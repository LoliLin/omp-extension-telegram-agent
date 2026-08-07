-- Schema v1. See docs/data-model.md. Applied idempotently at daemon start.

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS raw_updates (
	bot_id TEXT NOT NULL,
	update_id INTEGER NOT NULL,
	received_at INTEGER NOT NULL, -- unix seconds, local receipt time
	json TEXT NOT NULL,
	PRIMARY KEY (bot_id, update_id)
);

CREATE TABLE IF NOT EXISTS messages (
	chat_id INTEGER NOT NULL,
	message_id INTEGER NOT NULL,
	date INTEGER NOT NULL, -- unix seconds, telegram send time
	thread_id INTEGER,
	sender_id INTEGER,
	display_name TEXT,
	username TEXT,
	sender_tag TEXT,
	sender_chat TEXT,
	is_bot INTEGER NOT NULL DEFAULT 0,
	text TEXT,
	caption TEXT,
	entities TEXT, -- JSON array, raw telegram entities
	reply_to_message_id INTEGER,
	quote TEXT, -- JSON, selected quote if any
	forward_origin TEXT, -- JSON
	edit_date INTEGER,
	media TEXT, -- JSON: {kind: photo|sticker|..., file_unique_id, file_id, ...}
	first_seen_by TEXT NOT NULL, -- bot id whose poller first delivered this message
	PRIMARY KEY (chat_id, message_id)
);

CREATE TABLE IF NOT EXISTS message_revisions (
	chat_id INTEGER NOT NULL,
	message_id INTEGER NOT NULL,
	edit_date INTEGER NOT NULL,
	text TEXT,
	caption TEXT,
	entities TEXT,
	PRIMARY KEY (chat_id, message_id, edit_date)
);

CREATE TABLE IF NOT EXISTS media (
	file_unique_id TEXT PRIMARY KEY,
	kind TEXT NOT NULL, -- photo | sticker | animation | video | document
	mime TEXT,
	width INTEGER,
	height INTEGER,
	local_path TEXT, -- downloaded cache
	vision TEXT, -- JSON: {model, kind, text, at} — shared by both bots
	sticker_set TEXT,
	sticker_emoji TEXT,
	semantic TEXT -- sticker semantic description
);

-- per-bot telegram file_id -> our media identity (file_id is bot-specific)
CREATE TABLE IF NOT EXISTS media_file_ids (
	bot_id TEXT NOT NULL,
	file_id TEXT NOT NULL,
	file_unique_id TEXT NOT NULL,
	PRIMARY KEY (bot_id, file_id)
);

CREATE TABLE IF NOT EXISTS agent_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	bot_id TEXT NOT NULL,
	ts INTEGER NOT NULL, -- unix ms
	kind TEXT NOT NULL, -- assistant_text|thinking|tool_call|tool_result|vision|usage|compaction|error|send
	payload TEXT NOT NULL -- JSON
);
CREATE INDEX IF NOT EXISTS idx_agent_events_ts ON agent_events(ts);

CREATE TABLE IF NOT EXISTS llm_runs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	bot_id TEXT NOT NULL,
	ts INTEGER NOT NULL,
	model TEXT NOT NULL,
	epoch INTEGER NOT NULL,
	context_tokens INTEGER,
	cache_read INTEGER,
	cache_miss INTEGER,
	output_tokens INTEGER,
	reasoning_tokens INTEGER,
	latency_ms INTEGER,
	cost REAL,
	compaction INTEGER NOT NULL DEFAULT 0,
	system_hash TEXT,
	tools_hash TEXT,
	messages_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_llm_runs_ts ON llm_runs(ts);

CREATE TABLE IF NOT EXISTS bot_state (
	bot_id TEXT NOT NULL,
	key TEXT NOT NULL,
	value TEXT NOT NULL,
	PRIMARY KEY (bot_id, key)
);

CREATE TABLE IF NOT EXISTS aliases (
	chat_id INTEGER NOT NULL,
	user_id INTEGER NOT NULL,
	alias TEXT NOT NULL,
	PRIMARY KEY (chat_id, user_id)
);

-- daemon-wide singleton state (router secret, schema version, ...)
CREATE TABLE IF NOT EXISTS daemon_state (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
