# Pi Telegram Agent user guide

[中文指南](../../zh/src/README.md) · [Back to the project README](../../../../README.en.md)

This guide is for operators and users. You can connect 1..N configurable AI companions to one Telegram supergroup and use Pi's native interface without first learning the internal architecture.

## Shortest path

1. Prepare the group ID, a BotFather token, and LLM provider credentials.
2. Run `bun run pi` from the repository.
3. Run `/tg config` in Pi and wait for the all-bots feed to open.

Read in order:

- [Installation and first setup](getting-started.md): Telegram/provider preparation and the native wizard.
- [Configuration and additional bots](configuration.md): typed config, secret boundaries, routing, and N-bot setup.
- [Chat and observe in Pi](using-pi.md): attach, compose, history, and telemetry.
- [Daily operations](operations.md): daemon lifecycle, configuration changes, backups, and multi-group isolation.
- [Troubleshooting](troubleshooting.md): move from an observable symptom to a safe next action.
- [Cost design overview](design-cost.md): how routing, cache, context, vision, and UI avoid wasted calls and tokens.

## Product boundaries

- One deployment = one Telegram supergroup + 1..N bots.
- Closing Pi does not stop the daemon. Telegram is the chat venue; Pi is the local observation and control interface.
- Multiple groups require isolated working directories and all data/session/process resources.
- `telegram.config.ts` is trusted executable local code, not a sandbox for downloaded configuration.
- Tracked files contain no valid credentials or deployment personas; older Git history may still contain removed personas.
