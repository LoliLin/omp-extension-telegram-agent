import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { BotConfig } from "../config.ts";

export interface ConfigurableModelRuntime {
	setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>;
	getModel(providerId: string, modelId: string): unknown | undefined;
}

/** Bind one bot's configured credential to its isolated Pi runtime and fail before session startup. */
export async function configureBotModelRuntime<T extends ConfigurableModelRuntime>(
	bot: Pick<BotConfig, "provider" | "model" | "providerApiKey">,
	runtime: T,
): Promise<T> {
	await runtime.setRuntimeApiKey(bot.provider, bot.providerApiKey);
	if (!runtime.getModel(bot.provider, bot.model)) {
		throw new Error(`model not found: ${bot.provider}/${bot.model}`);
	}
	return runtime;
}

/** A runtime is isolated per bot so two bots may use distinct keys for the same provider. */
export async function createBotModelRuntime(
	bot: Pick<BotConfig, "provider" | "model" | "providerApiKey">,
	create: () => Promise<ModelRuntime> = () => ModelRuntime.create(),
): Promise<ModelRuntime> {
	return configureBotModelRuntime(bot, await create());
}
