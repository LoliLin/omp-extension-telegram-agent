// Deterministic, bounded RichMessage source storage and plain-text projection.
// Telegram owns rich presentation; Pi/provider only consume the projection.

export const RICH_MESSAGE_MAX_CHARS = 32_768;
export const RICH_MESSAGE_MAX_BLOCKS = 500;
export const RICH_MESSAGE_MAX_NODES = 4096;
export const RICH_MESSAGE_MAX_DEPTH = 16;
export const RICH_MESSAGE_RAW_MAX_BYTES = 256 * 1024;
export const RICH_MESSAGE_TRUNCATED = "[rich message truncated]";
export const RICH_MESSAGE_UNAVAILABLE = "[rich message unavailable]";

export interface RichProjection {
	text: string;
	truncated: boolean;
	nodes: number;
	blocks: number;
}

export interface NormalizedRichMessage extends RichProjection {
	source: string;
	rawBytes: number | null;
	rawTruncated: boolean;
}

interface ProjectionState {
	nodes: number;
	blocks: number;
	truncated: boolean;
}

function objectValue(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function takeCodePoints(value: string, limit: number): { text: string; length: number; complete: boolean } {
	if (limit <= 0) return { text: "", length: 0, complete: value.length === 0 };
	let count = 0;
	let end = 0;
	for (const character of value) {
		if (count >= limit) return { text: value.slice(0, end), length: count, complete: false };
		end += character.length;
		count++;
	}
	return { text: value, length: count, complete: true };
}

function boundedString(value: string, state: ProjectionState): string {
	const normalized = value.replace(/\r\n?/g, "\n");
	const result = takeCodePoints(normalized, RICH_MESSAGE_MAX_CHARS);
	if (!result.complete) state.truncated = true;
	return result.text;
}

function joinLimited(values: Iterable<string>, separator: string, state: ProjectionState): string {
	let output = "";
	let length = 0;
	for (const value of values) {
		if (!value) continue;
		const prefix = output ? separator : "";
		for (const part of [prefix, value]) {
			const remaining = RICH_MESSAGE_MAX_CHARS - length;
			const taken = takeCodePoints(part, remaining);
			output += taken.text;
			length += taken.length;
			if (!taken.complete) {
				state.truncated = true;
				return output;
			}
		}
	}
	return output;
}

function enter(depth: number, state: ProjectionState, block = false): boolean {
	if (depth > RICH_MESSAGE_MAX_DEPTH) {
		state.truncated = true;
		return false;
	}
	state.nodes++;
	if (state.nodes > RICH_MESSAGE_MAX_NODES) {
		state.truncated = true;
		return false;
	}
	if (block) {
		state.blocks++;
		if (state.blocks > RICH_MESSAGE_MAX_BLOCKS) {
			state.truncated = true;
			return false;
		}
	}
	return true;
}

function renderInline(value: unknown, depth: number, state: ProjectionState): string {
	if (typeof value === "string") return boundedString(value, state);
	if (value == null || typeof value === "boolean" || typeof value === "number") return "";
	if (Array.isArray(value)) {
		if (!enter(depth, state)) return "";
		return joinLimited(renderInlineItems(value, depth + 1, state), "", state);
	}
	if (!objectValue(value) || !enter(depth, state)) return "";
	if ("text" in value) return renderInline(value.text, depth + 1, state);
	if (typeof value.expression === "string") return boundedString(value.expression, state);
	if (typeof value.alternative_text === "string") return boundedString(value.alternative_text, state);
	return renderUnknown(value, depth + 1, state, "");
}

function* renderInlineItems(values: readonly unknown[], depth: number, state: ProjectionState): Generator<string> {
	for (const value of values) {
		if (state.truncated) return;
		yield renderInline(value, depth, state);
	}
}

function renderCaption(value: unknown, depth: number, state: ProjectionState): string {
	if (!objectValue(value)) return renderInline(value, depth, state);
	if (!enter(depth, state)) return "";
	return joinLimited(
		[renderInline(value.text, depth + 1, state), renderInline(value.credit, depth + 1, state)],
		" — ",
		state,
	);
}

function prefixLines(value: string, prefix: string): string {
	return value
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");
}

function renderBlocks(value: unknown, depth: number, state: ProjectionState): string {
	if (!Array.isArray(value)) return renderBlock(value, depth, state);
	if (!enter(depth, state)) return "";
	return joinLimited(renderBlockItems(value, depth + 1, state), "\n", state);
}

function* renderBlockItems(values: readonly unknown[], depth: number, state: ProjectionState): Generator<string> {
	for (const value of values) {
		if (state.truncated) return;
		yield renderBlock(value, depth, state);
	}
}

function* renderListItems(values: readonly unknown[], depth: number, state: ProjectionState): Generator<string> {
	for (const value of values) {
		if (state.truncated) return;
		yield renderListItem(value, depth, state);
	}
}

function* renderTableCells(values: readonly unknown[], depth: number, state: ProjectionState): Generator<string> {
	for (const value of values) {
		if (state.truncated) return;
		if (!objectValue(value) || !enter(depth, state)) continue;
		yield renderInline(value.text, depth + 1, state)
			.replace(/\n+/g, " ")
			.trim();
	}
}

function renderListItem(value: unknown, depth: number, state: ProjectionState): string {
	if (!objectValue(value) || !enter(depth, state)) return "";
	const body = renderBlocks(value.blocks, depth + 1, state);
	const rawLabel = typeof value.label === "string" && value.label.trim() ? value.label.trim() : "-";
	const labelResult = takeCodePoints(rawLabel, 64);
	if (!labelResult.complete) state.truncated = true;
	const label = labelResult.text;
	const checkbox = value.has_checkbox === true ? (value.is_checked === true ? "[x] " : "[ ] ") : "";
	const prefix = `${label} ${checkbox}`;
	if (!body) return prefix.trimEnd();
	return joinLimited(renderListLines(body, prefix), "\n", state);
}

function* renderListLines(body: string, prefix: string): Generator<string> {
	let first = true;
	for (const line of body.split("\n")) {
		yield first ? `${prefix}${line}` : `  ${line}`;
		first = false;
	}
}

function* renderTableRows(value: Record<string, unknown>, depth: number, state: ProjectionState): Generator<string> {
	if (Array.isArray(value.cells) && enter(depth, state)) {
		for (const row of value.cells) {
			if (state.truncated) return;
			if (!Array.isArray(row) || !enter(depth + 1, state)) continue;
			yield joinLimited(renderTableCells(row, depth + 2, state), " | ", state);
		}
	}
}

function* renderTableParts(value: Record<string, unknown>, depth: number, state: ProjectionState): Generator<string> {
	yield renderInline(value.caption, depth, state);
	yield* renderTableRows(value, depth, state);
}

function renderTable(value: Record<string, unknown>, depth: number, state: ProjectionState): string {
	return joinLimited(renderTableParts(value, depth, state), "\n", state);
}

const MEDIA_BLOCK_TYPES = new Set(["animation", "audio", "photo", "video", "voice_note", "map"]);

function renderBlock(value: unknown, depth: number, state: ProjectionState): string {
	if (typeof value === "string" || Array.isArray(value)) return renderInline(value, depth, state);
	if (!objectValue(value) || !enter(depth, state, true)) return "";
	const type = typeof value.type === "string" ? value.type : "";
	switch (type) {
		case "paragraph":
		case "heading":
		case "pre":
		case "footer":
		case "thinking":
			return renderInline(value.text, depth + 1, state);
		case "divider":
			return "---";
		case "mathematical_expression":
			return typeof value.expression === "string" ? boundedString(value.expression, state) : "";
		case "anchor":
			return "";
		case "list":
			return Array.isArray(value.items) ? joinLimited(renderListItems(value.items, depth + 1, state), "\n", state) : "";
		case "blockquote": {
			const quote = renderBlocks(value.blocks, depth + 1, state);
			const credit = renderInline(value.credit, depth + 1, state);
			return joinLimited([quote ? prefixLines(quote, "> ") : "", credit ? `— ${credit}` : ""], "\n", state);
		}
		case "pullquote": {
			const quote = renderInline(value.text, depth + 1, state);
			const credit = renderInline(value.credit, depth + 1, state);
			return joinLimited([quote ? prefixLines(quote, "> ") : "", credit ? `— ${credit}` : ""], "\n", state);
		}
		case "collage":
		case "slideshow":
			return joinLimited(
				[renderBlocks(value.blocks, depth + 1, state), renderCaption(value.caption, depth + 1, state)],
				"\n",
				state,
			);
		case "table":
			return renderTable(value, depth + 1, state);
		case "details":
			return joinLimited(
				[renderInline(value.summary, depth + 1, state), renderBlocks(value.blocks, depth + 1, state)],
				"\n",
				state,
			);
		default:
			if (MEDIA_BLOCK_TYPES.has(type)) {
				return renderCaption(value.caption, depth + 1, state) || `[${type}]`;
			}
			return renderUnknown(value, depth + 1, state, "\n");
	}
}

const UNKNOWN_TEXT_FIELDS = [
	"text",
	"expression",
	"summary",
	"title",
	"description",
	"alternative_text",
	"caption",
	"credit",
	"label",
	"content",
	"children",
	"blocks",
	"items",
	"cells",
] as const;

function renderUnknown(
	value: Record<string, unknown>,
	depth: number,
	state: ProjectionState,
	separator: string,
): string {
	const parts: string[] = [];
	for (const key of UNKNOWN_TEXT_FIELDS) {
		if (!(key in value)) continue;
		if (key === "caption") parts.push(renderCaption(value[key], depth + 1, state));
		else if (key === "blocks") parts.push(renderBlocks(value[key], depth + 1, state));
		else parts.push(renderInline(value[key], depth + 1, state));
	}
	return joinLimited(parts, separator, state);
}

/** Project a Telegram RichMessage into stable plain text without exposing metadata. */
export function projectRichMessage(value: unknown): RichProjection {
	const state: ProjectionState = { nodes: 0, blocks: 0, truncated: false };
	let text: string;
	if (objectValue(value) && Array.isArray(value.blocks)) {
		if (!enter(0, state)) text = "";
		else text = renderBlocks(value.blocks, 1, state);
	} else if (objectValue(value)) {
		if (!enter(0, state)) text = "";
		else text = renderUnknown(value, 1, state, "\n");
	} else {
		text = "";
	}
	text = text.replace(/^\n+|\n+$/g, "");
	if (!text && !state.truncated) text = RICH_MESSAGE_UNAVAILABLE;
	if (state.truncated) {
		const separator = text ? "\n" : "";
		// separator and RICH_MESSAGE_TRUNCATED are single-code-unit ASCII, so length == code points
		const contentLimit = RICH_MESSAGE_MAX_CHARS - separator.length - RICH_MESSAGE_TRUNCATED.length;
		text = `${takeCodePoints(text, contentLimit).text}${separator}${RICH_MESSAGE_TRUNCATED}`;
	}
	return { text, truncated: state.truncated, nodes: state.nodes, blocks: state.blocks };
}

function sourceDiagnostic(reason: "raw_bytes" | "unserializable", rawBytes: number | null): string {
	return JSON.stringify({ truncated: true, reason, ...(rawBytes == null ? {} : { raw_bytes: rawBytes }) });
}

/** Preserve the source when bounded; otherwise store a small valid-JSON diagnostic. */
export function normalizeRichMessage(value: unknown): NormalizedRichMessage {
	const projection = projectRichMessage(value);
	let source: string;
	let rawBytes: number | null = null;
	let rawTruncated = false;
	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) throw new TypeError("rich message is not serializable");
		rawBytes = new TextEncoder().encode(serialized).length;
		if (rawBytes > RICH_MESSAGE_RAW_MAX_BYTES) {
			rawTruncated = true;
			source = sourceDiagnostic("raw_bytes", rawBytes);
		} else {
			source = serialized;
		}
	} catch {
		rawTruncated = true;
		source = sourceDiagnostic("unserializable", null);
	}
	return { ...projection, source, rawBytes, rawTruncated };
}
