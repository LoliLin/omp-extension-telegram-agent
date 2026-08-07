// E2E agent test: trigger bot A (小雪) with a synthetic human message, real DeepSeek + real Telegram group.
// Verifies: serialization -> session -> LLM -> send tool (terminate) -> DB insert -> telemetry.
// Usage: bun run scripts/e2e-agent.ts
import { loadConfig } from "../src/config.ts";
import { openDb, getBotState, setBotState } from "../src/db/db.ts";
import { BotApi } from "../src/telegram/api.ts";
import { BotRuntime } from "../src/agent/runtime.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const config = loadConfig(process.cwd());
const db = openDb(config.dbPath);
const chatId = Number(`-100${config.groupPeerId}`);

// bot identity (normally set by daemon)
const me = await new BotApi(config.bots[0].token).getMe();
setBotState(db, "A", "bot_user_id", String(me.id));
setBotState(db, "A", "bot_username", me.username);

// synthetic human trigger message (identifiable as a test)
const syntheticId = Math.floor(Date.now() / 1000);
db.query(
	`INSERT OR IGNORE INTO messages (chat_id, message_id, date, sender_id, display_name, username, is_bot, text, first_seen_by)
	 VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'test')`,
).run(chatId, syntheticId, Math.floor(Date.now() / 1000), 999000001, "Tester", "tester_human", "[test] 小雪在吗？看到的话吱一声");

process.env.DEEPSEEK_API_KEY = config.deepseekApiKey;
const modelRuntime = await ModelRuntime.create();
const rt = new BotRuntime(db, config.bots[0], config, modelRuntime);
await rt.init();

console.log("[e2e] triggering bot A...");
rt.trigger();

// wait until the run settles (poll llm_runs / agent_events)
const deadline = Date.now() + 120_000;
let settled = false;
while (Date.now() < deadline) {
	const send = db
		.query("SELECT payload FROM agent_events WHERE bot_id = 'A' AND kind = 'send' ORDER BY id DESC LIMIT 1")
		.get() as { payload: string } | null;
	if (send) {
		console.log("[e2e] SEND happened:", send.payload);
		settled = true;
		break;
	}
	const usage = db.query("SELECT COUNT(*) c FROM llm_runs WHERE bot_id = 'A'").get() as { c: number };
	if (usage.c > 0) {
		// give the run a moment to potentially call send after first llm response
		await new Promise((r) => setTimeout(r, 5000));
		const send2 = db.query("SELECT COUNT(*) c FROM agent_events WHERE bot_id = 'A' AND kind = 'send'").get() as { c: number };
		if (send2.c > 0) {
			settled = true;
			break;
		}
		console.log("[e2e] LLM ran but chose silence (local assistant text only)");
		break;
	}
	await new Promise((r) => setTimeout(r, 1000));
}

const events = db.query("SELECT kind, payload FROM agent_events WHERE bot_id = 'A' ORDER BY id").all() as { kind: string; payload: string }[];
for (const e of events) console.log(`  event ${e.kind}: ${e.payload.slice(0, 160)}`);
const runs = db.query("SELECT context_tokens, cache_read, cache_miss, output_tokens, cost, epoch, system_hash, tools_hash FROM llm_runs WHERE bot_id = 'A'").all();
console.log("[e2e] llm_runs:", JSON.stringify(runs));
const sent = db.query("SELECT message_id, text, username FROM messages WHERE sender_id = ? ORDER BY message_id DESC LIMIT 1").get(me.id) as Record<string, unknown> | null;
console.log("[e2e] latest bot message in transcript:", JSON.stringify(sent));

await rt.stop();
db.close();
console.log(settled ? "[e2e] PASS (send verified)" : "[e2e] DONE (no send; check events above)");
process.exit(0);
