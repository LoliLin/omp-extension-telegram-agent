process.env.TZ = "Asia/Singapore";

import { describe, expect, test } from "bun:test";
import { TelegramTypingLease, type ActivityScheduler } from "../src/telegram/activity.ts";
import { BotApi } from "../src/telegram/api.ts";

class FakeScheduler implements ActivityScheduler {
	now = 0;
	private nextId = 0;
	private readonly tasks = new Map<number, { at: number; callback: () => void }>();

	setTimeout(callback: () => void, delayMs: number): number {
		const id = ++this.nextId;
		this.tasks.set(id, { at: this.now + delayMs, callback });
		return id;
	}

	clearTimeout(handle: unknown): void {
		this.tasks.delete(handle as number);
	}

	async flush(): Promise<void> {
		for (let index = 0; index < 6; index++) await Promise.resolve();
	}

	async advance(ms: number): Promise<void> {
		await this.flush();
		const target = this.now + ms;
		while (true) {
			const due = [...this.tasks.entries()]
				.filter(([, task]) => task.at <= target)
				.sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
			if (!due) break;
			this.now = due[1].at;
			this.tasks.delete(due[0]);
			due[1].callback();
			await this.flush();
		}
		this.now = target;
	}
}

describe("Telegram typing activity lease (REQ-TG-0002)", () => {
	test("starts immediately, renews at four-second boundaries, and stops idempotently", async () => {
		const scheduler = new FakeScheduler();
		const calls: number[] = [];
		const lease = new TelegramTypingLease(async () => { calls.push(scheduler.now); }, { scheduler });

		expect(lease.start()).toBe(true);
		expect(lease.start()).toBe(false);
		expect(calls).toEqual([0]);
		await scheduler.advance(3999);
		expect(calls).toEqual([0]);
		await scheduler.advance(1);
		expect(calls).toEqual([0, 4000]);
		await scheduler.advance(8000);
		expect(calls).toEqual([0, 4000, 8000, 12000]);
		expect(lease.metrics).toEqual({ starts: 1, attempts: 4, renewals: 3, stops: 0, failures: 0 });

		expect(lease.stop()).toBe(true);
		expect(lease.stop()).toBe(false);
		await scheduler.advance(20_000);
		expect(calls).toHaveLength(4);
		expect(lease.metrics.stops).toBe(1);
	});

	test("never overlaps a hung action request", async () => {
		const scheduler = new FakeScheduler();
		const calls: number[] = [];
		let resolveFirst!: () => void;
		const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
		const lease = new TelegramTypingLease(() => {
			calls.push(scheduler.now);
			return calls.length === 1 ? first : Promise.resolve();
		}, { scheduler });

		lease.start();
		await scheduler.advance(8000);
		expect(calls).toEqual([0]);
		resolveFirst();
		await scheduler.flush();
		await scheduler.advance(4000);
		expect(calls).toEqual([0, 12000]);
		expect(lease.metrics).toMatchObject({ attempts: 2, renewals: 1 });
		lease.stop();
	});

	test("a restarted lease sends immediately after the previous in-flight request settles", async () => {
		const scheduler = new FakeScheduler();
		const calls: number[] = [];
		let resolveFirst!: () => void;
		const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
		const lease = new TelegramTypingLease(() => {
			calls.push(scheduler.now);
			return calls.length === 1 ? first : Promise.resolve();
		}, { scheduler });

		lease.start();
		lease.stop();
		lease.start();
		expect(calls).toEqual([0]);
		resolveFirst();
		await scheduler.flush();
		expect(calls).toEqual([0, 0]);
		expect(lease.metrics).toMatchObject({ starts: 2, attempts: 2, renewals: 0, stops: 1 });
		lease.stop();
	});

	test("different bots renew and stop independently", async () => {
		const scheduler = new FakeScheduler();
		const calls: string[] = [];
		const a = new TelegramTypingLease(async () => { calls.push(`A@${scheduler.now}`); }, { scheduler });
		const b = new TelegramTypingLease(async () => { calls.push(`B@${scheduler.now}`); }, { scheduler });

		a.start();
		b.start();
		expect(calls).toEqual(["A@0", "B@0"]);
		a.stop();
		await scheduler.advance(4000);
		expect(calls).toEqual(["A@0", "B@0", "B@4000"]);
		expect(a.isActive).toBe(false);
		expect(b.isActive).toBe(true);
		b.stop();
	});

	test("deduplicates one warning per failure streak and retries after recovery", async () => {
		const scheduler = new FakeScheduler();
		let call = 0;
		const warnings: unknown[] = [];
		const lease = new TelegramTypingLease(() => {
			call++;
			return call === 3 ? Promise.resolve() : Promise.reject(new Error(`failure-${call}`));
		}, { scheduler, onFailure: (error) => warnings.push(error) });

		lease.start();
		await scheduler.flush();
		await scheduler.advance(4000);
		expect(warnings).toHaveLength(1);
		await scheduler.advance(4000); // success resets the streak
		await scheduler.advance(4000);
		expect(warnings).toHaveLength(2);
		expect(lease.metrics.failures).toBe(3);
		lease.stop();
	});

	test("BotApi sends only the group-capable typing action with a bounded timeout", async () => {
		const api = new BotApi("test-token");
		const calls: unknown[] = [];
		(api as any).call = async (method: string, params: unknown, timeoutMs: number) => {
			calls.push({ method, params, timeoutMs });
			return true;
		};

		await api.sendChatAction(-1004402809405);

		expect(calls).toEqual([{
			method: "sendChatAction",
			params: { chat_id: -1004402809405, action: "typing" },
			timeoutMs: 3500,
		}]);
		expect(calls.some((call) => ["sendMessageDraft", "sendRichMessageDraft"].includes((call as { method: string }).method))).toBe(false);
	});
});
