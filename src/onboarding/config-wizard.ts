import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { ConfigError, defaultConfigPath, parseEnvFile } from "../config.ts";
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
	const legacyPath = join(rootDir, "bots.config.json");
	const envPath = join(rootDir, ".env");
	const configOverride = process.env.bots_config ?? parseEnvFile(envPath).bots_config;
	let explicitConfigPath: string | null = null;
	if (configOverride?.trim()) {
		try {
			explicitConfigPath = defaultConfigPath(rootDir, configOverride);
		} catch (error) {
			ui.notify(formatSafeFailure("Configuration source override is invalid", error, "Fix or remove bots_config, then retry."), "error");
			return { outcome: "failed" };
		}
		if (!existsSync(explicitConfigPath) && explicitConfigPath !== typedPath) {
			ui.notify(
				formatSafeFailure(
					"Configuration source override is missing",
					new OnboardingWriteError(`bots_config selects a missing source: ${basename(explicitConfigPath)}`),
					"Create that file or remove bots_config, then retry.",
				),
				"error",
			);
			return { outcome: "failed" };
		}
	}
	const defaultConfigFiles = [typedPath, legacyPath].filter(existsSync);
	let existing: ReturnType<typeof readExistingConfigSource> | null = null;
	try {
		existing = readExistingConfigSource(rootDir);
	} catch {
		// Missing and ambiguous defaults are handled by the protected-file branch below.
	}

	let mode: OnboardingWriteMode = "create";
	if (existing) {
		const isProjectRootSource = dirname(existing.path) === rootDir;
		const canFullReplace = explicitConfigPath === null
			? existing.path === typedPath || existing.path === legacyPath
			: existing.path === typedPath;
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
				ui.notify(formatSafeFailure("Edited configuration is invalid", error, "The original file was preserved."), "error");
				return { outcome: "failed" };
			}
		}
		const confirmed = await ui.confirm(
			"Back up and replace local configuration?",
			"Existing config, .env, and matching generated persona files will be preserved as local backups before replacement.",
		);
		if (!confirmed) return cancelled(ui);
		mode = "backup-replace";
	} else if (defaultConfigFiles.length > 0 || existsSync(envPath)) {
		const action = await ui.select("Partial or ambiguous Telegram configuration found", [WIZARD_ACTION_REPLACE, WIZARD_ACTION_CANCEL]);
		if (!action || action === WIZARD_ACTION_CANCEL) return cancelled(ui);
		const confirmed = await ui.confirm(
			"Back up and replace local configuration?",
			"Every existing default config and .env file will be retained as a local backup. No automatic merge of TypeScript source is attempted.",
		);
		if (!confirmed) return cancelled(ui);
		mode = "backup-replace";
	}

	let collected: FirstRunDraft | null;
	try {
		collected = await collectFirstRunDraft(ui, rootDir);
	} catch (error) {
		ui.notify(formatSafeFailure("Configuration could not start", error, "No files were changed; restore the public persona templates and retry."), "error");
		return { outcome: "failed" };
	}
	if (!collected) return cancelled(ui);
	const approved = await ui.confirm(
		"Write Telegram configuration?",
		[
			`Bot: ${collected.bot.id} (${collected.bot.name})`,
			`Model: ${collected.provider}/${collected.model}`,
			"Files: .env, telegram.config.ts, private persona",
			mode === "backup-replace" ? "Existing local files will be backed up first." : "No existing local files will be overwritten.",
		].join("\n"),
	);
	if (!approved) return cancelled(ui);

	try {
		const result = writeFirstRunDeployment(rootDir, collected, { mode });
		if (result.backupPaths.length > 0) {
			ui.notify(`Configuration files verified; ${result.backupPaths.length} local backup(s) were retained.`, "info");
		} else {
			ui.notify("Configuration files verified. Restarting the Telegram daemon...", "info");
		}
		return await finishReadiness(ui, dependencies, result.summary);
	} catch (error) {
		ui.notify(formatSafeFailure("Configuration was not written", error, "Existing files were preserved; run /tg config to retry."), "error");
		return { outcome: "failed" };
	}
}

async function collectFirstRunDraft(ui: ConfigWizardUI, rootDir: string): Promise<FirstRunDraft | null> {
	const templateChoice = await ui.select("Choose a public persona template", [WIZARD_TEMPLATE_ZH, WIZARD_TEMPLATE_EN]);
	if (!templateChoice) return null;
	const templateName = templateChoice === WIZARD_TEMPLATE_ZH ? "template.zh.md" : "template.en.md";
	let personaText: string;
	try {
		personaText = readFileSync(join(rootDir, "personas", templateName), "utf8");
	} catch {
		throw new OnboardingWriteError(`public persona template is unavailable: personas/${templateName}`);
	}
	const groupPeerId = await input(ui, "Telegram supergroup id", "-1001234567890");
	if (groupPeerId == null) return null;
	const provider = await input(ui, "LLM provider id", "deepseek", "deepseek");
	if (provider == null) return null;
	const model = await input(ui, "LLM model id", provider === "deepseek" ? "deepseek-v4-flash" : "provider model id");
	if (model == null) return null;
	const apiKeyEnv = await input(ui, "Name for the provider key in .env", "llm_api_key", "llm_api_key");
	if (apiKeyEnv == null) return null;
	const providerApiKey = await input(ui, "Provider API key (Pi native input is visible)", "paste the key; it is written only to ignored .env");
	if (providerApiKey == null) return null;
	const botId = await input(ui, "Local bot id", "friend", "friend");
	if (botId == null) return null;
	const botName = await input(ui, "Bot display name", "Mochi");
	if (botName == null) return null;
	const tokenEnv = await input(ui, "Name for the Telegram token in .env", "telegram_bot_token", "telegram_bot_token");
	if (tokenEnv == null) return null;
	const token = await input(ui, "Telegram bot token (Pi native input is visible)", "paste the BotFather token; it is written only to ignored .env");
	if (token == null) return null;

	personaText = templateChoice === WIZARD_TEMPLATE_ZH
		? personaText.replace("- 名字：请填写公开显示名。", `- 名字：${botName}`)
		: personaText.replace("- Name: choose the public display name.", `- Name: ${botName}`);
	return {
		groupPeerId,
		provider,
		model,
		apiKeyEnv,
		providerApiKey,
		bot: { id: botId, name: botName, tokenEnv, token, personaText },
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
	const detail = fields.length > 0 ? ` Check: ${[...new Set(fields)].join(", ")}.` : "";
	return `${prefix}.${detail} ${suffix}`;
}
