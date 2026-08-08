import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDebugReport, parseDebugDuration } from "../src/observability/debug-report.ts";
import type { LogRecord } from "../src/observability/log.ts";

const CHAT = -1004402809405;
let db: Database;

beforeEach(() => {
	db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
});

describe("bounded read-only debug report (REQ-OBS-0001)", () => {
	test("correlates route/run/silence/preflight/degraded/backlog without content", () => {
		const now = 1_786_212_000_000;
		db.query("INSERT INTO message_events (event_key,chat_id,message_id,revision,kind,event_date,payload_json) VALUES ('m1',?,10,0,'message',?,?)")
			.run(CHAT, Math.floor(now / 1000) - 300, JSON.stringify({ text: "CANARY_MESSAGE_BODY", token: "123456789:SECRETSECRET" }));
		db.query("INSERT INTO routing_claims VALUES (?,?,?,1,'probability','started',?,?)")
			.run(CHAT, 10, "A", now - 300_000, now - 300_000);
		db.query("INSERT INTO reply_obligations VALUES (?,?,?,?)").run("A", CHAT, 10, Math.floor(now / 1000));
		db.query("INSERT INTO llm_runs (bot_id,ts,model,epoch,trigger_message_id,public_send_count) VALUES ('A',?,'m',1,11,0)").run(now - 10_000);
		db.query("INSERT INTO agent_events (bot_id,ts,kind,payload) VALUES ('A',?,'assistant_text',?)")
			.run(now - 9_000, JSON.stringify({ text: "CANARY_ASSISTANT_TEXT" }));
		db.query("INSERT INTO agent_events (bot_id,ts,kind,payload) VALUES ('A',?,'send_degraded',?)")
			.run(now - 8_000, JSON.stringify({ outcome: "committed", failures: [{ category: "sqlite_busy" }], secret: "CANARY_SECRET" }));
		const logs: LogRecord[] = [{
			schema: 1, ts: new Date(now - 7_000).toISOString(), level: "warn", component: "agent_send", event: "preflight_failed",
			fields: { bot_id: "A", trigger_message_id: 11, category: "reply_not_visible" },
		}];

		const report = buildDebugReport(db, { botIds: ["A"], chatId: CHAT, sinceMs: 600_000, now, logs });
		const serialized = JSON.stringify(report);
		expect(report.findings).toEqual(expect.arrayContaining([
			expect.objectContaining({ code: "cursor_backlog", bot_id: "A" }),
			expect.objectContaining({ code: "pending_reply_obligation", bot_id: "A" }),
			expect.objectContaining({ code: "route_without_run", bot_id: "A", message_id: 10 }),
			expect.objectContaining({ code: "model_silence", bot_id: "A", message_id: 11 }),
			expect.objectContaining({ code: "tool_preflight_failed", category: "reply_not_visible" }),
			expect.objectContaining({ code: "send_degraded", outcome: "committed" }),
		]));
		expect(serialized).not.toContain("CANARY_MESSAGE_BODY");
		expect(serialized).not.toContain("CANARY_ASSISTANT_TEXT");
		expect(serialized).not.toContain("CANARY_SECRET");
		expect(serialized).not.toContain("SECRETSECRET");
	});

	test("duration parser is explicit and bounded to seven days", () => {
		expect(parseDebugDuration("30s")).toBe(30_000);
		expect(parseDebugDuration("15m")).toBe(900_000);
		expect(parseDebugDuration("2h")).toBe(7_200_000);
		expect(parseDebugDuration("7d")).toBe(604_800_000);
		expect(parseDebugDuration("8d")).toBeNull();
		expect(parseDebugDuration("forever")).toBeNull();
	});
});
