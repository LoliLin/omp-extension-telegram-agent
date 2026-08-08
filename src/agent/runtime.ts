// BotRuntime: one persona bot = one Pi AgentSession + send tool + exposure tracking.
// See docs/architecture.md and docs/research.md.

import type { Database } from "bun:sqlite";
import { readFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	serializeConversation,
	type AgentSession,
	type AgentSessionEvent,
	type CompactionResult,
	type ExtensionAPI,
	type ModelRuntime,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BotConfig, AppConfig } from "../config.ts";
import { getBotState, setBotState } from "../db/db.ts";
import { BotApi, TelegramApiError } from "../telegram/api.ts";
import { TelegramTypingLease, type ActivityScheduler } from "../telegram/activity.ts";
import { insertSentMessage } from "../telegram/ingest.ts";
import { sendRichTextAndPersist } from "../telegram/send.ts";
import { serializeMessages, type MessageRow } from "./serialize.ts";
import { buildSystemPrompt, sha256Short, CACHE_SCHEMA_VERSION, COMPACTION_SUMMARY_PROMPT } from "./prompt.ts";
import { successfulSendResult, TOOL_DEFS, toolProtocolHash, toolsHash, type SendParams } from "./tools.ts";
import { tinyFishSearch, formatSearchResults } from "../tools/search.ts";
import { runJs } from "../tools/run-js.ts";
import { ensureVision, fileIdForBot, type VisionUpdateSink } from "../media/vision.ts";
import { ensureStickerCatalog, stickerCatalogBlock, preRecognizeCatalogVision } from "../media/sticker-catalog.ts";
import type { TriggerResult, TriggerSource } from "./router.ts";
import type { AgentStreamFrame, AgentStreamToolCall } from "../ipc.ts";

const MAX_CATCHUP_MESSAGES = 40; // per trigger; older unexposed messages are skipped
const EXPOSED_KEY = "exposed_ids";
const EPOCH_KEY = "context_epoch";
const STREAM_TEXT_MAX = 4096;
const STREAM_TOOL_ARGS_MAX = 2048;
const STREAM_TOOLS_MAX = 4;

function boundedDisplay(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function displayJson(value: unknown): string {
	try {
		return JSON.stringify(value ?? {}) ?? "{}";
	} catch {
		return "[unserializable arguments]";
	}
}

export class BotRuntime {
	private db: Database;
	private bot: BotConfig;
	private config: AppConfig;
	private modelRuntime: ModelRuntime;
	private api: BotApi;
	private session: AgentSession | null = null;
	private model: ReturnType<ModelRuntime["getModel"]>; // resolved in init(); used by the compaction extension
	private running = false;
	// Flush state machine (REQ-AGENT-0001): `flushing` is owned locally and set synchronously
	// at trigger time — never gated on SDK events. While flushing, triggers only coalesce
	// into `pendingTrigger`; the flush loop drains it (burst-merge semantics unchanged).
	private flushing = false;
	private pendingTrigger = false;
	private stopping = false;
	private flushPromise: Promise<void> | null = null;
	private cooldownUntil = 0;
	private cooldownAfterFlush = false;
	private readonly monotonicNow: () => number;
	private exposed = new Set<number>();
	private epoch = 1;
	private runStartTs = 0;
	private systemHash = "";
	private toolsHash = "";
	private streamSequence = 0;
	private activeStreamId: string | null = null;
	private readonly typingLease: TelegramTypingLease;
	/** Optional sink for TUI/live broadcasting of agent events. */
	eventSink: ((kind: string, payload: unknown) => void) | null = null;
	/** Optional sink for messages this bot sent (poller echo dedupes them, so TUI needs this path). */
	sentMessageSink: ((rawMsg: unknown) => void) | null = null;
	/** Optional sink for llm_run telemetry (REQ-UI-0003: live usage push). */
	usageSink: ((run: {
		id: number;
		botId: string;
		ts: number;
		model: string;
		epoch: number;
		contextTokens: number;
		cacheRead: number;
		cacheWrite: number;
		cacheMiss: number;
		outputTokens: number;
		reasoningTokens: number;
		latencyMs: number | null;
		cost: number;
	}) => void) | null = null;
	/** Optional sink for newly persisted media descriptions (REQ-UI-0006). */
	visionSink: VisionUpdateSink | null = null;
	/** Ephemeral Pi-feed assistant snapshots; never persisted (REQ-UI-0010). */
	streamSink: ((frame: AgentStreamFrame) => void) | null = null;
	/** Lets the daemon avoid building snapshots when no matching listener completed hello. */
	streamDemand: (() => boolean) | null = null;

	constructor(
		db: Database,
		bot: BotConfig,
		config: AppConfig,
		modelRuntime: ModelRuntime,
		options: {
			monotonicNow?: () => number;
			activityScheduler?: ActivityScheduler;
			chatActionSender?: () => Promise<unknown>;
		} = {},
	) {
		this.db = db;
		this.bot = bot;
		this.config = config;
		this.modelRuntime = modelRuntime;
		this.monotonicNow = options.monotonicNow ?? (() => performance.now());
		this.api = new BotApi(bot.token);
		const chatId = Number(`-100${config.groupPeerId}`);
		this.typingLease = new TelegramTypingLease(
			options.chatActionSender ?? (() => this.api.sendChatAction(chatId)),
			{
				scheduler: options.activityScheduler,
				onFailure: (error) => {
					const category = error instanceof TelegramApiError
						? `telegram_${error.code}`
						: typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "TimeoutError"
							? "timeout"
							: "request_failed";
					console.warn(`[chat-action] bot=${this.bot.id} typing failed (${category}); will retry`);
				},
			},
		);
		this.exposed = new Set(JSON.parse(getBotState(db, bot.id, EXPOSED_KEY) ?? "[]") as number[]);
		this.epoch = Number(getBotState(db, bot.id, EPOCH_KEY) ?? "1");
	}

	get botUserId(): number {
		return Number(getBotState(this.db, this.bot.id, "bot_user_id") ?? "0");
	}

	get botUsername(): string {
		return getBotState(this.db, this.bot.id, "bot_username") ?? "";
	}

	async init(): Promise<void> {
		const persona = readFileSync(this.bot.personaPath, "utf8");
		// Fixed sticker catalog first: it serializes into the STABLE prefix, so it must be
		// resolved (sets fetched, short_ids assigned, vision pre-recognized) before the
		// system prompt is built (REQ-STICKER-0001 R1/R2). Empty for bots without sets.
		let stickerCatalog = "";
		if (this.bot.stickerSets.length > 0) {
			// fetch + persist + short_ids block startup (seconds); vision pre-recognition runs in
			// the background so the poller is never held offline for minutes (REQ-STICKER-0001 R1)
			await ensureStickerCatalog(this.db, this.api, this.bot.id, this.bot.stickerSets);
			preRecognizeCatalogVision(
				this.db,
				this.api,
				this.bot.id,
				this.bot.stickerSets,
				this.config.auxiliaryVisualModel,
				(fileUniqueId, text) => this.visionSink?.(fileUniqueId, text),
			);
			stickerCatalog = stickerCatalogBlock(this.db, this.bot.id, this.bot.stickerSets);
		}
		const systemPrompt = buildSystemPrompt(persona, stickerCatalog);
		this.systemHash = sha256Short(systemPrompt);

		const sessionsDir = join(this.config.dataDir, "sessions", this.bot.id);
		mkdirSync(sessionsDir, { recursive: true });
		const hasSession = readdirSync(sessionsDir).some((f) => f.endsWith(".jsonl"));
		const sessionManager = hasSession
			? SessionManager.continueRecent(this.config.dataDir, sessionsDir)
			: SessionManager.create(this.config.dataDir, sessionsDir);

		const sendTool = {
			name: "send",
			label: "Send",
			description: TOOL_DEFS[0].description,
			parameters: TOOL_DEFS[0].parameters,
			execute: async (_toolCallId: string, params: SendParams) => {
				return await this.executeSend(params);
			},
		};
		const searchTool = {
			name: "search",
			label: "Search",
			description: TOOL_DEFS[1].description,
			parameters: TOOL_DEFS[1].parameters,
			execute: async (_toolCallId: string, params: { query: string }) => {
				try {
					const hits = await tinyFishSearch(this.config.tinyfishApiKey, params.query);
					this.recordEvent("tool_search", { query: params.query, hits: hits.length });
					return {
						content: [{ type: "text" as const, text: formatSearchResults(hits) }],
						details: { query: params.query, hits: hits.length },
					};
				} catch (err) {
					// structured failure back to the model; never let a hung upstream wedge the turn (R6)
					const error = err instanceof Error ? err.message : String(err);
					this.recordEvent("error", { stage: "tool_search", error });
					return {
						content: [{ type: "text" as const, text: `search failed: ${error}` }],
						details: { query: params.query, error },
					};
				}
			},
		};
		const runJsTool = {
			name: "run_js",
			label: "Run JS",
			description: TOOL_DEFS[2].description,
			parameters: TOOL_DEFS[2].parameters,
			execute: async (_toolCallId: string, params: { code: string }) => {
				const result = await runJs(params.code);
				this.recordEvent("tool_run_js", { ok: result.ok, durationMs: result.durationMs });
				return {
					content: [{ type: "text" as const, text: result.output || "(no output)" }],
					details: { ok: result.ok, durationMs: result.durationMs },
				};
			},
		};
		// Tool order is cache-visible protocol: never reorder (docs/cache.md, REQ-TEST-0001 R2).
		const tools = [sendTool, searchTool, runJsTool];
		this.toolsHash = toolsHash(); // full protocol hash; filtered per-bot hash computed below

		const model = this.modelRuntime.getModel("deepseek", this.bot.model);
		if (!model) throw new Error(`model not found: deepseek/${this.bot.model}`);
		this.model = model;

		// Custom compaction: chat-oriented summary (state, not replay), threshold from config.
		// Pi's trigger formula is contextTokens > contextWindow - reserveTokens, so reserve = window - threshold.
		const threshold = this.bot.compactionThreshold;
		const reserveTokens = Math.max(16_384, model.contextWindow - threshold);
		const compactionExt = {
			name: "tg-compaction",
			hidden: true,
			factory: (pi: ExtensionAPI) => {
				pi.on("session_before_compact", (event: SessionBeforeCompactEvent) => this.handleBeforeCompact(event));
			},
		};

		const loader = new DefaultResourceLoader({
			cwd: this.config.dataDir,
			agentDir: join(this.config.dataDir, "pi-agent"),
			systemPrompt,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
			extensionFactories: [compactionExt],
		});
		await loader.reload();

		// Per-bot tool toggles (REQ-CONF-0001): filter the fixed-order tool list. send off
		// means the bot cannot speak in-group (observer-only); search/run_js off saves tokens.
		const activeTools = [sendTool, searchTool, runJsTool].filter((t) =>
			t.name === "send" ? this.bot.tools.send : t.name === "search" ? this.bot.tools.search : this.bot.tools.runJs,
		);
		if (activeTools.length < tools.length) {
			// telemetry hash reflects what THIS bot's provider actually sees
			this.toolsHash = toolProtocolHash(activeTools);
		}

		const { session } = await createAgentSession({
			cwd: this.config.dataDir,
			model,
			thinkingLevel: this.bot.reasoningEffort as "medium",
			modelRuntime: this.modelRuntime,
			sessionManager,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens, keepRecentTokens: this.bot.compactionKeepRecent } }),
			resourceLoader: loader,
			noTools: "builtin",
			customTools: activeTools,
		});
		this.session = session;
		this.subscribeEvents();
		console.log(
			`[bot ${this.bot.id}] session ready (${hasSession ? "resumed" : "new"}), epoch=${this.epoch}, system=${this.systemHash}, tools=${this.toolsHash}, cache_schema=v${CACHE_SCHEMA_VERSION}`,
		);
	}

	private subscribeEvents(): void {
		if (!this.session) return;
		this.session.subscribe((event) => {
			const now = Date.now();
			switch (event.type) {
				case "agent_start":
					this.running = true;
					this.runStartTs = now;
					break;
				case "message_start":
					if (event.message.role === "assistant") {
						this.beginAssistantStream(now);
						this.updateAssistantStream(event.message, now);
					}
					break;
				case "message_update":
					if (event.message.role === "assistant") this.updateAssistantStream(event.message, now);
					break;
				case "message_end": {
					const msg = event.message;
					if (msg.role === "assistant") {
						this.endAssistantStream(now);
						const text = msg.content
							.filter((c) => c.type === "text")
							.map((c) => (c as { text: string }).text)
							.join("\n");
						const thinking = msg.content
							.filter((c) => c.type === "thinking")
							.map((c) => (c as { thinking: string }).thinking)
							.join("\n");
						if (text.trim()) this.recordEvent("assistant_text", { text });
						if (thinking.trim()) this.recordEvent("thinking", { text: thinking });
						if (msg.usage) this.recordUsage(msg.usage, now);
					}
					break;
				}
				case "agent_end":
					this.endAssistantStream(now);
					break;
				case "tool_execution_start":
					this.recordEvent("tool_call", { tool: event.toolName, args: event.args });
					break;
				case "tool_execution_end":
					this.recordEvent("tool_result", { tool: event.toolName, isError: event.isError });
					break;
				case "agent_settled":
					this.running = false;
					this.endAssistantStream(now);
					// no flush re-trigger here: the flush loop owns pendingTrigger (REQ-AGENT-0001 R1)
					break;
				case "compaction_end":
					this.onCompactionEnd(event);
					break;
			}
		});
	}

	private beginAssistantStream(now: number): void {
		this.endAssistantStream(now);
		const streamId = `${this.bot.id}-${++this.streamSequence}`;
		this.activeStreamId = streamId;
		if (!this.wantsAssistantStream()) return;
		this.streamSink?.({
			phase: "start",
			streamId,
			botId: this.bot.id,
			botName: this.bot.name,
			ts: now,
		});
	}

	private updateAssistantStream(
		message: Extract<AgentSessionEvent, { type: "message_update" }>["message"],
		now: number,
	): void {
		if (message.role !== "assistant") return;
		if (!this.activeStreamId) this.beginAssistantStream(now);
		const streamId = this.activeStreamId;
		if (!streamId || !this.wantsAssistantStream()) return;
		const text = message.content
			.filter((content) => content.type === "text")
			.map((content) => content.text)
			.join("\n");
		const thinking = message.content
			.filter((content) => content.type === "thinking")
			.map((content) => content.thinking)
			.join("\n");
		const toolCalls: AgentStreamToolCall[] = message.content
			.filter((content) => content.type === "toolCall")
			.slice(0, STREAM_TOOLS_MAX)
			.map((content) => ({
				name: boundedDisplay(content.name, 80),
				arguments: boundedDisplay(displayJson(content.arguments), STREAM_TOOL_ARGS_MAX),
			}));
		if (!text && !thinking && toolCalls.length === 0) return;
		this.streamSink?.({
			phase: "update",
			streamId,
			botId: this.bot.id,
			botName: this.bot.name,
			ts: now,
			text: boundedDisplay(text, STREAM_TEXT_MAX),
			thinking: boundedDisplay(thinking, STREAM_TEXT_MAX),
			toolCalls,
		});
	}

	private endAssistantStream(now = Date.now()): void {
		const streamId = this.activeStreamId;
		if (!streamId) return;
		this.activeStreamId = null;
		if (!this.wantsAssistantStream()) return;
		this.streamSink?.({
			phase: "end",
			streamId,
			botId: this.bot.id,
			botName: this.bot.name,
			ts: now,
		});
	}

	private wantsAssistantStream(): boolean {
		return this.streamSink != null && (this.streamDemand?.() ?? true);
	}

	/**
	 * Compaction ended. Only a successful compaction (result present, not aborted) starts a
	 * new epoch and resets exposure; failure/abort leaves epoch and exposure untouched (R4).
	 */
	private onCompactionEnd(event: Extract<AgentSessionEvent, { type: "compaction_end" }>): void {
		if (event.aborted || !event.result) {
			this.recordEvent("error", { stage: "compaction", reason: event.reason, aborted: event.aborted, error: event.errorMessage ?? null });
			console.log(`[bot ${this.bot.id}] compaction ${event.aborted ? "aborted" : "failed"} (${event.reason}): ${event.errorMessage ?? "no error message"}`);
			return;
		}
		this.epoch += 1;
		setBotState(this.db, this.bot.id, EPOCH_KEY, String(this.epoch));
		this.exposed.clear();
		// Re-mark exactly the telegram messages that survive inside the kept tail (R5) —
		// derived from the entries the provider actually sees, not a count heuristic.
		const kept = this.keptTailMessageIds();
		this.markExposed(kept);
		this.recordEvent("compaction", { epoch: this.epoch, kept: kept.length });
		console.log(`[bot ${this.bot.id}] compaction -> epoch ${this.epoch}, kept tail ${kept.length} msgs`);
	}

	/**
	 * Ids of telegram messages still visible in context after compaction, parsed out of the
	 * user-message entries in the session's current context (compaction entry + kept tail +
	 * post-compaction entries). The SDK does not map session entries back to telegram ids, so
	 * we parse our own serialization grammar (`[HH:MM:SS] #<id> ` at line start) — the same
	 * bytes the provider sees. Known limit: a chat message whose text contains a newline
	 * followed by a forged `[HH:MM:SS] #<id> ` line would be mis-marked exposed (accepted;
	 * assistant/tool/custom entries are never parsed, so the model cannot inject these).
	 */
	private keptTailMessageIds(): number[] {
		if (!this.session) return [];
		const ids = new Set<number>();
		for (const entry of this.session.sessionManager.buildContextEntries()) {
			if (entry.type !== "message" || entry.message.role !== "user") continue;
			const content = entry.message.content;
			const text =
				typeof content === "string"
					? content
					: (content ?? [])
							.filter((c) => c.type === "text")
							.map((c) => (c as { text: string }).text)
							.join("\n");
			for (const m of text.matchAll(/^\[\d{2}:\d{2}:\d{2}\] #(\d+) /gm)) ids.add(Number(m[1]));
		}
		return [...ids];
	}

	/** session_before_compact handler: empty summary is refused via cancel, never persisted. */
	private async handleBeforeCompact(event: SessionBeforeCompactEvent): Promise<{ cancel: true } | { compaction: CompactionResult }> {
		const prep = event.preparation;
		const gen = await this.generateCompactionSummary(prep);
		if (!gen) {
			// NOTE: the SDK swallows extension handler exceptions and would silently fall back
			// to the default summarizer, so refusal goes through cancel -> compaction_end { aborted: true }.
			this.recordEvent("error", { stage: "compaction", error: "empty summary" });
			return { cancel: true };
		}
		return {
			compaction: {
				summary: gen.summary,
				firstKeptEntryId: prep.firstKeptEntryId,
				tokensBefore: prep.tokensBefore,
				usage: gen.usage,
			},
		};
	}

	/** Chat-oriented compaction summary via the aux model. Null when the model returns empty text. */
	private async generateCompactionSummary(
		prep: SessionBeforeCompactEvent["preparation"],
	): Promise<{ summary: string; usage: Awaited<ReturnType<ModelRuntime["completeSimple"]>>["usage"] } | null> {
		const conversation = serializeConversation(prep.messagesToSummarize as never);
		const userText =
			`<conversation>\n${conversation}\n</conversation>\n\n` +
			(prep.previousSummary
				? `<previous-summary>\n${prep.previousSummary}\n</previous-summary>\n\n把上面的旧摘要与新内容合并成一份更新的摘要。`
				: "请输出摘要。");
		const result = await this.modelRuntime.completeSimple(
			this.model as never,
			{
				systemPrompt: COMPACTION_SUMMARY_PROMPT,
				messages: [{ role: "user", content: userText, timestamp: Date.now() }],
			},
			{ cacheRetention: "none", maxTokens: 4096 },
		);
		const summary = result.content
			.filter((c: { type: string }) => c.type === "text")
			.map((c: unknown) => (c as { text: string }).text)
			.join("\n");
		if (!summary.trim()) return null;
		return { summary, usage: result.usage };
	}

	private async executeSend(params: SendParams) {
		if (!params.message && !params.sticker) {
			throw new Error("send requires at least one of message or sticker");
		}
		if (params.reply_to != null && !this.exposed.has(params.reply_to)) {
			throw new Error("messaging.reply_not_visible");
		}
		// Validate everything (incl. sticker resolution) before any network send (R7):
		// a late sticker failure would make the model retry and double-send the text.
		let stickerFileId: string | null = null;
		if (params.sticker) {
			const row = this.db.query("SELECT file_unique_id FROM media WHERE short_id = ?").get(params.sticker) as
				| { file_unique_id: string }
				| null;
			if (!row) throw new Error(`unknown sticker id: ${params.sticker} (use one from the Available stickers list)`);
			stickerFileId = fileIdForBot(this.db, this.bot.id, row.file_unique_id);
			if (!stickerFileId) {
				this.recordEvent("error", { stage: "send", code: "candidate_invariant", sticker: params.sticker });
				throw new Error(`candidate invariant violated: sticker ${params.sticker} is not sendable by this bot (no file_id)`);
			}
		}
		const chatId = Number(`-100${this.config.groupPeerId}`);
		const sentIds: number[] = [];
		if (params.message) {
			const { raw, canonical, transport } = await sendRichTextAndPersist(
				this.db,
				this.api,
				this.bot.id,
				chatId,
				params.message,
				params.reply_to,
			);
			sentIds.push(canonical.message_id);
			this.markExposed([canonical.message_id]);
			this.sentMessageSink?.(raw);
			this.recordEvent(transport === "rich" ? "rich_sent" : "plain_fallback", {
				message_id: canonical.message_id,
			});
		}
		if (stickerFileId) {
			const m = await this.api.sendSticker(chatId, stickerFileId, params.reply_to);
			const canonical = insertSentMessage(this.db, this.bot.id, m);
			sentIds.push(canonical.message_id);
			this.markExposed([canonical.message_id]);
			this.sentMessageSink?.(m);
		}
		this.recordEvent("send", { reply_to: params.reply_to ?? null, sticker: params.sticker ?? null, sent: sentIds });
		this.typingLease.stop();
		return successfulSendResult(sentIds);
	}

	/** Lifecycle state used only by deterministic probability scheduling. */
	samplingState(now = this.monotonicNow()): "idle" | "busy" | "cooldown" | "stopping" {
		if (this.stopping) return "stopping";
		if (this.flushing) return "busy";
		if (now < this.cooldownUntil) return "cooldown";
		return "idle";
	}

	isAvailableForSampling(now = this.monotonicNow()): boolean {
		return this.samplingState(now) === "idle";
	}

	/** Called by the scheduler when this bot gets a response opportunity. */
	trigger(source: TriggerSource = "explicit"): TriggerResult {
		const state = this.samplingState();
		if (state === "stopping") return "skipped_stopping";
		if (source === "probability" && state !== "idle") {
			return state === "busy" ? "skipped_busy" : "skipped_cooldown";
		}
		if (this.flushing) {
			// re-entrant trigger while a flush is in flight (e.g. slow vision await):
			// coalesce into pendingTrigger; the loop picks it up (burst merge, R1)
			this.pendingTrigger = true;
			return "coalesced";
		}
		if (source === "probability") this.cooldownAfterFlush = true;
		this.flushing = true; // set synchronously, before any await — never gated on SDK events
		this.typingLease.start();
		this.flushPromise = this.flushLoop()
			.catch((err) => {
				// R3: a failed flush only produces an error event; nothing escapes as an
				// unhandled rejection. Messages stay unexposed and are retried by later triggers.
				try {
					this.recordEvent("error", { stage: "flush", error: err instanceof Error ? err.message : String(err) });
				} catch {
					// shutdown may have closed the db under a wedged flush; nothing more to do
				}
			})
			.finally(() => {
				this.flushing = false;
				this.flushPromise = null;
				if (this.cooldownAfterFlush) {
					this.cooldownUntil = this.monotonicNow() + this.bot.samplingCooldownMs;
					this.cooldownAfterFlush = false;
				}
			});
		return "started";
	}

	private async flushLoop(): Promise<void> {
		try {
			do {
				this.pendingTrigger = false;
				this.typingLease.start();
				await this.flush();
			} while (this.pendingTrigger && !this.stopping);
		} finally {
			this.typingLease.stop();
		}
	}

	/** Serialize unexposed messages into a new context suffix and wake the agent. */
	private async flush(): Promise<void> {
		if (!this.session) return;
		const chatId = Number(`-100${this.config.groupPeerId}`);
		const rows = this.db
			.query("SELECT * FROM messages WHERE chat_id = ? ORDER BY date, message_id")
			.all(chatId) as MessageRow[];
		const fresh = rows.filter((r) => !this.exposed.has(r.message_id));
		if (fresh.length === 0) return;

		let batch = fresh;
		let skipped: MessageRow[] = [];
		if (fresh.length > MAX_CATCHUP_MESSAGES) {
			skipped = fresh.slice(0, fresh.length - MAX_CATCHUP_MESSAGES);
			batch = fresh.slice(-MAX_CATCHUP_MESSAGES);
		}

		const visibleIds = new Set(this.exposed);
		await this.ensureBatchVision(batch);
		const text = serializeMessages(this.db, batch, { visibleIds });
		if (!text.trim()) return;
		const suffix = [text, this.stickerCandidatesBlock()].filter(Boolean).join("\n\n");
		await this.session.sendUserMessage(suffix);
		// mark exposed only after the batch actually entered context (R2): on send failure
		// the ids stay unexposed and a later trigger re-serializes them
		this.markExposed(batch.map((r) => r.message_id));
		// catchup overflow is deliberately dropped, but only once the batch landed —
		// otherwise a failed send would silently lose the skipped messages too
		if (skipped.length > 0) this.markExposed(skipped.map((r) => r.message_id));
	}

	/** Lazy vision: resolve media descriptions only now that they enter this bot's context. */
	private async ensureBatchVision(batch: MessageRow[]): Promise<void> {
		for (const row of batch) {
			if (!row.media) continue;
			const media = JSON.parse(row.media) as { kind: string; file_unique_id?: string };
			if (!media.file_unique_id || (media.kind !== "photo" && media.kind !== "sticker")) continue;
			const existing = this.db.query("SELECT vision FROM media WHERE file_unique_id = ?").get(media.file_unique_id) as
				| { vision: string | null }
				| null;
			if (existing?.vision) continue; // persistent cache hit, shared by both bots
			try {
				this.recordEvent("vision", { file_unique_id: media.file_unique_id, kind: media.kind });
				await ensureVision(this.db, this.api, this.bot.id, this.config.auxiliaryVisualModel, media.file_unique_id, {
					onPersist: (fileUniqueId, text) => this.visionSink?.(fileUniqueId, text),
				});
			} catch (err) {
				this.recordEvent("error", { stage: "vision", error: String(err) });
			}
		}
	}

	/** Small dynamic sticker candidate list (semantic, short ids). Empty string when catalog is empty.
	 * Stickers from the fixed catalog are excluded: they are already in the stable prefix
	 * (REQ-STICKER-0001 R4/R6 — the dynamic block only carries set-EXTERNAL stickers seen in context). */
	private stickerCandidatesBlock(): string {
		// assign short ids (rowid-based: stable and unique, race-free)
		const unassigned = this.db
			.query(
				`SELECT rowid, file_unique_id FROM media m
				 WHERE kind = 'sticker' AND json_extract(vision, '$.text') IS NOT NULL AND short_id IS NULL
				   AND EXISTS (
				     SELECT 1 FROM media_file_ids f
				      WHERE f.bot_id = ? AND f.file_unique_id = m.file_unique_id
				   )`,
			)
			.all(this.bot.id) as { rowid: number; file_unique_id: string }[];
		for (const row of unassigned) {
			this.db.query("UPDATE media SET short_id = ? WHERE file_unique_id = ?").run(`s${row.rowid}`, row.file_unique_id);
		}
		const rows =
			this.bot.stickerSets.length > 0
				? (this.db
						.query(
							`SELECT short_id, sticker_emoji, vision FROM media m
							 WHERE kind = 'sticker' AND short_id IS NOT NULL AND json_extract(vision, '$.text') IS NOT NULL
							   AND (sticker_set IS NULL OR sticker_set NOT IN (SELECT value FROM json_each(?)))
							   AND EXISTS (
							     SELECT 1 FROM media_file_ids f
							      WHERE f.bot_id = ? AND f.file_unique_id = m.file_unique_id
							   )
							 ORDER BY rowid DESC LIMIT 8`,
						)
						.all(JSON.stringify(this.bot.stickerSets), this.bot.id) as { short_id: string; sticker_emoji: string | null; vision: string }[])
				: (this.db
						.query(
							`SELECT short_id, sticker_emoji, vision FROM media m
							 WHERE kind = 'sticker' AND short_id IS NOT NULL AND json_extract(vision, '$.text') IS NOT NULL
							   AND EXISTS (
							     SELECT 1 FROM media_file_ids f
							      WHERE f.bot_id = ? AND f.file_unique_id = m.file_unique_id
							   )
							 ORDER BY rowid DESC LIMIT 8`,
						)
						.all(this.bot.id) as { short_id: string; sticker_emoji: string | null; vision: string }[]);
		if (rows.length === 0) return "";
		const lines = rows.map((r) => {
			// catalog short_ids are assigned before vision completes (background pre-recognition);
			// the query filters for vision text, and this parse is defensive on top of that
			const parsed = JSON.parse(r.vision) as { text: string };
			const desc = (parsed.text ?? "").replace(/\s+/g, " ").slice(0, 60);
			return `${r.short_id} = ${r.sticker_emoji ?? ""} ${desc}`.trim();
		});
		return `Available stickers:\n${lines.join("\n")}`;
	}

	private markExposed(ids: number[]): void {
		for (const id of ids) this.exposed.add(id);
		// persist; array grows within an epoch and resets on compaction (Phase 8)
		setBotState(this.db, this.bot.id, EXPOSED_KEY, JSON.stringify([...this.exposed]));
	}

	private recordEvent(kind: string, payload: unknown): void {
		this.db
			.query("INSERT INTO agent_events (bot_id, ts, kind, payload) VALUES (?, ?, ?, ?)")
			.run(this.bot.id, Date.now(), kind, JSON.stringify(payload));
		this.eventSink?.(kind, payload);
	}

	private recordUsage(
		usage: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number; cost: { total: number } },
		now: number,
	): void {
		const contextTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		const reasoningTokens = usage.reasoning ?? 0;
		const latencyMs = this.runStartTs ? now - this.runStartTs : null;
		const res = this.db
			.query(
				`INSERT INTO llm_runs (bot_id, ts, model, epoch, context_tokens, cache_read, cache_write, cache_miss, output_tokens, reasoning_tokens, latency_ms, cost, system_hash, tools_hash)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				this.bot.id,
				now,
				this.bot.model,
				this.epoch,
				contextTokens,
				usage.cacheRead,
				usage.cacheWrite,
				usage.input,
				usage.output,
				reasoningTokens,
				latencyMs,
				usage.cost.total,
				this.systemHash,
				this.toolsHash,
			);
		this.usageSink?.({
			id: Number(res.lastInsertRowid),
			botId: this.bot.id,
			ts: now,
			model: this.bot.model,
			epoch: this.epoch,
			contextTokens,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			cacheMiss: usage.input,
			outputTokens: usage.output,
			reasoningTokens,
			latencyMs,
			cost: usage.cost.total,
		});
	}

	/** Record a cache-schema bump (CACHE_SCHEMA_VERSION change) as a new context epoch. */
	noteSchemaBump(epoch: number): void {
		this.epoch = epoch;
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.typingLease.stop();
		this.endAssistantStream();
		// Bounded wait for an in-flight flush so exposure isn't left half-written;
		// the timeout only guards a wedged run (markExposed follows sendUserMessage
		// immediately, so the normal window is tiny).
		if (this.flushPromise) {
			await Promise.race([this.flushPromise.catch(() => {}), new Promise((r) => setTimeout(r, 30_000))]);
		}
		if (this.session) await this.session.dispose();
	}
}
