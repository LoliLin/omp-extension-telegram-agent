export interface ActivityScheduler {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface TypingLeaseMetrics {
	starts: number;
	attempts: number;
	renewals: number;
	stops: number;
	failures: number;
}

const systemScheduler: ActivityScheduler = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One bot's best-effort Telegram typing lease. It never overlaps action requests. */
export class TelegramTypingLease {
	private active = false;
	private generation = 0;
	private timer: unknown = null;
	private inFlight = false;
	private inFlightAbort: AbortController | null = null;
	private attemptedThisLease = false;
	private failureReported = false;
	private readonly counts: TypingLeaseMetrics = { starts: 0, attempts: 0, renewals: 0, stops: 0, failures: 0 };

	constructor(
		private readonly sendTyping: (signal: AbortSignal) => Promise<unknown>,
		private readonly options: {
			intervalMs?: number;
			scheduler?: ActivityScheduler;
			onFailure?: (error: unknown) => void;
		} = {},
	) {}

	get isActive(): boolean {
		return this.active;
	}

	get metrics(): Readonly<TypingLeaseMetrics> {
		return { ...this.counts };
	}

	start(): boolean {
		if (this.active) return false;
		this.active = true;
		this.generation++;
		this.attemptedThisLease = false;
		this.failureReported = false;
		this.counts.starts++;
		this.tick(this.generation);
		return true;
	}

	stop(): boolean {
		if (!this.active) return false;
		this.active = false;
		this.generation++;
		if (this.timer != null) this.scheduler.clearTimeout(this.timer);
		this.timer = null;
		this.inFlightAbort?.abort();
		this.inFlightAbort = null;
		this.counts.stops++;
		return true;
	}

	private get scheduler(): ActivityScheduler {
		return this.options.scheduler ?? systemScheduler;
	}

	private tick(generation: number): void {
		if (!this.active || generation !== this.generation) return;
		const intervalMs = Math.max(1, this.options.intervalMs ?? 4000);
		this.timer = this.scheduler.setTimeout(() => this.tick(generation), intervalMs);
		(this.timer as { unref?: () => void } | null)?.unref?.();
		if (this.inFlight) return;

		this.inFlight = true;
		const abort = new AbortController();
		this.inFlightAbort = abort;
		this.counts.attempts++;
		if (this.attemptedThisLease) this.counts.renewals++;
		this.attemptedThisLease = true;
		let request: Promise<unknown>;
		try {
			request = this.sendTyping(abort.signal);
		} catch (error) {
			this.inFlight = false;
			if (this.inFlightAbort === abort) this.inFlightAbort = null;
			this.noteFailure(error, generation);
			return;
		}
		void Promise.resolve(request)
			.then(() => {
				if (this.active && generation === this.generation) this.failureReported = false;
			})
			.catch((error) => this.noteFailure(error, generation))
			.finally(() => {
				if (this.inFlightAbort === abort) this.inFlightAbort = null;
				this.inFlight = false;
				if (this.active && generation !== this.generation && !this.attemptedThisLease) {
					if (this.timer != null) this.scheduler.clearTimeout(this.timer);
					this.timer = null;
					this.tick(this.generation);
				}
			});
	}

	private noteFailure(error: unknown, generation: number): void {
		if (!this.active || generation !== this.generation) return;
		this.counts.failures++;
		if (this.failureReported) return;
		this.failureReported = true;
		this.options.onFailure?.(error);
	}
}
