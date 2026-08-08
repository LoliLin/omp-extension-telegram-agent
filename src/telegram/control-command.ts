import type { Database } from "bun:sqlite";
import { log } from "../observability/log.ts";
import type { BotConfig, TelegramAdmin } from "../config.ts";
import type { ManualCompactResult, RuntimeControlSnapshot } from "../agent/runtime.ts";
import { extractUpdateMessage } from "./normalize.ts";
import { TelegramControlState, type ControlMutationResult } from "./control-state.ts";

export const CONTROL_COMMAND_CLAIM_EVENT = "telegram_control_claim";
export const CONTROL_COMMAND_AUDIT_EVENT = "telegram_control";
export const CONTROL_REPLY_EVENT = "telegram_control_reply";

const MAX_REPLY_CHARS = 3500;
const MAX_LABEL_CHARS = 64;

export interface ControlBotIdentity {
	id: string;
	username: string;
}

export interface ControlSender {
	id: number | null;
	username: `@${string}` | null;
	isBot: boolean;
	hasSenderChat: boolean;
}

export type TelegramControlAction =
	| { kind: "help" }
	| { kind: "bots" }
	| { kind: "status"; botId: string | null }
	| { kind: "compact"; target: string }
	| { kind: "set"; botId: string; parameter: "routing_p" | "cooldown_ms"; value: number }
	| { kind: "reset"; botId: string; parameter: "routing_p" | "cooldown_ms" }
	| { kind: "usage" };

export interface ParsedTelegramControlCommand {
	chatId: number;
	messageId: number;
	edited: boolean;
	receivedByBotId: string;
	replyBotId: string;
	sender: ControlSender;
	action: TelegramControlAction;
}

export interface TelegramControlRuntime {
	controlSnapshot(): RuntimeControlSnapshot;
	compactForControl(): Promise<ManualCompactResult>;
	consumeControlMessage(messageId: number): void;
}

export interface TelegramControlResult {
	chatId: number;
	replyToMessageId: number;
	replyBotId: string;
	text: string | null;
	duplicate: boolean;
}

/**
 * Parse only Telegram's offset-zero bot_command entity. Telegram entity offsets are UTF-16
 * code units, which is exactly what JavaScript slice() consumes.
 */
export function parseTelegramControlCommand(
	update: unknown,
	receivedByBotId: string,
	bots: readonly ControlBotIdentity[],
): ParsedTelegramControlCommand | null {
	const payload = extractUpdateMessage(update);
	if (!payload) return null;
	const message = payload.message as Record<string, unknown>;
	const source = typeof message.text === "string"
		? message.text
		: typeof message.caption === "string"
			? message.caption
			: null;
	const entities = typeof message.text === "string" ? message.entities : message.caption_entities;
	if (source == null || !Array.isArray(entities)) return null;
	const entity = entities.find((candidate) => {
		if (!candidate || typeof candidate !== "object") return false;
		const value = candidate as Record<string, unknown>;
		return value.type === "bot_command" && value.offset === 0;
	}) as Record<string, unknown> | undefined;
	if (!entity || typeof entity.length !== "number" || !Number.isSafeInteger(entity.length) || entity.length <= 0) return null;
	const commandToken = source.slice(0, entity.length);
	const match = commandToken.match(/^\/([a-z0-9_]+)(?:@([a-z0-9_]{5,32}))?$/i);
	if (!match || match[1]!.toLowerCase() !== "tg") return null;

	const receivingBot = bots.find((bot) => bot.id === receivedByBotId);
	if (!receivingBot) return null;
	let replyBotId = receivingBot.id;
	if (match[2]) {
		const suffix = match[2].toLowerCase();
		const target = bots.find((bot) => bot.username.toLowerCase() === suffix);
		if (!target) return null;
		replyBotId = target.id;
	}

	const chat = message.chat as Record<string, unknown> | undefined;
	const chatId = chat?.id;
	const messageId = message.message_id;
	if (typeof chatId !== "number" || !Number.isSafeInteger(chatId)) return null;
	if (typeof messageId !== "number" || !Number.isSafeInteger(messageId) || messageId <= 0) return null;
	const from = message.from as Record<string, unknown> | undefined;
	const senderId = typeof from?.id === "number" && Number.isSafeInteger(from.id) && from.id > 0 ? from.id : null;
	const username = typeof from?.username === "string" && /^[a-z0-9_]{5,32}$/i.test(from.username)
		? `@${from.username.toLowerCase()}` as `@${string}`
		: null;

	const remainder = source.slice(entity.length);
	const action = remainder && !/^\s/.test(remainder)
		? { kind: "usage" } as const
		: parseControlArguments(remainder.trim());
	return {
		chatId,
		messageId,
		edited: payload.edited,
		receivedByBotId,
		replyBotId,
		sender: {
			id: senderId,
			username,
			isBot: from?.is_bot === true,
			hasSenderChat: message.sender_chat != null,
		},
		action,
	};
}

function parseControlArguments(input: string): TelegramControlAction {
	const tokens = input ? input.split(/\s+/) : [];
	if (tokens.length === 0) return { kind: "help" };
	const command = tokens[0]!.toLowerCase();
	if (command === "help") return tokens.length === 1 ? { kind: "help" } : { kind: "usage" };
	if (command === "bots") return tokens.length === 1 ? { kind: "bots" } : { kind: "usage" };
	if (command === "status") {
		return tokens.length <= 2 ? { kind: "status", botId: tokens[1] ?? null } : { kind: "usage" };
	}
	if (command === "compact") {
		return tokens.length === 2 ? { kind: "compact", target: tokens[1]! } : { kind: "usage" };
	}
	if (command === "set") {
		if (tokens.length !== 4) return { kind: "usage" };
		const parameter = normalizedParameter(tokens[2]!);
		if (!parameter) return { kind: "usage" };
		const value = parseControlValue(parameter, tokens[3]!);
		return value == null ? { kind: "usage" } : { kind: "set", botId: tokens[1]!, parameter, value };
	}
	if (command === "reset") {
		if (tokens.length !== 3) return { kind: "usage" };
		const parameter = normalizedParameter(tokens[2]!);
		return parameter ? { kind: "reset", botId: tokens[1]!, parameter } : { kind: "usage" };
	}
	return { kind: "usage" };
}

function normalizedParameter(value: string): "routing_p" | "cooldown_ms" | null {
	const normalized = value.toLowerCase();
	return normalized === "routing_p" || normalized === "cooldown_ms" ? normalized : null;
}

function parseControlValue(parameter: "routing_p" | "cooldown_ms", raw: string): number | null {
	if (parameter === "cooldown_ms") {
		if (!/^\d+$/.test(raw)) return null;
		const value = Number(raw);
		return Number.isSafeInteger(value) ? value : null;
	}
	if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(raw)) return null;
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
}

export class TelegramControlCommandService {
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(
		private readonly db: Database,
		private readonly bots: readonly BotConfig[],
		private readonly state: TelegramControlState,
		private readonly runtimes: ReadonlyMap<string, TelegramControlRuntime>,
		private readonly admins: readonly TelegramAdmin[],
		private readonly now: () => number = () => Date.now(),
	) {}

	async handle(command: ParsedTelegramControlCommand): Promise<TelegramControlResult> {
		const claimed = this.claim(command);
		this.consumeEveryRuntime(command.messageId);
		if (!claimed) return this.result(command, null, true);
		const startedAt = this.now();
		if (command.edited) {
			this.audit(command, false, "ignored_edit", startedAt);
			return this.result(command, null, false);
		}
		if (!isHuman(command.sender)) {
			this.audit(command, false, "rejected_sender", startedAt);
			return this.result(command, null, false);
		}

		const mutation = isMutation(command.action);
		const authorized = !mutation || this.isAdmin(command.sender);
		if (!authorized) {
			this.audit(command, false, "permission_denied", startedAt);
			return this.result(command, "权限不足：此操作仅限 telegram_admins 白名单。", false);
		}

		if (mutation) {
			return await this.enqueueMutation(async () => {
				const { text, outcome } = await this.execute(command.action);
				this.audit(command, true, outcome, startedAt);
				return this.result(command, text, false);
			});
		}
		const { text, outcome } = await this.execute(command.action);
		this.audit(command, true, outcome, startedAt);
		return this.result(command, text, false);
	}

	/** Persist and expose a sent control reply so it remains outside every future provider epoch. */
	consumeReply(botId: string, chatId: number, messageId: number): void {
		const existing = this.db
			.query(`SELECT 1 FROM agent_events WHERE kind = ? AND json_extract(payload, '$.chat_id') = ? AND json_extract(payload, '$.message_id') = ? LIMIT 1`)
			.get(CONTROL_REPLY_EVENT, chatId, messageId);
		if (!existing) {
			this.db.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES (?, ?, ?, ?)").run(
				botId,
				this.now(),
				CONTROL_REPLY_EVENT,
				JSON.stringify({ chat_id: chatId, message_id: messageId }),
			);
		}
		this.consumeEveryRuntime(messageId);
	}

	private claim(command: ParsedTelegramControlCommand): boolean {
		const existing = this.db
			.query(`SELECT 1 FROM agent_events WHERE kind = ? AND json_extract(payload, '$.chat_id') = ? AND json_extract(payload, '$.message_id') = ? LIMIT 1`)
			.get(CONTROL_COMMAND_CLAIM_EVENT, command.chatId, command.messageId);
		if (existing) return false;
		this.db.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES (?, ?, ?, ?)").run(
			command.replyBotId,
			this.now(),
			CONTROL_COMMAND_CLAIM_EVENT,
			JSON.stringify({ chat_id: command.chatId, message_id: command.messageId, command: command.action.kind }),
		);
		return true;
	}

	private async execute(action: TelegramControlAction): Promise<{ text: string; outcome: string }> {
		switch (action.kind) {
			case "help":
				return { text: HELP_TEXT, outcome: "ok" };
			case "bots":
				return { text: this.formatBots(), outcome: "ok" };
			case "status":
				return this.formatStatus(action.botId);
			case "set": {
				const result = this.state.set(action.botId, action.parameter, action.value);
				return this.formatStateMutation("set", action.botId, action.parameter, result);
			}
			case "reset": {
				const result = this.state.reset(action.botId, action.parameter);
				return this.formatStateMutation("reset", action.botId, action.parameter, result);
			}
			case "compact":
				return await this.compact(action.target);
			case "usage":
				return { text: USAGE_TEXT, outcome: "usage" };
		}
	}

	private formatBots(): string {
		const lines = this.bots.map((bot) => {
			const runtime = this.runtimes.get(bot.id);
			return `${bounded(bot.id)} · ${bounded(bot.name)} · ${runtime?.controlSnapshot().state ?? "unavailable"}`;
		});
		return boundedReply(["Bots", ...lines].join("\n"));
	}

	private formatStatus(botId: string | null): { text: string; outcome: string } {
		const selected = botId == null ? this.bots : this.bots.filter((bot) => bot.id === botId);
		if (selected.length === 0) return { text: `未知 bot：${bounded(botId ?? "")}`, outcome: "unknown_bot" };
		const lines: string[] = [];
		for (const bot of selected) {
			const effective = this.state.get(bot.id)!;
			const snapshot = this.runtimes.get(bot.id)?.controlSnapshot();
			const aggregate = this.db
				.query("SELECT COUNT(*) runs, COALESCE(SUM(context_tokens), 0) context_tokens, COALESCE(SUM(output_tokens), 0) output_tokens, COALESCE(SUM(cost), 0) cost FROM llm_runs WHERE bot_id = ?")
				.get(bot.id) as { runs: number; context_tokens: number; output_tokens: number; cost: number };
			lines.push(
				`${bounded(bot.id)} · ${bounded(bot.name)}`,
				`state=${snapshot?.state ?? "unavailable"} epoch=${snapshot?.epoch ?? "-"} model=${bounded(snapshot?.model ?? bot.model)}`,
				`routing_p=${effective.routingP} (${effective.routingSource}) cooldown_ms=${effective.cooldownMs} (${effective.cooldownSource})`,
				`runs=${aggregate.runs} context=${aggregate.context_tokens} output=${aggregate.output_tokens} cost=$${aggregate.cost.toFixed(4)}`,
			);
			if (snapshot?.lastCompact) lines.push(`last_compact=${snapshot.lastCompact.outcome} at=${snapshot.lastCompact.at}`);
		}
		return { text: boundedReply(lines.join("\n")), outcome: "ok" };
	}

	private formatStateMutation(
		verb: "set" | "reset",
		botId: string,
		parameter: "routing_p" | "cooldown_ms",
		result: ControlMutationResult,
	): { text: string; outcome: string } {
		if (!result.ok) return { text: boundedReply(`未修改：${result.error}`), outcome: result.code };
		const value = parameter === "routing_p" ? result.value.routingP : result.value.cooldownMs;
		const source = parameter === "routing_p" ? result.value.routingSource : result.value.cooldownSource;
		return { text: `${verb} ${botId}.${parameter} = ${value} (${source})`, outcome: "ok" };
	}

	private async compact(target: string): Promise<{ text: string; outcome: string }> {
		const selected = target.toLowerCase() === "all"
			? this.bots
			: this.bots.filter((bot) => bot.id === target);
		if (selected.length === 0) return { text: `未知 bot：${bounded(target)}`, outcome: "unknown_bot" };
		const lines: string[] = [];
		let allOk = true;
		for (const bot of selected) {
			const runtime = this.runtimes.get(bot.id);
			const result: ManualCompactResult = runtime
				? await runtime.compactForControl()
				: { ok: false, code: "unavailable" };
			if (result.ok) lines.push(`${bounded(bot.id)}: compact 完成，epoch=${result.epoch}`);
			else {
				allOk = false;
				lines.push(`${bounded(bot.id)}: ${compactFailureText(result.code)}`);
			}
		}
		return { text: boundedReply(lines.join("\n")), outcome: allOk ? "ok" : "partial" };
	}

	private isAdmin(sender: ControlSender): boolean {
		return this.admins.some((admin) => typeof admin === "number" ? admin === sender.id : admin === sender.username);
	}

	private consumeEveryRuntime(messageId: number): void {
		for (const [botId, runtime] of this.runtimes) {
			try {
				runtime.consumeControlMessage(messageId);
			} catch {
				// The durable claim/reply marker remains the flush authority even if local
				// obligation cleanup races shutdown.
				log.error("telegram_control", "context_exclusion_failed", { bot_id: botId, message_id: messageId, category: "local_failure" });
			}
		}
	}

	private audit(command: ParsedTelegramControlCommand, authorized: boolean, outcome: string, startedAt: number): void {
		const target = "botId" in command.action
			? command.action.botId
			: "target" in command.action
				? command.action.target
				: null;
		const finishedAt = this.now();
		this.db.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES (?, ?, ?, ?)").run(
			command.replyBotId,
			finishedAt,
			CONTROL_COMMAND_AUDIT_EVENT,
			JSON.stringify({
				command: command.action.kind,
				target,
				sender_id: command.sender.id,
				username: command.sender.username,
				authorized,
				outcome,
				duration_ms: Math.max(0, finishedAt - startedAt),
			}),
		);
	}

	private result(command: ParsedTelegramControlCommand, text: string | null, duplicate: boolean): TelegramControlResult {
		return {
			chatId: command.chatId,
			replyToMessageId: command.messageId,
			replyBotId: command.replyBotId,
			text: text == null ? null : boundedReply(text),
			duplicate,
		};
	}

	private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.mutationTail.then(operation, operation);
		this.mutationTail = result.then(() => {}, () => {});
		return result;
	}
}

/** IDs marked here stay out of provider suffixes across every context generation. */
export function consumedControlMessageIds(db: Database, chatId: number): Set<number> {
	const rows = db
		.query(`SELECT DISTINCT json_extract(payload, '$.message_id') message_id FROM agent_events WHERE kind IN (?, ?) AND json_extract(payload, '$.chat_id') = ?`)
		.all(CONTROL_COMMAND_CLAIM_EVENT, CONTROL_REPLY_EVENT, chatId) as { message_id: unknown }[];
	return new Set(rows.flatMap((row) => typeof row.message_id === "number" && Number.isSafeInteger(row.message_id) ? [row.message_id] : []));
}

function isHuman(sender: ControlSender): boolean {
	return sender.id != null && !sender.isBot && !sender.hasSenderChat;
}

function isMutation(action: TelegramControlAction): boolean {
	return action.kind === "compact" || action.kind === "set" || action.kind === "reset";
}

function compactFailureText(code: Exclude<ManualCompactResult, { ok: true }>["code"]): string {
	switch (code) {
		case "busy": return "busy，请稍后重试";
		case "stopping": return "正在停止";
		case "unavailable": return "runtime unavailable";
		case "nothing_to_compact": return "没有足够上下文可压缩";
		case "failed": return "compact 失败（详情仅保留在本机日志）";
	}
}

function bounded(value: string): string {
	const clean = value.replace(/[\r\n\t]+/g, " ");
	return clean.length <= MAX_LABEL_CHARS ? clean : `${clean.slice(0, MAX_LABEL_CHARS - 1)}…`;
}

function boundedReply(value: string): string {
	return value.length <= MAX_REPLY_CHARS ? value : `${value.slice(0, MAX_REPLY_CHARS - 1)}…`;
}

const USAGE_TEXT = [
	"用法：",
	"/tg help",
	"/tg bots",
	"/tg status [bot]",
	"/tg compact <bot|all>（管理员）",
	"/tg set <bot> <routing_p|cooldown_ms> <value>（管理员）",
	"/tg reset <bot> <routing_p|cooldown_ms>（管理员）",
].join("\n");

const HELP_TEXT = [
	"Telegram Agent 控制",
	"查看：help、bots、status",
	"管理员：compact、set、reset",
	"手动 compact 会使用既有摘要模型并产生相应费用。",
	USAGE_TEXT,
].join("\n");
