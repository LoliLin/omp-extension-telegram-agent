process.env.TZ = "Asia/Singapore";

import { describe, expect, test } from "bun:test";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import {
	itemComponent,
	registerTelegramExtension,
	supportsPiVersion,
	TelegramFeed,
	type TelegramExtensionOptions,
} from "../.pi/extensions/tg-extension.ts";
import type { BotStats, TimelineItem } from "../src/ipc.ts";
import type { TimelineEvent, TimelineHooks, TimelinePort } from "../src/plugin/timeline.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

class FakeTimeline implements TimelinePort {
	isConnected = false;
	hasMore = true;
	isLoadingOlder = false;
	disposed = false;
	moreRequests = 0;

	constructor(readonly filter: string | null, private readonly hooks: TimelineHooks) {}

	async connect(): Promise<boolean> {
		this.isConnected = true;
		this.emit({ type: "status", text: this.filter ? `connected · bot ${this.filter}` : "connected · all bots" });
		return true;
	}

	requestOlder(): boolean {
		if (this.disposed || this.isLoadingOlder || !this.hasMore) return false;
		this.moreRequests++;
		return true;
	}

	dispose(): void {
		this.disposed = true;
		this.isConnected = false;
	}

	emit(event: TimelineEvent): void {
		this.hooks.onEvent(event);
	}
}

interface FakeHost {
	command: (args: string) => Promise<void>;
	clients: FakeTimeline[];
	entries: { data: unknown; component: Tui.Component }[];
	notifies: { text: string; level: string }[];
	widgets: Map<string, Tui.Component>;
	widgetInputs: unknown[];
	statuses: string[];
	restore(data: unknown): Tui.Component | undefined;
	shutdown(): void;
}

function makeHost(overrides: Partial<TelegramExtensionOptions> = {}): FakeHost {
	const clients: FakeTimeline[] = [];
	const entries: FakeHost["entries"] = [];
	const notifies: FakeHost["notifies"] = [];
	const widgets = new Map<string, Tui.Component>();
	const widgetInputs: unknown[] = [];
	const statuses: string[] = [];
	const commands = new Map<string, { handler(args: string, ctx: unknown): Promise<void> }>();
	const renderers = new Map<string, (entry: { data?: unknown }, options: unknown, theme: Theme) => Tui.Component | undefined>();
	const handlers = new Map<string, (() => void)[]>();
	const ctx = {
		mode: "tui",
		ui: {
			notify: (text: string, level: string) => notifies.push({ text, level }),
			setStatus: (_key: string, text: string | undefined) => statuses.push(text ?? ""),
			setWidget: (key: string, input: unknown) => {
				widgetInputs.push(input);
				if (input === undefined) widgets.delete(key);
				else widgets.set(key, (input as (tui: { requestRender(): void }, theme: Theme) => Tui.Component)({ requestRender() {} }, theme));
			},
		},
	};
	const api = {
		registerCommand: (name: string, definition: { handler(args: string, ctx: unknown): Promise<void> }) => commands.set(name, definition),
		registerEntryRenderer: (type: string, renderer: (entry: { data?: unknown }, options: unknown, theme: Theme) => Tui.Component | undefined) => renderers.set(type, renderer),
		appendEntry: (type: string, data: unknown) => {
			const component = renderers.get(type)?.({ data }, {}, theme);
			if (component) entries.push({ data, component });
		},
		on: (event: string, handler: () => void) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
	};
	let id = 0;
	registerTelegramExtension(api as never, {
		rootDir: join(import.meta.dir, ".."),
		hostVersion: "0.84.1",
		idFactory: () => `feed-${++id}`,
		timelineFactory: (filter, hooks) => {
			const client = new FakeTimeline(filter, hooks);
			clients.push(client);
			return client;
		},
		...overrides,
	});
	return {
		command: (args) => commands.get("tg")!.handler(args, ctx),
		clients,
		entries,
		notifies,
		widgets,
		widgetInputs,
		statuses,
		restore: (data) => renderers.get("telegram-chat")?.({ data }, {}, theme),
		shutdown: () => handlers.get("session_shutdown")?.forEach((handler) => handler()),
	};
}

const message: TimelineItem = {
	kind: "msg",
	ts: 1754600000 * 1000,
	chatId: 1,
	messageId: 5,
	senderName: "Alice",
	username: "alice",
	isBot: false,
	botId: null,
	text: "hello\nworld",
	mediaKind: null,
	stickerEmoji: null,
	replyTo: 3,
	edited: true,
};

describe("native Pi Telegram extension", () => {
	test("package manifest exposes the extension and pins the local fullscreen launcher", () => {
		const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as { keywords: string[]; pi: { extensions: string[] }; scripts: { pi: string } };
		const settings = JSON.parse(readFileSync(join(import.meta.dir, "../.pi/settings.json"), "utf8")) as { tuiMode: string };
		expect(pkg.keywords).toContain("pi-package");
		expect(pkg.pi.extensions).toContain("./.pi/extensions/tg-extension.ts");
		expect(pkg.scripts.pi).toContain("node_modules/@earendil-works/pi-coding-agent");
		expect(settings.tuiMode).toBe("fullscreen");
	});

	test("version guard rejects the old global Pi with the local launcher hint", async () => {
		expect(supportsPiVersion("0.83.0")).toBe(false);
		expect(supportsPiVersion("0.84.1")).toBe(true);
		expect(supportsPiVersion("1.0.0")).toBe(true);
		const host = makeHost({ hostVersion: "0.83.0" });
		await host.command("attach");
		expect(host.entries).toHaveLength(0);
		expect(host.notifies[0]?.text).toContain("bun run pi");
	});

	test("attach mounts one TUI-only transcript component and renders live items", async () => {
		const host = makeHost();
		await host.command("attach");
		expect(host.entries).toHaveLength(1);
		expect(host.entries[0]!.component).toBeInstanceOf(TelegramFeed);
		expect(host.clients).toHaveLength(1);
		host.clients[0]!.emit({ type: "append", items: [message] });
		const rendered = host.entries[0]!.component.render(48).join("\n");
		expect(rendered).toContain("Alice · @alice");
		expect(rendered).toContain("reply to #3");
		expect(rendered).toContain("edited");
		expect(host.statuses.at(-1)).toContain("connected");
	});

	test("a restored attach anchor renders detached without opening a socket", () => {
		const host = makeHost();
		const restored = host.restore({ instanceId: "old-feed", filter: "A" });
		expect(restored?.render(50).join("\n")).toContain("detached");
		expect(host.clients).toHaveLength(0);
	});

	test("a second attach disposes the first feed; more and detach target the singleton", async () => {
		const host = makeHost();
		await host.command("attach A");
		await host.command("attach B");
		expect(host.clients).toHaveLength(2);
		expect(host.clients[0]!.disposed).toBe(true);
		expect(host.clients[1]!.disposed).toBe(false);
		await host.command("more");
		expect(host.clients[1]!.moreRequests).toBe(1);
		await host.command("detach");
		expect(host.clients[1]!.disposed).toBe(true);
	});

	test("panel uses a Pi component factory and disposes its standalone client", async () => {
		const host = makeHost();
		await host.command("panel A");
		expect(typeof host.widgetInputs[0]).toBe("function");
		expect(host.widgets.get("tg-panel")).toBeInstanceOf(Tui.Container);
		const stats: BotStats = { runs: 1, contextTokens: 1000, cacheRead: 800, cacheMiss: 200, outputTokens: 10, cost: 0.01, epoch: 2, last: null };
		host.clients[0]!.emit({ type: "stats", stats: { A: stats } });
		expect(host.widgets.get("tg-panel")!.render(36).join(" ").replace(/\s+/g, " ")).toContain("hit 80.0%");
		await host.command("panel off");
		expect(host.widgets.has("tg-panel")).toBe(false);
		expect(host.clients[0]!.disposed).toBe(true);
	});

	test("status reuses active feed telemetry without another socket", async () => {
		const host = makeHost();
		await host.command("attach A");
		const stats: BotStats = { runs: 1, contextTokens: 1000, cacheRead: 800, cacheMiss: 200, outputTokens: 10, cost: 0.01, epoch: 2, last: null };
		host.clients[0]!.emit({ type: "stats", stats: { A: stats } });
		await host.command("status A");
		expect(host.clients).toHaveLength(1);
		expect(host.notifies.at(-1)?.text).toContain("hit 80.0%");
	});

	test("invalid bot ids are rejected and session shutdown disposes live resources", async () => {
		const host = makeHost();
		await host.command("attach nobody");
		expect(host.notifies.at(-1)?.text).toContain("configured bots");
		await host.command("attach A");
		host.shutdown();
		expect(host.clients.at(-1)?.disposed).toBe(true);
	});

	test("message and LOCAL event cards are native components, safe at narrow widths", () => {
		const controlMessage = { ...message, text: "safe\x1b]52;c;pwnd\x07 text" };
		const messageCard = itemComponent(controlMessage, theme);
		const eventCard = itemComponent({ kind: "evt", ts: 1, evtId: 2, botId: "A", botName: "小雪", evtKind: "tool_call", payload: JSON.stringify({ tool: "send", args: { message: "hi" } }) }, theme);
		for (const component of [messageCard, eventCard]) {
			const lines = component.render(24);
			expect(lines.every((line) => Tui.visibleWidth(line) <= 24)).toBe(true);
			expect(lines.join("\n")).not.toContain("\x1b]52");
		}
		expect(eventCard.render(40).join("\n")).toContain("小雪 · LOCAL");
	});

	test("a supported local media file becomes Pi's Image component", () => {
		const path = join(tmpdir(), `tg-native-image-${process.pid}.png`);
		writeFileSync(path, "not-empty");
		try {
			const card = itemComponent({ ...message, mediaKind: "photo", mediaPath: path }, theme) as Tui.Box;
			expect(card.children.some((child) => child instanceof Tui.Image)).toBe(true);
		} finally {
			unlinkSync(path);
		}
	});
});
