import type { Database } from "bun:sqlite";
import { log } from "../observability/log.ts";
import type { ParsedTelegramControlCommand, TelegramControlResult } from "./control-command.ts";
import { classifyTelegramCreateFailure, localFailureCategory, retrySqliteBusy, sendTextAndPersist, SentMessagePersistenceError, type TextSendApi } from "./send.ts";

export interface TelegramControlCommandPort {
	handle(command: ParsedTelegramControlCommand): Promise<TelegramControlResult>;
	consumeReply(botId: string, chatId: number, messageId: number): void;
}

export interface TelegramControlReplyNotification {
	botId: string;
	chatId: number;
	messageId: number;
}

export type TelegramControlDeliveryResult =
	| { outcome: "sent"; botId: string; chatId: number; messageId: number }
	| { outcome: "no_reply" | "failed"; category?: string };

/** Command execution + existing plain send/canonical projection, with no remote retry. */
export class TelegramControlCoordinator {
	constructor(
		private readonly db: Database,
		private readonly commands: TelegramControlCommandPort,
		private readonly apis: ReadonlyMap<string, TextSendApi>,
		private readonly onSent?: (message: TelegramControlReplyNotification) => void,
		private readonly warn: (message: string) => void = (message) => log.warn("telegram_control", "operation_failed", { detail: message }),
	) {}

	async handle(command: ParsedTelegramControlCommand): Promise<TelegramControlDeliveryResult> {
		let result: TelegramControlResult;
		try {
			result = await this.commands.handle(command);
		} catch {
			this.warn(`[telegram-control] command failed bot=${command.replyBotId} msg=#${command.messageId} category=local_failure`);
			return { outcome: "failed", category: "local_failure" };
		}
		if (result.text == null) return { outcome: "no_reply" };
		const api = this.apis.get(result.replyBotId);
		if (!api) {
			this.warn(`[telegram-control] reply failed bot=${result.replyBotId} msg=#${result.replyToMessageId} category=unknown_bot`);
			return { outcome: "failed", category: "unknown_bot" };
		}

		try {
			const { canonical } = await sendTextAndPersist(
				this.db,
				api,
				result.replyBotId,
				result.chatId,
				result.text,
				result.replyToMessageId,
			);
			try {
				await retrySqliteBusy(() => this.commands.consumeReply(
					result.replyBotId,
					canonical.chat_id,
					canonical.message_id,
				));
			} catch (error) {
				this.warn(`[telegram-control] reply marker failed bot=${result.replyBotId} msg=#${canonical.message_id} category=${localFailureCategory(error)}`);
			}
			try {
				this.onSent?.({ botId: result.replyBotId, chatId: canonical.chat_id, messageId: canonical.message_id });
			} catch {
				this.warn(`[telegram-control] reply broadcast failed bot=${result.replyBotId} msg=#${canonical.message_id} category=local_failure`);
			}
			return { outcome: "sent", botId: result.replyBotId, chatId: canonical.chat_id, messageId: canonical.message_id };
		} catch (error) {
			const category = error instanceof SentMessagePersistenceError
				? localFailureCategory(error.cause)
				: classifyTelegramCreateFailure(error).category;
			this.warn(`[telegram-control] reply failed bot=${result.replyBotId} msg=#${result.replyToMessageId} category=${category}`);
			return { outcome: "failed", category };
		}
	}
}

export interface TelegramMenuApi {
	setMyCommands(commands: readonly { command: string; description: string }[]): Promise<true>;
}

export const TELEGRAM_CONTROL_MENU = [{
	command: "tg",
	description: "Telegram agent controls (help, status, admin)",
}] as const;

/** Startup capability only: every bot attempts the same menu, failures never block polling. */
export async function publishTelegramControlMenus(
	apis: ReadonlyMap<string, TelegramMenuApi>,
	warn: (message: string) => void = (message) => log.warn("telegram_control", "menu_publish_failed", { detail: message }),
): Promise<void> {
	await Promise.all([...apis].map(async ([botId, api]) => {
		try {
			await api.setMyCommands(TELEGRAM_CONTROL_MENU);
		} catch {
			warn(`[telegram-control] menu publish failed bot=${botId} category=request_failed`);
		}
	}));
}
