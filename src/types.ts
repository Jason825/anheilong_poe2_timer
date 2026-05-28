export type TimerStatus = "未开始" | "计时中" | "已暂停" | "已完成";

export type ViewMode = "迷你" | "展开" | "列表2" | "历史";

export type ShortcutAction =
  | "开始暂停继续"
  | "记录节点"
  | "重置当前关卡"
  | "切换展开";

export interface SplitNode {
  id: string;
  name: string;
}

export interface SplitTemplate {
  id: string;
  name: string;
  version: number;
  templateKey: string;
  nodes: SplitNode[];
  createdAt: string;
  updatedAt: string;
}

export interface SplitResult {
  nodeId: string;
  name: string;
  index: number;
  durationMs: number;
  completedAt: string;
}

export interface ActiveRun {
  id: string;
  templateId: string;
  templateName: string;
  templateVersion: number;
  templateKey: string;
  nodes: SplitNode[];
  status: TimerStatus;
  startedAt: string;
  currentIndex: number;
  currentSegmentStartedAt: number | null;
  currentSegmentElapsedBeforePauseMs: number;
  splits: SplitResult[];
  savedAt?: string;
}

export interface RunRecord {
  id: string;
  templateId: string;
  templateName: string;
  templateVersion: number;
  templateKey: string;
  startedAt: string;
  finishedAt: string;
  completed: boolean;
  totalMs: number;
  splits: SplitResult[];
  note?: string;
}

export interface HotkeySettings {
  startPause: string;
  split: string;
  undo: string;
  toggleView: string;
  toggleClickThrough: string;
}

export interface AppSettings {
  scale: number;
  opacity: number;
  clickThrough: boolean;
  currentTemplateId: string;
  hotkeys: HotkeySettings;
}

export interface AppData {
  version: number;
  settings: AppSettings;
  templates: SplitTemplate[];
  runs: RunRecord[];
  activeRun: ActiveRun | null;
}

export interface ElectronBridge {
  loadData: () => Promise<AppData>;
  saveData: (data: AppData) => Promise<{ ok: boolean }>;
  updateShortcuts: (hotkeys: HotkeySettings) => Promise<{ ok: boolean; failures: string[] }>;
  setClickThrough: (enabled: boolean) => Promise<{ ok: boolean }>;
  setLocked: (enabled: boolean) => Promise<{ ok: boolean }>;
  closeApp: () => Promise<{ ok: boolean }>;
  minimizeApp: () => Promise<{ ok: boolean }>;
  openSettings: () => Promise<{ ok: boolean }>;
  closeSettings: () => Promise<{ ok: boolean }>;
  resizeWindow: (size: { width: number; height: number }) => Promise<{ ok: boolean }>;
  onDataChanged: (callback: (data: AppData) => void) => () => void;
  onShortcut: (callback: (action: ShortcutAction) => void) => () => void;
  onClickThroughChange: (callback: (enabled: boolean) => void) => () => void;
}

declare global {
  interface Window {
    poe2Timer: ElectronBridge;
  }
}
