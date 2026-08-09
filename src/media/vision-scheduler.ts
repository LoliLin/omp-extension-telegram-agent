export class VisionBudgetExceededError extends Error {
	constructor() {
		super("vision budget exceeded");
		this.name = "VisionBudgetExceededError";
	}
}

interface QueuedTask<T> {
	chatId: number;
	foreground: boolean;
	run: () => Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

export interface VisionSchedulerOptions {
	concurrency: number;
	perChatHourlyLimit: number;
	dailyLimit: number;
	now?: () => number;
}

/** One deployment-wide vision-work gate; video reserves it before local preparation. */
export class VisionScheduler {
	private readonly concurrency: number;
	private readonly perChatHourlyLimit: number;
	private readonly dailyLimit: number;
	private readonly now: () => number;
	private active = 0;
	private foregroundQueue: QueuedTask<unknown>[] = [];
	private backgroundQueue: QueuedTask<unknown>[] = [];
	private hourCounts = new Map<string, number>();
	private dayKey = "";
	private dayCount = 0;

	constructor(options: VisionSchedulerOptions) {
		this.concurrency = Math.max(1, Math.floor(options.concurrency));
		this.perChatHourlyLimit = Math.max(0, Math.floor(options.perChatHourlyLimit));
		this.dailyLimit = Math.max(0, Math.floor(options.dailyLimit));
		this.now = options.now ?? Date.now;
	}

	private keys(chatId: number): { hour: string; day: string } {
		const date = new Date(this.now());
		const day = date.toISOString().slice(0, 10);
		const hour = `${day}T${String(date.getUTCHours()).padStart(2, "0")}:${chatId}`;
		return { hour, day };
	}

	private reserve(chatId: number): boolean {
		const { hour, day } = this.keys(chatId);
		if (day !== this.dayKey) {
			this.dayKey = day;
			this.dayCount = 0;
			this.hourCounts.clear();
		}
		const hourCount = this.hourCounts.get(hour) ?? 0;
		if (hourCount >= this.perChatHourlyLimit || this.dayCount >= this.dailyLimit) return false;
		this.hourCounts.set(hour, hourCount + 1);
		this.dayCount++;
		return true;
	}

	schedule<T>(chatId: number, foreground: boolean, run: () => Promise<T>): Promise<T> {
		if (!this.reserve(chatId)) return Promise.reject(new VisionBudgetExceededError());
		return new Promise<T>((resolve, reject) => {
			const task: QueuedTask<T> = { chatId, foreground, run, resolve, reject };
			(foreground ? this.foregroundQueue : this.backgroundQueue).push(task as QueuedTask<unknown>);
			this.drain();
		});
	}

	private drain(): void {
		while (this.active < this.concurrency) {
			const task = this.foregroundQueue.shift() ?? this.backgroundQueue.shift();
			if (!task) return;
			this.active++;
			void task
				.run()
				.then(task.resolve, task.reject)
				.finally(() => {
					this.active--;
					this.drain();
				});
		}
	}

	snapshot(): { active: number; foregroundQueued: number; backgroundQueued: number; dayCount: number } {
		return {
			active: this.active,
			foregroundQueued: this.foregroundQueue.length,
			backgroundQueued: this.backgroundQueue.length,
			dayCount: this.dayCount,
		};
	}
}
