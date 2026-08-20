import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TelegramThinkingLevel } from "../agent/model-settings.ts";
import { ConfigError } from "../config.ts";
import {
	createSharedModelRuntime,
	PiModelConfigurationError,
	type PiModelConfigurationCategory,
} from "../agent/model-runtime.ts";
import { loadPiModelDefaults, PiSettingsConfigurationError, type PiModelDefaults } from "../agent/model-settings.ts";
import { redactDaemonLog } from "../daemon/control.ts";
import {
	OnboardingValidationError,
	OnboardingWriteError,
	readExistingConfigSource,
	replaceExistingConfigSource,
	validateEditedConfigSource,
	validateExistingDeployment,
	writeFirstRunDeployment,
	type DeploymentSummary,
	type FirstRunDraft,
	type OnboardingWriteMode,
} from "./config-core.ts";

export const WIZARD_ACTION_VALIDATE = "Validate existing configuration";
export const WIZARD_ACTION_EDIT = "Edit existing source";
export const WIZARD_ACTION_REPLACE = "Back up and replace";
export const WIZARD_ACTION_CANCEL = "Cancel";
export const WIZARD_TEMPLATE_ZH = "中文模板";
export const WIZARD_TEMPLATE_EN = "English template";

export interface ConfigWizardUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	editor(title: string, prefill?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface DaemonReadiness {
	ready: boolean;
	diagnostic?: string;
}

export interface ConfigWizardDependencies {
	rootDir: string;
	restartDaemon(): Promise<DaemonReadiness>;
	/** Public persona templates ship with the plugin, not the workdir. */
	personaTemplatesDir?: string;
	/** Test seam; production resolves and authenticates Pi's merged default model locally. */
	preflightPiModel?: PiModelPreflight;
}

export interface PiModelSelection {
	provider: string;
	model: string;
	thinkingLevel: TelegramThinkingLevel;
}

export type PiModelPreflight = (rootDir: string) => Promise<PiModelSelection>;

export type PiOnboardingPreflightCategory = "invalid_settings" | "missing_default" | PiModelConfigurationCategory;

export class PiOnboardingPreflightError extends Error {
	constructor(readonly category: PiOnboardingPreflightCategory) {
		super(`Pi model preflight failed (${category})`);
		this.name = "PiOnboardingPreflightError";
	}
}

export type ConfigWizardOutcome = "cancelled" | "validated" | "ready" | "configured_not_ready" | "failed";

export interface ConfigWizardResult {
	outcome: ConfigWizardOutcome;
	summary?: DeploymentSummary;
}

/** Pi-native dialog flow. It never sends dialog values to notifications, logs, or provider context. */
export async function runNativeConfigWizard(
	ui: ConfigWizardUI,
	dependencies: ConfigWizardDependencies,
): Promise<ConfigWizardResult> {
	const rootDir = resolve(dependencies.rootDir);
	const typedPath = join(rootDir, "telegram.config.ts");
	const envPath = join(rootDir, ".env");
	let existing: ReturnType<typeof readExistingConfigSource> | null = null;
	try {
		existing = readExistingConfigSource(rootDir);
	} catch {
		// Missing and unreadable defaults are handled by the protected-file branch below.
	}

	let mode: OnboardingWriteMode = "create";
	if (existing) {
		const isProjectRootSource = dirname(existing.path) === rootDir;
		const canFullReplace = existing.path === typedPath;
		const actions = [WIZARD_ACTION_VALIDATE];
		if (isProjectRootSource) actions.push(WIZARD_ACTION_EDIT);
		if (canFullReplace) actions.push(WIZARD_ACTION_REPLACE);
		actions.push(WIZARD_ACTION_CANCEL);
		const action = await ui.select("Telegram configuration already exists", actions);
		if (!action || action === WIZARD_ACTION_CANCEL) return cancelled(ui);
		if (action === WIZARD_ACTION_VALIDATE) {
			try {
				const summary = validateExistingDeployment(rootDir);
				ui.notify(formatSummary("Configuration is valid", summary), "info");
				return { outcome: "validated", summary };
			} catch (error) {
				ui.notify(formatSafeFailure("Existing configuration is invalid", error, "No files were changed."), "error");
				return { outcome: "failed" };
			}
		}
		if (action === WIZARD_ACTION_EDIT) {
			const edited = await ui.editor(`Edit ${existing.path.slice(rootDir.length + 1)}`, existing.source);
			if (edited === undefined) return cancelled(ui);
			try {
				const summary = validateEditedConfigSource(rootDir, existing.path, edited);
				if (edited === existing.source) {
					ui.notify(formatSummary("Configuration is valid; source was unchanged", summary), "info");
					return { outcome: "validated", summary };
				}
				const confirmed = await ui.confirm(
					"Replace existing configuration?",
					"The exact original source will be kept as a local backup. Secrets in .env are not shown or changed.",
				);
				if (!confirmed) return cancelled(ui);
				const result = replaceExistingConfigSource(rootDir, existing.path, edited, { confirmed: true });
				ui.notify(`Configuration source verified; backup kept at ${result.backupPath}.`, "info");
				return await finishReadiness(ui, dependencies, result.summary);
			} catch (error) {
				ui.notify(
					formatSafeFailure("Edited configuration is invalid", error, "The original file was preserved."),
					"error",
				);
				return { outcome: "failed" };
			}
		}
		const confirmed = await ui.confirm(
			"Back up and replace local configuration?",
			"Existing config, .env, and matching generated persona files will be preserved as local backups before replacement.",
		);
		if (!confirmed) return cancelled(ui);
		mode = "backup-replace";
	} else if (existsSync(typedPath) || existsSync(envPath)) {
		const action = await ui.select("Partial or ambiguous Telegram configuration found", [
			WIZARD_ACTION_REPLACE,
			WIZARD_ACTION_CANCEL,
		]);
		if (!action || action === WIZARD_ACTION_CANCEL) return cancelled(ui);
		const confirmed = await ui.confirm(
			"Back up and replace local configuration?",
			"Every existing default config and .env file will be retained as a local backup. No automatic merge of TypeScript source is attempted.",
		);
		if (!confirmed) return cancelled(ui);
		mode = "backup-replace";
	}

	let piModel: PiModelSelection;
	try {
		piModel = await (dependencies.preflightPiModel ?? preflightPiDefaultModel)(rootDir);
	} catch (error) {
		const category = error instanceof PiOnboardingPreflightError ? error.category : "runtime_unavailable";
		ui.notify(
			`Pi model is not ready (${category}). No files were changed. Exit this flow, use Pi /login and /model, then run /tg config again.`,
			"error",
		);
		return { outcome: "failed" };
	}
	ui.notify(`Pi model ready: ${formatPiModel(piModel)}. Authentication remains in Pi.`, "info");

	let collected: { draft: FirstRunDraft; zh: boolean } | null;
	try {
		collected = await collectFirstRunDraft(ui, rootDir, dependencies.personaTemplatesDir);
	} catch (error) {
		ui.notify(
			formatSafeFailure(
				"Configuration could not start",
				error,
				"No files were changed; restore the public persona templates and retry.",
			),
			"error",
		);
		return { outcome: "failed" };
	}
	if (!collected) return cancelled(ui);
	const approved = await ui.confirm(
		collected.zh ? "写入 Telegram 配置？" : "Write Telegram configuration?",
		[
			`Bot: ${collected.draft.bot.id} (${collected.draft.bot.name})`,
			`Model: ${formatPiModel(piModel)}`,
			collected.zh
				? "文件：.env、telegram.config.ts、私有 persona"
				: "Files: .env, telegram.config.ts, private persona",
			mode === "backup-replace"
				? collected.zh
					? "已存在的本地文件会先备份。"
					: "Existing local files will be backed up first."
				: collected.zh
					? "不会覆盖任何已存在的本地文件。"
					: "No existing local files will be overwritten.",
		].join("\n"),
	);
	if (!approved) return cancelled(ui);

	try {
		const result = writeFirstRunDeployment(rootDir, collected.draft, {
			mode,
			modelSelection: { provider: piModel.provider, model: piModel.model },
		});
		if (result.backupPaths.length > 0) {
			ui.notify(`Configuration files verified; ${result.backupPaths.length} local backup(s) were retained.`, "info");
		} else {
			ui.notify("Configuration files verified. Restarting the Telegram daemon...", "info");
		}
		return await finishReadiness(ui, dependencies, result.summary);
	} catch (error) {
		ui.notify(
			formatSafeFailure(
				"Configuration was not written",
				error,
				"Existing files were preserved; run /tg config to retry.",
			),
			"error",
		);
		return { outcome: "failed" };
	}
}

async function collectFirstRunDraft(
	ui: ConfigWizardUI,
	rootDir: string,
	templatesDirOverride?: string,
): Promise<{ draft: FirstRunDraft; zh: boolean } | null> {
	const templateChoice = await ui.select("Choose a public persona template / 选择 public persona 模板", [
		WIZARD_TEMPLATE_ZH,
		WIZARD_TEMPLATE_EN,
	]);
	if (!templateChoice) return null;
	const zh = templateChoice === WIZARD_TEMPLATE_ZH;
	const templateName = zh ? "template.zh.md" : "template.en.md";
	let personaText: string;
	const templatesDir = resolve(templatesDirOverride ?? join(rootDir, "personas"));
	try {
		personaText = readFileSync(join(templatesDir, templateName), "utf8");
	} catch {
		throw new OnboardingWriteError(`public persona template is unavailable: personas/${templateName}`);
	}
	const groupPeerId = await input(
		ui,
		zh ? "Telegram 群 ID（supergroup，可填裸正数/负数/-100...）" : "Telegram supergroup id",
		"-1001234567890",
	);
	if (groupPeerId == null) return null;
	const botId = await input(
		ui,
		zh ? "本地 bot 标识（仅本机使用：字母/数字/下划线/连字符）" : "Local bot id",
		"friend",
		"friend",
	);
	if (botId == null) return null;
	const botName = await input(
		ui,
		zh ? "群内显示名（可中文，会显示在群消息里）" : "Bot display name",
		zh ? "小雨" : "Mochi",
		zh ? "小雨" : "Mochi",
	);
	if (botName == null) return null;
	const tokenEnv = await input(
		ui,
		zh ? "Telegram token 的 .env 键名（字母开头，仅字母/数字/下划线）" : "Name for the Telegram token in .env",
		"telegram_bot_token",
		"telegram_bot_token",
	);
	if (tokenEnv == null) return null;
	const token = await input(
		ui,
		zh ? "Telegram bot token（输入可见，只写入被忽略的 .env）" : "Telegram bot token (Pi native input is visible)",
		zh ? "粘贴 BotFather 的 token" : "paste the BotFather token; it is written only to ignored .env",
	);
	if (token == null) return null;

	personaText = zh
		? personaText.replace("- 名字：请填写公开显示名。", `- 名字：${botName}`)
		: personaText.replace("- Name: choose the public display name.", `- Name: ${botName}`);
	return {
		draft: {
			groupPeerId,
			bot: { id: botId, name: botName, tokenEnv, token, personaText },
		},
		zh,
	};
}

/** Local-only catalog/auth validation; it never sends a provider request. */
export async function preflightPiDefaultModel(
	rootDir: string,
	readDefaults: (root: string) => PiModelDefaults = loadPiModelDefaults,
	preflightModels: (
		bots: readonly { provider: string; model: string }[],
	) => Promise<unknown> = createSharedModelRuntime,
): Promise<PiModelSelection> {
	let defaults: PiModelDefaults;
	try {
		defaults = readDefaults(rootDir);
	} catch (error) {
		if (error instanceof PiSettingsConfigurationError) throw new PiOnboardingPreflightError("invalid_settings");
		throw new PiOnboardingPreflightError("runtime_unavailable");
	}
	if (!defaults.provider || !defaults.model) throw new PiOnboardingPreflightError("missing_default");
	try {
		await preflightModels([{ provider: defaults.provider, model: defaults.model }]);
	} catch (error) {
		if (error instanceof PiModelConfigurationError) throw new PiOnboardingPreflightError(error.category);
		throw new PiOnboardingPreflightError("runtime_unavailable");
	}
	return {
		provider: defaults.provider,
		model: defaults.model,
		thinkingLevel: defaults.thinkingLevel,
	};
}

async function finishReadiness(
	ui: ConfigWizardUI,
	dependencies: ConfigWizardDependencies,
	summary: DeploymentSummary,
): Promise<ConfigWizardResult> {
	let readiness: DaemonReadiness;
	try {
		readiness = await dependencies.restartDaemon();
	} catch {
		readiness = { ready: false };
	}
	if (!readiness.ready) {
		const safeDiagnostic = redactDaemonLog(readiness.diagnostic ?? "");
		const diagnostic = safeDiagnostic ? ` Diagnostic: ${safeDiagnostic}` : "";
		ui.notify(
			`Configuration is valid and was kept, but the daemon is not ready.${diagnostic} Run /tg status-daemon, then /tg restart to retry.`,
			"error",
		);
		return { outcome: "configured_not_ready", summary };
	}
	ui.notify(`${formatSummary("Configuration complete; daemon ready", summary)} Opening the all-bots feed.`, "info");
	return { outcome: "ready", summary };
}

async function input(
	ui: ConfigWizardUI,
	title: string,
	placeholder?: string,
	fallback?: string,
): Promise<string | null> {
	const value = await ui.input(title, placeholder);
	if (value === undefined) return null;
	const normalized = value.trim();
	return normalized || fallback || "";
}

function cancelled(ui: ConfigWizardUI): ConfigWizardResult {
	ui.notify("Configuration cancelled; no files were changed.", "info");
	return { outcome: "cancelled" };
}

function formatSummary(prefix: string, summary: DeploymentSummary): string {
	const bots = summary.bots.map((bot) => `${bot.id} (${bot.name}, ${bot.provider}/${bot.model})`).join(", ");
	return `${prefix}: ${bots}.`;
}

function formatPiModel(selection: PiModelSelection): string {
	const safe = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 160);
	return `${safe(selection.provider)}/${safe(selection.model)}:${selection.thinkingLevel}`;
}

const FIELD_HINTS: Readonly<Record<string, string>> = {
	"bot.token_env": "字母开头，仅字母/数字/下划线（如 telegram_bot_token）",
	"bot.token": "BotFather token（数字:字母数字，形如 1234567890:AA...）",
	"bot.id": "字母/数字/下划线/连字符",
	"bot.name": "不能为空，≤64 字符",
	"bot.persona": "persona 内容为空或过大",
	group_peer_id: "需为合法的群数字 ID",
};

function formatSafeFailure(prefix: string, error: unknown, suffix: string): string {
	let fields: string[] = [];
	if (error instanceof OnboardingValidationError) fields = [...error.fields];
	else if (error instanceof ConfigError) {
		fields = error.errors.map((line) => {
			const field = line.match(/^\[config\]\s+([^:]+):/)?.[1];
			return field ?? "configuration source";
		});
	} else if (error instanceof OnboardingWriteError) {
		fields = [error.message.replace(/[\r\n]+/g, " ").slice(0, 240)];
	}
	const detail =
		fields.length > 0
			? ` Check: ${[...new Set(fields)]
					.map((field) => (FIELD_HINTS[field] ? `${field} (${FIELD_HINTS[field]})` : field))
					.join(", ")}.`
			: "";
	return `${prefix}.${detail} ${suffix}`;
}
