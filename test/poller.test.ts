// Poller reliability tests (REQ-TG-0001 AC2–AC4). Scripted fake API + fault-injecting
// db wrapper; no network, no real Telegram.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Poller } from "../src/telegram/poller.ts";
import { TelegramApiError } from "../src/telegram/api.ts";
import { getBotState } from "../src/db/db.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const GROUP = 4402809405;
const SUPERGROUP = Number(`-100${GROUP}`);

function freshDb(): Database {
	const db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
	return db;
}

function makeUpdate(updateId: number, text = "hi"): object {
	return {
		update_id: updateId,
		message: {
			message_id: updateId * 100,
			from: { id: 111, is_bot: false, first_name: "Alice" },
			chat: { id: SUPERGROUP, type: "supergroup" },
			date: 1754600000,
			text,
		},
	};
}

interface FakeApi {
	getUpdates(offset: number, timeoutSec: number): Promise<unknown[]>;
}

function injectApi(poller: Poller, api: FakeApi): void {
	(poller as unknown as { api: FakeApi }).api = api;
}

/** db handle that throws on statements matching failOn; everything else delegates. */
function injectDbFault(db: Database, failOn: (sql: string) => boolean): Database {
	return {
		query: (sql: string) => {
			if (failOn(sql)) throw new Error("injected db fault");
			return db.query(sql);
		},
		transaction: (callback: () => unknown) => db.transaction(callback),
	} as unknown as Database;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
		await sleep(10);
	}
}

describe("Poller (REQ-TG-0001)", () => {
	test("AC2: ingest failure holds the offset; next poll replays without duplicates", async () => {
		const db = freshDb();
		let faultsLeft = 1;
		const faulty = injectDbFault(db, (sql) => sql.includes("raw_updates") && faultsLeft-- > 0);
		const p = new Poller(faulty, "A", "token", GROUP);
		let calls = 0;
		injectApi(p, {
			getUpdates: async () => {
				calls++;
				if (calls <= 2) return [makeUpdate(1)]; // Telegram re-delivers while offset is held
				await sleep(20); // idle polls
				return [];
			},
		});
		const done = p.run();
		void done.catch(() => {}); // handled by the await below
		await waitFor(() => getBotState(db, "A", "update_offset") === "2");
		p.stop();
		await done;

		expect(calls).toBeGreaterThanOrEqual(2); // failed round did not advance the offset
		expect(db.query("SELECT COUNT(*) c FROM raw_updates").get()).toEqual({ c: 1 });
		expect(db.query("SELECT COUNT(*) c FROM messages").get()).toEqual({ c: 1 });
		expect(db.query("SELECT text FROM messages WHERE message_id = 100").get()).toEqual({ text: "hi" });
	});

	test("AC3: setBotState failure keeps the poller alive in backoff", async () => {
		const db = freshDb();
		const faulty = injectDbFault(db, (sql) => sql.startsWith("INSERT INTO bot_state"));
		const p = new Poller(faulty, "A", "token", GROUP);
		injectApi(p, {
			getUpdates: async () => {
				await sleep(20);
				return [makeUpdate(1)];
			},
		});
		const done = p.run();
		void done.catch(() => {});
		await sleep(300); // several poll rounds, offset persistence failing every time
		expect(p.running).toBe(true); // did not die; still looping in backoff
		p.stop();
		await done; // resolves cleanly, run() never rejected

		// ingest itself kept succeeding; raw/message dedupe absorbed the replays
		expect(db.query("SELECT COUNT(*) c FROM messages").get()).toEqual({ c: 1 });
		expect(getBotState(db, "A", "update_offset")).toBeNull();
	});

	test("AC4: stop during an in-flight getUpdates discards the returned batch", async () => {
		const db = freshDb();
		let onMessageCalls = 0;
		const p = new Poller(db, "A", "token", GROUP, () => {
			onMessageCalls++;
		});
		let inFlight = false;
		let release: (updates: unknown[]) => void = () => {};
		injectApi(p, {
			getUpdates: () => {
				inFlight = true;
				return new Promise((r) => {
					release = r;
				});
			},
		});
		const done = p.run();
		await waitFor(() => inFlight);
		p.stop(); // shutdown lands while the long poll is still awaiting
		release([makeUpdate(1)]);
		await done;

		expect(onMessageCalls).toBe(0);
		expect(db.query("SELECT COUNT(*) c FROM messages").get()).toEqual({ c: 0 });
		expect(db.query("SELECT COUNT(*) c FROM raw_updates").get()).toEqual({ c: 0 });
		expect(getBotState(db, "A", "update_offset")).toBeNull();
	});

	test("R4: 401 auth error is fatal (thrown), not retried forever", async () => {
		const db = freshDb();
		const p = new Poller(db, "A", "token", GROUP);
		injectApi(p, {
			getUpdates: async () => {
				throw new TelegramApiError(401, "Unauthorized");
			},
		});
		await expect(p.run()).rejects.toThrow(/401/);
		expect(p.running).toBe(false);
	});
});
