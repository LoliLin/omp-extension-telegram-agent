// Read-only routing observability. The application receives only message identity plus a
// SQLite-derived trigger code; message bodies never leave SQLite or enter the report.

import { Database } from "bun:sqlite";
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import type { BotConfig } from "../config.ts";
import { getBotState, getDaemonState } from "../db/db.ts";
import { CONTROL_ROUTING_KEY } from "../telegram/control-state.ts";
import { routingValue } from "./router.ts";

const MAX_LOG_BYTES = 16 * 1024 * 1024;

type SqlBinding = string | number | null;
type TriggerReason = "explicit" | "reply" | "name";
type LogOutcome = "started" | "busy" | "cooldown" | "coalesced" | "stopping" | "missingRuntime";

export interface RoutingAuditBotInput {
	id: string;
	name: string;
	routingP: number;
	userId: number | null;
	username: string | null;
}

export interface RoutingAuditInput {
	chatId: number;
	secret: string;
	bots: RoutingAuditBotInput[];
	/** null means unavailable; any supplied daemon log is inherently a partial process-local view. */
	logText?: string | null;
	logTruncated?: boolean;
}

export interface RoutingOutcomeCounts {
	started: number;
	busy: number;
	cooldown: number;
	coalesced: number;
	stopping: number;
	missingRuntime: number;
}

export interface RoutingReasonCounts {
	explicit: number;
	reply: number;
	name: number;
}

export interface RoutingAuditBotResult {
	id: string;
	configuredProbability: number;
	assignments: number;
	reasons: RoutingReasonCounts;
	probabilityOutcomes: RoutingOutcomeCounts;
	explicitOutcomes: RoutingOutcomeCounts;
	llmRuns: number;
	publicMessages: number | null;
}

export interface RoutingAuditLogResult {
	status: "unavailable" | "partial";
	truncated: boolean;
	recognizedRecords: number;
	unknownBotRecords: number;
	malformedRecords: number;
}

export interface RoutingAuditReport {
	bots: RoutingAuditBotResult[];
	humanMessages: number;
	botMessagesIgnored: number;
	probabilitySample: number;
	probabilityNobody: number;
	classificationStatus: "complete" | "partial";
	invalidEntityRows: number;
	log: RoutingAuditLogResult;
}

interface AuditMessageRow {
	chat_id: number;
	message_id: number;
	trigger_code: string | null;
}

interface BoundedLog {
	text: string;
	truncated: boolean;
}

function blankOutcomes(): RoutingOutcomeCounts {
	return { started: 0, busy: 0, cooldown: 0, coalesced: 0, stopping: 0, missingRuntime: 0 };
}

function blankReasons(): RoutingReasonCounts {
	return { explicit: 0, reply: 0, name: 0 };
}

/** Open an existing deployment DB without migrations, PRAGMA writes, or create fallback. */
export function openRoutingAuditDatabase(path: string): Database {
	return new Database(path, { readonly: true });
}

/**
 * Load only routing state and bot identity from the production configuration/state authorities.
 * Secrets remain in the returned in-memory context and are never formatted.
 */
export function resolveRoutingAuditInput(
	db: Database,
	config: { groupPeerId: number; routerSecret: string | null; bots: readonly BotConfig[] },
	log: BoundedLog | null,
): RoutingAuditInput {
	const bots = config.bots.map((bot, index): RoutingAuditBotInput => {
		const override = getBotState(db, bot.id, CONTROL_ROUTING_KEY);
		const routingP = override == null ? bot.routingP : Number(override);
		if (!Number.isFinite(routingP) || routingP < 0 || routingP > 1) {
			throw new Error(`invalid effective routing probability for bot-${index + 1}`);
		}
		const rawUserId = Number(getBotState(db, bot.id, "bot_user_id"));
		const rawUsername = getBotState(db, bot.id, "bot_username")?.trim() ?? "";
		return {
			id: bot.id,
			name: bot.name,
			routingP,
			userId: Number.isSafeInteger(rawUserId) && rawUserId > 0 ? rawUserId : null,
			username: rawUsername ? rawUsername.replace(/^@/, "") : null,
		};
	});
	if (bots.reduce((sum, bot) => sum + bot.routingP, 0) > 1) {
		throw new Error("effective routing probability sum exceeds one");
	}
	const secret = config.routerSecret ?? getDaemonState(db, "router_secret");
	if (!secret) throw new Error("router secret is unavailable");
	return {
		chatId: Number(`-100${config.groupPeerId}`),
		secret,
		bots,
		logText: log?.text ?? null,
		logTruncated: log?.truncated ?? false,
	};
}

/** Read at most the newest 16 MiB. A sliced or existing log is always reported as partial. */
export function readRoutingAuditLog(path: string, maxBytes = MAX_LOG_BYTES): BoundedLog | null {
	if (!existsSync(path)) return null;
	let fd: number | null = null;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const length = Math.min(size, Math.max(1, maxBytes));
		const start = Math.max(0, size - length);
		const buffer = Buffer.alloc(length);
		let offset = 0;
		while (offset < length) {
			const read = readSync(fd, buffer, offset, length - offset, start + offset);
			if (read === 0) break;
			offset += read;
		}
		let text = buffer.subarray(0, offset).toString("utf8");
		if (start > 0) {
			const firstNewline = text.indexOf("\n");
			text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
		}
		return { text, truncated: start > 0 };
	} catch {
		return null;
	} finally {
		if (fd != null) closeSync(fd);
	}
}

function buildMessageAuditQuery(bots: readonly RoutingAuditBotInput[]): { sql: string; params: SqlBinding[] } {
	const params: SqlBinding[] = [];
	const bind = (value: SqlBinding): string => {
		params.push(value);
		return `?${params.length}`;
	};
	const chat = bind(0); // replaced by the caller while preserving numbered placeholders
	const explicitCases: string[] = [];
	const nameCases: string[] = [];

	for (let index = 0; index < bots.length; index++) {
		const bot = bots[index]!;
		const userId = bind(bot.userId);
		const mention = bind(bot.username ? `@${bot.username.toLowerCase()}` : null);
		const name = bind(bot.name);
		const validEntities = "CASE WHEN messages.entities IS NOT NULL AND json_valid(messages.entities) THEN messages.entities ELSE '[]' END";
		const explicit = `EXISTS (
			SELECT 1 FROM json_each(${validEntities}) AS entity
			WHERE (
				json_extract(entity.value, '$.type') = 'text_mention'
				AND ${userId} IS NOT NULL
				AND CAST(json_extract(entity.value, '$.user.id') AS INTEGER) = ${userId}
			) OR (
				json_extract(entity.value, '$.type') = 'mention'
				AND ${mention} IS NOT NULL
				AND instr(lower(COALESCE(messages.text, '')), ${mention}) > 0
			)
		)`;
		const reply = `messages.reply_to_message_id IS NOT NULL AND ${userId} IS NOT NULL AND (
			messages.reply_to_sender_id = ${userId}
			OR (SELECT parent.sender_id FROM messages AS parent
				WHERE parent.chat_id = messages.chat_id AND parent.message_id = messages.reply_to_message_id) = ${userId}
		)`;
		explicitCases.push(`WHEN (${explicit}) THEN '${index}:explicit'`, `WHEN (${reply}) THEN '${index}:reply'`);
		nameCases.push(`WHEN instr(COALESCE(messages.text, messages.caption, ''), ${name}) > 0 THEN '${index}:name'`);
	}

	return {
		sql: `SELECT messages.chat_id, messages.message_id,
		CASE
			${explicitCases.join("\n\t\t\t")}
			${nameCases.join("\n\t\t\t")}
			ELSE NULL
		END AS trigger_code
	FROM messages
	WHERE messages.chat_id = ${chat} AND messages.is_bot = 0
	ORDER BY messages.message_id`,
		params,
	};
}

function parseTriggerCode(value: string | null, botCount: number): { botIndex: number; reason: TriggerReason } | null {
	if (value == null) return null;
	const match = /^(\d+):(explicit|reply|name)$/.exec(value);
	if (!match) return null;
	const botIndex = Number(match[1]);
	if (!Number.isSafeInteger(botIndex) || botIndex < 0 || botIndex >= botCount) return null;
	return { botIndex, reason: match[2] as TriggerReason };
}

function incrementOutcome(counts: RoutingOutcomeCounts, outcome: LogOutcome): void {
	counts[outcome]++;
}

function parseLog(
	text: string | null | undefined,
	truncated: boolean,
	bots: readonly RoutingAuditBotResult[],
): RoutingAuditLogResult {
	if (text == null) {
		return { status: "unavailable", truncated: false, recognizedRecords: 0, unknownBotRecords: 0, malformedRecords: 0 };
	}
	const botIndexes = new Map(bots.map((bot, index) => [bot.id, index]));
	let recognizedRecords = 0;
	let unknownBotRecords = 0;
	let malformedRecords = 0;
	const probabilityPattern = /\[route\] route_probability_(triggered|skipped_busy|skipped_cooldown|coalesced|skipped_stopping|missing_runtime) bot=([^\s]+) msg=#-?\d+ count=\d+/;
	const explicitPattern = /\[route\] msg #-?\d+ -> bot ([^\s]+) reason=(explicit|reply|name) outcome=(started|coalesced|skipped_busy|skipped_cooldown|skipped_stopping|missing_runtime)/;
	const outcomeMap: Record<string, LogOutcome> = {
		triggered: "started",
		started: "started",
		skipped_busy: "busy",
		skipped_cooldown: "cooldown",
		coalesced: "coalesced",
		skipped_stopping: "stopping",
		missing_runtime: "missingRuntime",
	};

	for (const line of text.split("\n")) {
		const probability = probabilityPattern.exec(line);
		if (probability) {
			const botIndex = botIndexes.get(probability[2]!);
			if (botIndex == null) unknownBotRecords++;
			else {
				incrementOutcome(bots[botIndex]!.probabilityOutcomes, outcomeMap[probability[1]!]!);
				recognizedRecords++;
			}
			continue;
		}
		const explicit = explicitPattern.exec(line);
		if (explicit) {
			const botIndex = botIndexes.get(explicit[1]!);
			if (botIndex == null) unknownBotRecords++;
			else {
				incrementOutcome(bots[botIndex]!.explicitOutcomes, outcomeMap[explicit[3]!]!);
				recognizedRecords++;
			}
			continue;
		}
		if (line.includes("[route] route_probability_") || (/\[route\] msg /.test(line) && line.includes("reason="))) {
			malformedRecords++;
		}
	}
	return { status: "partial", truncated, recognizedRecords, unknownBotRecords, malformedRecords };
}

/** Analyze canonical history using current effective routing values without network or model calls. */
export function analyzeRouting(db: Database, input: RoutingAuditInput): RoutingAuditReport {
	if (input.bots.length === 0) throw new Error("routing audit requires at least one bot");
	if (!input.secret) throw new Error("routing audit requires a router secret");
	const probabilitySum = input.bots.reduce((sum, bot, index) => {
		if (!Number.isFinite(bot.routingP) || bot.routingP < 0 || bot.routingP > 1) {
			throw new Error(`invalid routing probability for bot-${index + 1}`);
		}
		return sum + bot.routingP;
	}, 0);
	if (probabilitySum > 1) throw new Error("routing probability sum exceeds one");

	const bots: RoutingAuditBotResult[] = input.bots.map((bot) => ({
		id: bot.id,
		configuredProbability: bot.routingP,
		assignments: 0,
		reasons: blankReasons(),
		probabilityOutcomes: blankOutcomes(),
		explicitOutcomes: blankOutcomes(),
		llmRuns: 0,
		publicMessages: 0,
	}));
	const query = buildMessageAuditQuery(input.bots);
	query.params[0] = input.chatId;
	const statement = db.query<AuditMessageRow, SqlBinding[]>(query.sql);
	let humanMessages = 0;
	let probabilitySample = 0;
	let probabilityNobody = 0;
	for (const row of statement.iterate(...query.params)) {
		humanMessages++;
		const trigger = parseTriggerCode(row.trigger_code, bots.length);
		if (trigger) {
			bots[trigger.botIndex]!.reasons[trigger.reason]++;
			continue;
		}
		probabilitySample++;
		const value = routingValue(input.secret, row.chat_id, row.message_id);
		let cumulative = 0;
		let assigned = false;
		for (let index = 0; index < bots.length; index++) {
			cumulative += input.bots[index]!.routingP;
			if (value < cumulative) {
				bots[index]!.assignments++;
				assigned = true;
				break;
			}
		}
		if (!assigned) probabilityNobody++;
	}

	const getCount = (sql: string, ...params: SqlBinding[]): number => {
		const row = db.query<{ count: number }, SqlBinding[]>(sql).get(...params);
		return row?.count ?? 0;
	};
	const botMessagesIgnored = getCount("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ? AND is_bot <> 0", input.chatId);
	const invalidEntityRows = getCount(
		"SELECT COUNT(*) AS count FROM messages WHERE chat_id = ? AND is_bot = 0 AND entities IS NOT NULL AND NOT json_valid(entities)",
		input.chatId,
	);
	for (let index = 0; index < bots.length; index++) {
		const source = input.bots[index]!;
		bots[index]!.llmRuns = getCount("SELECT COUNT(*) AS count FROM llm_runs WHERE bot_id = ?", source.id);
		bots[index]!.publicMessages = source.userId == null
			? null
			: getCount("SELECT COUNT(*) AS count FROM messages WHERE chat_id = ? AND is_bot <> 0 AND sender_id = ?", input.chatId, source.userId);
	}
	const classificationStatus = invalidEntityRows === 0 && input.bots.every((bot) => bot.userId != null && bot.username != null)
		? "complete"
		: "partial";
	const log = parseLog(input.logText, input.logTruncated ?? false, bots);
	return {
		bots,
		humanMessages,
		botMessagesIgnored,
		probabilitySample,
		probabilityNobody,
		classificationStatus,
		invalidEntityRows,
		log,
	};
}

function observed(count: number, total: number): string {
	return total === 0 ? "0/0 (n/a)" : `${count}/${total} (${((count / total) * 100).toFixed(2)}%)`;
}

function logObserved(count: number, total: number, status: RoutingAuditLogResult["status"]): string {
	if (status === "unavailable") return "unavailable";
	return total === 0 ? "unobserved" : observed(count, total);
}

function sumBots(report: RoutingAuditReport, select: (bot: RoutingAuditBotResult) => number): number {
	return report.bots.reduce((sum, bot) => sum + select(bot), 0);
}

/** Deterministic, anonymized stdout representation. Never interpolate source ids, names, paths, or secrets. */
export function formatRoutingAudit(report: RoutingAuditReport): string {
	const assignmentTotal = sumBots(report, (bot) => bot.assignments) + report.probabilityNobody;
	const startedTotal = sumBots(report, (bot) => bot.probabilityOutcomes.started);
	const busyTotal = sumBots(report, (bot) => bot.probabilityOutcomes.busy);
	const cooldownTotal = sumBots(report, (bot) => bot.probabilityOutcomes.cooldown);
	const runTotal = sumBots(report, (bot) => bot.llmRuns);
	const publicTotal = sumBots(report, (bot) => bot.publicMessages ?? 0);
	const logDetail = report.log.status === "unavailable"
		? "unavailable"
		: `partial (process-local; recognized=${report.log.recognizedRecords}; unknown=${report.log.unknownBotRecords}; malformed=${report.log.malformedRecords}; truncated=${report.log.truncated ? "yes" : "no"})`;
	const lines = [
		"Routing audit",
		"scope: current effective configuration replay over canonical history (SQLite read-only; model calls=0)",
		`classification: ${report.classificationStatus} (message bodies remain inside SQLite; invalid-entity-rows=${report.invalidEntityRows})`,
		`daemon-log: ${logDetail}`,
		`sample: human=${report.humanMessages}; bot-ignored=${report.botMessagesIgnored}; probability=${report.probabilitySample}; probability-nobody=${report.probabilityNobody}`,
		"bot | configured | assignment | started | busy | cooldown | llm-runs | public",
	];
	for (let index = 0; index < report.bots.length; index++) {
		const bot = report.bots[index]!;
		lines.push([
			`bot-${index + 1}`,
			`${(bot.configuredProbability * 100).toFixed(2)}%`,
			observed(bot.assignments, assignmentTotal),
			logObserved(bot.probabilityOutcomes.started, startedTotal, report.log.status),
			logObserved(bot.probabilityOutcomes.busy, busyTotal, report.log.status),
			logObserved(bot.probabilityOutcomes.cooldown, cooldownTotal, report.log.status),
			observed(bot.llmRuns, runTotal),
			bot.publicMessages == null ? "unavailable" : observed(bot.publicMessages, publicTotal),
		].join(" | "));
	}
	lines.push("explicit replay (excluded from probability sample):");
	for (let index = 0; index < report.bots.length; index++) {
		const reasons = report.bots[index]!.reasons;
		lines.push(`bot-${index + 1}: mention=${reasons.explicit}; reply=${reasons.reply}; name=${reasons.name}`);
	}
	lines.push(`explicit lifecycle from daemon log: ${report.log.status}`);
	if (report.log.status === "partial") {
		for (let index = 0; index < report.bots.length; index++) {
			const outcomes = report.bots[index]!.explicitOutcomes;
			lines.push(
				`bot-${index + 1}: started=${outcomes.started}; coalesced=${outcomes.coalesced}; busy=${outcomes.busy}; cooldown=${outcomes.cooldown}; stopping=${outcomes.stopping}; missing-runtime=${outcomes.missingRuntime}`,
			);
		}
	}
	lines.push(
		"interpretation: assignment/started are response opportunities; public is final Telegram output and need not follow routing_p.",
		"caution: current-config replay is counterfactual for periods with older config; partial logs cannot prove historical zero events.",
	);
	return `${lines.join("\n")}\n`;
}
