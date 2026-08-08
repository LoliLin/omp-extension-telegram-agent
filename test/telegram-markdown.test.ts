import { describe, expect, test } from "bun:test";
import {
	formatTelegramMarkdown,
	TelegramMarkdownError,
	type TelegramMessageEntity,
} from "../src/telegram/markdown.ts";

function assertUtf16Boundaries(text: string, entities: readonly TelegramMessageEntity[]): void {
	for (const entity of entities) {
		const start = entity.offset;
		const end = entity.offset + entity.length;
		for (const boundary of [start, end]) {
			if (boundary <= 0 || boundary >= text.length) continue;
			const previous = text.charCodeAt(boundary - 1);
			const next = text.charCodeAt(boundary);
			expect(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff).toBe(false);
		}
	}
}

describe("Markdown to Telegram entities (REQ-TG-0004)", () => {
	test("ordinary CJK and emoji remain byte-for-byte plain with no entity", () => {
		expect(formatTelegramMarkdown("普通中文 😀")).toEqual({ text: "普通中文 😀", entities: [] });
	});

	test("explicit nested inline styles use JavaScript UTF-16 offsets and split around code", () => {
		const formatted = formatTelegramMarkdown("😀 **粗 _斜_ `码` 尾** 与 ~~删~~");
		expect(formatted).toEqual({
			text: "😀 粗 斜 码 尾 与 删",
			entities: [
				{ type: "bold", offset: 3, length: 4 },
				{ type: "italic", offset: 5, length: 1 },
				{ type: "code", offset: 7, length: 1 },
				{ type: "bold", offset: 8, length: 2 },
				{ type: "strikethrough", offset: 13, length: 1 },
			],
		});
		assertUtf16Boundaries(formatted.text, formatted.entities);
	});

	test("headings, lists, task markers, tables, and simple quotes remain readable", () => {
		const formatted = formatTelegramMarkdown([
			"# 标题",
			"",
			"- A",
			"- B",
			"  1. C",
			"",
			"- [x] done",
			"",
			"| 名称 | 值 |",
			"| --- | --- |",
			"| hit | 90% |",
			"",
			"> **引用**",
		].join("\n"));
		expect(formatted.text).toBe("标题\n\n• A\n• B\n  1. C\n• [x] done\n\n名称 | 值\nhit | 90%\n\n引用");
		expect(formatted.entities).toContainEqual({ type: "bold", offset: 0, length: 2 });
		expect(formatted.entities).toContainEqual({ type: "blockquote", offset: formatted.text.length - 2, length: 2 });
		expect(formatted.entities).toContainEqual({ type: "bold", offset: formatted.text.length - 2, length: 2 });
		assertUtf16Boundaries(formatted.text, formatted.entities);
	});

	test("fenced code becomes pre with a sanitized optional language", () => {
		expect(formatTelegramMarkdown("```ts title=x\nconst ok = true;\n```")).toEqual({
			text: "const ok = true;",
			entities: [{ type: "pre", offset: 0, length: 16, language: "ts" }],
		});
		expect(formatTelegramMarkdown("```bad/lang\nx\n```")).toEqual({
			text: "x",
			entities: [{ type: "pre", offset: 0, length: 1 }],
		});
	});

	test("public HTTP(S) links become text_link while private links and images stay inert", () => {
		const formatted = formatTelegramMarkdown(
			"[安全](https://example.com/a?q=1) [内网](http://127.0.0.1/x) [js](javascript:alert(1)) [data](data:text/plain,x) [file](file:///tmp/x) ![图片](https://example.com/x.png)",
		);
		expect(formatted).toEqual({
			text: "安全 内网 js data file 图片",
			entities: [{ type: "text_link", url: "https://example.com/a?q=1", offset: 0, length: 2 }],
		});
	});

	test("raw HTML is literal and never becomes a Telegram parse mode", () => {
		expect(formatTelegramMarkdown("<b>raw</b>")).toEqual({ text: "<b>raw</b>", entities: [] });
	});

	test("non-style wrappers are omitted when they would overlap code or another wrapper", () => {
		expect(formatTelegramMarkdown("> `quoted code`")).toEqual({
			text: "quoted code",
			entities: [{ type: "code", offset: 0, length: 11 }],
		});
		expect(formatTelegramMarkdown("[**safe**](https://example.com)")).toEqual({
			text: "safe",
			entities: [
				{ type: "text_link", url: "https://example.com/", offset: 0, length: 4 },
				{ type: "bold", offset: 0, length: 4 },
			],
		});
	});

	test("empty, source length, and entity count fail locally with fixed redacted errors", () => {
		for (const source of ["", " \n\t"]) {
			expect(() => formatTelegramMarkdown(source)).toThrow(new TelegramMarkdownError("empty"));
		}
		const tooLong = "😀".repeat(4097);
		try {
			formatTelegramMarkdown(tooLong);
			throw new Error("expected too_long");
		} catch (error) {
			expect(error).toBeInstanceOf(TelegramMarkdownError);
			expect((error as TelegramMarkdownError).category).toBe("too_long");
			expect((error as Error).message).toBe("telegram_markdown_too_long");
			expect((error as Error).message).not.toContain("😀");
		}
		const tooManyEntities = "**x** ".repeat(101);
		expect(() => formatTelegramMarkdown(tooManyEntities)).toThrow(new TelegramMarkdownError("too_complex"));
	});

	test("all emitted entities are sorted outer-first, non-empty, nested or disjoint", () => {
		const { text, entities } = formatTelegramMarkdown("[**粗 _斜_**](https://example.com) and `code` 😀");
		expect(entities).toEqual([
			{ type: "text_link", url: "https://example.com/", offset: 0, length: 3 },
			{ type: "bold", offset: 0, length: 3 },
			{ type: "italic", offset: 2, length: 1 },
			{ type: "code", offset: 8, length: 4 },
		]);
		for (const entity of entities) expect(entity.length).toBeGreaterThan(0);
		assertUtf16Boundaries(text, entities);
	});
});
