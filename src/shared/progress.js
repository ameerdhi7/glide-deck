// Where a ticket sits on its road from assigned to merged, as one ordered
// step list — shared by the main process (for the dock badge) and the
// renderer (for the stepper and the overview bar). Plain JS with no imports
// so the renderer can load it as a classic script too.

(function (root) {
  const STEPS = ["To do", "Queued", "Implementing", "Ready", "Reviewed", "PR open", "Done"];

  /**
   * `{ step, tone, label }` for a ticket: `step` indexes STEPS (the last one
   * reached), `tone` is ok | warn | err | active | idle, and `label` is the
   * short state word for the card.
   */
  function progressOf(t) {
    const w = t.workflow;
    const review = (t.evidence || []).find((b) => b.kind === "review");
    const reviewed = review && review.state === "passed";

    if (t.delivery === "merged" || (!w && t.status_category === "done")) {
      return { step: 6, tone: "ok", label: t.delivery === "merged" ? "merged" : "done" };
    }
    if (t.delivery === "open" || t.delivery === "changes_requested") {
      const cr = t.delivery === "changes_requested";
      return { step: 5, tone: cr ? "warn" : "active", label: cr ? "changes requested" : "PR open" };
    }
    if (t.delivery === "declined") return { step: 5, tone: "err", label: "PR declined" };
    switch (w) {
      case "queued":
        return { step: 1, tone: "active", label: "queued" };
      case "running":
        return { step: 2, tone: "active", label: t.stage || "running" };
      case "paused":
        return { step: 2, tone: "idle", label: "paused" };
      case "needs_input":
        return { step: 2, tone: "warn", label: "needs input" };
      case "blocked":
        return { step: 2, tone: "warn", label: "blocked" };
      case "failed":
        return { step: 2, tone: "err", label: "failed" };
      case "interrupted":
        return { step: 2, tone: "err", label: "interrupted" };
      case "cancelled":
        return { step: 1, tone: "idle", label: "cancelled" };
      case "ready":
        return reviewed
          ? { step: 4, tone: "ok", label: "reviewed" }
          : { step: 3, tone: "ok", label: "ready" };
    }
    if (t.blocked_reason) return { step: 0, tone: "warn", label: "blocked" };
    if (t.status_category === "in_progress") return { step: 0, tone: "idle", label: "in progress" };
    return { step: 0, tone: "idle", label: "to do" };
  }

  /** Whether a ticket is waiting on the human. */
  function needsYou(t) {
    return (
      (t.unread_pr_activity || 0) > 0 ||
      ["needs_input", "failed", "interrupted"].includes(t.workflow) ||
      t.delivery === "changes_requested"
    );
  }

  /** Counts for the overview's stacked bar, in display order. */
  function tally(tickets) {
    const buckets = { done: 0, pr: 0, ready: 0, active: 0, attention: 0, queued: 0, todo: 0 };
    for (const t of tickets) {
      if (t.removed_reason) continue;
      const p = progressOf(t);
      if (p.step === 6) buckets.done++;
      else if (needsYou(t) || p.tone === "err") buckets.attention++;
      else if (p.step === 5) buckets.pr++;
      else if (p.step >= 3) buckets.ready++;
      else if (p.step === 2) buckets.active++;
      else if (p.step === 1) buckets.queued++;
      else buckets.todo++;
    }
    const total = Object.values(buckets).reduce((a, b) => a + b, 0);
    return { buckets, total };
  }

  const api = { STEPS, progressOf, needsYou, tally };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NebulaProgress = api;
})(typeof window !== "undefined" ? window : globalThis);
