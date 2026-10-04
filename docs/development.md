# Development

You need Node 22+ (`nvm use` reads `.nvmrc`), with `nebula` on your `PATH`.

```sh
npm install      # also rebuilds node-pty for Electron
npm start
npm test         # node --test, no Electron needed
npm run dist     # unsigned dist/mac-arm64/Glide Deck.app
npm run dist:dmg # a .dmg
```

## Isolating a dev run

| Variable | Effect |
|---|---|
| `NEBULA_RUNTIME_DIR`, `NEBULA_DATA_DIR` | Point the app at a sandboxed daemon. |
| `NEBULAX_USER_DATA` | Use separate settings and a separate activity feed. |
| `NEBULAX_OPEN_VIEW` | Open on a given view (`tickets`, `prs`, …). |
| `NEBULAX_CAPTURE_DIR` | Screenshot every view into this dir, then quit. |
| `NEBULAX_CAPTURE_DELAY_MS` | How long to wait before each capture. |

## Tests

Logic that runs without Electron stays pure so `node --test` can run it:
change detection (`diff.js`), ticket ↔ PR links, connections file patching,
Bitbucket parsing, rotation, sounds and notes.

## The site

`site/` holds the static landing page and docs viewer, deployed to Vercel. See
[`site/README.md`](../site/README.md).
