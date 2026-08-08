# Cost design overview

The project promises no fixed savings percentage. Provider pricing, group activity, persona length, and model cache behavior all vary. Measure your deployment through Pi's footer, `/tg status`, and retained SQLite telemetry.

“Minimal” means fewer mechanisms, not fewer safeguards: minimize state, interfaces, network requests, and provider-visible bytes while preserving transactions, timeouts, redaction, tests, and observability. The six mechanisms below are the current expression of that philosophy, not a roadmap for a general platform.

## 1. Deterministic routing decides whether to call a model

Local code handles mentions, replies, configured names, and HMAC probability buckets. An unmatched ordinary message creates no provider run. A probability target that is busy or cooling down is not reassigned or sampled again.

This avoids an entire unnecessary call instead of shaving a few tokens after starting one. See [Routing architecture](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/architecture.md).

## 2. A stable provider prefix reuses cache

Persona, fixed protocol, and fixed-order tool schemas form the stable prefix. New messages append only to the suffix; dynamic information never rewrites an existing prefix.

A cache-visible grammar change must increment the schema and open a new context epoch. UI, telemetry, and operator commands may not alter provider bytes. See [Cache engineering](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/cache.md).

## 3. Bounded context carries only necessary facts

SQLite retains canonical Telegram history, while a model receives only bounded unexposed messages, required replies, and deterministic projections. Logs, raw rich JSON, UI state, and unbounded tool output never enter provider context.

This separates the complete local source of truth from the context necessary for one run. See [Architecture](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/architecture.md) and the [data model](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/data-model.md).

## 4. Compaction changes epochs at an explicit boundary

At the configured context threshold, Pi produces a summary, retains the recent tail, and starts a new epoch. Failed or empty summaries do not fabricate an epoch, and exposure follows the actual retained tail.

Compaction itself uses an auxiliary model, so it is not an every-turn online optimizer. Configuration controls the threshold and retained amount; telemetry validates the result. See [Cache engineering](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/cache.md) and [test status](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/testing.md).

## 5. Media vision runs lazily and reuses results

Photos and stickers enter canonical SQLite first. Vision runs only when a real bot turn needs media context. The result is persisted by media identity and reused across bots. UI updates consume that result without adding a model call.

See the [Vision architecture](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/architecture.md).

## 6. UI and telemetry use side channels

The Pi-native feed, assistant partials, footer, `/tg status`, and Telegram controls use local IPC, SQLite, and the deterministic control plane. They remain outside personas and main provider context.

Opening Pi, scrolling history, changing a panel, or viewing usage therefore does not create a chat-model call. See the [Pi-native transcript architecture](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/architecture.md) and [Cache engineering](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/cache.md).

## Evaluate your deployment

1. Record runs, prompt miss/read/write, output, reasoning, latency, and cost with `/tg status [bot]`.
2. Compare similar activity periods; do not mix providers, personas, or group sizes in one conclusion.
3. Replay threshold candidates with `scripts/analyze-context-window.ts`; do not tune compaction by intuition.
4. Before changing prompts, tools, or serialization, follow the cache process in the [development guide](https://github.com/mizorewww/pi-extension-telegram-agent/blob/main/docs/engineering/development-guide.md).
5. Before adding a capability, try to remove one layer, tool, model call, or dynamic field. Do not expand a one-group deployment into a multi-tenant system without an explicit requirement.
