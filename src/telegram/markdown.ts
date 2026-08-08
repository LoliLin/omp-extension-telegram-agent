import { Marked, type Token, type Tokens } from "@earendil-works/pi-tui";
import { parsePublicHttpUrl } from "../net/public-url.ts";

const MAX_CODE_POINTS = 4096;
const MAX_TOKEN_NODES = 4096;
const MAX_ENTITIES = 100;
const MARKED = new Marked();

export type TelegramMessageEntity =
	| { type: "bold" | "italic" | "strikethrough" | "code" | "blockquote"; offset: number; length: number }
	| { type: "pre"; offset: number; length: number; language?: string }
	| { type: "text_link"; offset: number; length: number; url: string };

export interface TelegramFormattedMessage {
	text: string;
	entities: TelegramMessageEntity[];
}

export type TelegramMarkdownErrorCategory = "empty" | "too_long" | "too_complex" | "invalid";

export class TelegramMarkdownError extends Error {
	constructor(public readonly category: TelegramMarkdownErrorCategory) {
		super(`telegram_markdown_${category}`);
		this.name = "TelegramMarkdownError";
	}
}

interface Fragment {
	text: string;
	entities: TelegramMessageEntity[];
}

type TelegramNonStyleEntity = { type: "blockquote" } | { type: "text_link"; url: string };

const EMPTY_FRAGMENT: Fragment = { text: "", entities: [] };
const STYLE_TYPES = new Set<TelegramMessageEntity["type"]>(["bold", "italic", "strikethrough"]);
const CODE_TYPES = new Set<TelegramMessageEntity["type"]>(["code", "pre"]);
const ENTITY_TYPE_ORDER: Record<TelegramMessageEntity["type"], number> = {
	blockquote: 0,
	text_link: 1,
	bold: 2,
	italic: 3,
	strikethrough: 4,
	code: 5,
	pre: 6,
};

function shiftEntity(entity: TelegramMessageEntity, delta: number): TelegramMessageEntity {
	return { ...entity, offset: entity.offset + delta };
}

function concatFragments(parts: readonly Fragment[], separator = ""): Fragment {
	let text = "";
	const entities: TelegramMessageEntity[] = [];
	for (const [index, part] of parts.entries()) {
		if (index > 0) text += separator;
		const offset = text.length;
		text += part.text;
		entities.push(...part.entities.map((entity) => shiftEntity(entity, offset)));
	}
	return { text, entities };
}

function textFragment(text: string): Fragment {
	return { text, entities: [] };
}

function splitAroundIntervals(length: number, intervals: readonly [number, number][]): Array<[number, number]> {
	if (length <= 0) return [];
	const merged: Array<[number, number]> = [];
	for (const [rawStart, rawEnd] of [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
		const start = Math.max(0, Math.min(length, rawStart));
		const end = Math.max(start, Math.min(length, rawEnd));
		if (end <= start) continue;
		const previous = merged.at(-1);
		if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
		else merged.push([start, end]);
	}
	const allowed: Array<[number, number]> = [];
	let cursor = 0;
	for (const [start, end] of merged) {
		if (cursor < start) allowed.push([cursor, start]);
		cursor = Math.max(cursor, end);
	}
	if (cursor < length) allowed.push([cursor, length]);
	return allowed;
}

function withStyle(fragment: Fragment, type: "bold" | "italic" | "strikethrough"): Fragment {
	const blocked = fragment.entities
		.filter((entity) => CODE_TYPES.has(entity.type))
		.map((entity): [number, number] => [entity.offset, entity.offset + entity.length]);
	const additions = splitAroundIntervals(fragment.text.length, blocked)
		.filter(([start, end]) => end > start)
		.map(([start, end]) => ({ type, offset: start, length: end - start }) satisfies TelegramMessageEntity);
	return { text: fragment.text, entities: [...fragment.entities, ...additions] };
}

function withNonStyle(
	fragment: Fragment,
	entity: TelegramNonStyleEntity,
): Fragment {
	if (!fragment.text || fragment.entities.some((existing) => !STYLE_TYPES.has(existing.type))) return fragment;
	return {
		text: fragment.text,
		entities: [...fragment.entities, { ...entity, offset: 0, length: fragment.text.length } as TelegramMessageEntity],
	};
}

function prefixLines(fragment: Fragment, firstPrefix: string, continuationPrefix: string): Fragment {
	const lines = fragment.text.split("\n");
	const parts: Fragment[] = [];
	let sourceOffset = 0;
	for (const [index, line] of lines.entries()) {
		const prefix = index === 0 ? firstPrefix : continuationPrefix;
		const lineEnd = sourceOffset + line.length;
		const lineEntities = fragment.entities
			.map((entity): TelegramMessageEntity | null => {
				const start = Math.max(sourceOffset, entity.offset);
				const end = Math.min(lineEnd, entity.offset + entity.length);
				if (end <= start) return null;
				return {
					...entity,
					offset: prefix.length + start - sourceOffset,
					length: end - start,
				};
			})
			.filter((entity): entity is TelegramMessageEntity => entity != null);
		parts.push({ text: `${prefix}${line}`, entities: lineEntities });
		sourceOffset = lineEnd + 1;
	}
	return concatFragments(parts, "\n");
}

function sanitizeLanguage(language: string | undefined): string | undefined {
	const candidate = language?.trim().split(/\s+/, 1)[0];
	return candidate && /^[A-Za-z0-9_+-]{1,64}$/.test(candidate) ? candidate : undefined;
}

class TelegramMarkdownRenderer {
	private nodeCount = 0;

	private countNode(): void {
		this.nodeCount++;
		if (this.nodeCount > MAX_TOKEN_NODES) throw new TelegramMarkdownError("too_complex");
	}

	render(tokens: readonly Token[]): Fragment {
		return this.renderBlocks(tokens, "\n\n");
	}

	private renderBlocks(tokens: readonly Token[], separator: string): Fragment {
		const blocks: Fragment[] = [];
		for (const token of tokens) {
			this.countNode();
			const rendered = this.renderBlock(token);
			if (rendered.text) blocks.push(rendered);
		}
		return concatFragments(blocks, separator);
	}

	private renderBlock(token: Token): Fragment {
		switch (token.type) {
			case "space":
			case "def":
				return EMPTY_FRAGMENT;
			case "paragraph":
				return this.renderInline((token as Tokens.Paragraph).tokens);
			case "heading":
				return withStyle(this.renderInline((token as Tokens.Heading).tokens), "bold");
			case "code": {
				const code = token as Tokens.Code;
				if (!code.text) return EMPTY_FRAGMENT;
				const language = sanitizeLanguage(code.lang);
				return {
					text: code.text,
					entities: [{ type: "pre", offset: 0, length: code.text.length, ...(language ? { language } : {}) }],
				};
			}
			case "blockquote": {
				const quote = this.render((token as Tokens.Blockquote).tokens);
				return withNonStyle(quote, { type: "blockquote" });
			}
			case "list":
				return this.renderList(token as Tokens.List);
			case "table":
				return this.renderTable(token as Tokens.Table);
			case "hr":
				return textFragment("———");
			case "html":
				return textFragment((token as Tokens.HTML).text);
			default:
				return this.renderInline([token]);
		}
	}

	private renderList(list: Tokens.List): Fragment {
		const items: Fragment[] = [];
		const start = typeof list.start === "number" ? list.start : 1;
		for (const [index, item] of list.items.entries()) {
			this.countNode();
			const rendered = this.renderBlocks(item.tokens, "\n");
			const marker = list.ordered ? `${start + index}. ` : "• ";
			items.push(prefixLines(rendered, marker, "  "));
		}
		return concatFragments(items, "\n");
	}

	private renderTable(table: Tokens.Table): Fragment {
		const rows: Fragment[] = [];
		const renderRow = (cells: Tokens.TableCell[], header: boolean): Fragment => {
			const fragments = cells.map((cell) => {
				this.countNode();
				const rendered = this.renderInline(cell.tokens);
				return header ? withStyle(rendered, "bold") : rendered;
			});
			return concatFragments(fragments, " | ");
		};
		rows.push(renderRow(table.header, true));
		for (const row of table.rows) rows.push(renderRow(row, false));
		return concatFragments(rows, "\n");
	}

	private renderInline(tokens: readonly Token[]): Fragment {
		const fragments: Fragment[] = [];
		for (const token of tokens) {
			this.countNode();
			switch (token.type) {
				case "text": {
					const text = token as Tokens.Text;
					fragments.push(text.tokens?.length ? this.renderInline(text.tokens) : textFragment(text.text));
					break;
				}
				case "escape":
					fragments.push(textFragment((token as Tokens.Escape).text));
					break;
				case "strong":
					fragments.push(withStyle(this.renderInline((token as Tokens.Strong).tokens), "bold"));
					break;
				case "em":
					fragments.push(withStyle(this.renderInline((token as Tokens.Em).tokens), "italic"));
					break;
				case "del":
					fragments.push(withStyle(this.renderInline((token as Tokens.Del).tokens), "strikethrough"));
					break;
				case "codespan": {
					const text = (token as Tokens.Codespan).text;
					fragments.push({ text, entities: text ? [{ type: "code", offset: 0, length: text.length }] : [] });
					break;
				}
				case "link": {
					const link = token as Tokens.Link;
					const label = this.renderInline(link.tokens);
					const publicUrl = parsePublicHttpUrl(link.href);
					fragments.push(publicUrl ? withNonStyle(label, { type: "text_link", url: publicUrl.url }) : label);
					break;
				}
				case "image": {
					const image = token as Tokens.Image;
					fragments.push(image.tokens?.length ? this.renderInline(image.tokens) : textFragment(image.text));
					break;
				}
				case "br":
					fragments.push(textFragment("\n"));
					break;
				case "checkbox":
					fragments.push(textFragment((token as Tokens.Checkbox).checked ? "[x] " : "[ ] "));
					break;
				case "html":
					fragments.push(textFragment((token as Tokens.HTML).text));
					break;
				default: {
					const generic = token as Tokens.Generic;
					if (generic.tokens?.length) fragments.push(this.renderInline(generic.tokens));
					else fragments.push(textFragment(typeof generic.text === "string" ? generic.text : generic.raw));
				}
			}
		}
		return concatFragments(fragments);
	}
}

function isSurrogateBoundary(text: string, offset: number): boolean {
	if (offset <= 0 || offset >= text.length) return true;
	const previous = text.charCodeAt(offset - 1);
	const next = text.charCodeAt(offset);
	return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

function normalizedEntities(text: string, entities: readonly TelegramMessageEntity[]): TelegramMessageEntity[] {
	const unique = new Map<string, TelegramMessageEntity>();
	for (const entity of entities) {
		const end = entity.offset + entity.length;
		if (
			!Number.isSafeInteger(entity.offset)
			|| !Number.isSafeInteger(entity.length)
			|| entity.offset < 0
			|| entity.length <= 0
			|| end > text.length
			|| !isSurrogateBoundary(text, entity.offset)
			|| !isSurrogateBoundary(text, end)
		) {
			throw new TelegramMarkdownError("invalid");
		}
		const extra = entity.type === "text_link" ? entity.url : entity.type === "pre" ? entity.language ?? "" : "";
		unique.set(`${entity.type}:${entity.offset}:${entity.length}:${extra}`, entity);
	}
	const sorted = [...unique.values()].sort(
		(a, b) => a.offset - b.offset || b.length - a.length || ENTITY_TYPE_ORDER[a.type] - ENTITY_TYPE_ORDER[b.type],
	);
	if (sorted.length > MAX_ENTITIES) throw new TelegramMarkdownError("too_complex");
	for (let leftIndex = 0; leftIndex < sorted.length; leftIndex++) {
		const left = sorted[leftIndex]!;
		const leftEnd = left.offset + left.length;
		for (let rightIndex = leftIndex + 1; rightIndex < sorted.length; rightIndex++) {
			const right = sorted[rightIndex]!;
			if (right.offset >= leftEnd) break;
			const rightEnd = right.offset + right.length;
			if (rightEnd > leftEnd) throw new TelegramMarkdownError("invalid");
			if ((CODE_TYPES.has(left.type) || CODE_TYPES.has(right.type)) && left.offset < rightEnd && right.offset < leftEnd) {
				throw new TelegramMarkdownError("invalid");
			}
		}
	}
	return sorted;
}

/** Convert the agent's bounded Markdown to classic Telegram text/entities without parse_mode. */
export function formatTelegramMarkdown(markdown: string): TelegramFormattedMessage {
	if (typeof markdown !== "string" || markdown.trim().length === 0) throw new TelegramMarkdownError("empty");
	if ([...markdown].length > MAX_CODE_POINTS) throw new TelegramMarkdownError("too_long");
	try {
		const tokens = MARKED.Lexer.lex(markdown, { gfm: true, breaks: false });
		const rendered = new TelegramMarkdownRenderer().render(tokens);
		if (!rendered.text.trim()) throw new TelegramMarkdownError("empty");
		if ([...rendered.text].length > MAX_CODE_POINTS) throw new TelegramMarkdownError("too_long");
		return { text: rendered.text, entities: normalizedEntities(rendered.text, rendered.entities) };
	} catch (error) {
		if (error instanceof TelegramMarkdownError) throw error;
		throw new TelegramMarkdownError("invalid");
	}
}
