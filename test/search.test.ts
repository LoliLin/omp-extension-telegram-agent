// REQ-AGENT-0001 R6 regression tests: search client timeout + response-size guard.
// Uses a local Bun.serve upstream — no external network.

import { describe, expect, test } from "bun:test";
import { tinyFishSearch } from "../src/tools/search.ts";

describe("tinyFishSearch guards", () => {
	test("AC5: hung upstream times out instead of wedging the turn", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
		try {
			const t0 = Date.now();
			await expect(tinyFishSearch("key", "q", { url: `http://127.0.0.1:${server.port}`, timeoutMs: 200 })).rejects.toThrow();
			expect(Date.now() - t0).toBeLessThan(5_000);
		} finally {
			server.stop(true);
		}
	});

	test("oversized response body is rejected", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response("x".repeat(300 * 1024), { headers: { "content-type": "application/json" } }),
		});
		try {
			await expect(tinyFishSearch("key", "q", { url: `http://127.0.0.1:${server.port}` })).rejects.toThrow(/too large/);
		} finally {
			server.stop(true);
		}
	});

	test("normal response still parses", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () =>
				Response.json({ results: [{ title: "t", url: "https://example.com", snippet: "s" }] }),
		});
		try {
			const hits = await tinyFishSearch("key", "q", { url: `http://127.0.0.1:${server.port}` });
			expect(hits).toEqual([{ title: "t", url: "https://example.com", snippet: "s" }]);
		} finally {
			server.stop(true);
		}
	});
});
