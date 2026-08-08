import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	type Stats,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { defaultConfigPath, loadConfig, normalizePeerId, type AppConfig } from "../config.ts";

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BOT_ID = /^[A-Za-z0-9_-]+$/;
const TELEGRAM_TOKEN = /^\d{5,20}:[A-Za-z0-9_-]{20,}$/;
const MAX_PERSONA_BYTES = 256 * 1024;
const PRIVATE_MODE = 0o600;

export interface FirstRunDraft {
	groupPeerId: string;
	bot: {
		id: string;
		name: string;
		tokenEnv: string;
		token: string;
		personaText: string;
	};
}

export interface DeploymentSummary {
	configPath: string;
	groupPeerId: number;
	bots: Array<{ id: string; name: string; provider: string; model: string }>;
}

export interface ConfigSource {
	path: string;
	source: string;
}

export interface ConfigFileOps {
	exists(path: string): boolean;
	readFile(path: string): string;
	lstat(path: string): Pick<Stats, "mode" | "isFile" | "isSymbolicLink">;
	mkdir(path: string): void;
	writeFile(path: string, contents: string, mode: number): void;
	rename(from: string, to: string): void;
	chmod(path: string, mode: number): void;
	unlink(path: string): void;
}

export const nodeConfigFileOps: ConfigFileOps = {
	exists: existsSync,
	readFile: (path) => readFileSync(path, "utf8"),
	lstat: lstatSync,
	mkdir: (path) => mkdirSync(path, { recursive: true }),
	writeFile: (path, contents, mode) => writeFileSync(path, contents, { encoding: "utf8", flag: "wx", mode }),
	rename: renameSync,
	chmod: chmodSync,
	unlink: unlinkSync,
};

export class OnboardingValidationError extends Error {
	readonly fields: readonly string[];

	constructor(fields: readonly string[]) {
		super(`invalid onboarding fields: ${fields.join(", ")}`);
		this.name = "OnboardingValidationError";
		this.fields = fields;
	}
}

export class OnboardingWriteError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OnboardingWriteError";
	}
}

export type OnboardingWriteMode = "create" | "backup-replace";
export type OnboardingWritePhase = "validated" | "installed" | "verified" | "rolled_back";

export interface OnboardingWriteEvent {
	phase: OnboardingWritePhase;
	paths: string[];
}

export interface OnboardingWriteOptions {
	mode?: OnboardingWriteMode;
	nonce?: string;
	/** Preflighted Pi selection to pin in newly generated configuration. */
	modelSelection?: { provider: string; model: string };
	fileOps?: ConfigFileOps;
	onEvent?: (event: OnboardingWriteEvent) => void;
}

interface NormalizedDraft extends FirstRunDraft {
	groupPeerIdNumber: number;
	personaRelativePath: string;
}

interface InstallFile {
	path: string;
	contents: string;
	mode: number;
}

interface AtomicInstall {
	backupPaths: string[];
	rollback(): void;
	finalize(): void;
}

export function validateFirstRunDraft(draft: FirstRunDraft): NormalizedDraft {
	const invalid: string[] = [];
	const groupPeerIdNumber = normalizePeerId(draft.groupPeerId);
	if (!Number.isFinite(groupPeerIdNumber)) invalid.push("group_peer_id");
	if (!BOT_ID.test(draft.bot.id)) invalid.push("bot.id");
	if (!draft.bot.name.trim() || draft.bot.name.length > 64 || /[\r\n\0]/.test(draft.bot.name)) invalid.push("bot.name");
	if (!ENV_KEY.test(draft.bot.tokenEnv)) invalid.push("bot.token_env");
	if (!TELEGRAM_TOKEN.test(draft.bot.token)) invalid.push("bot.token");
	if (
		!draft.bot.personaText.trim()
		|| draft.bot.personaText.includes("\0")
		|| Buffer.byteLength(draft.bot.personaText, "utf8") > MAX_PERSONA_BYTES
	) invalid.push("bot.persona");
	if (invalid.length > 0) throw new OnboardingValidationError([...new Set(invalid)]);

	return {
		...draft,
		groupPeerIdNumber,
		bot: { ...draft.bot, name: draft.bot.name.trim() },
		personaRelativePath: `personas/${draft.bot.id}.local.md`,
	};
}

export function mergeEnvSource(source: string, updates: Readonly<Record<string, string>>): string {
	const remaining = new Map(Object.entries(updates));
	const updateKeys = new Set(remaining.keys());
	const output: string[] = [];
	for (const line of source.split(/\r?\n/)) {
		const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/);
		if (!match || !updateKeys.has(match[1]!)) {
			output.push(line);
			continue;
		}
		if (!remaining.has(match[1]!)) continue;
		output.push(`${match[1]}: ${remaining.get(match[1]!)}`);
		remaining.delete(match[1]!);
	}
	while (output.length > 0 && output.at(-1) === "") output.pop();
	if (output.length > 0 && remaining.size > 0) output.push("");
	for (const [key, value] of remaining) output.push(`${key}: ${value}`);
	return `${output.join("\n")}\n`;
}

function renderFirstRunConfig(
	draft: NormalizedDraft,
	modelSelection?: { provider: string; model: string },
): string {
	const value = (input: string | number | boolean) => JSON.stringify(input);
	const pinnedModel = modelSelection
		? `\tprovider: ${value(modelSelection.provider)},\n\tmodel: ${value(modelSelection.model)},\n`
		: "";
	return `import { defineConfig } from "./src/config.ts";

export default defineConfig({
	group_peer_id: ${value(draft.groupPeerIdNumber)},
${pinnedModel}	reasoning_effort: "off",
	cache_retention: "short",
	compaction_model: "openai-codex/gpt-5.6-luna:low",
	compaction_threshold: 128_000,
	compaction_keep_recent: 20_000,
	max_suffix_tokens: 12_000,
	max_message_tokens: 4_096,
	sampling_cooldown_ms: 2_000,
	db_path: "data/agent.db",
	tinyfish_key_env: "tiny_fish_api_key",
	vision: {
		enabled: false,
		foreground_media_limit: 2,
		concurrency: 2,
		per_chat_hourly_limit: 24,
		daily_limit: 200,
	},
	telemetry_retention_days: 90,
	raw_update_retention_days: 30,
	message_event_retention_days: 365,
	telegram_admins: [],
	bots: [{
		id: ${value(draft.bot.id)},
		name: ${value(draft.bot.name)},
		token_env: ${value(draft.bot.tokenEnv)},
		persona_path: ${value(draft.personaRelativePath)},
		routing_p: 0.1,
		sticker_sets: [],
		tools: { send: true, search: false, run_js: false },
	}],
});
`;
}

/** Write a complete first-run deployment or replace it only after explicit confirmation upstream. */
export function writeFirstRunDeployment(rootDir: string, draft: FirstRunDraft, options: OnboardingWriteOptions = {}): {
	summary: DeploymentSummary;
	backupPaths: string[];
} {
	const root = resolve(rootDir);
	const normalized = validateFirstRunDraft(draft);
	const mode = options.mode ?? "create";
	const ops = options.fileOps ?? nodeConfigFileOps;
	const nonce = options.nonce ?? randomUUID();
	const configPath = join(root, "telegram.config.ts");
	const envPath = join(root, ".env");
	const personaPath = join(root, normalized.personaRelativePath);
	options.onEvent?.({ phase: "validated", paths: [".env", "telegram.config.ts", normalized.personaRelativePath] });

	let existingEnv = "";
	if (mode === "backup-replace" && ops.exists(envPath)) {
		assertRegularFile(envPath, ops);
		existingEnv = ops.readFile(envPath);
	}
	const envSource = mergeEnvSource(existingEnv, {
		[normalized.bot.tokenEnv]: normalized.bot.token,
	});
	const files: InstallFile[] = [
		{ path: envPath, contents: envSource, mode: PRIVATE_MODE },
		{ path: configPath, contents: renderFirstRunConfig(normalized, options.modelSelection), mode: PRIVATE_MODE },
		{ path: personaPath, contents: ensureTrailingNewline(normalized.bot.personaText), mode: PRIVATE_MODE },
	];
	const transaction = installAtomically(files, [], mode, nonce, ops);
	options.onEvent?.({ phase: "installed", paths: files.map((file) => relative(root, file.path)) });
	try {
		const config = loadConfig(root, { configPath });
		const summary = summarizeConfig(root, config, configPath);
		transaction.finalize();
		options.onEvent?.({ phase: "verified", paths: [relative(root, configPath)] });
		return { summary, backupPaths: transaction.backupPaths.map((path) => relative(root, path)) };
	} catch {
		transaction.rollback();
		options.onEvent?.({ phase: "rolled_back", paths: files.map((file) => relative(root, file.path)) });
		throw new OnboardingWriteError("final configuration validation failed; original files were restored");
	}
}

export function validateExistingDeployment(rootDir: string): DeploymentSummary {
	const root = resolve(rootDir);
	const path = onboardingConfigPath(root);
	return summarizeConfig(root, loadConfig(root), path);
}

export function readExistingConfigSource(rootDir: string, ops: ConfigFileOps = nodeConfigFileOps): ConfigSource {
	const root = resolve(rootDir);
	const path = onboardingConfigPath(root);
	if (!ops.exists(path)) throw new OnboardingWriteError("no existing telegram.config.ts configuration was found");
	assertRegularFile(path, ops);
	return { path, source: ops.readFile(path) };
}

function onboardingConfigPath(rootDir: string): string {
	return defaultConfigPath(rootDir);
}

export function validateEditedConfigSource(
	rootDir: string,
	path: string,
	source: string,
	options: Pick<OnboardingWriteOptions, "nonce" | "fileOps"> = {},
): DeploymentSummary {
	const root = resolve(rootDir);
	const target = resolve(path);
	if (dirname(target) !== root || extname(target) !== ".ts") {
		throw new OnboardingWriteError("edited configuration must be the project-root .ts source");
	}
	const ops = options.fileOps ?? nodeConfigFileOps;
	const extension = extname(target);
	const stem = basename(target, extension);
	const temporary = join(root, `.${stem}.edit-${options.nonce ?? randomUUID()}${extension}`);
	if (ops.exists(temporary)) throw new OnboardingWriteError(`temporary file already exists: ${basename(temporary)}`);
	let created = false;
	try {
		ops.writeFile(temporary, source, PRIVATE_MODE);
		created = true;
		return summarizeConfig(root, loadConfig(root, { configPath: temporary }), target);
	} finally {
		if (created) unlinkIfExists(temporary, ops);
	}
}

export function replaceExistingConfigSource(
	rootDir: string,
	path: string,
	source: string,
	options: OnboardingWriteOptions & { confirmed: boolean },
): { summary: DeploymentSummary; backupPath: string } {
	if (!options.confirmed) throw new OnboardingWriteError("replacement was not confirmed; original configuration was preserved");
	const root = resolve(rootDir);
	const target = resolve(path);
	const ops = options.fileOps ?? nodeConfigFileOps;
	assertRegularFile(target, ops);
	validateEditedConfigSource(root, target, source, options);
	const transaction = installAtomically(
		[{ path: target, contents: source, mode: PRIVATE_MODE }],
		[],
		"backup-replace",
		options.nonce ?? randomUUID(),
		ops,
	);
	try {
		const summary = summarizeConfig(root, loadConfig(root, { configPath: target }), target);
		transaction.finalize();
		return { summary, backupPath: relative(root, transaction.backupPaths[0]!) };
	} catch {
		transaction.rollback();
		throw new OnboardingWriteError("edited configuration validation failed; original file was restored");
	}
}

function installAtomically(
	files: InstallFile[],
	retirePaths: string[],
	mode: OnboardingWriteMode,
	nonce: string,
	ops: ConfigFileOps,
): AtomicInstall {
	const allProtected = [...new Set([...files.map((file) => file.path), ...retirePaths])];
	const existing = allProtected.filter((path) => ops.exists(path));
	if (mode === "create" && existing.length > 0) {
		throw new OnboardingWriteError(`existing files were preserved: ${existing.map((path) => basename(path)).join(", ")}`);
	}
	for (const path of existing) assertRegularFile(path, ops);
	const backups = existing.map((path) => ({ original: path, backup: `${path}.bak-${nonce}` }));
	for (const { backup } of backups) {
		if (ops.exists(backup)) throw new OnboardingWriteError(`backup already exists: ${basename(backup)}`);
	}
	const staged = files.map((file) => ({
		...file,
		temporary: join(dirname(file.path), `.${basename(file.path)}.tmp-${nonce}`),
	}));
	for (const file of staged) {
		if (ops.exists(file.temporary)) throw new OnboardingWriteError(`temporary file already exists: ${basename(file.temporary)}`);
		ops.mkdir(dirname(file.path));
	}

	const movedBackups: typeof backups = [];
	const installed: string[] = [];
	let closed = false;
	const rollback = () => {
		if (closed) return;
		const failures: string[] = [];
		const attempt = (label: string, action: () => void) => {
			try {
				action();
			} catch {
				failures.push(label);
			}
		};
		for (const path of [...installed].reverse()) attempt(basename(path), () => unlinkIfExists(path, ops));
		for (const { original, backup } of [...movedBackups].reverse()) {
			attempt(basename(original), () => unlinkIfExists(original, ops));
			attempt(basename(backup), () => {
				if (ops.exists(backup)) ops.rename(backup, original);
			});
		}
		for (const file of staged) attempt(basename(file.temporary), () => unlinkIfExists(file.temporary, ops));
		closed = true;
		if (failures.length > 0) {
			throw new OnboardingWriteError(`automatic rollback was incomplete for: ${[...new Set(failures)].join(", ")}`);
		}
	};

	try {
		for (const file of staged) ops.writeFile(file.temporary, file.contents, file.mode);
		for (const item of backups) {
			ops.rename(item.original, item.backup);
			movedBackups.push(item);
		}
		for (const file of staged) {
			ops.rename(file.temporary, file.path);
			installed.push(file.path);
			ops.chmod(file.path, file.mode);
		}
	} catch {
		try {
			rollback();
		} catch {
			throw new OnboardingWriteError("configuration write failed and automatic rollback was incomplete; inspect local backup files");
		}
		throw new OnboardingWriteError("configuration write failed; original files were restored");
	}

	return {
		backupPaths: backups.map(({ backup }) => backup),
		rollback,
		finalize() {
			closed = true;
		},
	};
}

function summarizeConfig(root: string, config: AppConfig, configPath: string): DeploymentSummary {
	return {
		configPath: relative(root, configPath),
		groupPeerId: config.groupPeerId,
		bots: config.bots.map((bot) => ({ id: bot.id, name: bot.name, provider: bot.provider, model: bot.model })),
	};
}

function assertRegularFile(path: string, ops: ConfigFileOps): void {
	const stat = ops.lstat(path);
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new OnboardingWriteError(`refusing non-regular local file: ${basename(path)}`);
	}
}

function unlinkIfExists(path: string, ops: ConfigFileOps): void {
	if (!ops.exists(path)) return;
	ops.unlink(path);
}

function ensureTrailingNewline(value: string): string {
	return value.endsWith("\n") ? value : `${value}\n`;
}
