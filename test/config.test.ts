// REQ-CONF-0001 + REQ-OPS-0001 regression tests: typed/legacy config validation,
// arbitrary bot counts, peer id normalization, pid lock exclusivity, example-file sanity.
// The lock test spawns a fixture process whose cmdline matches our daemon check;
// no real daemon or network is involved.

import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	loadConfig,
	parseEnvFile,
	normalizePeerId,
	normalizeTelegramAdmin,
	defaultConfigPath,
	ConfigError,
} from "../src/config.ts";
import { acquirePidLock, releasePidLock, readPid, pidAlive, isOurDaemon, listOurDaemons } from "../src/daemon/pid.ts";
import { buildSystemPrompt, sha256Short } from "../src/agent/prompt.ts";
import { loadPiModelDefaults, PiSettingsConfigurationError } from "../src/agent/model-settings.ts";

const FIXTURE_LOCK = join(import.meta.dir, "fixtures/daemon/index.ts");

// Bun auto-loads the project .env into process.env, and loadConfig lets process.env override
// the parsed file — tests must clear the real keys so the temp .env is authoritative.
const ENV_KEYS = [
	"telegram_bot_alpha", "telegram_bot_beta", "telegram_group_peer_id",
	"deepseek_api_key", "anthropic_api_key", "alternate_deepseek_key", "tiny_fish_api_key", "auxiliary_visual_model", "router_secret",
	"bots_config",
];
const savedEnv = new Map<string, string | undefined>();
for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);
for (const k of ENV_KEYS) delete process.env[k];
afterAll(() => {
	for (const [k, v] of savedEnv) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
});

const VALID_BOTS = [
	{ id: "A", name: "Alpha", token_env: "telegram_bot_alpha", persona_path: "personas/alpha.md", routing_p: 0.08 },
	{ id: "B", name: "Beta", token_env: "telegram_bot_beta", persona_path: "personas/beta.md", routing_p: 0.08 },
];

function makeEnvDir(bots: unknown = VALID_BOTS, extraEnv: Record<string, string> = {}, extraConfig: Record<string, unknown> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "conf-test-"));
	const lines = [
		"telegram_bot_alpha: 123:AAA",
		"telegram_bot_beta: 456:BBB",
		"tiny_fish_api_key: tf-test",
		...Object.entries(extraEnv).map(([k, v]) => `${k}: ${v}`),
	];
	writeFileSync(join(dir, ".env"), lines.join("\n"));
	writeFileSync(
		join(dir, "bots.config.json"),
		JSON.stringify({
			group_peer_id: 1234567890,
			provider: "deepseek",
			model: "deepseek-v4-flash",
			reasoning_effort: "medium",
			...extraConfig,
			bots,
		}),
	);
	// persona files referenced by the default VALID_BOTS must exist under the temp dir
	mkdirSync(join(dir, "personas"), { recursive: true });
	writeFileSync(join(dir, "personas/alpha.md"), "# Alpha\n\nA generic fixture persona.");
	writeFileSync(join(dir, "personas/beta.md"), "# Beta\n\nA second generic fixture persona.");
	return dir;
}

function convertFixtureToTypedConfig(dir: string, keepLegacy = false): void {
	const legacyPath = join(dir, "bots.config.json");
	const config = JSON.parse(readFileSync(legacyPath, "utf8")) as Record<string, unknown>;
	if (!keepLegacy) rmSync(legacyPath);
	const helperUrl = pathToFileURL(join(process.cwd(), "src/config-schema.ts")).href;
	writeFileSync(
		join(dir, "telegram.config.ts"),
		`import { defineConfig } from ${JSON.stringify(helperUrl)};\nexport default defineConfig(${JSON.stringify(config, null, 2)});\n`,
	);
}

function makeTypedExampleDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "typed-config-example-"));
	writeFileSync(join(dir, ".env"), [
		"telegram_bot_token: 123:EXAMPLE",
		"tinyfish_api_key: tf-example",
		"router_secret: fixture-only",
	].join("\n"));
	mkdirSync(join(dir, "personas"));
	writeFileSync(join(dir, "personas/template.en.md"), readFileSync("personas/template.en.md", "utf8"));
	const helperUrl = pathToFileURL(join(process.cwd(), "src/config-schema.ts")).href;
	const source = readFileSync("telegram.config.example.ts", "utf8")
		.replace('"./src/config-schema.ts"', JSON.stringify(helperUrl));
	writeFileSync(join(dir, "telegram.config.ts"), source);
	return dir;
}

describe("loadConfig typed/legacy sources (REQ-CONF-0001)", () => {
	test("ONBOARD AC3: typed config and legacy JSON normalize identically", () => {
		const legacyDir = makeEnvDir();
		const typedDir = makeEnvDir();
		convertFixtureToTypedConfig(typedDir);
		try {
			const project = (dir: string) => {
				const config = loadConfig(dir);
				return {
					groupPeerId: config.groupPeerId,
					telegramAdmins: config.telegramAdmins,
					bots: config.bots.map(({ token: _token, personaPath, ...bot }) => ({
						...bot,
						personaPath: personaPath.slice(personaPath.lastIndexOf("/") + 1),
					})),
				};
			};
			expect(project(typedDir)).toEqual(project(legacyDir));
		} finally {
			rmSync(legacyDir, { recursive: true, force: true });
			rmSync(typedDir, { recursive: true, force: true });
		}
	});

	test("ONBOARD AC3: the same typed fixture loads equivalently under Bun and Node", () => {
		const dir = makeEnvDir();
		convertFixtureToTypedConfig(dir);
		try {
			const fixture = join(import.meta.dir, "fixtures/load-config-runtime.ts");
			const bun = Bun.spawnSync(["bun", "run", fixture, dir], { cwd: process.cwd() });
			const node = Bun.spawnSync(["node", "--import", "jiti/register", fixture, dir], { cwd: process.cwd() });
			expect(bun.exitCode, bun.stderr.toString()).toBe(0);
			expect(node.exitCode, node.stderr.toString()).toBe(0);
			expect(JSON.parse(node.stdout.toString())).toEqual(JSON.parse(bun.stdout.toString()));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("ONBOARD AC3: ambiguous defaults fail fast and override extensions are explicit", () => {
		const dir = makeEnvDir();
		convertFixtureToTypedConfig(dir, true);
		try {
			expect(() => loadConfig(dir)).toThrow(/telegram\.config\.ts[\s\S]*bots\.config\.json/);
			expect(defaultConfigPath(dir, "deployment.ts")).toBe(join(dir, "deployment.ts"));
			expect(defaultConfigPath(dir, "deployment.json")).toBe(join(dir, "deployment.json"));
			expect(() => defaultConfigPath(dir, "deployment.yaml")).toThrow(/expected \.ts or \.json/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("ONBOARD AC3: tracked typed example loads without a private deployment", () => {
		const dir = makeTypedExampleDir();
		try {
			const config = loadConfig(dir);
			expect(config.bots.map((bot) => [bot.id, bot.name, bot.provider, bot.model])).toEqual([
				["friend", "Mochi", "openai-codex", "gpt-5.6-luna"],
			]);
			expect(config.telegramAdmins).toEqual([]);
			expect(config.bots[0]!.tools.search).toBe(false);
			expect(config.auxiliaryVisualModel).toBe("openai-codex/gpt-5.6-luna:low");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("VISION R7: auxiliary vision uses a canonical Pi ref and a bounded default", () => {
		const defaultDir = makeEnvDir();
		const legacyDir = makeEnvDir(VALID_BOTS, {}, { auxiliary_visual_model: "gpt-5.6-luna-low" });
		const invalidDir = makeEnvDir(VALID_BOTS, {}, { auxiliary_visual_model: "provider-model-low" });
		try {
			expect(loadConfig(defaultDir).auxiliaryVisualModel).toBe("openai-codex/gpt-5.6-luna:low");
			expect(loadConfig(legacyDir).auxiliaryVisualModel).toBe("openai-codex/gpt-5.6-luna:low");
			expect(() => loadConfig(invalidDir)).toThrow(/auxiliary_visual_model[\s\S]*provider\/model:effort/);
		} finally {
			rmSync(defaultDir, { recursive: true, force: true });
			rmSync(legacyDir, { recursive: true, force: true });
			rmSync(invalidDir, { recursive: true, force: true });
		}
	});

	test("AC5: single-bot and three-bot configs load", () => {
		for (const bots of [
			[{ id: "solo", token_env: "telegram_bot_alpha", persona_path: "personas/alpha.md", routing_p: 0.5 }],
			[
				{ id: "A", token_env: "telegram_bot_alpha", persona_path: "personas/alpha.md", routing_p: 0.1 },
				{ id: "B", token_env: "telegram_bot_beta", persona_path: "personas/beta.md", routing_p: 0.1 },
				{ id: "C", token_env: "telegram_bot_alpha", persona_path: "personas/beta.md", routing_p: 0.1 },
			],
		]) {
			const dir = makeEnvDir(bots);
			try {
				const config = loadConfig(dir);
				expect(config.bots.map((b) => b.id)).toEqual(bots.map((b) => b.id));
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}
	});

	test("AC3: duplicate bot ids error naming the offending ids", () => {
		const dir = makeEnvDir([
			{ id: "A", token_env: "telegram_bot_alpha", persona_path: "personas/alpha.md" },
			{ id: "A", token_env: "telegram_bot_beta", persona_path: "personas/beta.md" },
		]);
		try {
			expect(() => loadConfig(dir)).toThrow(/duplicate bot id "A"/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("AC3: missing token_env errors with the env key name", () => {
		const dir = makeEnvDir([
			{ id: "A", token_env: "telegram_bot_alpha", persona_path: "personas/alpha.md" },
			{ id: "B", token_env: "no_such_token_key", persona_path: "personas/beta.md" },
		]);
		try {
			expect(() => loadConfig(dir)).toThrow(/no_such_token_key/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("AC3: routing probabilities summing over 1 error; ALL errors listed together", () => {
		const dir = makeEnvDir([
			{ id: "A", token_env: "telegram_bot_alpha", persona_path: "personas/alpha.md", routing_p: 0.9 },
			{ id: "B", token_env: "telegram_bot_beta", persona_path: "personas/beta.md", routing_p: 0.9 },
			{ id: "C", token_env: "telegram_bot_alpha", persona_path: "personas/does-not-exist.md", routing_p: "abc" },
		]);
		try {
			let err: ConfigError | null = null;
			try {
				loadConfig(dir);
			} catch (e) {
				err = e as ConfigError;
			}
			expect(err).toBeInstanceOf(ConfigError);
			const msg = err!.message;
			expect(msg).toContain("sum to <= 1");
			expect(msg).toContain("routing_p"); // per-bot value error
			expect(msg).toContain("personas/does-not-exist.md"); // unreadable persona
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("AC3: invalid bot id charset rejected", () => {
		const dir = makeEnvDir([
			{ id: "Bad ID!", token_env: "telegram_bot_alpha", persona_path: "personas/alpha.md" },
		]);
		try {
			expect(() => loadConfig(dir)).toThrow(/\[A-Za-z0-9_-\]/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("AC2: peer id forms normalize identically through config; send chat id stays correct", () => {
		for (const raw of [1234567890, -1234567890, -1001234567890, "1234567890"]) {
			expect(normalizePeerId(raw)).toBe(1234567890);
		}
		const dir = makeEnvDir(VALID_BOTS, {}, { group_peer_id: -1001234567890 });
		try {
			const config = loadConfig(dir);
			expect(config.groupPeerId).toBe(1234567890);
			expect(Number(`-100${config.groupPeerId}`)).toBe(-1001234567890);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("AC4: persona at an external absolute path resolves and loads", () => {
		const extDir = mkdtempSync(join(tmpdir(), "persona-ext-"));
		writeFileSync(join(extDir, "my-persona.md"), "# 外部人设\n\n仓库外绝对路径。");
		const dir = makeEnvDir([
			{ id: "A", token_env: "telegram_bot_alpha", persona_path: join(extDir, "my-persona.md"), routing_p: 1 },
		]);
		try {
			const config = loadConfig(dir);
			expect(config.bots[0]!.personaPath).toBe(join(extDir, "my-persona.md"));
			expect(existsSync(config.bots[0]!.personaPath)).toBe(true);
			// same text -> same provider-visible hash regardless of file location (determinism)
			const viaExternal = buildSystemPrompt(readFileSync(config.bots[0]!.personaPath, "utf8"));
			const viaExternal2 = buildSystemPrompt(readFileSync(config.bots[0]!.personaPath, "utf8"));
			expect(sha256Short(viaExternal)).toBe(sha256Short(viaExternal2));
			// the external persona is genuinely a different file from the repo persona
			const viaRepo = buildSystemPrompt(readFileSync("personas/template.zh.md", "utf8"));
			expect(sha256Short(viaExternal)).not.toBe(sha256Short(viaRepo));
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(extDir, { recursive: true, force: true });
		}
	});

	test("per-bot overrides and tool toggles apply", () => {
		const dir = makeEnvDir([
			{
				id: "A", token_env: "telegram_bot_alpha", persona_path: "personas/alpha.md",
				routing_p: 0.3, sampling_cooldown_ms: 0, provider: "deepseek", model: "custom-model", compaction_threshold: 999, tools: { search: false },
			},
		]);
		try {
			const config = loadConfig(dir);
			const a = config.bots[0]!;
			expect([a.provider, a.model]).toEqual(["deepseek", "custom-model"]);
			expect(a.routingP).toBe(0.3);
			expect(a.samplingCooldownMs).toBe(0);
			expect(a.model).toBe("custom-model");
			expect(a.compactionThreshold).toBe(999);
			expect(a.compactionKeepRecent).toBe(20000); // default
			expect(a.tools).toEqual({ send: true, search: false, runJs: false });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("PLAT-0002 R3: deployment and per-bot provider/model selection stays independent of project secrets", () => {
		const globalDir = makeEnvDir(VALID_BOTS, {}, {
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			api_key_env: "missing_legacy_key",
		});
		const mixedDir = makeEnvDir([
			{ ...VALID_BOTS[0], api_key_env: "missing_legacy_deepseek_key" },
			{
				...VALID_BOTS[1],
				provider: "anthropic",
				model: "claude-sonnet-4-6",
				api_key_env: "missing_legacy_anthropic_key",
			},
		]);
		try {
			const globalBots = loadConfig(globalDir).bots;
			expect(globalBots.map((bot) => [bot.provider, bot.model])).toEqual([
				["anthropic", "claude-sonnet-4-6"],
				["anthropic", "claude-sonnet-4-6"],
			]);
			const mixedBots = loadConfig(mixedDir).bots;
			expect(mixedBots.map((bot) => [bot.provider, bot.model])).toEqual([
				["deepseek", "deepseek-v4-flash"],
				["anthropic", "claude-sonnet-4-6"],
			]);
			expect(Object.keys(mixedBots[0]!)).not.toContain("apiKeyEnv");
			expect(Object.keys(mixedBots[0]!)).not.toContain("providerApiKey");
		} finally {
			rmSync(globalDir, { recursive: true, force: true });
			rmSync(mixedDir, { recursive: true, force: true });
		}
	});

	test("PLAT-0002 R3: provider overrides require a model but never a project auth env", () => {
		const missingShapeDir = makeEnvDir([{ ...VALID_BOTS[0], provider: "anthropic" }]);
		const ignoredSecretDir = makeEnvDir([
			{
				...VALID_BOTS[0],
				provider: "anthropic",
				model: "claude-sonnet-4-6",
				api_key_env: "definitely_not_in_env",
			},
		]);
		try {
			expect(() => loadConfig(missingShapeDir)).toThrow(/model/);
			expect(loadConfig(ignoredSecretDir).bots[0]).toMatchObject({
				provider: "anthropic",
				model: "claude-sonnet-4-6",
			});
		} finally {
			rmSync(missingShapeDir, { recursive: true, force: true });
			rmSync(ignoredSecretDir, { recursive: true, force: true });
		}
	});

	test("PLAT-0002 AC3: legacy provider key fields are accepted then discarded", () => {
		const dir = makeEnvDir(VALID_BOTS, {}, {
			deepseek_key_env: "missing_legacy_key",
			api_key_env: "also_missing",
		});
		try {
			const bots = loadConfig(dir).bots;
			expect(bots.map((bot) => bot.provider)).toEqual(["deepseek", "deepseek"]);
			expect(JSON.stringify(bots)).not.toContain("missing_legacy_key");
			expect(JSON.stringify(bots)).not.toContain("also_missing");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("PLAT-0002 AC2: Pi global/project settings resolve omitted model defaults and thinking", () => {
		const globalOnlyDir = makeEnvDir(VALID_BOTS, {}, {
			provider: undefined,
			model: undefined,
			reasoning_effort: undefined,
		});
		const projectOverrideDir = makeEnvDir(VALID_BOTS, {}, {
			provider: undefined,
			model: undefined,
			reasoning_effort: undefined,
		});
		const agentDir = mkdtempSync(join(tmpdir(), "pi-settings-agent-"));
		mkdirSync(join(projectOverrideDir, ".pi"));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
			defaultProvider: "deepseek",
			defaultModel: "deepseek-v4-flash",
			defaultThinkingLevel: "high",
		}));
		writeFileSync(join(projectOverrideDir, ".pi/settings.json"), JSON.stringify({
			defaultProvider: "openai-codex",
			defaultModel: "gpt-5.6-luna",
			defaultThinkingLevel: "low",
		}));
		try {
			const globalDefaults = loadPiModelDefaults(globalOnlyDir, agentDir);
			const projectDefaults = loadPiModelDefaults(projectOverrideDir, agentDir);
			expect(loadConfig(globalOnlyDir, { piModelDefaults: globalDefaults }).bots[0]).toMatchObject({
				provider: "deepseek",
				model: "deepseek-v4-flash",
				reasoningEffort: "off",
			});
			expect(loadConfig(projectOverrideDir, { piModelDefaults: projectDefaults }).bots[0]).toMatchObject({
				provider: "openai-codex",
				model: "gpt-5.6-luna",
				reasoningEffort: "off",
			});
		} finally {
			rmSync(globalOnlyDir, { recursive: true, force: true });
			rmSync(projectOverrideDir, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	test("PLAT-0002 AC2: missing or malformed Pi defaults fail with bounded guidance", () => {
		const missingDir = makeEnvDir(VALID_BOTS, {}, {
			provider: undefined,
			model: undefined,
			reasoning_effort: undefined,
		});
		const invalidAgentDir = mkdtempSync(join(tmpdir(), "pi-settings-invalid-"));
		writeFileSync(join(invalidAgentDir, "settings.json"), "{private-invalid-settings");
		try {
			expect(() => loadConfig(missingDir, {
				piModelDefaults: { provider: undefined, model: undefined, thinkingLevel: "medium" },
			})).toThrow(/Pi default provider\/model is missing[\s\S]*\/login[\s\S]*\/model/);
			try {
				loadPiModelDefaults(missingDir, invalidAgentDir);
				throw new Error("expected invalid settings to reject");
			} catch (error) {
				expect(error).toBeInstanceOf(PiSettingsConfigurationError);
				expect(String(error)).toContain("invalid_settings: global");
				expect(String(error)).not.toContain("private-invalid-settings");
				expect(String(error)).not.toContain(invalidAgentDir);
			}
		} finally {
			rmSync(missingDir, { recursive: true, force: true });
			rmSync(invalidAgentDir, { recursive: true, force: true });
		}
	});

	test("sampling cooldown defaults to 2000 ms, supports a global default, and rejects invalid values", () => {
		const defaultDir = makeEnvDir();
		const globalDir = makeEnvDir(VALID_BOTS, {}, { sampling_cooldown_ms: 2750 });
		const invalidDir = makeEnvDir(
			[
				{ ...VALID_BOTS[0], sampling_cooldown_ms: -1 },
				{ ...VALID_BOTS[1], sampling_cooldown_ms: "fast" },
			],
			{},
			{ sampling_cooldown_ms: -5 },
		);
		try {
			expect(loadConfig(defaultDir).bots.map((bot) => bot.samplingCooldownMs)).toEqual([2000, 2000]);
			expect(loadConfig(globalDir).bots.map((bot) => bot.samplingCooldownMs)).toEqual([2750, 2750]);
			expect(() => loadConfig(invalidDir)).toThrow(/sampling_cooldown_ms[\s\S]*sampling_cooldown_ms[\s\S]*sampling_cooldown_ms/);
		} finally {
			rmSync(defaultDir, { recursive: true, force: true });
			rmSync(globalDir, { recursive: true, force: true });
			rmSync(invalidDir, { recursive: true, force: true });
		}
	});

	test("Telegram admin allowlist is normalized, deduplicated, and deny-by-default", () => {
		const emptyDir = makeEnvDir();
		const validDir = makeEnvDir(VALID_BOTS, {}, { telegram_admins: [123456789, " @Alice_1 "] });
		const invalidDir = makeEnvDir(VALID_BOTS, {}, {
			telegram_admins: [0, -1, 1.5, "alice", "@x", "@Alice_1", "@alice_1", null],
		});
		try {
			expect(loadConfig(emptyDir).telegramAdmins).toEqual([]);
			expect(loadConfig(validDir).telegramAdmins).toEqual([123456789, "@alice_1"]);
			expect(() => loadConfig(invalidDir)).toThrow(/telegram_admins\[0\][\s\S]*telegram_admins\[7\]/);
			expect(() => loadConfig(invalidDir)).toThrow(/duplicate identity @alice_1/);
			expect(normalizeTelegramAdmin(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
		} finally {
			rmSync(emptyDir, { recursive: true, force: true });
			rmSync(validDir, { recursive: true, force: true });
			rmSync(invalidDir, { recursive: true, force: true });
		}
	});

});

describe(".env.example (REQ-OPS-0001 R1)", () => {
	test("example file is colon format and parses to expected keys", () => {
		const env = parseEnvFile(join(process.cwd(), ".env.example"));
		expect(env.telegram_bot_token).toBe("123456:REPLACE_WITH_BOTFATHER_TOKEN");
		expect(env.llm_api_key).toBeUndefined();
		expect(env.tinyfish_api_key).toBe("REPLACE_WITH_TINYFISH_KEY");
		expect(env.router_secret).toBe("REPLACE_WITH_RANDOM_LOCAL_SECRET");
		expect(env.auxiliary_visual_model).toBeUndefined();
		expect(Object.keys(env).sort()).toEqual([
			"gpg_key_passphrase",
			"router_secret",
			"telegram_bot_token",
			"tinyfish_api_key",
		]);
	});
});

describe("repo hygiene (REQ-OPS-0001 R3)", () => {
	test("deployment config, data, and private personas are git-ignored", () => {
		const r = Bun.spawnSync([
			"git", "check-ignore",
			"data/agent.db", "data/sessions", "bots.config.json", "telegram.config.ts", "personas/private-local.md",
		], { cwd: process.cwd() });
		expect(r.exitCode).toBe(0);
		const out = r.stdout.toString();
		expect(out).toContain("data/agent.db");
		expect(out).toContain("bots.config.json");
		expect(out).toContain("telegram.config.ts");
		expect(out).toContain("personas/private-local.md");
	});

	test("tracked examples and persona files are public-only", () => {
		const example = JSON.parse(readFileSync(join(process.cwd(), "bots.config.example.json"), "utf8")) as {
			telegram_admins?: unknown[];
		};
		expect(example.telegram_admins).toEqual([]);
		const tracked = Bun.spawnSync([
			"git", "ls-files", "--cached", "--others", "--exclude-standard", "personas",
		], { cwd: process.cwd() });
		expect(tracked.exitCode).toBe(0);
		expect(tracked.stdout.toString().trim().split("\n").sort()).toEqual([
			"personas/README.md",
			"personas/template.en.md",
			"personas/template.zh.md",
		]);
		for (const path of ["bots.config.example.json", "telegram.config.example.ts"]) {
			expect(readFileSync(join(process.cwd(), path), "utf8")).not.toMatch(/aac6fef|hastuyuki|kosamere|xiaoxue|xiaoyu/i);
		}
	});
});

describe("pid lock (REQ-OPS-0001 R4)", () => {
	test("acquire/release roundtrip; stale dead pid is taken over", () => {
		const dir = mkdtempSync(join(tmpdir(), "pidlock-"));
		try {
			const fd = acquirePidLock(dir);
			expect(readPid(join(dir, "daemon.pid"))).toBe(process.pid);
			releasePidLock(fd, dir);
			expect(existsSync(join(dir, "daemon.pid"))).toBe(false);

			// stale pid of a dead process: next acquire takes over cleanly
			writeFileSync(join(dir, "daemon.pid"), "99999999");
			const fd2 = acquirePidLock(dir);
			expect(readPid(join(dir, "daemon.pid"))).toBe(process.pid);
			releasePidLock(fd2, dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("release only removes the pid file still owned by the exiting daemon", () => {
		const dir = mkdtempSync(join(tmpdir(), "pidlock-owner-"));
		try {
			const fd = acquirePidLock(dir);
			writeFileSync(join(dir, "daemon.pid"), "99999999");
			releasePidLock(fd, dir);
			expect(readPid(join(dir, "daemon.pid"))).toBe(99999999);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("second acquire while a daemon-like process holds the lock exits with 'already running' and leaves the lock intact", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pidlock-"));
		try {
			const child = Bun.spawn(["bun", "run", FIXTURE_LOCK, dir], { stdout: "pipe", stderr: "pipe" });
			const t0 = Date.now();
			let locked = false;
			while (Date.now() - t0 < 5000) {
				const pid = readPid(join(dir, "daemon.pid"));
				if (pid != null && pidAlive(pid) && isOurDaemon(pid)) { locked = true; break; }
				await new Promise((r) => setTimeout(r, 50));
			}
			expect(locked).toBe(true);
			const holderPid = readPid(join(dir, "daemon.pid"))!;

			const second = Bun.spawnSync(["bun", "run", FIXTURE_LOCK, dir]);
			expect(second.exitCode).toBe(1);
			expect(second.stderr.toString()).toContain("already running");

			expect(readPid(join(dir, "daemon.pid"))).toBe(holderPid);
			child.kill("SIGTERM");
			await child.exited;
			expect(isOurDaemon(holderPid)).toBe(false); // dead now
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an alive but foreign pid is not our daemon (stop would refuse)", () => {
		expect(pidAlive(process.pid)).toBe(true);
		expect(isOurDaemon(process.pid)).toBe(false);
	});

	test("a shell command merely containing the daemon path is not enumerated as a daemon", async () => {
		const decoy = Bun.spawn(["sh", "-c", "sleep 5", "src/daemon/index.ts"], { stdout: "ignore", stderr: "ignore" });
		try {
			expect(pidAlive(decoy.pid)).toBe(true);
			expect(isOurDaemon(decoy.pid)).toBe(false);
			expect(listOurDaemons()).not.toContain(decoy.pid);
		} finally {
			decoy.kill("SIGTERM");
			await decoy.exited;
		}
	});
});
