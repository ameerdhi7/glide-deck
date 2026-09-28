# NebulaX Desktop

A macOS desktop companion for [NebulaX](../nebula): ticket progress, your ticket
list, pull requests, desktop notifications for every update, and the NebulaX TUI
itself in a built-in terminal.

- **Overview** — done/total progress bar, what's in flight, what needs you.
- **Tickets** — the daemon's board, filterable, each ticket on a 7-step road
  (To do → Queued → Implementing → Ready → Reviewed → PR open → Done) with its
  brief, evidence, linked PRs and the run's diff.
- **Pull requests** — via your `gh` login: reviews waiting on you, your open PRs
  (checks, review decision, comments), and the last two weeks of merges.
- **Activity** — every change, kept across restarts; the same events become
  macOS notifications (toggle per category in Settings).
- **Terminal** — runs `nebula` in a real PTY; *Open in Terminal.app* hands off.

The app starts its own `nebula web --no-open` bridge on port 7691 (and
`nebula daemon` if none is running) — the daemon stays the source of truth, and
the app stays read-only: you drive from the terminal.

## Run

Needs Node 22+ (`nvm use`), `nebula` on your PATH, and `gh auth login` for PRs.

```sh
npm install      # also rebuilds node-pty for Electron
npm start
npm test
npm run dist     # unsigned dist/mac-arm64/NebulaX.app  (dist:dmg for a .dmg)
```

Dev isolation: `NEBULA_RUNTIME_DIR`/`NEBULA_DATA_DIR` point it at a sandboxed
daemon, `NEBULAX_USER_DATA` at separate settings, and `NEBULAX_CAPTURE_DIR`
screenshots every view and quits.
