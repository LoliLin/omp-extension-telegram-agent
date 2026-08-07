// Compaction e2e: real session + real summary LLM call; polls for the compaction event
// instead of fixed sleeps and FAILS (exit != 0) when compaction did not happen
// (REQ-TEST-0001 R4). The auto-threshold path needs ~984K tokens with the 1M-window model
// (reserveTokens floors at 16384), so compaction is driven deterministically via
// session.compact() — the same path the daemon's extension handles.
// Usage: bun run scripts/e2e-compaction.ts   (touches real services, needs .env)
import { loadConfig } from "../src/config.ts";
import { openDb, getBotState, setBotState } from "../src/db/db.ts";
import { BotApi } from "../src/telegram/api.ts";
import { BotRuntime } from "../src/agent/runtime.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const config = loadConfig(process.cwd());
const db = openDb(config.dbPath);
const me = await new BotApi(config.bots[0].token).getMe();
setBotState(db, "A", "bot_user_id", String(me.id));
setBotState(db, "A", "bot_username", me.username);
process.env.DEEPSEEK_API_KEY = config.deepseekApiKey;
const modelRuntime = await ModelRuntime.create();
const rt = new BotRuntime(db, config.bots[0], config, modelRuntime);
await rt.init();
const session = (rt as unknown as { session: { compact: () => Promise<unknown> } }).session;

const epochBefore = Number(getBotState(db, "A", "context_epoch") ?? "1");
console.log("[e2e] epoch before:", epochBefore);

/** Poll agent_events for a compaction event with a deadline (no fixed sleeps). */
async function waitForCompaction(timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const row = db
			.query("SELECT payload FROM agent_events WHERE kind = 'compaction' AND ts > ? ORDER BY id DESC LIMIT 1")
			.get(Date.now() - timeoutMs - 60_000) as { payload: string } | null;
		if (row) return true;
		await new Promise((r) => setTimeout(r, 500));
	}
	return false;
}

try {
	const result = await session.compact();
	console.log("[e2e] compact() summary chars:", String(result).length);
} catch (err) {
	console.error("[e2e] compact() threw:", err);
	process.exit(1);
}

if (!(await waitForCompaction(60_000))) {
	console.error("[e2e] FAIL: no compaction event observed after compact()");
	process.exit(1);
}
const epochAfter = Number(getBotState(db, "A", "context_epoch") ?? "1");
console.log("[e2e] epoch after:", epochAfter);
if (epochAfter <= epochBefore) {
	console.error(`[e2e] FAIL: epoch did not advance (${epochBefore} -> ${epochAfter})`);
	process.exit(1);
}

const errors = db.query("SELECT payload FROM agent_events WHERE kind = 'error' AND ts > ?").all(Date.now() - 120_000);
if (errors.length > 0) {
	console.error("[e2e] FAIL: unexpected error events:", JSON.stringify(errors));
	process.exit(1);
}
console.log("[e2e] PASS: compaction observed, epoch", epochBefore, "->", epochAfter);
await rt.stop();
db.close();
process.exit(0);
