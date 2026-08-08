# Daily operations

## Canonical commands

```bash
bun run start
bun run status
bun run restart
bun run stop
```

- `start`: starts in the background and waits for PID/socket readiness; invalid config fails before any bot polls.
- `restart`: serially stops the deployment's PID owner and orphan processes, waits for every PID/file/socket to disappear, then starts one replacement.
- `status`: verifies that the PID belongs to this repository's daemon instead of trusting the file alone.
- `stop`: gracefully stops bots, agents, and IPC with SIGTERM.

Logs are in `data/daemon.log`. The controller shows only a bounded credential-redacted tail. Never post a full `.env` or unreviewed logs.

## Configuration changes

Configuration is not hot-reloaded. After changing `telegram.config.ts`, `.env`, or a persona, run:

```bash
bun run restart
```

You can also use `/tg config` in Pi to validate or safely edit an existing source. Replacement retains local `.bak-<nonce>` files. Confirm the new deployment is ready before applying your backup-retention policy; do not delete backups as incidental cleanup.

## Data and backups

Persistent resources default to `data/` and local project session directories. SQLite is canonical history; Telegram is not the restore source.

Before backup:

1. run `bun run stop`;
2. confirm `bun run status` no longer reports running;
3. copy configuration, personas, data, and session resources to an access-controlled destination;
4. keep `.env` and private personas out of public artifacts.

Never start two daemons against one copied database in the same directory.

## Telegram group controls

Public read commands are `/tg help`, `/tg bots`, and `/tg status [bot]`.

Only `telegram_admins` may run:

```text
/tg compact <bot|all>
/tg set <bot> routing_p <0..1>
/tg set <bot> cooldown_ms <0..3600000>
/tg reset <bot> <routing_p|cooldown_ms>
```

The deterministic control plane consumes these commands outside persona/provider context. `compact` uses the existing auxiliary summarization model and may incur cost. Busy bots are not aborted.

## Real verification

Default `bun test` avoids Telegram/provider calls except explicitly environment-gated cases. Networked scripts require a bot selection:

```bash
bun run scripts/smoke-pi.ts --bot friend
bun run scripts/e2e-agent.ts --bot friend
bun run scripts/e2e-compaction-manual.ts --bot friend
```

These commands may incur cost or post group messages. Read the [daemon runbook](../../../runbooks/daemon.md) first and record the selected bot, expected side effects, and rollback.

## Multiple groups

One working directory currently hosts one group deployment. A second group must isolate:

- config and `.env`;
- `data/agent.db`, PID, control lock, and socket;
- agent session directories;
- daemon working directory.

Do not run different `bots_config` values concurrently against shared data.

Next: [Troubleshooting](troubleshooting.md).
