// REQ-CONF-0001 + REQ-OPS-0001 regression tests: bots.config.json schema validation,
// arbitrary bot counts, peer id normalization, pid lock exclusivity, example-file sanity.
// The lock test spawns a fixture process whose cmdline matches our daemon check;
// no real daemon or network is involved.

import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseEnvFile, normalizePeerId, normalizeTelegramAdmin, ConfigError } from "../src/config.ts";
import { acquirePidLock, releasePidLock, readPid, pidAlive, isOurDaemon, listOurDaemons } from "../src/daemon/pid.ts";
import { buildSystemPrompt, sha256Short } from "../src/agent/prompt.ts";

const FIXTURE_LOCK = join(import.meta.dir, "fixtures/daemon/index.ts");

// Bun auto-loads the project .env into process.env, and loadConfig lets process.env override
// the parsed file — tests must clear the real keys so the temp .env is authoritative.
const ENV_KEYS = [
	"teleram_hastuyuki_bot", "telegram_kosamerobot", "telegram_group_peer_id",
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
	{ id: "A", name: "小雪", token_env: "teleram_hastuyuki_bot", persona_path: "personas/xiaoxue.md", routing_p: 0.08 },
	{ id: "B", name: "小雨", token_env: "telegram_kosamerobot", persona_path: "personas/xiaoyu.md", routing_p: 0.08 },
];

function makeEnvDir(bots: unknown = VALID_BOTS, extraEnv: Record<string, string> = {}, extraConfig: Record<string, unknown> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "conf-test-"));
	const lines = [
		"teleram_hastuyuki_bot: 123:AAA",
		"telegram_kosamerobot: 456:BBB",
		"deepseek_api_key: sk-test",
		"tiny_fish_api_key: tf-test",
		...Object.entries(extraEnv).map(([k, v]) => `${k}: ${v}`),
	];
	writeFileSync(join(dir, ".env"), lines.join("\n"));
	writeFileSync(
		join(dir, "bots.config.json"),
		JSON.stringify({
			group_peer_id: 4402809405,
			...extraConfig,
			bots,
		}),
	);
	// persona files referenced by the default VALID_BOTS must exist under the temp dir
	mkdirSync(join(dir, "personas"), { recursive: true });
	writeFileSync(join(dir, "personas/xiaoxue.md"), "# 小雪\n\n小雪人设。");
	writeFileSync(join(dir, "personas/xiaoyu.md"), "# 小雨\n\n小雨人设。");
	return dir;
}

describe("loadConfig / bots.config.json (REQ-CONF-0001)", () => {
	test("AC5: single-bot and three-bot configs load", () => {
		for (const bots of [
			[{ id: "solo", token_env: "teleram_hastuyuki_bot", persona_path: "personas/xiaoxue.md", routing_p: 0.5 }],
			[
				{ id: "A", token_env: "teleram_hastuyuki_bot", persona_path: "personas/xiaoxue.md", routing_p: 0.1 },
				{ id: "B", token_env: "telegram_kosamerobot", persona_path: "personas/xiaoyu.md", routing_p: 0.1 },
				{ id: "C", token_env: "teleram_hastuyuki_bot", persona_path: "personas/xiaoyu.md", routing_p: 0.1 },
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
			{ id: "A", token_env: "teleram_hastuyuki_bot", persona_path: "personas/xiaoxue.md" },
			{ id: "A", token_env: "telegram_kosamerobot", persona_path: "personas/xiaoyu.md" },
		]);
		try {
			expect(() => loadConfig(dir)).toThrow(/duplicate bot id "A"/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("AC3: missing token_env errors with the env key name", () => {
		const dir = makeEnvDir([
			{ id: "A", token_env: "teleram_hastuyuki_bot", persona_path: "personas/xiaoxue.md" },
			{ id: "B", token_env: "no_such_token_key", persona_path: "personas/xiaoyu.md" },
		]);
		try {
			expect(() => loadConfig(dir)).toThrow(/no_such_token_key/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("AC3: routing probabilities summing over 1 error; ALL errors listed together", () => {
		const dir = makeEnvDir([
			{ id: "A", token_env: "teleram_hastuyuki_bot", persona_path: "personas/xiaoxue.md", routing_p: 0.9 },
			{ id: "B", token_env: "telegram_kosamerobot", persona_path: "personas/xiaoyu.md", routing_p: 0.9 },
			{ id: "C", token_env: "teleram_hastuyuki_bot", persona_path: "personas/does-not-exist.md", routing_p: "abc" },
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
			{ id: "Bad ID!", token_env: "teleram_hastuyuki_bot", persona_path: "personas/xiaoxue.md" },
		]);
		try {
			expect(() => loadConfig(dir)).toThrow(/\[A-Za-z0-9_-\]/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("AC2: peer id forms normalize identically through config; send chat id stays correct", () => {
		for (const raw of [4402809405, -4402809405, -1004402809405, "4402809405"]) {
			expect(normalizePeerId(raw)).toBe(4402809405);
		}
		const dir = makeEnvDir(VALID_BOTS, {}, { group_peer_id: -1004402809405 });
		try {
			const config = loadConfig(dir);
			expect(config.groupPeerId).toBe(4402809405);
			expect(Number(`-100${config.groupPeerId}`)).toBe(-1004402809405);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("AC4: persona at an external absolute path resolves and loads", () => {
		const extDir = mkdtempSync(join(tmpdir(), "persona-ext-"));
		writeFileSync(join(extDir, "my-persona.md"), "# 外部人设\n\n仓库外绝对路径。");
		const dir = makeEnvDir([
			{ id: "A", token_env: "teleram_hastuyuki_bot", persona_path: join(extDir, "my-persona.md"), routing_p: 1 },
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
			const viaRepo = buildSystemPrompt(readFileSync("personas/xiaoxue.md", "utf8"));
			expect(sha256Short(viaExternal)).not.toBe(sha256Short(viaRepo));
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(extDir, { recursive: true, force: true });
		}
	});

	test("per-bot overrides and tool toggles apply", () => {
		const dir = makeEnvDir([
			{
				id: "A", token_env: "teleram_hastuyuki_bot", persona_path: "personas/xiaoxue.md",
				routing_p: 0.3, sampling_cooldown_ms: 0, model: "custom-model", compaction_threshold: 999, tools: { search: false },
			},
		]);
		try {
			const config = loadConfig(dir);
			const a = config.bots[0]!;
			expect([a.provider, a.model, a.apiKeyEnv, a.providerApiKey]).toEqual([
				"deepseek", "custom-model", "deepseek_api_key", "sk-test",
			]);
			expect(a.routingP).toBe(0.3);
			expect(a.samplingCooldownMs).toBe(0);
			expect(a.model).toBe("custom-model");
			expect(a.compactionThreshold).toBe(999);
			expect(a.compactionKeepRecent).toBe(20000); // default
			expect(a.tools).toEqual({ send: true, search: false, runJs: true });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("PLAT AC5: deployment and per-bot provider/model/auth env resolve independently", () => {
		const globalDir = makeEnvDir(VALID_BOTS, { anthropic_api_key: "sk-ant-test" }, {
			provider: "anthropic",
			model: "claude-sonnet-4-6",
			api_key_env: "anthropic_api_key",
		});
		const mixedDir = makeEnvDir([
			{ ...VALID_BOTS[0], api_key_env: "alternate_deepseek_key" },
			{
				...VALID_BOTS[1],
				provider: "anthropic",
				model: "claude-sonnet-4-6",
				api_key_env: "anthropic_api_key",
			},
		], { anthropic_api_key: "sk-ant-test", alternate_deepseek_key: "sk-ds-alt" });
		try {
			const globalBots = loadConfig(globalDir).bots;
			expect(globalBots.map((bot) => [bot.provider, bot.model, bot.apiKeyEnv, bot.providerApiKey])).toEqual([
				["anthropic", "claude-sonnet-4-6", "anthropic_api_key", "sk-ant-test"],
				["anthropic", "claude-sonnet-4-6", "anthropic_api_key", "sk-ant-test"],
			]);
			const mixedBots = loadConfig(mixedDir).bots;
			expect(mixedBots.map((bot) => [bot.provider, bot.model, bot.apiKeyEnv, bot.providerApiKey])).toEqual([
				["deepseek", "deepseek-v4-flash", "alternate_deepseek_key", "sk-ds-alt"],
				["anthropic", "claude-sonnet-4-6", "anthropic_api_key", "sk-ant-test"],
			]);
		} finally {
			rmSync(globalDir, { recursive: true, force: true });
			rmSync(mixedDir, { recursive: true, force: true });
		}
	});

	test("PLAT R2: provider overrides require explicit model/auth env and missing secrets fail closed", () => {
		const missingShapeDir = makeEnvDir([{ ...VALID_BOTS[0], provider: "anthropic" }]);
		const missingSecretDir = makeEnvDir([
			{
				...VALID_BOTS[0],
				provider: "anthropic",
				model: "claude-sonnet-4-6",
				api_key_env: "anthropic_api_key",
			},
		]);
		try {
			expect(() => loadConfig(missingShapeDir)).toThrow(/api_key_env[\s\S]*model/);
			expect(() => loadConfig(missingSecretDir)).toThrow(/anthropic_api_key.*empty or missing/);
		} finally {
			rmSync(missingShapeDir, { recursive: true, force: true });
			rmSync(missingSecretDir, { recursive: true, force: true });
		}
	});

	test("PLAT R8: deepseek_key_env remains a zero-migration alias", () => {
		const dir = makeEnvDir(VALID_BOTS, { alternate_deepseek_key: "sk-legacy" }, {
			deepseek_key_env: "alternate_deepseek_key",
		});
		try {
			expect(loadConfig(dir).bots.map((bot) => [bot.provider, bot.apiKeyEnv, bot.providerApiKey])).toEqual([
				["deepseek", "alternate_deepseek_key", "sk-legacy"],
				["deepseek", "alternate_deepseek_key", "sk-legacy"],
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
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

	test("AC1: the real project config (example replica) loads against the real .env", () => {
		// project root has bots.config.json + .env + personas/ — the migration replica must
		// parse cleanly end to end (persona files exist, env keys present)
		const config = loadConfig(process.cwd());
		expect(config.bots.length).toBeGreaterThanOrEqual(2);
		for (const b of config.bots) {
			expect(existsSync(b.personaPath)).toBe(true);
			expect(b.token.length).toBeGreaterThan(0);
		}
		expect(config.telegramAdmins).toEqual(["@aac6fef"]);
	});
});

describe(".env.example (REQ-OPS-0001 R1)", () => {
	test("example file is colon format and parses to expected keys", () => {
		const env = parseEnvFile(join(process.cwd(), ".env.example"));
		expect(env.teleram_hastuyuki_bot).toBe("123456:AAA...");
		expect(env.deepseek_api_key).toBe("sk-...");
		expect(env.router_secret).toBe("...");
		expect(Object.keys(env).length).toBeGreaterThanOrEqual(6);
	});
});

describe("repo hygiene (REQ-OPS-0001 R3)", () => {
	test("data/ and bots.config.json are git-ignored", () => {
		const r = Bun.spawnSync(["git", "check-ignore", "data/agent.db", "data/sessions", "bots.config.json"], { cwd: process.cwd() });
		expect(r.exitCode).toBe(0);
		const out = r.stdout.toString();
		expect(out).toContain("data/agent.db");
		expect(out).toContain("bots.config.json");
	});

	test("tracked config example uses only a non-private numeric admin placeholder", () => {
		const example = JSON.parse(readFileSync(join(process.cwd(), "bots.config.example.json"), "utf8")) as {
			telegram_admins?: unknown[];
		};
		expect(example.telegram_admins).toEqual([123456789]);
		expect(readFileSync(join(process.cwd(), "bots.config.example.json"), "utf8")).not.toContain("aac6fef");
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
