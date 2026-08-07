// Daemon entry: long-running core. Owns SQLite, pollers, (later) agents, IPC server.
// Started by `src/main.ts start` (detached) or directly with `bun run src/daemon/index.ts`.

import { loadConfig } from "../config.ts";
import { openDb, setBotState, getDaemonState, setDaemonState } from "../db/db.ts";
import { BotApi } from "../telegram/api.ts";
import { Poller } from "../telegram/poller.ts";
import { randomBytes } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const rootDir = process.cwd();
const config = loadConfig(rootDir);
const db = openDb(config.dbPath);

// router secret: stable across restarts, generated once
if (!config.routerSecret) {
	let secret = getDaemonState(db, "router_secret");
	if (!secret) {
		secret = randomBytes(32).toString("hex");
		setDaemonState(db, "router_secret", secret);
		console.log("[daemon] generated and persisted router secret");
	}
	config.routerSecret = secret;
}

// resolve bot identities (getMe) so we can recognize own messages and mentions
for (const bot of config.bots) {
	const me = await new BotApi(bot.token).getMe();
	setBotState(db, bot.id, "bot_user_id", String(me.id));
	setBotState(db, bot.id, "bot_username", me.username);
	console.log(`[daemon] bot ${bot.id} (${bot.name}) = @${me.username} (${me.id})`);
}

const pollers = config.bots.map(
	(bot) =>
		new Poller(db, bot.id, bot.token, config.groupPeerId, (result, _update, botId) => {
			console.log(`[msg] bot=${botId} ${result.kind} chat=${result.chatId} msg=${result.messageId}`);
		}),
);

const pidPath = join(config.dataDir, "daemon.pid");
writeFileSync(pidPath, String(process.pid));

let stopping = false;
async function shutdown(signal: string) {
	if (stopping) return;
	stopping = true;
	console.log(`[daemon] ${signal} received, shutting down`);
	for (const p of pollers) p.stop();
	rmSync(pidPath, { force: true });
	// give pollers a moment to exit their loops
	await new Promise((r) => setTimeout(r, 500));
	db.close();
	process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log(`[daemon] started pid=${process.pid} group=${config.groupPeerId} db=${config.dbPath}`);
await Promise.all(pollers.map((p) => p.run()));
