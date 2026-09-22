// suppressed global ResizeObserver error handler
console.log("%c[PLBT] build tag: v2-live-candle-fix (state.js)", "color:#10b981;font-weight:bold;font-size:14px");
window.addEventListener("error", (e) => {
  if (e.message && (e.message.includes("ResizeObserver") || e.message.includes("resize observer"))) {
    e.stopImmediatePropagation();
    e.preventDefault();
  }
});

// Sound system
const sounds = {
  open: new Audio('https://assets.mixkit.co/active_storage/sfx/2568/2568-preview.mp3'),
  close: new Audio('https://assets.mixkit.co/active_storage/sfx/2570/2570-preview.mp3'),
  win: new Audio('https://assets.mixkit.co/active_storage/sfx/2000/2000-preview.mp3'),
  loss: new Audio('https://assets.mixkit.co/active_storage/sfx/3148/3148-preview.mp3')
};

export function playSound(type) {
  if (!isSoundEnabled) return;
  if (sounds[type]) {
    sounds[type].play().catch((e) => console.log("Sound error:", e));
  }
}

// App Settings & Live States
export let balance = parseFloat(localStorage.getItem("balance")) || 10000.0;
export function setBalance(val) {
  balance = val;
  localStorage.setItem("balance", balance.toString());
}

export let tradeHistory = [];
export function setTradeHistory(val) {
  tradeHistory = val;
  localStorage.setItem("plbt_trade_history", JSON.stringify(tradeHistory));
}

export let selectedHistoryDateStr = null;
export function setSelectedHistoryDateStr(val) { selectedHistoryDateStr = val; }

export let selectedHistoryTrades = [];
export function setSelectedHistoryTrades(val) { selectedHistoryTrades = val; }

export let hoveredHistTradeId = null;
export function setHoveredHistTradeId(val) { hoveredHistTradeId = val; }

export let activeOrders = [];
export let openPositions = [];
export let pendingOrder = null;
export let isDraftMode = false;
export function setIsDraftMode(val) { isDraftMode = val; }

export let activePartialCloseId = null;
export let hoveredElement = null;
export function setHoveredElement(val) { hoveredElement = val; }

export let draggedElement = null;
export function setDraggedElement(val) { draggedElement = val; }

export let activeDragInfo = null;
export function setActiveDragInfo(val) { activeDragInfo = val; }

export let hoveredObject = null;
export function setHoveredObject(val) { hoveredObject = val; }

export let activeSelectedObject = null;
export function setActiveSelectedObject(val) { activeSelectedObject = val; }

export let activeTool = "cursor";
export function setActiveToolState(val) { activeTool = val; }

export let drawings = { brushPaths: [], positions: [], horizontalLines: [], lines: [], rectangles: [] };
export function setDrawings(val) {
  drawings = val;
  localStorage.setItem("drawings", JSON.stringify(drawings));
}

export let activeColor = localStorage.getItem("drawing_color") || "#3b82f6";
export function setActiveColor(val) {
  activeColor = val;
  localStorage.setItem("drawing_color", val);
}

export let isDrawingBrush = false;
export function setIsDrawingBrush(val) { isDrawingBrush = val; }

export let currentBrushPath = null;
export function setCurrentBrushPath(val) { currentBrushPath = val; }

export let isDrawingLineOrRect = false;
export function setIsDrawingLineOrRect(val) { isDrawingLineOrRect = val; }

export let tempDrawing = null;
export function setTempDrawing(val) { tempDrawing = val; }

export let activeDrag = null;
export function setActiveDrag(val) { activeDrag = val; }

export let undoStack = [];
export let redoStack = [];
export function clearRedoStack() { redoStack = []; }

export let isSoundEnabled = localStorage.getItem("is_sound_enabled") !== "false";
export function setIsSoundEnabled(val) {
  isSoundEnabled = val;
  localStorage.setItem("is_sound_enabled", val);
}

export let isAnalyticsActive = false;
export function setIsAnalyticsActive(val) { isAnalyticsActive = val; }

export let heatmapCurrentDate = new Date();
export let currentNotesTradeId = null;
export function setCurrentNotesTradeId(val) { currentNotesTradeId = val; }

export let currentScreenshotBase64 = "";
export let currentScreenshots = [];
export function setCurrentScreenshots(val) { currentScreenshots = val; }

export let state = {
  currentProvider: "twelvedata",
  symbol: "EUR_USD",
  timeframe: "15m",
  leverage: 100,
  volume: 1.0,
  commissionPerLot: 2.0,
  positions: [],
  historicalCandles: [],
  isBacktestActive: false,
  backtestVisibleCandles: [],
  backtestFutureCandles: [],
  backtestInitialIdx: null,
  currentReplayIndex: null,
  selectedTradeId: null,
  orderPreviewDirection: "buy",
  isTradeModeActive: false,
};

export const TWELVE_DATA_KEYS = [
  "7916964ef5f64bca8dbb0a23ea8971f1",
  "79d0abcbbf8c4d21b3699ff878a48ef2",
  "d153ef6905584bc5b19e9185a676bfa2",
  "453be9f627ba49f2b8f870fa1c7be491",
  "f26a7cb8fa1440eb8cf931ca8b86d9a0",
];

export const TIMEFRAME_MAPPING = {
  "1m": "1min", "3m": "5min", "5m": "5min", "10m": "15min", "15m": "15min",
  "30m": "30min", "1h": "1h", "2h": "2h", "4h": "4h", "8h": "4h", "10h": "4h",
  "1d": "1day", "2d": "1day", "4d": "1day", "8d": "1day", "10d": "1day"
};

export function updateConnectionStatus(status, type = "demo") {
  const statusDot = document.getElementById("status-dot");
  const statusText = document.getElementById("status-text");
  if (!statusDot || !statusText) return;
  if (type === "active") {
    statusDot.className = "status-dot active";
  } else if (type === "demo") {
    statusDot.className = "status-dot demo";
  } else {
    statusDot.className = "status-dot";
  }
  statusText.textContent = status;
  
  const systemStatus = document.getElementById("system-status");
  if (systemStatus) {
    systemStatus.textContent = status === "ONLINE (MT5)" ? "Подключено к MT5" : status;
  }
}

export function showToast(message, type = "success") {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const t = document.createElement("div");
  t.className = "toast toast-" + type;
  t.style.cssText =
    "pointer-events:none; min-width:280px; max-width:360px; padding:12px 16px; border-radius:6px; font-size:12px; font-weight:500; line-height:1.4; box-shadow:0 10px 30px rgba(0,0,0,0.5); display:flex; align-items:center; gap:10px; transition:all 0.4s ease;";

  if (type === "success") {
    t.style.backgroundColor = "#131e24";
    t.style.border = "1px solid #26a69a";
    t.style.color = "#4db6ac";
  } else if (type === "error") {
    t.style.backgroundColor = "#1a141a";
    t.style.border = "1px solid #ef5350";
    t.style.color = "#e57373";
  } else {
    t.style.backgroundColor = "#1c1b12";
    t.style.border = "1px solid #ff9800";
    t.style.color = "#ffb74d";
  }

  const icon = document.createElement("span");
  icon.style.cssText = "font-weight:bold; font-size:14px;";
  icon.textContent = type === "success" ? "✓" : type === "error" ? "✕" : "⚠";
  t.appendChild(icon);

  const txt = document.createElement("div");
  txt.textContent = message;
  t.appendChild(txt);
  container.appendChild(t);

  setTimeout(() => {
    t.style.opacity = "0";
    setTimeout(() => t.remove(), 400);
  }, 4000);
}
window.showToast = showToast;
