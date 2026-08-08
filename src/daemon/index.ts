// Daemon entry: long-running core. Owns SQLite, pollers, (later) agents, IPC server.
// Started by `src/main.ts start` (detached) or directly with `bun run src/daemon/index.ts`.

import { loadConfig } from "../config.ts";
import { openDb, getDaemonState, setDaemonState } from "../db/db.ts";
import { BotApi } from "../telegram/api.ts";
import { BotRuntime } from "../agent/runtime.ts";
import { dispatchRoutingDecision, routeMessageDecision } from "../agent/router.ts";
import { IpcServer } from "./ipc-server.ts";
import { acquirePidLock, releasePidLock } from "./pid.ts";
import type { MessageRow } from "../agent/serialize.ts";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_SCHEMA_VERSION } from "../agent/prompt.ts";
import { ManualSendService } from "./manual-send.ts";
import { TelegramControlState } from "../telegram/control-state.ts";
import { parseTelegramControlCommand, TelegramControlCommandService } from "../telegram/control-command.ts";
import { publishTelegramControlMenus, TelegramControlCoordinator } from "../telegram/control-integration.ts";
import { createSharedModelRuntime, piAuthSource } from "../agent/model-runtime.ts";
import { parsePiModelReference } from "../agent/model-ref.ts";
import { assertPiVisionExecutorReady, createPiVisionExecutor } from "../media/vision.ts";
import { VisionScheduler } from "../media/vision-scheduler.ts";
import { PhotoCacheQueue } from "../media/photo-cache.ts";
import { composeDeployment, composePollers } from "./composition.ts";
import type { IngestResult } from "../telegram/ingest.ts";
import { claimRoutingDecision, finishRoutingClaim } from "../db/routing-claims.ts";
import { applyRetention } from "../db/retention.ts";

const rootDir = process.cwd();
const config = loadConfig(rootDir);
// Exclusive pid lock at the EARLIEST moment, before any slow init (getMe / model runtime /
// session creation): a second `start` while we're still initializing must not race us
// (REQ-OPS-0001 R4). Released on shutdown; stale pid files are taken over.
const pidFd = acquirePidLock(config.dataDir);
const visualModel = config.vision?.enabled ? parsePiModelReference(config.auxiliaryVisualModel)! : null;
const compactionModels = config.bots.map((bot) => parsePiModelReference(bot.compactionModel ?? config.auxiliaryVisualModel)!);
const { sharedModelRuntime, sharedVisionExecutor } = await (async () => {
	try {
		const runtime = await createSharedModelRuntime([
			...config.bots,
			...compactionModels,
			...(visualModel ? [visualModel] : []),
		]);
		const executor = visualModel ? createPiVisionExecutor(runtime, visualModel.canonical) : null;
		if (executor) assertPiVisionExecutorReady(executor);
		return { sharedModelRuntime: runtime, sharedVisionExecutor: executor };
	} catch (error) {
		releasePidLock(pidFd, config.dataDir);
		throw error;
	}
})();
const visionScheduler = config.vision?.enabled
	? new VisionScheduler({
			concurrency: config.vision.concurrency,
			perChatHourlyLimit: config.vision.perChatHourlyLimit,
			dailyLimit: config.vision.dailyLimit,
		})
	: null;
const db = openDb(config.dbPath);
const retentionConfig = config.retention ?? {
	telemetryDays: 90,
	rawUpdateDays: 30,
	messageEventDays: 365,
};
function runRetentionMaintenance(): void {
	const retention = applyRetention(db, retentionConfig);
	if (Object.values(retention).some((count) => count > 0)) {
		console.log(`[daemon] retention pruned agent=${retention.agentEvents} llm=${retention.llmRuns} raw=${retention.rawUpdates} message_events=${retention.messageEvents}`);
	}
	db.exec("PRAGMA optimize; PRAGMA wal_checkpoint(PASSIVE);");
}
runRetentionMaintenance();
const retentionTimer = setInterval(runRetentionMaintenance, 24 * 60 * 60 * 1_000);
retentionTimer.unref?.();
// Restore effective overrides before BotRuntime captures the shared BotConfig objects.
const telegramControlState = new TelegramControlState(db, config.bots);

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
console.log(
	`[daemon] bot list: ${config.bots.map((bot) =>
		`${bot.id} (${bot.name}) model=${bot.provider}/${bot.model}:${bot.reasoningEffort} auth=${piAuthSource(sharedModelRuntime, bot.provider)}`
	).join(", ")}`,
); // fixed non-sensitive Pi metadata only
const composition = await composeDeployment(db, config, {
	createApi: (bot) => new BotApi(bot.token),
	createRuntime: async (bot) => {
		const runtime = new BotRuntime(db, bot, config, sharedModelRuntime, {
			...(sharedVisionExecutor ? { visionExecutor: sharedVisionExecutor } : {}),
			...(visionScheduler ? { visionScheduler } : {}),
		});
		await runtime.init();
		return runtime;
	},
	onIdentity: (bot, identity) => {
		console.log(`[daemon] bot ${bot.id} (${bot.name}) = @${identity.username} (${identity.userId})`);
	},
});
const { botApis, runtimes, identities, botNames, botUserIds, replyBotTargets } = composition;

// The per-bot content fingerprint rotated incompatible sessions before they were opened.
const storedSchema = getDaemonState(db, "cache_schema_version");
if (storedSchema !== String(CACHE_SCHEMA_VERSION)) {
	console.log(`[daemon] cache schema v${storedSchema ?? "none"} -> v${CACHE_SCHEMA_VERSION}: fingerprints reconciled`);
	setDaemonState(db, "cache_schema_version", String(CACHE_SCHEMA_VERSION));
}
const routeCounters = new Map<string, number>();

function recordRouteMetric(metric: string, botId: string, messageId: number): void {
	const count = (routeCounters.get(metric) ?? 0) + 1;
	routeCounters.set(metric, count);
	console.log(`[route] ${metric} bot=${botId} msg=#${messageId} count=${count}`);
}

// IPC server for TUI attach/detach
let ipc!: IpcServer;
const manualSend = new ManualSendService(
	db,
	Number(`-100${config.groupPeerId}`),
	botApis,
	({ chatId, messageId }) => {
		const row = db.query("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?").get(chatId, messageId) as MessageRow | null;
		if (row) ipc.broadcast(ipc.msgToItem(row));
	},
);
ipc = new IpcServer(
	db,
	join(config.dataDir, "daemon.sock"),
	botNames,
	botUserIds,
	(request) => manualSend.send(request),
);
for (const [botId, rt] of runtimes) {
	rt.eventSink = (kind, payload) => {
		ipc.broadcast({ kind: "evt", ts: Date.now(), botId, botName: botNames.get(botId) ?? botId, evtKind: kind, payload: JSON.stringify(payload) });
	};
	rt.sentMessageSink = (rawMsg) => {
		const m = rawMsg as { chat: { id: number }; message_id: number };
		const row = db.query("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?").get(m.chat.id, m.message_id) as MessageRow | null;
		if (row) ipc.broadcast(ipc.msgToItem(row));
	};
	rt.usageSink = (run) => ipc.broadcastUsage(run);
	rt.visionSink = (fileUniqueId, text) => ipc.broadcastVision({ fileUniqueId, text });
	rt.streamSink = (stream) => ipc.broadcastStream(stream);
	rt.streamDemand = () => ipc.hasStreamListener(botId);
}
ipc.start();
const photoCache = new PhotoCacheQueue(db, botApis, {
	cacheDir: join(config.dataDir, "media"),
	onReady: (fileUniqueId, mediaPath) => ipc.broadcastMediaReady({ fileUniqueId, mediaPath }),
	onTelemetry: (event) => {
		console.log(
			`[media-cache] event=${event.event} kind=${event.kind} outcome=${event.outcome} bytes=${event.bytesBucket} queue=${event.queueDepth}`,
		);
	},
});
const photoBackfillCount = photoCache.scheduleBackfill();
console.log(`[media-cache] startup scheduled=${photoBackfillCount} limit=100 concurrency=2`);

const telegramControl = new TelegramControlCommandService(
	db,
	config.bots,
	telegramControlState,
	runtimes,
	config.telegramAdmins,
);
const telegramControlCoordinator = new TelegramControlCoordinator(
	db,
	telegramControl,
	botApis,
	({ chatId, messageId }) => {
		const row = db.query("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?").get(chatId, messageId) as MessageRow | null;
		if (row) ipc.broadcast(ipc.msgToItem(row));
	},
);
const controlTasks = new Set<Promise<unknown>>();
function runTelegramControl(command: NonNullable<ReturnType<typeof parseTelegramControlCommand>>): void {
	const task = telegramControlCoordinator.handle(command).catch(() => {
		console.error(`[telegram-control] coordinator failed bot=${command.replyBotId} msg=#${command.messageId}`);
	});
	controlTasks.add(task);
	void task.finally(() => controlTasks.delete(task));
}
void publishTelegramControlMenus(botApis);

// Direct replies are durable response opportunities. Restore them only after each
// session and observer sink is ready, before fresh polling can add more work.
for (const [botId, rt] of runtimes) {
	const outcome = rt.recoverReplyObligations();
	if (outcome) console.log(`[route] recovered direct replies bot=${botId} outcome=${outcome}`);
}

// route an ingested group message to a bot per routing rules
function route(result: IngestResult): void {
	if (result.chatId == null || result.messageId == null) return;
	const row = db
		.query("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?")
		.get(result.chatId, result.messageId) as MessageRow | null;
	if (!row) return; // missing row; is_bot is enforced inside routeMessage (REQ-TEST-0001 R3)
	const decision = routeMessageDecision(db, row, identities, {
		secret: config.routerSecret ?? "",
		probs: config.bots.map((b) => b.routingP),
	});
	// The only enrichment performed by ingestion is reply-sender identity. Re-route only when
	// that new fact actually changes the deterministic outcome into a direct reply.
	if (result.kind === "enriched" && decision.reason !== "reply") return;
	if (decision.target === "nobody") return;
	const claimedDecision = decision as typeof decision & { target: string };
	const routeVersion = result.routeVersion ?? 1;
	if (!claimRoutingDecision(db, claimedDecision, routeVersion)) {
		console.log(`[route] duplicate claim suppressed bot=${decision.target} msg=#${row.message_id} version=${routeVersion}`);
		return;
	}
	const dispatched = dispatchRoutingDecision(decision, runtimes);
	finishRoutingClaim(db, claimedDecision, routeVersion, dispatched.outcome === "nobody" ? "missing_runtime" : dispatched.outcome);
	if (decision.reason === "probability") {
		const metric =
			dispatched.outcome === "started"
				? "route_probability_triggered"
				: dispatched.outcome === "skipped_busy"
					? "route_probability_skipped_busy"
					: dispatched.outcome === "skipped_cooldown"
						? "route_probability_skipped_cooldown"
						: `route_probability_${dispatched.outcome}`;
		recordRouteMetric(metric, decision.target, row.message_id);
	} else {
		console.log(
			`[route] msg #${row.message_id} -> bot ${decision.target} reason=${decision.reason} outcome=${dispatched.outcome}`,
		);
	}
}

const pollers = composePollers(
	db,
	config,
	(result, update, botId) => {
		console.log(`[msg] bot=${botId} ${result.kind} chat=${result.chatId} msg=${result.messageId}`);
		const command = parseTelegramControlCommand(update, botId, identities);
		if (command) runTelegramControl(command);
		else route(result);
		if (result.chatId != null && result.messageId != null) {
			const row = db
				.query("SELECT * FROM messages WHERE chat_id = ? AND message_id = ?")
				.get(result.chatId, result.messageId) as MessageRow | null;
			if (row) {
				ipc.broadcast(ipc.msgToItem(row));
				// Poller offset + canonical row are durable before this non-blocking side effect.
				photoCache.scheduleMessage(botId, row);
			}
		}
	},
	replyBotTargets,
);

let stopping = false;
async function shutdown(signal: string) {
	if (stopping) return;
	stopping = true;
	console.log(`[daemon] ${signal} received, shutting down`);
	// hard bound: a wedged provider request / SDK dispose must never leave the daemon
	// unkillable — SIGTERM always wins within STOP_HARD_TIMEOUT
	const hardTimer = setTimeout(() => {
		console.error("[daemon] shutdown timed out, forcing exit");
		process.exit(1);
	}, 35_000);
	hardTimer.unref?.();
	for (const p of pollers) p.stop();
	clearInterval(retentionTimer);
	const photoCacheStop = photoCache.stop();
	for (const rt of runtimes.values()) await rt.stop();
	await photoCacheStop;
	if (controlTasks.size > 0) {
		await Promise.race([
			Promise.allSettled([...controlTasks]),
			new Promise((resolve) => setTimeout(resolve, 5_000)),
		]);
	}
	ipc.stop();
	releasePidLock(pidFd, config.dataDir);
	// give pollers a moment to exit their loops
	await new Promise((r) => setTimeout(r, 500));
	db.close();
	clearTimeout(hardTimer);
	process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

console.log(`[daemon] started pid=${process.pid} group=${config.groupPeerId} db=${config.dbPath}`);
await Promise.all(pollers.map((p) => p.run()));
