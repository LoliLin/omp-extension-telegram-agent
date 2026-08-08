# Pi Telegram Agent

[中文](README.md) · [English](README.en.md) · [中文用户指南](docs/user-guide/zh/src/README.md) · [English user guide](docs/user-guide/en/src/README.md)

Run 1..N configurable AI companions as long-lived members of one Telegram supergroup, with setup, observation, and controls rendered in Pi's native transcript.

One deployment serves one group. Each bot has its own token, persona, provider/model, session, routing, tools, and telemetry. Adding a bot does not require production code changes, and closing Pi does not stop the local daemon.

## Start in three steps

1. Prepare a Telegram supergroup ID, at least one BotFather token, and credentials for a provider/model supported by the current Pi model catalog. Add every bot to the target group and disable BotFather privacy mode so it can receive ordinary group messages.
2. Install [Bun](https://bun.sh/), clone this repository, and run `bun run pi`. The launcher installs the locked project-local Pi 0.84.1 when needed; no sibling Pi source checkout is required.
3. Enter `/tg config` in Pi, choose a public persona template, and provide the requested values. The wizard validates and atomically writes local files, then opens the all-bots feed only after the daemon reports ready.

> Pi's current native `input` dialog does not mask passwords. Provider keys and Telegram tokens remain visible while you enter them. Use a private terminal and do not record or share the screen. Secrets are written only to the Git-ignored `.env` file.

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
| `/tg attach [bot]` | Observe the global or one-bot feed without sending |
| `/tg compose <bot>` | Send interactive editor text explicitly as that bot |
| `/tg compose off` | Return the editor to the Pi agent |
| `/tg more` / `/tg detach` | Load older history / disconnect the live feed |
| `/tg panel [bot\|off]` | Select or restore Pi-native footer telemetry |
| `/tg status [bot]` | Show lifetime and latest usage details |
| `/tg start` / `restart` / `stop` / `status-daemon` | Manage the daemon from Pi |

`attach` is always read-only. Only explicit compose mode sends to Telegram. If the outcome is unknown, the extension restores the text and closes compose without retrying. Check the group before sending again to avoid a duplicate.

## Configuration files

`/tg config` is the recommended entry point. For manual setup:

```bash
cp telegram.config.example.ts telegram.config.ts
cp .env.example .env
cp personas/template.en.md personas/friend.local.md
```

- `telegram.config.ts`: trusted local TypeScript containing non-secret schema and environment-key names, with comments and editor types.
- `.env`: the project's `key: value` colon format, containing only tokens, API keys, and the router secret.
- `personas/*.local.md`: local personas, ignored by Git by default.
- `bots.config.json`: legacy deployment compatibility; prefer TypeScript for new setups.

Read [Configuration](docs/user-guide/en/src/configuration.md) for a minimal one-bot config, additional bots, provider overrides, and routing rules. Tracked examples contain no valid credentials or private personas.

## When something fails

- Daemon not ready after `/tg config`: the valid files remain. Run `/tg status-daemon`, inspect `data/daemon.log`, fix credentials or networking, then run `/tg restart`.
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
