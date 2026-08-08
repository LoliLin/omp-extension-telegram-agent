# Chat and observe in Pi

## Open the feed

The daemon stays online independently. Open or close Pi whenever needed:

```bash
bun run pi
```

Successful first setup attaches the global feed automatically. Later, choose the scope explicitly:

```text
/tg attach             # Group messages + every bot's LOCAL events
/tg attach friend      # Group messages + friend LOCAL/usage only
/tg more               # Load one older history page
/tg detach             # Disconnect live IPC but retain the transcript
```

The Telegram feed is one TUI-only Pi custom entry. Pi owns scrolling, resizing, selection, themes, image layout, and the footer. Displaying messages does not put them into the current Pi agent's provider context.

Use Tab or Pi's selection menu after `/tg `. Bot arguments come from the currently validated config.

## Send explicitly

`attach` is always read-only. To send from the Pi editor:

```text
/tg compose friend
# Enter and submit plain text in the editor
/tg compose off
```

The footer continuously shows the active send identity. Compose intercepts only interactive editor input; RPC and extension sources continue to Pi. Attachments are blocked instead of silently sending only their caption.

An explicit failure restores the editor text. If the acknowledgement is lost or the connection drops during send, the outcome is unknown:

1. compose closes automatically;
2. the extension does not retry;
3. inspect the Telegram group;
4. send again only when the message is absent.

This boundary prevents a remote success plus local acknowledgement failure from creating duplicate messages.

## Status and footer

```text
/tg panel              # Global Telegram telemetry
/tg panel friend       # One-bot telemetry
/tg panel off          # Restore the current Pi session footer
/tg status friend      # Lifetime + latest details
```

Pi's native footer renders `↑/↓/R/W/CH/$/context/model`. Lifetime values cover retained SQLite `llm_runs` across Pi and daemon restarts and context epochs. Context is the latest run's current use, not a historical sum.

## Local events, streams, and media

- Assistant thinking/text/tool partials update one Pi-native card in place. Persistent LOCAL/Telegram events replace them at completion; partials are not stored in SQLite.
- Local assistant text when a bot does not call `send` remains feed-only and never reaches the group.
- Photo and sticker vision runs lazily only when a real bot run needs media context; opening the UI never adds a vision call.
- Inline image visibility follows Pi terminal capabilities and local media preparation. Text, media labels, and vision descriptions remain readable fallbacks.

## Daemon commands in Pi

```text
/tg start
/tg restart
/tg stop
/tg status-daemon
```

`/tg restart` closes compose and old IPC, then replaces the whole deployment through controlled process management. A ready result restores the feed; failure retains the transcript and gives a diagnostic.

Next: [Daily operations](operations.md).
