// Manual compaction e2e: exercises the REQ-AGENT-0001 compaction_end success path end-to-end
// (real SessionManager entries, real summary LLM call, real kept-tail exposure reset).
// The threshold e2e (e2e-compaction.ts) can no longer force auto-compaction cheaply:
// with a 1M context window, reserveTokens floors at 16384, so the trigger sits at ~984K tokens.
// Usage: bun run scripts/e2e-compaction-manual.ts --bot <id>   (touches real services, needs .env)
import { loadConfig } from "../src/config.ts";
import { openDb, getBotState, setBotState } from "../src/db/db.ts";
import { BotApi } from "../src/telegram/api.ts";
import { BotRuntime } from "../src/agent/runtime.ts";
import { createSharedModelRuntime } from "../src/agent/model-runtime.ts";
import { selectConfiguredBot } from "./bot-selection.ts";

const config = loadConfig(process.cwd());
const bot = selectConfiguredBot(config.bots, process.argv.slice(2));
const db = openDb(config.dbPath);
const me = await new BotApi(bot.token).getMe();
setBotState(db, bot.id, "bot_user_id", String(me.id));
setBotState(db, bot.id, "bot_username", me.username);
const modelRuntime = await createSharedModelRuntime([bot]);
const rt = new BotRuntime(db, bot, config, modelRuntime);
await rt.init();
const session = (rt as unknown as { session: { compact: () => Promise<{ summary: string }> } }).session;

const epochBefore = Number(getBotState(db, bot.id, "context_epoch") ?? "1");
console.log(`bot=${bot.id} epoch before:`, epochBefore);
const result = await session.compact();
console.log("summary chars:", result.summary.length);
const epochAfter = Number(getBotState(db, bot.id, "context_epoch") ?? "1");
console.log("epoch after:", epochAfter);
if (epochAfter <= epochBefore) {
	console.error(`FAIL: epoch did not advance (${epochBefore} -> ${epochAfter})`);
	process.exit(1);
}
const errs = db.query("SELECT payload FROM agent_events WHERE bot_id = ? AND kind = 'error' AND ts > ?").all(bot.id, Date.now() - 120_000) as { payload: string }[];
if (errs.length > 0) {
	console.error("FAIL: unexpected error events:", JSON.stringify(errs));
	process.exit(1);
}
console.log("PASS: compaction_end success path verified (epoch", epochBefore, "->", epochAfter, ")");
await rt.stop();
process.exit(0);
