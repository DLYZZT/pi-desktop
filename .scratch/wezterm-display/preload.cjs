const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("spike", {
  sendRect: (rect) => ipcRenderer.send("term-rect", rect),
  onStatus: (cb) => {
    ipcRenderer.on("status", (_event, message) => cb(message));
    return () => ipcRenderer.removeAllListeners("status");
  },
});
