import { describe, expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { configureBotModelRuntime, type ConfigurableModelRuntime } from "../src/agent/model-runtime.ts";

class FakeRuntime implements ConfigurableModelRuntime {
	readonly authCalls: Array<[string, string]> = [];

	constructor(private readonly models: ReadonlySet<string>) {}

	async setRuntimeApiKey(providerId: string, apiKey: string): Promise<void> {
		this.authCalls.push([providerId, apiKey]);
	}

	getModel(providerId: string, modelId: string): object | undefined {
		return this.models.has(`${providerId}/${modelId}`) ? { provider: providerId, id: modelId } : undefined;
	}
}

describe("per-bot Pi model runtime (REQ-PLAT-0001)", () => {
	test("AC5: the pinned Pi catalog resolves DeepSeek and Anthropic by provider/model", async () => {
		const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
		expect(runtime.getModel("deepseek", "deepseek-v4-flash")?.provider).toBe("deepseek");
		expect(runtime.getModel("anthropic", "claude-sonnet-4-6")?.provider).toBe("anthropic");
	});

	test("AC5: two provider fixtures route auth and lookup through their own runtime", async () => {
		const deepseek = new FakeRuntime(new Set(["deepseek/deepseek-v4-flash"]));
		const anthropic = new FakeRuntime(new Set(["anthropic/claude-sonnet-4-6"]));

		await configureBotModelRuntime(
			{ provider: "deepseek", model: "deepseek-v4-flash", providerApiKey: "ds-test-key" },
			deepseek,
		);
		await configureBotModelRuntime(
			{ provider: "anthropic", model: "claude-sonnet-4-6", providerApiKey: "ant-test-key" },
			anthropic,
		);

		expect(deepseek.authCalls).toEqual([["deepseek", "ds-test-key"]]);
		expect(anthropic.authCalls).toEqual([["anthropic", "ant-test-key"]]);
		expect(deepseek.getModel("anthropic", "claude-sonnet-4-6")).toBeUndefined();
	});

	test("unknown provider/model fails before AgentSession startup", async () => {
		const runtime = new FakeRuntime(new Set());
		await expect(configureBotModelRuntime(
			{ provider: "custom", model: "missing", providerApiKey: "test-key" },
			runtime,
		)).rejects.toThrow("model not found: custom/missing");
	});
});
