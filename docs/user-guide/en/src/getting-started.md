# Installation and first setup

## 1. Prepare the local environment

Install Bun, clone the repository, and enter the project directory:

```bash
git clone <repository-url> pi-extension-telegram-agent
cd pi-extension-telegram-agent
bun run pi
```

`bun run pi` performs a frozen-lockfile install only when the project Pi CLI is missing, then starts the locked Pi 0.84.1. It does not read a sibling `../pi` checkout. Run `bun install --frozen-lockfile` when you need an explicit installation step.

## 2. Prepare Telegram

For every bot:

1. Create it with BotFather and retain the token.
2. Disable group privacy in BotFather so the bot receives ordinary group messages.
3. Add the bot to the target supergroup. Grant send permission if the group's restrictions require it.
4. Obtain the supergroup's numeric ID. The wizard accepts bare positive, negative, or `-100...` forms and normalizes them.

Never paste a token into the group, an issue, logs, or Git. Give every bot a distinct token environment-key name.

## 3. Prepare a provider

You need:

- a provider ID and model ID present in the current Pi model catalog;
- that provider's API key;
- the name to use in `.env`, such as `llm_api_key`.

The wizard suggests `deepseek` / `deepseek-v4-flash`, but you may select another installed Pi catalog entry. First setup uses `tools.search: false`, so a TinyFish key is not required.

## 4. Run `/tg config`

`/tg config` remains available in Pi help and completion when configuration is missing or invalid. The daemon does not need to be running.

The wizard asks for:

1. a Chinese or English public persona template;
2. the Telegram supergroup ID;
3. provider ID, model ID, provider environment-key name, and API key;
4. local bot ID, Telegram display name, token environment-key name, and BotFather token;
5. final write confirmation.

Pi's current native `input` dialog does not mask passwords. API keys and tokens remain visible while entered. Use a private terminal and do not record or share the screen. The wizard never places these values in notifications, process arguments, the Pi session, or provider context.

Pressing Esc at any step leaves no partial deployment. After confirmation, the wizard atomically creates:

- `.env`: credentials, mode 0600, ignored by Git;
- `telegram.config.ts`: environment-key references only, mode 0600, ignored by Git;
- `personas/<bot-id>.local.md`: local persona, mode 0600, ignored by Git.

## 5. Confirm readiness

The wizard validates the complete deployment with the production loader, then invokes the controlled daemon restart. Pi opens the all-bots feed only when the command exits successfully and explicitly reports `daemon ready`.

When credentials or networking prevent readiness, the validated files remain and the UI does not claim a connection. Run:

```text
/tg status-daemon
/tg restart
```

Inspect the redacted tail of `data/daemon.log` when needed. Do not overwrite configuration repeatedly just to retry.

## Existing configuration

Running `/tg config` again lets you:

- validate the current deployment;
- edit a project-root `.ts` / `.json` source in Pi and retain an exact backup after confirmation;
- explicitly back up and replace a default source;
- cancel without changing a byte.

When `.env` or the process selects a custom `bots_config` source, the wizard will not write an unrelated default file that the daemon would ignore. Fix or remove a missing/invalid override first.

Next: [Configuration and additional bots](configuration.md).
