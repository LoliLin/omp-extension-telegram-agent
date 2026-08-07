// Manual compaction e2e: exercises the REQ-AGENT-0001 compaction_end success path end-to-end
// (real SessionManager entries, real summary LLM call, real kept-tail exposure reset).
// The threshold e2e (e2e-compaction.ts) can no longer force auto-compaction cheaply:
// with a 1M context window, reserveTokens floors at 16384, so the trigger sits at ~984K tokens.
// Usage: bun run scripts/e2e-compaction-manual.ts   (touches real services, needs .env)
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
const session = (rt as unknown as { session: { compact: () => Promise<{ summary: string }> } }).session;

console.log("epoch before:", getBotState(db, "A", "context_epoch"));
const result = await session.compact();
console.log("summary chars:", result.summary.length);
console.log("epoch after:", getBotState(db, "A", "context_epoch"));
console.log("exposed after:", getBotState(db, "A", "exposed_ids"));
console.log(
	"last compaction event:",
	JSON.stringify(db.query("SELECT payload FROM agent_events WHERE kind = 'compaction' ORDER BY ts DESC LIMIT 1").all()),
);
const errors = db.query("SELECT payload FROM agent_events WHERE kind = 'error' AND ts > ?").all(Date.now() - 120_000);
console.log("recent error events:", JSON.stringify(errors));
await rt.stop();
process.exit(0);
