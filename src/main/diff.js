// Pure change detection: given what we knew and what just arrived, say what
// happened worth telling the user about. No Electron, no I/O — the notifier
// decides whether an event becomes a desktop notification, this only decides
// that it *is* an event. Kept pure so it can be unit-tested under plain node.

const WORKFLOW_TEXT = {
  queued: { title: "queued", level: "info" },
  running: { title: "started", level: "info" },
  needs_input: { title: "needs your input", level: "warn" },
  blocked: { title: "is blocked", level: "warn" },
  paused: { title: "paused", level: "info" },
  ready: { title: "is ready", level: "success" },
  failed: { title: "failed", level: "error" },
  cancelled: { title: "was cancelled", level: "info" },
  interrupted: { title: "was interrupted", level: "error" },
};

const DELIVERY_TEXT = {
  open: { title: "PR opened", level: "info" },
  changes_requested: { title: "PR changes requested", level: "warn" },
  merged: { title: "PR merged", level: "success" },
  declined: { title: "PR declined", level: "error" },
};

const EVIDENCE_TEXT = {
  passed: "success",
  failed: "error",
  stale: "warn",
};

/** Stable map key for a ticket id `{connection, native}`. */
function ticketKey(id) {
  return id ? `${id.connection}\u0000${id.native}` : "";
}

function label(t) {
  return t.key || (t.id && t.id.native) || "ticket";
}

function event(fields) {
  return {
    ts: Date.now(),
    level: "info",
    body: "",
    ...fields,
  };
}

/**
 * What changed on one ticket between `prev` (may be undefined: newly seen)
 * and `next`.
 */
function diffTicket(prev, next) {
  const out = [];
  const name = label(next);
  const target = { view: "tickets", id: ticketKey(next.id) };
  const base = { category: "tickets", target, url: next.url || null };

  if (!prev) {
    out.push(
      event({
        ...base,
        kind: "ticket-new",
        title: `${name} assigned`,
        body: next.summary || "",
      }),
    );
    return out;
  }

  if (next.workflow && next.workflow !== prev.workflow) {
    const w = WORKFLOW_TEXT[next.workflow] || { title: next.workflow, level: "info" };
    let body = next.summary || "";
    if (next.workflow === "ready" && next.change_summary) body = next.change_summary;
    out.push(
      event({ ...base, kind: `workflow-${next.workflow}`, level: w.level, title: `${name} ${w.title}`, body }),
    );
  } else if (next.workflow === "running" && next.stage && next.stage !== prev.stage) {
    out.push(
      event({ ...base, kind: "stage", title: `${name} → ${next.stage}`, body: next.summary || "" }),
    );
  }

  if (next.delivery && next.delivery !== prev.delivery && DELIVERY_TEXT[next.delivery]) {
    const d = DELIVERY_TEXT[next.delivery];
    out.push(event({ ...base, kind: `delivery-${next.delivery}`, level: d.level, title: `${name}: ${d.title}`, body: next.summary || "" }));
  }

  if (next.status_name && prev.status_name && next.status_name !== prev.status_name) {
    out.push(
      event({
        ...base,
        kind: "status",
        title: `${name} moved to ${next.status_name}`,
        body: `was ${prev.status_name}`,
      }),
    );
  }

  const prevEv = new Map((prev.evidence || []).map((b) => [b.kind, b.state]));
  for (const b of next.evidence || []) {
    const level = EVIDENCE_TEXT[b.state];
    if (!level || prevEv.get(b.kind) === b.state) continue;
    out.push(
      event({
        ...base,
        kind: `evidence-${b.kind}-${b.state}`,
        level,
        title: `${name}: ${b.kind} ${b.state}`,
        body: b.label || "",
      }),
    );
  }

  if (next.blocked_reason && next.blocked_reason !== prev.blocked_reason) {
    out.push(event({ ...base, kind: "blocked", level: "warn", title: `${name} blocked`, body: next.blocked_reason }));
  }

  if ((next.unread_pr_activity || 0) > (prev.unread_pr_activity || 0)) {
    out.push(event({ ...base, kind: "pr-activity", title: `${name}: new PR activity`, body: `${next.unread_pr_activity} unread` }));
  }

  return out;
}

/**
 * A whole snapshot against the last known map — used on reconnect, so what
 * happened while we were away still reaches the user. Removed tickets are
 * reported too.
 */
function diffSnapshot(prevMap, nextList) {
  const out = [];
  const seen = new Set();
  for (const t of nextList) {
    const k = ticketKey(t.id);
    seen.add(k);
    out.push(...diffTicket(prevMap.get(k), t));
  }
  for (const [k, t] of prevMap) {
    if (!seen.has(k)) out.push(removedEvent(t, "no longer on the board"));
  }
  return out;
}

function removedEvent(t, reason) {
  return event({
    category: "tickets",
    kind: "ticket-removed",
    title: `${label(t)} left the board`,
    body: reason || "",
    target: { view: "tickets" },
    url: t.url || null,
  });
}

/** A connection's health turning bad (or recovering). */
function diffConnection(prev, next) {
  if (!prev || prev.health === next.health) return [];
  if (next.health === "error") {
    return [
      event({
        category: "connections",
        kind: "connection-error",
        level: "error",
        title: `${next.label || next.id} connection error`,
        body: next.detail || "",
        target: { view: "overview" },
      }),
    ];
  }
  if (prev.health === "error") {
    return [
      event({
        category: "connections",
        kind: "connection-ok",
        level: "success",
        title: `${next.label || next.id} reconnected`,
        target: { view: "overview" },
      }),
    ];
  }
  return [];
}

const CHECKS_TEXT = {
  SUCCESS: { title: "checks passed", level: "success" },
  FAILURE: { title: "checks failed", level: "error" },
  ERROR: { title: "checks errored", level: "error" },
};

const REVIEW_TEXT = {
  APPROVED: { title: "approved", level: "success" },
  CHANGES_REQUESTED: { title: "changes requested", level: "warn" },
};

function prName(p) {
  return `${p.repo}#${p.number}`;
}

/**
 * What changed across the pull-request lists. `prevMap` is keyed by PR url.
 * A PR that drops out of every list is not reported — it simply left the
 * query window; its merge/close was reported when the state flipped.
 */
function diffPrs(prevMap, nextList) {
  const out = [];
  for (const p of nextList) {
    const prev = prevMap.get(p.url);
    const base = { category: "prs", target: { view: "prs", id: p.url }, url: p.url };
    const name = prName(p);
    if (!prev) {
      if (p.bucket === "review") {
        out.push(event({ ...base, kind: "pr-review-requested", level: "warn", title: `Review requested: ${name}`, body: p.title }));
      } else if (p.state === "OPEN") {
        out.push(event({ ...base, kind: "pr-new", title: `PR opened: ${name}`, body: p.title }));
      }
      continue;
    }
    if (p.state !== prev.state) {
      const merged = p.state === "MERGED";
      out.push(
        event({
          ...base,
          kind: `pr-${p.state.toLowerCase()}`,
          level: merged ? "success" : "info",
          title: `${name} ${merged ? "merged" : p.state === "CLOSED" ? "closed" : "reopened"}`,
          body: p.title,
        }),
      );
    }
    if (p.bucket === "review" && prev.bucket !== "review") {
      out.push(event({ ...base, kind: "pr-review-requested", level: "warn", title: `Review requested: ${name}`, body: p.title }));
    }
    if (p.reviewDecision && p.reviewDecision !== prev.reviewDecision && REVIEW_TEXT[p.reviewDecision]) {
      const r = REVIEW_TEXT[p.reviewDecision];
      out.push(event({ ...base, kind: `pr-review-${p.reviewDecision.toLowerCase()}`, level: r.level, title: `${name} ${r.title}`, body: p.title }));
    }
    if (p.checks && p.checks !== prev.checks && CHECKS_TEXT[p.checks]) {
      const c = CHECKS_TEXT[p.checks];
      out.push(event({ ...base, kind: `pr-checks-${p.checks.toLowerCase()}`, level: c.level, title: `${name} ${c.title}`, body: p.title }));
    }
    if (p.comments > prev.comments) {
      const n = p.comments - prev.comments;
      out.push(event({ ...base, kind: "pr-comments", title: `${name}: ${n} new comment${n === 1 ? "" : "s"}`, body: p.title }));
    }
    if (prev.draft && !p.draft && p.state === "OPEN") {
      out.push(event({ ...base, kind: "pr-ready", title: `${name} ready for review`, body: p.title }));
    }
  }
  return out;
}

module.exports = {
  ticketKey,
  diffTicket,
  diffSnapshot,
  removedEvent,
  diffConnection,
  diffPrs,
};
