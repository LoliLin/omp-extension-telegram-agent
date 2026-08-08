import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotConfig } from "../src/config.ts";
import { getBotState, openDb, setBotState } from "../src/db/db.ts";
import {
	CONTROL_COOLDOWN_KEY,
	CONTROL_ROUTING_KEY,
	ControlStateError,
	TelegramControlState,
} from "../src/telegram/control-state.ts";

function bot(id: string, routingP: number, cooldownMs: number): BotConfig {
	return {
		id,
		name: id,
		token: `${id}:token`,
		personaPath: `/tmp/${id}.md`,
		routingP,
		samplingCooldownMs: cooldownMs,
		provider: "deepseek",
		model: "model",
		reasoningEffort: "medium",
		compactionThreshold: 128_000,
		compactionKeepRecent: 20_000,
		tools: { send: true, search: true, runJs: true },
		stickerSets: [],
	};
}

describe("Telegram control parameter state (REQ-CMD-0001)", () => {
	test("set applies immediately, persists across file reopen, and reports override sources", () => {
		const dir = mkdtempSync(join(tmpdir(), "tg-control-state-"));
		const path = join(dir, "agent.db");
		let db = openDb(path);
		try {
			const bots = [bot("A", 0.2, 2_000), bot("B", 0.3, 3_000)];
			const state = new TelegramControlState(db, bots);
			expect(state.set("A", "routing_p", 0.4)).toMatchObject({ ok: true });
			expect(state.set("B", "cooldown_ms", 0)).toMatchObject({ ok: true });
			expect(bots.map((value) => [value.routingP, value.samplingCooldownMs])).toEqual([[0.4, 2_000], [0.3, 0]]);
			expect(state.get("A")).toMatchObject({ routingP: 0.4, routingSource: "telegram_override", cooldownSource: "config" });
			expect(state.get("B")).toMatchObject({ cooldownMs: 0, cooldownSource: "telegram_override", routingSource: "config" });
			db.close();

			db = openDb(path);
			const restartedBots = [bot("A", 0.2, 2_000), bot("B", 0.3, 3_000)];
			const restarted = new TelegramControlState(db, restartedBots);
			expect(restartedBots.map((value) => [value.routingP, value.samplingCooldownMs])).toEqual([[0.4, 2_000], [0.3, 0]]);
			expect(restarted.list().map((value) => [value.botId, value.routingSource, value.cooldownSource])).toEqual([
				["A", "telegram_override", "config"],
				["B", "config", "telegram_override"],
			]);
		} finally {
			try { db.close(); } catch {}
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("reset restores file values without rewriting config", () => {
		const db = openDb(":memory:");
		const bots = [bot("A", 0.2, 2_000), bot("B", 0.3, 3_000)];
		try {
			const state = new TelegramControlState(db, bots);
			state.set("A", "routing_p", 0.5);
			state.set("A", "cooldown_ms", 10);
			expect(state.reset("A", "routing_p")).toMatchObject({ ok: true, value: { routingP: 0.2, routingSource: "config" } });
			expect(state.reset("A", "cooldown_ms")).toMatchObject({ ok: true, value: { cooldownMs: 2_000, cooldownSource: "config" } });
			expect(getBotState(db, "A", CONTROL_ROUTING_KEY)).toBeNull();
			expect(getBotState(db, "A", CONTROL_COOLDOWN_KEY)).toBeNull();
		} finally {
			db.close();
		}
	});

	test("invalid values, unknown targets, and probability overflow cause zero state changes", () => {
		const db = openDb(":memory:");
		const bots = [bot("A", 0.6, 2_000), bot("B", 0.4, 3_000)];
		try {
			const state = new TelegramControlState(db, bots);
			const before = state.list();
			expect(state.set("A", "routing_p", 0.7)).toMatchObject({ ok: false, code: "probability_sum" });
			expect(state.set("A", "routing_p", Number.NaN)).toMatchObject({ ok: false, code: "invalid_value" });
			expect(state.set("A", "cooldown_ms", 3_600_001)).toMatchObject({ ok: false, code: "invalid_value" });
			expect(state.set("A", "cooldown_ms", 1.5)).toMatchObject({ ok: false, code: "invalid_value" });
			expect(state.set("missing", "routing_p", 0)).toMatchObject({ ok: false, code: "unknown_bot" });
			expect(state.set("A", "model", 0)).toMatchObject({ ok: false, code: "unknown_parameter" });
			expect(state.list()).toEqual(before);
			expect(getBotState(db, "A", CONTROL_ROUTING_KEY)).toBeNull();
			expect(getBotState(db, "A", CONTROL_COOLDOWN_KEY)).toBeNull();
		} finally {
			db.close();
		}
	});

	test("reset also rejects an effective probability overflow atomically", () => {
		const db = openDb(":memory:");
		const bots = [bot("A", 0.6, 2_000), bot("B", 0.4, 3_000)];
		try {
			const state = new TelegramControlState(db, bots);
			expect(state.set("A", "routing_p", 0.2)).toMatchObject({ ok: true });
			expect(state.set("B", "routing_p", 0.7)).toMatchObject({ ok: true });
			expect(state.reset("A", "routing_p")).toMatchObject({ ok: false, code: "probability_sum" });
			expect(state.get("A")).toMatchObject({ routingP: 0.2, routingSource: "telegram_override" });
			expect(getBotState(db, "A", CONTROL_ROUTING_KEY)).toBe("0.2");
		} finally {
			db.close();
		}
	});

	test("corrupt persisted overrides fail startup before mutating config objects", () => {
		for (const [key, value] of [
			[CONTROL_ROUTING_KEY, "NaN"],
			[CONTROL_COOLDOWN_KEY, "1.5"],
		] as const) {
			const db = openDb(":memory:");
			const bots = [bot("A", 0.2, 2_000)];
			try {
				setBotState(db, "A", key, value);
				expect(() => new TelegramControlState(db, bots)).toThrow(ControlStateError);
				expect([bots[0]!.routingP, bots[0]!.samplingCooldownMs]).toEqual([0.2, 2_000]);
			} finally {
				db.close();
			}
		}
	});
});
