import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { BotConfig } from "../config.ts";

export interface ConfigurableModelRuntime {
	getModel(providerId: string, modelId: string): unknown | undefined;
	hasConfiguredAuth(providerId: string): boolean;
	getProviderAuthStatus?(providerId: string): {
		configured: boolean;
		source?: string;
	};
}

export type PiModelConfigurationCategory =
	| "runtime_unavailable"
	| "unknown_model"
	| "unauthenticated_provider"
	| "image_input_unsupported";

export class PiModelConfigurationError extends Error {
	constructor(
		readonly category: PiModelConfigurationCategory,
		readonly provider: string,
		readonly model: string,
	) {
		super(`Pi model unavailable (${category}): ${provider}/${model}. Use Pi /login and /model, then restart.`);
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

/** Create exactly one Pi-owned runtime and preflight every configured bot before Telegram starts. */
export async function createSharedModelRuntime(
	bots: readonly Pick<BotConfig, "provider" | "model">[],
	create: () => Promise<ModelRuntime> = () => ModelRuntime.create(),
): Promise<ModelRuntime> {
	let runtime: ModelRuntime;
	try {
		runtime = await create();
	} catch {
		throw new PiModelConfigurationError("runtime_unavailable", "<startup>", "<startup>");
	}
	for (const bot of bots) await configureBotModelRuntime(bot, runtime);
	return runtime;
}

export type PiAuthSource = "stored" | "environment" | "configured";

/** Return only Pi's fixed non-sensitive auth source category. */
export function piAuthSource(runtime: ConfigurableModelRuntime, provider: string): PiAuthSource {
	const status = runtime.getProviderAuthStatus?.(provider);
	if (status?.configured && (status.source === "stored" || status.source === "environment")) return status.source;
	return "configured";
}

export type PiProviderFailureCategory =
	| PiModelConfigurationCategory
	| "oauth_refresh_failed"
	| "provider_auth_failed"
	| "provider_timeout"
	| "provider_aborted"
	| "provider_request_failed";

/** Collapse untrusted provider/OAuth error text into a bounded non-secret category. */
export function classifyPiProviderFailure(error: unknown): PiProviderFailureCategory {
	if (error instanceof PiModelConfigurationError) return error.category;
	if (typeof DOMException !== "undefined" && error instanceof DOMException) {
		if (error.name === "TimeoutError") return "provider_timeout";
		if (error.name === "AbortError") return "provider_aborted";
	}
	const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	if (/oauth|refresh/i.test(text)) return "oauth_refresh_failed";
	if (/\bauth\b|unauthori[sz]ed|forbidden|\b401\b|\b403\b/i.test(text)) return "provider_auth_failed";
	if (/timeout|timed out/i.test(text)) return "provider_timeout";
	if (/abort/i.test(text)) return "provider_aborted";
	return "provider_request_failed";
}
