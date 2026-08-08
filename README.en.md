# Pi Telegram Agent

[中文](README.md) · [English](README.en.md) · [中文用户指南](docs/user-guide/zh/src/README.md) · [English user guide](docs/user-guide/en/src/README.md)

Run 1..N AI bots, each with its own persona, as long-lived members of one Telegram supergroup, joining conversations by probabilistic routing. The Pi terminal UI is the observation and control surface.

The design philosophy is four points, and each one pays off directly:

- **Fast**: a local daemon runs permanently, and incoming messages route straight to the right bot — no queue, no cold start.
- **Context-optimized**: the provider prefix cache means repeated context is not billed again; group messages only append the incremental part.
- **Simple**: one configuration file, one structure, no intermediate concepts to learn.
- **Cheap**: the result of the three above — no unnecessary model calls, no re-sent cached tokens.

## Fast deploy

1. Prepare a Telegram supergroup ID and at least one BotFather token. Add every bot to the group and disable BotFather privacy mode, or it cannot see ordinary group messages.
2. With [Bun](https://bun.sh/) installed, clone this repository and run `bun run pi`. In Pi, authenticate a model provider with `/login` and pick the default model with `/model`. The project reuses Pi's credentials as-is.
3. Enter `/tg config` in Pi and follow the wizard: group ID, persona template, token. It validates and writes local files, then opens the all-bots feed once the daemon reports ready.

> Pi's current input dialog does not mask passwords: the Telegram token stays visible while you type it. Use a private terminal; do not record or share your screen.

The full walkthrough is in [Installation and first setup](docs/user-guide/en/src/getting-started.md).

## Everyday commands

```bash
bun run start      # Start the daemon in the background
bun run pi         # Open Pi with the Telegram extension
bun run status     # Inspect process state
bun run restart    # Graceful restart
bun run stop       # Graceful stop
```

In the Telegram group itself, `/help` and `/status` report bot state; `/compact` and `/set` are restricted to admins listed in `telegram_admins`.

For the in-Pi `/tg` commands (attach / compose / panel / more, and so on), see [Chatting and observing in Pi](docs/user-guide/en/src/using-pi.md).

## Configuration

There is exactly one configuration track: `telegram.config.ts` holds every non-secret setting, `.env` holds secrets such as the Telegram token and `tiny_fish_api_key`, and provider/model authentication stays in Pi, outside this repository. A minimal config:

```ts
import { defineConfig } from "./src/config.ts";

export default defineConfig({
	group_peer_id: 1234567890, // supergroup ID
	bots: [
		{
			id: "friend",
			name: "Mochi", // display name in the group, also a trigger keyword
			token_env: "telegram_bot_token", // key name in .env
			persona_path: "personas/template.en.md",
			routing_p: 0.1, // chance of joining when not addressed
			sticker_sets: [],
			tools: { send: true, search: false, run_js: true },
		},
	],
});
```

Every omitted field has a default (see the comments in `telegram.config.example.ts`). Adding a second bot means adding one more entry to `bots` — no code changes. Multiple bots, provider overrides, and routing rules are covered in [Configuration](docs/user-guide/en/src/configuration.md).

One working directory hosts one group; run multiple groups from isolated working directories (why and how: [Daily operations](docs/user-guide/en/src/operations.md)).

## When something fails

- `unknown bot id`: check the `id` in `telegram.config.ts`, or use dynamic `/tg ` completion.
- `restart already in progress`: wait for the current restart instead of launching a second daemon.
- Telegram `409`: another poller is using the same token; do a controlled restart per the [daemon runbook](docs/runbooks/daemon.md).
- For other symptoms, see [Troubleshooting](docs/user-guide/en/src/troubleshooting.md).

## Cost control

Routing, deduplication, and state are handled by deterministic code — no model calls spent on them. When the provider prefix cache hits, repeated system prompts and history are not billed as new tokens. Media vision is off by default and budget-capped when enabled. Compaction only runs past a context threshold. Measure the real effect with local telemetry (`bun run debug`); the mechanisms are documented in the [cost design overview](docs/user-guide/en/src/design-cost.md).

## Development

To modify the project, start with [AGENTS.md](AGENTS.md) and the [development guide](docs/engineering/development-guide.md). The full documentation index is [docs/index.md](docs/index.md).
