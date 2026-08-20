import type { Effort } from "@oh-my-pi/pi-ai";
import type { PiRequestThinkingLevel } from "./model-settings.ts";

export const DEFAULT_AUXILIARY_VISUAL_MODEL = "openai-codex/gpt-5.6-luna:low";

/** omp's `Effort` enum uses the same string values as the config's thinking levels. */
export const EFFORT_BY_THINKING_LEVEL: Record<PiRequestThinkingLevel, Effort> = {
	minimal: "minimal" as Effort,
	low: "low" as Effort,
	medium: "medium" as Effort,
	high: "high" as Effort,
	xhigh: "xhigh" as Effort,
	max: "max" as Effort,
};

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
	if (!(Object.keys(EFFORT_BY_THINKING_LEVEL) as readonly string[]).includes(thinkingLevel)) return null;

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
