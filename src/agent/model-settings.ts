import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

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
		super(
			`Pi settings unavailable (invalid_settings: ${scopes.join(",") || "unknown"}). Fix Pi settings, then restart.`,
		);
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

	return {
		provider: settings.getDefaultProvider(),
		model: settings.getDefaultModel(),
		// This is Pi's own SDK fallback when defaultThinkingLevel is absent.
		thinkingLevel: settings.getDefaultThinkingLevel() ?? "medium",
	};
}

export function isPiThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel);
}
