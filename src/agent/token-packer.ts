import type { Database } from "bun:sqlite";
import type { MessageEvent, MediaUpdatePayload } from "../db/message-events.ts";
import type { MessageRow, SerializeOptions } from "./serialize.ts";
import { serializeMessageEvents } from "./serialize.ts";

export const DEFAULT_SUFFIX_TOKEN_BUDGET = 12_000;
export const DEFAULT_MESSAGE_TOKEN_CAP = 4_096;
export const DEFAULT_OUTPUT_RESERVE = 4_096;
export const DEFAULT_TOOL_FOLLOWUP_RESERVE = 6_144;
export const DEFAULT_REASONING_RESERVE = 4_096;
export const DEFAULT_SAFETY_MARGIN = 2_048;

/** UTF-8 bytes/2 is deliberately conservative for ASCII, code, CJK, URLs, and emoji. */
export function estimateProviderTokensUpperBound(text: string): number {
	return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 2));
}

export interface SuffixBudgetInput {
	contextWindow: number;
	currentContextTokens: number;
	staticPrefixTokens: number;
	maxSuffixTokens?: number;
	outputReserve?: number;
	reasoningReserve?: number;
	toolFollowupReserve?: number;
	safetyMargin?: number;
}

export function availableSuffixBudget(input: SuffixBudgetInput): number {
	const occupied = input.currentContextTokens > 0 ? input.currentContextTokens : input.staticPrefixTokens;
	const available = input.contextWindow
		- occupied
		- (input.outputReserve ?? DEFAULT_OUTPUT_RESERVE)
		- (input.reasoningReserve ?? 0)
		- (input.toolFollowupReserve ?? 0)
		- (input.safetyMargin ?? DEFAULT_SAFETY_MARGIN);
	return Math.max(512, Math.min(input.maxSuffixTokens ?? DEFAULT_SUFFIX_TOKEN_BUDGET, available));
}

function truncateBody(value: string, maxTokens: number): string {
	if (estimateProviderTokensUpperBound(value) <= maxTokens) return value;
	const points = [...value];
	const originalChars = points.length;
	const originalTokens = estimateProviderTokensUpperBound(value);
	const marker = `\n[truncated original_chars=${originalChars} estimated_tokens=${originalTokens}]\n`;
	let low = 0;
	let high = points.length;
	while (low < high) {
		const mid = Math.ceil((low + high) / 2);
		const head = Math.ceil(mid / 2);
		const tail = Math.floor(mid / 2);
		const candidate = `${points.slice(0, head).join("")}${marker}${tail > 0 ? points.slice(-tail).join("") : ""}`;
		if (estimateProviderTokensUpperBound(candidate) <= maxTokens) low = mid;
		else high = mid - 1;
	}
	const head = Math.ceil(low / 2);
	const tail = Math.floor(low / 2);
	return `${points.slice(0, head).join("")}${marker}${tail > 0 ? points.slice(-tail).join("") : ""}`;
}

export function capMessageEvent(event: MessageEvent, maxTokens = DEFAULT_MESSAGE_TOKEN_CAP): MessageEvent {
	if (event.kind === "media_update") {
		const payload = event.payload as MediaUpdatePayload;
		return { ...event, payload: { ...payload, text: truncateBody(payload.text, maxTokens) } };
	}
	const row = event.payload as MessageRow;
	if (row.text) return { ...event, payload: { ...row, text: truncateBody(row.text, maxTokens) } };
	if (row.caption) return { ...event, payload: { ...row, caption: truncateBody(row.caption, maxTokens) } };
	return event;
}

export interface PackedMessageEvents {
	events: MessageEvent[];
	text: string;
	estimatedTokens: number;
	visibleMessageIds: number[];
	deferredMandatory: number;
	droppedNormal: number;
}

function eventKey(event: MessageEvent): string {
	return `${event.kind}:${event.chatId}:${event.messageId}:${event.revision}:${event.ingestSeq}`;
}

/** Mandatory direct replies first, then newest ordinary events; output is chronological. */
export function packMessageEvents(
	db: Database,
	mandatory: readonly MessageEvent[],
	normal: readonly MessageEvent[],
	budgetTokens: number,
	serializeOptions: SerializeOptions,
	messageTokenCap = DEFAULT_MESSAGE_TOKEN_CAP,
): PackedMessageEvents {
	const selected: MessageEvent[] = [];
	const selectedKeys = new Set<string>();
	let remaining = Math.max(512, budgetTokens);
	let deferredMandatory = 0;
	const trySelect = (source: MessageEvent, required: boolean): boolean => {
		const key = eventKey(source);
		if (selectedKeys.has(key)) return true;
		let event = capMessageEvent(source, messageTokenCap);
		let rendered = serializeMessageEvents(db, [event], { visibleIds: new Set(serializeOptions.visibleIds) });
		let tokens = estimateProviderTokensUpperBound(rendered);
		if (required && selected.length === 0 && tokens > remaining) {
			event = capMessageEvent(source, Math.max(128, remaining - 64));
			rendered = serializeMessageEvents(db, [event], { visibleIds: new Set(serializeOptions.visibleIds) });
			tokens = estimateProviderTokensUpperBound(rendered);
		}
		if (tokens > remaining) return false;
		selected.push(event);
		selectedKeys.add(key);
		remaining -= tokens;
		return true;
	};

	for (const event of mandatory) {
		if (!trySelect(event, true)) deferredMandatory++;
	}
	let droppedNormal = 0;
	for (let index = normal.length - 1; index >= 0; index--) {
		if (!trySelect(normal[index]!, false)) droppedNormal++;
	}
	selected.sort((left, right) => left.ingestSeq - right.ingestSeq || left.eventDate - right.eventDate);
	const visibleBefore = new Set(serializeOptions.visibleIds);
	const text = serializeMessageEvents(db, selected, { visibleIds: visibleBefore });
	const visibleMessageIds = selected
		.filter((event) => event.kind === "message" || event.kind === "edit")
		.map((event) => event.messageId);
	return {
		events: selected,
		text,
		estimatedTokens: estimateProviderTokensUpperBound(text),
		visibleMessageIds: [...new Set(visibleMessageIds)],
		deferredMandatory,
		droppedNormal,
	};
}
