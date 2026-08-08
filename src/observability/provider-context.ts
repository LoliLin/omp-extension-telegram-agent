import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SessionManager, buildSessionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DebugDeploymentIdentity } from "../config.ts";
import { getSessionManifest } from "../db/message-events.ts";
import { projectTelegramContext } from "../agent/extensions/context.ts";
import { buildSystemPrompt } from "../agent/prompt.ts";
import { TOOL_DEFS } from "../agent/tools.ts";
import type { Database } from "bun:sqlite";

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return JSON.stringify(content ?? null);
	return content.map((part) => {
		if (!part || typeof part !== "object") return String(part);
		const item = part as Record<string, unknown>;
		if (item.type === "text") return String(item.text ?? "");
		if (item.type === "thinking") return String(item.thinking ?? "");
		if (item.type === "toolCall") return JSON.stringify({ name: item.name, arguments: item.arguments });
		return JSON.stringify(item);
	}).join("\n");
}

function messageMetadata(message: AgentMessage, index: number) {
	const record = message as AgentMessage & Record<string, unknown>;
	const text = contentText(record.content);
	const contentTypes = Array.isArray(record.content)
		? record.content.map((part) => part && typeof part === "object" ? String((part as { type?: unknown }).type ?? "object") : typeof part)
		: [typeof record.content];
	return {
		index,
		role: record.role,
		content_types: contentTypes,
		content_chars: text.length,
		content_hash: hash(text),
		...(typeof record.toolName === "string" ? { tool_name: record.toolName } : {}),
		...(typeof record.toolCallId === "string" ? { tool_call_id: record.toolCallId } : {}),
		...(typeof record.isError === "boolean" ? { is_error: record.isError } : {}),
		...(typeof record.customType === "string" ? { custom_type: record.customType } : {}),
	};
}

/**
 * Reconstruct the current pre-adapter provider context from the durable active Pi branch.
 * Default output contains every message/tool identity but no prompt or conversation content.
 * Explicit content output is stdout-only diagnostic material and must never enter daemon logs.
 */
export function inspectProviderContext(
	db: Database,
	deployment: DebugDeploymentIdentity,
	botId: string,
	includeContent = false,
) {
	const bot = deployment.bots.find((entry) => entry.id === botId);
	if (!bot) throw new Error(`unknown bot: ${botId}`);
	const manifest = getSessionManifest(db, botId);
	if (!manifest) throw new Error(`session manifest unavailable: ${botId}`);
	const manager = SessionManager.open(manifest.sessionFile, `${deployment.dataDir}/sessions/${botId}`, deployment.dataDir);
	const context = buildSessionContext(manager.getBranch(), manager.getLeafId());
	const messages = projectTelegramContext(context.messages);
	const lastRun = db.query(`
		SELECT provider, api, model, tools_hash AS toolsHash
		  FROM llm_runs WHERE bot_id = ? ORDER BY id DESC LIMIT 1
	`).get(botId) as { provider: string | null; api: string | null; model: string | null; toolsHash: string | null } | null;
	const system = buildSystemPrompt(readFileSync(bot.personaPath, "utf8"));
	const tools = TOOL_DEFS.filter((tool) =>
		tool.name === "send" ? bot.tools.send : tool.name === "search" ? bot.tools.search : bot.tools.runJs,
	).map(({ name, description, parameters }) => ({ name, description, parameters }));
	return {
		source: "current_session_pre_adapter_projection",
		exact_last_request: false,
		session: { id_hash: hash(manifest.sessionId), file_hash: hash(manifest.sessionFile), context_fingerprint: manifest.contextFingerprint },
		request_metadata: {
			provider: bot.provider ?? lastRun?.provider ?? context.model?.provider ?? null,
			api: lastRun?.api ?? null,
			model: bot.model ?? lastRun?.model ?? context.model?.modelId ?? null,
			reasoning_effort: bot.reasoningEffort ?? context.thinkingLevel ?? null,
			cache_retention: bot.cacheRetention,
			last_observed_tools_hash: lastRun?.toolsHash ?? null,
		},
		system: {
			chars: system.length,
			hash: hash(system),
			...(includeContent ? { content: system } : { content: "<omitted; pass --show-provider-content --bot ID>" }),
		},
		tools,
		messages: messages.map((message, index) => ({
			...messageMetadata(message, index),
			...(includeContent ? { content: (message as AgentMessage & { content?: unknown }).content } : {}),
		})),
	};
}
