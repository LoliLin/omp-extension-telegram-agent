# Pi Telegram Agent

[中文](README.md) · [English](README.en.md) · [中文用户指南](docs/user-guide/zh/src/README.md) · [English user guide](docs/user-guide/en/src/README.md)

Run 1..N configurable AI companions as long-lived members of one Telegram supergroup, with setup, observation, and controls rendered in Pi's native transcript.

One deployment serves one group. Each bot has its own token, persona, provider/model, session, routing, tools, and telemetry. Adding a bot does not require production code changes, and closing Pi does not stop the local daemon.

## Start in three steps

1. Prepare a Telegram supergroup ID and at least one BotFather token. Add every bot to the target group and disable BotFather privacy mode so it can receive ordinary group messages.
2. Install [Bun](https://bun.sh/), clone this repository, and run `bun run pi`. Use Pi's native `/login` to authenticate a model provider and `/model` to select the default model; this project reuses those Pi settings and credentials.
3. Enter `/tg config` in Pi, confirm the displayed Pi model, choose a public persona template, and provide the Telegram values. The wizard validates and atomically writes local files, then opens the all-bots feed only after the daemon reports ready.

> Pi's current native `input` dialog does not mask passwords. The Telegram token remains visible while you enter it, so use a private terminal and do not record or share the screen. Model authentication remains owned by Pi; `/tg config` never asks for or stores a provider key.

Read [Installation and first setup](docs/user-guide/en/src/getting-started.md) for the complete preparation flow.

## What it provides

- Raw Telegram Bot API long polling, canonical SQLite history, and isolated sessions for 1..N agents.
- Mention, reply, configured-name, and deterministic probability routing with availability and cooldown gates.
- Telegram Rich Messages, stickers, on-demand media vision, optional search, and constrained JavaScript computation.
- Pi-native transcript, image components, footer telemetry, hierarchical command completion, and editor compose; the plugin does not implement its own viewport or terminal protocol.
- Append-only provider context, a stable cached prefix, bounded suffixes, and compaction to avoid unnecessary calls and repeated tokens.

Current boundary: one working directory safely hosts one group deployment. Multiple groups require isolated working directories, data, databases, sessions, PID files, and sockets. This is not a SaaS or multi-tenant service, and configuration is not hot-reloaded. Different config files do not namespace shared history, offsets, or process resources; read [Daily operations: multiple groups](docs/user-guide/en/src/operations.md#why-working-directories-must-be-isolated) for the reason and safe setup.

## Daily use

```bash
bun run start      # Start the daemon in the background
bun run status     # Inspect controlled process state
bun run pi         # Open project Pi with the Telegram extension
bun run restart    # Gracefully restart the deployment
bun run stop       # Stop gracefully
```

Enter `/tg ` in Pi to use native command completion:

| Command | Result |
| --- | --- |
| `/tg config` | Set up, validate, edit, or explicitly back up and replace local configuration |
| `/tg attach [bot]` | Mount the global or one-bot feed and send from the editor |
| `/tg compose [bot]` | Restore feed scope or pin one bot |
| `/tg compose off` | Return the editor to the Pi agent |
| `/tg more` / `/tg detach` | Load older history / disconnect the live feed |
| `/tg panel [bot\|off]` | Select or restore Pi-native footer telemetry |
| `/tg status [bot]` | Show lifetime and latest usage details |
| `/tg start` / `restart` / `stop` / `status-daemon` | Manage the daemon from Pi |

After `attach <bot>`, the editor sends directly as that bot. A global attach opens Pi's native selector on every submission when several bots exist, and sends directly when only one exists. `compose <bot>` pins an identity, `compose off` temporarily returns input to Pi, and bare `compose` restores feed scope. An unknown outcome restores the text and closes compose without retrying; inspect the group before sending again.

## Configuration files

`/tg config` is the recommended entry point. For manual setup:

```bash
cp telegram.config.example.ts telegram.config.ts
cp .env.example .env
cp personas/template.en.md personas/friend.local.md
```

- `telegram.config.ts`: trusted local TypeScript containing non-secret schema and environment-key names, with comments and editor types.
- `.env`: the project's `key: value` colon format for Telegram tokens, an optional TinyFish key, and the router secret; model credentials do not belong here.
- `personas/*.local.md`: local personas, ignored by Git by default.
- `bots.config.json`: legacy deployment compatibility; prefer TypeScript for new setups.

Read [Configuration](docs/user-guide/en/src/configuration.md) for a minimal one-bot config, additional bots, provider overrides, and routing rules. Tracked examples contain no valid credentials or private personas.

## When something fails

- Pi model not ready before `/tg config` writes: exit the wizard, use Pi `/login` and `/model`, then retry; no deployment files are created.
- Daemon not ready after `/tg config`: the valid files remain. Run `/tg status-daemon`, inspect `data/daemon.log`, fix Telegram or networking issues, then run `/tg restart`.
- `unknown bot id`: use dynamic `/tg ` completion or check the bot `id` in `telegram.config.ts`.
- `restart already in progress`: wait for the controlled restart instead of starting another daemon.
- Telegram `409`: another poller probably uses the same token; follow the [daemon runbook](docs/runbooks/daemon.md) for a controlled restart.
- Compose reports an unknown outcome: inspect the Telegram group and retry only if the message is absent.

Read [Troubleshooting](docs/user-guide/en/src/troubleshooting.md) and the [daemon runbook](docs/runbooks/daemon.md) for recovery procedures.

## Why it avoids unnecessary calls and tokens

Deterministic code owns routing, deduplication, state, and UI. The provider-visible prefix stays stable, dynamic group content enters only a bounded suffix, media vision runs lazily, and compaction occurs only at a context boundary. The project promises no fixed savings percentage; use local lifetime telemetry to measure your deployment.

Read the [cost design overview](docs/user-guide/en/src/design-cost.md) for the six mechanisms and their authoritative implementation documents.

## Development and maintenance

Users do not need the internal architecture to complete setup. Contributors and coding agents should start with [AGENTS.md](AGENTS.md) and the [maintainer guide](docs/maintainers/guide.md). Current work is in the [handoff](docs/handoff.md), and the full map is in the [documentation index](docs/index.md).

The current HEAD tracks only public persona templates. Older Git history may still contain removed deployment personas. The repository has not rewritten history and cannot replace necessary credential rotation.
