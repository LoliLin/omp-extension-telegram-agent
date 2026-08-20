import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";

const THINKING_LEVELS: Record<string, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};

const REQUEST_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type PiRequestThinkingLevel = (typeof REQUEST_THINKING_LEVELS)[number];

/** Telegram-side thinking selector: "off" or an omp Effort value (string form). */
export type TelegramThinkingLevel = "off" | PiRequestThinkingLevel;

export interface PiModelDefaults {
	provider: string | undefined;
	model: string | undefined;
	thinkingLevel: TelegramThinkingLevel;
}

export interface PiSettingsReader {
	getDefaultProvider(): string | undefined;
	getDefaultModel(): string | undefined;
	getDefaultThinkingLevel(): TelegramThinkingLevel | undefined;
	drainErrors(): Array<{ scope: "global" | "project" }>;
}

export class PiSettingsConfigurationError extends Error {
	readonly category = "invalid_settings" as const;

	constructor(readonly scopes: readonly ("global" | "project")[]) {
		super(
			`OMP settings unavailable (invalid_settings: ${scopes.join(",") || "unknown"}). Fix OMP settings, then restart.`,
		);
		this.name = "PiSettingsConfigurationError";
	}
}

interface OmpSettingsDefaults {
	provider: string | undefined;
	model: string | undefined;
	thinkingLevel: TelegramThinkingLevel | undefined;
}

const EMPTY_SETTINGS_DEFAULTS: OmpSettingsDefaults = {
	provider: undefined,
	model: undefined,
	thinkingLevel: undefined,
};

/**
 * Parse only the two non-secret default keys omp writes into its YAML settings
 * (`defaultThinkingLevel` and `modelRoles.default`). Bounded line scan; any
 * malformed content degrades to undefined rather than failing config load.
 */
function readOmpSettingsDefaults(agentDir: string, projectRoot: string): OmpSettingsDefaults {
	const candidates = [join(projectRoot, ".omp", "config.yml"), join(agentDir, "config.yml")];
	for (const file of candidates) {
		let content: string;
		try {
			content = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const defaults: OmpSettingsDefaults = { provider: undefined, model: undefined, thinkingLevel: undefined };
		let inModelRoles = false;
		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trimEnd();
			const indent = line.length - line.trimStart().length;
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			if (indent === 0) {
				inModelRoles = trimmed.startsWith("modelRoles:");
				if (trimmed.startsWith("defaultThinkingLevel:")) {
					const value = trimmed.slice("defaultThinkingLevel:".length).trim();
					if (THINKING_LEVELS[value]) {
						defaults.thinkingLevel = value as TelegramThinkingLevel;
					}
				}
				continue;
			}
			if (inModelRoles && indent >= 2 && trimmed.startsWith("default:")) {
				const value = trimmed.slice("default:".length).trim();
				const slash = value.indexOf("/");
				if (slash > 0 && slash < value.length - 1) {
					defaults.provider = value.slice(0, slash);
					defaults.model = value.slice(slash + 1);
				}
			}
		}
		if (defaults.provider || defaults.model || defaults.thinkingLevel) return defaults;
	}
	return EMPTY_SETTINGS_DEFAULTS;
}

/**
 * Read omp's merged global/project defaults without copying or exposing credential data.
 * omp keeps no separate settings-level default provider/model pair; the default model
 * role (`modelRoles.default`) carries that role.
 */
export function loadPiModelDefaults(
	projectRoot: string,
	agentDir = getAgentDir(),
	createSettings: (root: string, dir: string) => PiSettingsReader = (root, dir) => {
		const defaults = readOmpSettingsDefaults(dir, root);
		return {
			getDefaultProvider: () => defaults.provider,
			getDefaultModel: () => defaults.model,
			getDefaultThinkingLevel: () => defaults.thinkingLevel,
			drainErrors: () => [],
		};
	},
): PiModelDefaults {
	const settings = createSettings(projectRoot, agentDir);
	const loadErrors = settings.drainErrors();
	if (loadErrors.length > 0) {
		throw new PiSettingsConfigurationError([...new Set(loadErrors.map((error) => error.scope))]);
	}

	return {
		provider: settings.getDefaultProvider(),
		model: settings.getDefaultModel(),
		// omp's own SDK fallback when defaultThinkingLevel is absent is the high effort
		// selector; the plugin keeps the historical medium fallback for configs that omit it.
		thinkingLevel: settings.getDefaultThinkingLevel() ?? "medium",
	};
}

export function isPiThinkingLevel(value: unknown): value is TelegramThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS[value] === true;
}

export const DEFAULT_AUXILIARY_VISUAL_MODEL = "openai-codex/gpt-5.6-luna:low";

export interface PiModelReference {
	provider: string;
	model: string;
	thinkingLevel: PiRequestThinkingLevel;
	canonical: string;
}

/** Parse a task model reference without consulting omp's catalog or credential store. */
export function parsePiModelReference(value: string): PiModelReference | null {
	if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) return null;
	const slash = value.indexOf("/");
	const colon = value.lastIndexOf(":");
	if (slash <= 0 || colon <= slash + 1 || colon === value.length - 1) return null;

	const provider = value.slice(0, slash);
	const model = value.slice(slash + 1, colon);
	const thinkingLevel = value.slice(colon + 1);
	if (!provider || !model || /[\s/:]/.test(provider) || /\s/.test(model)) return null;
	if (!(REQUEST_THINKING_LEVELS as readonly string[]).includes(thinkingLevel)) return null;

	return {
		provider,
		model,
		thinkingLevel: thinkingLevel as PiRequestThinkingLevel,
		canonical: `${provider}/${model}:${thinkingLevel}`,
	};
}

export function canonicalPiModelReference(value: string): string | null {
	return parsePiModelReference(value)?.canonical ?? null;
}
