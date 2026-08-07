// REQ-UI-0004: the pi extension registers /tg commands and validates bot ids.
// Uses a fake ExtensionAPI (no pi process needed); engine behavior is covered by
// test/tg-engine.test.ts over a real IPC socket.

import { describe, expect, test } from "bun:test";
import extensionFactory from "../.pi/extensions/tg-extension.ts";

interface FakeAPI {
	commands: { name: string; description?: string; handler: (args: string | undefined, ctx: unknown) => Promise<void> }[];
	notifies: { text: string; level: string }[];
	widgets: Map<string, unknown>;
}

function makeFake(): { api: FakeAPI; ctx: Record<string, unknown> } {
	const api: FakeAPI = { commands: [], notifies: [], widgets: new Map() };
	const ctx = {
		mode: "tui",
		ui: {
			notify: (text: string, level: string) => api.notifies.push({ text, level }),
			custom: async () => undefined,
			setWidget: (id: string, w: unknown) => {
				if (w === undefined) api.widgets.delete(id);
				else api.widgets.set(id, w);
			},
		},
	};
	return { api, ctx };
}

describe("tg pi extension (REQ-UI-0004)", () => {
	test("registers the /tg command", () => {
		const { api, ctx } = makeFake();
		extensionFactory({
			registerCommand: (name: string, def: unknown) => api.commands.push({ name, ...(def as object) } as FakeAPI["commands"][number]),
		} as never);
		expect(api.commands.map((c) => c.name)).toContain("tg");
		expect(api.commands[0]!.description).toContain("attach");
		void ctx;
	});
	test("invalid bot id notifies with the configured bot list", async () => {
		const { api, ctx } = makeFake();
		extensionFactory({ registerCommand: (name: string, def: { handler: (a: string | undefined, c: unknown) => Promise<void> }) => api.commands.push({ name, handler: def.handler }) } as never);
		const cmd = api.commands.find((c) => c.name === "tg")!;
		await cmd.handler("attach nobody", ctx);
		const err = api.notifies.find((n) => n.level === "error");
		expect(err).toBeDefined();
		expect(err!.text).toContain("unknown bot id");
		expect(err!.text).toContain("configured bots");
	});

	test("attach with no daemon resolves as a command (view shows disconnected, no crash)", async () => {
		const { api, ctx } = makeFake();
		extensionFactory({ registerCommand: (name: string, def: { handler: (a: string | undefined, c: unknown) => Promise<void> }) => api.commands.push({ name, handler: def.handler }) } as never);
		const cmd = api.commands.find((c) => c.name === "tg")!;
		await cmd.handler("attach", ctx); // fake custom resolves immediately
		expect(api.notifies.length).toBe(0); // no error for a valid global attach
	});

	test("panel registers a widget; panel off clears it", async () => {
		const { api, ctx } = makeFake();
		extensionFactory({ registerCommand: (name: string, def: { handler: (a: string | undefined, c: unknown) => Promise<void> }) => api.commands.push({ name, handler: def.handler }) } as never);
		const cmd = api.commands.find((c) => c.name === "tg")!;
		await cmd.handler("panel A", ctx);
		expect(api.widgets.has("tg-panel")).toBe(true);
		expect(api.notifies.some((n) => n.text.includes("常驻遥测"))).toBe(true);
		await cmd.handler("panel off", ctx);
		expect(api.widgets.has("tg-panel")).toBe(false);
	});

	test("usage help is notified for unknown subcommands", async () => {
		const { api, ctx } = makeFake();
		extensionFactory({ registerCommand: (name: string, def: { handler: (a: string | undefined, c: unknown) => Promise<void> }) => api.commands.push({ name, handler: def.handler }) } as never);
		const cmd = api.commands.find((c) => c.name === "tg")!;
		await cmd.handler("frobnicate", ctx);
		expect(api.notifies.some((n) => n.text.includes("usage: /tg"))).toBe(true);
	});
});
