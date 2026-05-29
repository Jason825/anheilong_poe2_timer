const { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, Tray } = require("electron");
const fs = require("fs/promises");
const path = require("path");

const DEFAULT_TEMPLATE_ID = "campaign-default-v1";
const DEFAULT_NODES = ["第一章", "第二章", "第三章", "第四章", "间章", "异界"];
const DEFAULT_HOTKEYS = {
  startPause: "F8",
  split: "F9",
  undo: "F10",
  toggleView: "F11",
  toggleClickThrough: ""
};
const HOTKEY_ACTIONS = {
  startPause: "开始暂停继续",
  split: "记录节点",
  undo: "重置当前关卡",
  toggleView: "切换展开"
};
const HOTKEY_FIELDS = Object.keys(HOTKEY_ACTIONS);
const MAIN_WINDOW_DEFAULT_WIDTH = 368;
const MAIN_WINDOW_DEFAULT_HEIGHT = 164;
const MAIN_WINDOW_MIN_WIDTH = 300;
const MAIN_WINDOW_MIN_HEIGHT = 112;
const APP_USER_MODEL_ID = "com.anheilong.poe2timer";

let mainWindow = null;
let settingsWindow = null;
let lockWindow = null;
let tray = null;
let clickThrough = false;
let isQuitting = false;
let registeredHotkeys = DEFAULT_HOTKEYS;

function createDefaultData() {
  const now = new Date().toISOString();
  return {
    version: 4,
    settings: {
      scale: 1,
      opacity: 1,
      clickThrough: false,
      currentTemplateId: DEFAULT_TEMPLATE_ID,
      hotkeys: DEFAULT_HOTKEYS
    },
    templates: [
      {
        id: DEFAULT_TEMPLATE_ID,
        name: "POE2 默认剧情",
        version: 1,
        templateKey: DEFAULT_NODES.join("|"),
        nodes: DEFAULT_NODES.map((name, index) => ({
          id: `default-${index + 1}`,
          name
        })),
        createdAt: now,
        updatedAt: now
      }
    ],
    runs: [],
    activeRun: null
  };
}

function normalizeHotkeys(hotkeys) {
  return {
    ...DEFAULT_HOTKEYS,
    ...(hotkeys || {}),
    toggleClickThrough: ""
  };
}

function normalizeAccelerator(accelerator) {
  const parts = String(accelerator || "")
    .trim()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return "";

  const modifiers = new Set();
  const keys = [];
  const keyNames = {
    arrowup: "Up",
    arrowdown: "Down",
    arrowleft: "Left",
    arrowright: "Right",
    esc: "Escape",
    escape: "Escape",
    pageup: "PageUp",
    pagedown: "PageDown",
    space: "Space",
    return: "Enter",
    enter: "Enter",
    delete: "Delete",
    backspace: "Backspace",
    home: "Home",
    end: "End",
    insert: "Insert",
    tab: "Tab"
  };

  for (const part of parts) {
    const lower = part.toLocaleLowerCase();
    if (["commandorcontrol", "control", "ctrl", "cmd", "command", "meta"].includes(lower)) {
      modifiers.add("CommandOrControl");
    } else if (["alt", "option"].includes(lower)) {
      modifiers.add("Alt");
    } else if (lower === "shift") {
      modifiers.add("Shift");
    } else {
      const upper = part.toUpperCase();
      keys.push(/^F([1-9]|1\d|2[0-4])$/.test(upper) ? upper : keyNames[lower] ?? (part.length === 1 ? upper : part));
    }
  }

  if (keys.length !== 1) return "";
  return [...["CommandOrControl", "Alt", "Shift"].filter((modifier) => modifiers.has(modifier)), keys[0]].join("+");
}

function canonicalAccelerator(accelerator) {
  return normalizeAccelerator(accelerator).toLocaleLowerCase();
}

function getShortcutEntries(hotkeys) {
  const normalized = normalizeHotkeys(hotkeys);
  return HOTKEY_FIELDS.map((key) => ({
    key,
    action: HOTKEY_ACTIONS[key],
    accelerator: normalizeAccelerator(normalized[key])
  }));
}

function findDuplicateAccelerators(entries) {
  const used = new Map();
  const duplicates = [];
  entries.forEach((entry) => {
    const canonical = canonicalAccelerator(entry.accelerator);
    if (used.has(canonical)) duplicates.push(entry.accelerator);
    else used.set(canonical, entry);
  });
  return [...new Set(duplicates)];
}

function findInvalidAccelerators(entries) {
  return entries.filter((entry) => !entry.accelerator).map((entry) => entry.action);
}

function getDataPath() {
  return path.join(app.getPath("userData"), "poe2-timer-data.json");
}

async function loadData() {
  try {
    const raw = await fs.readFile(getDataPath(), "utf8");
    return JSON.parse(raw);
  } catch {
    return createDefaultData();
  }
}

async function saveData(data) {
  await fs.mkdir(path.dirname(getDataPath()), { recursive: true });
  await fs.writeFile(getDataPath(), JSON.stringify(data, null, 2), "utf8");
  BrowserWindow.getAllWindows().forEach((window) => {
    if (!window.isDestroyed()) window.webContents.send("数据变化", data);
  });
  return { ok: true };
}

function sendShortcut(action) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("快捷键", action);
}

function getRuntimeIconPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, "icon.ico");
  return path.join(__dirname, "..", "build", "icon.ico");
}

function getAppIcon() {
  const icon = nativeImage.createFromPath(getRuntimeIconPath());
  if (!icon.isEmpty()) return icon;
  return nativeImage.createFromPath(path.join(__dirname, "..", "public", "brand", "dark-dragon-logo.png"));
}

function positionLockWindow() {
  if (!mainWindow || mainWindow.isDestroyed() || !lockWindow || lockWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  lockWindow.setBounds({
    x: bounds.x + bounds.width - 175,
    y: bounds.y + 6,
    width: 32,
    height: 32
  });
}

function showLockWindow() {
  if (!lockWindow || lockWindow.isDestroyed()) return;
  positionLockWindow();
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    lockWindow.showInactive();
  }
}

function hideLockWindow() {
  if (!lockWindow || lockWindow.isDestroyed()) return;
  lockWindow.hide();
}

function setClickThrough(enabled) {
  clickThrough = enabled;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setIgnoreMouseEvents(enabled, { forward: true });
  if (typeof mainWindow.setMovable === "function") {
    mainWindow.setMovable(!enabled);
  }
  if (enabled) showLockWindow();
  else hideLockWindow();
  mainWindow.webContents.send("点击穿透变化", enabled);
  rebuildTrayMenu();
}

function createTrayIcon() {
  return getAppIcon().resize({ width: 16, height: 16 });
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: mainWindow && mainWindow.isVisible() ? "隐藏计时器" : "显示计时器",
      click: () => {
        if (!mainWindow) return;
        if (mainWindow.isVisible()) mainWindow.hide();
        else mainWindow.show();
        rebuildTrayMenu();
      }
    },
    { label: "展开 / 收起", click: () => sendShortcut("切换展开") },
    {
      label: clickThrough ? "解锁面板" : "锁定面板",
      click: () => setClickThrough(!clickThrough)
    },
    { type: "separator" },
    { label: "退出", click: () => app.quit() }
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("暗黑龙剧情计时器");
  tray.on("click", () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) mainWindow.focus();
    else mainWindow.show();
  });
  rebuildTrayMenu();
}

function createLockWindow() {
  lockWindow = new BrowserWindow({
    width: 32,
    height: 32,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, "lock-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  lockWindow.setAlwaysOnTop(true, "screen-saver");
  lockWindow.setMenuBarVisibility(false);
  lockWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`
      <!doctype html>
      <html lang="zh-CN">
        <head>
          <meta charset="UTF-8" />
          <style>
            html, body {
              width: 100%;
              height: 100%;
              margin: 0;
              overflow: hidden;
              background: transparent;
            }
            button {
              display: grid;
              width: 32px;
              height: 32px;
              place-items: center;
              border: 1px solid rgba(105, 230, 255, 0.54);
              border-radius: 9px;
              color: #071017;
              background: rgba(105, 230, 255, 0.94);
              cursor: pointer;
            }
            button:hover {
              background: #9df3ff;
            }
            svg {
              width: 17px;
              height: 17px;
              stroke: currentColor;
              stroke-width: 2.4;
              fill: none;
              stroke-linecap: round;
              stroke-linejoin: round;
            }
          </style>
        </head>
        <body>
          <button title="解锁" aria-label="解锁">
            <svg viewBox="0 0 24 24">
              <rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
            </svg>
          </button>
          <script>
            document.querySelector("button").addEventListener("click", () => window.poe2Lock.unlock());
          </script>
        </body>
      </html>
    `)}`
  );
}

function loadRenderer(window, kind) {
  if (process.env.VITE_DEV_SERVER_URL) {
    const url = new URL(process.env.VITE_DEV_SERVER_URL);
    url.searchParams.set("window", kind);
    window.loadURL(url.toString());
  } else {
    window.loadFile(path.join(__dirname, "..", "dist", "index.html"), {
      query: { window: kind }
    });
  }
}

function showWindowWhenReady(window, shouldShow = () => true) {
  let shown = false;
  const show = () => {
    if (shown || window.isDestroyed() || !shouldShow()) return;
    shown = true;
    window.show();
  };

  window.once("ready-to-show", show);
  window.webContents.once("did-finish-load", show);
  window.webContents.once("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`页面加载失败：${errorCode} ${errorDescription} ${validatedURL}`);
    show();
  });
  window.webContents.once("render-process-gone", (_event, details) => {
    console.error(`渲染进程退出：${details.reason}`);
    show();
  });
  setTimeout(show, 1500);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: MAIN_WINDOW_DEFAULT_WIDTH,
    height: MAIN_WINDOW_DEFAULT_HEIGHT,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: true,
    skipTaskbar: false,
    alwaysOnTop: true,
    icon: getRuntimeIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.setAlwaysOnTop(true, "screen-saver");
  mainWindow.setMenuBarVisibility(false);
  setClickThrough(false);

  const timerWindow = mainWindow;
  showWindowWhenReady(timerWindow, () => mainWindow === timerWindow);

  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
    rebuildTrayMenu();
  });

  mainWindow.on("move", positionLockWindow);
  mainWindow.on("resize", positionLockWindow);
  mainWindow.on("show", () => {
    if (clickThrough) showLockWindow();
  });
  mainWindow.on("hide", hideLockWindow);
  mainWindow.on("minimize", hideLockWindow);
  mainWindow.on("restore", () => {
    if (clickThrough) showLockWindow();
  });

  loadRenderer(mainWindow, "timer");
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return { ok: true };
  }

  const mainBounds =
    mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.getBounds()
      : { x: 120, y: 120, width: MAIN_WINDOW_DEFAULT_WIDTH, height: MAIN_WINDOW_DEFAULT_HEIGHT };
  settingsWindow = new BrowserWindow({
    width: 500,
    height: 560,
    minWidth: 500,
    minHeight: 560,
    x: mainBounds.x,
    y: mainBounds.y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: true,
    skipTaskbar: false,
    alwaysOnTop: true,
    icon: getRuntimeIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  settingsWindow.setAlwaysOnTop(true, "screen-saver");
  settingsWindow.setMenuBarVisibility(false);
  const currentSettingsWindow = settingsWindow;
  showWindowWhenReady(currentSettingsWindow, () => settingsWindow === currentSettingsWindow);
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
  loadRenderer(settingsWindow, "settings");
  return { ok: true };
}

function closeSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
  return { ok: true };
}

function registerShortcuts(hotkeys = DEFAULT_HOTKEYS) {
  const normalized = normalizeHotkeys(hotkeys);
  const entries = getShortcutEntries(normalized);
  const invalid = findInvalidAccelerators(entries);
  if (invalid.length) return { ok: false, failures: invalid };
  const duplicates = findDuplicateAccelerators(entries);
  if (duplicates.length) return { ok: false, failures: duplicates };

  const failures = [];

  globalShortcut.unregisterAll();
  for (const { accelerator, action } of entries) {
    try {
      const ok = globalShortcut.register(accelerator, () => {
        sendShortcut(action);
      });
      if (!ok) failures.push(accelerator);
    } catch {
      failures.push(accelerator);
    }
  }

  if (failures.length) {
    console.warn(`快捷键注册失败：${failures.join(", ")}`);
    globalShortcut.unregisterAll();
    for (const { accelerator, action } of getShortcutEntries(registeredHotkeys)) {
      try {
        globalShortcut.register(accelerator, () => {
          sendShortcut(action);
        });
      } catch {
        // 保持静默：恢复失败时不覆盖 registeredHotkeys，下一次应用仍以旧设置为准。
      }
    }
    return { ok: false, failures };
  }

  registeredHotkeys = normalized;
  return { ok: true, failures: [] };
}

app.whenReady().then(async () => {
  if (process.platform === "win32") app.setAppUserModelId(APP_USER_MODEL_ID);
  const initialData = await loadData();
  ipcMain.handle("数据:读取", loadData);
  ipcMain.handle("数据:保存", (_event, data) => saveData(data));
  ipcMain.handle("快捷键:更新", (_event, hotkeys) => registerShortcuts(hotkeys));
  ipcMain.handle("窗口:设置点击穿透", (_event, enabled) => {
    setClickThrough(Boolean(enabled));
    return { ok: true };
  });
  ipcMain.handle("锁定:设置", (_event, enabled) => {
    setClickThrough(Boolean(enabled));
    return { ok: true };
  });
  ipcMain.handle("窗口:关闭", () => {
    isQuitting = true;
    app.quit();
    return { ok: true };
  });
  ipcMain.handle("窗口:最小化", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    hideLockWindow();
    mainWindow.minimize();
    return { ok: true };
  });
  ipcMain.handle("设置:打开", openSettingsWindow);
  ipcMain.handle("设置:关闭", closeSettingsWindow);
  ipcMain.handle("窗口:调整尺寸", (_event, size) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    const requestedWidth = Number(size && size.width);
    const requestedHeight = Number(size && size.height);
    if (!Number.isFinite(requestedWidth) || !Number.isFinite(requestedHeight)) return { ok: false };
    const width = Math.max(150, Math.round(requestedWidth));
    const height = Math.max(60, Math.round(requestedHeight));
    mainWindow.setContentSize(width, height);
    positionLockWindow();
    return { ok: true };
  });
  createWindow();
  createLockWindow();
  createTray();
  const shortcutResult = registerShortcuts(initialData.settings && initialData.settings.hotkeys);
  if (!shortcutResult.ok) registerShortcuts(DEFAULT_HOTKEYS);
});

app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  isQuitting = true;
  hideLockWindow();
  globalShortcut.unregisterAll();
});
