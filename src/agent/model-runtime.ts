import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { BotConfig } from "../config.ts";

export interface ConfigurableModelRuntime {
	getModel(providerId: string, modelId: string): unknown | undefined;
	hasConfiguredAuth(providerId: string): boolean;
}

export type PiModelConfigurationCategory = "unknown_model" | "unauthenticated_provider";

export class PiModelConfigurationError extends Error {
	constructor(
		readonly category: PiModelConfigurationCategory,
		readonly provider: string,
		readonly model: string,
	) {
		super(`Pi model unavailable (${category}): ${provider}/${model}. Configure it in Pi, then restart.`);
		this.name = "PiModelConfigurationError";
	}
}

/** Select a Pi-owned model/auth pair without reading or injecting credential material. */
export async function configureBotModelRuntime<T extends ConfigurableModelRuntime>(
	bot: Pick<BotConfig, "provider" | "model">,
	runtime: T,
): Promise<T> {
	if (!runtime.getModel(bot.provider, bot.model)) {
		throw new PiModelConfigurationError("unknown_model", bot.provider, bot.model);
	}
	if (!runtime.hasConfiguredAuth(bot.provider)) {
		throw new PiModelConfigurationError("unauthenticated_provider", bot.provider, bot.model);
	}
	return runtime;
}

/** Create a Pi-owned runtime. A later task shares one instance across every configured bot. */
export async function createBotModelRuntime(
	bot: Pick<BotConfig, "provider" | "model">,
	create: () => Promise<ModelRuntime> = () => ModelRuntime.create(),
): Promise<ModelRuntime> {
	return configureBotModelRuntime(bot, await create());
}
