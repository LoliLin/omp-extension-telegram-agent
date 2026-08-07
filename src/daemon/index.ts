// Daemon entry: long-running core. Owns SQLite, pollers, (later) agents, IPC server.
// Started by `src/main.ts start` (detached) or directly with `bun run src/daemon/index.ts`.

import { loadConfig } from "../config.ts";
import { openDb, setBotState, getBotState, getDaemonState, setDaemonState } from "../db/db.ts";
import { BotApi } from "../telegram/api.ts";
import { Poller } from "../telegram/poller.ts";
import { BotRuntime } from "../agent/runtime.ts";
import { routeMessage, type BotIdentity } from "../agent/router.ts";
import { IpcServer } from "./ipc-server.ts";
import { acquirePidLock, releasePidLock } from "./pid.ts";
import type { MessageRow } from "../agent/serialize.ts";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_SCHEMA_VERSION } from "../agent/prompt.ts";

const rootDir = process.cwd();
const config = loadConfig(rootDir);
// Exclusive pid lock at the EARLIEST moment, before any slow init (getMe / model runtime /
// session creation): a second `start` while we're still initializing must not race us
// (REQ-OPS-0001 R4). Released on shutdown; stale pid files are taken over.
const pidFd = acquirePidLock(config.dataDir);
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
console.log(`[daemon] bot list: ${config.bots.map((b) => `${b.id} (${b.name}) persona=${b.personaPath} model=${b.model}`).join(", ")}`); // no tokens
for (const bot of config.bots) {
	const me = await new BotApi(bot.token).getMe();
	setBotState(db, bot.id, "bot_user_id", String(me.id));
	setBotState(db, bot.id, "bot_username", me.username);
	console.log(`[daemon] bot ${bot.id} (${bot.name}) = @${me.username} (${me.id})`);
}

// agent runtimes (one Pi AgentSession per bot)
process.env.DEEPSEEK_API_KEY = config.deepseekApiKey;
const modelRuntime = await ModelRuntime.create();
const runtimes = new Map<string, BotRuntime>();
for (const bot of config.bots) {
	const rt = new BotRuntime(db, bot, config, modelRuntime);
	await rt.init();
	runtimes.set(bot.id, rt);
}

// Cache schema change (e.g. REQ-STICKER-0001 catalog in the prefix): open a new context
// epoch for every bot so telemetry marks the expected one-time cache reset (docs/cache.md).
const storedSchema = getDaemonState(db, "cache_schema_version");
if (storedSchema !== String(CACHE_SCHEMA_VERSION)) {
	console.log(`[daemon] cache schema v${storedSchema ?? "none"} -> v${CACHE_SCHEMA_VERSION}: opening new context epoch`);
	for (const bot of config.bots) {
		const epoch = Number(getBotState(db, bot.id, "context_epoch") ?? "1") + 1;
		setBotState(db, bot.id, "context_epoch", String(epoch));
		runtimes.get(bot.id)?.noteSchemaBump(epoch);
	}
	setDaemonState(db, "cache_schema_version", String(CACHE_SCHEMA_VERSION));
}
const identities: BotIdentity[] = config.bots.map((bot) => ({
	id: bot.id,
	userId: Number(getBotState(db, bot.id, "bot_user_id") ?? "0"),
	username: getBotState(db, bot.id, "bot_username") ?? "",
	name: bot.name,
}));

// IPC server for TUI attach/detach
const botNames = new Map(config.bots.map((b) => [b.id, b.name] as [string, string]));
const botUserIds = new Map(identities.map((i) => [i.id, i.userId] as [string, number]));
const ipc = new IpcServer(db, join(config.dataDir, "daemon.sock"), botNames, botUserIds);
for (const [botId, rt] of runtimes) {
	rt.eventSink = (kind, payload) => {
		ipc.broadcast({ kind: "evt", ts: Date.now(), botId, botName: botNames.get(botId) ?? botId, evtKind: kind, payload: JSON.stringify(payload) });
	};
	rt.sentMessageSink = (rawMsg) => {
		const m = rawMsg as { chat: { id: number }; message_id: number };
		const row = db.query("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?").get(m.chat.id, m.message_id) as MessageRow | null;
		if (row) ipc.broadcast(ipc.msgToItem(row));
	};
}
ipc.start();

// route an ingested group message to a bot per routing rules
function route(result: { chatId?: number; messageId?: number }): void {
	if (result.chatId == null || result.messageId == null) return;
	const row = db
		.query("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?")
		.get(result.chatId, result.messageId) as MessageRow | null;
	if (!row) return; // missing row; is_bot is enforced inside routeMessage (REQ-TEST-0001 R3)
	const target = routeMessage(db, row, identities, {
		secret: config.routerSecret ?? "",
		probs: config.bots.map((b) => b.routingP),
	});
	if (target !== "nobody") {
		console.log(`[route] msg #${row.message_id} -> bot ${target}`);
		runtimes.get(target)?.trigger();
	}
}

const pollers = config.bots.map(
	(bot) =>
		new Poller(db, bot.id, bot.token, config.groupPeerId, (result, _update, botId) => {
			console.log(`[msg] bot=${botId} ${result.kind} chat=${result.chatId} msg=${result.messageId}`);
			route(result);
			if (result.chatId != null && result.messageId != null) {
				const row = db
					.query("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?")
					.get(result.chatId, result.messageId) as MessageRow | null;
				if (row) ipc.broadcast(ipc.msgToItem(row));
			}
		}),
);

let stopping = false;
async function shutdown(signal: string) {
	if (stopping) return;
	stopping = true;
	console.log(`[daemon] ${signal} received, shutting down`);
	for (const p of pollers) p.stop();
	for (const rt of runtimes.values()) await rt.stop();
	ipc.stop();
	releasePidLock(pidFd, config.dataDir);
	// give pollers a moment to exit their loops
	await new Promise((r) => setTimeout(r, 500));
	db.close();
	process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log(`[daemon] started pid=${process.pid} group=${config.groupPeerId} db=${config.dbPath}`);
await Promise.all(pollers.map((p) => p.run()));
