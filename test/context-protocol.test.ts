// Pure Pi extension and cache-identity contracts from review-260808.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	buildContextFingerprint,
	canResumeContextSession,
	type ContextFingerprintInput,
} from "../src/agent/context-fingerprint.ts";
import {
	configureBotModelRuntime,
	createInstalledPiModelRuntime,
	inspectModelReasoning,
} from "../src/agent/model-runtime.ts";
import {
	NO_SEND_MARKER,
	TELEGRAM_EXTENSION_ORDER,
	applyAssistantPersistencePolicy,
	observeProviderPayload,
	projectTelegramContext,
} from "../src/agent/extensions/index.ts";

function fingerprintInput(): ContextFingerprintInput {
	return {
		piVersion: "0.84.1",
		provider: "openai-codex",
		api: "responses",
		model: "gpt-5.6-luna",
		reasoningEffort: "off",
		cacheRetention: "short",
		cacheSchemaVersion: 8,
		commonPromptSha256: "common",
		personaSha256: "persona-a",
		serializerVersion: 2,
		compactionPromptSha256: "compact",
		compactionModel: "openai-codex/gpt-5.6-luna:low",
		stickerCatalogSnapshotSha256: "catalog",
		extensionOrder: TELEGRAM_EXTENSION_ORDER,
		tools: [
			{ name: "send", description: "send", parameters: { type: "object" } },
			{ name: "search", description: "search", parameters: { type: "object" } },
		],
	};
}

describe("Pi context protocol", () => {
	test("loads user-installed provider extensions into the daemon model runtime", async () => {
		const root = mkdtempSync(join(tmpdir(), "tg-provider-extension-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "workspace");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const extensionPath = join(root, "provider.ts");
		writeFileSync(
			extensionPath,
			`export default function (pi) {
	pi.registerProvider("fixture-provider", {
		name: "Fixture Provider",
		baseUrl: "http://127.0.0.1:1/v1",
		api: "openai-completions",
		apiKey: "fixture-key",
		models: [{
			id: "fixture-model",
			name: "Fixture Model",
			reasoning: false,
			input: ["text"],
			contextWindow: 4096,
			maxTokens: 1024,
			cost: { input: 1.25, output: 2.5, cacheRead: 0.25, cacheWrite: 0 }
		}]
	});
}\n`,
		);
		writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ extensions: [extensionPath] })}\n`);

		try {
			const runtime = await createInstalledPiModelRuntime({ cwd, agentDir });
			const model = runtime.getModel("fixture-provider", "fixture-model");
			expect(model?.cost).toEqual({ input: 1.25, output: 2.5, cacheRead: 0.25, cacheWrite: 0 });
			expect(runtime.hasConfiguredAuth("fixture-provider")).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects a model-specific reasoning level that Pi would silently clamp", async () => {
		const catalog = await ModelRuntime.create();
		const model = catalog.getModel("deepseek", "deepseek-v4-flash");
		expect(model).toBeDefined();
		const runtime = {
			getModel: (provider: string, modelId: string) =>
				provider === "deepseek" && modelId === "deepseek-v4-flash" ? model : undefined,
			hasConfiguredAuth: () => true,
		};

		expect(inspectModelReasoning(model!, "medium")).toEqual({
			provider: "deepseek",
			model: "deepseek-v4-flash",
			requested: "medium",
			effective: "high",
			supported: ["off", "high", "max"],
			valid: false,
		});
		await expect(
			configureBotModelRuntime(
				{
					provider: "deepseek",
					model: "deepseek-v4-flash",
					thinkingLevel: "medium",
					purpose: "bot:A",
				},
				runtime,
			),
		).rejects.toMatchObject({
			category: "unsupported_reasoning_effort",
			purpose: "bot:A",
			reasoning: { requested: "medium", effective: "high", supported: ["off", "high", "max"] },
		});
		expect(
			await configureBotModelRuntime(
				{ provider: "deepseek", model: "deepseek-v4-flash", thinkingLevel: "high" },
				runtime,
			),
		).toBe(runtime);
	});

	test("fingerprint changes and missing files prevent session resume", () => {
		const original = buildContextFingerprint(fingerprintInput());
		const changed = buildContextFingerprint({ ...fingerprintInput(), personaSha256: "persona-b" });
		const manifest = { contextFingerprint: original, sessionFile: "/retained/session.jsonl" };

		expect(canResumeContextSession(manifest, original, true)).toBe(true);
		expect(canResumeContextSession(manifest, changed, true)).toBe(false);
		expect(canResumeContextSession(manifest, original, false)).toBe(false);
	});

	test("tool and extension order participate in the context fingerprint", () => {
		const input = fingerprintInput();
		expect(buildContextFingerprint({ ...input, tools: [...input.tools].reverse() })).not.toBe(
			buildContextFingerprint(input),
		);
		expect(buildContextFingerprint({ ...input, extensionOrder: [...input.extensionOrder].reverse() })).not.toBe(
			buildContextFingerprint(input),
		);
	});

	test("provider payload observations are deterministic and redact content", () => {
		const first = observeProviderPayload(
			{
				model: "m",
				tools: [{ name: "send", parameters: { b: 2, a: 1 } }],
				messages: [
					{ role: "system", content: "protocol" },
					{ role: "user", content: "hello" },
				],
			},
			"local-hmac-key",
		);
		const reordered = observeProviderPayload(
			{
				messages: [
					{ content: "protocol", role: "system" },
					{ content: "hello", role: "user" },
				],
				tools: [{ parameters: { a: 1, b: 2 }, name: "send" }],
				model: "m",
			},
			"local-hmac-key",
			first,
		);
		const changed = observeProviderPayload(
			{
				model: "m",
				tools: [{ name: "send", parameters: { a: 1, b: 2 } }],
				messages: [
					{ role: "system", content: "protocol" },
					{ role: "user", content: "changed" },
				],
			},
			"local-hmac-key",
			reordered,
		);

		expect(reordered.fullPayloadHash).toBe(first.fullPayloadHash);
		expect(reordered.firstDivergentSegment).toBeNull();
		expect(changed.firstDivergentSegment).toBe("messages");
		expect(changed.firstDivergentMessageIndex).toBe(0);
		expect(changed.firstDivergentByteOffset).toBeGreaterThan(0);
		expect(JSON.stringify(changed)).not.toContain("changed");
	});

	test("structured Telegram entries project without parsing their display text", () => {
		const projected = projectTelegramContext([
			{
				role: "custom",
				customType: "telegram_context_v2",
				content: "stale-display",
				display: false,
				details: {
					version: 2,
					consumedSeq: 9,
					providerText: "canonical-provider-text",
					visibleMessageIds: [42],
					events: [{ ingestSeq: 9, kind: "message", chatId: -1001, messageId: 42, fullMessageVisible: true }],
				},
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "send",
				content: [{ type: "text", text: "ok" }],
				details: { sent: [100, 101] },
				isError: false,
				timestamp: 2,
			},
		] as never);

		expect((projected[0] as { content: string }).content).toBe("canonical-provider-text");
		expect(JSON.stringify(projected[1])).toContain("sent_message_ids=#100,#101");
	});

	test("unpublished assistant prose is absent from the next context", () => {
		let unpublished = "";
		let displayed: unknown = null;
		const result = applyAssistantPersistencePolicy(
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "real chain of thought" },
					{ type: "text", text: "private draft that was never sent" },
				],
			} as never,
			(text) => {
				unpublished = text;
			},
			(message) => {
				displayed = message.content;
			},
		);

		expect(unpublished).toBe("private draft that was never sent");
		expect(displayed).toEqual([
			{ type: "thinking", thinking: "real chain of thought" },
			{ type: "text", text: "private draft that was never sent" },
		]);
		expect((result as { content: unknown }).content).toEqual([{ type: "text", text: NO_SEND_MARKER }]);
		expect(JSON.stringify(result)).not.toContain("private draft");
	});
});
