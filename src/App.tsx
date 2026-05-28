import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  CirclePause,
  ClipboardList,
  Flag,
  Keyboard,
  LayoutTemplate,
  Lock,
  Maximize2,
  Minus,
  PanelLeft,
  Play,
  Plus,
  RotateCcw,
  Save,
  Settings,
  SlidersHorizontal,
  Trash2,
  TimerReset,
  Trophy,
  X
} from "lucide-react";
import type {
  ActiveRun,
  AppData,
  HotkeySettings,
  RunRecord,
  ShortcutAction,
  SplitNode,
  SplitResult,
  SplitTemplate,
  ViewMode
} from "./types";

const APP_NAME = "暗黑龙剧情计时器";
const DEFAULT_NODE_NAMES = ["第一章", "第二章", "第三章", "第四章", "间章", "异界"];
const DEFAULT_TEMPLATE_ID = "campaign-default-v1";
const MAX_TEMPLATE_NODES = 15;
const DEFAULT_HOTKEYS: HotkeySettings = {
  startPause: "F8",
  split: "F9",
  undo: "F10",
  toggleView: "F11",
  toggleClickThrough: ""
};
const HOTKEY_FIELDS = ["startPause", "split", "undo", "toggleView"] as const;
type HotkeyField = (typeof HOTKEY_FIELDS)[number];
const HOTKEY_LABELS: Record<HotkeyField, string> = {
  startPause: "开始 / 暂停 / 继续",
  split: "下一关",
  undo: "重置当前关卡",
  toggleView: "迷你 / 列表 / 列表2"
};
const RESERVED_HOTKEYS = new Set(
  [
    "Alt+F4",
    "Alt+Tab",
    "CommandOrControl+C",
    "CommandOrControl+V",
    "CommandOrControl+X",
    "CommandOrControl+A",
    "CommandOrControl+Z",
    "CommandOrControl+Y",
    "CommandOrControl+S",
    "CommandOrControl+F",
    "CommandOrControl+P",
    "CommandOrControl+N",
    "CommandOrControl+O",
    "CommandOrControl+W",
    "CommandOrControl+R",
    "CommandOrControl+Space",
    "CommandOrControl+Alt+Delete",
    "CommandOrControl+Shift+Escape"
  ].map(canonicalHotkey)
);

interface BestSegmentRecord {
  id: string;
  templateName: string;
  totalMs: number;
  splits: SplitResult[];
  completed: true;
  finishedAt: string;
}

interface SplitFeedback {
  id: string;
  statusText: string;
  timeText: string;
  good: boolean;
}

type SettingsTab = "关卡模板" | "历史记录" | "窗口" | "快捷键";
type ConfirmAction = "重置当前关卡" | "重置所有关卡" | "重置关卡模板" | "删除历史记录" | "删除关卡模板";

function IconButton({
  label,
  children,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button {...props} className={`icon-button ${className}`.trim()} title={label} aria-label={label} type={props.type ?? "button"}>
      {children}
    </button>
  );
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeTemplateKey(nodes: SplitNode[]) {
  return nodes.map((node) => node.name.trim()).filter(Boolean).join("|");
}

function createDefaultTemplate(): SplitTemplate {
  const now = new Date().toISOString();
  const nodes = DEFAULT_NODE_NAMES.map((name, index) => ({
    id: `default-${index + 1}`,
    name
  }));

  return {
    id: DEFAULT_TEMPLATE_ID,
    name: "默认剧情",
    version: 1,
    templateKey: makeTemplateKey(nodes),
    nodes,
    createdAt: now,
    updatedAt: now
  };
}

function createDefaultData(): AppData {
  const template = createDefaultTemplate();
  return {
    version: 4,
    settings: {
      scale: 1,
      opacity: 1,
      clickThrough: false,
      currentTemplateId: template.id,
      hotkeys: DEFAULT_HOTKEYS
    },
    templates: [template],
    runs: [],
    activeRun: null
  };
}

function normalizeData(input?: Partial<AppData>, options: { pauseRunning?: boolean; resetClickThrough?: boolean } = {}): AppData {
  const pauseRunning = options.pauseRunning ?? true;
  const resetClickThrough = options.resetClickThrough ?? true;
  const fallback = createDefaultData();
  const templates = input?.templates?.length ? input.templates : fallback.templates;
  const storedOpacity = input?.settings?.opacity;
  const migratedOpacity = input?.version && input.version < 4 && (storedOpacity === 0 || storedOpacity === 0.38) ? fallback.settings.opacity : storedOpacity;
  const hotkeys = {
    ...DEFAULT_HOTKEYS,
    ...(input?.settings?.hotkeys ?? {}),
    toggleClickThrough: ""
  };
  const currentTemplateId =
    input?.settings?.currentTemplateId && templates.some((template) => template.id === input.settings?.currentTemplateId)
      ? input.settings.currentTemplateId
      : templates[0].id;

  let activeRun = input?.activeRun ?? null;
  if (pauseRunning && activeRun?.status === "计时中") {
    activeRun = {
      ...activeRun,
      status: "已暂停",
      currentSegmentStartedAt: null,
      savedAt: new Date().toISOString()
    };
  }

  return {
    version: 4,
    settings: {
      scale: fallback.settings.scale,
      opacity: migratedOpacity ?? fallback.settings.opacity,
      clickThrough: resetClickThrough ? false : input?.settings?.clickThrough ?? fallback.settings.clickThrough,
      currentTemplateId,
      hotkeys
    },
    templates,
    runs: input?.runs ?? [],
    activeRun
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatDuration(ms: number, _forceHours = false) {
  const safeMs = Math.max(0, Math.floor(ms));
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDiff(ms: number) {
  const sign = ms <= 0 ? "-" : "+";
  return `${sign}${formatDuration(Math.abs(ms))}`;
}

function formatNaturalDuration(ms: number) {
  const totalSeconds = ms > 0 ? Math.max(1, Math.ceil(ms / 1000)) : 0;
  if (totalSeconds === 0) return "0秒";

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours}小时`);
  if (minutes) parts.push(`${minutes}分`);
  if (seconds || !parts.length) parts.push(`${seconds}秒`);
  return parts.join("");
}

function parseDurationInput(value: string) {
  const parts = value
    .trim()
    .split(":")
    .map((part) => part.trim());

  if (!parts.length || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null;

  const numbers = parts.map(Number);
  const seconds = numbers[numbers.length - 1];
  const minutes = numbers.length >= 2 ? numbers[numbers.length - 2] : 0;
  const hours = numbers.length === 3 ? numbers[0] : 0;

  if (seconds >= 60 || minutes >= 60 || hours > 24 || (hours === 24 && (minutes > 0 || seconds > 0))) return null;
  return ((hours * 3600 + minutes * 60 + seconds) * 1000);
}

function getDurationParts(value: string) {
  const [hours = "00", minutes = "00", seconds = "00"] = value.split(":");
  return [hours.padStart(2, "0"), minutes.padStart(2, "0"), seconds.padStart(2, "0")] as const;
}

function getEditableDurationParts(value: string) {
  const [hours = "00", minutes = "00", seconds = "00"] = value.split(":");
  return [hours, minutes, seconds] as const;
}

function updateDurationPart(value: string, partIndex: number, rawValue: string) {
  const nextParts = [...getEditableDurationParts(value)];
  const digits = rawValue.replace(/\D/g, "");
  if (!digits) {
    nextParts[partIndex] = "";
    return nextParts.join(":");
  }

  const hourValue = partIndex === 0 ? Number(digits) : Number(nextParts[0] || 0);
  const max = partIndex === 0 ? 24 : hourValue === 24 ? 0 : 59;
  const nextNumber = Math.min(max, Number(digits));
  nextParts[partIndex] = max === 0 ? "00" : digits.length === 1 && nextNumber < 10 ? String(nextNumber) : String(nextNumber).padStart(2, "0");
  if (partIndex === 0 && nextNumber === 24) {
    nextParts[1] = "00";
    nextParts[2] = "00";
  }
  return nextParts.join(":");
}

function getConfirmActionMessage(action: ConfirmAction) {
  if (action === "重置当前关卡") return "当前关卡时间会清零，已完成关卡不会改变。";
  if (action === "重置所有关卡") return "本次计时会全部清空，历史记录不会删除。";
  if (action === "删除历史记录") return "这条历史记录会被删除，历史最佳记录会自动重新计算。";
  if (action === "删除关卡模板") return "当前关卡模板会被删除，历史记录不会删除。";
  return "关卡模板会恢复为默认剧情，自定义模板和历史记录不会删除。";
}

function formatHotkeyFromEvent(event: React.KeyboardEvent<HTMLInputElement>) {
  const key = event.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(key)) return null;
  if ((key === "Backspace" || key === "Delete") && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) return "";

  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("CommandOrControl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");

  const keyMap: Record<string, string> = {
    " ": "Space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Escape",
    Enter: "Enter",
    Tab: "Tab",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Home: "Home",
    End: "End",
    Insert: "Insert"
  };
  const mainKey = keyMap[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  parts.push(mainKey);
  return parts.join("+");
}

function normalizeHotkey(value: string) {
  const parts = value
    .trim()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return null;

  const modifiers = new Set<string>();
  const keys: string[] = [];
  parts.forEach((part) => {
    const lower = part.toLocaleLowerCase();
    if (["commandorcontrol", "control", "ctrl", "cmd", "command", "meta"].includes(lower)) modifiers.add("CommandOrControl");
    else if (["alt", "option"].includes(lower)) modifiers.add("Alt");
    else if (lower === "shift") modifiers.add("Shift");
    else {
      keys.push(part.length === 1 ? part.toUpperCase() : part);
    }
  });

  if (keys.length !== 1) return null;

  const key = keys[0];
  const ordered = ["CommandOrControl", "Alt", "Shift"].filter((modifier) => modifiers.has(modifier));
  ordered.push(key);
  return {
    canonical: ordered.join("+").toLocaleLowerCase(),
    display: ordered.join("+"),
    key,
    modifiers
  };
}

function canonicalHotkey(value: string) {
  return normalizeHotkey(value)?.canonical ?? value.trim().toLocaleLowerCase();
}

function isFunctionHotkeyKey(key: string) {
  return /^F([1-9]|1\d|2[0-4])$/i.test(key);
}

function isRiskyUnmodifiedKey(key: string) {
  return /^[A-Z0-9]$/.test(key) || ["Space", "Enter", "Tab", "Escape", "Up", "Down", "Left", "Right", "PageUp", "PageDown", "Home", "End", "Insert"].includes(key);
}

function validateSingleHotkey(field: HotkeyField, value: string) {
  const normalized = normalizeHotkey(value);
  if (!value.trim()) {
    return { ok: false as const, message: `${HOTKEY_LABELS[field]} 的快捷键不能为空。` };
  }
  if (!normalized) {
    return { ok: false as const, message: `${HOTKEY_LABELS[field]} 的快捷键格式无效。` };
  }

  const hasCommandOrAlt = normalized.modifiers.has("CommandOrControl") || normalized.modifiers.has("Alt");
  if (!normalized.modifiers.size && !isFunctionHotkeyKey(normalized.key)) {
    return { ok: false as const, message: `${HOTKEY_LABELS[field]} 不能使用单独的普通按键，请使用 F 键或 Ctrl/Alt 组合。` };
  }
  if (normalized.modifiers.size === 1 && normalized.modifiers.has("Shift") && !isFunctionHotkeyKey(normalized.key)) {
    return { ok: false as const, message: `${HOTKEY_LABELS[field]} 不能只用 Shift 组合普通按键。` };
  }
  if (!isFunctionHotkeyKey(normalized.key) && isRiskyUnmodifiedKey(normalized.key) && !hasCommandOrAlt) {
    return { ok: false as const, message: `${HOTKEY_LABELS[field]} 会影响正常输入，请换成 F 键或 Ctrl/Alt 组合。` };
  }
  if (RESERVED_HOTKEYS.has(normalized.canonical)) {
    return { ok: false as const, message: `${normalized.display} 是系统或常用编辑快捷键，不能设置。` };
  }

  return { ok: true as const, hotkey: normalized.display, canonical: normalized.canonical };
}

function validateHotkeySettings(draft: HotkeySettings) {
  const normalizedHotkeys: HotkeySettings = { ...draft, toggleClickThrough: "" };
  const used = new Map<string, HotkeyField>();

  for (const field of HOTKEY_FIELDS) {
    const result = validateSingleHotkey(field, draft[field]);
    if (!result.ok) return { ok: false as const, message: result.message };

    const existing = used.get(result.canonical);
    if (existing) {
      return {
        ok: false as const,
        message: `${result.hotkey} 已被「${HOTKEY_LABELS[existing]}」占用，不能重复设置。`
      };
    }
    used.set(result.canonical, field);
    normalizedHotkeys[field] = result.hotkey;
  }

  return { ok: true as const, hotkeys: normalizedHotkeys };
}

function sumSplits(splits: SplitResult[]) {
  return splits.reduce((total, split) => total + split.durationMs, 0);
}

function getCurrentSegmentElapsed(activeRun: ActiveRun | null, now: number) {
  if (!activeRun || activeRun.status === "已完成") return 0;
  if (activeRun.status === "计时中" && activeRun.currentSegmentStartedAt) {
    return activeRun.currentSegmentElapsedBeforePauseMs + Math.max(0, now - activeRun.currentSegmentStartedAt);
  }

  return activeRun.currentSegmentElapsedBeforePauseMs;
}

function getTotalElapsed(activeRun: ActiveRun | null, now: number) {
  if (!activeRun) return 0;
  if (activeRun.status === "已完成") return sumSplits(activeRun.splits);
  return sumSplits(activeRun.splits) + getCurrentSegmentElapsed(activeRun, now);
}

function createBestSegments(nodes: SplitNode[], completedRuns: RunRecord[]): BestSegmentRecord | null {
  if (!completedRuns.length || !nodes.length) return null;

  const splits = nodes
    .map((node, index) => {
      const bestSplit = completedRuns
        .map((run) => run.splits.find((split) => split.index === index))
        .filter((split): split is SplitResult => Boolean(split))
        .sort((a, b) => a.durationMs - b.durationMs)[0];

      return bestSplit
        ? {
            ...bestSplit,
            nodeId: node.id,
            name: node.name,
            index
          }
        : null;
    })
    .filter((split): split is SplitResult => Boolean(split));

  if (!splits.length) return null;

  return {
    id: "best-history",
    templateName: "历史最佳记录",
    totalMs: sumSplits(splits),
    splits,
    completed: true,
    finishedAt: completedRuns[0].finishedAt
  };
}

function getHistoryTitle(run: BestSegmentRecord | RunRecord, sequence?: number) {
  if (run.id === "best-history") return "历史最佳记录";
  const title = run.completed ? "完整记录" : "未完成记录";
  return sequence ? `${title} ${sequence}` : title;
}

function getHistorySubtitle(run: BestSegmentRecord | RunRecord) {
  return formatDateTime(run.finishedAt);
}

function freezeRunningActive(activeRun: ActiveRun, now: number, keepRunning: boolean): ActiveRun {
  if (activeRun.status !== "计时中" || !activeRun.currentSegmentStartedAt) return activeRun;

  return {
    ...activeRun,
    status: keepRunning ? "计时中" : "已暂停",
    currentSegmentElapsedBeforePauseMs: getCurrentSegmentElapsed(activeRun, now),
    currentSegmentStartedAt: keepRunning ? now : null,
    savedAt: new Date(now).toISOString()
  };
}

function resumeActive(activeRun: ActiveRun, now: number): ActiveRun {
  if (activeRun.status !== "已暂停") return activeRun;
  return {
    ...activeRun,
    status: "计时中",
    currentSegmentStartedAt: now,
    savedAt: new Date(now).toISOString()
  };
}

function createActiveRun(template: SplitTemplate, now: number): ActiveRun {
  return {
    id: makeId("run"),
    templateId: template.id,
    templateName: template.name,
    templateVersion: template.version,
    templateKey: template.templateKey,
    nodes: template.nodes.map((node) => ({ ...node })),
    status: "计时中",
    startedAt: new Date(now).toISOString(),
    currentIndex: 0,
    currentSegmentStartedAt: now,
    currentSegmentElapsedBeforePauseMs: 0,
    splits: [],
    savedAt: new Date(now).toISOString()
  };
}

function createRecord(activeRun: ActiveRun, now: number, completed: boolean, includeCurrent: boolean): RunRecord | null {
  const splits = [...activeRun.splits];
  if (includeCurrent && activeRun.currentIndex < activeRun.nodes.length) {
    const durationMs = getCurrentSegmentElapsed(activeRun, now);
    if (durationMs > 0) {
      const node = activeRun.nodes[activeRun.currentIndex];
      splits.push({
        nodeId: node.id,
        name: node.name,
        index: activeRun.currentIndex,
        durationMs,
        completedAt: new Date(now).toISOString()
      });
    }
  }

  if (!splits.length) return null;

  return {
    id: completed ? activeRun.id : makeId("run-manual"),
    templateId: activeRun.templateId,
    templateName: activeRun.templateName,
    templateVersion: activeRun.templateVersion,
    templateKey: activeRun.templateKey,
    startedAt: activeRun.startedAt,
    finishedAt: new Date(now).toISOString(),
    completed,
    totalMs: sumSplits(splits),
    splits,
    note: completed ? undefined : "手动保存未完成记录"
  };
}

function getNextTimerViewMode(mode: ViewMode): ViewMode {
  if (mode === "迷你") return "展开";
  if (mode === "展开") return "列表2";
  return "迷你";
}

function getTimerModeButtonLabel(mode: ViewMode) {
  if (mode === "迷你") return "切换列表模式";
  if (mode === "展开") return "切换列表模式2";
  return "切换迷你模式";
}

function getWindowSize(viewMode: ViewMode, scale: number, locked: boolean) {
  const sizes: Record<ViewMode, { width: number; height: number }> = {
    迷你: { width: 368, height: locked ? 120 : 164 },
    展开: { width: 368, height: locked ? 388 : 432 },
    列表2: { width: 368, height: locked ? 388 : 432 },
    历史: { width: 520, height: 560 }
  };
  const size = sizes[viewMode];
  return {
    width: size.width * scale,
    height: size.height * scale
  };
}

export default function App() {
  const isSettingsWindow = useMemo(() => new URLSearchParams(window.location.search).get("window") === "settings", []);
  const dataSignatureRef = useRef("");
  const [data, setData] = useState<AppData>(() => createDefaultData());
  const [loaded, setLoaded] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("迷你");
  const [now, setNow] = useState(() => Date.now());
  const [draftName, setDraftName] = useState("默认剧情");
  const [draftNodes, setDraftNodes] = useState<SplitNode[]>([]);
  const [hotkeyDraft, setHotkeyDraft] = useState<HotkeySettings>(DEFAULT_HOTKEYS);
  const [hotkeyMessage, setHotkeyMessage] = useState("");
  const [splitFeedback, setSplitFeedback] = useState<SplitFeedback | null>(null);
  const [selectedHistoryId, setSelectedHistoryId] = useState<string>("best-history");
  const [selectedSettingsTemplateId, setSelectedSettingsTemplateId] = useState("");
  const [selectedSettingsHistoryId, setSelectedSettingsHistoryId] = useState<string>("best-history");
  const [settingsHistoryDropdownOpen, setSettingsHistoryDropdownOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("关卡模板");
  const [isEditingSegmentTime, setIsEditingSegmentTime] = useState(false);
  const [segmentTimeDraft, setSegmentTimeDraft] = useState("");
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [showOpacityPopover, setShowOpacityPopover] = useState(false);
  const [templateMessage, setTemplateMessage] = useState("");
  const [historyMessage, setHistoryMessage] = useState("");
  const [historyDeleteTargetId, setHistoryDeleteTargetId] = useState<string | null>(null);
  const [templateDeleteTargetId, setTemplateDeleteTargetId] = useState<string | null>(null);

  const currentTemplate = useMemo(() => {
    return data.templates.find((template) => template.id === data.settings.currentTemplateId) ?? data.templates[0];
  }, [data.settings.currentTemplateId, data.templates]);

  const activeRun = data.activeRun;
  const currentNode = useMemo(() => {
    if (!activeRun) return currentTemplate.nodes[0];
    if (!activeRun.nodes.length) return currentTemplate.nodes[0];
    return activeRun.nodes[clamp(activeRun.currentIndex, 0, activeRun.nodes.length - 1)];
  }, [activeRun, currentTemplate.nodes]);
  const currentSegmentMs = getCurrentSegmentElapsed(activeRun, now);
  const totalElapsedMs = getTotalElapsed(activeRun, now);
  const isLocked = data.settings.clickThrough;
  const canUseTimer = Boolean(currentTemplate?.nodes.length);
  const canSplit = Boolean(activeRun && (activeRun.status === "计时中" || activeRun.status === "已暂停") && activeRun.currentIndex < activeRun.nodes.length);
  const canEditSegmentTime = !isLocked && activeRun?.status !== "已完成" && (!activeRun || activeRun.status === "已暂停" || currentSegmentMs < 1000);

  const completedRunsForTemplate = useMemo(() => {
    const templateKey = activeRun?.templateKey ?? currentTemplate.templateKey;
    return data.runs.filter((run) => run.completed && run.templateKey === templateKey);
  }, [activeRun?.templateKey, currentTemplate.templateKey, data.runs]);

  const bestSegments = useMemo<BestSegmentRecord | null>(() => {
    const nodes = activeRun?.nodes ?? currentTemplate.nodes;
    return createBestSegments(nodes, completedRunsForTemplate);
  }, [activeRun?.nodes, completedRunsForTemplate, currentTemplate.nodes]);

  const bestByIndex = useMemo(() => {
    return new Map(bestSegments?.splits.map((split) => [split.index, split]) ?? []);
  }, [bestSegments]);

  const historyItems = useMemo(() => {
    const items: Array<BestSegmentRecord | RunRecord> = [...data.runs];
    if (bestSegments) return [bestSegments, ...items];
    return items;
  }, [bestSegments, data.runs]);

  const selectedHistory = useMemo(() => {
    return historyItems.find((item) => item.id === selectedHistoryId) ?? historyItems[0] ?? null;
  }, [historyItems, selectedHistoryId]);

  const selectedSettingsTemplate = useMemo(() => {
    return data.templates.find((template) => template.id === selectedSettingsTemplateId) ?? currentTemplate ?? data.templates[0];
  }, [currentTemplate, data.templates, selectedSettingsTemplateId]);

  const settingsRunsForTemplate = useMemo(() => {
    if (!selectedSettingsTemplate) return [];
    return data.runs
      .filter((run) => run.templateKey === selectedSettingsTemplate.templateKey)
      .sort((a, b) => new Date(b.finishedAt).getTime() - new Date(a.finishedAt).getTime());
  }, [data.runs, selectedSettingsTemplate]);

  const settingsBestSegments = useMemo(() => {
    if (!selectedSettingsTemplate) return null;
    return createBestSegments(
      selectedSettingsTemplate.nodes,
      settingsRunsForTemplate.filter((run) => run.completed)
    );
  }, [selectedSettingsTemplate, settingsRunsForTemplate]);

  const settingsHistoryItems = useMemo(() => {
    if (settingsBestSegments) return [settingsBestSegments, ...settingsRunsForTemplate];
    return settingsRunsForTemplate;
  }, [settingsBestSegments, settingsRunsForTemplate]);

  const settingsHistorySequenceById = useMemo(() => {
    const sequenceById = new Map<string, number>();
    let sequence = 1;
    settingsHistoryItems.forEach((run) => {
      if (run.id === "best-history") return;
      sequenceById.set(run.id, sequence);
      sequence += 1;
    });
    return sequenceById;
  }, [settingsHistoryItems]);

  const selectedSettingsHistory = useMemo(() => {
    return settingsHistoryItems.find((item) => item.id === selectedSettingsHistoryId) ?? settingsHistoryItems[0] ?? null;
  }, [selectedSettingsHistoryId, settingsHistoryItems]);

  useEffect(() => {
    window.poe2Timer.loadData().then((storedData) => {
      const normalized = normalizeData(storedData, {
        pauseRunning: !isSettingsWindow,
        resetClickThrough: !isSettingsWindow
      });
      dataSignatureRef.current = JSON.stringify(normalized);
      setData(normalized);
      setHotkeyDraft(normalized.settings.hotkeys);
      setSelectedSettingsTemplateId(normalized.settings.currentTemplateId);
      setLoaded(true);
      if (!isSettingsWindow) {
        void window.poe2Timer.setClickThrough(normalized.settings.clickThrough);
        void window.poe2Timer.updateShortcuts(normalized.settings.hotkeys);
      }
    });
  }, [isSettingsWindow]);

  useEffect(() => {
    if (!loaded || !currentTemplate) return;
    setDraftName(currentTemplate.name);
    setDraftNodes(currentTemplate.nodes.map((node) => ({ ...node })));
  }, [currentTemplate, loaded]);

  useEffect(() => {
    if (!loaded || !data.templates.length) return;
    const selectedTemplateExists = data.templates.some((template) => template.id === selectedSettingsTemplateId);
    if (selectedTemplateExists) return;
    const fallbackTemplateId = data.templates.some((template) => template.id === data.settings.currentTemplateId)
      ? data.settings.currentTemplateId
      : data.templates[0].id;
    setSelectedSettingsTemplateId(fallbackTemplateId);
  }, [data.settings.currentTemplateId, data.templates, loaded, selectedSettingsTemplateId]);

  useEffect(() => {
    if (!loaded) return;
    if (!selectedSettingsHistory) {
      if (selectedSettingsHistoryId !== "best-history") setSelectedSettingsHistoryId("best-history");
      return;
    }
    if (selectedSettingsHistory.id !== selectedSettingsHistoryId) setSelectedSettingsHistoryId(selectedSettingsHistory.id);
  }, [loaded, selectedSettingsHistory, selectedSettingsHistoryId]);

  useEffect(() => {
    if (settingsTab !== "历史记录") setSettingsHistoryDropdownOpen(false);
  }, [settingsTab]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const saveTimer = window.setTimeout(() => {
      dataSignatureRef.current = JSON.stringify(data);
      void window.poe2Timer.saveData(data);
    }, 250);
    return () => window.clearTimeout(saveTimer);
  }, [data, loaded]);

  useEffect(() => {
    const removeDataChanged = window.poe2Timer.onDataChanged((changedData) => {
      const normalized = normalizeData(changedData, {
        pauseRunning: false,
        resetClickThrough: false
      });
      const signature = JSON.stringify(normalized);
      if (signature === dataSignatureRef.current) return;
      dataSignatureRef.current = signature;
      setData(normalized);
      setHotkeyDraft(normalized.settings.hotkeys);
    });
    return removeDataChanged;
  }, []);

  useEffect(() => {
    if (!loaded || isSettingsWindow || data.activeRun?.status !== "计时中") return;
    const saveSnapshot = window.setInterval(() => {
      setData((previous) => {
        if (previous.activeRun?.status !== "计时中") return previous;
        return {
          ...previous,
          activeRun: freezeRunningActive(previous.activeRun, Date.now(), true)
        };
      });
    }, 5000);
    return () => window.clearInterval(saveSnapshot);
  }, [data.activeRun?.status, isSettingsWindow, loaded]);

  useEffect(() => {
    if (!loaded || isSettingsWindow) return;
    void window.poe2Timer.resizeWindow(getWindowSize(viewMode, data.settings.scale, data.settings.clickThrough));
  }, [data.settings.clickThrough, data.settings.scale, isSettingsWindow, loaded, viewMode]);

  const updateLocked = useCallback((enabled: boolean) => {
    setShowOpacityPopover(false);
    setData((previous) => ({
      ...previous,
      settings: {
        ...previous.settings,
        clickThrough: enabled
      }
    }));
    void window.poe2Timer.setLocked(enabled);
  }, []);

  const toggleTimer = useCallback(() => {
    setData((previous) => {
      const nowMs = Date.now();
      const active = previous.activeRun;
      const template = previous.templates.find((item) => item.id === previous.settings.currentTemplateId) ?? previous.templates[0];
      if (!template?.nodes.length) return previous;

      if (!active || active.status === "已完成") {
        return {
          ...previous,
          activeRun: createActiveRun(template, nowMs)
        };
      }

      if (active.status === "计时中") {
        return {
          ...previous,
          activeRun: freezeRunningActive(active, nowMs, false)
        };
      }

      if (active.status === "已暂停") {
        return {
          ...previous,
          activeRun: resumeActive(active, nowMs)
        };
      }

      return previous;
    });
  }, []);

  const splitNode = useCallback(() => {
    setData((previous) => {
      const active = previous.activeRun;
      if (!active || (active.status !== "计时中" && active.status !== "已暂停")) return previous;
      if (active.currentIndex >= active.nodes.length) return previous;

      const nowMs = Date.now();
      const node = active.nodes[active.currentIndex];
      const durationMs = getCurrentSegmentElapsed(active, nowMs);
      const split: SplitResult = {
        nodeId: node.id,
        name: node.name,
        index: active.currentIndex,
        durationMs,
        completedAt: new Date(nowMs).toISOString()
      };
      const pbSplit = bestByIndex.get(active.currentIndex);
      if (pbSplit) {
        const diff = durationMs - pbSplit.durationMs;
        const feedback = {
          id: makeId("feedback"),
          statusText: diff === 0 ? "持平" : diff < 0 ? "快" : "慢",
          timeText: formatNaturalDuration(Math.abs(diff)),
          good: diff <= 0
        };
        setSplitFeedback(feedback);
        window.setTimeout(() => {
          setSplitFeedback((current) => (current?.id === feedback.id ? null : current));
        }, 3000);
      }

      const splits = [...active.splits, split];
      const isFinished = active.currentIndex >= active.nodes.length - 1;

      if (isFinished) {
        const finishedActive: ActiveRun = {
          ...active,
          status: "已完成",
          currentIndex: active.nodes.length,
          currentSegmentStartedAt: null,
          currentSegmentElapsedBeforePauseMs: 0,
          splits,
          savedAt: new Date(nowMs).toISOString()
        };
        const record = createRecord(finishedActive, nowMs, true, false);
        return {
          ...previous,
          runs: record ? [record, ...previous.runs.filter((run) => run.id !== record.id)] : previous.runs,
          activeRun: finishedActive
        };
      }

      return {
        ...previous,
        activeRun: {
          ...active,
          currentIndex: active.currentIndex + 1,
          currentSegmentStartedAt: active.status === "计时中" ? nowMs : null,
          currentSegmentElapsedBeforePauseMs: 0,
          splits,
          savedAt: new Date(nowMs).toISOString()
        }
      };
    });
  }, [bestByIndex]);

  const resetCurrentSegment = useCallback(() => {
    setData((previous) => {
      const active = previous.activeRun;
      if (!active || active.status === "已完成") return previous;
      const nowMs = Date.now();
      return {
        ...previous,
        activeRun: {
          ...active,
          currentSegmentStartedAt: active.status === "计时中" ? nowMs : null,
          currentSegmentElapsedBeforePauseMs: 0,
          savedAt: new Date(nowMs).toISOString()
        }
      };
    });
    setSplitFeedback(null);
  }, []);

  const resetRun = useCallback(() => {
    setData((previous) => ({
      ...previous,
      activeRun: null
    }));
    setSplitFeedback(null);
  }, []);

  const requestResetCurrentSegment = useCallback(() => {
    if (!data.activeRun || data.activeRun.status === "已完成") return;
    setConfirmAction("重置当前关卡");
  }, [data.activeRun]);

  const requestResetRun = useCallback(() => {
    setConfirmAction("重置所有关卡");
  }, []);

  const saveCurrentRun = useCallback(() => {
    const active = data.activeRun;
    if (!active || active.status === "已完成") {
      setHistoryMessage("当前没有可保存的计时记录。");
      return;
    }

    const record = createRecord(active, Date.now(), false, true);
    if (!record) {
      setHistoryMessage("当前记录还没有有效时间。");
      return;
    }

    setData((previous) => ({
      ...previous,
      runs: [record, ...previous.runs],
      activeRun: null
    }));
    setSelectedHistoryId(record.id);
    setSelectedSettingsTemplateId(active.templateId);
    setSelectedSettingsHistoryId(record.id);
    setHistoryMessage("本次记录已保存。");
  }, [data.activeRun]);

  const saveTemplate = useCallback(() => {
    const cleanedNodes = draftNodes
      .map((node) => ({ ...node, name: node.name.trim() }))
      .filter((node) => node.name.length > 0)
      .map((node) => ({ ...node, id: node.id || makeId("node") }));

    if (!cleanedNodes.length) {
      setTemplateMessage("至少需要保留一个关卡节点。");
      return;
    }

    if (cleanedNodes.length > MAX_TEMPLATE_NODES) {
      setTemplateMessage(`关卡节点最多只能保留 ${MAX_TEMPLATE_NODES} 个。`);
      return;
    }

    const newVersion = data.templates.reduce((max, template) => Math.max(max, template.version), 0) + 1;
    const templateName = draftName.trim() || `自定义剧情模板 ${newVersion}`;
    const duplicateName = data.templates.some((template) => template.name.trim().toLocaleLowerCase() === templateName.toLocaleLowerCase());
    if (duplicateName) {
      setTemplateMessage("模板名称已存在，请换一个名称后再保存。");
      return;
    }

    const nowIso = new Date().toISOString();
    const template: SplitTemplate = {
      id: makeId("template"),
      name: templateName,
      version: newVersion,
      templateKey: makeTemplateKey(cleanedNodes),
      nodes: cleanedNodes,
      createdAt: nowIso,
      updatedAt: nowIso
    };

    setData((previous) => ({
      ...previous,
      templates: [template, ...previous.templates],
      settings: {
        ...previous.settings,
        currentTemplateId: template.id
      }
    }));
    setTemplateMessage("关卡模板已保存。");
  }, [data.templates, draftName, draftNodes]);

  const resetTemplateConfirmed = useCallback(() => {
    const template = createDefaultTemplate();
    setDraftName(template.name);
    setDraftNodes(template.nodes);
    setTemplateMessage("已恢复为默认剧情模板。");
    setData((previous) => {
      const existing = previous.templates.find((item) => item.templateKey === template.templateKey) ?? template;
      const templates = previous.templates.some((item) => item.templateKey === template.templateKey) ? previous.templates : [template, ...previous.templates];
      return {
        ...previous,
        templates,
        settings: {
          ...previous.settings,
          currentTemplateId: existing.id
        },
        activeRun: null
      };
    });
  }, []);

  const requestResetTemplate = useCallback(() => {
    setConfirmAction("重置关卡模板");
  }, []);

  const requestDeleteHistoryRecord = useCallback((recordId?: string) => {
    if (!recordId || recordId === "best-history") return;
    setHistoryDeleteTargetId(recordId);
    setConfirmAction("删除历史记录");
  }, []);

  const requestDeleteTemplate = useCallback(() => {
    if (!currentTemplate || data.templates.length <= 1 || activeRun?.status === "计时中" || activeRun?.status === "已暂停") return;
    setTemplateDeleteTargetId(currentTemplate.id);
    setConfirmAction("删除关卡模板");
  }, [activeRun?.status, currentTemplate, data.templates.length]);

  const deleteTemplate = useCallback((templateId: string) => {
    setData((previous) => {
      if (previous.templates.length <= 1) return previous;
      const templates = previous.templates.filter((template) => template.id !== templateId);
      if (!templates.length) return previous;
      const currentTemplateId = previous.settings.currentTemplateId === templateId ? templates[0].id : previous.settings.currentTemplateId;
      return {
        ...previous,
        templates,
        settings: {
          ...previous.settings,
          currentTemplateId
        },
        activeRun: null
      };
    });
    setTemplateDeleteTargetId(null);
    setTemplateMessage("关卡模板已删除。");
  }, []);

  const deleteHistoryRecord = useCallback((recordId: string) => {
    setData((previous) => ({
      ...previous,
      runs: previous.runs.filter((run) => run.id !== recordId)
    }));
    setSelectedHistoryId("best-history");
    setSelectedSettingsHistoryId("best-history");
    setSettingsHistoryDropdownOpen(false);
    setHistoryMessage("历史记录已删除。");
  }, []);

  const cancelConfirmAction = useCallback(() => {
    setConfirmAction(null);
    setHistoryDeleteTargetId(null);
    setTemplateDeleteTargetId(null);
  }, []);

  const confirmResetAction = useCallback(() => {
    if (confirmAction === "重置当前关卡") resetCurrentSegment();
    if (confirmAction === "重置所有关卡") resetRun();
    if (confirmAction === "重置关卡模板") resetTemplateConfirmed();
    if (confirmAction === "删除历史记录" && historyDeleteTargetId) deleteHistoryRecord(historyDeleteTargetId);
    if (confirmAction === "删除关卡模板" && templateDeleteTargetId) deleteTemplate(templateDeleteTargetId);
    setHistoryDeleteTargetId(null);
    setTemplateDeleteTargetId(null);
    setConfirmAction(null);
  }, [confirmAction, deleteHistoryRecord, deleteTemplate, historyDeleteTargetId, resetCurrentSegment, resetRun, resetTemplateConfirmed, templateDeleteTargetId]);

  const handleShortcut = useCallback(
    (action: ShortcutAction) => {
      if (action === "开始暂停继续") toggleTimer();
      if (action === "记录节点") splitNode();
      if (action === "重置当前关卡") resetCurrentSegment();
      if (action === "切换展开") setViewMode((previous) => getNextTimerViewMode(previous));
    },
    [resetCurrentSegment, splitNode, toggleTimer]
  );

  useEffect(() => {
    const removeShortcut = window.poe2Timer.onShortcut(handleShortcut);
    const removeClickThrough = window.poe2Timer.onClickThroughChange((enabled) => {
      setData((previous) => ({
        ...previous,
        settings: {
          ...previous.settings,
          clickThrough: enabled
        }
      }));
    });

    return () => {
      removeShortcut();
      removeClickThrough();
    };
  }, [handleShortcut]);

  const rows = useMemo(() => {
    const sourceNodes = activeRun?.nodes ?? currentTemplate.nodes;
    return sourceNodes.map((node, index) => {
      const split = activeRun?.splits.find((item) => item.index === index);
      const isCurrent = activeRun?.currentIndex === index && activeRun.status !== "已完成";
      const durationMs = split?.durationMs ?? (isCurrent ? currentSegmentMs : null);
      const pbSplit = bestByIndex.get(index);
      const diff = durationMs !== null && pbSplit ? durationMs - pbSplit.durationMs : null;

      return {
        node,
        index,
        isCurrent,
        durationMs,
        bestMs: pbSplit?.durationMs ?? null,
        diff
      };
    });
  }, [activeRun, bestByIndex, currentSegmentMs, currentTemplate.nodes]);

  const setOpacity = (opacity: number) => {
    setData((previous) => ({
      ...previous,
      settings: {
        ...previous.settings,
        opacity: clamp(opacity, 0, 1)
      }
    }));
  };

  const updateHotkeyDraft = (key: HotkeyField, value: string) => {
    setHotkeyMessage("");
    setHotkeyDraft((previous) => ({
      ...previous,
      [key]: value
    }));
  };

  const captureHotkeyDraft = (key: HotkeyField, event: React.KeyboardEvent<HTMLInputElement>) => {
    event.preventDefault();
    const accelerator = formatHotkeyFromEvent(event);
    if (accelerator === null) return;
    const validation = validateSingleHotkey(key, accelerator);
    if (!validation.ok) {
      setHotkeyMessage(validation.message);
      return;
    }

    const duplicateField = HOTKEY_FIELDS.find((field) => field !== key && canonicalHotkey(hotkeyDraft[field]) === validation.canonical);
    if (duplicateField) {
      setHotkeyMessage(`${validation.hotkey} 已被「${HOTKEY_LABELS[duplicateField]}」占用，不能重复设置。`);
      return;
    }

    updateHotkeyDraft(key, validation.hotkey);
  };

  const resetHotkeys = () => {
    setHotkeyDraft(DEFAULT_HOTKEYS);
    setHotkeyMessage("已恢复默认，应用后生效。");
  };

  const applyHotkeys = async () => {
    const validation = validateHotkeySettings(hotkeyDraft);
    if (!validation.ok) {
      setHotkeyMessage(validation.message);
      return;
    }

    const result = await window.poe2Timer.updateShortcuts(validation.hotkeys);
    if (!result.ok) {
      setHotkeyMessage(`未应用：快捷键被系统或其他程序占用：${result.failures.join("、")}`);
      return;
    }

    setData((previous) => ({
      ...previous,
      settings: {
        ...previous.settings,
        hotkeys: validation.hotkeys
      }
    }));
    setHotkeyDraft(validation.hotkeys);
    setHotkeyMessage("快捷键已应用。");
  };

  const selectTemplate = (templateId: string) => {
    setTemplateMessage("");
    setData((previous) => ({
      ...previous,
      settings: {
        ...previous.settings,
        currentTemplateId: templateId
      },
      activeRun: null
    }));
  };

  const selectSettingsHistoryTemplate = (templateId: string) => {
    setHistoryMessage("");
    setSelectedSettingsTemplateId(templateId);
    setSelectedSettingsHistoryId("best-history");
    setSettingsHistoryDropdownOpen(false);
  };

  const selectSettingsHistoryRecord = (recordId: string) => {
    setSelectedSettingsHistoryId(recordId);
    setSettingsHistoryDropdownOpen(false);
  };

  const addDraftNode = () => {
    setTemplateMessage("");
    if (draftNodes.length >= MAX_TEMPLATE_NODES) {
      setTemplateMessage(`关卡节点最多只能增加到 ${MAX_TEMPLATE_NODES} 个。`);
      return;
    }
    setDraftNodes((previous) => [...previous, { id: makeId("node"), name: "新增节点" }]);
  };

  const updateDraftNode = (id: string, name: string) => {
    setTemplateMessage("");
    setDraftNodes((previous) => previous.map((node) => (node.id === id ? { ...node, name } : node)));
  };

  const removeDraftNode = (id: string) => {
    setTemplateMessage("");
    setDraftNodes((previous) => previous.filter((node) => node.id !== id));
  };

  const moveDraftNode = (index: number, direction: -1 | 1) => {
    setTemplateMessage("");
    setDraftNodes((previous) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= previous.length) return previous;
      const copy = [...previous];
      const [node] = copy.splice(index, 1);
      copy.splice(nextIndex, 0, node);
      return copy;
    });
  };

  const beginSegmentTimeEdit = () => {
    if (!canEditSegmentTime) return;
    setSegmentTimeDraft(formatDuration(currentSegmentMs));
    setIsEditingSegmentTime(true);
  };

  const cancelSegmentTimeEdit = () => {
    setIsEditingSegmentTime(false);
    setSegmentTimeDraft("");
  };

  const commitSegmentTimeEdit = () => {
    const parsedMs = parseDurationInput(segmentTimeDraft);
    if (parsedMs === null) {
      cancelSegmentTimeEdit();
      return;
    }

    setData((previous) => {
      const nowMs = Date.now();
      const template = previous.templates.find((item) => item.id === previous.settings.currentTemplateId) ?? previous.templates[0];
      const active = previous.activeRun;
      if (!template?.nodes.length || active?.status === "已完成") return previous;

      if (!active) {
        if (parsedMs === 0) return previous;
        return {
          ...previous,
          activeRun: {
            ...createActiveRun(template, nowMs),
            status: "已暂停",
            currentSegmentStartedAt: null,
            currentSegmentElapsedBeforePauseMs: parsedMs
          }
        };
      }

      return {
        ...previous,
        activeRun: {
          ...active,
          currentSegmentStartedAt: active.status === "计时中" ? nowMs : null,
          currentSegmentElapsedBeforePauseMs: parsedMs,
          savedAt: new Date(nowMs).toISOString()
        }
      };
    });
    cancelSegmentTimeEdit();
  };

  const commitSegmentTimeEditOnBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    commitSegmentTimeEdit();
  };

  const handleSegmentTimeKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") commitSegmentTimeEdit();
    if (event.key === "Escape") cancelSegmentTimeEdit();
  };

  const confirmLayer = confirmAction ? (
    <section className="confirm-layer no-drag">
      <div className="confirm-dialog">
        <strong>{confirmAction}</strong>
        <span>{getConfirmActionMessage(confirmAction)}</span>
        <div className="confirm-actions">
          <button className="confirm-button ghost" onClick={cancelConfirmAction} type="button">
            取消
          </button>
          <button className="confirm-button danger" onClick={confirmResetAction} type="button">
            确认
          </button>
        </div>
      </div>
    </section>
  ) : null;

  if (!loaded) {
    return <div className="loading">正在读取计时器数据...</div>;
  }

  if (isSettingsWindow) {
    return (
      <main
        className="app app-settings-window"
        style={
          {
            "--scale": 1,
            "--panel-alpha": data.settings.opacity
          } as React.CSSProperties
        }
      >
        <section className="settings-window-panel">
          <header className="panel-header drag-zone settings-window-header">
            <div className="brand-lockup">
              <img src="/brand/dark-dragon-logo.png" alt="" />
              <div className="eyebrow">设置</div>
            </div>
            <div className="header-actions no-drag">
              <IconButton className="header-button danger" label="关闭设置" onClick={() => void window.poe2Timer.closeSettings()}>
                <X />
              </IconButton>
            </div>
          </header>

          <section className="settings-view no-drag">
            <aside className="settings-rail">
              <IconButton className={settingsTab === "关卡模板" ? "selected" : ""} label="关卡模板" onClick={() => setSettingsTab("关卡模板")}>
                <LayoutTemplate />
              </IconButton>
              <IconButton className={settingsTab === "历史记录" ? "selected" : ""} label="历史记录" onClick={() => setSettingsTab("历史记录")}>
                <ClipboardList />
              </IconButton>
              <IconButton className={settingsTab === "窗口" ? "selected" : ""} label="调参数" onClick={() => setSettingsTab("窗口")}>
                <SlidersHorizontal />
              </IconButton>
              <IconButton className={settingsTab === "快捷键" ? "selected" : ""} label="快捷键" onClick={() => setSettingsTab("快捷键")}>
                <Keyboard />
              </IconButton>
            </aside>

            <section className={`settings-main ${settingsTab === "历史记录" ? "history-settings-main" : ""}`}>
              {settingsTab === "关卡模板" && (
                <>
                  <div className="settings-title">关卡模板</div>
                  <div className="setting-row">
                    <label>
                      <span>选择模板</span>
                      <select value={data.settings.currentTemplateId} onChange={(event) => selectTemplate(event.target.value)} disabled={activeRun?.status === "计时中"}>
                        {data.templates.map((template) => (
                          <option key={template.id} value={template.id}>
                            {template.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <label className="field">
                    <span>模板名称</span>
                    <input
                      value={draftName}
                      onChange={(event) => {
                        setTemplateMessage("");
                        setDraftName(event.target.value);
                      }}
                    />
                  </label>

                  <div className="node-editor">
                    <div className="section-title">节点</div>
                    <div className="node-action-row">
                      <div className="settings-inline-feedback">
                        {(templateMessage || draftNodes.length >= MAX_TEMPLATE_NODES) && (
                          <span className="settings-note strong-note">{templateMessage || `已达到 ${MAX_TEMPLATE_NODES} 个节点上限。`}</span>
                        )}
                      </div>
                      <div className="toolbar settings-actions inline-actions">
                        <IconButton className="settings-action-button add" label={draftNodes.length >= MAX_TEMPLATE_NODES ? `最多 ${MAX_TEMPLATE_NODES} 个节点` : "新增节点"} onClick={addDraftNode} disabled={draftNodes.length >= MAX_TEMPLATE_NODES}>
                          <Plus />
                        </IconButton>
                        <IconButton className="settings-action-button reset" label="重置关卡模板" onClick={requestResetTemplate}>
                          <RotateCcw />
                        </IconButton>
                        <IconButton
                          className="settings-action-button danger"
                          label="删除关卡模板"
                          onClick={requestDeleteTemplate}
                          disabled={data.templates.length <= 1 || activeRun?.status === "计时中" || activeRun?.status === "已暂停"}
                        >
                          <Trash2 />
                        </IconButton>
                        <IconButton className="settings-action-button save" label="保存关卡模板" onClick={saveTemplate} disabled={activeRun?.status === "计时中" || draftNodes.every((node) => !node.name.trim())}>
                          <Save />
                        </IconButton>
                      </div>
                    </div>
                    {draftNodes.map((node, index) => (
                      <div className="node-edit-row" key={node.id}>
                        <span className="node-index">{String(index + 1).padStart(2, "0")}</span>
                        <input value={node.name} onChange={(event) => updateDraftNode(node.id, event.target.value)} />
                        <div className="node-row-actions">
                          <IconButton className="node-row-button" label="上移" onClick={() => moveDraftNode(index, -1)} disabled={index === 0}>
                            <ArrowUp />
                          </IconButton>
                          <IconButton className="node-row-button" label="下移" onClick={() => moveDraftNode(index, 1)} disabled={index === draftNodes.length - 1}>
                            <ArrowDown />
                          </IconButton>
                          <IconButton className="node-row-button danger" label="删除" onClick={() => removeDraftNode(node.id)} disabled={draftNodes.length <= 1}>
                            <Trash2 />
                          </IconButton>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {settingsTab === "历史记录" && (
                <>
                  <div className="settings-title">历史记录</div>
                  <div className="field">
                    <span>关卡模板</span>
                    <select value={selectedSettingsTemplate?.id ?? ""} onChange={(event) => selectSettingsHistoryTemplate(event.target.value)} disabled={!data.templates.length}>
                      {!data.templates.length && <option value="">暂无关卡模板</option>}
                      {data.templates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <span>历史记录</span>
                    <div className="history-select-control">
                      <button
                        className="history-select-button"
                        disabled={!settingsHistoryItems.length}
                        onClick={() => setSettingsHistoryDropdownOpen((previous) => !previous)}
                        type="button"
                      >
                        <span className="history-select-text">
                          <strong>{selectedSettingsHistory ? getHistoryTitle(selectedSettingsHistory, settingsHistorySequenceById.get(selectedSettingsHistory.id)) : "暂无历史记录"}</strong>
                          <span>{selectedSettingsHistory ? getHistorySubtitle(selectedSettingsHistory) : "该模板还没有保存过成绩"}</span>
                        </span>
                        {selectedSettingsHistory?.id === "best-history" && (
                          <span className="history-best-badge">
                            <Trophy />
                            最佳
                          </span>
                        )}
                        <ChevronDown />
                      </button>
                      {settingsHistoryDropdownOpen && settingsHistoryItems.length > 0 && (
                        <div className="history-select-menu" role="listbox">
                          {settingsHistoryItems.map((run) => (
                            <button
                              className={`${run.id === selectedSettingsHistory?.id ? "selected" : ""} ${run.id === "best-history" ? "best" : ""}`}
                              key={run.id}
                              onClick={() => selectSettingsHistoryRecord(run.id)}
                              role="option"
                              type="button"
                            >
                              <span className="history-select-text">
                                <strong>{getHistoryTitle(run, settingsHistorySequenceById.get(run.id))}</strong>
                                <span>{getHistorySubtitle(run)}</span>
                              </span>
                              <span className="history-select-meta">
                                {run.id === "best-history" && (
                                  <span className="history-best-badge">
                                    <Trophy />
                                    最佳
                                  </span>
                                )}
                                <b>{formatDuration(run.totalMs, true)}</b>
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="history-action-row">
                    <div className="settings-inline-feedback">{historyMessage && <span className="settings-note strong-note">{historyMessage}</span>}</div>
                    <div className="toolbar settings-actions inline-actions">
                      <IconButton className="settings-action-button save" label="保存本次" onClick={saveCurrentRun} disabled={!activeRun || activeRun.status === "已完成"}>
                        <Save />
                      </IconButton>
                      <IconButton className="settings-action-button danger" label="删除历史记录" onClick={() => requestDeleteHistoryRecord(selectedSettingsHistory?.id)} disabled={!selectedSettingsHistory || selectedSettingsHistory.id === "best-history"}>
                        <Trash2 />
                      </IconButton>
                    </div>
                  </div>
                  <div className="history-detail settings-history-detail">
                    {!selectedSettingsHistory && <p className="empty">请选择一条历史记录。</p>}
                    {selectedSettingsHistory?.splits.map((split) => (
                      <div className="detail-row" key={`settings-${selectedSettingsHistory.id}-${split.index}`}>
                        <span>{split.name}</span>
                        <strong>{formatDuration(split.durationMs)}</strong>
                      </div>
                    ))}
                    {selectedSettingsHistory && (
                      <div className="detail-row total">
                        <span>总用时</span>
                        <strong>{formatDuration(selectedSettingsHistory.totalMs, true)}</strong>
                      </div>
                    )}
                  </div>
                </>
              )}

              {settingsTab === "窗口" && (
                <>
                  <div className="settings-title">调参数</div>
                  <label className="field inline-field">
                    <span>透明度</span>
                    <input type="range" min="0" max="100" step="1" value={Math.round(data.settings.opacity * 100)} onChange={(event) => setOpacity(Number(event.target.value) / 100)} />
                    <b>{Math.round(data.settings.opacity * 100)}%</b>
                  </label>
                </>
              )}

              {settingsTab === "快捷键" && (
                <>
                  <div className="settings-title">快捷键</div>
                  <div className="hotkey-action-row">
                    <div className="settings-inline-feedback">{hotkeyMessage && <span className="settings-note strong-note">{hotkeyMessage}</span>}</div>
                    <div className="toolbar settings-actions inline-actions">
                      <IconButton className="settings-action-button save" label="应用快捷键" onClick={applyHotkeys}>
                        <Check />
                      </IconButton>
                      <IconButton className="settings-action-button reset" label="恢复默认快捷键" onClick={resetHotkeys}>
                        <RotateCcw />
                      </IconButton>
                    </div>
                  </div>
                  <div className="hotkey-grid">
                    <label>
                      <span>开始 / 暂停 / 继续</span>
                      <input readOnly value={hotkeyDraft.startPause} onKeyDown={(event) => captureHotkeyDraft("startPause", event)} />
                    </label>
                    <label>
                      <span>下一关</span>
                      <input readOnly value={hotkeyDraft.split} onKeyDown={(event) => captureHotkeyDraft("split", event)} />
                    </label>
                    <label>
                      <span>重置当前关卡</span>
                      <input readOnly value={hotkeyDraft.undo} onKeyDown={(event) => captureHotkeyDraft("undo", event)} />
                    </label>
                    <label>
                      <span>迷你 / 列表 / 列表2</span>
                      <input readOnly value={hotkeyDraft.toggleView} onKeyDown={(event) => captureHotkeyDraft("toggleView", event)} />
                    </label>
                  </div>
                </>
              )}
            </section>
          </section>
          {confirmLayer}
        </section>
      </main>
    );
  }

  return (
    <main
      className={`app app-${viewMode} ${isLocked ? "is-locked" : "is-unlocked"}`}
      style={
        {
          "--scale": data.settings.scale,
          "--panel-alpha": data.settings.opacity
        } as React.CSSProperties
      }
    >
      <section className="timer-panel">
        <header className="panel-header drag-zone">
          <div className="header-left">
            <div className="brand-lockup">
              <img src="/brand/dark-dragon-logo.png" alt="" />
              <div className="eyebrow app-name">{APP_NAME}</div>
            </div>
          </div>
          <div className="header-actions no-drag">
            {(viewMode === "迷你" || viewMode === "展开" || viewMode === "列表2") && (
              <IconButton className="header-button mode-toggle-button" label={getTimerModeButtonLabel(viewMode)} onClick={() => setViewMode((previous) => getNextTimerViewMode(previous))}>
                {viewMode === "迷你" ? <ClipboardList /> : <PanelLeft />}
              </IconButton>
            )}
            <IconButton className="header-button lock-toggle-button" label={isLocked ? "解锁" : "锁定"} onClick={() => updateLocked(!isLocked)}>
              <Lock />
            </IconButton>
            <IconButton className="header-button" label="设置透明度" onClick={() => setShowOpacityPopover((previous) => !previous)}>
              <SlidersHorizontal />
            </IconButton>
            <IconButton className="header-button" label="设置" onClick={() => void window.poe2Timer.openSettings()}>
              <Settings />
            </IconButton>
            <IconButton className="header-button" label="最小化" onClick={() => void window.poe2Timer.minimizeApp()}>
              <Minus />
            </IconButton>
            <IconButton className="header-button danger" label="关闭" onClick={() => void window.poe2Timer.closeApp()}>
              <X />
            </IconButton>
          </div>
        </header>

        {showOpacityPopover && !isLocked && (viewMode === "迷你" || viewMode === "展开" || viewMode === "列表2") && (
          <section className="opacity-popover no-drag">
            <span>透明度</span>
            <input type="range" min="0" max="100" step="1" value={Math.round(data.settings.opacity * 100)} onChange={(event) => setOpacity(Number(event.target.value) / 100)} />
            <b>{Math.round(data.settings.opacity * 100)}%</b>
          </section>
        )}

        {(viewMode === "迷你" || viewMode === "展开" || viewMode === "列表2") && (
          <>
            <section className="mini-readout">
              <div className="node-block">
                <strong>{activeRun ? currentNode?.name ?? "已完成" : currentTemplate.nodes[0]?.name}</strong>
                <span>总时间</span>
              </div>
              <div className={activeRun?.status === "已暂停" && currentSegmentMs > 0 ? "time-block paused" : "time-block"}>
                {isEditingSegmentTime ? (
                  <div className="time-editor" onBlur={commitSegmentTimeEditOnBlur}>
                    {getEditableDurationParts(segmentTimeDraft).map((part, index) => (
                      <span className="time-editor-part" key={`time-part-${index}`}>
                        <input
                          autoFocus={index === 0}
                          inputMode="numeric"
                          value={part}
                          onChange={(event) => setSegmentTimeDraft((previous) => updateDurationPart(previous, index, event.target.value))}
                          onFocus={(event) => event.currentTarget.select()}
                          onKeyDown={handleSegmentTimeKeyDown}
                        />
                        {index < 2 && <i>:</i>}
                      </span>
                    ))}
                  </div>
                ) : canEditSegmentTime ? (
                  <button className="time-value editable-time" onClick={beginSegmentTimeEdit} type="button">
                    {activeRun?.status === "已完成" ? "完成" : formatDuration(currentSegmentMs)}
                  </button>
                ) : (
                  <strong className="time-value">{activeRun?.status === "已完成" ? "完成" : formatDuration(currentSegmentMs)}</strong>
                )}
                <span>{formatDuration(totalElapsedMs, true)}</span>
              </div>
              {splitFeedback && (
                <em className={splitFeedback.good ? "split-feedback good" : "split-feedback bad"} key={splitFeedback.id}>
                  <span>{splitFeedback.statusText}</span>
                  <strong>{splitFeedback.timeText}</strong>
                </em>
              )}
            </section>

            {!isLocked && (
              <section className="controls no-drag">
                <IconButton label={activeRun?.status === "计时中" ? "暂停" : "开始 / 继续"} onClick={toggleTimer} disabled={!canUseTimer}>
                  {activeRun?.status === "计时中" ? <CirclePause /> : <Play />}
                </IconButton>
                <IconButton label="下一关" onClick={splitNode} disabled={!canSplit}>
                  <Flag />
                </IconButton>
                <IconButton label="重置当前关卡" onClick={requestResetCurrentSegment} disabled={!activeRun || activeRun.status === "已完成"}>
                  <TimerReset />
                </IconButton>
                <IconButton label="重置所有关卡" onClick={requestResetRun}>
                  <RotateCcw />
                </IconButton>
              </section>
            )}

            {(viewMode === "展开" || viewMode === "列表2") && (
              <section className={viewMode === "列表2" ? "split-list split-list-simple" : "split-list"}>
                <div className={viewMode === "列表2" ? "split-row split-head split-row-simple" : "split-row split-head"}>
                  <span>关卡</span>
                  <span>当前时间</span>
                  {viewMode === "展开" && (
                    <>
                      <span>历史最佳时间</span>
                      <span>差值</span>
                    </>
                  )}
                </div>
                {rows.map((row) => (
                  <div className={`${viewMode === "列表2" ? "split-row split-row-simple" : "split-row"} ${row.isCurrent ? "current" : ""}`.trim()} key={`${row.node.id}-${row.index}`}>
                    <span>{row.node.name}</span>
                    <strong>{row.durationMs === null ? "--" : formatDuration(row.durationMs)}</strong>
                    {viewMode === "展开" && (
                      <>
                        <strong>{row.bestMs === null ? "--" : formatDuration(row.bestMs)}</strong>
                        <em className={row.diff === null ? "diff muted" : row.diff <= 0 ? "diff good" : "diff bad"}>
                          {row.diff === null ? "--" : formatDiff(row.diff)}
                        </em>
                      </>
                    )}
                  </div>
                ))}
                <div className={viewMode === "列表2" ? "split-row split-row-simple total-row" : "split-row total-row"}>
                  <span>总用时</span>
                  <strong>{formatDuration(totalElapsedMs, true)}</strong>
                  {viewMode === "展开" && (
                    <>
                      <strong>{bestSegments ? formatDuration(bestSegments.totalMs, true) : "--"}</strong>
                      <em className={bestSegments ? (totalElapsedMs - bestSegments.totalMs <= 0 ? "diff good" : "diff bad") : "diff muted"}>
                        {bestSegments ? formatDiff(totalElapsedMs - bestSegments.totalMs) : "--"}
                      </em>
                    </>
                  )}
                </div>
              </section>
            )}
          </>
        )}
        {confirmLayer}

        {viewMode === "历史" && (
          <section className="history-view no-drag">
            <div className="toolbar">
              <IconButton label="返回迷你" onClick={() => setViewMode("迷你")}>
                <ChevronLeft />
              </IconButton>
              <IconButton label="返回展开" onClick={() => setViewMode("展开")}>
                <Maximize2 />
              </IconButton>
              <IconButton className="settings-action-button save" label="保存本次" onClick={saveCurrentRun} disabled={!activeRun || activeRun.status === "已完成"}>
                <Save />
              </IconButton>
              <IconButton className="settings-action-button danger" label="删除历史记录" onClick={() => requestDeleteHistoryRecord(selectedHistory?.id)} disabled={!selectedHistory || selectedHistory.id === "best-history"}>
                <Trash2 />
              </IconButton>
            </div>
            {historyMessage && <p className="settings-note strong-note">{historyMessage}</p>}

            <div className="history-layout">
              <div className="history-list">
                {historyItems.length === 0 && <p className="empty">还没有历史成绩。跑完全程后会自动保存。</p>}
                {historyItems.map((run) => (
                  <article
                    className={`${run.id === "best-history" ? "history-item best" : "history-item"} ${selectedHistory?.id === run.id ? "selected" : ""}`}
                    key={run.id}
                    onClick={() => setSelectedHistoryId(run.id)}
                    role="button"
                    tabIndex={0}
                  >
                    <div>
                      <strong>{getHistoryTitle(run)}</strong>
                      <span>{getHistorySubtitle(run)}</span>
                    </div>
                    <b>{formatDuration(run.totalMs, true)}</b>
                  </article>
                ))}
              </div>

              <div className="history-detail">
                <div className="section-title">{selectedHistory?.id === "best-history" ? "历史最佳记录" : "具体数据"}</div>
                {!selectedHistory && <p className="empty">请选择一条历史记录。</p>}
                {selectedHistory?.splits.map((split) => (
                  <div className="detail-row" key={`${selectedHistory.id}-${split.index}`}>
                    <span>{split.name}</span>
                    <strong>{formatDuration(split.durationMs)}</strong>
                  </div>
                ))}
                {selectedHistory && (
                  <div className="detail-row total">
                    <span>总用时</span>
                    <strong>{formatDuration(selectedHistory.totalMs, true)}</strong>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}
      </section>
    </main>
  );
}
