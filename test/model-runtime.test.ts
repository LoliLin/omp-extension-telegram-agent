import { describe, expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	configureBotModelRuntime,
	PiModelConfigurationError,
	type ConfigurableModelRuntime,
} from "../src/agent/model-runtime.ts";

class FakeRuntime implements ConfigurableModelRuntime {
	constructor(
		private readonly models: ReadonlySet<string>,
		private readonly authenticatedProviders: ReadonlySet<string>,
	) {}

	getModel(providerId: string, modelId: string): object | undefined {
		return this.models.has(`${providerId}/${modelId}`) ? { provider: providerId, id: modelId } : undefined;
	}

	hasConfiguredAuth(providerId: string): boolean {
		return this.authenticatedProviders.has(providerId);
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
});
