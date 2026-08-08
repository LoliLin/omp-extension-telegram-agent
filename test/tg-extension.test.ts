process.env.TZ = "Asia/Singapore";

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FooterComponent, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import {
	completeTgArguments,
	formatTgHelp,
	itemComponent,
	parseTgArguments,
	registerTelegramExtension,
	streamComponent,
	supportsPiVersion,
	TG_COMMAND_TREE,
	TelegramFeed,
	type TgCommandNode,
	type TelegramExtensionOptions,
} from "../.pi/extensions/tg-extension.ts";
import type { BotStats, SendMessageResult, TimelineItem } from "../src/ipc.ts";
import type { TimelineEvent, TimelineHooks, TimelinePort } from "../src/plugin/timeline.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

beforeAll(() => initTheme(undefined, false));

class FakeTimeline implements TimelinePort {
	isConnected = false;
	hasMore = true;
	isLoadingOlder = false;
	disposed = false;
	moreRequests = 0;
	readonly sendCalls: { botId: string; text: string; requestId: string }[] = [];
	sendHandler: (botId: string, text: string, requestId: string) => Promise<SendMessageResult> = async (botId, _text, requestId) => ({
		requestId,
		botId,
		ok: true,
		chatId: -1001,
		messageId: 42,
	});

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

	sendText(botId: string, text: string, requestId: string): Promise<SendMessageResult> {
		this.sendCalls.push({ botId, text, requestId });
		return this.sendHandler(botId, text, requestId);
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
	complete: (prefix: string) => Promise<{ value: string; label: string; description?: string }[] | null>;
	clients: FakeTimeline[];
	entries: { data: unknown; component: Tui.Component }[];
	notifies: { text: string; level: string }[];
	widgets: Map<string, Tui.Component>;
	widgetInputs: unknown[];
	statuses: string[];
	statusUpdates: { key: string; text: string | undefined }[];
	footerInputs: unknown[];
	renderRequests: { count: number };
	sessionEntries: unknown[];
	getFooter(): Tui.Component | undefined;
	editorTexts: string[];
	input(event: { text: string; source?: "interactive" | "rpc" | "extension"; images?: unknown[] }): Promise<{ action: string } | undefined>;
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
	const statusUpdates: FakeHost["statusUpdates"] = [];
	const footerInputs: unknown[] = [];
	const renderRequests = { count: 0 };
	const sessionEntries: unknown[] = [];
	const footerStatuses = new Map<string, string>();
	let currentFooter: Tui.Component | undefined;
	const editorTexts: string[] = [];
	const commands = new Map<string, {
		handler(args: string, ctx: unknown): Promise<void>;
		getArgumentCompletions?: (prefix: string) => { value: string; label: string; description?: string }[] | null | Promise<{ value: string; label: string; description?: string }[] | null>;
	}>();
	const renderers = new Map<string, (entry: { data?: unknown }, options: unknown, theme: Theme) => Tui.Component | undefined>();
	const shutdownHandlers: (() => void)[] = [];
	let inputHandler: ((event: unknown, ctx: unknown) => Promise<{ action: string } | undefined> | { action: string } | undefined) | undefined;
	const model = {
		id: "deepseek-v4-flash",
		provider: "deepseek",
		api: "openai-completions",
		contextWindow: 1_000_000,
		reasoning: true,
	};
	const footerData = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => footerStatuses,
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
	const ctx = {
		mode: "tui",
		model,
		thinkingLevel: "max",
		modelRegistry: { getAvailable: () => [model] },
		sessionManager: {
			getEntries: () => sessionEntries,
			getCwd: () => join(import.meta.dir, ".."),
			getSessionName: () => undefined,
		},
		getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000, percent: 0 }),
		ui: {
			notify: (text: string, level: string) => notifies.push({ text, level }),
			setStatus: (key: string, text: string | undefined) => {
				statuses.push(text ?? "");
				statusUpdates.push({ key, text });
				if (text === undefined) footerStatuses.delete(key);
				else footerStatuses.set(key, text);
				renderRequests.count++;
			},
			setFooter: (input: unknown) => {
				footerInputs.push(input);
				if (input === undefined) currentFooter = undefined;
				else {
					currentFooter = (input as (tui: Tui.TUI, theme: Theme, footerData: unknown) => Tui.Component)(
						{ requestRender: () => { renderRequests.count++; } } as never,
						theme,
						footerData,
					);
				}
			},
			setEditorText: (text: string) => editorTexts.push(text),
			getEditorText: () => editorTexts.at(-1) ?? "",
			setWidget: (key: string, input: unknown) => {
				widgetInputs.push(input);
				if (input === undefined) widgets.delete(key);
				else widgets.set(key, (input as (tui: { requestRender(): void }, theme: Theme) => Tui.Component)({ requestRender() {} }, theme));
			},
		},
	};
	const api = {
		registerCommand: (name: string, definition: {
			handler(args: string, ctx: unknown): Promise<void>;
			getArgumentCompletions?: (prefix: string) => { value: string; label: string; description?: string }[] | null | Promise<{ value: string; label: string; description?: string }[] | null>;
		}) => commands.set(name, definition),
		registerEntryRenderer: (type: string, renderer: (entry: { data?: unknown }, options: unknown, theme: Theme) => Tui.Component | undefined) => renderers.set(type, renderer),
		appendEntry: (type: string, data: unknown) => {
			const component = renderers.get(type)?.({ data }, {}, theme);
			if (component) entries.push({ data, component });
		},
		on: (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => {
			if (event === "input") inputHandler = handler as typeof inputHandler;
			else if (event === "session_shutdown") shutdownHandlers.push(() => handler());
		},
	};
	let id = 0;
	let requestId = 0;
	registerTelegramExtension(api as never, {
		rootDir: join(import.meta.dir, ".."),
		hostVersion: "0.84.1",
		idFactory: () => `feed-${++id}`,
		requestIdFactory: () => `send-${++requestId}`,
		timelineFactory: (filter, hooks) => {
			const client = new FakeTimeline(filter, hooks);
			clients.push(client);
			return client;
		},
		...overrides,
	});
	return {
		command: (args) => commands.get("tg")!.handler(args, ctx),
		complete: async (prefix) => await commands.get("tg")!.getArgumentCompletions?.(prefix) ?? null,
		clients,
		entries,
		notifies,
		widgets,
		widgetInputs,
		statuses,
		statusUpdates,
		footerInputs,
		renderRequests,
		sessionEntries,
		getFooter: () => currentFooter,
		editorTexts,
		input: async (event) => await inputHandler?.({ type: "input", source: "interactive", ...event }, ctx),
		restore: (data) => renderers.get("telegram-chat")?.({ data }, {}, theme),
		shutdown: () => shutdownHandlers.forEach((handler) => handler()),
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
	test("command tree drives native multi-level completion and help", () => {
		const bots = [
			{ id: "A", name: "小雪" },
			{ id: "B", name: "小雨" },
			{ id: "C", name: "Cloud" },
		];
		const values = (prefix: string) => completeTgArguments(prefix, bots)?.map((item) => item.value) ?? [];

		expect(values("")).toEqual(TG_COMMAND_TREE.map((node) => node.token));
		expect(values("att")).toEqual(["attach"]);
		expect(values("attach ")).toEqual(["attach A", "attach B", "attach C"]);
		expect(values("  attach   c")).toEqual(["attach C"]);
		expect(values("panel o")).toEqual(["panel off"]);
		expect(values("compose ")).toEqual(["compose A", "compose B", "compose C", "compose off"]);
		expect(values("status ")).toEqual(["status A", "status B", "status C"]);
		expect(values("more ")).toEqual([]);
		expect(values("start ")).toEqual([]);
		expect(completeTgArguments("attach ", bots)?.[0]).toEqual({
			value: "attach A",
			label: "A (小雪)",
			description: "Telegram bot 小雪",
		});
		expect(formatTgHelp()).toBe("usage: /tg attach [bot] | compose <bot|off> | more | detach | panel [bot|off] | status [bot] | start | restart | stop | status-daemon");
		for (const root of completeTgArguments("", bots) ?? []) {
			expect(parseTgArguments(root.value, bots).ok).toBe(true);
			for (const child of completeTgArguments(`${root.value} `, bots) ?? []) {
				expect(parseTgArguments(child.value, bots).ok).toBe(true);
			}
		}
	});

	test("command traversal supports future depth and parser rejects syntax drift", () => {
		const bots = [{ id: "C", name: "Cloud" }];
		const futureTree: readonly TgCommandNode[] = [{
			token: "config",
			description: "Configure Telegram",
			children: {
				hint: "scope",
				optional: false,
				resolve: () => [{
					token: "bot",
					description: "Configure a bot",
					children: {
						hint: "bot",
						optional: false,
						resolve: (choices) => choices.map((bot) => ({ token: bot.id, label: bot.name, description: "Bot", dispatch: "status" })),
					},
				}],
			},
		}];
		expect(completeTgArguments("config bot ", bots, futureTree)?.map((item) => item.value)).toEqual(["config bot C"]);
		expect(parseTgArguments(" attach   nobody ", bots)).toEqual({ ok: true, dispatch: "attach", arguments: ["nobody"] });
		expect(parseTgArguments("more unexpected", bots)).toEqual({ ok: false, reason: "extra" });
		expect(parseTgArguments("unknown", bots)).toEqual({ ok: false, reason: "unknown" });
	});

	test("native completer keeps static commands when config loading fails", async () => {
		const host = makeHost({ rootDir: join(tmpdir(), `missing-tg-config-${process.pid}-${Date.now()}`) });
		expect((await host.complete("att"))?.map((item) => item.value)).toEqual(["attach"]);
		expect(await host.complete("attach ")).toBeNull();
		await host.command("");
		expect(host.notifies.at(-1)).toEqual({ text: formatTgHelp(), level: "info" });
	});

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
		expect(rendered).not.toContain("connected · bot");
		expect(host.getFooter()).toBeInstanceOf(FooterComponent);
		expect(host.widgetInputs).toHaveLength(0);
	});

	test("every feed change requests a host render even after panel off", async () => {
		const host = makeHost();
		await host.command("attach A");
		const beforeFirst = host.renderRequests.count;
		host.clients[0]!.emit({ type: "append", items: [message] });
		expect(host.renderRequests.count).toBe(beforeFirst + 1);

		await host.command("panel off");
		const beforeSecond = host.renderRequests.count;
		host.clients[0]!.emit({ type: "append", items: [{ ...message, messageId: 6, ts: message.ts + 1 }] });
		expect(host.renderRequests.count).toBe(beforeSecond + 1);
	});

	test("assistant partials replace one native streaming card and expose tool arguments", async () => {
		const host = makeHost();
		await host.command("attach A");
		const streamBase = { streamId: "s1", botId: "A", botName: "小雪", ts: message.ts };
		host.clients[0]!.emit({ type: "stream", stream: { ...streamBase, phase: "start" } });
		host.clients[0]!.emit({
			type: "stream",
			stream: { ...streamBase, phase: "update", thinking: "先想\x1b]52;c;bad\x07", text: "旧文本", toolCalls: [] },
		});
		host.clients[0]!.emit({
			type: "stream",
			stream: { ...streamBase, phase: "update", thinking: "先想", text: "", toolCalls: [{ name: "send", arguments: `${JSON.stringify({ message: "你好" })}\x1b[31m` }] },
		});

		const rendered = host.entries[0]!.component.render(80).join("\n");
		expect(rendered.match(/STREAMING/g)).toHaveLength(1);
		expect(rendered).toContain("thinking · 先想");
		expect(rendered).toContain('send · {"message":"你好"}');
		expect(rendered).not.toContain("旧文本");
		expect(rendered).not.toContain("\x1b]52");
		expect(rendered).not.toContain("\x1b[31m");
		expect(host.entries).toHaveLength(1);

		host.clients[0]!.emit({ type: "stream", stream: { ...streamBase, phase: "end" } });
		host.clients[0]!.emit({ type: "append", items: [{ kind: "evt", ts: message.ts + 1, evtId: 9, botId: "A", botName: "小雪", evtKind: "tool_call", payload: JSON.stringify({ tool: "send", args: {} }) }] });
		const final = host.entries[0]!.component.render(80).join("\n");
		expect(final).not.toContain("STREAMING");
		expect(final.match(/send · \{\}/g)).toHaveLength(1);
	});

	test("stream updates self-heal without start and remain bounded across stale/end/disconnect", async () => {
		const host = makeHost();
		await host.command("attach");
		for (let index = 0; index < 33; index++) {
			host.clients[0]!.emit({
				type: "stream",
				stream: { phase: "update", streamId: `s-${index}`, botId: index % 2 ? "B" : "A", botName: `bot-${index}`, ts: index, thinking: "", text: `text-${index}`, toolCalls: [] },
			});
		}
		let rendered = host.entries[0]!.component.render(100).join("\n");
		expect(rendered.match(/STREAMING/g)).toHaveLength(32);
		expect(rendered).not.toContain("text-0");
		expect(rendered).toContain("text-32");

		host.clients[0]!.emit({ type: "stream", stream: { phase: "end", streamId: "s-32", botId: "A", botName: "bot-32", ts: 34 } });
		host.clients[0]!.emit({ type: "stream", stream: { phase: "update", streamId: "s-32", botId: "A", botName: "bot-32", ts: 35, thinking: "", text: "stale", toolCalls: [] } });
		rendered = host.entries[0]!.component.render(100).join("\n");
		expect(rendered).not.toContain("stale");
		expect(rendered.match(/STREAMING/g)).toHaveLength(31);

		host.clients[0]!.emit({ type: "disconnected", reason: "daemon disconnected" });
		rendered = host.entries[0]!.component.render(100).join("\n");
		expect(rendered).not.toContain("STREAMING");
		expect(host.entries).toHaveLength(1);
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

	test("explicit compose sends interactive editor text once and keeps it out of Pi", async () => {
		const host = makeHost();
		await host.command("attach A");
		await host.command("compose A");

		const result = await host.input({ text: "hello" });

		expect(result).toEqual({ action: "handled" });
		expect(host.clients[0]!.sendCalls).toEqual([{ botId: "A", text: "hello", requestId: "send-1" }]);
		expect(host.entries).toHaveLength(1);
		expect(host.editorTexts).toHaveLength(0);
		expect(host.statusUpdates.some((update) => update.key === "telegram-compose" && update.text?.includes("SEND AS A"))).toBe(true);
		expect(host.notifies.at(-1)?.text).toContain("#42");
	});

	test("read-only, compose-off and non-interactive inputs continue to Pi unchanged", async () => {
		const host = makeHost();
		await host.command("attach");
		expect(await host.input({ text: "normal Pi prompt" })).toEqual({ action: "continue" });
		await host.command("compose nobody");
		expect(host.notifies.at(-1)?.text).toContain("configured bots");
		expect(await host.input({ text: "still a Pi prompt" })).toEqual({ action: "continue" });

		await host.command("compose A");
		expect(await host.input({ text: "rpc prompt", source: "rpc" })).toEqual({ action: "continue" });
		expect(await host.input({ text: "extension prompt", source: "extension" })).toEqual({ action: "continue" });
		await host.command("compose off");
		expect(await host.input({ text: "back to Pi" })).toEqual({ action: "continue" });
		expect(host.clients[0]!.sendCalls).toHaveLength(0);
	});

	test("compose blocks attachments and restores text after an explicit daemon failure", async () => {
		const host = makeHost();
		await host.command("attach A");
		await host.command("compose A");

		expect(await host.input({ text: "caption", images: [{}] })).toEqual({ action: "handled" });
		expect(host.clients[0]!.sendCalls).toHaveLength(0);
		expect(host.editorTexts.at(-1)).toBe("caption");
		expect(host.notifies.at(-1)?.text).toContain("does not support attachments");

		host.clients[0]!.sendHandler = async (botId, _text, requestId) => ({
			requestId,
			botId,
			ok: false,
			code: "telegram_error",
			error: "Unauthorized",
		});
		expect(await host.input({ text: "keep me" })).toEqual({ action: "handled" });
		expect(host.editorTexts.at(-1)).toBe("keep me");
		expect(host.notifies.at(-1)?.text).toContain("telegram_error");

		const before = host.clients[0]!.sendCalls.length;
		expect(await host.input({ text: "   " })).toEqual({ action: "handled" });
		expect(host.clients[0]!.sendCalls).toHaveLength(before);
	});

	test("a pending send suppresses duplicates and unknown outcome closes compose without retry", async () => {
		const host = makeHost();
		await host.command("attach A");
		await host.command("compose A");
		let finish: ((result: SendMessageResult) => void) | undefined;
		host.clients[0]!.sendHandler = (_botId, _text, _requestId) => new Promise((resolve) => { finish = resolve; });

		const first = host.input({ text: "possibly sent" });
		await Promise.resolve();
		expect(await host.input({ text: "do not duplicate" })).toEqual({ action: "handled" });
		expect(host.clients[0]!.sendCalls).toHaveLength(1);
		finish?.({ requestId: "send-1", botId: "A", ok: false, code: "unknown_outcome", error: "ack lost" });
		expect(await first).toEqual({ action: "handled" });

		expect(host.editorTexts).toContain("possibly sent");
		expect(host.notifies.at(-1)?.text).toContain("Check the group before retrying");
		expect(await host.input({ text: "now Pi owns this" })).toEqual({ action: "continue" });
		expect(host.clients[0]!.sendCalls).toHaveLength(1);
	});

	test("disconnect, detach and shutdown safely clear compose identity", async () => {
		const disconnected = makeHost();
		await disconnected.command("attach A");
		await disconnected.command("compose A");
		disconnected.clients[0]!.isConnected = false;
		disconnected.clients[0]!.emit({ type: "disconnected", reason: "daemon disconnected" });
		expect(await disconnected.input({ text: "Pi after disconnect" })).toEqual({ action: "continue" });
		expect(disconnected.getFooter()).toBeUndefined();

		const detached = makeHost();
		await detached.command("attach A");
		await detached.command("compose A");
		await detached.command("detach");
		expect(await detached.input({ text: "Pi after detach" })).toEqual({ action: "continue" });
		expect(detached.getFooter()).toBeUndefined();

		const shutdown = makeHost();
		await shutdown.command("attach A");
		await shutdown.command("compose A");
		shutdown.shutdown();
		expect(await shutdown.input({ text: "Pi after shutdown" })).toEqual({ action: "continue" });
		expect(shutdown.getFooter()).toBeUndefined();
	});

	test("vision updates refresh every matching native media card in place and sanitize text", async () => {
		const host = makeHost();
		await host.command("attach A");
		const mediaMessage = {
			...message,
			text: null,
			mediaKind: "sticker",
			stickerEmoji: "👋",
			fileUniqueId: "shared-sticker",
		};
		host.clients[0]!.emit({
			type: "append",
			items: [mediaMessage, { ...mediaMessage, messageId: 6, ts: mediaMessage.ts + 1 }],
		});
		host.clients[0]!.emit({
			type: "vision",
			fileUniqueId: "shared-sticker",
			text: "挥手问候\x1b]52;c;pwnd\x07",
		});
		host.clients[0]!.emit({
			type: "vision",
			fileUniqueId: "shared-sticker",
			text: "挥手问候\x1b]52;c;pwnd\x07",
		});

		const rendered = host.entries[0]!.component.render(80).join("\n");
		expect(rendered.match(/视觉理解 · 挥手问候/g)).toHaveLength(2);
		expect(rendered).not.toContain("\x1b]52");
		expect(host.entries).toHaveLength(1);
	});

	test("native Pi FooterComponent renders Telegram usage with exact Pi metrics", async () => {
		const host = makeHost();
		await host.command("attach A");
		const stats: BotStats = {
			runs: 7,
			contextTokens: 33_000,
			cacheRead: 20_000,
			cacheMiss: 13_000,
			outputTokens: 817,
			cost: 0.002,
			epoch: 2,
			last: { id: 7, botId: "A", ts: 7, model: "deepseek-v4-flash", epoch: 2, contextTokens: 15_000, cacheRead: 10_000, cacheMiss: 5000, outputTokens: 100, cost: 0.001 },
		};
		host.clients[0]!.emit({ type: "stats", stats: { A: stats } });

		const footer = host.getFooter();
		expect(footer).toBeInstanceOf(FooterComponent);
		const rendered = footer!.render(180).join("\n");
		expect(rendered).toContain("↑13k ↓817 R20k CH60.6% $0.002 1.5%/1.0M (auto)");
		expect(rendered).not.toContain(" W");
		expect(rendered).toContain("deepseek-v4-flash • medium");
		expect(host.widgetInputs).toHaveLength(0);
		expect(host.sessionEntries).toEqual([]);
		expect(host.renderRequests.count).toBeGreaterThan(0);
		for (const width of [24, 80]) {
			expect(host.getFooter()!.render(width).every((line) => Tui.visibleWidth(line) <= width)).toBe(true);
		}
		await host.command("compose A");
		expect(host.getFooter()!.render(180).join("\n")).toContain("TELEGRAM · SEND AS A");
	});

	test("native footer adds lifetime cache-write and lets Pi compute CH with the full prompt denominator", async () => {
		const host = makeHost();
		await host.command("attach A");
		host.clients[0]!.emit({
			type: "stats",
			stats: {
				A: {
					runs: 2, contextTokens: 1000, cacheRead: 800, cacheWrite: 100, cacheMiss: 100,
					outputTokens: 50, reasoningTokens: 25, totalLatencyMs: 600, latencySamples: 2,
					firstRunTs: 1000, cost: 0.004, epoch: 2,
					last: { id: 2, botId: "A", ts: 2000, model: "deepseek-v4-flash", epoch: 2, contextTokens: 5000, cacheRead: 4000, cacheWrite: 500, cacheMiss: 500, outputTokens: 30, reasoningTokens: 15, latencyMs: 350, cost: 0.003 },
				},
			},
		});

		const rendered = host.getFooter()!.render(180).join("\n");
		expect(rendered).toContain("↑100 ↓50 R800 W100 CH80.0% $0.004");
		expect(host.sessionEntries).toEqual([]);
	});

	test("global footer aggregates bots and uses the latest run model context", async () => {
		const host = makeHost();
		await host.command("attach");
		const base = { runs: 1, contextTokens: 1000, cacheRead: 800, cacheMiss: 200, outputTokens: 10, cost: 0.001, epoch: 1 };
		host.clients[0]!.emit({
			type: "stats",
			stats: {
				A: { ...base, last: { id: 1, botId: "A", ts: 1, model: "deepseek-v4-flash", epoch: 1, contextTokens: 1000, cacheRead: 800, cacheMiss: 200, outputTokens: 10, cost: 0.001 } },
				B: { ...base, cacheRead: 1200, cacheMiss: 300, outputTokens: 20, cost: 0.002, last: { id: 2, botId: "B", ts: 2, model: "deepseek-v4-flash", epoch: 1, contextTokens: 20_000, cacheRead: 1200, cacheMiss: 300, outputTokens: 20, cost: 0.002 } },
			},
		});

		const rendered = host.getFooter()!.render(160).join("\n");
		expect(rendered).toContain("↑500 ↓30 R2.0k CH80.0% $0.003 2.0%/1.0M (auto)");
		expect(host.clients).toHaveLength(1);
	});

	test("standalone panel owns one stats socket and off restores the default footer", async () => {
		const host = makeHost();
		await host.command("panel A");
		expect(host.getFooter()).toBeInstanceOf(FooterComponent);
		expect(host.clients).toHaveLength(1);
		const stats: BotStats = { runs: 1, contextTokens: 1000, cacheRead: 800, cacheMiss: 200, outputTokens: 10, cost: 0.01, epoch: 2, last: null };
		host.clients[0]!.emit({ type: "stats", stats: { A: stats } });
		expect(host.getFooter()!.render(120).join("\n")).toContain("CH80.0%");
		await host.command("panel off");
		expect(host.getFooter()).toBeUndefined();
		expect(host.clients[0]!.disposed).toBe(true);
		expect(host.widgetInputs).toHaveLength(0);

		const disconnected = makeHost();
		await disconnected.command("panel A");
		disconnected.clients[0]!.emit({ type: "disconnected", reason: "daemon stopped" });
		expect(disconnected.getFooter()).toBeUndefined();
		expect(disconnected.clients[0]!.disposed).toBe(true);
		expect(disconnected.notifies.at(-1)?.text).toContain("Telegram stats disconnected");
	});

	test("panel switches one standalone socket back to active-feed stats without detaching", async () => {
		const host = makeHost();
		await host.command("attach A");
		await host.command("panel B");
		expect(host.clients).toHaveLength(2);
		expect(host.clients[0]!.disposed).toBe(false);
		expect(host.clients[1]!.disposed).toBe(false);

		await host.command("panel A");
		expect(host.clients).toHaveLength(2);
		expect(host.clients[0]!.disposed).toBe(false);
		expect(host.clients[1]!.disposed).toBe(true);
		expect(host.getFooter()).toBeInstanceOf(FooterComponent);
	});

	test("status reuses active feed and reports lifetime/latest telemetry details", async () => {
		const host = makeHost();
		await host.command("attach A");
		const stats: BotStats = {
			runs: 2, contextTokens: 3000, cacheRead: 2200, cacheWrite: 300, cacheMiss: 500,
			outputTokens: 30, reasoningTokens: 12, totalLatencyMs: 600, latencySamples: 2,
			firstRunTs: new Date("2026-08-08T00:00:00+08:00").getTime(), cost: 0.03, epoch: 2,
			last: { id: 2, botId: "A", ts: 2000, model: "deepseek-v4-flash", epoch: 2, contextTokens: 2000, cacheRead: 1500, cacheWrite: 200, cacheMiss: 300, outputTokens: 20, reasoningTokens: 7, latencyMs: 400, cost: 0.02 },
		};
		host.clients[0]!.emit({ type: "stats", stats: { A: stats } });
		await host.command("status A");
		expect(host.clients).toHaveLength(1);
		const text = host.notifies.at(-1)?.text ?? "";
		expect(text).toContain("A · lifetime · 2 runs since 2026-08-08 00:00:00");
		expect(text).toContain("last · ep2 · ctx 2.00K · miss 300 · read 1.50K · write 200 · out 20 · reasoning 7 · 400ms · $0.0200");
		expect(text).toContain("total · prompt 3.00K · ↑500 ↓30 R2.20K W300 · reasoning 12 · $0.0300 · CH73.3% · avg 300ms");

		const empty = makeHost();
		await empty.command("attach A");
		empty.clients[0]!.emit({ type: "stats", stats: { A: { runs: 0, contextTokens: 0, cacheRead: 0, cacheMiss: 0, outputTokens: 0, cost: 0, epoch: 0, last: null } } });
		await empty.command("status A");
		expect(empty.notifies.at(-1)?.text).toBe("A · lifetime · no runs yet");

		const noLatency = makeHost();
		await noLatency.command("attach A");
		noLatency.clients[0]!.emit({
			type: "stats",
			stats: { A: {
				runs: 1, contextTokens: 100, cacheRead: 0, cacheWrite: 0, cacheMiss: 100,
				outputTokens: 5, reasoningTokens: 0, totalLatencyMs: 0, latencySamples: 0,
				firstRunTs: 1000, cost: 0, epoch: 1,
				last: { id: 1, botId: "A", ts: 1000, model: "m", epoch: 1, contextTokens: 100, cacheRead: 0, cacheWrite: 0, cacheMiss: 100, outputTokens: 5, reasoningTokens: 0, latencyMs: null, cost: 0 },
			} },
		});
		await noLatency.command("status A");
		expect(noLatency.notifies.at(-1)?.text).toContain("latency n/a");
		expect(noLatency.notifies.at(-1)?.text).toContain("avg n/a");
	});

	test("invalid bot ids are rejected and session shutdown disposes live resources", async () => {
		const host = makeHost();
		await host.command("attach nobody");
		expect(host.notifies.at(-1)?.text).toContain("configured bots");
		await host.command("attach A");
		host.shutdown();
		expect(host.clients.at(-1)?.disposed).toBe(true);
	});

	test("restart delegates to the CLI and reconnects the same filtered feed and footer", async () => {
		const calls: { command: string; args: readonly string[]; cwd: string }[] = [];
		const host = makeHost({
			processRunner: async (command, args, options) => {
				calls.push({ command, args, cwd: options.cwd });
				return { status: 0, stdout: "stopping old daemon (pid 100)\ndaemon ready (pid 200)\n", stderr: "" };
			},
		});
		await host.command("attach A");
		host.clients[0]!.emit({ type: "append", items: [message] });
		await host.command("compose A");
		await host.command("restart");

		expect(calls).toEqual([{ command: "bun", args: ["run", "src/main.ts", "restart"], cwd: join(import.meta.dir, "..") }]);
		expect(host.entries).toHaveLength(1);
		expect(host.clients).toHaveLength(2);
		expect(host.clients[0]!.disposed).toBe(true);
		expect(host.clients[1]!.filter).toBe("A");
		expect(host.clients[1]!.isConnected).toBe(true);
		expect(host.getFooter()).toBeInstanceOf(FooterComponent);
		expect(host.statusUpdates).toContainEqual({ key: "telegram-daemon", text: "TELEGRAM · RESTARTING" });
		expect(host.statusUpdates.at(-1)).toEqual({ key: "telegram-daemon", text: undefined });
		expect(host.statusUpdates).toContainEqual({ key: "telegram-compose", text: undefined });
		expect(host.notifies.at(-1)).toEqual({ text: "stopping old daemon (pid 100)\ndaemon ready (pid 200)", level: "info" });

		// A reconnect snapshot may overlap the retained transcript; the feed owns cross-client dedupe.
		host.clients[1]!.emit({ type: "append", items: [message, { ...message, messageId: 6, text: "after restart" }] });
		const rendered = host.entries[0]!.component.render(80).join("\n");
		expect(rendered.match(/Alice · @alice/g)).toHaveLength(2);
		expect(rendered).toContain("after restart");
		expect(host.clients.flatMap((client) => client.sendCalls)).toHaveLength(0);
	});

	test("restart preserves transcript on failure, reports starting honestly, and creates no feed when detached", async () => {
		const failed = makeHost({ processRunner: async () => ({ status: 1, stdout: "", stderr: "shutdown timed out; no replacement was started" }) });
		await failed.command("attach A");
		failed.clients[0]!.emit({ type: "append", items: [message] });
		await failed.command("restart");
		expect(failed.clients).toHaveLength(1);
		expect(failed.clients[0]!.disposed).toBe(true);
		expect(failed.entries[0]!.component.render(80).join("\n")).toContain("Alice · @alice");
		expect(failed.notifies.at(-1)).toEqual({ text: "shutdown timed out; no replacement was started", level: "error" });

		const starting = makeHost({ processRunner: async () => ({ status: 0, stdout: "daemon starting (pid 201)", stderr: "" }) });
		await starting.command("attach");
		await starting.command("restart");
		expect(starting.clients).toHaveLength(1);
		expect(starting.clients[0]!.disposed).toBe(true);
		expect(starting.notifies.at(-1)).toEqual({ text: "daemon starting (pid 201)", level: "info" });

		const detached = makeHost({ processRunner: async () => ({ status: 0, stdout: "daemon ready (pid 202)", stderr: "" }) });
		await detached.command("restart");
		expect(detached.entries).toHaveLength(0);
		expect(detached.clients).toHaveLength(0);
	});

	test("message, LOCAL event and stream cards share trailing native headers at every width", () => {
		const messageCard = itemComponent({ ...message, text: "safe\x1b]52;c;pwnd\x07 text" }, theme);
		const eventCard = itemComponent({ kind: "evt", ts: message.ts, evtId: 2, botId: "A", botName: "小雪", evtKind: "tool_call", payload: JSON.stringify({ tool: "send", args: { message: "hi" } }) }, theme);
		const streamCard = streamComponent({ phase: "update", streamId: "s1", botId: "A", botName: "小雪", ts: message.ts, thinking: "先想", text: "流式正文", toolCalls: [] }, theme);
		for (const width of [40, 60, 80, 120]) {
			for (const component of [messageCard, eventCard, streamCard]) {
				const lines = component.render(width);
				expect(lines.every((line) => Tui.visibleWidth(line) <= width)).toBe(true);
				expect(lines.join("\n")).not.toContain("\x1b]52");
			}
		}

		for (const width of [80, 120]) {
			const headers = [messageCard, eventCard, streamCard].map((component) => Tui.stripTerminalSequences(component.render(width)[0]!).trimEnd());
			for (const header of headers) expect(Tui.visibleWidth(header)).toBe(width - 1);
			expect(headers[0]).toMatch(/^ Alice · @alice\s+#5 · \d{2}:\d{2}:\d{2} · edited$/);
			expect(headers[1]).toMatch(/^ 小雪 · bot A\s+LOCAL · \d{2}:\d{2}:\d{2}$/);
			expect(headers[2]).toMatch(/^ 小雪 · bot A\s+STREAMING · \d{2}:\d{2}:\d{2}$/);
		}

		const narrow = Tui.stripTerminalSequences(itemComponent({
			...message, messageId: 812, senderName: "非常非常长的中文用户🙂名字", username: "extraordinarily_long_username", text: "正文保留",
		}, theme).render(40).join("\n"));
		expect(narrow).toContain("非常非常");
		expect(narrow).toContain("#812");
		expect(narrow).toContain("正文保留");
		const botHeader = Tui.stripTerminalSequences(itemComponent({ ...message, isBot: true, botId: "helper", username: "telegram_name" }, theme).render(80)[0]!);
		expect(botHeader).toContain("Alice · bot helper");
		expect(botHeader).not.toContain("@telegram_name");
		expect(itemComponent({ ...message, replyTo: null, text: "one line" }, theme).render(80)).toHaveLength(2);
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
