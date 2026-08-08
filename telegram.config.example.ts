import { defineConfig } from "./src/config-schema.ts";

export default defineConfig({
	// Telegram supergroup id. Bare, negative, and -100-prefixed forms are accepted.
	group_peer_id: 1234567890,

	// Provider defaults inherited by every bot unless that bot explicitly overrides all fields.
	provider: "deepseek",
	model: "deepseek-v4-flash",
	api_key_env: "llm_api_key",
	reasoning_effort: "medium",

	// Deterministic local behavior. These defaults keep context and background work bounded.
	compaction_threshold: 128_000,
	compaction_keep_recent: 20_000,
	sampling_cooldown_ms: 2_000,
	db_path: "data/agent.db",
	router_secret_env: "router_secret",
	tinyfish_key_env: "tinyfish_api_key",
	auxiliary_visual_model: "gpt-5.6-luna-low",

	// Empty means all state-changing Telegram /tg commands are denied.
	telegram_admins: [],

	bots: [
		{
			// Stable id for Pi commands, sessions, routing, and telemetry.
			id: "friend",
			name: "Mochi",
			// .env holds the token value; this file contains only its key name.
			token_env: "telegram_bot_token",
			// Copy a public template to an ignored local file before personalizing it.
			persona_path: "personas/template.en.md",
			// Chance of joining an unaddressed human conversation. Explicit replies still route.
			routing_p: 0.1,
			sticker_sets: [],
			tools: {
				send: true,
				// Enable only after adding tinyfish_api_key to .env.
				search: false,
				run_js: true,
			},
		},
	],
});
