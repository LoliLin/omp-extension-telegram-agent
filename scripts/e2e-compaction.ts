// Compaction e2e: tiny threshold forces compaction after two prompts.
// Usage: compaction_threshold=1500 bun run scripts/e2e-compaction.ts
import { loadConfig } from "../src/config.ts";
import { openDb, setBotState } from "../src/db/db.ts";
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
const session = (rt as unknown as { session: { subscribe: (l: (e: { type: string; errorMessage?: string }) => void) => void; getContextUsage: () => unknown } }).session;
session.subscribe((e) => {
	if (e.type.startsWith("compaction")) console.log("[test] event:", e.type, e.errorMessage ?? "");
});

const chatId = Number(`-100${config.groupPeerId}`);
const now = Math.floor(Date.now() / 1000);
const insert = db.prepare(
	"INSERT OR IGNORE INTO messages (chat_id, message_id, date, sender_id, display_name, username, is_bot, text, first_seen_by) VALUES (?,?,?,?,?,?,0,?,'test')",
);
insert.run(chatId, now, now, 999000002, "Tester", "tester2", "[test] 第一轮，随便聊聊");
rt.trigger();
await new Promise((r) => setTimeout(r, 45_000));
insert.run(chatId, now + 1, now + 1, 999000002, "Tester", "tester2", "[test] 第二轮，继续");
rt.trigger();
await new Promise((r) => setTimeout(r, 45_000));
console.log("usage:", JSON.stringify(session.getContextUsage()));
console.log("compaction events:", JSON.stringify(db.query("SELECT payload FROM agent_events WHERE kind='compaction'").all()));
await rt.stop();
process.exit(0);
