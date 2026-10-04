# Architecture

Glide Deck is an Electron app that sits on top of the NebulaX daemon. The daemon
remains the source of truth. Glide Deck watches it and starts work only through
the daemon's own requests.

```
 ┌──────────── Electron main process ─────────────┐        ┌───────────────┐
 │ bridge.js ── ws ──► nebula web --no-open :7691 ─┼──────► │ nebula daemon │
 │ prs.js / bitbucket-prs.js / agent-prs.js        │        └───────────────┘
 │ terminal.js (node-pty + headless xterm)         │
 │ diff.js → activity feed → notifications, sound  │
 │ rotator.js, connections.js, settings.js         │
 └───────────────▲─────────────────────────────────┘
                 │ preload.js (named calls + subscriptions, no Node)
 ┌───────────────┴─────────────────────────────────┐
 │ renderer: app.js, index.html, styles.css         │
 └──────────────────────────────────────────────────┘
```

## Main process (`src/main/`)

The main process owns every long-lived part of the app, so notifications keep
arriving while the window is closed.

| Module | Job |
|---|---|
| `main.js` | Window, tray/dock badge, IPC wiring, and the activity feed. |
| `bridge.js` | Finds `nebula` and runs `nebula web --no-open` on its own port (default 7691). If no daemon is running, it starts `nebula daemon` and connects over WebSocket. On a dropped connection it reconnects with backoff. The app never speaks the daemon's socket protocol itself, so a protocol change only has to be handled in Rust. |
| `env.js` | Apps launched from Finder get launchd's bare `PATH`. This module asks the login shell for the real one, with the usual install dirs as a fallback. |
| `prs.js` | Polls pull requests from the chosen provider and returns three lists: PRs waiting on your review, your open PRs, and your recent merges. |
| `bitbucket-prs.js` | Reads Bitbucket Cloud's REST API with each `bitbucket` connection's token. Its PRs are merged into the provider's results. |
| `agent-prs.js` | Has Claude Code or Codex list PRs through the MCP servers you already connected. Each listing is one read-only headless turn, so it runs every `refreshMinutes`. |
| `connections.js` | Edits NebulaX's tracker connections. The non-secret half goes to `config.json` and the token to `config.local.json`. Every other key in those files is left as it was. |
| `diff.js` | Pure change detection: compares old state with new and names the events worth telling you about. It has unit tests. |
| `rotator.js` | Removes stale worktrees on a timer through the daemon's `worktrees/delete`. It never forces a removal and never touches a checkout with a running session. |
| `terminal.js` | Runs the NebulaX TUI in a real PTY and mirrors its output into a headless xterm. Output streams to the window only while the view is open. |
| `sound.js` | Plays activity sounds with `afplay` (macOS system sounds). |
| `settings.js` | Settings and the activity feed, stored as small JSON files that are written atomically. |

## Shared (`src/shared/`)

Plain scripts with no imports, so the renderer can load them as classic scripts:

- `progress.js` — the 7-step ticket road (To do → Queued → Implementing → Ready → Reviewed → PR open → Done).
- `links.js` — links tickets and PRs, using ticket keys found in a PR's title or branch, or links reported by the provider.

## Renderer (`src/renderer/`)

A single page with no framework. Its views are Overview, Working hub (the TUI),
Projects, Worktrees, Tickets, Pull requests, Activity, Notes and Terminal. It
reaches the main process only through the API exposed in `preload.js`.
