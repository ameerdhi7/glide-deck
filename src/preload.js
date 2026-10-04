// The only surface the page gets: named calls and subscriptions, no Node.

const { contextBridge, ipcRenderer } = require("electron");

function on(channel) {
  return (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

/** One PTY's calls, on channels `<prefix>:start`, `<prefix>:data`, … */
function pty(prefix) {
  return {
    start: (cols, rows) => ipcRenderer.invoke(`${prefix}:start`, { cols, rows }),
    detach: () => ipcRenderer.send(`${prefix}:detach`),
    write: (data) => ipcRenderer.send(`${prefix}:write`, data),
    resize: (cols, rows) => ipcRenderer.send(`${prefix}:resize`, { cols, rows }),
    kill: () => ipcRenderer.invoke(`${prefix}:kill`),
    onData: on(`${prefix}:data`),
    onExit: on(`${prefix}:exit`),
  };
}

contextBridge.exposeInMainWorld("nebula", {
  getState: () => ipcRenderer.invoke("state:get"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  markActivityRead: () => ipcRenderer.invoke("activity:markRead"),
  clearActivity: () => ipcRenderer.invoke("activity:clear"),
  saveNote: (note) => ipcRenderer.invoke("notes:save", note),
  deleteNote: (id) => ipcRenderer.invoke("notes:delete", id),
  openExternal: (url) => ipcRenderer.invoke("open:external", url),
  requestChanges: (ticketId) => ipcRenderer.invoke("changes:request", ticketId),
  prDiff: (url) => ipcRenderer.invoke("changes:pr", url),
  deleteWorktrees: (ids, force) => ipcRenderer.invoke("worktrees:delete", { ids, force }),
  rotateWorktrees: () => ipcRenderer.invoke("rotate:run"),
  addProjects: () => ipcRenderer.invoke("projects:add"),
  removeProject: (id) => ipcRenderer.invoke("projects:remove", id),
  refreshPrs: () => ipcRenderer.invoke("prs:refresh"),
  resyncTickets: () => ipcRenderer.invoke("tickets:resync"),
  startTicket: (opts) => ipcRenderer.invoke("tickets:start", opts),
  reconnect: () => ipcRenderer.invoke("bridge:reconnect"),
  testNotification: () => ipcRenderer.invoke("notify:test"),
  listSounds: () => ipcRenderer.invoke("sound:list"),
  playSound: (name) => ipcRenderer.invoke("sound:play", name),
  listConnections: () => ipcRenderer.invoke("connections:list"),
  saveConnection: (connection, token, clearToken) => ipcRenderer.invoke("connections:save", { connection, token, clearToken }),
  removeConnection: (id) => ipcRenderer.invoke("connections:remove", id),
  testConnection: (connection, token) => ipcRenderer.invoke("connections:test", { connection, token }),
  githubStatus: () => ipcRenderer.invoke("github:status"),
  githubLogin: () => ipcRenderer.invoke("github:login"),

  onBoard: on("board"),
  onBridgeStatus: on("bridge:status"),
  onPrs: on("prs"),
  onActivity: on("activity:new"),
  onUnread: on("activity:unread"),
  onSettings: on("settings"),
  onChanges: on("changes:result"),
  onWorktrees: on("worktrees"),
  onWorktreeProgress: on("worktrees:progress"),
  onRotateStatus: on("rotate:status"),
  onNav: on("nav"),
  onFocus: on("window:focus"),

  terminal: pty("term"),
  shell: pty("shell"),
});
