import { describe, expect, test } from "bun:test";
import { selectConfiguredBot } from "../scripts/bot-selection.ts";

const bots = [
	{ id: "A", name: "Alpha" },
	{ id: "B", name: "Beta" },
	{ id: "C", name: "Gamma" },
];

describe("script --bot selection (REQ-PLAT-0001)", () => {
	test("AC3: --bot C and --bot=C select the configured third bot", () => {
		expect(selectConfiguredBot(bots, ["--bot", "C"])).toBe(bots[2]);
		expect(selectConfiguredBot(bots, ["--bot=C"])).toBe(bots[2]);
	});

	test("missing and unknown ids fail fast with every valid id", () => {
		for (const args of [[], ["--bot", "unknown"]]) {
			expect(() => selectConfiguredBot(bots, args)).toThrow(/valid bot ids: A, B, C/);
		}
	});

	test("malformed, duplicate, and unrelated options are rejected without guessing", () => {
		expect(() => selectConfiguredBot(bots, ["--bot"])).toThrow(/requires an id/);
		expect(() => selectConfiguredBot(bots, ["--bot", "A", "--bot", "B"])).toThrow(/only once/);
		expect(() => selectConfiguredBot(bots, ["--model", "x"])).toThrow(/unknown argument/);
	});
});
