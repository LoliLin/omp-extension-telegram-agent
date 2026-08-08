process.env.TZ = "Asia/Singapore";

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToPng, FooterComponent, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import * as Tui from "@earendil-works/pi-tui";
import {
	completeTgArguments,
	formatTgHelp,
	itemComponent,
	MEDIA_CACHE_MAX_BASE64_BYTES,
	MEDIA_CACHE_MAX_ENTRIES,
	MEDIA_CACHE_MAX_ITEM_BASE64_BYTES,
	MEDIA_CONVERSION_MAX_PENDING,
	NativeMediaCache,
	parseTgArguments,
	registerTelegramExtension,
	streamComponent,
	supportsPiVersion,
	TG_COMMAND_TREE,
	TelegramFeed,
	type TgCommandNode,
	type TelegramExtensionOptions,
} from "../.pi/extensions/tg-extension.ts";
import { loadConfig } from "../src/config.ts";
import { PiModelConfigurationError } from "../src/agent/model-runtime.ts";
import type { BotStats, SendMessageResult, TimelineItem } from "../src/ipc.ts";
import { writeFirstRunDeployment } from "../src/onboarding/config-core.ts";
import {
	PiOnboardingPreflightError,
	preflightPiDefaultModel,
	WIZARD_ACTION_CANCEL,
	WIZARD_ACTION_EDIT,
	WIZARD_ACTION_REPLACE,
	WIZARD_ACTION_VALIDATE,
	WIZARD_TEMPLATE_EN,
} from "../src/onboarding/config-wizard.ts";
import type { TimelineEvent, TimelineHooks, TimelinePort } from "../src/plugin/timeline.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

beforeAll(() => initTheme(undefined, false));
afterEach(() => Tui.resetCapabilitiesCache());

const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==";
const TINY_JPEG =
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAGCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AD3VTB3/2Q==";
const TINY_GIF = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
// Deterministic 2x2 WebP generated from Pi's red-circle fixture with cwebp.
const TINY_WEBP = "UklGRjAAAABXRUJQVlA4ICQAAABwAQCdASoCAAIAAgA0JZACdAF1AAD++DLAHxcv9qflZ7vuAAA=";

let mediaFixtureSequence = 0;
function writeMediaFixture(extension: string, base64: string): string {
	const path = join(tmpdir(), `tg-media-${process.pid}-${++mediaFixtureSequence}.${extension}`);
	writeFileSync(path, Buffer.from(base64, "base64"));
	return path;
}

async function waitForMedia(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("timed out waiting for media conversion");
}

function pngSignature(base64: string): string {
	return Buffer.from(base64, "base64").subarray(0, 8).toString("hex");
}

function firstKittyPayload(rendered: string): string | null {
	const start = rendered.indexOf("\x1b_G");
	if (start < 0) return null;
	const separator = rendered.indexOf(";", start);
	const end = rendered.indexOf("\x1b\\", separator);
	return separator < 0 || end < 0 ? null : rendered.slice(separator + 1, end);
}

function firstKittyPlacement(rendered: string): { columns: number; rows: number } | null {
	const start = rendered.indexOf("\x1b_G");
	const separator = rendered.indexOf(";", start);
	if (start < 0 || separator < 0) return null;
	const controls = new Map(
		rendered.slice(start + "\x1b_G".length, separator).split(",").map((control) => control.split("=", 2) as [string, string]),
	);
	const columns = Number(controls.get("c"));
	const rows = Number(controls.get("r"));
	return Number.isFinite(columns) && Number.isFinite(rows) ? { columns, rows } : null;
}

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
	dialogCalls: Array<{
		kind: "select" | "confirm" | "input" | "editor";
		title: string;
		options?: readonly string[];
		message?: string;
		placeholder?: string;
		prefill?: string;
	}>;
	input(event: { text: string; source?: "interactive" | "rpc" | "extension"; images?: unknown[] }): Promise<{ action: string } | undefined>;
	restore(data: unknown): Tui.Component | undefined;
	shutdown(): void;
}

interface FakeDialogAnswers {
	selects?: Array<string | undefined>;
	select?: (title: string, options: readonly string[]) => Promise<string | undefined>;
	confirms?: boolean[];
	inputs?: Array<string | undefined>;
	editors?: Array<string | undefined>;
}

function makeHost(overrides: Partial<TelegramExtensionOptions> = {}, dialogs: FakeDialogAnswers = {}): FakeHost {
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
	const dialogCalls: FakeHost["dialogCalls"] = [];
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
			select: async (title: string, options: string[]) => {
				dialogCalls.push({ kind: "select", title, options });
				return dialogs.select ? await dialogs.select(title, options) : dialogs.selects?.shift();
			},
			confirm: async (title: string, message: string) => {
				dialogCalls.push({ kind: "confirm", title, message });
				return dialogs.confirms?.shift() ?? false;
			},
			input: async (title: string, placeholder?: string) => {
				dialogCalls.push({ kind: "input", title, ...(placeholder === undefined ? {} : { placeholder }) });
				return dialogs.inputs?.shift();
			},
			editor: async (title: string, prefill?: string) => {
				dialogCalls.push({ kind: "editor", title, ...(prefill === undefined ? {} : { prefill }) });
				return dialogs.editors?.shift();
			},
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
		piModelPreflight: async () => ({
			provider: "deepseek",
			model: "deepseek-v4-flash",
			thinkingLevel: "medium",
		}),
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
		dialogCalls,
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

const ONBOARD_PROVIDER_SECRET = "NOT_A_REAL_PROVIDER_KEY_FOR_WIZARD_TESTS";
const ONBOARD_TELEGRAM_SECRET = "123456:THIS_IS_A_TEST_TOKEN_NOT_VALID";

function makeOnboardingRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "tg-native-config-"));
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, "personas"), { recursive: true });
	mkdirSync(join(root, ".pi"), { recursive: true });
	writeFileSync(join(root, "src/config-schema.ts"), readFileSync(join(import.meta.dir, "../src/config-schema.ts"), "utf8"));
	writeFileSync(join(root, "personas/template.zh.md"), readFileSync(join(import.meta.dir, "../personas/template.zh.md"), "utf8"));
	writeFileSync(join(root, "personas/template.en.md"), readFileSync(join(import.meta.dir, "../personas/template.en.md"), "utf8"));
	writeFileSync(join(root, ".pi/settings.json"), JSON.stringify({
		defaultProvider: "deepseek",
		defaultModel: "deepseek-v4-flash",
		defaultThinkingLevel: "medium",
	}));
	return root;
}

function onboardingInputs(): string[] {
	return [
		"-1001234567890",
		"friend",
		"Mochi",
		"telegram_bot_token",
		ONBOARD_TELEGRAM_SECRET,
	];
}

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
		expect(formatTgHelp()).toBe("usage: /tg config | attach [bot] | compose [bot|off] | more | detach | panel [bot|off] | status [bot] | start | restart | stop | status-daemon");
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
		expect((await host.complete("con"))?.map((item) => item.value)).toEqual(["config"]);
		expect((await host.complete("att"))?.map((item) => item.value)).toEqual(["attach"]);
		expect(await host.complete("attach ")).toBeNull();
		await host.command("");
		expect(host.notifies.at(-1)).toEqual({ text: formatTgHelp(), level: "info" });
	});

	test("config uses Pi dialogs, controlled readiness, and opens the all-bots feed", async () => {
		const root = makeOnboardingRoot();
		const processCalls: Array<{ command: string; args: readonly string[]; cwd: string }> = [];
		try {
			const host = makeHost({
				rootDir: root,
				processRunner: async (command, args, options) => {
					processCalls.push({ command, args, cwd: options.cwd });
					return { status: 0, stdout: "daemon ready (pid 321)\n", stderr: "" };
				},
			}, {
				selects: [WIZARD_TEMPLATE_EN],
				inputs: onboardingInputs(),
				confirms: [true],
			});

			await host.command("config");

			expect(loadConfig(root).bots.map((bot) => ({ id: bot.id, name: bot.name }))).toEqual([{ id: "friend", name: "Mochi" }]);
			expect(processCalls).toEqual([{ command: "bun", args: ["run", "src/main.ts", "restart"], cwd: root }]);
			expect(JSON.stringify(processCalls)).not.toContain(ONBOARD_TELEGRAM_SECRET);
			expect(host.entries).toHaveLength(1);
			expect(host.clients).toHaveLength(1);
			expect(host.clients[0]!.filter).toBeNull();
			expect(host.clients[0]!.isConnected).toBe(true);
			expect(host.getFooter()).toBeInstanceOf(FooterComponent);
			expect((await host.complete("attach "))?.map((item) => item.value)).toEqual(["attach friend"]);
			expect(host.dialogCalls.map((call) => call.kind)).toEqual([
				"select", "input", "input", "input", "input", "input", "confirm",
			]);
			expect(host.dialogCalls.filter((call) => call.kind === "input").map((call) => call.title)).toEqual([
				"Telegram supergroup id",
				"Local bot id",
				"Bot display name",
				"Name for the Telegram token in .env",
				"Telegram bot token (Pi native input is visible)",
			]);
			const transcript = host.notifies.map((item) => item.text).join("\n");
			expect(transcript).toContain("Pi model ready: deepseek/deepseek-v4-flash:medium");
			expect(transcript).toContain("daemon ready");
			expect(transcript).toContain("Opening the all-bots feed");
			expect(transcript).not.toContain(ONBOARD_TELEGRAM_SECRET);
			const configSource = readFileSync(join(root, "telegram.config.ts"), "utf8");
			expect(configSource).not.toMatch(/\b(provider|model|reasoning_effort|api_key_env)\s*:/);
			expect(readFileSync(join(root, ".env"), "utf8")).toBe(`telegram_bot_token: ${ONBOARD_TELEGRAM_SECRET}\n`);
			expect(host.statusUpdates.at(-1)).toEqual({ key: "telegram-config", text: undefined });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("config cancellation at every Pi dialog leaves every target absent", async () => {
		for (let abortAt = 0; abortAt <= 6; abortAt++) {
			const root = makeOnboardingRoot();
			let processCalls = 0;
			try {
				const inputs = onboardingInputs();
				const dialogs: FakeDialogAnswers = abortAt === 0
					? { selects: [undefined] }
					: abortAt <= 5
						? { selects: [WIZARD_TEMPLATE_EN], inputs: [...inputs.slice(0, abortAt - 1), undefined] }
						: { selects: [WIZARD_TEMPLATE_EN], inputs, confirms: [false] };
				const host = makeHost({
					rootDir: root,
					processRunner: async () => {
						processCalls++;
						return { status: 0, stdout: "daemon ready", stderr: "" };
					},
				}, dialogs);

				await host.command("config");

				expect(processCalls).toBe(0);
				expect(existsSync(join(root, ".env"))).toBe(false);
				expect(existsSync(join(root, "telegram.config.ts"))).toBe(false);
				expect(existsSync(join(root, "personas/friend.local.md"))).toBe(false);
				expect(host.entries).toHaveLength(0);
				expect(host.notifies.at(-1)?.text).toContain("no files were changed");
				expect(host.notifies.map((item) => item.text).join("\n")).not.toContain(ONBOARD_TELEGRAM_SECRET);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	test("config preflights Pi defaults/auth before dialogs and leaves zero files on failure", async () => {
		const root = makeOnboardingRoot();
		let processCalls = 0;
		try {
			const host = makeHost({
				rootDir: root,
				piModelPreflight: async () => {
					throw new PiOnboardingPreflightError("unauthenticated_provider");
				},
				processRunner: async () => {
					processCalls++;
					return { status: 0, stdout: "daemon ready", stderr: "" };
				},
			});

			await host.command("config");

			expect(host.dialogCalls).toHaveLength(0);
			expect(processCalls).toBe(0);
			for (const path of [".env", "telegram.config.ts", "personas/friend.local.md"]) {
				expect(existsSync(join(root, path))).toBe(false);
			}
			const transcript = host.notifies.map((item) => item.text).join("\n");
			expect(transcript).toContain("unauthenticated_provider");
			expect(transcript).toContain("/login");
			expect(transcript).toContain("/model");
			expect(transcript).toContain("No files were changed");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("production onboarding preflight composes Pi defaults with catalog/auth validation", async () => {
		const preflighted: Array<{ provider: string; model: string }> = [];
		const selected = await preflightPiDefaultModel(
			"/fixture",
			() => ({ provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "low" }),
			async (bots) => { preflighted.push(...bots); },
		);
		expect(selected).toEqual({ provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "low" });
		expect(preflighted).toEqual([{ provider: "openai-codex", model: "gpt-5.6-luna" }]);

		for (const [defaults, expected] of [
			[{ provider: undefined, model: undefined, thinkingLevel: "medium" as const }, "missing_default"],
			[{ provider: "deepseek", model: "missing", thinkingLevel: "medium" as const }, "unknown_model"],
		] as const) {
			try {
				await preflightPiDefaultModel(
					"/fixture",
					() => defaults,
					async () => { throw new PiModelConfigurationError("unknown_model", "deepseek", "missing"); },
				);
				throw new Error("expected Pi onboarding preflight to fail");
			} catch (error) {
				expect(error).toBeInstanceOf(PiOnboardingPreflightError);
				expect((error as PiOnboardingPreflightError).category).toBe(expected);
			}
		}
	});

	test("existing config exposes protected actions and editor cancellation preserves exact bytes", async () => {
		const root = makeOnboardingRoot();
		const paths = [join(root, ".env"), join(root, "telegram.config.ts"), join(root, "personas/friend.local.md")];
		try {
			writeFirstRunDeployment(root, {
				groupPeerId: "-1001234567890",
				bot: {
					id: "friend",
					name: "Mochi",
					tokenEnv: "telegram_bot_token",
					token: ONBOARD_TELEGRAM_SECRET,
					personaText: readFileSync(join(root, "personas/template.en.md"), "utf8"),
				},
			}, { nonce: "existing-dialog" });
			const before = paths.map((path) => readFileSync(path));
			let processCalls = 0;
			const host = makeHost({
				rootDir: root,
				processRunner: async () => {
					processCalls++;
					return { status: 0, stdout: "daemon ready", stderr: "" };
				},
			}, {
				selects: [WIZARD_ACTION_EDIT],
				editors: [undefined],
			});

			await host.command("config");

			expect(host.dialogCalls[0]?.options).toEqual([
				WIZARD_ACTION_VALIDATE,
				WIZARD_ACTION_EDIT,
				WIZARD_ACTION_REPLACE,
				WIZARD_ACTION_CANCEL,
			]);
			expect(host.dialogCalls.map((call) => call.kind)).toEqual(["select", "editor"]);
			expect(host.dialogCalls[1]?.prefill).toBe(readFileSync(join(root, "telegram.config.ts"), "utf8"));
			expect(paths.map((path) => readFileSync(path))).toEqual(before);
			expect(processCalls).toBe(0);
			expect(host.notifies.at(-1)?.text).toContain("no files were changed");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("config honors bots_config selection without replacing an unread source", async () => {
		const customRoot = makeOnboardingRoot();
		try {
			writeFirstRunDeployment(customRoot, {
				groupPeerId: "-1001234567890",
				bot: {
					id: "friend",
					name: "Mochi",
					tokenEnv: "telegram_bot_token",
					token: ONBOARD_TELEGRAM_SECRET,
					personaText: readFileSync(join(customRoot, "personas/template.en.md"), "utf8"),
				},
			}, { nonce: "custom-source" });
			renameSync(join(customRoot, "telegram.config.ts"), join(customRoot, "custom.config.ts"));
			writeFileSync(join(customRoot, ".env"), `${readFileSync(join(customRoot, ".env"), "utf8")}bots_config: custom.config.ts\n`);
			const originalSource = readFileSync(join(customRoot, "custom.config.ts"));
			const host = makeHost({ rootDir: customRoot }, {
				selects: [WIZARD_ACTION_EDIT],
				editors: [undefined],
			});

			await host.command("config");

			expect(host.dialogCalls[0]?.options).toEqual([WIZARD_ACTION_VALIDATE, WIZARD_ACTION_EDIT, WIZARD_ACTION_CANCEL]);
			expect(readFileSync(join(customRoot, "custom.config.ts"))).toEqual(originalSource);
			expect(existsSync(join(customRoot, "telegram.config.ts"))).toBe(false);
			expect(loadConfig(customRoot).bots[0]!.id).toBe("friend");
		} finally {
			rmSync(customRoot, { recursive: true, force: true });
		}

		const missingRoot = makeOnboardingRoot();
		try {
			const originalEnv = "bots_config: absent.config.ts\nunrelated: keep-exactly\n";
			writeFileSync(join(missingRoot, ".env"), originalEnv);
			let processCalls = 0;
			const host = makeHost({
				rootDir: missingRoot,
				processRunner: async () => {
					processCalls++;
					return { status: 0, stdout: "daemon ready", stderr: "" };
				},
			});

			await host.command("config");

			expect(host.dialogCalls).toHaveLength(0);
			expect(processCalls).toBe(0);
			expect(readFileSync(join(missingRoot, ".env"), "utf8")).toBe(originalEnv);
			expect(existsSync(join(missingRoot, "telegram.config.ts"))).toBe(false);
			expect(host.notifies.at(-1)?.text).toContain("bots_config");
			expect(host.notifies.at(-1)?.text).toContain("remove bots_config");
		} finally {
			rmSync(missingRoot, { recursive: true, force: true });
		}
	});

	test("config keeps a valid deployment when readiness fails and redacts diagnostics", async () => {
		const root = makeOnboardingRoot();
		try {
			const host = makeHost({
				rootDir: root,
				processRunner: async () => ({
					status: 1,
					stdout: "",
					stderr: `authentication failed token=${ONBOARD_TELEGRAM_SECRET} api_key=${ONBOARD_PROVIDER_SECRET}`,
				}),
			}, {
				selects: [WIZARD_TEMPLATE_EN],
				inputs: onboardingInputs(),
				confirms: [true],
			});

			await host.command("config");

			expect(loadConfig(root).bots[0]!.id).toBe("friend");
			expect(host.entries).toHaveLength(0);
			expect(host.clients).toHaveLength(0);
			const transcript = host.notifies.map((item) => item.text).join("\n");
			expect(transcript).toContain("daemon is not ready");
			expect(transcript).toContain("/tg status-daemon");
			expect(transcript).toContain("/tg restart");
			expect(transcript).not.toContain("Opening the all-bots feed");
			expect(transcript).not.toContain(ONBOARD_PROVIDER_SECRET);
			expect(transcript).not.toContain(ONBOARD_TELEGRAM_SECRET);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("package manifest exposes the extension through the portable fullscreen launcher", () => {
		const pkg = JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")) as {
			keywords: string[];
			pi: { extensions: string[] };
			scripts: { pi: string };
			dependencies: Record<string, string>;
		};
		const settings = JSON.parse(readFileSync(join(import.meta.dir, "../.pi/settings.json"), "utf8")) as { tuiMode: string };
		expect(pkg.keywords).toContain("pi-package");
		expect(pkg.pi.extensions).toContain("./.pi/extensions/tg-extension.ts");
		expect(pkg.scripts.pi).toBe("bun run scripts/pi-launcher.ts");
		expect(Object.entries(pkg.dependencies).filter(([name]) => name.startsWith("@earendil-works/pi-"))).toEqual([
			["@earendil-works/pi-agent-core", "0.84.1"],
			["@earendil-works/pi-ai", "0.84.1"],
			["@earendil-works/pi-coding-agent", "0.84.1"],
			["@earendil-works/pi-tui", "0.84.1"],
		]);
		expect(pkg.dependencies.jiti).toBe("2.7.0");
		expect(Object.values(pkg.dependencies).some((value) => value.startsWith("file:"))).toBe(false);
		expect(settings.tuiMode).toBe("fullscreen");
	});

	test("version guard points unsupported hosts to the project launcher", async () => {
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

	test("a filtered attach sends editor text directly once and keeps it out of Pi", async () => {
		const host = makeHost();
		await host.command("attach A");

		const result = await host.input({ text: "hello" });

		expect(result).toEqual({ action: "handled" });
		expect(host.clients[0]!.sendCalls).toEqual([{ botId: "A", text: "hello", requestId: "send-1" }]);
		expect(host.entries).toHaveLength(1);
		expect(host.editorTexts).toHaveLength(0);
		expect(host.statusUpdates.some((update) => update.key === "telegram-compose" && update.text?.includes("SEND AS A"))).toBe(true);
		expect(host.notifies.at(-1)?.text).toContain("#42");
	});

	test("a global multi-bot feed selects with Pi on every scoped send", async () => {
		const host = makeHost({}, { selects: ["B (小雨)", "A (小雪)"] });
		await host.command("attach");
		expect(host.statusUpdates.at(-1)).toEqual({ key: "telegram-compose", text: "TELEGRAM · CHOOSE BOT ON SEND" });

		expect(await host.input({ text: "from B" })).toEqual({ action: "handled" });
		expect(await host.input({ text: "from A" })).toEqual({ action: "handled" });

		expect(host.dialogCalls.filter((call) => call.kind === "select")).toEqual([
			{ kind: "select", title: "Send Telegram message as", options: ["A (小雪)", "B (小雨)"] },
			{ kind: "select", title: "Send Telegram message as", options: ["A (小雪)", "B (小雨)"] },
		]);
		expect(host.clients[0]!.sendCalls).toEqual([
			{ botId: "B", text: "from B", requestId: "send-1" },
			{ botId: "A", text: "from A", requestId: "send-2" },
		]);
	});

	test("canceling Pi bot selection restores exact text and sends nowhere", async () => {
		const host = makeHost({}, { selects: [undefined] });
		await host.command("attach");

		expect(await host.input({ text: "keep exactly" })).toEqual({ action: "handled" });

		expect(host.clients[0]!.sendCalls).toHaveLength(0);
		expect(host.editorTexts.at(-1)).toBe("keep exactly");
		expect(host.notifies.at(-1)?.text).toContain("canceled");
		expect(host.statusUpdates.at(-1)).toEqual({ key: "telegram-compose", text: "TELEGRAM · CHOOSE BOT ON SEND" });
	});

	test("a Pi selector failure is a definite no-send and restores the editor", async () => {
		const host = makeHost({}, { select: async () => { throw new Error("dialog unavailable"); } });
		await host.command("attach");

		expect(await host.input({ text: "safe draft" })).toEqual({ action: "handled" });

		expect(host.clients[0]!.sendCalls).toHaveLength(0);
		expect(host.editorTexts.at(-1)).toBe("safe draft");
		expect(host.notifies.at(-1)?.text).toContain("selection failed");
		expect(host.notifies.at(-1)?.text).not.toContain("unknown");
	});

	test("a global single-bot feed bypasses selection", async () => {
		const root = makeOnboardingRoot();
		try {
			writeFirstRunDeployment(root, {
				groupPeerId: "-1001234567890",
				bot: {
					id: "friend",
					name: "Mochi",
					tokenEnv: "telegram_bot_token",
					token: ONBOARD_TELEGRAM_SECRET,
					personaText: readFileSync(join(root, "personas/template.en.md"), "utf8"),
				},
			}, { nonce: "single-bot-compose" });
			const host = makeHost({ rootDir: root });
			await host.command("attach");

			expect(await host.input({ text: "one identity" })).toEqual({ action: "handled" });
			expect(host.clients[0]!.sendCalls).toEqual([{ botId: "friend", text: "one identity", requestId: "send-1" }]);
			expect(host.dialogCalls.filter((call) => call.kind === "select")).toHaveLength(0);
			expect(host.statusUpdates.some((update) => update.text?.includes("SEND AS friend (Mochi)"))).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("sticky compose, scope compose, compose-off and non-interactive inputs stay distinct", async () => {
		const host = makeHost({}, { selects: ["B (小雨)"] });
		await host.command("attach");
		await host.command("compose nobody");
		expect(host.notifies.at(-1)?.text).toContain("configured bots");

		await host.command("compose A");
		expect(await host.input({ text: "rpc prompt", source: "rpc" })).toEqual({ action: "continue" });
		expect(await host.input({ text: "extension prompt", source: "extension" })).toEqual({ action: "continue" });
		expect(await host.input({ text: "sticky A" })).toEqual({ action: "handled" });
		expect(host.dialogCalls.filter((call) => call.kind === "select")).toHaveLength(0);
		await host.command("compose off");
		expect(await host.input({ text: "back to Pi" })).toEqual({ action: "continue" });
		await host.command("compose");
		expect(await host.input({ text: "scope B" })).toEqual({ action: "handled" });
		expect(host.clients[0]!.sendCalls.map(({ botId, text }) => ({ botId, text }))).toEqual([
			{ botId: "A", text: "sticky A" },
			{ botId: "B", text: "scope B" },
		]);
	});

	test("a late selector result after detach is invalidated and duplicate input is suppressed", async () => {
		let finishSelect: ((value: string | undefined) => void) | undefined;
		const host = makeHost({}, {
			select: async () => await new Promise<string | undefined>((resolve) => { finishSelect = resolve; }),
		});
		await host.command("attach");
		const first = host.input({ text: "do not lose" });
		await Promise.resolve();

		expect(await host.input({ text: "duplicate" })).toEqual({ action: "handled" });
		expect(host.dialogCalls.filter((call) => call.kind === "select")).toHaveLength(1);
		await host.command("detach");
		finishSelect?.("A (小雪)");
		expect(await first).toEqual({ action: "handled" });

		expect(host.clients[0]!.sendCalls).toHaveLength(0);
		expect(host.editorTexts).toContain("do not lose");
		expect(host.notifies.at(-1)?.text).toContain("feed changed");
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

	test("media_ready rebuilds matching photo slots in place with Pi native Image", async () => {
		Tui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const path = writeMediaFixture("png", TINY_PNG);
		const host = makeHost();
		try {
			await host.command("attach A");
			const photo = { ...message, text: null, mediaKind: "photo", fileUniqueId: "ready-photo" };
			host.clients[0]!.emit({
				type: "append",
				items: [photo, { ...photo, messageId: 6, ts: photo.ts + 1 }],
			});
			const feed = host.entries[0]!.component as TelegramFeed;
			const entriesBefore = host.entries.length;
			const rendersBefore = host.renderRequests.count;
			expect((feed as any).items.map((item: { mediaPath?: string | null }) => item.mediaPath ?? null)).toEqual([null, null]);

			host.clients[0]!.emit({ type: "media", fileUniqueId: "ready-photo", mediaPath: path });

			expect((feed as any).items.map((item: { mediaPath?: string | null }) => item.mediaPath ?? null)).toEqual([path, path]);
			expect(host.entries).toHaveLength(entriesBefore);
			expect(host.renderRequests.count).toBeGreaterThan(rendersBefore);
			expect(host.entries[0]!.component.render(80).join("\n")).toContain("\x1b_G");
		} finally {
			host.shutdown();
			unlinkSync(path);
		}
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

	test("Kitty never receives raw WebP and redraws the same feed with converted PNG", async () => {
		Tui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const path = writeMediaFixture("webp", TINY_WEBP);
		let conversionCalls = 0;
		let resolveConversion!: (value: { data: string; mimeType: string } | null) => void;
		const conversion = new Promise<{ data: string; mimeType: string } | null>((resolve) => { resolveConversion = resolve; });
		const cache = new NativeMediaCache(async () => {
			conversionCalls++;
			return await conversion;
		});
		const host = makeHost({ mediaCache: cache });
		try {
			await host.command("attach A");
			host.clients[0]!.emit({
				type: "append",
				items: [
					{ ...message, text: null, mediaKind: "sticker", stickerEmoji: "👋", mediaPath: path },
					{ ...message, messageId: 6, text: "unrelated card" },
				],
			});
			const feed = host.entries[0]!.component as TelegramFeed;
			const content = feed.children[2] as Tui.Container;
			const mediaSlot = content.children[1] as Tui.Container;
			const unrelatedSlot = content.children[3] as Tui.Container;
			const mediaCardBefore = mediaSlot.children[0];
			const unrelatedCardBefore = unrelatedSlot.children[0];
			const firstFrame = feed.render(80).join("\n");
			expect(firstFrame).toContain("[sticker 👋]");
			expect(firstFrame).not.toContain("\x1b_G");
			expect(conversionCalls).toBe(1);
			expect(cache.pendingCount).toBe(1);

			const rendersBeforeCompletion = host.renderRequests.count;
			resolveConversion({ data: TINY_PNG, mimeType: "image/png" });
			await waitForMedia(() => cache.pendingCount === 0);

			const convertedFrame = feed.render(80).join("\n");
			const payload = firstKittyPayload(convertedFrame);
			expect(host.entries).toHaveLength(1);
			expect(host.renderRequests.count).toBeGreaterThan(rendersBeforeCompletion);
			expect(payload).not.toBeNull();
			expect(pngSignature(payload!)).toBe("89504e470d0a1a0a");
			expect(firstKittyPlacement(convertedFrame)).toEqual({ columns: 24, rows: 12 });
			expect(conversionCalls).toBe(1);
			expect(mediaSlot.children[0]).not.toBe(mediaCardBefore);
			expect(unrelatedSlot.children[0]).toBe(unrelatedCardBefore);
		} finally {
			host.shutdown();
			unlinkSync(path);
		}
	});

	test("sticker Image stays compact while photo retains its native detail bounds", () => {
		Tui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const path = writeMediaFixture("png", TINY_PNG);
		try {
			for (const width of [40, 80, 120]) {
				const sticker = itemComponent({
					...message,
					text: null,
					mediaKind: "sticker",
					stickerEmoji: "👋",
					mediaDesc: "挥手贴纸",
					mediaPath: path,
				}, theme).render(width);
				const photo = itemComponent({ ...message, text: null, mediaKind: "photo", mediaPath: path }, theme).render(width);
				expect(firstKittyPlacement(sticker.join("\n"))).toEqual({ columns: 24, rows: 12 });
				expect(firstKittyPlacement(photo.join("\n"))).toEqual({ columns: 32, rows: 16 });
				expect(Tui.stripTerminalSequences(sticker.join("\n"))).toContain("[sticker 👋]");
				expect(Tui.stripTerminalSequences(sticker.join("\n"))).toContain("视觉理解 · 挥手贴纸");
				for (const line of [...sticker, ...photo]) expect(Tui.visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		} finally {
			unlinkSync(path);
		}
	});

	test("JPEG, GIF, and duplicate WebP share conversion state while PNG stays zero-copy", async () => {
		Tui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const paths = [
			writeMediaFixture("webp", TINY_WEBP),
			writeMediaFixture("jpg", TINY_JPEG),
			writeMediaFixture("gif", TINY_GIF),
			writeMediaFixture("png", TINY_PNG),
		];
		const convertedMimes: string[] = [];
		const cache = new NativeMediaCache(async (_data, mime) => {
			convertedMimes.push(mime);
			return { data: TINY_PNG, mimeType: "image/png" };
		});
		const host = makeHost({ mediaCache: cache });
		try {
			await host.command("attach A");
			const mediaBase = { ...message, text: null, mediaKind: "photo", fileUniqueId: "same-revision" };
			host.clients[0]!.emit({
				type: "append",
				items: [
					{ ...mediaBase, messageId: 20, mediaPath: paths[0] },
					{ ...mediaBase, messageId: 21, mediaPath: paths[0] },
					{ ...mediaBase, messageId: 22, mediaPath: paths[1] },
					{ ...mediaBase, messageId: 23, mediaPath: paths[2] },
					{ ...mediaBase, messageId: 24, mediaPath: paths[3] },
				],
			});
			await waitForMedia(() => cache.pendingCount === 0);
			expect(convertedMimes.sort()).toEqual(["image/gif", "image/jpeg", "image/webp"]);

			// Vision rebuild, history prepend, repeated widths, and duplicate cards all reuse the same revisions.
			host.clients[0]!.emit({ type: "vision", fileUniqueId: "same-revision", text: "媒体描述" });
			host.clients[0]!.emit({
				type: "prepend",
				items: [{ ...mediaBase, messageId: 19, ts: mediaBase.ts - 1, mediaPath: paths[0] }],
			});
			host.entries[0]!.component.render(40);
			host.entries[0]!.component.render(120);
			expect(convertedMimes).toHaveLength(3);
			expect(host.entries[0]!.component.render(80).join("\n").match(/\x1b_G/g)?.length).toBe(6);
		} finally {
			host.shutdown();
			for (const path of paths) unlinkSync(path);
		}
	});

	test("Pi capability detection owns Ghostty, iTerm2, tmux, and unsupported decisions", () => {
		const keys = [
			"TERM_PROGRAM",
			"TERMINAL_EMULATOR",
			"TERM",
			"COLORTERM",
			"TMUX",
			"KITTY_WINDOW_ID",
			"GHOSTTY_RESOURCES_DIR",
			"WEZTERM_PANE",
			"WARP_SESSION_ID",
			"WARP_TERMINAL_SESSION_UUID",
			"ITERM_SESSION_ID",
			"WT_SESSION",
		] as const;
		const saved = new Map(keys.map((key) => [key, process.env[key]]));
		const detect = (values: Partial<Record<(typeof keys)[number], string>>) => {
			for (const key of keys) delete process.env[key];
			for (const [key, value] of Object.entries(values)) process.env[key] = value;
			return Tui.detectCapabilities(() => false);
		};
		try {
			expect(detect({ TERM_PROGRAM: "ghostty" }).images).toBe("kitty");
			expect(detect({ GHOSTTY_RESOURCES_DIR: "/Applications/Ghostty.app" }).images).toBe("kitty");
			expect(detect({ TERM_PROGRAM: "ghostty", TMUX: "/tmp/tmux", TERM: "tmux-256color" }).images).toBeNull();
			expect(detect({ TERM_PROGRAM: "iTerm.app" }).images).toBe("iterm2");
			expect(detect({ TERM_PROGRAM: "unknown" }).images).toBeNull();
			const source = readFileSync(join(import.meta.dir, "../.pi/extensions/tg-extension.ts"), "utf8");
			expect(source).not.toMatch(/TERM_PROGRAM|GHOSTTY_RESOURCES_DIR|KITTY_WINDOW_ID/);
			expect(source).toContain("Tui.getCapabilities()");
		} finally {
			for (const key of keys) {
				const value = saved.get(key);
				if (value == null) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	test("iTerm2 and image-null paths keep Pi's raw Image behavior without conversion", () => {
		const path = writeMediaFixture("webp", TINY_WEBP);
		let calls = 0;
		const item = { ...message, kind: "msg" as const, mediaKind: "sticker", mediaPath: path };
		try {
			for (const images of ["iterm2", null] as const) {
				const cache = new NativeMediaCache(
					async () => { calls++; return { data: TINY_PNG, mimeType: "image/png" }; },
					() => ({ images, trueColor: true, hyperlinks: true }),
				);
				const resolved = cache.resolve(item);
				expect(resolved?.mime).toBe("image/webp");
				const card = itemComponent(item, theme, (candidate) => cache.resolve(candidate)) as Tui.Box;
				expect(card.children.some((child) => child instanceof Tui.Image)).toBe(true);
				expect(cache.pendingCount).toBe(0);
			}
			const unavailable = new NativeMediaCache(
				async () => { calls++; return { data: TINY_PNG, mimeType: "image/png" }; },
				() => { throw new Error("capability probe failed"); },
			);
			expect(unavailable.resolve(item)).toBeNull();
			expect(unavailable.pendingCount).toBe(0);
			expect(calls).toBe(0);
		} finally {
			unlinkSync(path);
		}
	});

	test("unsupported WebM remains a readable text fallback without conversion", () => {
		const path = writeMediaFixture("webm", TINY_WEBP);
		let calls = 0;
		const cache = new NativeMediaCache(
			async () => { calls++; return { data: TINY_PNG, mimeType: "image/png" }; },
			() => ({ images: "kitty", trueColor: true, hyperlinks: true }),
		);
		try {
			const item = { ...message, kind: "msg" as const, text: null, mediaKind: "sticker", stickerEmoji: "🎞", mediaPath: path };
			const card = itemComponent(item, theme, (candidate) => cache.resolve(candidate)) as Tui.Box;
			const rendered = card.render(80).join("\n");
			expect(rendered).toContain("[sticker 🎞]");
			expect(rendered).not.toContain("\x1b_G");
			expect(card.children.some((child) => child instanceof Tui.Image)).toBe(false);
			expect(calls).toBe(0);
		} finally {
			unlinkSync(path);
		}
	});

	test("converter rejection, null, invalid PNG, and oversized output are remembered without loops", async () => {
		const path = writeMediaFixture("webp", TINY_WEBP);
		const kitty = () => ({ images: "kitty" as const, trueColor: true, hyperlinks: true });
		try {
			const converters = [
				async () => { throw new Error("decode failed"); },
				async () => null,
				async () => ({ data: Buffer.from("not png").toString("base64"), mimeType: "image/png" }),
				async () => ({ data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"), mimeType: "image/png" }),
				async () => ({ data: `${TINY_PNG}${"A".repeat(MEDIA_CACHE_MAX_ITEM_BASE64_BYTES)}`, mimeType: "image/png" }),
			];
			for (const converter of converters) {
				let calls = 0;
				const cache = new NativeMediaCache(async () => { calls++; return await converter(); }, kitty);
				const item = { ...message, kind: "msg" as const, mediaKind: "sticker", mediaPath: path };
				expect(cache.resolve(item)).toBeNull();
				await waitForMedia(() => cache.pendingCount === 0);
				expect(cache.resolve(item)).toBeNull();
				expect(calls).toBe(1);
				expect(cache.totalBase64Bytes).toBe(0);
				const card = itemComponent(item, theme, (candidate) => cache.resolve(candidate)) as Tui.Box;
				const rendered = card.render(80).join("\n");
				expect(rendered).toContain("[sticker]");
				expect(rendered).not.toContain("\x1b_G");
				expect(card.children.some((child) => child instanceof Tui.Image)).toBe(false);
			}
		} finally {
			unlinkSync(path);
		}
	});

	test("a file replacement invalidates an in-flight conversion and retries only the new revision", async () => {
		const path = writeMediaFixture("webp", TINY_WEBP);
		let calls = 0;
		let resolveFirst!: (value: { data: string; mimeType: string } | null) => void;
		const first = new Promise<{ data: string; mimeType: string } | null>((resolve) => { resolveFirst = resolve; });
		const cache = new NativeMediaCache(
			async () => ++calls === 1 ? await first : { data: TINY_PNG, mimeType: "image/png" },
			() => ({ images: "kitty", trueColor: true, hyperlinks: true }),
		);
		const item = { ...message, kind: "msg" as const, mediaKind: "sticker", mediaPath: path };
		let notifications = 0;
		try {
			expect(cache.resolve(item, () => { notifications++; })).toBeNull();
			writeFileSync(path, Buffer.concat([Buffer.from(TINY_WEBP, "base64"), Buffer.from([0])]));
			resolveFirst({ data: TINY_PNG, mimeType: "image/png" });
			await waitForMedia(() => cache.pendingCount === 0);
			expect(notifications).toBe(1);
			expect(cache.resolve(item)).toBeNull();
			await waitForMedia(() => cache.pendingCount === 0);
			expect(cache.resolve(item)?.mime).toBe("image/png");
			expect(calls).toBe(2);
		} finally {
			unlinkSync(path);
		}
	});

	test("completed and pending media state obey exact production bounds and LRU eviction", async () => {
		const defaults = new NativeMediaCache();
		expect(defaults.limits).toEqual({
			maxEntries: MEDIA_CACHE_MAX_ENTRIES,
			maxTotalBase64Bytes: MEDIA_CACHE_MAX_BASE64_BYTES,
			maxItemBase64Bytes: MEDIA_CACHE_MAX_ITEM_BASE64_BYTES,
			maxPending: MEDIA_CONVERSION_MAX_PENDING,
		});

		const paths = [writeMediaFixture("webp", TINY_WEBP), writeMediaFixture("webp", TINY_WEBP), writeMediaFixture("webp", TINY_WEBP)];
		let calls = 0;
		const cache = new NativeMediaCache(
			async () => { calls++; return { data: TINY_PNG, mimeType: "image/png" }; },
			() => ({ images: "kitty", trueColor: true, hyperlinks: true }),
			{ maxEntries: 2, maxTotalBase64Bytes: TINY_PNG.length * 2, maxItemBase64Bytes: TINY_PNG.length },
		);
		try {
			for (let index = 0; index < paths.length; index++) {
				cache.resolve({ ...message, kind: "msg", messageId: 100 + index, mediaKind: "sticker", mediaPath: paths[index] });
			}
			await waitForMedia(() => cache.pendingCount === 0);
			expect(cache.size).toBe(2);
			expect(cache.totalBase64Bytes).toBeLessThanOrEqual(TINY_PNG.length * 2);
			expect(calls).toBe(3);

			// The oldest revision was evicted, so only that revision needs a new conversion.
			expect(cache.resolve({ ...message, kind: "msg", messageId: 200, mediaKind: "sticker", mediaPath: paths[0] })).toBeNull();
			await waitForMedia(() => cache.pendingCount === 0);
			expect(calls).toBe(4);
		} finally {
			for (const path of paths) unlinkSync(path);
		}

		const pendingPaths = [writeMediaFixture("webp", TINY_WEBP), writeMediaFixture("webp", TINY_WEBP), writeMediaFixture("webp", TINY_WEBP)];
		const releases: Array<(value: { data: string; mimeType: string }) => void> = [];
		let pendingCalls = 0;
		const pendingCache = new NativeMediaCache(
			async () => {
				pendingCalls++;
				return await new Promise<{ data: string; mimeType: string }>((resolve) => releases.push(resolve));
			},
			() => ({ images: "kitty", trueColor: true, hyperlinks: true }),
			{ maxPending: 2 },
		);
		try {
			for (let index = 0; index < pendingPaths.length; index++) {
				pendingCache.resolve({ ...message, kind: "msg", messageId: 300 + index, mediaKind: "sticker", mediaPath: pendingPaths[index] });
			}
			expect(pendingCache.pendingCount).toBe(2);
			expect(pendingCalls).toBe(2);
			for (const release of releases) release({ data: TINY_PNG, mimeType: "image/png" });
			await waitForMedia(() => pendingCache.pendingCount === 0);
		} finally {
			for (const path of pendingPaths) unlinkSync(path);
		}
	});

	test("detach invalidates old callbacks while a new feed reuses completed PNG", async () => {
		Tui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const path = writeMediaFixture("webp", TINY_WEBP);
		let calls = 0;
		let resolveConversion!: (value: { data: string; mimeType: string } | null) => void;
		const conversion = new Promise<{ data: string; mimeType: string } | null>((resolve) => { resolveConversion = resolve; });
		const cache = new NativeMediaCache(async () => { calls++; return await conversion; });
		const host = makeHost({ mediaCache: cache });
		const mediaItem = { ...message, kind: "msg" as const, text: null, mediaKind: "sticker", mediaPath: path };
		try {
			await host.command("attach A");
			host.clients[0]!.emit({ type: "append", items: [mediaItem] });
			await host.command("detach");
			const rendersAfterDetach = host.renderRequests.count;
			resolveConversion({ data: TINY_PNG, mimeType: "image/png" });
			await waitForMedia(() => cache.pendingCount === 0);
			expect(host.renderRequests.count).toBe(rendersAfterDetach);

			await host.command("attach A");
			host.clients[1]!.emit({ type: "append", items: [{ ...mediaItem, messageId: 6 }] });
			expect(host.entries[1]!.component.render(80).join("\n")).toContain("\x1b_G");
			expect(calls).toBe(1);
		} finally {
			host.shutdown();
			unlinkSync(path);
		}
	});

	test("restart ignores the old conversion callback and rebuilds retained cards from the shared cache", async () => {
		Tui.setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const path = writeMediaFixture("webp", TINY_WEBP);
		let conversionCalls = 0;
		let resolveConversion!: (value: { data: string; mimeType: string } | null) => void;
		const conversion = new Promise<{ data: string; mimeType: string } | null>((resolve) => { resolveConversion = resolve; });
		let resolveRestart!: (value: { status: number; stdout: string; stderr: string }) => void;
		const restart = new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => { resolveRestart = resolve; });
		const cache = new NativeMediaCache(async () => { conversionCalls++; return await conversion; });
		const host = makeHost({ mediaCache: cache, processRunner: async () => await restart });
		try {
			await host.command("attach A");
			host.clients[0]!.emit({
				type: "append",
				items: [{ ...message, text: null, mediaKind: "sticker", mediaPath: path }],
			});
			const restartCommand = host.command("restart");
			const rendersWhileRestarting = host.renderRequests.count;
			resolveConversion({ data: TINY_PNG, mimeType: "image/png" });
			await waitForMedia(() => cache.pendingCount === 0);
			expect(host.renderRequests.count).toBe(rendersWhileRestarting);

			resolveRestart({ status: 0, stdout: "daemon ready (pid 900)", stderr: "" });
			await restartCommand;
			expect(host.clients).toHaveLength(2);
			expect(host.entries[0]!.component.render(80).join("\n")).toContain("\x1b_G");
			expect(conversionCalls).toBe(1);
		} finally {
			host.shutdown();
			unlinkSync(path);
		}
	});

	test("Pi's real converter turns the repository WebP fixture into a 2x2 PNG", async () => {
		const converted = await convertToPng(TINY_WEBP, "image/webp");
		expect(converted?.mimeType).toBe("image/png");
		expect(pngSignature(converted!.data)).toBe("89504e470d0a1a0a");
		expect(Tui.getPngDimensions(converted!.data)).toEqual({ widthPx: 2, heightPx: 2 });
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
