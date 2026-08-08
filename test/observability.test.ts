import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	formatLogRecord,
	log,
	MAX_LOG_FIELDS,
	MAX_LOG_LINE_BYTES,
	readStructuredLogTail,
	rotateLogFile,
	setLogSink,
} from "../src/observability/log.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true }));
});

describe("structured local observability (REQ-OBS-0001)", () => {
	test("daemon production modules do not bypass the structured logger", () => {
		const sourceRoot = join(import.meta.dir, "../src");
		const files: string[] = [];
		const walk = (dir: string) => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) walk(path);
				else if (entry.name.endsWith(".ts")) files.push(path);
			}
		};
		for (const area of ["daemon", "telegram", "media"]) walk(join(sourceRoot, area));
		files.push(join(sourceRoot, "agent/runtime.ts"));
		const offenders = files.filter((path) => /console\.(?:log|warn|error)\s*\(/.test(readFileSync(path, "utf8")));
		expect(offenders).toEqual([]);
	});

	test("JSONL envelope is stable, bounded, flat, and redacts content-shaped input", () => {
		const secret = "123456789:AAAbbbbbbbbbbbbbbbbbbbb";
		const fields = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field_${index}`, index]));
		const line = formatLogRecord("warn", "Agent Runtime", "Reply rejected", {
			...fields,
			api_key: "sk-secretsecret",
			detail: `bad\u0007 ${secret} https://example.com/private?q=secret /Users/name/private/file`,
			nested: { content: "must not serialize" },
			error: new Error("stack and secret must not serialize"),
		}, new Date("2026-08-09T00:00:00.000Z"));
		const parsed = JSON.parse(line) as Record<string, any>;

		expect(line.endsWith("\n")).toBe(true);
		expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_LOG_LINE_BYTES + 1);
		expect(parsed).toMatchObject({ schema: 1, level: "warn", component: "agent_runtime", event: "reply_rejected" });
		expect(Object.keys(parsed.fields).length).toBeLessThanOrEqual(MAX_LOG_FIELDS);
		expect(line).not.toContain(secret);
		expect(line).not.toContain("sk-secretsecret");
		expect(line).not.toContain("example.com");
		expect(line).not.toContain("/Users/name");
		expect(line).not.toContain("must not serialize");
		expect(line).not.toContain("stack and secret");
	});

	test("sink failures never escape into business code", () => {
		const restore = setLogSink(() => { throw new Error("disk full"); });
		try {
			expect(() => log.error("daemon", "sink_failed", { category: "io" })).not.toThrow();
		} finally {
			restore();
		}
	});

	test("rotation is bounded, ordered, and private", () => {
		const root = join(tmpdir(), `observability-${process.pid}-${Date.now()}`);
		roots.push(root);
		mkdirSync(root, { recursive: true });
		const path = join(root, "daemon.log");
		for (let generation = 0; generation < 5; generation++) {
			writeFileSync(path, `${generation}`.repeat(16), { mode: 0o644 });
			rotateLogFile(path, 8, 3);
		}
		expect(readFileSync(`${path}.1`, "utf8")).toBe("4".repeat(16));
		expect(readFileSync(`${path}.2`, "utf8")).toBe("3".repeat(16));
		expect(readFileSync(`${path}.3`, "utf8")).toBe("2".repeat(16));
		expect(() => statSync(`${path}.4`)).toThrow();
		for (const generation of [1, 2, 3]) expect(statSync(`${path}.${generation}`).mode & 0o777).toBe(0o600);
	});

	test("tail reader accepts bounded current-schema JSON and ignores legacy/malformed lines", () => {
		const root = join(tmpdir(), `observability-tail-${process.pid}-${Date.now()}`);
		roots.push(root);
		mkdirSync(root, { recursive: true });
		const path = join(root, "daemon.log");
		writeFileSync(path, `legacy line\n${formatLogRecord("info", "daemon", "ready", { pid: 1 })}{bad}\n`);
		chmodSync(path, 0o600);
		expect(readStructuredLogTail(path)).toEqual([expect.objectContaining({ component: "daemon", event: "ready" })]);
	});
});
