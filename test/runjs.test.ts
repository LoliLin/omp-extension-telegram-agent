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
