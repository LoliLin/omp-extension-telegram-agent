process.env.TZ = "Asia/Singapore";

import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/db.ts";
import { IpcServer } from "../src/daemon/ipc-server.ts";
import { serializeMessages, type MessageRow } from "../src/agent/serialize.ts";
import { ingestUpdate, insertSentMessage } from "../src/telegram/ingest.ts";
import { setLogSink } from "../src/observability/log.ts";
import {
	normalizeRichMessage,
	projectRichMessage,
	RICH_MESSAGE_MAX_CHARS,
	RICH_MESSAGE_MAX_DEPTH,
	RICH_MESSAGE_MAX_NODES,
	RICH_MESSAGE_RAW_MAX_BYTES,
	RICH_MESSAGE_TRUNCATED,
	RICH_MESSAGE_UNAVAILABLE,
} from "../src/telegram/rich-message.ts";

const GROUP = 4402809405;
const CHAT = Number(`-100${GROUP}`);

let db: Database;
beforeEach(() => {
	db = new Database(":memory:");
	db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
});

function message(messageId: number, richMessage: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		message_id: messageId,
		from: { id: 111, is_bot: false, first_name: "Alice", username: "alice" },
		chat: { id: CHAT, type: "supergroup", title: "test" },
		date: 1754600000 + messageId,
		rich_message: richMessage,
		...overrides,
	};
}

function update(updateId: number, raw: Record<string, unknown>, edited = false): Record<string, unknown> {
	return edited ? { update_id: updateId, edited_message: raw } : { update_id: updateId, message: raw };
}

const richFixture = {
	blocks: [
		{ type: "heading", size: 1, text: ["报告", { type: "bold", text: "概览" }] },
		{
			type: "paragraph",
			text: [{ type: "url", text: "详情", url: "https://secret.example/path" }, "链接"],
		},
		{
			type: "list",
			items: [
				{ label: "1.", blocks: [{ type: "paragraph", text: "第一项" }] },
				{ label: "•", has_checkbox: true, is_checked: true, blocks: [{ type: "paragraph", text: "第二项" }] },
			],
		},
		{
			type: "table",
			caption: "指标",
			cells: [
				[{ text: "名称", is_header: true, align: "left" }, { text: "值", is_header: true, align: "right" }],
				[{ text: "命中" }, { text: "90%" }],
			],
		},
		{ type: "details", summary: "更多", blocks: [{ type: "paragraph", text: "隐藏内容" }], is_open: true },
		{
			type: "photo",
			photo: { file_id: "private-file-id", file_unique_id: "private-unique-id" },
			caption: { text: "图片说明", credit: "摄影者" },
		},
		{
			type: "future_block",
			text: "未来块",
			children: [{ text: "子内容", url: "https://ignored.example" }],
			file_id: "ignored-file-id",
		},
	],
	is_rtl: false,
};

const expectedProjection = [
	"报告概览",
	"详情链接",
	"1. 第一项",
	"• [x] 第二项",
	"指标",
	"名称 | 值",
	"命中 | 90%",
	"更多",
	"隐藏内容",
	"图片说明 — 摄影者",
	"未来块",
	"子内容",
].join("\n");

describe("bounded rich message projection (REQ-TG-0003)", () => {
	test("projects inline wrappers, lists, tables, details, media captions, and unknown blocks in order", () => {
		const projected = projectRichMessage(richFixture);

		expect(projected.text).toBe(expectedProjection);
		expect(projected.truncated).toBe(false);
		expect(projected.blocks).toBeGreaterThan(0);
		expect(projected.text).not.toContain("https://");
		expect(projected.text).not.toContain("file-id");
		expect(projected.text).not.toContain("[object Object]");
	});

	test("malformed input is readable and oversized source/text use one bounded diagnostic", () => {
		expect(projectRichMessage(42).text).toBe(RICH_MESSAGE_UNAVAILABLE);

		const oversized = { blocks: [{ type: "paragraph", text: "界".repeat(RICH_MESSAGE_RAW_MAX_BYTES) }] };
		const normalized = normalizeRichMessage(oversized);
		expect(normalized.rawTruncated).toBe(true);
		expect(normalized.rawBytes).toBeGreaterThan(RICH_MESSAGE_RAW_MAX_BYTES);
		expect(JSON.parse(normalized.source)).toMatchObject({ truncated: true, reason: "raw_bytes" });
		expect(normalized.source).not.toContain("界");
		expect([...normalized.text].length).toBeLessThanOrEqual(RICH_MESSAGE_MAX_CHARS);
		expect(normalized.text.endsWith(RICH_MESSAGE_TRUNCATED)).toBe(true);
		expect(normalized.text.split(RICH_MESSAGE_TRUNCATED)).toHaveLength(2);
	});

	test("depth, node, and cycle limits terminate deterministically", () => {
		let nested: unknown = { type: "paragraph", text: "deep" };
		for (let index = 0; index < RICH_MESSAGE_MAX_DEPTH + 3; index++) {
			nested = { type: "details", summary: `level-${index}`, blocks: [nested] };
		}
		const deep = projectRichMessage({ blocks: [nested] });
		expect(deep.truncated).toBe(true);
		expect(deep.text.split(RICH_MESSAGE_TRUNCATED)).toHaveLength(2);

		const many = projectRichMessage({
			blocks: [{ type: "paragraph", text: Array.from({ length: RICH_MESSAGE_MAX_NODES + 10 }, (_, i) => ({ text: String(i) })) }],
		});
		expect(many.truncated).toBe(true);
		expect(many.nodes).toBeGreaterThan(RICH_MESSAGE_MAX_NODES);

		const cyclic: { blocks: unknown[] } = { blocks: [] };
		cyclic.blocks.push(cyclic);
		expect(projectRichMessage(cyclic).text.endsWith(RICH_MESSAGE_TRUNCATED)).toBe(true);
	});
});

describe("rich message canonical data plane (REQ-TG-0003)", () => {
	test("incoming rich source is bounded in DB while IPC and provider see only the projection", () => {
		expect(ingestUpdate(db, "A", update(1, message(100, richFixture)), GROUP).kind).toBe("inserted");
		const row = db.query("SELECT * FROM messages WHERE message_id = 100").get() as MessageRow & { rich_message: string };

		expect(row.text).toBe(expectedProjection);
		expect(JSON.parse(row.rich_message)).toEqual(richFixture);
		const server = new IpcServer(db, "/tmp/unused-rich-message.sock", new Map([["A", "小雪"]]), new Map([["A", 777]]));
		const item = server.msgToItem(row);
		expect(item.text).toBe(expectedProjection);
		expect(JSON.stringify(item)).not.toContain("secret.example");
		expect(JSON.stringify(item)).not.toContain("private-file-id");

		const suffix = serializeMessages(db, [row], { visibleIds: new Set() });
		expect(suffix).toContain(expectedProjection);
		expect(suffix).not.toContain("secret.example");
		expect(suffix).not.toContain("private-file-id");
	});

	test("malformed rich data preserves an existing plain text fallback", () => {
		expect(ingestUpdate(db, "A", update(2, message(104, 42, { text: "server plain fallback" })), GROUP).kind).toBe("inserted");
		expect(db.query("SELECT text, rich_message FROM messages WHERE message_id = 104").get()).toEqual({
			text: "server plain fallback",
			rich_message: "42",
		});
	});

	test("rich edits retain the old source revision and replace the current projection", () => {
		const v1 = { blocks: [{ type: "paragraph", text: "第一版" }] };
		const v2 = { blocks: [{ type: "heading", text: "第二版", size: 2 }] };
		ingestUpdate(db, "A", update(10, message(101, v1)), GROUP);
		const edited = message(101, v2, { edit_date: 1754609999 });
		expect(ingestUpdate(db, "A", update(11, edited, true), GROUP).kind).toBe("edited");

		const current = db.query("SELECT text, rich_message, edit_date FROM messages WHERE message_id = 101").get() as Record<string, unknown>;
		expect(current.text).toBe("第二版");
		expect(JSON.parse(current.rich_message as string)).toEqual(v2);
		const revision = db.query("SELECT text, rich_message FROM message_revisions WHERE message_id = 101").get() as Record<string, unknown>;
		expect(revision.text).toBe("第一版");
		expect(JSON.parse(revision.rich_message as string)).toEqual(v1);
	});

	test("agent immediate insert followed by another bot poller echo remains one rich row", () => {
		const raw = message(102, richFixture, {
			from: { id: 777, is_bot: true, first_name: "小雪", username: "hastuyuki_bot" },
		});
		const canonical = insertSentMessage(db, "A", raw);
		expect(canonical.text).toBe(expectedProjection);
		expect(canonical.rich_message).not.toBeNull();

		expect(ingestUpdate(db, "B", update(20, raw), GROUP).kind).toBe("duplicate");
		expect(db.query("SELECT COUNT(*) n FROM messages WHERE message_id = 102").get()).toEqual({ n: 1 });
		const stored = db.query("SELECT text, rich_message FROM messages WHERE message_id = 102").get() as Record<string, unknown>;
		expect(stored.text).toBe(expectedProjection);
		expect(JSON.parse(stored.rich_message as string)).toEqual(richFixture);
	});

	test("truncation emits one bounded diagnostic and a duplicate echo emits none", () => {
		const oversized = { blocks: [{ type: "paragraph", text: "x".repeat(RICH_MESSAGE_MAX_CHARS + 100) }] };
		const warnings: string[] = [];
		const restore = setLogSink((line) => warnings.push(line));
		try {
			expect(ingestUpdate(db, "A", update(21, message(103, oversized)), GROUP).kind).toBe("inserted");
			expect(ingestUpdate(db, "B", update(22, message(103, oversized)), GROUP).kind).toBe("duplicate");
		} finally {
			restore();
		}
		expect(warnings).toHaveLength(1);
		expect(JSON.parse(warnings[0]!)).toMatchObject({
			level: "warn", component: "telegram_ingest", event: "rich_parse_truncated",
			fields: { bot_id: "A", message_id: 103 },
		});
		expect(warnings[0]).not.toContain("xxxxx");
	});

	test("old file databases migrate idempotently and preserve plain and rich rows across reopen", () => {
		const path = join(tmpdir(), `rich-migration-${process.pid}-${Date.now()}.db`);
		let fileDb: Database | null = null;
		try {
			const legacy = new Database(path, { create: true });
			legacy.exec(`
				CREATE TABLE messages (
					chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, date INTEGER NOT NULL,
					thread_id INTEGER, sender_id INTEGER, display_name TEXT, username TEXT,
					sender_tag TEXT, sender_chat TEXT, is_bot INTEGER NOT NULL DEFAULT 0,
					text TEXT, caption TEXT, entities TEXT, reply_to_message_id INTEGER,
					quote TEXT, forward_origin TEXT, edit_date INTEGER, media TEXT,
					first_seen_by TEXT NOT NULL, PRIMARY KEY (chat_id, message_id)
				);
				CREATE TABLE message_revisions (
					chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, edit_date INTEGER NOT NULL,
					text TEXT, caption TEXT, entities TEXT,
					PRIMARY KEY (chat_id, message_id, edit_date)
				);
			`);
			legacy.query("INSERT INTO messages (chat_id, message_id, date, sender_id, display_name, is_bot, text, first_seen_by) VALUES (?, 1, 1, 111, 'Alice', 0, 'legacy plain', 'A')").run(CHAT);
			legacy.close();

			fileDb = openDb(path);
			const columns = (fileDb.query("PRAGMA table_info(messages)").all() as { name: string }[]).map((column) => column.name);
			const revisionColumns = (fileDb.query("PRAGMA table_info(message_revisions)").all() as { name: string }[]).map((column) => column.name);
			expect(columns).toContain("rich_message");
			expect(revisionColumns).toContain("rich_message");
			expect(fileDb.query("SELECT text, rich_message FROM messages WHERE message_id = 1").get()).toEqual({ text: "legacy plain", rich_message: null });
			ingestUpdate(fileDb, "A", update(30, message(2, richFixture)), GROUP);
			fileDb.close();
			fileDb = openDb(path);
			const reopened = fileDb.query("SELECT text, rich_message FROM messages WHERE message_id = 2").get() as Record<string, unknown>;
			expect(reopened.text).toBe(expectedProjection);
			expect(JSON.parse(reopened.rich_message as string)).toEqual(richFixture);
		} finally {
			fileDb?.close();
			for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
		}
	});
});
