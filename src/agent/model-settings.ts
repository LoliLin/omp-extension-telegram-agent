import {
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

const THINKING_LEVELS = new Set<ThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export interface PiModelDefaults {
	provider: string | undefined;
	model: string | undefined;
	thinkingLevel: ThinkingLevel;
}

export interface PiSettingsReader {
	getDefaultProvider(): string | undefined;
	getDefaultModel(): string | undefined;
	getDefaultThinkingLevel(): ThinkingLevel | undefined;
	drainErrors(): Array<{ scope: "global" | "project" }>;
}

export class PiSettingsConfigurationError extends Error {
	readonly category = "invalid_settings" as const;

	constructor(readonly scopes: readonly ("global" | "project")[]) {
		super(`Pi settings unavailable (invalid_settings: ${scopes.join(",") || "unknown"}). Fix Pi settings, then restart.`);
		this.name = "PiSettingsConfigurationError";
	}
}

/** Read Pi's merged global/project defaults without copying or exposing credential data. */
export function loadPiModelDefaults(
	projectRoot: string,
	agentDir = getAgentDir(),
	createSettings: (root: string, dir: string) => PiSettingsReader = (root, dir) => SettingsManager.create(root, dir),
): PiModelDefaults {
	const settings = createSettings(projectRoot, agentDir);
	const loadErrors = settings.drainErrors();
	if (loadErrors.length > 0) {
		throw new PiSettingsConfigurationError([...new Set(loadErrors.map((error) => error.scope))]);
	}

	const rawProvider = settings.getDefaultProvider() as unknown;
	const rawModel = settings.getDefaultModel() as unknown;
	const rawThinking = settings.getDefaultThinkingLevel() as unknown;
	if (
		(rawProvider !== undefined && (typeof rawProvider !== "string" || !rawProvider.trim())) ||
		(rawModel !== undefined && (typeof rawModel !== "string" || !rawModel.trim())) ||
		(rawThinking !== undefined && (typeof rawThinking !== "string" || !THINKING_LEVELS.has(rawThinking as ThinkingLevel)))
	) {
		throw new PiSettingsConfigurationError(["global", "project"]);
	}

	return {
		provider: typeof rawProvider === "string" ? rawProvider.trim() : undefined,
		model: typeof rawModel === "string" ? rawModel.trim() : undefined,
		// This is Pi's own SDK fallback when defaultThinkingLevel is absent.
		thinkingLevel: typeof rawThinking === "string" ? rawThinking as ThinkingLevel : "medium",
	};
}

export function isPiThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel);
}
