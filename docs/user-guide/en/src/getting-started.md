# Installation and first setup

This project runs 1..N AI bots, each with its own persona, inside one Telegram supergroup. It is designed to be fast (a resident daemon routes messages directly), context-optimized (the provider prefix cache means repeated context is not billed again), and simple (one configuration track, no intermediate concepts) — low cost is the result of those three.

There is exactly one configuration track: `telegram.config.ts` for non-secret settings, `.env` for secrets such as tokens, and omp for model authentication. The wizard below writes these files for you in its final step.

## 1. Prepare the local environment

Install Bun, clone the repository, and enter the project directory:

```bash
omp install <repository-url>
```

The extension loads with omp automatically (for local development, `omp plugin link <repo-path>`). Run `bun install` in the checkout when you want the test/typecheck toolchain locally.

## 2. Prepare Telegram

For every bot:

1. Create it with BotFather and retain the token.
2. Disable group privacy in BotFather so the bot receives ordinary group messages.
3. Add the bot to the target supergroup. Grant send permission if the group's restrictions require it.
4. Obtain the supergroup's numeric ID. The wizard accepts bare positive, negative, or `-100...` forms and normalizes them.

Never paste a token into the group, an issue, logs, or Git. Give every bot a distinct token environment-key name.

## 3. Prepare the omp model

In the omp session:

1. Run `/login` and complete Pi's native provider authentication.
2. Run `/model` and select the default provider and chat model. The Telegram runtime uses reasoning `off` unless `telegram.config.ts` explicitly overrides it, even if the interactive Pi session uses another thinking level.

The Telegram project reads omp's merged model settings and auth store (`~/.omp/agent`). It does not copy model credentials into this repository. First setup uses `tools.search: false`, so a TinyFish key is not required.

## 4. Run `/tg config`

`/tg config` remains available in omp help and completion when configuration is missing or invalid. The daemon does not need to be running.

Before opening input dialogs, the wizard locally preflights the displayed `provider/model:thinking` against Pi's catalog and authentication. It makes no model request. The wizard then asks for:

1. a Chinese or English public persona template;
2. the Telegram supergroup ID;
3. local bot ID, Telegram display name, token environment-key name, and BotFather token;
4. final write confirmation.

Pi's current native `input` dialog does not mask passwords. The BotFather token remains visible while entered. Use a private terminal and do not record or share the screen. The wizard never places it in notifications, process arguments, the Pi session, or provider context. Provider authentication stays in Pi and is never requested here.

Pressing Esc at any step leaves no partial deployment. After confirmation, the wizard atomically creates:

- `.env`: the Telegram token, mode 0600, ignored by Git;
- `telegram.config.ts`: Telegram deployment fields; the wizard pins the Pi provider/model it just preflighted and explicitly keeps reasoning/search/`run_js`/vision off with bounded context/cache/retention defaults, mode 0600, ignored by Git;
- `personas/<bot-id>.local.md`: local persona, mode 0600, ignored by Git.

## 5. Confirm readiness

The wizard validates the complete deployment with the production loader, then invokes the controlled daemon restart. Pi opens the all-bots feed only when the command exits successfully and explicitly reports `daemon ready`.

If Pi has no valid default model or authentication, the preflight stops before any dialog or write. Use Pi `/login` and `/model`, then run `/tg config` again.

When Telegram credentials or networking prevent readiness, the validated files remain and the UI does not claim a connection. Run:

```text
/tg status-daemon
/tg restart
```

Inspect the redacted tail of `data/daemon.log` when needed. Do not overwrite configuration repeatedly just to retry.

## Existing configuration

Running `/tg config` again lets you:

- validate the current deployment;
- edit the project-root `telegram.config.ts` source in Pi and retain an exact backup after confirmation;
- explicitly back up and replace a default source;
- cancel without changing a byte.

Next: [Configuration and additional bots](configuration.md).
