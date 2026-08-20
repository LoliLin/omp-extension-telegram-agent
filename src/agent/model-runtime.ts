import { discoverAuthStorage, getAgentDir, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { clampThinkingLevelForModel, getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { getEnvApiKey, type Api, type Effort, type Model } from "@oh-my-pi/pi-ai";
import type { TelegramThinkingLevel } from "./model-settings.ts";

/** Narrow model/auth facade shared by config validation and runtime wiring. */
export interface ConfigurableModelRuntime {
	find(providerId: string, modelId: string): Model<Api> | undefined;
	hasConfiguredAuth(model: Model<Api>): boolean;
	getAvailable(): readonly Model<Api>[];
}

export type PiModelConfigurationCategory =
	| "runtime_unavailable"
	| "unknown_model"
	| "unauthenticated_provider"
	| "unsupported_reasoning_effort"
	| "image_input_unsupported";

export interface PiModelSelection {
	provider: string;
	model: string;
	thinkingLevel?: TelegramThinkingLevel;
	purpose?: string;
}

export interface ModelReasoningCapabilities {
	provider: string;
	model: string;
	requested: TelegramThinkingLevel;
	effective: TelegramThinkingLevel;
	supported: TelegramThinkingLevel[];
	valid: boolean;
}

export class PiModelConfigurationError extends Error {
	constructor(
		readonly category: PiModelConfigurationCategory,
		readonly provider: string,
		readonly model: string,
		readonly reasoning?: ModelReasoningCapabilities,
		readonly purpose?: string,
		detail?: string,
	) {
		const target = `${provider}/${model}${purpose ? ` (${purpose})` : ""}`;
		const base = reasoning
			? `OMP model configuration invalid (${category}): ${target} requested ${reasoning.requested}; supported: ${reasoning.supported.join(", ") || "off"}. Use OMP /model, then restart.`
			: `OMP model unavailable (${category}): ${target}. Use OMP /login and /model, then restart.`;
		super(detail ? `${base} Cause: ${detail}` : base);
		this.name = "PiModelConfigurationError";
	}
}

/** Read omp's model-specific reasoning contract without sending a provider request. */
export function inspectModelReasoning(model: Model<Api>, requested: TelegramThinkingLevel): ModelReasoningCapabilities {
	// omp's Effort is a const enum over exactly the config's string levels; only the
	// nominal type differs, so the boundary cast is value-identical.
	const supported = ["off", ...getSupportedEfforts(model)] as unknown as TelegramThinkingLevel[];
	const effective =
		requested === "off" ? ("off" as const) : (clampThinkingLevelForModel(model, requested as Effort) ?? "off");
	return {
		provider: model.provider,
		model: model.id,
		requested,
		effective,
		supported,
		valid: supported.includes(requested),
	};
}

/** Select an omp-owned model/auth pair without reading or injecting credential material. */
export async function configureBotModelRuntime<T extends ConfigurableModelRuntime>(
	bot: PiModelSelection,
	runtime: T,
): Promise<T> {
	const model = runtime.find(bot.provider, bot.model);
	if (!model) {
		throw new PiModelConfigurationError("unknown_model", bot.provider, bot.model, undefined, bot.purpose);
	}
	if (bot.thinkingLevel != null) {
		const reasoning = inspectModelReasoning(model, bot.thinkingLevel);
		if (!reasoning.valid) {
			throw new PiModelConfigurationError(
				"unsupported_reasoning_effort",
				bot.provider,
				bot.model,
				reasoning,
				bot.purpose,
			);
		}
	}
	if (!runtime.hasConfiguredAuth(model)) {
		throw new PiModelConfigurationError("unauthenticated_provider", bot.provider, bot.model, undefined, bot.purpose);
	}
	return runtime;
}

/**
 * Build the daemon's shared model registry through omp's native auth storage so
 * user-installed provider plugins participate in the same catalog/auth/cost contract
 * as interactive omp. Project extensions stay excluded: bot sessions own a fixed
 * cache-visible extension set.
 */
export async function createInstalledPiModelRuntime(
	options: { agentDir?: string; refreshStrategy?: "online" | "offline" | "online-if-uncached" } = {},
): Promise<ModelRegistry> {
	const agentDir = options.agentDir ?? getAgentDir();
	const authStorage = await discoverAuthStorage(agentDir);
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh(options.refreshStrategy ?? "online-if-uncached");
	return modelRegistry;
}

/** Create exactly one omp-owned registry and preflight every configured bot before Telegram starts. */
export async function createSharedModelRuntime(
	bots: readonly PiModelSelection[],
	create: () => Promise<ModelRegistry> = () => createInstalledPiModelRuntime(),
): Promise<ModelRegistry> {
	let runtime: ModelRegistry;
	try {
		runtime = await create();
		const registered = new Set(runtime.getAvailable().map((model) => model.provider));
		const selectedExtensionProviders = [...new Set(bots.map((bot) => bot.provider))].filter((provider) =>
			registered.has(provider),
		);
		if (selectedExtensionProviders.length > 0) {
			await Promise.all(
				selectedExtensionProviders.map((provider) => runtime.refreshProvider(provider, "online-if-uncached")),
			);
		}
	} catch (error) {
		// Untrusted provider/extension failure text: attach only a bounded single-line message, never a stack.
		const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 200);
		throw new PiModelConfigurationError(
			"runtime_unavailable",
			"<startup>",
			"<startup>",
			undefined,
			undefined,
			detail || undefined,
		);
	}
	for (const bot of bots) await configureBotModelRuntime(bot, runtime);
	return runtime;
}

export type PiAuthSource = "stored" | "environment" | "configured";

/** Return only omp's fixed non-sensitive auth source category. */
export function piAuthSource(runtime: ConfigurableModelRuntime, provider: string): PiAuthSource {
	if (getEnvApiKey(provider)) return "environment";
	const model = runtime.getAvailable().find((candidate) => candidate.provider === provider);
	if (model && runtime.hasConfiguredAuth(model)) return "stored";
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
