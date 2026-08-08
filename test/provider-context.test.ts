import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { DebugDeploymentIdentity } from "../src/config.ts";
import { setSessionManifest } from "../src/db/message-events.ts";
import { inspectProviderContext } from "../src/observability/provider-context.ts";

let cleanup: string | null = null;
afterEach(() => {
	if (cleanup) rmSync(cleanup, { recursive: true, force: true });
	cleanup = null;
});

describe("provider context inspection (REQ-SEARCH-0002)", () => {
	test("default exposes every provider-visible identity but content requires an explicit switch", () => {
		const root = mkdtempSync(join(tmpdir(), "provider-context-"));
		cleanup = root;
		const dataDir = join(root, "data");
		const sessionDir = join(dataDir, "sessions", "A");
		mkdirSync(sessionDir, { recursive: true });
		const personaPath = join(root, "persona.md");
		writeFileSync(personaPath, "CANARY_SYSTEM_PROMPT");
		const manager = SessionManager.create(dataDir, sessionDir);
		manager.appendCustomMessageEntry("telegram_context_v2", "stale", false, {
			version: 2,
			consumedSeq: 1,
			providerText: "CANARY_GROUP_CONTEXT",
			visibleMessageIds: [10],
			events: [{ ingestSeq: 1, kind: "message", chatId: -1001, messageId: 10, fullMessageVisible: true }],
		});
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-search", name: "search", arguments: { query: "CANARY_QUERY" } }],
			timestamp: 2,
		} as never);
		manager.appendMessage({
			role: "toolResult", toolCallId: "call-search", toolName: "search",
			content: [{ type: "text", text: "CANARY_TINYFISH_RESULT" }], details: { hits: 1 }, isError: false, timestamp: 3,
		} as never);

		const db = new Database(":memory:");
		db.exec(readFileSync(join(import.meta.dir, "../src/db/schema.sql"), "utf8"));
		setSessionManifest(db, {
			botId: "A", sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile()!,
			contextFingerprint: "fingerprint", createdAt: 1,
		});
		const deployment: DebugDeploymentIdentity = {
			dataDir, dbPath: ":memory:", groupPeerId: 1, botIds: ["A"],
			bots: [{
				id: "A", name: "A", personaPath, provider: "deepseek", model: "model",
				reasoningEffort: "medium", cacheRetention: "short",
				tools: { send: true, search: true, runJs: false },
			}],
		};

		const safe = inspectProviderContext(db, deployment, "A");
		const safeJson = JSON.stringify(safe);
		expect(safe.tools.map((tool) => tool.name)).toEqual(["send", "search"]);
		expect(safe.messages.map((message) => message.role)).toEqual(["custom", "assistant", "toolResult"]);
		expect(safe.messages.at(-1)).toMatchObject({ tool_name: "search", tool_call_id: "call-search", is_error: false });
		expect(safeJson).not.toContain("CANARY_SYSTEM_PROMPT");
		expect(safeJson).not.toContain("CANARY_GROUP_CONTEXT");
		expect(safeJson).not.toContain("CANARY_QUERY");
		expect(safeJson).not.toContain("CANARY_TINYFISH_RESULT");

		const fullJson = JSON.stringify(inspectProviderContext(db, deployment, "A", true));
		expect(fullJson).toContain("CANARY_SYSTEM_PROMPT");
		expect(fullJson).toContain("CANARY_GROUP_CONTEXT");
		expect(fullJson).toContain("CANARY_QUERY");
		expect(fullJson).toContain("CANARY_TINYFISH_RESULT");
		db.close();
	});
});
