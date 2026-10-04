# Connecting your tools (API tokens)

Nebula talks to three kinds of outside tool: **trackers** that hold your tickets
(Jira, Linear, Asana, GitHub Issues…), **code hosts** that hold your pull
requests (Bitbucket, GitHub), and the **agent** you already use (Claude Code or
Codex). This guide gets a token — or no token at all — into each of them.

## Pick a route

| Tool | Route | Token lives in |
|---|---|---|
| Jira Cloud | native `jira` connection | nebula's `config.local.json` |
| Bitbucket Cloud | native `bitbucket` connection | nebula's `config.local.json` |
| GitHub (PRs, issues, checks) | the `gh` CLI | `gh`'s own keychain entry |
| Anything with an MCP server — Linear, Asana, Trello, ClickUp, monday.com, Shortcut, YouTrack, GitHub Issues, Jira too | `agent` connection | your agent (`claude mcp` / `codex mcp`) |

Rule of thumb: use a native connection when one exists (deterministic, no model
cost); use an `agent` connection for everything else.

## How nebula stores a secret (every connection)

A connection has two halves, both under the data dir (`nebula config path`
prints it — on macOS `~/Library/Application Support/dev.nebula.nebula/`):

- **`config.json`** — the non-secret settings: `id`, `kind`, URL, account.
- **`config.local.json`** — the token, keyed by the connection `id`. This layer
  is never exported, never forwarded over `nebula ssh`, never overwritten on
  import.

```json
{
  "secrets": {
    "connections": {
      "<connection-id>": { "token": "<the token>" }
    }
  }
}
```

An environment variable wins over the file — handy for CI or a one-off:
`NEBULA_TOKEN_<ID>`, the id upper-cased with every non-alphanumeric turned into
`_` (`work-jira` → `NEBULA_TOKEN_WORK_JIRA`).

> The token is plaintext on disk. `chmod 600 config.local.json` and keep it out
> of dotfile repos. OS-keychain storage is planned, not yet built.

## Jira Cloud

1. Open <https://id.atlassian.com/manage-profile/security/api-tokens> and choose
   **Create API token** (the classic one, *not* "with scopes" — scoped tokens
   only work through `api.atlassian.com`, not your site URL).
2. Name it `nebula`, pick an expiry, copy the token — it is shown once.
3. Add the connection to `config.json`:

   ```json
   {
     "connections": [
       {
         "id": "work-jira",
         "kind": "jira",
         "label": "Work Jira",
         "base_url": "https://your-site.atlassian.net",
         "account": "you@company.com"
       }
     ]
   }
   ```

   `account` is the email the token belongs to; `base_url` is the site, no
   trailing path. `jql` is optional (see [Jira ticket board](jira-tickets.md)).
4. Put the token in `config.local.json` under `work-jira`.

Check it by hand if the board says *error*:

```sh
curl -su you@company.com:$TOKEN https://your-site.atlassian.net/rest/api/3/myself
```

## Bitbucket Cloud

Bitbucket feeds the inbox with pull-request news (merged, declined, approved,
changes requested, comments, review requests). Auth is HTTP basic:
`account` + token.

1. Create the token — either works:
   - **API token (recommended):** <https://id.atlassian.com/manage-profile/security/api-tokens>
     → **Create API token with scopes** → app **Bitbucket**, and grant the
     read scopes for *account*, *workspace*, *repository* and *pull request*.
     `account` is then your **Atlassian email**.
   - **App password (legacy):** Bitbucket → Personal settings → App passwords,
     with read on Account, Repositories, Pull requests. `account` is then your
     **Bitbucket username**. Atlassian is retiring these; prefer an API token.
2. Add the connection to `config.json`, beside any Jira one:

   ```json
   { "id": "bb", "kind": "bitbucket", "label": "Bitbucket",
     "account": "you@company.com", "repos": ["acme/api", "acme/web"] }
   ```

   `repos` (`workspace/slug`) is optional. Left out, you hear about PRs you
   authored across every workspace; listed, you also get the ones you review.
3. Put the token in `config.local.json` under `bb`.

Check it by hand:

```sh
curl -su you@company.com:$TOKEN https://api.bitbucket.org/2.0/user
```

## GitHub

Nebula never holds a GitHub token. PR status, checks, comments, reviews and
issues all go through the [`gh` CLI](https://cli.github.com), which keeps its
own credential in the OS keychain:

```sh
brew install gh
gh auth login          # GitHub.com → HTTPS → login with a web browser
gh auth status         # should say "Logged in to github.com"
```

For GitHub Enterprise, `gh auth login --hostname github.example.com`. To see
GitHub **Issues** as cards on the ticket board, use the `agent` route below
with GitHub's MCP server.

## Any other tracker (the `agent` route)

If your agent can reach the tracker through MCP, nebula can list tickets
through it — no token in nebula at all. The agent holds and refreshes the
credential.

1. Connect the tracker to your agent, e.g. for Claude Code:

   ```sh
   claude mcp add --transport http linear https://mcp.linear.app/mcp
   claude mcp add --transport http github https://api.githubcopilot.com/mcp/ \
     --header "Authorization: Bearer $(gh auth token)"
   ```

   then run `/mcp` inside `claude` to finish any browser sign-in. For Codex,
   `codex mcp add …`. A claude.ai connector (Asana, Atlassian, Notion,
   monday.com…) counts too.
2. **Zero config:** with no `connections` in `config.json`, nebula finds it on
   its own — it reads `claude mcp list` / `codex mcp list` and makes one board
   connection per tracker it recognises. Done.
3. **Explicit:** or name it yourself (explicit connections switch discovery off):

   ```json
   { "id": "gh-issues", "kind": "agent", "label": "GitHub Issues",
     "harness": "claude", "source": "GitHub Issues",
     "mcp_servers": ["github"], "query": "repo acme/api, assigned to me" }
   ```

   `source` says which tracker in plain words; `mcp_servers` are the names
   `claude mcp list` prints. Each refresh is one short model turn (default
   every 5 minutes, `refresh_minutes` to slow it). The full field list is in
   [Jira ticket board](jira-tickets.md#list-tickets-through-claude-or-codex-agent-connection).

## Did it work?

Open the board (`Shift+J`) and press **`r`** to resync. Each
connection reads one of:

| State | Meaning | Fix |
|---|---|---|
| configured | set up, no token found | check the `id` under `secrets.connections` matches exactly |
| authenticated | the token logs in | wait for the first sync, or press `r` |
| verified | a sync succeeded | — |
| error | the last sync failed; last-known tickets stay | read the error on the board |

Common errors:

- **401 / Unauthorized** — wrong `account` for the token type (email for API
  tokens, username for Bitbucket app passwords), or the token expired.
- **403 / Forbidden** — the token lacks a scope, or your user can't see that
  project/repo.
- **404 on Jira** — `base_url` has a trailing path, or you used a scoped token.
- **agent connection: signed out** — run `/mcp` in `claude` (or re-add the
  server) and resync.

## Rotating or revoking

Create the new token, replace it in `config.local.json` (or the env var), press
`r`. Then revoke the old one on the same page you made it. Nothing else
references it.
