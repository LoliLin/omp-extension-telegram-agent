import { describe, expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyPiProviderFailure,
	configureBotModelRuntime,
	createSharedModelRuntime,
	piAuthSource,
	PiModelConfigurationError,
	type ConfigurableModelRuntime,
} from "../src/agent/model-runtime.ts";

class FakeRuntime implements ConfigurableModelRuntime {
	readonly modelLookups: string[] = [];

	constructor(
		private readonly models: ReadonlySet<string>,
		private readonly authenticatedProviders: ReadonlySet<string>,
		private readonly authSource: string = "stored",
	) {}

	getModel(providerId: string, modelId: string): object | undefined {
		this.modelLookups.push(`${providerId}/${modelId}`);
		return this.models.has(`${providerId}/${modelId}`) ? { provider: providerId, id: modelId } : undefined;
	}

	hasConfiguredAuth(providerId: string): boolean {
		return this.authenticatedProviders.has(providerId);
	}

	getProviderAuthStatus(providerId: string): { configured: boolean; source?: string } {
		return this.authenticatedProviders.has(providerId)
			? { configured: true, source: this.authSource }
			: { configured: false };
	}
}

describe("Pi-owned model authentication (REQ-PLAT-0002)", () => {
	test("AC5: the pinned Pi catalog resolves DeepSeek and Anthropic by provider/model", async () => {
		const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
		expect(runtime.getModel("deepseek", "deepseek-v4-flash")?.provider).toBe("deepseek");
		expect(runtime.getModel("anthropic", "claude-sonnet-4-6")?.provider).toBe("anthropic");
	});

	test("R1: provider selection never receives or injects credential material", async () => {
		const deepseek = new FakeRuntime(
			new Set(["deepseek/deepseek-v4-flash"]),
			new Set(["deepseek"]),
		);
		const anthropic = new FakeRuntime(
			new Set(["anthropic/claude-sonnet-4-6"]),
			new Set(["anthropic"]),
		);

		await configureBotModelRuntime(
			{ provider: "deepseek", model: "deepseek-v4-flash" },
			deepseek,
		);
		await configureBotModelRuntime(
			{ provider: "anthropic", model: "claude-sonnet-4-6" },
			anthropic,
		);

		expect("setRuntimeApiKey" in deepseek).toBeFalse();
		expect("setRuntimeApiKey" in anthropic).toBeFalse();
		expect(deepseek.getModel("anthropic", "claude-sonnet-4-6")).toBeUndefined();
	});

	test("AC1: N same/cross-provider bots create one shared runtime and retain their own selection", async () => {
		const runtime = new FakeRuntime(
			new Set([
				"deepseek/deepseek-v4-flash",
				"deepseek/deepseek-reasoner",
				"anthropic/claude-sonnet-4-6",
			]),
			new Set(["deepseek", "anthropic"]),
		);
		let creates = 0;
		const bots = [
			{ provider: "deepseek", model: "deepseek-v4-flash" },
			{ provider: "deepseek", model: "deepseek-reasoner" },
			{ provider: "anthropic", model: "claude-sonnet-4-6" },
		];
		const shared = await createSharedModelRuntime(bots, async () => {
			creates++;
			return runtime as unknown as ModelRuntime;
		});

		expect(creates).toBe(1);
		expect(shared).toBe(runtime as unknown as ModelRuntime);
		expect(runtime.modelLookups).toEqual(bots.map((bot) => `${bot.provider}/${bot.model}`));
		expect(new Set(bots.map((bot) => `${bot.provider}/${bot.model}`)).size).toBe(3);
		expect("setRuntimeApiKey" in runtime).toBeFalse();
	});

	test("AC2: isolated auth.json recognizes API-key and OAuth providers without exposing values", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-auth-fixture-"));
		const privateFixtureValue = "PRIVATE_FIXTURE_VALUE";
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
			deepseek: { type: "api_key", key: privateFixtureValue },
			"openai-codex": {
				type: "oauth",
				access: privateFixtureValue,
				refresh: privateFixtureValue,
				expires: Date.now() + 60 * 60 * 1000,
			},
		}));
		try {
			const runtime = await createSharedModelRuntime(
				[
					{ provider: "deepseek", model: "deepseek-v4-flash" },
					{ provider: "openai-codex", model: "gpt-5.6-luna" },
				],
				() => ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null }),
			);
			expect(piAuthSource(runtime, "deepseek")).toBe("stored");
			expect(piAuthSource(runtime, "openai-codex")).toBe("stored");
			expect(JSON.stringify([
				piAuthSource(runtime, "deepseek"),
				piAuthSource(runtime, "openai-codex"),
			])).not.toContain(privateFixtureValue);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("AC2: preflight failures expose bounded categories without credential values", async () => {
		const unknown = new FakeRuntime(new Set(), new Set(["custom"]));
		const unauthenticated = new FakeRuntime(new Set(["custom/known"]), new Set());

		for (const [runtime, expectedCategory, model] of [
			[unknown, "unknown_model", "missing"],
			[unauthenticated, "unauthenticated_provider", "known"],
		] as const) {
			try {
				await configureBotModelRuntime({ provider: "custom", model }, runtime);
				throw new Error("expected preflight to reject");
			} catch (error) {
				expect(error).toBeInstanceOf(PiModelConfigurationError);
				expect((error as PiModelConfigurationError).category).toBe(expectedCategory);
				expect(String(error)).not.toContain("secret");
			}
		}
	});

	test("R7: runtime/OAuth/provider failures collapse to fixed non-secret categories", async () => {
		const privateFixtureValue = "PRIVATE_UPSTREAM_BODY";
		try {
			await createSharedModelRuntime([], async () => {
				throw new Error(`OAuth refresh failed: ${privateFixtureValue}`);
			});
			throw new Error("expected runtime creation to reject");
		} catch (error) {
			expect(error).toBeInstanceOf(PiModelConfigurationError);
			expect((error as PiModelConfigurationError).category).toBe("runtime_unavailable");
			expect(String(error)).not.toContain(privateFixtureValue);
		}
		expect(classifyPiProviderFailure(new Error(`OAuth refresh ${privateFixtureValue}`))).toBe("oauth_refresh_failed");
		expect(classifyPiProviderFailure(new Error(`401 authorization ${privateFixtureValue}`))).toBe("provider_auth_failed");
		expect(classifyPiProviderFailure(new Error(`upstream ${privateFixtureValue}`))).toBe("provider_request_failed");
	});
});
