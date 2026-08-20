const TYPING_INTERVAL_MS = 4000;

/** One bot's best-effort Telegram typing lease. It never overlaps action requests. */
export class TelegramTypingLease {
	private active = false;
	private generation = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private inFlight = false;
	private inFlightAbort: AbortController | null = null;
	private attemptedThisLease = false;
	private failureReported = false;

	constructor(
		private readonly sendTyping: (signal: AbortSignal) => Promise<unknown>,
		private readonly options: {
			onFailure?: (error: unknown) => void;
		} = {},
	) {}

	start(): boolean {
		if (this.active) return false;
		this.active = true;
		this.generation++;
		this.attemptedThisLease = false;
		this.failureReported = false;
		this.tick(this.generation);
		return true;
	}

	stop(): boolean {
		if (!this.active) return false;
		this.active = false;
		this.generation++;
		if (this.timer != null) clearTimeout(this.timer);
		this.timer = null;
		this.inFlightAbort?.abort();
		this.inFlightAbort = null;
		return true;
	}

	private tick(generation: number): void {
		if (!this.active || generation !== this.generation) return;
		this.timer = setTimeout(() => this.tick(generation), TYPING_INTERVAL_MS);
		this.timer.unref();
		if (this.inFlight) return;

		this.inFlight = true;
		const abort = new AbortController();
		this.inFlightAbort = abort;
		this.attemptedThisLease = true;
		void this.sendTyping(abort.signal)
			.then(() => {
				if (this.active && generation === this.generation) this.failureReported = false;
			})
			.catch((error) => this.noteFailure(error, generation))
			.finally(() => {
				if (this.inFlightAbort === abort) this.inFlightAbort = null;
				this.inFlight = false;
				if (this.active && generation !== this.generation && !this.attemptedThisLease) {
					if (this.timer != null) clearTimeout(this.timer);
					this.timer = null;
					this.tick(this.generation);
				}
			});
	}

	private noteFailure(error: unknown, generation: number): void {
		if (!this.active || generation !== this.generation) return;
		if (this.failureReported) return;
		this.failureReported = true;
		this.options.onFailure?.(error);
	}
}
