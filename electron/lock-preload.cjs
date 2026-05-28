const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("poe2Lock", {
  unlock: () => ipcRenderer.invoke("锁定:设置", false)
});
