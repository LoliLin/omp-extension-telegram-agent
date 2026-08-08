# Configuration and additional bots

`/tg config` is the recommended entry point. To add bots or tune advanced fields, edit the ignored `telegram.config.ts`, then run `bun run restart` or `/tg restart` in Pi.

## File boundaries

| File | Contents | Commit it? |
| --- | --- | --- |
| `telegram.config.ts` | Group, bots, optional Pi model selection, routing, tools | No |
| `.env` | Telegram/TinyFish tokens and router secret | No |
| `personas/*.local.md` | Real deployment personas | No |
| `telegram.config.example.ts` | Public typed schema example | Yes |
| `personas/template.*.md` | Public generic persona templates | Yes |

`.env` uses the project's colon format, not dotenv equals syntax:

```text
telegram_bot_token: 123456:REPLACE_WITH_BOTFATHER_TOKEN
router_secret: REPLACE_WITH_RANDOM_LOCAL_SECRET
```

## Minimal one-bot configuration

```ts
import { defineConfig } from "./src/config-schema.ts";

export default defineConfig({
  group_peer_id: 1234567890,
  bots: [{
    id: "friend",
    name: "Mochi",
    token_env: "telegram_bot_token",
    persona_path: "personas/friend.local.md",
    routing_p: 0.1,
    sticker_sets: [],
    tools: { send: true, search: false, run_js: true },
  }],
});
```

See the repository's `telegram.config.example.ts` for annotated advanced defaults. TypeScript config is trusted local code. Edit only configuration you maintain; do not execute unreviewed snippets.

## Add a second or third bot

1. Add a distinct token key to `.env`.
2. Copy a public template to a new ignored persona.
3. Append an object to `bots`; `id` must be unique and contain only letters, numbers, `_`, or `-`.
4. Perform a controlled restart, then verify with `/tg attach <id>` and `/tg status <id>`.

```ts
{
  id: "helper",
  name: "Nori",
  token_env: "helper_bot_token",
  persona_path: "personas/helper.local.md",
  routing_p: 0,
  tools: { send: true, search: false, run_js: true },
}
```

`routing_p: 0` disables only probability sampling. Mentions, direct replies, and the configured name remain explicit triggers. The sum of every bot's `routing_p` must be `<= 1`, and configuration order defines deterministic probability-bucket order.

Each bot has an isolated Telegram poller, agent session, model selection, state, and telemetry. Bots share one Pi model runtime/auth snapshot plus the target group and canonical SQLite history.

## Pi model and tool overrides

When top-level model fields are omitted, every bot inherits Pi's merged default provider, model, and thinking level. Advanced deployments may set top-level or per-bot `provider` and `model` to select another catalog entry; switching provider requires both fields. `reasoning_effort` is also an optional selection override. Authentication always comes from Pi, never this configuration or `.env`. After changing Pi login/default-model settings, perform a controlled restart.

`tools` controls:

- `send`: Telegram Rich Message and sticker delivery;
- `search`: enables bounded TinyFish search and single-page retrieval through one tool; it requires the TinyFish key selected by `tinyfish_key_env` in `.env`;
- `run_js`: constrained deterministic computation.

The first-run wizard disables search. Before enabling it, add the TinyFish credential to `.env` (the default key name is `tiny_fish_api_key`); it is unrelated to Pi model authentication. Once enabled, the agent can search explicitly or read one public HTTP(S) page when an answer needs its contents. It never eagerly fetches every group link and does not support authenticated, private, or local targets.

## Routing and administrative commands

- Mention > reply > configured name > probability. Bot messages never trigger bot-to-bot runs.
- `routing_p` controls a normal human message's **response opportunity**, not a quota for final group posts. Each eligible message produces one deterministic value and enters at most one cumulative bucket. When the sum is 1, every eligible message has exactly one probability target.
- `sampling_cooldown_ms` applies only to probability routing; it defaults to 2000, and 0 disables cooldown.
- A busy or cooling probability target is skipped without reassignment. Mentions, replies, and configured names use the explicit path. Even after a run starts, the persona may remain silent and delivery may fail, so public-message ratios need not equal `routing_p`.
- Empty `telegram_admins` denies Telegram `compact/set/reset`. When needed, prefer your own positive numeric user ID; never copy a placeholder ID.
- Telegram `set/reset` stores an SQLite override without rewriting TypeScript; `reset` returns to the file baseline.

Audit the current deployment without writes:

```bash
bun run scripts/analyze-routing.ts            # use the default data/daemon.log
bun run scripts/analyze-routing.ts --no-log   # replay SQLite only
```

The report uses only ordinal labels such as `bot-1` and separately shows current-effective assignment, daemon started/busy/cooldown, LLM runs, and final public messages. A daemon log covers only a process segment and may rotate, so it is always `partial`; a missing log is `unavailable`, never a fabricated zero. Replaying history with today's configuration is counterfactual and does not prove the historical configuration. The command never writes the database or calls a model. Message bodies are reduced to trigger categories inside local SQLite and never enter script memory or output. A single custom log path may be supplied as the only argument.

## Legacy format and multiple groups

`bots.config.json` remains loadable, but new deployments should prefer TypeScript. Both default TS and legacy JSON together fail fast; `bots_config` accepts only explicit `.ts` / `.json` sources.

One deployment has one `group_peer_id`. Multiple groups require isolated working directories and data/session/database/PID/socket resources. Do not switch `bots_config` concurrently inside one checkout.

Next: [Chat and observe in Pi](using-pi.md).
