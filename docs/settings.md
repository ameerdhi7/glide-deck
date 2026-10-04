# Settings

Settings are stored in Electron's userData dir (`settings.json`). You can change
all of them from the Settings panel in the app.

## NebulaX

| Key | Default | Meaning |
|---|---|---|
| `nebulaBin` | `""` | Path to `nebula`. Leave empty to find it on your login `PATH`. |
| `bridgePort` | `7691` | Port for the app's own `nebula web` bridge. It differs from the CLI's 7690 so the two never clash. |

## Pull requests

| Key | Default | Meaning |
|---|---|---|
| `prs.provider` | `gh` | `gh` (your GitHub CLI login), `claude`, or `codex`. |
| `prs.source` | `GitHub` | Agent providers only: the code host to ask, in plain words. |
| `prs.model` | `""` | Agent providers only. Empty uses `haiku` for Claude and Codex's default for Codex. |
| `prs.mcpServers` | `""` | Claude only: MCP server names, comma-separated. |
| `prs.query` | `""` | Extra scope in plain words, such as "only the api and web repos". |
| `prs.refreshMinutes` | `10` | How often an agent listing runs. Each run is a paid model turn. |
| `prPollSeconds` | `60` | Poll interval for `gh` and Bitbucket. |

Bitbucket Cloud PRs come from **Settings → Connections**. Add a `bitbucket`
connection with an Atlassian API token and the repos to watch.

## Connections

Glide Deck edits NebulaX's own connections. Jira and other trackers are stored
in `config.json`, and their tokens go to `config.local.json`, which NebulaX never
exports. GitHub needs no connection: Glide Deck uses your `gh auth` login.

## Notifications & sounds

| Key | Default | Meaning |
|---|---|---|
| `notify.tickets` / `prs` / `connections` | `true` | Which kinds of activity raise a macOS notification. |
| `notify.prsLinkedOnly` | `false` | Notify only about PRs linked to a ticket on the board. The feed still shows every PR. |
| `notify.whenFocused` | `false` | Show banners even while the window is focused. |
| `notify.sound` | `true` | Play a sound as activity arrives. |
| `notify.sounds` | Glass / Ping / Basso | macOS system sound for each kind of activity. `""` means no sound. |

## Worktree rotation

| Key | Default | Meaning |
|---|---|---|
| `rotate.enabled` | `false` | Turn rotation on. |
| `rotate.olderThan` / `unit` | `7` `days` | Age cutoff (`hours`, `days` or `weeks`). |
| `rotate.basis` | `activity` | Measure age from the last git activity (`activity`) or from when the checkout was created (`created`). |

Rotation never forces a removal. Checkouts with uncommitted changes are kept and
reported, and checkouts with a running session are skipped.

## Starting tickets

`start.harness` (default `claude`) picks the agent that implements a ticket when
you press play, and `start.base` (default `develop`) is the branch its worktree
is cut from.
