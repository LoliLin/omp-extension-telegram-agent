// REQ-OPS-0001 regression tests: config validation (all errors listed, peer id
// normalization), .env.example format, data/ gitignore, pid lock exclusivity.
// The lock exclusivity test spawns a fixture process whose cmdline matches our daemon
// check; no real daemon or network is involved.

import { describe, expect, test, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseEnvFile, normalizePeerId, ConfigError } from "../src/config.ts";
import { acquirePidLock, releasePidLock, readPid, pidAlive, isOurDaemon } from "../src/daemon/pid.ts";

const FIXTURE_LOCK = join(import.meta.dir, "fixtures/daemon/index.ts");

// Bun auto-loads the project .env into process.env, and loadConfig lets process.env override
// the parsed file — tests must clear the real keys so the temp .env is authoritative.
const ENV_KEYS = [
	"teleram_hastuyuki_bot", "telegram_kosamerobot", "telegram_group_peer_id",
	"deepseek_api_key", "deepseek_model", "deepseek_reasoning_effort",
	"tiny_fish_api_key", "auxiliary_visual_model", "router_secret",
	"routing_p_a", "routing_p_b", "compaction_threshold", "compaction_keep_recent",
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

function makeEnvDir(extra: Record<string, string> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "ops-test-"));
	const lines = [
		"teleram_hastuyuki_bot: 123:AAA",
		"telegram_kosamerobot: 456:BBB",
		"telegram_group_peer_id: 4402809405",
		"deepseek_api_key: sk-test",
		"tiny_fish_api_key: tf-test",
		...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
	];
	writeFileSync(join(dir, ".env"), lines.join("\n"));
	return dir;
}

describe("loadConfig validation (R2)", () => {
	test("AC2: numeric value that is not a number errors naming the key", () => {
		const dir = makeEnvDir({ routing_p_a: "abc" });
		try {
			expect(() => loadConfig(dir)).toThrow(/routing_p_a/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("AC2: routing probabilities summing over 1 error", () => {
		const dir = makeEnvDir({ routing_p_a: "0.9", routing_p_b: "0.9" });
		try {
			expect(() => loadConfig(dir)).toThrow(/sum to <= 1/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("AC2: non-positive compaction threshold errors", () => {
		const dir = makeEnvDir({ compaction_threshold: "-5" });
		try {
			expect(() => loadConfig(dir)).toThrow(/compaction_threshold/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("AC2: ALL errors are listed together, not first-only", () => {
		const dir = makeEnvDir({
			routing_p_a: "abc",
			routing_p_b: "oops",
			telegram_group_peer_id: "not-a-number",
			compaction_keep_recent: "0",
		});
		try {
			let err: ConfigError | null = null;
			try {
				loadConfig(dir);
			} catch (e) {
				err = e as ConfigError;
			}
			expect(err).toBeInstanceOf(ConfigError);
			const msg = err!.message;
			for (const key of ["routing_p_a", "routing_p_b", "telegram_group_peer_id", "compaction_keep_recent"]) {
				expect(msg).toContain(key);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("AC2: peer id forms -100..., -..., bare all normalize to the same value", () => {
		expect(normalizePeerId("4402809405")).toBe(4402809405);
		expect(normalizePeerId("-4402809405")).toBe(4402809405);
		expect(normalizePeerId("-1004402809405")).toBe(4402809405);
		expect(normalizePeerId("1004402809405")).toBe(4402809405); // full form without minus
		expect(normalizePeerId("abc")).toBeNaN();
		// a bare peer id genuinely starting with "100" is not corrupted
		expect(normalizePeerId("10044028094")).toBe(10044028094);
	});

	test("AC2: normalized peer id flows into config; send chat id stays correct", () => {
		const dir = makeEnvDir({ telegram_group_peer_id: "-1004402809405" });
		try {
			const config = loadConfig(dir);
			expect(config.groupPeerId).toBe(4402809405);
			expect(Number(`-100${config.groupPeerId}`)).toBe(-1004402809405);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("valid config loads with defaults", () => {
		const dir = makeEnvDir();
		try {
			const config = loadConfig(dir);
			expect(config.routingPA).toBe(0.08);
			expect(config.compactionThreshold).toBe(128000);
			expect(config.bots.length).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe(".env.example (R1)", () => {
	test("AC1: example file is colon format and parses to expected keys", () => {
		const env = parseEnvFile(join(process.cwd(), ".env.example"));
		expect(env.teleram_hastuyuki_bot).toBe("123456:AAA...");
		expect(env.telegram_group_peer_id).toBe("4402809405");
		expect(env.deepseek_api_key).toBe("sk-...");
		expect(Object.keys(env).length).toBeGreaterThanOrEqual(10);
	});
});

describe("repo hygiene (R3)", () => {
	test("AC3: data/ contents are git-ignored", () => {
		const r = Bun.spawnSync(["git", "check-ignore", "data/agent.db", "data/sessions", "data/media"], { cwd: process.cwd() });
		expect(r.exitCode).toBe(0);
		const out = r.stdout.toString();
		expect(out).toContain("data/agent.db");
		expect(out).toContain("data/sessions");
		expect(out).toContain("data/media");
	});
});

describe("pid lock (R4)", () => {
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

	test("AC4: second acquire while a daemon-like process holds the lock exits with 'already running' and leaves the lock intact", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pidlock-"));
		try {
			// child holds the lock; its cmdline matches the daemon check
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

			// second acquire attempt from another process must fail loudly, not take over
			const second = Bun.spawnSync(["bun", "run", FIXTURE_LOCK, dir]);
			expect(second.exitCode).toBe(1);
			expect(second.stderr.toString()).toContain("already running");

			// lock intact, original holder still owns it
			expect(readPid(join(dir, "daemon.pid"))).toBe(holderPid);
			child.kill("SIGTERM");
			await child.exited;
			expect(isOurDaemon(holderPid)).toBe(false); // dead now
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("AC5: an alive but foreign pid is not our daemon (stop would refuse)", async () => {
		// our own test process is alive but its cmdline is not the daemon
		expect(pidAlive(process.pid)).toBe(true);
		expect(isOurDaemon(process.pid)).toBe(false);
	});
});
