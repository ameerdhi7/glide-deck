// Pull requests from Bitbucket Cloud, read straight from its REST API with the
// token of each `bitbucket` connection in Settings → Connections. They are
// merged into whatever the chosen PR provider (gh, or an agent) returns.
//
// Only the listed `repos` are read, and only the PRs that involve you: yours,
// and the ones waiting on your review. Who "you" are comes from `GET /user`,
// which needs `read:user:bitbucket` — a scope a workspace admin can hide.
// Without it, a Jira connection on the same Atlassian login answers instead:
// Jira's `accountId` is the Bitbucket `account_id`. With neither, every open
// PR in the repos lands in "Open in watched repos".

const API = "https://api.bitbucket.org/2.0";
const HTTP_TIMEOUT_MS = 20000;
const RECENT_DAYS = 14;
const FIELDS = "+values.participants,+values.reviewers,+values.draft";

async function get(auth, url) {
  const res = await fetch(url, {
    headers: { Authorization: auth, Accept: "application/json" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const said = body && body.error && body.error.message;
    const err = new Error(`HTTP ${res.status}${said ? ` — ${said}` : ""}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

/** `GET /user`, or null when the token may not read it (403). */
async function whoami(auth) {
  try {
    return await get(auth, `${API}/user`);
  } catch (e) {
    if (e.status === 403) return null;
    throw e;
  }
}

/**
 * `{ account_id }` from Jira's `/myself` — the same Atlassian account as the
 * Bitbucket one — or null when there is no Jira connection or it fails.
 */
async function jiraMe(jira) {
  if (!jira) return null;
  try {
    const auth = `Basic ${Buffer.from(`${jira.account}:${jira.token}`).toString("base64")}`;
    const me = await get(auth, `${jira.baseUrl.replace(/\/+$/, "")}/rest/api/3/myself`);
    return me.accountId ? { account_id: me.accountId } : null;
  } catch {
    return null;
  }
}

/** Whether Bitbucket user `u` is `me`, by uuid or Atlassian account id. */
function isMe(u, me) {
  if (!u || !me) return false;
  return (!!me.uuid && u.uuid === me.uuid) || (!!me.account_id && u.account_id === me.account_id);
}

/** The review decision the app shows, from the participants' states. */
function decision(pr, me) {
  const others = (pr.participants || []).filter((p) => !isMe(p.user, me));
  if (others.some((p) => p.state === "changes_requested")) return "CHANGES_REQUESTED";
  if (others.some((p) => p.approved || p.state === "approved")) return "APPROVED";
  return (pr.reviewers || []).length ? "REVIEW_REQUIRED" : null;
}

/** Which list a PR goes in, or null to leave it out. */
function bucketFor(pr, me) {
  const open = pr.state === "OPEN";
  if (!me) return open ? "open" : "closed";
  const mine = isMe(pr.author, me);
  if (open && !mine) {
    const asked = (pr.reviewers || []).some((r) => isMe(r, me));
    const done = (pr.participants || []).some((p) => isMe(p.user, me) && (p.approved || p.state));
    return asked && !done ? "review" : null;
  }
  if (!mine) return null;
  return open ? "mine" : "closed";
}

/** One Bitbucket PR → the shape the app uses (see prs.js `normalize`). */
function normalize(pr, me) {
  const bucket = bucketFor(pr, me);
  if (!bucket) return null;
  const state = { OPEN: "OPEN", MERGED: "MERGED" }[pr.state] || "CLOSED";
  return {
    url: pr.links?.html?.href || "",
    number: pr.id,
    title: pr.title || "",
    repo: pr.destination?.repository?.full_name || "",
    author: pr.author?.display_name || "",
    draft: !!pr.draft,
    state,
    updatedAt: pr.updated_on,
    mergedAt: state === "MERGED" ? pr.updated_on : null,
    headRef: pr.source?.branch?.name || "",
    reviewDecision: state === "OPEN" ? decision(pr, me) : null,
    checks: null,
    comments: pr.comment_count || 0,
    additions: 0,
    deletions: 0,
    bucket,
    host: "bitbucket",
  };
}

/** Every open PR, plus the ones closed within RECENT_DAYS, of one repo. */
async function repoPrs(auth, repo) {
  const since = new Date(Date.now() - RECENT_DAYS * 864e5).toISOString().slice(0, 10);
  const q = encodeURIComponent(`state="OPEN" OR (state!="OPEN" AND updated_on>=${since})`);
  const states = "state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED";
  let url = `${API}/repositories/${repo}/pullrequests?${states}&q=${q}&sort=-updated_on&pagelen=50&fields=${encodeURIComponent(FIELDS)}`;
  const out = [];
  // Two pages at most: 100 PRs a repo is plenty for a two-week window.
  for (let page = 0; url && page < 2; page++) {
    const body = await get(auth, url);
    out.push(...(body.values || []));
    url = body.next;
  }
  return out;
}

/**
 * The PRs of every `{ account, token, repos }` source. Resolves to
 * `{ prs, errors, read }` — `read` counts the repos read cleanly; one source
 * failing never hides the others.
 */
async function listBitbucketPrs(sources) {
  const prs = [];
  const errors = [];
  let read = 0;
  for (const s of sources) {
    if (!s.token || !s.repos || !s.repos.length) continue;
    const auth = `Basic ${Buffer.from(`${s.account}:${s.token}`).toString("base64")}`;
    try {
      const me = (await whoami(auth)) || (await jiraMe(s.jira));
      for (const repo of s.repos) {
        try {
          for (const pr of await repoPrs(auth, repo)) {
            const p = normalize(pr, me);
            if (p && p.url) prs.push(p);
          }
          read++;
        } catch (e) {
          errors.push(`Bitbucket ${repo}: ${e.message}`);
        }
      }
    } catch (e) {
      errors.push(`Bitbucket ${s.label || s.id}: ${e.message}`);
    }
  }
  return { prs, errors, read };
}

module.exports = { listBitbucketPrs, normalize, bucketFor, isMe };
