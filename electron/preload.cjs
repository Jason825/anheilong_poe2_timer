const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("poe2Timer", {
  loadData: () => ipcRenderer.invoke("数据:读取"),
  saveData: (data) => ipcRenderer.invoke("数据:保存", data),
  updateShortcuts: (hotkeys) => ipcRenderer.invoke("快捷键:更新", hotkeys),
  setClickThrough: (enabled) => ipcRenderer.invoke("窗口:设置点击穿透", enabled),
  setLocked: (enabled) => ipcRenderer.invoke("锁定:设置", enabled),
  closeApp: () => ipcRenderer.invoke("窗口:关闭"),
  minimizeApp: () => ipcRenderer.invoke("窗口:最小化"),
  openSettings: () => ipcRenderer.invoke("设置:打开"),
  closeSettings: () => ipcRenderer.invoke("设置:关闭"),
  resizeWindow: (size) => ipcRenderer.invoke("窗口:调整尺寸", size),
  onDataChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("数据变化", handler);
    return () => ipcRenderer.removeListener("数据变化", handler);
  },
  onShortcut: (callback) => {
    const handler = (_event, action) => callback(action);
    ipcRenderer.on("快捷键", handler);
    return () => ipcRenderer.removeListener("快捷键", handler);
  },
  onClickThroughChange: (callback) => {
    const handler = (_event, enabled) => callback(enabled);
    ipcRenderer.on("点击穿透变化", handler);
    return () => ipcRenderer.removeListener("点击穿透变化", handler);
  }
});
