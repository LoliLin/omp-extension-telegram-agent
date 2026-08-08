# Troubleshooting

Choose a safe next action from the observable symptom. Do not delete data, PID files, or sockets just to experiment. The [daemon runbook](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/runbooks/daemon.md) owns full recovery procedures.

## `bun run pi` does not start

Run:

```bash
bun install --frozen-lockfile
bun run pi --version
```

The expected version is the project-locked Pi 0.84.1. If installation fails, retain the error and fix registry/network access. Do not hide the problem by switching to an unlocked global Pi.

## `/tg config` is missing

Confirm you started `bun run pi` from the repository root and package discovery loaded `.pi/extensions/tg-extension.ts`. `config` is static and does not depend on an existing deployment. If it is completely absent, inspect Pi/package loading instead of creating an empty JSON file.

## The wizard refuses configuration

- Field error: correct the fields named in the notification; values are never echoed.
- Missing/invalid `bots_config`: create the selected `.ts`/`.json` source or remove the override from `.env` / the process.
- Both default TS and legacy JSON exist: retain one or select one explicitly; do not guess by modification time.
- Existing files: choose validate/editor or explicitly confirm backup-replace. Cancellation preserves bytes.
- Pi model preflight: leave the wizard, use Pi `/login` and `/model`, then retry. No deployment file was written.

## Config is valid but the daemon is not ready

```text
/tg status-daemon
/tg restart
```

Then inspect `data/daemon.log`. Typical causes include an invalid Telegram token, unreachable network, changed Pi login/default-model settings, a model absent from Pi's catalog, or a bot missing from the target group. Valid files remain, so you do not need to paste the token again.

## `daemon starting` persists

Configured sticker sets may make first catalog/vision preparation slower. Run `bun run status` and inspect redacted logs. A live child after the 60-second wait is reported only as starting; readiness requires a real socket connection.

## Telegram 401 or no group messages

- 401: rotate or correct that bot's token, ensure `token_env` selects the right key, then restart.
- Ordinary messages are absent: disable group privacy for that bot in BotFather and confirm it joined the intended supergroup.
- The bot cannot send: inspect group permissions. Do not grant unrelated administrator rights for ordinary reading.

## Telegram 409 / duplicate poller

Another process is long-polling with the same token. Run `bun run restart`; the controller verifies and recovers this deployment's real daemon and orphans. Do not blindly signal the PID-file number or start concurrently.

## Pi feed or compose disconnects

- `no connected Telegram feed`: run `/tg attach [bot]` and wait for the snapshot connection.
- `unknown bot id`: use `/tg ` completion or inspect configured IDs.
- Unknown compose outcome: inspect the group and retry only when absent.
- `/tg detach` and closing Pi do not stop the daemon; attach again later.

## Images do not render inline

A new photo first shows its media label, then the daemon downloads it in the background and updates the same Pi card. This does not depend on a bot responding or on vision running. Startup backfills only the newest 100 missing records, so very old gaps may require later restarts to continue.

If a new photo remains label-only, inspect only the fixed `media_cache_ready/skip/error` category and queue number in redacted logs, then check the 1 MiB limit, terminal image capability, and project Pi version. Pi still selects Kitty, iTerm2, or native text fallback. Do not add terminal escapes or bypass Pi components. Record terminal type, tmux state, media kind, fixed outcome, and whether a local path exists—never a token, absolute path, or private image contents.

## Still unable to recover

Collect only non-sensitive evidence:

- `bun run status` output;
- `bun run pi --version`;
- a manually reviewed, redacted tail of `data/daemon.log`;
- the failed command, bot ID, and fresh/legacy/custom `bots_config` state;
- terminal and tmux details when UI is involved.

Never submit `.env`, real personas, full group messages, tokens, API keys, or unredacted absolute paths.
