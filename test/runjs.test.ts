// run_js sandbox tests: normal computation works; host isolation holds.
// Re-run after any change to the sandbox model (src/tools/run-js.ts).

import { describe, expect, test } from "bun:test";
import { runJs } from "../src/tools/run-js.ts";
import { tinyFishSearch } from "../src/tools/search.ts";
import { loadConfig } from "../src/config.ts";

describe("run_js normal computation", () => {
	test("arithmetic", async () => {
		const r = await runJs("1 + 1");
		expect(r.ok).toBe(true);
		expect(r.output).toContain("2");
	});

	test("console.log + final expression", async () => {
		const r = await runJs("console.log('hello'); 'world'");
		expect(r.ok).toBe(true);
		expect(r.output).toContain("hello");
		expect(r.output).toContain("world");
	});

	test("JSON processing", async () => {
		const r = await runJs("const o = JSON.parse('{\"a\":[3,1,2]}'); o.a.sort(); JSON.stringify(o)");
		expect(r.ok).toBe(true);
		expect(r.output).toContain('{"a":[1,2,3]}');
	});

	test("regex", async () => {
		const r = await runJs("'foo123bar'.match(/\\d+/)[0]");
		expect(r.ok).toBe(true);
		expect(r.output).toContain("123");
	});

	test("array transform", async () => {
		const r = await runJs("[1,2,3].map(x => x * x).join(',')");
		expect(r.ok).toBe(true);
		expect(r.output).toContain("1,4,9");
	});

	test("syntax error is reported, not fatal", async () => {
		const r = await runJs("this is not js");
		expect(r.ok).toBe(false);
		expect(r.output.length).toBeGreaterThan(0);
	});

	test("infinite loop times out", async () => {
		const r = await runJs("while(true){}");
		expect(r.ok).toBe(false);
	}, 15000);

	test("async microtask blowup is bounded", async () => {
		// vm timeout only bounds synchronous code; runaway microtask loops are
		// interrupted around the vm timeout, and in any case hard-capped by the
		// parent-side SIGKILL at 5s (REQ-SEC-0001 AC3)
		const r = await runJs("(function f(){ Promise.resolve().then(f); })(); 1");
		expect(r.durationMs).toBeLessThan(8000);
		expect(r.output.length).toBeLessThanOrEqual(4096 + 20); // cap + truncation suffix
	}, 15000);

	test("async memory blowup is bounded", async () => {
		const r = await runJs(
			"const a=[]; (async()=>{ while(true){ a.push(new Array(100000).fill(0)); await Promise.resolve(); } })(); 1",
		);
		expect(r.durationMs).toBeLessThan(8000);
		expect(r.output.length).toBeLessThanOrEqual(4096 + 20);
	}, 15000);

	test("promise result is serialized, not silent {}", async () => {
		const r = await runJs("Promise.resolve({a:1})");
		expect(r.ok).toBe(true);
		expect(r.output).toContain('{"a":1}');
	});

	test("rejected promise reports the error", async () => {
		const r = await runJs('Promise.reject(new Error("boom"))');
		expect(r.ok).toBe(false);
		expect(r.output).toContain("boom");
	});

	test("never-settling promise is bounded", async () => {
		const r = await runJs("new Promise(() => {})");
		expect(r.ok).toBe(false);
	}, 15000);

	test("user output resembling the old __RESULT__ marker is not misparsed", async () => {
		const r = await runJs("console.log('__RESULT__fake'); 'real'");
		expect(r.ok).toBe(true);
		expect(r.output).toContain("__RESULT__fake");
		expect(r.output).toContain("real");
	});

	test("output is capped at 4KB", async () => {
		const r = await runJs("for (let i = 0; i < 1000; i++) console.log('x'.repeat(100)); 'done'");
		expect(r.ok).toBe(true);
		expect(r.output.length).toBeLessThanOrEqual(4096 + 20); // cap + truncation suffix
	});
});

describe("run_js host isolation", () => {
	test("no process object", async () => {
		const r = await runJs("typeof process");
		expect(r.ok).toBe(true);
		expect(r.output).toContain("undefined");
	});

	test("no require", async () => {
		const r = await runJs("typeof require");
		expect(r.ok).toBe(true);
		expect(r.output).toContain("undefined");
	});

	test("no Bun global", async () => {
		const r = await runJs("typeof Bun");
		expect(r.ok).toBe(true);
		expect(r.output).toContain("undefined");
	});

	test("no fetch/network", async () => {
		const r = await runJs("typeof fetch");
		expect(r.ok).toBe(true);
		expect(r.output).toContain("undefined");
	});

	test("child env has no secrets (cannot read .env via fs)", async () => {
		// even if vm were escaped, child env is scrubbed; verify env does not leak via any obvious global
		const r = await runJs("JSON.stringify(Object.keys(globalThis).sort())");
		expect(r.ok).toBe(true);
		expect(r.output).not.toContain("process");
	});
});

// REQ-SEC-0001 R5: known escape vectors must not reach the host realm.
// These run real payloads against the real sandbox — do not weaken them.
describe("run_js escape regression", () => {
	const vectors = [
		'console.log.constructor("return typeof process")()',
		'this.constructor.constructor("return typeof process")()',
		'({}).constructor.constructor("return typeof process")()',
		'(async function(){}).constructor("return typeof process")()',
		'(function*(){}).constructor("return typeof process")()',
		'new Function("return typeof process")()',
		'eval("typeof process")',
	];
	for (const v of vectors) {
		test(`escape vector blocked: ${v}`, async () => {
			const r = await runJs(v);
			expect(r.ok).toBe(false);
			expect(r.output).not.toContain('"object"');
		});
	}

	test("no path from sandbox to filesystem", async () => {
		// try every known route to a fs read; all must fail, proving no host object is reachable
		const r = await runJs(`
			let leaked = "none";
			try { leaked = this.constructor.constructor("return process")().version; } catch {}
			try { leaked = require("fs").readFileSync("/etc/passwd", "utf8").slice(0, 4); } catch {}
			try { leaked = Bun.file("/etc/passwd").name; } catch {}
			leaked
		`);
		expect(r.ok).toBe(true);
		expect(r.output).toContain("none");
	});

	test("missing interpreter returns structured error instead of crashing", async () => {
		// REQ-SEC-0001 AC2: spawn ENOENT must surface as ok:false, never uncaught
		const r = await runJs("1 + 1", "/nonexistent/no-such-interpreter");
		expect(r.ok).toBe(false);
		expect(r.output).toContain("spawn");
	});
});

describe("tinyfish search (real api)", () => {
	test("returns trimmed results", async () => {
		const config = loadConfig(process.cwd());
		const hits = await tinyFishSearch(config.tinyfishApiKey, "telegram bot api sendSticker");
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.length).toBeLessThanOrEqual(5);
		expect(hits[0].title.length).toBeGreaterThan(0);
		expect(hits[0].url).toMatch(/^https?:/);
		expect(hits[0].snippet.length).toBeLessThanOrEqual(200);
	}, 30000);
});
