// The only surface the page gets: named calls and subscriptions, no Node.

const { contextBridge, ipcRenderer } = require("electron");

function on(channel) {
  return (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

contextBridge.exposeInMainWorld("nebula", {
  getState: () => ipcRenderer.invoke("state:get"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  markActivityRead: () => ipcRenderer.invoke("activity:markRead"),
  clearActivity: () => ipcRenderer.invoke("activity:clear"),
  openExternal: (url) => ipcRenderer.invoke("open:external", url),
  requestChanges: (ticketId) => ipcRenderer.invoke("changes:request", ticketId),
  refreshPrs: () => ipcRenderer.invoke("prs:refresh"),
  reconnect: () => ipcRenderer.invoke("bridge:reconnect"),
  testNotification: () => ipcRenderer.invoke("notify:test"),

  onBoard: on("board"),
  onBridgeStatus: on("bridge:status"),
  onPrs: on("prs"),
  onActivity: on("activity:new"),
  onUnread: on("activity:unread"),
  onSettings: on("settings"),
  onChanges: on("changes:result"),
  onNav: on("nav"),
  onFocus: on("window:focus"),

  terminal: {
    start: (cols, rows) => ipcRenderer.invoke("term:start", { cols, rows }),
    write: (data) => ipcRenderer.send("term:write", data),
    resize: (cols, rows) => ipcRenderer.send("term:resize", { cols, rows }),
    kill: () => ipcRenderer.invoke("term:kill"),
    openExternal: () => ipcRenderer.invoke("term:external"),
    onData: on("term:data"),
    onExit: on("term:exit"),
  },
});
