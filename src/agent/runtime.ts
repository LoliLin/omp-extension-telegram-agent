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
	type ExtensionAPI,
	type ModelRuntime,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BotConfig, AppConfig } from "../config.ts";
import { getBotState, setBotState } from "../db/db.ts";
import { BotApi } from "../telegram/api.ts";
import { insertSentMessage } from "../telegram/ingest.ts";
import { serializeMessages, type MessageRow } from "./serialize.ts";
import { buildSystemPrompt, sha256Short, CACHE_SCHEMA_VERSION } from "./prompt.ts";
import { tinyFishSearch, formatSearchResults } from "../tools/search.ts";
import { runJs } from "../tools/run-js.ts";
import { ensureVision, fileIdForBot } from "../media/vision.ts";

const MAX_CATCHUP_MESSAGES = 40; // per trigger; older unexposed messages are skipped
const EXPOSED_KEY = "exposed_ids";
const EPOCH_KEY = "context_epoch";

// Chat-oriented compaction summary prompt (state, not replay). Part of cache protocol.
const COMPACTION_SUMMARY_PROMPT = `你在为一个长期住在 Telegram 群里的 AI 群友压缩记忆。把被压缩的群聊历史总结成"状态"而不是逐条复述，供它之后延续人设和上下文。

保留：
- 重要人物关系、称呼和互动模式
- 已知稳定事实和长期话题
- 正在讨论的问题、结论和争议点
- 承诺和未解决事项
- 必要的消息引用（#消息id）
- 这个人设真正会关心的信息

输出中文，分段，直接给摘要正文，控制在 800 字以内。`;

interface SendParams {
	reply_to?: number;
	sticker?: string;
	message?: string;
}

export class BotRuntime {
	private db: Database;
	private bot: BotConfig;
	private config: AppConfig;
	private modelRuntime: ModelRuntime;
	private api: BotApi;
	private session: AgentSession | null = null;
	private running = false;
	private pendingTrigger = false;
	private exposed = new Set<number>();
	private epoch = 1;
	private runStartTs = 0;
	private systemHash = "";
	private toolsHash = "";
	/** Optional sink for TUI/live broadcasting of agent events. */
	eventSink: ((kind: string, payload: unknown) => void) | null = null;
	/** Optional sink for messages this bot sent (poller echo dedupes them, so TUI needs this path). */
	sentMessageSink: ((rawMsg: unknown) => void) | null = null;

	constructor(db: Database, bot: BotConfig, config: AppConfig, modelRuntime: ModelRuntime) {
		this.db = db;
		this.bot = bot;
		this.config = config;
		this.modelRuntime = modelRuntime;
		this.api = new BotApi(bot.token);
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
		const systemPrompt = buildSystemPrompt(persona);
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
			description:
				"Send a message and/or sticker to the Telegram group. This ends your turn: after send succeeds, no further output is needed. Omit message for a pure sticker, omit sticker when no suitable candidate exists.",
			parameters: Type.Object({
				reply_to: Type.Optional(Type.Number({ description: "Telegram message id (# number) to reply to" })),
				sticker: Type.Optional(Type.String({ description: "Sticker id from the available sticker list" })),
				message: Type.Optional(Type.String({ description: "Text message to send" })),
			}),
			execute: async (_toolCallId: string, params: SendParams) => {
				return await this.executeSend(params);
			},
		};
		const searchTool = {
			name: "search",
			label: "Search",
			description:
				"Search the web (TinyFish). Returns up to 5 results with title, url and a short snippet. Use when you need external facts or current information.",
			parameters: Type.Object({
				query: Type.String({ description: "Search query" }),
			}),
			execute: async (_toolCallId: string, params: { query: string }) => {
				const hits = await tinyFishSearch(this.config.tinyfishApiKey, params.query);
				this.recordEvent("tool_search", { query: params.query, hits: hits.length });
				return {
					content: [{ type: "text" as const, text: formatSearchResults(hits) }],
					details: { query: params.query, hits: hits.length },
				};
			},
		};
		const runJsTool = {
			name: "run_js",
			label: "Run JS",
			description:
				"Run small pure-computation JavaScript (calculation, JSON, regex, transforms). Sandboxed: no filesystem, network, process or environment access. console.log output and the final expression value are returned. 3s limit.",
			parameters: Type.Object({
				code: Type.String({ description: "JavaScript source; the value of the last expression is returned" }),
			}),
			execute: async (_toolCallId: string, params: { code: string }) => {
				const result = await runJs(params.code);
				this.recordEvent("tool_run_js", { ok: result.ok, durationMs: result.durationMs });
				return {
					content: [{ type: "text" as const, text: result.output || "(no output)" }],
					details: { ok: result.ok, durationMs: result.durationMs },
				};
			},
		};
		// Tool order is cache-visible protocol: never reorder (docs/cache.md).
		const tools = [sendTool, searchTool, runJsTool];
		this.toolsHash = sha256Short(JSON.stringify(tools.map((t) => ({ name: t.name, params: t.parameters }))));

		const model = this.modelRuntime.getModel("deepseek", this.config.deepseekModel);
		if (!model) throw new Error(`model not found: deepseek/${this.config.deepseekModel}`);

		// Custom compaction: chat-oriented summary (state, not replay), threshold from config.
		// Pi's trigger formula is contextTokens > contextWindow - reserveTokens, so reserve = window - threshold.
		const threshold = this.config.compactionThreshold;
		const reserveTokens = Math.max(16_384, model.contextWindow - threshold);
		const compactionExt = {
			name: "tg-compaction",
			hidden: true,
			factory: (pi: ExtensionAPI) => {
				pi.on("session_before_compact", async (event: SessionBeforeCompactEvent) => {
					const prep = event.preparation;
					const conversation = serializeConversation(prep.messagesToSummarize as never);
					const userText =
						`<conversation>\n${conversation}\n</conversation>\n\n` +
						(prep.previousSummary
							? `<previous-summary>\n${prep.previousSummary}\n</previous-summary>\n\n把上面的旧摘要与新内容合并成一份更新的摘要。`
							: "请输出摘要。");
					const result = await this.modelRuntime.completeSimple(
						model as never,
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
					return {
						compaction: {
							summary,
							firstKeptEntryId: prep.firstKeptEntryId,
							tokensBefore: prep.tokensBefore,
							usage: result.usage,
						},
					};
				});
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

		const { session } = await createAgentSession({
			cwd: this.config.dataDir,
			model,
			thinkingLevel: this.config.deepseekReasoningEffort as "medium",
			modelRuntime: this.modelRuntime,
			sessionManager,
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens, keepRecentTokens: this.config.compactionKeepRecent } }),
			resourceLoader: loader,
			noTools: "builtin",
			customTools: tools,
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
				case "message_end": {
					const msg = event.message;
					if (msg.role === "assistant") {
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
				case "tool_execution_start":
					this.recordEvent("tool_call", { tool: event.toolName, args: event.args });
					break;
				case "tool_execution_end":
					this.recordEvent("tool_result", { tool: event.toolName, isError: event.isError });
					break;
				case "agent_settled":
					this.running = false;
					if (this.pendingTrigger) {
						this.pendingTrigger = false;
						void this.flush();
					}
					break;
				case "compaction_end":
					this.onCompactionEnd();
					break;
			}
		});
	}

	/** New context epoch after compaction: reset exposure, re-mark the recent kept tail. */
	private onCompactionEnd(): void {
		this.epoch += 1;
		setBotState(this.db, this.bot.id, EPOCH_KEY, String(this.epoch));
		this.exposed.clear();
		// the last ~40 telegram messages survive inside the kept tail; treat as exposed
		const chatId = Number(`-100${this.config.groupPeerId}`);
		const recent = this.db
			.query("SELECT message_id FROM messages WHERE chat_id = ? ORDER BY message_id DESC LIMIT 40")
			.all(chatId) as { message_id: number }[];
		this.markExposed(recent.map((r) => r.message_id));
		this.recordEvent("compaction", { epoch: this.epoch });
		console.log(`[bot ${this.bot.id}] compaction -> epoch ${this.epoch}`);
	}

	private async executeSend(params: SendParams) {
		if (!params.message && !params.sticker) {
			throw new Error("send requires at least one of message or sticker");
		}
		if (params.reply_to != null && !this.exposed.has(params.reply_to)) {
			throw new Error("messaging.reply_not_visible");
		}
		const chatId = Number(`-100${this.config.groupPeerId}`);
		const sentIds: number[] = [];
		if (params.message) {
			const m = await this.api.sendMessage(chatId, params.message, params.reply_to);
			const canonical = insertSentMessage(this.db, this.bot.id, m);
			sentIds.push(canonical.message_id);
			this.markExposed([canonical.message_id]);
			this.sentMessageSink?.(m);
		}
		if (params.sticker) {
			const row = this.db.query("SELECT file_unique_id FROM media WHERE short_id = ?").get(params.sticker) as
				| { file_unique_id: string }
				| null;
			if (!row) throw new Error(`unknown sticker id: ${params.sticker} (use one from the Available stickers list)`);
			const fileId = fileIdForBot(this.db, this.bot.id, row.file_unique_id);
			if (!fileId) throw new Error(`sticker ${params.sticker} is not sendable by this bot (no file_id)`);
			const m = await this.api.sendSticker(chatId, fileId, params.reply_to);
			const canonical = insertSentMessage(this.db, this.bot.id, m);
			sentIds.push(canonical.message_id);
			this.markExposed([canonical.message_id]);
			this.sentMessageSink?.(m);
		}
		this.recordEvent("send", { reply_to: params.reply_to ?? null, sticker: params.sticker ?? null, sent: sentIds });
		return {
			content: [{ type: "text" as const, text: `ok sent ${sentIds.map((i) => `#${i}`).join(" ")}` }],
			details: { sent: sentIds },
			terminate: true,
		};
	}

	/** Called by the router when this bot gets a response opportunity. */
	trigger(): void {
		if (this.running) {
			this.pendingTrigger = true;
			return;
		}
		void this.flush();
	}

	/** Serialize unexposed messages into a new context suffix and wake the agent. */
	private async flush(): Promise<void> {
		if (!this.session || this.running) return;
		const chatId = Number(`-100${this.config.groupPeerId}`);
		const rows = this.db
			.query("SELECT * FROM messages WHERE chat_id = ? ORDER BY date, message_id")
			.all(chatId) as MessageRow[];
		const fresh = rows.filter((r) => !this.exposed.has(r.message_id));
		if (fresh.length === 0) return;

		let batch = fresh;
		if (fresh.length > MAX_CATCHUP_MESSAGES) {
			const skipped = fresh.slice(0, fresh.length - MAX_CATCHUP_MESSAGES);
			this.markExposed(skipped.map((r) => r.message_id));
			batch = fresh.slice(-MAX_CATCHUP_MESSAGES);
		}

		const visibleIds = new Set(this.exposed);
		// lazy vision: only now that this bot is woken and the media enters its context
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
				await ensureVision(this.db, this.api, this.bot.id, this.config.auxiliaryVisualModel, media.file_unique_id);
			} catch (err) {
				this.recordEvent("error", { stage: "vision", error: String(err) });
			}
		}
		const text = serializeMessages(this.db, batch, { visibleIds });
		if (!text.trim()) return;
		this.markExposed(batch.map((r) => r.message_id));
		const suffix = [text, this.stickerCandidatesBlock()].filter(Boolean).join("\n\n");
		await this.session.sendUserMessage(suffix);
	}

	/** Small dynamic sticker candidate list (semantic, short ids). Empty string when catalog is empty. */
	private stickerCandidatesBlock(): string {
		// assign short ids (rowid-based: stable and unique, race-free)
		const unassigned = this.db
			.query("SELECT rowid, file_unique_id FROM media WHERE kind = 'sticker' AND json_extract(vision, '$.text') IS NOT NULL AND short_id IS NULL")
			.all() as { rowid: number; file_unique_id: string }[];
		for (const row of unassigned) {
			this.db.query("UPDATE media SET short_id = ? WHERE file_unique_id = ?").run(`s${row.rowid}`, row.file_unique_id);
		}
		const rows = this.db
			.query("SELECT short_id, sticker_emoji, vision FROM media WHERE kind = 'sticker' AND short_id IS NOT NULL ORDER BY rowid DESC LIMIT 8")
			.all() as { short_id: string; sticker_emoji: string | null; vision: string }[];
		if (rows.length === 0) return "";
		const lines = rows.map((r) => {
			const desc = (JSON.parse(r.vision) as { text: string }).text.replace(/\s+/g, " ").slice(0, 60);
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
		this.db
			.query(
				`INSERT INTO llm_runs (bot_id, ts, model, epoch, context_tokens, cache_read, cache_miss, output_tokens, reasoning_tokens, latency_ms, cost, system_hash, tools_hash)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				this.bot.id,
				now,
				this.config.deepseekModel,
				this.epoch,
				usage.input + usage.cacheRead + usage.cacheWrite,
				usage.cacheRead,
				usage.input,
				usage.output,
				usage.reasoning ?? 0,
				this.runStartTs ? now - this.runStartTs : null,
				usage.cost.total,
				this.systemHash,
				this.toolsHash,
			);
	}

	async stop(): Promise<void> {
		if (this.session) await this.session.dispose();
	}
}
