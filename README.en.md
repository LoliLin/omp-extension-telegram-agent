# omp Telegram Agent

[中文](README.md) · [English](README.en.md)

Let a few AI bots, each with its own persona, live permanently in your Telegram group: they join conversations by probability, answer when named, send animated stickers, and understand images and videos — like real group members. You observe and control everything from the local [omp](https://omp.sh) terminal.

## Features

- **Multiple persona bots**: 1..N bots per group, each with its own persona, model, reply probability, and cooldown; deterministic HMAC routing decides who speaks — no model calls spent on plumbing.
- **Telegram-native**: group messages, edits, replies, and media (photo/sticker/video) land in local SQLite; exactly three fixed tools (`send`, `search`, `run_js`) — no filesystem tools.
- **Cost-efficient**: the provider prefix cache means stable context is never billed twice; routing, dedupe, state, and stats are pure deterministic code; compaction summarizes history as "state" with a dedicated aux model.
- **omp-native observation**: `/tg attach` shows the full conversation, LOCAL events, and live agent activity cards in the omp transcript; the attached footer shows Telegram usage/model without touching provider context.
- **Operable**: a long-lived daemon, `/tg restart` restores the feed in place, `bun run debug` produces one redacted diagnostic report, structured JSONL logs.

## Quick start

You need:

- [Bun](https://bun.sh/) and [omp](https://omp.sh) (≥ 17.4.0)
- A Telegram supergroup and at least one [BotFather](https://t.me/BotFather) token (the bot must be in the group with privacy mode disabled, or it cannot see ordinary messages)
- Optional: video understanding needs host `ffmpeg` (with `ffprobe`); without it, everything else including static-image vision keeps working

Install the plugin (for local development, `omp plugin link <repo-path>`):

```bash
omp install <repository-url>
```

Then two things inside omp:

1. Use omp's model commands to authenticate a provider and pick the default model — credentials stay with omp, outside this repo.
2. Run `/tg config`: it preflights `provider/model:thinking` locally (no model request), then collects the group ID, bot token, and persona; once validated, the daemon comes up and the all-bots feed opens.

Mention your bot in the group or just say something; `/help` lists the group commands.

> Note: omp's input dialog does not mask secrets — the token stays visible while you paste it. Use a private terminal and don't record your screen.

## Everyday use

### Inside omp (`/tg` commands)

| Command | What it does |
|---|---|
| `/tg attach [bot]` | Open the live feed for all bots or one bot |
| `/tg more` / `/tg detach` | Load one older history page / disconnect the live socket |
| `/tg compose [bot\|off]` | Send group messages from the editor as a chosen bot |
| `/tg status [bot]` | Telegram usage and model status |
| `/tg start` `/tg restart` `/tg stop` | Daemon lifecycle; restart restores the feed in place |
| `/tg status-daemon` | Daemon process status |
| `/tg config` | Setup wizard (validate / edit / backup-and-replace) |

### CLI

```bash
bun run start      # Start the daemon in the background
bun run status     # Check status
bun run restart    # Restart to apply config changes
bun run stop       # Stop
bun run debug      # One redacted diagnostic report
```

In the group, `/help` and `/status` work for everyone; admins (listed in `telegram_admins`) also get `/compact` and `/set` — `/set` writes the new value straight back into the config file, so it survives restarts.

## Configuration

Exactly one configuration track:

- **`telegram.config.ts`**: every non-secret setting (group, bots, provider/model, routing, compaction, vision, retention), with a comment on each field. Copy [telegram.config.example.ts](telegram.config.example.ts) and change a few values; adding a bot is one entry in `bots`.
- **`.env`**: project-owned secrets (bot tokens, TinyFish, router secret), `key: value` colon format, Git ignored.
- **omp auth store**: provider credentials (kept by omp after `/login`); the project never copies them.

Full field reference: [Configuration guide](docs/user-guide/en/src/configuration.md).

## How it works (one minute)

A single long-lived daemon owns SQLite and the IPC server: Telegram long-polling → canonical messages to the database → deterministic routing → one omp `AgentSession` per bot, thinking only when needed. The omp extension pulls history and subscribes to live events over IPC; all presentation lives on the omp side, and closing omp never affects the daemon. Architecture details: [docs/architecture.md](docs/architecture.md).

## Security and privacy

- Secrets never enter logs, the database, sessions, or provider context; `.env` stays out of the repo.
- `run_js` executes in a sandbox (no filesystem, network, process, or environment access); see the architecture doc for the threat model.
- Group message text is stripped of ANSI/OSC control sequences before rendering, blocking terminal injection.

## Getting help

- Common problems: [Troubleshooting](docs/user-guide/en/src/troubleshooting.md)
- Daemon operations (restart, logs, diagnostics): [daemon runbook](docs/runbooks/daemon.md)
- Complete user guide: [English](docs/user-guide/en/src/README.md) · [中文](docs/user-guide/zh/src/README.md)

## Contributing

Start with [AGENTS.md](AGENTS.md) and the [development guide](docs/engineering/development-guide.md); the documentation index is [docs/index.md](docs/index.md). Verification funnel: `bun test` → `bun run check` → `bun run lint` → `bun run docs:check`.

Licensed under MIT — see [LICENSE](LICENSE).
