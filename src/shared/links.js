// Ticket ↔ pull request links — shared by the main process (to put the
// ticket on a PR's notification) and the renderer (chips both ways). A PR is
// linked to a ticket when the ticket's key appears in its title or branch, or
// when the provider that listed it said so (`pr.tickets`, which an agent
// provider fills from the tracker's own dev links). Plain JS with no imports
// so the renderer can load it as a classic script too.

(function (root) {
  const KEY = /[A-Z][A-Z0-9]+-\d+/g;

  const tkey = (id) => (id ? `${id.connection}\u0000${id.native}` : "");

  /** The ticket keys a PR names, upper-cased and de-duplicated. */
  function keysOf(pr) {
    const named = `${pr.title || ""} ${pr.headRef || ""}`.toUpperCase().match(KEY) || [];
    const told = (pr.tickets || []).map((k) => String(k).trim().toUpperCase());
    return [...new Set([...named, ...told].filter(Boolean))];
  }

  /** `{ prsByTicket, ticketsByPr }` — keyed by ticket map key and PR url. */
  function linkPrs(tickets, prs) {
    const byKey = new Map();
    for (const t of tickets || []) if (t.key && !t.removed_reason) byKey.set(t.key.toUpperCase(), t);
    const prsByTicket = new Map();
    const ticketsByPr = new Map();
    for (const pr of prs || []) {
      const hits = keysOf(pr).map((k) => byKey.get(k)).filter(Boolean);
      if (!hits.length) continue;
      ticketsByPr.set(pr.url, hits);
      for (const t of hits) {
        const k = tkey(t.id);
        if (!prsByTicket.has(k)) prsByTicket.set(k, []);
        prsByTicket.get(k).push(pr);
      }
    }
    return { prsByTicket, ticketsByPr };
  }

  const api = { linkPrs, keysOf, tkey };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NebulaLinks = api;
})(typeof window !== "undefined" ? window : globalThis);
