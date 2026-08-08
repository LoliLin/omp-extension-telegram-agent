import type { Database } from "bun:sqlite";
import type { BotConfig } from "../config.ts";
import { deleteBotState, getBotState, setBotState } from "../db/db.ts";

export const CONTROL_ROUTING_KEY = "telegram_override:routing_p";
export const CONTROL_COOLDOWN_KEY = "telegram_override:cooldown_ms";
export const CONTROL_COOLDOWN_MAX_MS = 3_600_000;

export type ControlParameter = "routing_p" | "cooldown_ms";
export type ControlValueSource = "config" | "telegram_override";

export interface EffectiveBotControl {
	botId: string;
	routingP: number;
	routingSource: ControlValueSource;
	cooldownMs: number;
	cooldownSource: ControlValueSource;
}

export type ControlMutationResult =
	| { ok: true; value: EffectiveBotControl }
	| { ok: false; code: "unknown_bot" | "unknown_parameter" | "invalid_value" | "probability_sum"; error: string };

export class ControlStateError extends Error {
	constructor(readonly errors: string[]) {
		super(`invalid Telegram control state:\n${errors.join("\n")}`);
		this.name = "ControlStateError";
	}
}

interface BaseBotControl {
	routingP: number;
	cooldownMs: number;
}

/** Owns effective mutable routing state while preserving file config as the reset baseline. */
export class TelegramControlState {
	private readonly bots: Map<string, BotConfig>;
	private readonly base = new Map<string, BaseBotControl>();
	private readonly routingOverrides = new Map<string, number>();
	private readonly cooldownOverrides = new Map<string, number>();

	constructor(private readonly db: Database, bots: readonly BotConfig[]) {
		this.bots = new Map(bots.map((bot) => [bot.id, bot]));
		for (const bot of bots) {
			this.base.set(bot.id, { routingP: bot.routingP, cooldownMs: bot.samplingCooldownMs });
		}
		this.restore();
	}

	get(botId: string): EffectiveBotControl | null {
		const bot = this.bots.get(botId);
		if (!bot) return null;
		return {
			botId,
			routingP: bot.routingP,
			routingSource: this.routingOverrides.has(botId) ? "telegram_override" : "config",
			cooldownMs: bot.samplingCooldownMs,
			cooldownSource: this.cooldownOverrides.has(botId) ? "telegram_override" : "config",
		};
	}

	list(): EffectiveBotControl[] {
		return [...this.bots.keys()].map((botId) => this.get(botId)!);
	}

	set(botId: string, parameter: string, value: number): ControlMutationResult {
		const bot = this.bots.get(botId);
		if (!bot) return { ok: false, code: "unknown_bot", error: `unknown bot id: ${botId}` };
		if (parameter !== "routing_p" && parameter !== "cooldown_ms") {
			return { ok: false, code: "unknown_parameter", error: `unknown control parameter: ${parameter}` };
		}
		const invalid = this.validate(parameter, value);
		if (invalid) return invalid;
		if (parameter === "routing_p") {
			const sum = this.routingSum(botId, value);
			if (sum > 1) {
				return { ok: false, code: "probability_sum", error: `effective routing_p sum would be ${sum.toFixed(6)}; maximum is 1` };
			}
			this.db.transaction(() => setBotState(this.db, botId, CONTROL_ROUTING_KEY, String(value)))();
			this.routingOverrides.set(botId, value);
			bot.routingP = value;
		} else {
			this.db.transaction(() => setBotState(this.db, botId, CONTROL_COOLDOWN_KEY, String(value)))();
			this.cooldownOverrides.set(botId, value);
			bot.samplingCooldownMs = value;
		}
		return { ok: true, value: this.get(botId)! };
	}

	reset(botId: string, parameter: string): ControlMutationResult {
		const bot = this.bots.get(botId);
		const base = this.base.get(botId);
		if (!bot || !base) return { ok: false, code: "unknown_bot", error: `unknown bot id: ${botId}` };
		if (parameter !== "routing_p" && parameter !== "cooldown_ms") {
			return { ok: false, code: "unknown_parameter", error: `unknown control parameter: ${parameter}` };
		}
		if (parameter === "routing_p") {
			const sum = this.routingSum(botId, base.routingP);
			if (sum > 1) {
				return { ok: false, code: "probability_sum", error: `effective routing_p sum would be ${sum.toFixed(6)}; maximum is 1` };
			}
			this.db.transaction(() => deleteBotState(this.db, botId, CONTROL_ROUTING_KEY))();
			this.routingOverrides.delete(botId);
			bot.routingP = base.routingP;
		} else {
			this.db.transaction(() => deleteBotState(this.db, botId, CONTROL_COOLDOWN_KEY))();
			this.cooldownOverrides.delete(botId);
			bot.samplingCooldownMs = base.cooldownMs;
		}
		return { ok: true, value: this.get(botId)! };
	}

	private restore(): void {
		const errors: string[] = [];
		for (const [botId, bot] of this.bots) {
			const routingRaw = getBotState(this.db, botId, CONTROL_ROUTING_KEY);
			if (routingRaw != null) {
				const value = parseStoredNumber(routingRaw);
				if (value == null || value < 0 || value > 1) errors.push(`${botId}.${CONTROL_ROUTING_KEY}: invalid value`);
				else this.routingOverrides.set(botId, value);
			}
			const cooldownRaw = getBotState(this.db, botId, CONTROL_COOLDOWN_KEY);
			if (cooldownRaw != null) {
				const value = parseStoredNumber(cooldownRaw);
				if (value == null || !Number.isSafeInteger(value) || value < 0 || value > CONTROL_COOLDOWN_MAX_MS) {
					errors.push(`${botId}.${CONTROL_COOLDOWN_KEY}: invalid value`);
				} else this.cooldownOverrides.set(botId, value);
			}
		}
		const routingSum = [...this.bots.keys()].reduce(
			(sum, botId) => sum + (this.routingOverrides.get(botId) ?? this.base.get(botId)!.routingP),
			0,
		);
		if (routingSum > 1) errors.push(`effective routing_p sum ${routingSum.toFixed(6)} exceeds 1`);
		if (errors.length > 0) {
			this.routingOverrides.clear();
			this.cooldownOverrides.clear();
			throw new ControlStateError(errors);
		}
		for (const [botId, value] of this.routingOverrides) this.bots.get(botId)!.routingP = value;
		for (const [botId, value] of this.cooldownOverrides) this.bots.get(botId)!.samplingCooldownMs = value;
	}

	private validate(parameter: ControlParameter, value: number): Extract<ControlMutationResult, { ok: false }> | null {
		if (!Number.isFinite(value)) {
			return { ok: false, code: "invalid_value", error: `${parameter} must be finite` };
		}
		if (parameter === "routing_p" && (value < 0 || value > 1)) {
			return { ok: false, code: "invalid_value", error: "routing_p must be in [0, 1]" };
		}
		if (parameter === "cooldown_ms" && (!Number.isSafeInteger(value) || value < 0 || value > CONTROL_COOLDOWN_MAX_MS)) {
			return { ok: false, code: "invalid_value", error: `cooldown_ms must be an integer in [0, ${CONTROL_COOLDOWN_MAX_MS}]` };
		}
		return null;
	}

	private routingSum(replacedBotId: string, replacement: number): number {
		let sum = 0;
		for (const [botId, bot] of this.bots) sum += botId === replacedBotId ? replacement : bot.routingP;
		return sum;
	}
}

function parseStoredNumber(value: string): number | null {
	if (!value.trim()) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}
