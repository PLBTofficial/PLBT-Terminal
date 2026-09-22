import { initDB, saveData, getData, clearDB, deleteData, saveVoiceNote, getAllVoiceNotes, deleteVoiceNoteFromDB, saveTradeThoughts, getTradeThoughts } from "./server/db.js";
import { SCHEMA_VERSION, runMigrations } from "./migrations.js";
import { initBanSystem } from "./ban.js";
import {
  CFTC_MARKETS,
  getCOTMarketForSymbol,
  getCOTDataForMarket,
  formatCOTSeriesData,
  generateCOTHistoricalData,
  fetchRealCFTCData,
  exportAllCOTDataToJSON,
  importCOTDataFromJSON,
  setCOTOfflineMode,
  isCOTOffline,
  getCOTOfflineInfo,
  cotSyncEngine,
  getNewYorkTime,
  checkCFTCNewReportAvailable,
  clearCOTFormatCache
} from "./cotData.js";

// Глобальный перехватчик ошибок ResizeObserver
window.addEventListener("error", (e) => {
  if (
    e.message &&
    (e.message.includes("ResizeObserver") ||
      e.message.includes("resize observer"))
  ) {
    e.stopImmediatePropagation();
    e.preventDefault();
  }
});

// Система динамических звуковых уведомлений
let isSoundEnabled = localStorage.getItem("is_sound_enabled") !== "false";
let isNotificationsEnabled = localStorage.getItem("is_notifications_enabled") !== "false";

// --- Telemetry & Performance Monitoring Helper ---
let __rafCallCount = 0;
let __rafRatePerSecond = 0;
let __lastRafMeasureTime = typeof performance !== "undefined" ? performance.now() : Date.now();

if (typeof window !== "undefined" && window.requestAnimationFrame) {
  const _origRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    __rafCallCount++;
    return _origRAF(cb);
  };

  setInterval(() => {
    const now = performance.now();
    const dt = (now - __lastRafMeasureTime) / 1000;
    if (dt >= 1) {
      __rafRatePerSecond = Math.round(__rafCallCount / dt);
      __rafCallCount = 0;
      __lastRafMeasureTime = now;
    }
  }, 1000);

  window.getPerformanceReport = function () {
    const drawingCount = typeof drawings !== "undefined"
      ? Object.values(drawings).reduce((acc, arr) => acc + (Array.isArray(arr) ? arr.length : 0), 0)
      : 0;
    return {
      rafCallsPerSecond: __rafRatePerSecond,
      isBacktestActive: Boolean(state?.isBacktestActive),
      isAutoplayRunning: Boolean(typeof isAutoplayRunning !== "undefined" && isAutoplayRunning),
      isCOTActive: Boolean(typeof cotChartState !== "undefined" && cotChartState.active),
      totalDrawings: drawingCount,
      timestamp: new Date().toISOString()
    };
  };
  window.__getPerformanceDiagnostics = window.getPerformanceReport;
}

const sounds = {
  open: new Audio('https://assets.mixkit.co/active_storage/sfx/2568/2568-preview.mp3'), // Техничный звук старта
  close: new Audio('https://assets.mixkit.co/active_storage/sfx/2570/2570-preview.mp3'), // Нейтральный клик
  win: new Audio('https://assets.mixkit.co/active_storage/sfx/2000/2000-preview.mp3'), // Радостный звук (ТП)
  loss: new Audio('https://assets.mixkit.co/active_storage/sfx/3148/3148-preview.mp3') // Грустный звук (СЛ)
};

function playSound(type) {
  if (typeof isSoundEnabled !== "undefined" && !isSoundEnabled) return;
  if (sounds && sounds[type]) {
    sounds[type].play().catch((e) => console.log("Sound error:", e));
  }
}

// Ротация API ключей для Twelve Data
const TWELVE_DATA_KEYS = [
  "7916964ef5f64bca8dbb0a23ea8971f1",
  "79d0abcbbf8c4d21b3699ff878a48ef2",
  "d153ef6905584bc5b19e9185a676bfa2",
  "453be9f627ba49f2b8f870fa1c7be491",
  "f26a7cb8fa1440eb8cf931ca8b86d9a0",
];

let balance = parseFloat(localStorage.getItem("balance")) || 10000.0;
let tradeHistory = [];
let expandedTradeIds = new Set();

// Prop Firm & Personal Accounts System
let accounts = [];
let activeAccountId = null;
let currentAccountCategoryFilter = "ALL"; // "ALL" | "PERSONAL" | "PROP"
let currentAccountSpecificFilter = "ALL"; // "ALL" or specific account.id
let currentAccountModalTab = "ALL"; // "ALL" | "PERSONAL" | "PROP"

const DEFAULT_TAGS = [
  { id: "tag-fomo", name: "FOMO", color: "#ff4d4d" },
  { id: "tag-tilt", name: "Тильт", color: "#9933ff" },
  { id: "tag-overtrading", name: "Овертрейдинг", color: "#ff9933" },
  { id: "tag-risk", name: "Игнор риска", color: "#ffcc00" },
  { id: "tag-early-exit", name: "Ранний выход", color: "#33ccff" }
];
const PRESET_COLORS = [
  "#ff4d4d", // Coral Red
  "#9933ff", // Purple
  "#ff9933", // Orange
  "#eab308", // Golden Yellow
  "#33ccff", // Sky Blue
  "#10b981", // Emerald Green
  "#ec4899", // Deep Pink
  "#f43f5e", // Rose Red
  "#8b5cf6", // Violet
  "#06b6d4", // Cyan
  "#f97316", // Tangerine Orange
  "#059669", // Forest Green
  "#3b82f6", // Royal Blue
  "#14b8a6", // Dark Teal
  "#a855f7", // Lavender Purple
  "#6366f1", // Indigo
  "#475569", // Cool Slate
  "#db2777", // Dark Pink
  "#d97706"  // Dark Amber
];
let customTags = [];
try {
  const savedTags = localStorage.getItem("plbt_custom_tags");
  if (savedTags) {
    customTags = JSON.parse(savedTags);
  } else {
    customTags = [...DEFAULT_TAGS];
    localStorage.setItem("plbt_custom_tags", JSON.stringify(customTags));
  }
} catch (e) {
  customTags = [...DEFAULT_TAGS];
}

let activeTagsDropdown = null;

function renderTradeRowTags(trade, container) {
  if (!container) return;
  container.innerHTML = "";
  
  const assignedTagIds = trade.tags || [];
  
  assignedTagIds.forEach(tagId => {
    const tag = customTags.find(t => t.id === tagId);
    if (tag) {
      const pill = document.createElement("span");
      pill.style.fontSize = "9px";
      pill.style.fontWeight = "600";
      pill.style.padding = "2px 6px";
      pill.style.borderRadius = "4px";
      pill.style.background = `${tag.color}22`;
      pill.style.color = tag.color;
      pill.style.border = `1px solid ${tag.color}44`;
      pill.style.textTransform = "uppercase";
      pill.style.letterSpacing = "0.03em";
      pill.style.lineHeight = "1";
      pill.textContent = tag.name;
      container.appendChild(pill);
    }
  });

  const addBtn = document.createElement("button");
  addBtn.className = "add-tag-trigger-btn";
  addBtn.style.display = "inline-flex";
  addBtn.style.alignItems = "center";
  addBtn.style.justifyContent = "center";
  addBtn.style.width = "18px";
  addBtn.style.height = "18px";
  addBtn.style.borderRadius = "50%";
  addBtn.style.background = "rgba(255,255,255,0.05)";
  addBtn.style.border = "1px solid rgba(255,255,255,0.1)";
  addBtn.style.color = "var(--text-muted)";
  addBtn.style.cursor = "pointer";
  addBtn.style.fontSize = "12px";
  addBtn.style.fontWeight = "bold";
  addBtn.style.transition = "all 0.2s";
  addBtn.style.padding = "0";
  addBtn.style.lineHeight = "1";
  addBtn.style.outline = "none";
  addBtn.textContent = "+";
  addBtn.title = "Добавить/изменить теги";

  addBtn.addEventListener("mouseover", () => {
    addBtn.style.background = "rgba(255,255,255,0.15)";
    addBtn.style.color = "#fff";
  });
  addBtn.addEventListener("mouseout", () => {
    addBtn.style.background = "rgba(255,255,255,0.05)";
    addBtn.style.color = "var(--text-muted)";
  });

  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openTagsDropdown(trade, addBtn, container);
  });

  container.appendChild(addBtn);
}

window.deleteTagGlobally = function(tagId, event, trade, refreshDropdownFn) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  
  if (confirm("Вы действительно хотите удалить этот тип тега насовсем?")) {
    customTags = customTags.filter(t => t.id !== tagId);
    localStorage.setItem("plbt_custom_tags", JSON.stringify(customTags));

    tradeHistory.forEach(t => {
      if (t.tags) {
        t.tags = t.tags.filter(tid => tid !== tagId);
      }
    });
    localStorage.setItem("plbt_trade_history", JSON.stringify(tradeHistory));

    if (typeof syncCurrentScenarioState === "function") {
      syncCurrentScenarioState(false);
    }

    if (typeof updateTradeHistoryUI === "function") {
      updateTradeHistoryUI();
    }
    
    if (typeof refreshDropdownFn === "function") {
      refreshDropdownFn();
    }
  }
};

function openTagsDropdown(trade, triggerBtn, rowTagsContainer) {
  if (activeTagsDropdown) {
    activeTagsDropdown.remove();
    activeTagsDropdown = null;
  }
  
  if (window.closeTagsDropdownHandler) {
    document.removeEventListener("click", window.closeTagsDropdownHandler);
    window.closeTagsDropdownHandler = null;
  }

  const dropdown = document.createElement("div");
  dropdown.className = "custom-tags-dropdown";
  dropdown.style.position = "absolute";
  dropdown.style.zIndex = "1000";
  dropdown.style.width = "250px";
  dropdown.style.background = "#1e222d";
  dropdown.style.border = "1px solid rgba(255,255,255,0.12)";
  dropdown.style.borderRadius = "8px";
  dropdown.style.boxShadow = "0 10px 25px -5px rgba(0,0,0,0.5), 0 8px 10px -6px rgba(0,0,0,0.5)";
  dropdown.style.padding = "10px";
  dropdown.style.display = "flex";
  dropdown.style.flexDirection = "column";
  dropdown.style.gap = "8px";
  dropdown.style.fontFamily = "var(--font-sans)";

  const rect = triggerBtn.getBoundingClientRect();
  
  let top = rect.bottom + window.scrollY + 6;
  let left = rect.left + window.scrollX;
  
  if (rect.left + 250 > window.innerWidth) {
    left = rect.right + window.scrollX - 250;
  }
  if (rect.bottom + 280 > window.innerHeight) {
    top = rect.top + window.scrollY - 280 - 6;
  }
  if (top < window.scrollY) top = window.scrollY + 10;
  if (left < window.scrollX) left = window.scrollX + 10;
  
  dropdown.style.top = `${top}px`;
  dropdown.style.left = `${left}px`;

  dropdown.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  function renderDropdownContent() {
    dropdown.innerHTML = "";

    // Header row with title and close button
    const headerRow = document.createElement("div");
    headerRow.style.display = "flex";
    headerRow.style.justifyContent = "space-between";
    headerRow.style.alignItems = "center";
    headerRow.style.width = "100%";
    headerRow.style.marginBottom = "4px";
    headerRow.style.boxSizing = "border-box";

    const title = document.createElement("div");
    title.style.fontSize = "11px";
    title.style.fontWeight = "700";
    title.style.color = "var(--text-muted)";
    title.style.textTransform = "uppercase";
    title.style.letterSpacing = "0.05em";
    title.textContent = "Выберите теги";
    headerRow.appendChild(title);

    const closeBtn = document.createElement("button");
    closeBtn.innerHTML = "&times;";
    closeBtn.title = "Закрыть";
    closeBtn.style.background = "none";
    closeBtn.style.border = "none";
    closeBtn.style.color = "var(--text-muted)";
    closeBtn.style.cursor = "pointer";
    closeBtn.style.fontSize = "16px";
    closeBtn.style.fontWeight = "bold";
    closeBtn.style.padding = "2px 6px";
    closeBtn.style.lineHeight = "1";
    closeBtn.style.transition = "color 0.15s";
    closeBtn.style.outline = "none";

    closeBtn.addEventListener("mouseover", () => {
      closeBtn.style.color = "#ffffff";
    });
    closeBtn.addEventListener("mouseout", () => {
      closeBtn.style.color = "var(--text-muted)";
    });

    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      dropdown.remove();
      if (activeTagsDropdown === dropdown) {
        activeTagsDropdown = null;
      }
      if (window.closeTagsDropdownHandler) {
        document.removeEventListener("click", window.closeTagsDropdownHandler);
        window.closeTagsDropdownHandler = null;
      }
    });

    headerRow.appendChild(closeBtn);
    dropdown.appendChild(headerRow);

    const listContainer = document.createElement("div");
    listContainer.style.display = "flex";
    listContainer.style.flexDirection = "column";
    listContainer.style.gap = "6px";
    listContainer.style.maxHeight = "160px";
    listContainer.style.overflowY = "auto";
    listContainer.style.paddingRight = "16px";
    listContainer.style.boxSizing = "border-box";
    
    const assignedTagIds = trade.tags || [];

    customTags.forEach(tag => {
      const itemRow = document.createElement("div");
      itemRow.style.display = "flex";
      itemRow.style.justifyContent = "space-between";
      itemRow.style.alignItems = "center";
      itemRow.style.width = "100%";
      itemRow.style.boxSizing = "border-box";

      const leftZone = document.createElement("div");
      leftZone.style.flex = "0 0 80%";
      leftZone.style.maxWidth = "80%";
      leftZone.style.display = "flex";
      leftZone.style.alignItems = "center";
      leftZone.style.gap = "8px";
      leftZone.style.padding = "5px 10px";
      leftZone.style.borderRadius = "4px";
      leftZone.style.cursor = "pointer";
      leftZone.style.transition = "all 0.15s";
      leftZone.style.fontSize = "11px";
      leftZone.style.fontWeight = "600";
      leftZone.style.boxSizing = "border-box";
      leftZone.style.overflow = "hidden";
      leftZone.style.textOverflow = "ellipsis";
      leftZone.style.whiteSpace = "nowrap";

      const isAssigned = assignedTagIds.includes(tag.id);
      
      if (isAssigned) {
        leftZone.style.background = tag.color;
        leftZone.style.color = "#ffffff";
        leftZone.style.border = `1px solid ${tag.color}`;
      } else {
        leftZone.style.background = `${tag.color}15`;
        leftZone.style.color = tag.color;
        leftZone.style.border = `1px solid ${tag.color}35`;
      }

      const dot = document.createElement("div");
      dot.style.width = "6px";
      dot.style.height = "6px";
      dot.style.borderRadius = "50%";
      dot.style.background = isAssigned ? "#ffffff" : tag.color;
      dot.style.flexShrink = "0";
      leftZone.appendChild(dot);

      const nameSpan = document.createElement("span");
      nameSpan.textContent = tag.name;
      nameSpan.style.overflow = "hidden";
      nameSpan.style.textOverflow = "ellipsis";
      leftZone.appendChild(nameSpan);

      leftZone.addEventListener("mouseover", () => {
        if (isAssigned) {
          leftZone.style.opacity = "0.85";
        } else {
          leftZone.style.background = `${tag.color}35`;
          leftZone.style.border = `1px solid ${tag.color}65`;
        }
      });
      leftZone.addEventListener("mouseout", () => {
        leftZone.style.opacity = "1";
        if (isAssigned) {
          leftZone.style.background = tag.color;
          leftZone.style.border = `1px solid ${tag.color}`;
        } else {
          leftZone.style.background = `${tag.color}15`;
          leftZone.style.border = `1px solid ${tag.color}35`;
        }
      });

      leftZone.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const idx = assignedTagIds.indexOf(tag.id);
        if (idx === -1) {
          assignedTagIds.push(tag.id);
        } else {
          assignedTagIds.splice(idx, 1);
        }
        trade.tags = assignedTagIds;
        localStorage.setItem("plbt_trade_history", JSON.stringify(tradeHistory));
        
        if (typeof syncCurrentScenarioState === "function") {
          syncCurrentScenarioState(false);
        }

        renderTradeRowTags(trade, rowTagsContainer);
        renderDropdownContent();
      });

      itemRow.appendChild(leftZone);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "delete-tag-btn";
      deleteBtn.setAttribute("data-tag-id", tag.id);
      deleteBtn.innerHTML = "✕";
      deleteBtn.title = "Удалить тег навсегда";
      deleteBtn.style.marginLeft = "15px";
      deleteBtn.style.color = "rgba(239, 68, 68, 0.6)";
      deleteBtn.style.background = "none";
      deleteBtn.style.border = "none";
      deleteBtn.style.cursor = "pointer";
      deleteBtn.style.fontSize = "13px";
      deleteBtn.style.fontWeight = "bold";
      deleteBtn.style.padding = "4px 8px";
      deleteBtn.style.borderRadius = "4px";
      deleteBtn.style.display = "inline-flex";
      deleteBtn.style.alignItems = "center";
      deleteBtn.style.justifyContent = "center";
      deleteBtn.style.transition = "all 0.15s";
      deleteBtn.style.outline = "none";
      deleteBtn.style.position = "relative";
      deleteBtn.style.zIndex = "10";
      deleteBtn.style.pointerEvents = "auto";

      deleteBtn.addEventListener("mouseover", () => {
        deleteBtn.style.color = "#f87171";
        deleteBtn.style.background = "rgba(239, 68, 68, 0.1)";
      });
      deleteBtn.addEventListener("mouseout", () => {
        deleteBtn.style.color = "rgba(239, 68, 68, 0.6)";
        deleteBtn.style.background = "none";
      });

      itemRow.appendChild(deleteBtn);
      listContainer.appendChild(itemRow);
    });

    listContainer.addEventListener("mousedown", (e) => {
      const deleteBtn = e.target.closest(".delete-tag-btn");
      if (deleteBtn) {
        e.preventDefault();
        e.stopPropagation();
        const tagId = deleteBtn.getAttribute("data-tag-id");
        if (tagId) {
          window.deleteTagGlobally(tagId, e, trade, renderDropdownContent);
        }
      }
    });

    if (customTags.length === 0) {
      const emptyMsg = document.createElement("div");
      emptyMsg.style.fontSize = "11px";
      emptyMsg.style.color = "var(--text-muted)";
      emptyMsg.style.textAlign = "center";
      emptyMsg.style.padding = "10px 0";
      emptyMsg.textContent = "Нет созданных тегов";
      listContainer.appendChild(emptyMsg);
    }

    dropdown.appendChild(listContainer);

    const hr = document.createElement("div");
    hr.style.height = "1px";
    hr.style.background = "rgba(255,255,255,0.08)";
    hr.style.margin = "4px 0";
    dropdown.appendChild(hr);

    const inputRow = document.createElement("div");
    inputRow.style.display = "flex";
    inputRow.style.gap = "6px";
    inputRow.style.alignItems = "center";
    inputRow.style.width = "100%";
    inputRow.style.boxSizing = "border-box";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Новый тег...";
    input.style.flex = "1";
    input.style.minWidth = "0";
    input.style.background = "rgba(0,0,0,0.2)";
    input.style.border = "1px solid rgba(255,255,255,0.1)";
    input.style.borderRadius = "4px";
    input.style.padding = "4px 8px";
    input.style.color = "#ffffff";
    input.style.fontSize = "11px";
    input.style.outline = "none";
    input.style.height = "24px";
    input.style.boxSizing = "border-box";

    input.addEventListener("focus", () => {
      input.style.borderColor = "var(--color-accent)";
    });
    input.addEventListener("blur", () => {
      input.style.borderColor = "rgba(255,255,255,0.1)";
    });

    const addBtn = document.createElement("button");
    addBtn.textContent = "Добавить";
    addBtn.style.background = "var(--color-accent)";
    addBtn.style.color = "#ffffff";
    addBtn.style.border = "none";
    addBtn.style.borderRadius = "4px";
    addBtn.style.padding = "0 8px";
    addBtn.style.fontSize = "11px";
    addBtn.style.fontWeight = "600";
    addBtn.style.cursor = "pointer";
    addBtn.style.height = "24px";
    addBtn.style.whiteSpace = "nowrap";
    addBtn.style.boxSizing = "border-box";
    addBtn.style.outline = "none";
    addBtn.style.transition = "opacity 0.15s";

    addBtn.addEventListener("mouseover", () => {
      addBtn.style.opacity = "0.9";
    });
    addBtn.addEventListener("mouseout", () => {
      addBtn.style.opacity = "1";
    });

    function handleCreateTag() {
      const val = input.value.trim();
      if (!val) return;
      
      const exists = customTags.some(t => t.name.toLowerCase() === val.toLowerCase());
      if (exists) {
        alert("Тег с таким названием уже существует!");
        return;
      }

      const usedColors = customTags.map(t => t.color.toLowerCase());
      const availableColors = PRESET_COLORS.filter(c => !usedColors.includes(c.toLowerCase()));
      
      let randColor;
      if (availableColors.length > 0) {
        randColor = availableColors[Math.floor(Math.random() * availableColors.length)];
      } else {
        randColor = PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)];
      }
      
      const newTag = {
        id: "tag-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
        name: val,
        color: randColor
      };

      customTags.push(newTag);
      localStorage.setItem("plbt_custom_tags", JSON.stringify(customTags));

      input.value = "";
      renderDropdownContent();
    }

    addBtn.addEventListener("click", handleCreateTag);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleCreateTag();
      }
    });

    inputRow.appendChild(input);
    inputRow.appendChild(addBtn);
    dropdown.appendChild(inputRow);
  }

  renderDropdownContent();
  document.body.appendChild(dropdown);
  activeTagsDropdown = dropdown;

  window.closeTagsDropdownHandler = (e) => {
    if (e.target && !document.body.contains(e.target)) {
      return;
    }
    if (activeTagsDropdown && !activeTagsDropdown.contains(e.target) && !triggerBtn.contains(e.target)) {
      activeTagsDropdown.remove();
      activeTagsDropdown = null;
      document.removeEventListener("click", window.closeTagsDropdownHandler);
      window.closeTagsDropdownHandler = null;
    }
  };

  setTimeout(() => {
    document.addEventListener("click", window.closeTagsDropdownHandler);
  }, 0);
}
let selectedHistoryDateStr = null;
let selectedHistoryTrades = [];
let hoveredHistTradeId = null;
let activeOrders = [];
let openPositions = [];
let pendingOrder = null;
let isDraftMode = false;
let activePartialCloseId = null;
let hoveredElement = null;
let draggedElement = null;
let activeDragInfo = null;
let canvasCurrentCandle = null;

function getSymbolDecimals(symbol) {
  const s = symbol || "";
  if (s.endsWith("_JPY") || s.includes("JPY")) {
    return 3;
  }
  if (s.includes("XAU") || s.startsWith("XAU")) {
    return 2;
  }
  return 5;
}
window.getSymbolDecimals = getSymbolDecimals;

function getSymbolMinMove(symbol) {
  const decimals = getSymbolDecimals(symbol);
  if (decimals === 2) return 0.01;
  if (decimals === 3) return 0.001;
  return 0.00001;
}
window.getSymbolMinMove = getSymbolMinMove;

function getSymbolPipSize(symbol) {
  const pointSize = getSymbolMinMove(symbol);
  return pointSize * 10;
}
window.getSymbolPipSize = getSymbolPipSize;

function formatPips(pipsValue) {
  if (typeof pipsValue !== "number" || isNaN(pipsValue)) return "0";
  const str = pipsValue.toFixed(1);
  return str.endsWith(".0") ? str.slice(0, -2) : str;
}
window.formatPips = formatPips;

function getSymbolInitialPrice(symbol) {
  const s = symbol || "";
  if (s === "EUR_USD") return 1.085;
  if (s === "GBP_USD") return 1.268;
  if (s === "USD_JPY") return 154.2;
  if (s === "GBP_JPY") return 204.5;
  if (s === "XAU_USD") return 2350.0;
  
  if (s.endsWith("_JPY") || s.includes("JPY")) return 160.0;
  if (s.includes("XAU") || s.startsWith("XAU")) return 2300.0;
  return 1.10;
}
window.getSymbolInitialPrice = getSymbolInitialPrice;

function getSymbolVolatility(symbol) {
  const s = symbol || "";
  if (s.endsWith("_JPY") || s.includes("JPY")) return 0.001;
  if (s.includes("XAU") || s.startsWith("XAU")) return 0.0015;
  return 0.00015;
}
window.getSymbolVolatility = getSymbolVolatility;

function updateHeaderPairDisplay(symbol) {
  const formatted = (symbol || "EUR_USD").replace("_", " / ");
  const headerPair = document.getElementById("header-pair");
  if (headerPair) {
    headerPair.textContent = formatted;
  }
  const fSymbol = document.getElementById("floating-trade-symbol");
  if (fSymbol) {
    fSymbol.textContent = (symbol || "EUR_USD").replace("_", "/");
  }
  const curPairDisp = document.getElementById("current-pair-display");
  if (curPairDisp) {
    curPairDisp.textContent = (symbol || "EUR_USD").replace("_", "/");
  }
}
window.updateHeaderPairDisplay = updateHeaderPairDisplay;

function updateChartPrecision(symbol) {
  if (typeof candlestickSeries !== "undefined" && candlestickSeries) {
    const decimals = getSymbolDecimals(symbol);
    const minMove = getSymbolMinMove(symbol);
    candlestickSeries.applyOptions({
      priceFormat: {
        type: "price",
        precision: decimals,
        minMove: minMove,
      },
    });
    console.log(`Updated chart precision for ${symbol} to ${decimals} decimals (minMove: ${minMove})`);
  }
}
window.updateChartPrecision = updateChartPrecision;

let state = {
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
  currentReplayTimestamp: null,
  baseTimeframeCache: [],
  backtestBaseCandles: null,
  selectedTradeId: null,
  orderPreviewDirection: "buy",
  isTradeModeActive: false,
  backtestData: [],
  lastRenderedCandlesArray: null,
  lastIndicator: null,
};

// Стек для Undo/Redo действий
let undoStack = [];
let redoStack = [];

function saveState() {
  const historyObj = {
    drawings: JSON.parse(JSON.stringify(drawings)),
    positions: JSON.parse(JSON.stringify(state.positions)),
    orderPreviewPrice: state.orderPreviewPrice,
    orderPreviewTP: state.orderPreviewTP,
    orderPreviewSL: state.orderPreviewSL,
    orderPreviewTPEnabled: state.orderPreviewTPEnabled,
    orderPreviewSLEnabled: state.orderPreviewSLEnabled,
  };
  const serialized = JSON.stringify(historyObj);
  if (undoStack.length > 0 && undoStack[undoStack.length - 1] === serialized) {
    return; // Don't save duplicate states!
  }
  undoStack.push(serialized);
  if (undoStack.length > 50) {
    undoStack.shift();
  }
  redoStack = [];
  updateUndoRedoButtons();
}

function undo() {
  if (undoStack.length === 0) return;
  const currentHistoryState = {
    drawings: JSON.parse(JSON.stringify(drawings)),
    positions: JSON.parse(JSON.stringify(state.positions)),
    orderPreviewPrice: state.orderPreviewPrice,
    orderPreviewTP: state.orderPreviewTP,
    orderPreviewSL: state.orderPreviewSL,
    orderPreviewTPEnabled: state.orderPreviewTPEnabled,
    orderPreviewSLEnabled: state.orderPreviewSLEnabled,
  };
  redoStack.push(JSON.stringify(currentHistoryState));

  const previousState = JSON.parse(undoStack.pop());

  drawings = previousState.drawings;
  saveDrawings();

  state.positions = previousState.positions || [];
  state.orderPreviewPrice = previousState.orderPreviewPrice;
  state.orderPreviewTP = previousState.orderPreviewTP;
  state.orderPreviewSL = previousState.orderPreviewSL;
  state.orderPreviewTPEnabled = !!previousState.orderPreviewTPEnabled;
  state.orderPreviewSLEnabled = !!previousState.orderPreviewSLEnabled;

  saveSimulatorState();
  updateSimulatorUI();
  syncOrderPreviewInputs();

  drawAllOnCanvas();
  updateUndoRedoButtons();
  showToast("Действие отменено (Undo)", "info");
}

function redo() {
  if (redoStack.length === 0) return;
  const currentHistoryState = {
    drawings: JSON.parse(JSON.stringify(drawings)),
    positions: JSON.parse(JSON.stringify(state.positions)),
    orderPreviewPrice: state.orderPreviewPrice,
    orderPreviewTP: state.orderPreviewTP,
    orderPreviewSL: state.orderPreviewSL,
    orderPreviewTPEnabled: state.orderPreviewTPEnabled,
    orderPreviewSLEnabled: state.orderPreviewSLEnabled,
  };
  undoStack.push(JSON.stringify(currentHistoryState));

  const nextState = JSON.parse(redoStack.pop());

  drawings = nextState.drawings;
  saveDrawings();

  state.positions = nextState.positions || [];
  state.orderPreviewPrice = nextState.orderPreviewPrice;
  state.orderPreviewTP = nextState.orderPreviewTP;
  state.orderPreviewSL = nextState.orderPreviewSL;
  state.orderPreviewTPEnabled = !!nextState.orderPreviewTPEnabled;
  state.orderPreviewSLEnabled = !!nextState.orderPreviewSLEnabled;

  saveSimulatorState();
  updateSimulatorUI();
  syncOrderPreviewInputs();

  drawAllOnCanvas();
  updateUndoRedoButtons();
  showToast("Действие повторено (Redo)", "info");
}

function syncOrderPreviewInputs() {
  const priceInput = document.getElementById("order-price-input");
  if (priceInput) {
    priceInput.value =
      state.orderPreviewPrice && !isNaN(state.orderPreviewPrice)
        ? state.orderPreviewPrice.toFixed(5)
        : "";
  }
  const tpInput = document.getElementById("order-tp-input");
  if (tpInput) {
    tpInput.value =
      state.orderPreviewTPEnabled &&
      state.orderPreviewTP &&
      !isNaN(state.orderPreviewTP)
        ? state.orderPreviewTP.toFixed(5)
        : "";
  }
  const slInput = document.getElementById("order-sl-input");
  if (slInput) {
    slInput.value =
      state.orderPreviewSLEnabled &&
      state.orderPreviewSL &&
      !isNaN(state.orderPreviewSL)
        ? state.orderPreviewSL.toFixed(5)
        : "";
  }

  // Synchronize values to the floating inputs
  const fPrice = document.getElementById("floating-order-price");
  const fTp = document.getElementById("floating-order-tp");
  const fSl = document.getElementById("floating-order-sl");
  const fVol = document.getElementById("floating-order-volume");
  const fLev = document.getElementById("floating-order-leverage");

  if (fPrice && priceInput) fPrice.value = priceInput.value;
  if (fTp && tpInput) fTp.value = tpInput.value;
  if (fSl && slInput) fSl.value = slInput.value;
  if (fVol && volumeInput) fVol.value = volumeInput.value;
  if (fLev && leverageInput) fLev.value = leverageInput.value;
}

function updateUndoRedoButtons() {
  const btnUndo = document.getElementById("btn-undo");
  const btnRedo = document.getElementById("btn-redo");
  if (btnUndo) {
    btnUndo.disabled = undoStack.length === 0;
    btnUndo.style.opacity = undoStack.length === 0 ? "0.4" : "1";
    btnUndo.style.cursor = undoStack.length === 0 ? "not-allowed" : "pointer";
  }
  if (btnRedo) {
    btnRedo.disabled = redoStack.length === 0;
    btnRedo.style.opacity = redoStack.length === 0 ? "0.4" : "1";
    btnRedo.style.cursor = redoStack.length === 0 ? "not-allowed" : "pointer";
  }
}

const TIMEFRAME_MAPPING = {
  "1m": "1min",
  "5m": "5min",
  "15m": "15min",
  "30m": "30min",
  "1h": "1h",
  "4h": "4h",
  "1d": "1day",
  "1w": "1week",
  "1M": "1month",
  "12M": "1month",
};

const container = document.getElementById("chart-viewport");
const loadingOverlay = document.getElementById("loading-overlay");
const loadingStatus = document.getElementById("loading-status");
const banner = document.getElementById("notification-banner");
let bannerTimeoutId = null;

window.closeBanner = function () {
  if (banner) {
    if (bannerTimeoutId) {
      clearTimeout(bannerTimeoutId);
      bannerTimeoutId = null;
    }
    banner.style.opacity = "0";
    banner.style.transform = "translateX(-50%) translateY(-50px)";
    setTimeout(() => {
      banner.style.display = "none";
    }, 500);
  }
};

window.showBannerNotification = function (htmlContent, autoHideSeconds = 10, isCritical = false) {
  if (!banner) return;
  const contentStr = typeof htmlContent === "string" ? htmlContent.toLowerCase() : "";
  const isCrit = isCritical === true || 
    contentStr.includes("ошибка") || 
    contentStr.includes("error") || 
    contentStr.includes("could not copy") || 
    contentStr.includes("превышен лимит") || 
    contentStr.includes("остановлен") ||
    contentStr.includes("drawdown");

  if (typeof isNotificationsEnabled !== "undefined" && !isNotificationsEnabled && !isCrit) {
    return;
  }
  if (bannerTimeoutId) {
    clearTimeout(bannerTimeoutId);
    bannerTimeoutId = null;
  }
  const c = banner.querySelector(".banner-content div");
  if (c) {
    c.innerHTML = htmlContent;
  }
  banner.style.borderColor = "var(--border-color)";
  banner.style.color = "var(--text-primary)";
  const iconSvg = banner.querySelector(".banner-content svg");
  if (iconSvg) {
    iconSvg.style.color = "var(--color-warning)";
  }
  banner.style.display = "flex";
  banner.offsetHeight;
  banner.style.opacity = "1";
  banner.style.transform = "translateX(-50%) translateY(0)";
  if (autoHideSeconds > 0) {
    bannerTimeoutId = setTimeout(() => {
      window.closeBanner();
    }, autoHideSeconds * 1000);
  }
};

if (banner) {
  bannerTimeoutId = setTimeout(() => {
    window.closeBanner();
  }, 10000);
}

const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const headerLastPrice = document.getElementById("price-display");
const headerPair = document.getElementById("header-pair");
const dbLatency = document.getElementById("db-latency");
const footerBalance = document.getElementById("footer-balance");
const buyBtnPrice = document.getElementById("buy-btn-price");
const sellBtnPrice = document.getElementById("sell-btn-price");
const positionsList = document.getElementById("positions-list");
const tokenInput = document.getElementById("oanda-token");
const capitalInput = document.getElementById("capital-input");
const leverageInput = document.getElementById("leverage-input");
const volumeInput = document.getElementById("volume-input");
const pairSelector = document.getElementById("pair-selector");
const timeframeContainer = document.getElementById("timeframe-container");
const useProxyCheckbox = document.getElementById("use-proxy");
const depositInput = document.getElementById("deposit-input");
const depositBtn = document.getElementById("deposit-btn");
const tabDeposit = document.getElementById("tab-deposit");
const tabWithdraw = document.getElementById("tab-withdraw");
const balanceInputLabel = document.getElementById("balance-input-label");
let isDeposit = true;
const backtestToggleBtn = document.getElementById("backtest-toggle-btn");
const backtestPrevBtn = document.getElementById("backtest-prev-btn");
const backtestNextBtn = document.getElementById("backtest-next-btn");
const backtestAutoplayBtn = document.getElementById("backtest-autoplay-btn");
const backtestFastForwardBtn = document.getElementById("backtest-fast-forward-btn");
const autoplaySpeedSlider = document.getElementById("autoplay-speed-slider");
const autoplaySpeedInput = document.getElementById("autoplay-speed-input");
const autoplaySpeedContainer = document.getElementById(
  "autoplay-speed-container",
);

let replayDelay =
  parseFloat(autoplaySpeedSlider ? autoplaySpeedSlider.value : 1.0) * 1000;

function updateSpeed(val) {
  if (isNaN(val)) return;
  replayDelay = val * 1000;

  // Sync slider
  if (autoplaySpeedSlider && parseFloat(autoplaySpeedSlider.value) !== val) {
    autoplaySpeedSlider.value = val;
  }
  // Sync input
  if (autoplaySpeedInput && parseFloat(autoplaySpeedInput.value) !== val) {
    autoplaySpeedInput.value = val;
  }
}

if (autoplaySpeedSlider) {
  autoplaySpeedSlider.addEventListener("input", () => {
    const val = parseFloat(autoplaySpeedSlider.value);
    updateSpeed(val);
  });
}

if (autoplaySpeedInput) {
  autoplaySpeedInput.addEventListener("input", () => {
    const val = parseFloat(autoplaySpeedInput.value);
    if (!isNaN(val)) {
      updateSpeed(val);
    }
  });

  autoplaySpeedInput.addEventListener("change", () => {
    let val = parseFloat(autoplaySpeedInput.value);
    if (isNaN(val) || val < 0.05) {
      val = 0.05;
    } else if (val > 3.0) {
      val = 3.0;
    }
    val = Math.round(val * 100) / 100;
    updateSpeed(val);
  });
}

const orderTypeSelect = document.getElementById("order-type-select");
const orderPriceGroup = document.getElementById("order-price-group");
const orderPriceInput = document.getElementById("order-price-input");

// Inject direction selection buttons dynamically inside panel
if (orderTypeSelect) {
  const configInputs = orderTypeSelect.closest(".config-inputs");
  if (configInputs) {
    configInputs.insertAdjacentHTML(
      "beforeend",
      `
            <div id="order-direction-group" style="display: none; margin-top: 10px;">
                <span class="input-label" style="margin-bottom: 4px; display: block;">Направление ордера</span>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                    <button id="order-dir-buy-btn" class="tf-btn active" style="height: 32px; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 1px solid var(--color-up); background: rgba(16, 185, 129, 0.15); color: var(--color-up); cursor: pointer; border-radius: 4px; font-size: 11px;">BUY LIMIT</button>
                    <button id="order-dir-sell-btn" class="tf-btn" style="height: 32px; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 1px solid var(--border-color); background: transparent; color: var(--text-muted); cursor: pointer; border-radius: 4px; font-size: 11px;">SELL LIMIT</button>
                </div>
            </div>
        `,
    );
  }

  // Set up button listeners
  document
    .getElementById("order-dir-buy-btn")
    ?.addEventListener("click", (e) => {
      e.preventDefault();
      updatePreviewDirection("buy");
      placeOrder("buy");
    });
  document
    .getElementById("order-dir-sell-btn")
    ?.addEventListener("click", (e) => {
      e.preventDefault();
      updatePreviewDirection("sell");
      placeOrder("sell");
    });
}

function updateOrderDirectionUI() {
  const directionGroup = document.getElementById("order-direction-group");
  const buyBtn = document.getElementById("order-dir-buy-btn");
  const sellBtn = document.getElementById("order-dir-sell-btn");

  if (!orderTypeSelect || !directionGroup || !buyBtn || !sellBtn) return;

  const orderType = orderTypeSelect.value;
  if (orderType === "market") {
    directionGroup.style.display = "none";
  } else {
    directionGroup.style.display = "block";
    if (orderType === "limit") {
      buyBtn.textContent = "BUY LIMIT";
      sellBtn.textContent = "SELL LIMIT";
    } else if (orderType === "stop") {
      buyBtn.textContent = "BUY STOP";
      sellBtn.textContent = "SELL STOP";
    }

    const dir = state.orderPreviewDirection || "buy";
    if (dir === "buy") {
      buyBtn.className = "tf-btn active";
      buyBtn.style.cssText =
        "height: 32px; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 1px solid var(--color-up); background: rgba(16, 185, 129, 0.15); color: var(--color-up); cursor: pointer; border-radius: 4px; font-size: 11px;";
      sellBtn.className = "tf-btn";
      sellBtn.style.cssText =
        "height: 32px; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 1px solid var(--border-color); background: transparent; color: var(--text-muted); cursor: pointer; border-radius: 4px; font-size: 11px;";
    } else {
      buyBtn.className = "tf-btn";
      buyBtn.style.cssText =
        "height: 32px; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 1px solid var(--border-color); background: transparent; color: var(--text-muted); cursor: pointer; border-radius: 4px; font-size: 11px;";
      sellBtn.className = "tf-btn active";
      sellBtn.style.cssText =
        "height: 32px; display: flex; align-items: center; justify-content: center; font-weight: bold; border: 1px solid var(--color-down); background: rgba(239, 68, 68, 0.15); color: var(--color-down); cursor: pointer; border-radius: 4px; font-size: 11px;";
    }
  }
}

function updatePreviewDirection(dir) {
  state.orderPreviewDirection = dir;

  // Очищаем предыдущие черновики ордеров при смене направления
  state.positions = state.positions.filter((pos) => pos.status !== "draft");

  const arr = state.isBacktestActive
    ? state.backtestVisibleCandles
    : state.historicalCandles;
  if (arr && arr.length > 0) {
    const currentPrice = arr[arr.length - 1].close;
    const orderType = orderTypeSelect ? orderTypeSelect.value : "limit";
    const priceInput = document.getElementById("order-price-input");

    // Auto-adjust price so it is valid for the direction
    let previewPrice = state.orderPreviewPrice || currentPrice;
    if (orderType === "limit") {
      if (dir === "buy" && previewPrice >= currentPrice) {
        previewPrice = currentPrice * 0.998;
      } else if (dir === "sell" && previewPrice <= currentPrice) {
        previewPrice = currentPrice * 1.002;
      }
    } else if (orderType === "stop") {
      if (dir === "buy" && previewPrice <= currentPrice) {
        previewPrice = currentPrice * 1.002;
      } else if (dir === "sell" && previewPrice >= currentPrice) {
        previewPrice = currentPrice * 0.998;
      }
    }

    state.orderPreviewPrice = previewPrice;
    if (priceInput) priceInput.value = previewPrice.toFixed(5);

    // Auto-adjust TP/SL
    const isBuy = dir === "buy";
    state.orderPreviewTP = isBuy ? previewPrice * 1.003 : previewPrice * 0.997;
    state.orderPreviewSL = isBuy ? previewPrice * 0.997 : previewPrice * 1.003;

    const tpInput = document.getElementById("order-tp-input");
    const slInput = document.getElementById("order-sl-input");
    if (tpInput) tpInput.value = state.orderPreviewTP.toFixed(5);
    if (slInput) slInput.value = state.orderPreviewSL.toFixed(5);
  }

  updateOrderDirectionUI();
  drawAllOnCanvas();
}

if (orderTypeSelect) {
  orderTypeSelect.addEventListener("change", () => {
    state.positions = state.positions.filter((pos) => pos.status !== "draft");
    if (orderTypeSelect.value === "market") {
      if (orderPriceGroup) orderPriceGroup.style.display = "none";
      state.orderPreviewPrice = null;
      updateOrderDirectionUI();
      drawAllOnCanvas();
    } else {
      if (orderPriceGroup) orderPriceGroup.style.display = "flex";
      const arr = state.isBacktestActive
        ? state.backtestVisibleCandles
        : state.historicalCandles;
      if (arr && arr.length > 0) {
        const currentPrice = arr[arr.length - 1].close;

        const currentDir = state.orderPreviewDirection || "buy";
        state.orderPreviewDirection = currentDir;
        let startPrice = currentPrice;
        if (orderTypeSelect.value === "limit") {
          startPrice = currentDir === "buy" ? currentPrice * 0.998 : currentPrice * 1.002;
        } else if (orderTypeSelect.value === "stop") {
          startPrice = currentDir === "buy" ? currentPrice * 1.002 : currentPrice * 0.998;
        }

        if (orderPriceInput) orderPriceInput.value = startPrice.toFixed(5);
        state.orderPreviewPrice = startPrice;
        state.orderPreviewTPEnabled = true;
        state.orderPreviewSLEnabled = true;

        const isBuy = currentDir === "buy";
        state.orderPreviewTP = isBuy ? startPrice * 1.003 : startPrice * 0.997;
        state.orderPreviewSL = isBuy ? startPrice * 0.997 : startPrice * 1.003;

        const tpInput = document.getElementById("order-tp-input");
        const slInput = document.getElementById("order-sl-input");
        if (tpInput) tpInput.value = state.orderPreviewTP.toFixed(5);
        if (slInput) slInput.value = state.orderPreviewSL.toFixed(5);

        updateOrderDirectionUI();
        drawAllOnCanvas();
      }
    }
  });
}

const orderTpInput = document.getElementById("order-tp-input");
const orderSlInput = document.getElementById("order-sl-input");

if (orderPriceInput) {
  orderPriceInput.addEventListener("input", () => {
    const val = parseFloat(orderPriceInput.value);
    if (!isNaN(val) && val > 0) {
      state.orderPreviewPrice = val;
      drawAllOnCanvas();
    }
  });
}
if (orderTpInput) {
  orderTpInput.addEventListener("input", () => {
    const val = parseFloat(orderTpInput.value);
    if (!isNaN(val) && val > 0) {
      state.orderPreviewTP = val;
      state.orderPreviewTPEnabled = true;
      drawAllOnCanvas();
    } else if (orderTpInput.value === "") {
      state.orderPreviewTPEnabled = false;
      drawAllOnCanvas();
    }
  });
}
if (orderSlInput) {
  orderSlInput.addEventListener("input", () => {
    const val = parseFloat(orderSlInput.value);
    if (!isNaN(val) && val > 0) {
      state.orderPreviewSL = val;
      state.orderPreviewSLEnabled = true;
      drawAllOnCanvas();
    } else if (orderSlInput.value === "") {
      state.orderPreviewSLEnabled = false;
      drawAllOnCanvas();
    }
  });
}

const elO = document.getElementById("val-o");
const elH = document.getElementById("val-h");
const elL = document.getElementById("val-l");
const elC = document.getElementById("val-c");
const elCh = document.getElementById("val-ch");

const canvas = document.getElementById("drawing-canvas");
const toolCursorBtn = document.getElementById("tool-cursor");
const toolBrushBtn = document.getElementById("tool-brush");
const toolHlineBtn = document.getElementById("tool-hline");
const toolWaitLevelBtn = document.getElementById("tool-wait-level");
const toolVladRayBtn = document.getElementById("tool-vlad-ray");
const toolFibBtn = document.getElementById("tool-fib");
const toolLongBtn = document.getElementById("tool-long");
const toolShortBtn = document.getElementById("tool-short");
const toolLineBtn = document.getElementById("tool-line");
const toolRectBtn = document.getElementById("tool-rect");
const toolTextBtn = document.getElementById("tool-text");
const toolPathBtn = document.getElementById("tool-path");
const drawingColorInput = document.getElementById("drawing-color");
const toolClearBtn = document.getElementById("tool-clear");

let activeTool = "cursor";
let drawings = { brushPaths: [], positions: [], horizontalLines: [], waitLevels: [], vladRays: [], lines: [], rectangles: [], texts: [], paths: [], fibs: [] };
let activeColor = localStorage.getItem("drawing_color") || "#3b82f6";
let isDrawingBrush = false;
let currentBrushPath = null;
let isDrawingLineOrRect = false;
let tempDrawing = null;
let tempPath = null;
let mousePreviewPt = null;
let activeInlineEditor = null;
let lastPathClickTime = 0;
let drawingMouseDownPos = null;
let activeDrag = null;
let currentCloseReasonFilter = "ALL";

try {
  const savedDrawings = localStorage.getItem("drawings");
  if (savedDrawings) {
    const parsed = JSON.parse(savedDrawings);
    if (parsed && typeof parsed === "object") {
      drawings = parsed;
    }
  }
} catch (e) {
  console.error(e);
}

if (!drawings || typeof drawings !== "object") {
  drawings = { brushPaths: [], positions: [], horizontalLines: [], waitLevels: [], vladRays: [], lines: [], rectangles: [], texts: [], paths: [], fibs: [] };
}
if (!Array.isArray(drawings.brushPaths)) drawings.brushPaths = [];
if (!Array.isArray(drawings.positions)) drawings.positions = [];
if (!Array.isArray(drawings.horizontalLines)) drawings.horizontalLines = [];
if (!Array.isArray(drawings.waitLevels)) drawings.waitLevels = [];
if (!Array.isArray(drawings.vladRays)) drawings.vladRays = [];
if (!Array.isArray(drawings.lines)) drawings.lines = [];
if (!Array.isArray(drawings.rectangles)) drawings.rectangles = [];
if (!Array.isArray(drawings.texts)) drawings.texts = [];
if (!Array.isArray(drawings.paths)) drawings.paths = [];
if (!Array.isArray(drawings.fibs)) drawings.fibs = [];
if (drawingColorInput) {
  drawingColorInput.value = activeColor;
}

function showToast(message, type = "success", isCritical = false) {
  if (typeof window !== "undefined") window.showToast = showToast;
  
  // Categorization: Errors, critical flags, account stops, or system alerts are critical
  const msgStr = typeof message === "string" ? message.toLowerCase() : "";
  const isCrit = isCritical === true || type === "error" || 
    msgStr.includes("ошибка") || 
    msgStr.includes("error") || 
    msgStr.includes("could not copy") || 
    msgStr.includes("превышен лимит") || 
    msgStr.includes("остановлен") ||
    msgStr.includes("drawdown") ||
    msgStr.includes("не удалось");

  if (typeof isNotificationsEnabled !== "undefined" && !isNotificationsEnabled && !isCrit) {
    return;
  }

  const cont = document.getElementById("toast-container");
  if (!cont) return;
  const t = document.createElement("div");
  t.className = "toast toast-" + type;
  t.style.cssText =
    "pointer-events:none; min-width:280px; max-width:360px; padding:12px 16px; border-radius:6px; font-size:12px; font-weight:500; line-height:1.4; box-shadow:0 10px 30px rgba(0,0,0,0.5); display:flex; align-items:center; gap:10px; opacity:0; transform:translateY(-20px); transition:all 0.4s cubic-bezier(0.16, 1, 0.3, 1);";

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
  cont.appendChild(t);

  requestAnimationFrame(() => {
    t.style.opacity = "1";
    t.style.transform = "translateY(0)";
  });
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transform = "translateY(-10px)";
    setTimeout(() => t.remove(), 400);
  }, 4000);
}

const chart = LightweightCharts.createChart(container, {
  layout: {
    background: { type: "solid", color: "#0b101b" },
    textColor: "#94a3b8",
    fontFamily:
      'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  grid: {
    vertLines: { color: "rgba(30, 41, 59, 0.15)" },
    horzLines: { color: "rgba(30, 41, 59, 0.15)" },
  },
  rightPriceScale: {
    borderColor: "#1e293b",
    borderVisible: true,
    scaleMargins: { top: 0.15, bottom: 0.15 },
    minimumWidth: 75,
  },
  timeScale: {
    borderColor: "#1e293b",
    borderVisible: true,
    timeVisible: true,
    secondsVisible: false,
    barSpacing: 10,
  },
  crosshair: {
    mode: LightweightCharts.CrosshairMode.Normal,
    vertLine: {
      color: "rgba(117, 134, 150, 0.35)",
      width: 1,
      style: 2,
      labelBackgroundColor: "#0f172a",
    },
    horzLine: {
      color: "rgba(117, 134, 150, 0.35)",
      width: 1,
      style: 2,
      labelBackgroundColor: "#0f172a",
    },
  },
  handleScale: { mouseWheel: true, pinch: true },
  handleScroll: { mouseWheel: true, pressedMouseMove: true },
});

const candlestickSeries = chart.addCandlestickSeries({
  upColor: "#10b981",
  downColor: "#ef4444",
  borderVisible: false,
  wickUpColor: "#10b981",
  wickDownColor: "#ef4444",
  priceFormat: { type: "price", precision: 5, minMove: 0.00001 },
});

function updateLegend(candle) {
  if (!candle) return;
  canvasCurrentCandle = candle;
  window.canvasCurrentCandle = candle;
  const decimals = getSymbolDecimals(state.symbol);
  const o = candle.open.toFixed(decimals);
  const h = candle.high.toFixed(decimals);
  const l = candle.low.toFixed(decimals);
  const c = candle.close.toFixed(decimals);

  if (elO) elO.textContent = o;
  if (elH) elH.textContent = h;
  if (elL) elL.textContent = l;
  if (elC) elC.textContent = c;
  const diff = candle.close - candle.open;
  const pct = (diff / candle.open) * 100;
  const sign = diff >= 0 ? "+" : "";
  if (elCh) elCh.textContent = `${sign}${diff.toFixed(decimals)} (${sign}${pct.toFixed(2)}%)`;

  const color = diff >= 0 ? "#10b981" : "#ef4444";
  if (elO) elO.style.color = color;
  if (elH) elH.style.color = color;
  if (elL) elL.style.color = color;
  if (elC) elC.style.color = color;
  if (elCh) elCh.style.color = color;

  if (headerLastPrice) {
    headerLastPrice.textContent = c;
    headerLastPrice.style.color = color;
  }
  if (buyBtnPrice && sellBtnPrice) {
    buyBtnPrice.textContent = c;
    sellBtnPrice.textContent = c;
  }
  if (!window._cachedFloatingBuyPrice) window._cachedFloatingBuyPrice = document.getElementById("floating-buy-price");
  if (!window._cachedFloatingSellPrice) window._cachedFloatingSellPrice = document.getElementById("floating-sell-price");
  if (!window._cachedFloatingTradeSymbol) window._cachedFloatingTradeSymbol = document.getElementById("floating-trade-symbol");
  
  if (window._cachedFloatingBuyPrice && window._cachedFloatingSellPrice) {
    window._cachedFloatingBuyPrice.textContent = c;
    window._cachedFloatingSellPrice.textContent = c;
  }
  if (window._cachedFloatingTradeSymbol && state.symbol) {
    window._cachedFloatingTradeSymbol.textContent = state.symbol.replace("_", "/");
  }
}

chart.subscribeCrosshairMove((p) => {
  const cWidth = cachedContainerWidth || (container ? container.clientWidth : 0);
  const cHeight = cachedContainerHeight || (container ? container.clientHeight : 0);
  if (
    !p ||
    !p.time ||
    p.point.x < 0 ||
    p.point.x > cWidth ||
    p.point.y < 0 ||
    p.point.y > cHeight
  ) {
    const arr = state.isBacktestActive
      ? state.backtestVisibleCandles
      : state.historicalCandles;
    if (arr && arr.length > 0) updateLegend(arr[arr.length - 1]);
  } else {
    const candle = p.seriesData.get(candlestickSeries);
    if (candle) updateLegend(candle);
  }
});

function updateChartPosition(clickedTime) {
  if (!state.isBacktestActive) return;

  // Ensure we have backtestData initialized
  if (!state.backtestData || state.backtestData.length === 0) {
    if (state.isFileLoaded && state.importedBaseCandles && state.importedBaseCandles.length > 0) {
      state.backtestData = [...state.importedBaseCandles];
    } else if (state.historicalCandles && state.historicalCandles.length > 0) {
      state.backtestData = [...state.historicalCandles];
    } else {
      showToast("Пожалуйста, загрузите JSON-файл или демо-данные для запуска бэктеста!", "warning");
      return;
    }
  }

  // Force backtest base candles to point to the protected immutable backtestData
  state.backtestBaseCandles = state.backtestData;
  state.baseTimeframeCache = state.backtestData;

  // Find the closest candle in backtestData <= clickedTime
  let targetTimestamp = clickedTime;
  const exactCandle = state.backtestData.find(c => c.time === clickedTime);
  if (!exactCandle) {
    const pastCandles = state.backtestData.filter(c => c.time <= clickedTime);
    if (pastCandles.length > 0) {
      targetTimestamp = pastCandles[pastCandles.length - 1].time;
    } else {
      targetTimestamp = state.backtestData[0].time;
    }
  }

  state.currentReplayTimestamp = targetTimestamp;

  // Set initial step index
  const baseIdx = state.backtestData.findIndex(c => c.time === targetTimestamp);
  state.backtestInitialIdx = baseIdx !== -1 ? baseIdx : 0;

  // Capture visible range BEFORE modifying data
  const timeScale = chart.timeScale();
  const visibleLogicalRangeBefore = timeScale ? timeScale.getVisibleLogicalRange() : null;

  // Update visible candles based on the chosen timeframe and target timestamp
  updateBacktestVisibleCandles();

  // Set chart data
  state.lastRenderedCandlesArray = null;
  candlestickSeries.setData(state.backtestVisibleCandles);

  // Restore visible range
  if (timeScale && visibleLogicalRangeBefore) {
    try {
      timeScale.setVisibleLogicalRange(visibleLogicalRangeBefore);
    } catch (e) {}
    requestAnimationFrame(() => {
      try {
        timeScale.setVisibleLogicalRange(visibleLogicalRangeBefore);
      } catch (e) {}
    });
    setTimeout(() => {
      try {
        timeScale.setVisibleLogicalRange(visibleLogicalRangeBefore);
      } catch (e) {}
    }, 50);
  }

  if (state.backtestVisibleCandles.length > 0) {
    updateLegend(state.backtestVisibleCandles[state.backtestVisibleCandles.length - 1]);
  }

  if (backtestPrevBtn) {
    backtestPrevBtn.disabled = false;
    backtestPrevBtn.style.opacity = "1";
    backtestPrevBtn.style.cursor = "pointer";
  }
  backtestNextBtn.disabled = false;
  backtestNextBtn.style.opacity = "1";
  backtestNextBtn.style.cursor = "pointer";
  backtestAutoplayBtn.disabled = false;
  backtestAutoplayBtn.style.opacity = "1";
  backtestAutoplayBtn.style.cursor = "pointer";
  if (backtestFastForwardBtn) {
    backtestFastForwardBtn.disabled = false;
    backtestFastForwardBtn.style.opacity = "1";
    backtestFastForwardBtn.style.cursor = "pointer";
  }
  updateDeckStatus("PAUSED");
  updateSimulatorUI();
  drawAllOnCanvas();

  if (typeof updateCOTChartData === "function" && typeof cotChartState !== "undefined" && cotChartState.active) {
    updateCOTChartData();
  }

  const formattedTime = new Date(targetTimestamp * 1000).toLocaleString();
  showToast(`Бэктест спозиционирован на ${formattedTime}`, "success");
}

chart.subscribeClick((p) => {
  if (!state.isBacktestActive) return;
  if (!p || !p.time) return;
  updateChartPosition(p.time);
});

let cachedPlotArea = null;
let cachedContainerRect = null;
let cachedContainerWidth = 0;
let cachedContainerHeight = 0;

function invalidateCachedDimensions() {
  cachedPlotArea = null;
  cachedContainerRect = null;
  if (container) {
    cachedContainerWidth = container.clientWidth;
    cachedContainerHeight = container.clientHeight;
  }
}

function updateCachedDimensions() {
  if (!container) return;
  const tds = container.querySelectorAll("td");
  let plotTd = null;
  let maxWidth = -1;
  if (tds && tds.length > 0) {
    tds.forEach((td) => {
      const w = td.clientWidth;
      if (w > maxWidth) {
        maxWidth = w;
        plotTd = td;
      }
    });
  }
  const containerRect = container.getBoundingClientRect();
  cachedContainerRect = containerRect;
  cachedContainerWidth = container.clientWidth;
  cachedContainerHeight = container.clientHeight;

  if (plotTd) {
    const rect = plotTd.getBoundingClientRect();
    cachedPlotArea = {
      left: rect.left - containerRect.left,
      top: rect.top - containerRect.top,
      width: rect.width,
      height: rect.height,
      right: rect.right - containerRect.left,
      bottom: rect.bottom - containerRect.top,
    };
  } else {
    cachedPlotArea = {
      left: 0,
      top: 0,
      width: Math.max(0, cachedContainerWidth - 75),
      height: Math.max(0, cachedContainerHeight - 26),
      right: Math.max(0, cachedContainerWidth - 75),
      bottom: Math.max(0, cachedContainerHeight - 26),
    };
  }
}

window.addEventListener("resize", invalidateCachedDimensions, { passive: true });

const resizeObs = new ResizeObserver((entries) => {
  if (entries.length > 0) {
    window.requestAnimationFrame(() => {
      chart.resize(entries[0].contentRect.width, entries[0].contentRect.height);
      resizeCanvas();
    });
  }
});
resizeObs.observe(container);

let hoveredObject = null;
let activeSelectedObject = null;

function resizeCanvas() {
  updateCachedDimensions();
  const rect = cachedContainerRect || container.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = rect.width + "px";
  canvas.style.height = rect.height + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  drawAllOnCanvas();
}

function saveDrawings() {
  localStorage.setItem("drawings", JSON.stringify(drawings));
  saveData("drawings", drawings).catch(e => console.error("Failed to save drawings to IndexedDB:", e));
}

function finishPath() {
  if (!tempPath) return;

  if (tempPath.points && tempPath.points.length > 1) {
    const pLast = tempPath.points[tempPath.points.length - 1];
    const pPrev = tempPath.points[tempPath.points.length - 2];
    if (pLast.time === pPrev.time && Math.abs(pLast.price - pPrev.price) < 0.000001) {
      tempPath.points.pop();
    }
  }

  if (tempPath.points && tempPath.points.length >= 2) {
    if (!Array.isArray(drawings.paths)) drawings.paths = [];
    saveState();
    const pathObj = JSON.parse(JSON.stringify(tempPath));
    drawings.paths.push(pathObj);
    activeSelectedObject = { type: "path", index: drawings.paths.length - 1 };
    saveDrawings();
    showToast("Траектория добавлена", "success");
  } else {
    showToast("Траектория отменена (нужно минимум 2 точки)", "warning");
  }

  tempPath = null;
  mousePreviewPt = null;
  setActiveTool("cursor");
  drawAllOnCanvas();
}

function openInlineTextEditor(pt, existingTextObj = null, textIndex = null) {
  if (activeInlineEditor) {
    try {
      activeInlineEditor.blur();
      activeInlineEditor.remove();
    } catch (e) {}
    activeInlineEditor = null;
  }

  const chartContainer = document.getElementById("chart-viewport") || document.getElementById("chart-container");
  if (!chartContainer) return;

  const rect = chartContainer.getBoundingClientRect();
  const screenX = getXFromPoint(pt);
  const screenY = candlestickSeries.priceToCoordinate(pt.price);

  if (screenX === null || screenY === null) return;

  const posX = Math.max(10, Math.min(rect.width - 160, screenX));
  const posY = Math.max(10, Math.min(rect.height - 60, screenY));
  const editorOpenedAt = Date.now();

  const textarea = document.createElement("textarea");
  textarea.className = "inline-text-editor";
  textarea.placeholder = "Введите текст...";
  textarea.style.cssText = `
    position: absolute;
    left: ${posX}px;
    top: ${posY}px;
    z-index: 1000;
    min-width: 150px;
    max-width: 280px;
    min-height: 48px;
    background: rgba(15, 23, 42, 0.95);
    color: ${existingTextObj ? existingTextObj.color || activeColor : activeColor};
    border: 2px solid ${activeColor || "#3b82f6"};
    border-radius: 6px;
    padding: 6px 8px;
    font-size: 14px;
    font-family: Inter, sans-serif;
    outline: none;
    box-shadow: 0 4px 20px rgba(0,0,0,0.6);
    resize: both;
    pointer-events: auto;
  `;

  if (existingTextObj) {
    textarea.value = existingTextObj.text || "";
  }

  ["mousedown", "mouseup", "click", "pointerdown", "pointerup", "dblclick", "contextmenu"].forEach(evt => {
    textarea.addEventListener(evt, (e) => e.stopPropagation());
  });

  chartContainer.appendChild(textarea);
  activeInlineEditor = textarea;

  textarea.focus();
  requestAnimationFrame(() => {
    textarea.focus();
    if (existingTextObj && textarea.value) {
      textarea.select();
    }
  });

  let isCommitted = false;
  const commit = () => {
    if (isCommitted) return;
    isCommitted = true;

    const val = textarea.value.trim();
    saveState();
    if (!Array.isArray(drawings.texts)) drawings.texts = [];

    if (val) {
      if (existingTextObj && textIndex !== null && drawings.texts[textIndex]) {
        drawings.texts[textIndex].text = val;
        drawings.texts[textIndex].color = existingTextObj.color || activeColor;
      } else {
        drawings.texts.push({
          id: Math.random().toString(36).substr(2, 9),
          type: "text",
          point: pt,
          text: val,
          color: activeColor,
          fontSize: 14
        });
        activeSelectedObject = { type: "text", index: drawings.texts.length - 1 };
      }
      saveDrawings();
      showToast(existingTextObj ? "Текст обновлен" : "Текст добавлен", "success");
    } else if (existingTextObj && textIndex !== null && drawings.texts[textIndex]) {
      drawings.texts.splice(textIndex, 1);
      saveDrawings();
      showToast("Пустой текст удален", "info");
    }

    if (activeInlineEditor === textarea) {
      activeInlineEditor = null;
    }
    textarea.remove();
    drawAllOnCanvas();
  };

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      isCommitted = true;
      if (activeInlineEditor === textarea) {
        activeInlineEditor = null;
      }
      textarea.remove();
      drawAllOnCanvas();
    }
  });

  textarea.addEventListener("blur", () => {
    if (Date.now() - editorOpenedAt < 250) {
      setTimeout(() => {
        if (!isCommitted && document.activeElement !== textarea) {
          textarea.focus();
        }
      }, 50);
      return;
    }
    commit();
  });
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function setActiveTool(tool) {
  if (activeTool === "path" && tool !== "path" && tempPath) {
    finishPath();
    return;
  }
  if (activeTool === "path" && tool === "path" && tempPath) {
    finishPath();
    return;
  }

  activeTool = tool;
  [
    toolCursorBtn,
    toolBrushBtn,
    toolHlineBtn,
    toolWaitLevelBtn,
    toolVladRayBtn,
    toolFibBtn,
    toolLongBtn,
    toolShortBtn,
    toolLineBtn,
    toolRectBtn,
    toolTextBtn,
    toolPathBtn,
  ].forEach((btn) => {
    if (btn) btn.classList.remove("active");
  });
  if (tool === "cursor" && toolCursorBtn) toolCursorBtn.classList.add("active");
  else if (tool === "brush" && toolBrushBtn) toolBrushBtn.classList.add("active");
  else if (tool === "long" && toolLongBtn) toolLongBtn.classList.add("active");
  else if (tool === "hline" && toolHlineBtn) toolHlineBtn.classList.add("active");
  else if (tool === "wait_level" && toolWaitLevelBtn) toolWaitLevelBtn.classList.add("active");
  else if (tool === "vlad_ray" && toolVladRayBtn) toolVladRayBtn.classList.add("active");
  else if (tool === "fib" && toolFibBtn) toolFibBtn.classList.add("active");
  else if (tool === "short" && toolShortBtn) toolShortBtn.classList.add("active");
  else if (tool === "line" && toolLineBtn) toolLineBtn.classList.add("active");
  else if (tool === "rect" && toolRectBtn) toolRectBtn.classList.add("active");
  else if (tool === "text" && toolTextBtn) toolTextBtn.classList.add("active");
  else if (tool === "path" && toolPathBtn) toolPathBtn.classList.add("active");

  if (tool === "cursor") {
    canvas.style.pointerEvents = "none";
    canvas.style.cursor = "default";
    chart.applyOptions({
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: true,
      },
    });
  } else {
    canvas.style.pointerEvents = "auto";
    canvas.style.cursor = "crosshair";
    chart.applyOptions({
      handleScroll: {
        mouseWheel: false,
        pressedMouseMove: false,
        horzTouchDrag: false,
        vertTouchDrag: false,
      },
      handleScale: {
        mouseWheel: false,
        pinch: false,
        axisPressedMouseMove: false,
      },
    });
  }
  drawAllOnCanvas();
}

function drawArrowHead(ctx, x1, y1, x2, y2, color, headLength = 13) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const arrowAngle = Math.PI / 6;
  ctx.save();
  ctx.fillStyle = color || "#3b82f6";
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLength * Math.cos(angle - arrowAngle),
    y2 - headLength * Math.sin(angle - arrowAngle)
  );
  ctx.lineTo(
    x2 - headLength * Math.cos(angle + arrowAngle),
    y2 - headLength * Math.sin(angle + arrowAngle)
  );
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawHandle(ctx, x, y, shapeType, color, size = 4.5) {
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = color || "#3b82f6";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (shapeType === "circle") {
    ctx.arc(x, y, size, 0, 2 * Math.PI);
  } else {
    ctx.rect(x - size, y - size, size * 2, size * 2);
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function getBarSpacing() {
  try {
    if (chart) {
      const opt = chart.timeScale().options();
      if (opt && typeof opt.barSpacing === "number") {
        return opt.barSpacing;
      }
    }
  } catch (e) {}
  return 10;
}

function getChartPlotArea() {
  if (!cachedPlotArea) {
    updateCachedDimensions();
  }
  return cachedPlotArea;
}

const OHLC_BAR_HEIGHT = 40;

function getOHLCBottomY() {
  const plotArea = getChartPlotArea();
  return plotArea ? plotArea.top + OHLC_BAR_HEIGHT : OHLC_BAR_HEIGHT;
}

function getDrawingTopBoundary() {
  return getOHLCBottomY();
}

function getXFromTime(t) {
  const arr = state.isBacktestActive
    ? state.backtestVisibleCandles
    : state.historicalCandles;
  if (!arr || arr.length === 0) return null;

  let left = 0;
  let right = arr.length - 1;
  let nearestCandle = arr[arr.length - 1];
  let minDiff = Infinity;

  while (left <= right) {
    const mid = (left + right) >> 1;
    const midCandle = arr[mid];
    const diff = Math.abs(midCandle.time - t);
    if (diff < minDiff) {
      minDiff = diff;
      nearestCandle = midCandle;
    }
    if (midCandle.time === t) {
      break;
    } else if (midCandle.time < t) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  const candleX = chart.timeScale().timeToCoordinate(nearestCandle.time);
  if (candleX === null) return null;

  const tfMinutes = timeframeToMinutes(state.timeframe || "15m");
  const tfSeconds = tfMinutes * 60;
  const spacing = getBarSpacing();
  
  const timeDiff = t - nearestCandle.time;
  const pixelOffset = (timeDiff / tfSeconds) * spacing;
  
  return candleX + pixelOffset;
}

function getXFromPoint(pt) {
  if (!pt) return null;
  const baseTime = pt.time || 0;
  const tfMinutes = timeframeToMinutes(state.timeframe || "15m");
  const tfSeconds = tfMinutes * 60;
  
  if (pt.offsetXFraction === 0 || !pt.offsetXFraction) {
    return getXFromTime(baseTime);
  }
  
  const exactTime = baseTime + pt.offsetXFraction * tfSeconds;
  return getXFromTime(exactTime);
}

function getXFromPosition(pos) {
  if (!pos) return null;
  const baseTime = pos.time || 0;
  const tfMinutes = timeframeToMinutes(state.timeframe || "15m");
  const tfSeconds = tfMinutes * 60;
  
  if (pos.offsetXFraction === 0 || !pos.offsetXFraction) {
    return getXFromTime(baseTime);
  }
  
  const exactTime = baseTime + pos.offsetXFraction * tfSeconds;
  return getXFromTime(exactTime);
}

function getPointFromCoords(mouseX, mouseY) {
  const arr = state.isBacktestActive
    ? state.backtestVisibleCandles
    : state.historicalCandles;
  if (!arr || arr.length === 0) return null;

  const tfMinutes = timeframeToMinutes(state.timeframe || "15m");
  const tfSeconds = tfMinutes * 60;

  let time = chart.timeScale().coordinateToTime(mouseX);
  let price = candlestickSeries.coordinateToPrice(mouseY);
  if (price === null) {
    price = candlestickSeries.coordinateToPrice(
      Math.max(0, Math.min(canvas.height, mouseY)),
    );
    if (price === null) price = arr[arr.length - 1].close;
  }

  let baseCandle = null;
  if (time !== null) {
    let left = 0;
    let right = arr.length - 1;
    while (left <= right) {
      const mid = (left + right) >> 1;
      if (arr[mid].time === time) {
        baseCandle = arr[mid];
        break;
      } else if (arr[mid].time < time) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }
  }
  if (!baseCandle) {
    let left = 0;
    let right = arr.length - 1;
    let nearestCandle = arr[arr.length - 1];
    let minDst = Infinity;

    while (left <= right) {
      const mid = (left + right) >> 1;
      const midCandle = arr[mid];
      const cx = chart.timeScale().timeToCoordinate(midCandle.time);
      if (cx === null) {
        break;
      }
      const dst = Math.abs(cx - mouseX);
      if (dst < minDst) {
        minDst = dst;
        nearestCandle = midCandle;
      }
      if (cx === mouseX) {
        break;
      } else if (cx < mouseX) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }
    baseCandle = nearestCandle;
    time = baseCandle.time;
  }

  const candleX = chart.timeScale().timeToCoordinate(baseCandle.time);
  const spacing = getBarSpacing();
  const offsetXFraction = candleX !== null ? (mouseX - candleX) / spacing : 0;

  // Calculate exact time (including sub-bar offset)
  const exactTime = baseCandle.time + offsetXFraction * tfSeconds;

  return { time: exactTime, price, offsetXFraction: 0 };
}

function getOrderPlacementPreviewValues(clickedPrice) {
  const arr = state.isBacktestActive
    ? state.backtestVisibleCandles
    : state.historicalCandles;
  if (!arr || arr.length === 0) return null;
  const currentPrice = arr[arr.length - 1].close;

  const orderTypeSelect = document.getElementById("order-type-select");
  if (!orderTypeSelect || orderTypeSelect.value === "market") return null;
  const orderType = orderTypeSelect.value;

  // Determine BUY or SELL automatically
  let type = "buy";
  if (orderType === "limit") {
    type = clickedPrice < currentPrice ? "buy" : "sell";
  } else if (orderType === "stop") {
    type = clickedPrice > currentPrice ? "buy" : "sell";
  }

  // TP and SL values
  const tpInput = document.getElementById("order-tp-input");
  const slInput = document.getElementById("order-sl-input");

  // Default offset based on currentPrice (0.3% of currentPrice)
  const defaultOffset = currentPrice * 0.003;

  let takeProfit =
    tpInput && tpInput.value ? parseFloat(tpInput.value) : undefined;
  let stopLoss =
    slInput && slInput.value ? parseFloat(slInput.value) : undefined;

  if (type === "buy") {
    if (!takeProfit) takeProfit = clickedPrice + defaultOffset;
    if (!stopLoss) stopLoss = clickedPrice - defaultOffset;
  } else {
    if (!takeProfit) takeProfit = clickedPrice - defaultOffset;
    if (!stopLoss) stopLoss = clickedPrice + defaultOffset;
  }

  return {
    orderType,
    type,
    entryPrice: clickedPrice,
    takeProfit,
    stopLoss,
  };
}

function getOrderPreviewType() {
  return state.orderPreviewDirection || "buy";
}

function getTPPreviewLabelText() {
  if (!state.orderPreviewTP) return "";
  const size = volumeInput ? parseFloat(volumeInput.value) || 1.0 : 1.0;
  const units = size * 100000;
  const isBuy = getOrderPreviewType() === "buy";

  let tpPnl = isBuy
    ? (state.orderPreviewTP - state.orderPreviewPrice) * units
    : (state.orderPreviewPrice - state.orderPreviewTP) * units;
  if (state.symbol.endsWith("_JPY")) {
    tpPnl = tpPnl / state.orderPreviewTP;
  }
  const tpSign = tpPnl >= 0 ? "+" : "";
  return ` TP: ${state.orderPreviewTP.toFixed(5)} (${tpSign}$${tpPnl.toFixed(2)}) `;
}

function getSLPreviewLabelText() {
  if (!state.orderPreviewSL) return "";
  const size = volumeInput ? parseFloat(volumeInput.value) || 1.0 : 1.0;
  const units = size * 100000;
  const isBuy = getOrderPreviewType() === "buy";

  let slPnl = isBuy
    ? (state.orderPreviewSL - state.orderPreviewPrice) * units
    : (state.orderPreviewPrice - state.orderPreviewSL) * units;
  if (state.symbol.endsWith("_JPY")) {
    slPnl = slPnl / state.orderPreviewSL;
  }
  const slSign = slPnl >= 0 ? "+" : "";
  return ` SL: ${state.orderPreviewSL.toFixed(5)} (${slSign}$${slPnl.toFixed(2)}) `;
}

function drawOrder(price, type, tp, sl) {
  if (!price) return;
  console.log("Drawing order:", { price, type, tp, sl });

  if (!candlestickSeries) return;

  const plotArea = getChartPlotArea();
  const canvas = document.getElementById("drawing-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const isLong = type === "Long";
  const previewColor = isLong ? "#0f9d58" : "#db4437";
  const previewColorAlpha = isLong ? "#0f9d58E6" : "#db4437E6";

  // Calculate coordinates on canvas using priceToCoordinate
  const entryY = candlestickSeries.priceToCoordinate(price);
  if (
    entryY === null ||
    isNaN(entryY) ||
    entryY < plotArea.top ||
    entryY > plotArea.bottom
  ) {
    return;
  }

  ctx.save();

  // 1. Draw Entry line
  ctx.beginPath();
  ctx.strokeStyle = previewColor;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.moveTo(plotArea.left, entryY);
  ctx.lineTo(plotArea.right, entryY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Draw Entry label
  ctx.font = "bold 9px Inter, sans-serif";
  const orderTypeSelect = document.getElementById("order-type-select");
  const orderTypeStr = orderTypeSelect
    ? orderTypeSelect.value.toUpperCase()
    : "LIMIT";
  const labelText = ` ${orderTypeStr} PREVIEW (${type.toUpperCase()}): ${price.toFixed(5)} `;
  const textW = ctx.measureText(labelText).width;
  const labelW = textW + 20;
  const labelH = 14;
  const labelX = plotArea.left + 10;
  const labelY = entryY - labelH / 2;

  ctx.fillStyle = previewColorAlpha;
  if (ctx.roundRect) {
    ctx.beginPath();
    ctx.roundRect(labelX, labelY, labelW, labelH, 3);
    ctx.fill();
  } else {
    ctx.fillRect(labelX, labelY, labelW, labelH);
  }
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(labelText, labelX + 3, entryY);

  // Divider
  const dividerX = labelX + textW + 4;
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(dividerX, labelY);
  ctx.lineTo(dividerX, labelY + labelH);
  ctx.stroke();

  // Close button
  const isEntryCloseHovered =
    hoveredObject &&
    hoveredObject.type === "preview_close_btn" &&
    hoveredObject.lineType === "entry";
  ctx.fillStyle = isEntryCloseHovered ? "#ff4d4f" : "#ffffff";
  ctx.font = "9px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("✕", dividerX + 8, entryY);

  // TP toggle button
  const tpBtnX = labelX + labelW + 10;
  const btnY = entryY - 7;
  const btnW = 32;
  const btnH = 14;
  ctx.font = "bold 8px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (state.orderPreviewTPEnabled) {
    ctx.fillStyle = "#0f9d58";
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(tpBtnX, btnY, btnW, btnH, 3);
      ctx.fill();
    } else {
      ctx.fillRect(tpBtnX, btnY, btnW, btnH);
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillText("TP", tpBtnX + btnW / 2, entryY);
  } else {
    ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(tpBtnX, btnY, btnW, btnH, 3);
      ctx.fill();
    } else {
      ctx.fillRect(tpBtnX, btnY, btnW, btnH);
    }
    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.fillStyle = "#cccccc";
    ctx.fillText("+TP", tpBtnX + btnW / 2, entryY);
  }

  // SL toggle button
  const slBtnX = tpBtnX + 36;
  if (state.orderPreviewSLEnabled) {
    ctx.fillStyle = "#ef5350";
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(slBtnX, btnY, btnW, btnH, 3);
      ctx.fill();
    } else {
      ctx.fillRect(slBtnX, btnY, btnW, btnH);
    }
    ctx.fillStyle = "#ffffff";
    ctx.fillText("SL", slBtnX + btnW / 2, entryY);
  } else {
    ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(slBtnX, btnY, btnW, btnH, 3);
      ctx.fill();
    } else {
      ctx.fillRect(slBtnX, btnY, btnW, btnH);
    }
    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.fillStyle = "#cccccc";
    ctx.fillText("+SL", slBtnX + btnW / 2, entryY);
  }

  // Draw Entry price label on the right scale
  const scaleX = plotArea.right + 2;
  const scaleW = 60;
  const scaleH = 16;
  const scaleY = entryY - scaleH / 2;
  ctx.fillStyle = previewColor;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(scaleX, scaleY, scaleW, scaleH, 3);
  else ctx.rect(scaleX, scaleY, scaleW, scaleH);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 9px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(price.toFixed(5), scaleX + scaleW / 2, entryY);

  // 2. Draw TP line (if enabled and present)
  if (state.orderPreviewTPEnabled && tp) {
    const tpY = candlestickSeries.priceToCoordinate(tp);
    if (
      tpY !== null &&
      !isNaN(tpY) &&
      tpY >= plotArea.top &&
      tpY <= plotArea.bottom
    ) {
      ctx.beginPath();
      ctx.strokeStyle = "#0f9d58";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 4]);
      ctx.moveTo(plotArea.left, tpY);
      ctx.lineTo(plotArea.right, tpY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.font = "bold 9px Inter, sans-serif";
      const labelText = getTPPreviewLabelText();
      const textW = ctx.measureText(labelText).width;
      const labelW = textW + 20;
      const labelH = 14;
      const labelX = plotArea.left + 10;
      const labelY = tpY - labelH / 2;

      ctx.fillStyle = "#0f9d58E6";
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(labelX, labelY, labelW, labelH, 3);
        ctx.fill();
      } else {
        ctx.fillRect(labelX, labelY, labelW, labelH);
      }
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(labelText, labelX + 3, tpY);

      const dividerX_tp = labelX + textW + 4;
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(dividerX_tp, labelY);
      ctx.lineTo(dividerX_tp, labelY + labelH);
      ctx.stroke();

      const isTPCloseHovered =
        hoveredObject &&
        hoveredObject.type === "preview_close_btn" &&
        hoveredObject.lineType === "tp";
      ctx.fillStyle = isTPCloseHovered ? "#ffccd5" : "#ffffff";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("✕", dividerX_tp + 8, tpY);

      // Draw scale label
      const scaleY_tp = tpY - scaleH / 2;
      ctx.fillStyle = "#0f9d58";
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(scaleX, scaleY_tp, scaleW, scaleH, 3);
      else ctx.rect(scaleX, scaleY_tp, scaleW, scaleH);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 9px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(tp.toFixed(5), scaleX + scaleW / 2, tpY);
    }
  }

  // 3. Draw SL line (if enabled and present)
  if (state.orderPreviewSLEnabled && sl) {
    const slY = candlestickSeries.priceToCoordinate(sl);
    if (
      slY !== null &&
      !isNaN(slY) &&
      slY >= plotArea.top &&
      slY <= plotArea.bottom
    ) {
      ctx.beginPath();
      ctx.strokeStyle = "#ef5350";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 4]);
      ctx.moveTo(plotArea.left, slY);
      ctx.lineTo(plotArea.right, slY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.font = "bold 9px Inter, sans-serif";
      const labelText = getSLPreviewLabelText();
      const textW = ctx.measureText(labelText).width;
      const labelW = textW + 20;
      const labelH = 14;
      const labelX = plotArea.left + 10;
      const labelY = slY - labelH / 2;

      ctx.fillStyle = "#ef5350E6";
      if (ctx.roundRect) {
        ctx.beginPath();
        ctx.roundRect(labelX, labelY, labelW, labelH, 3);
        ctx.fill();
      } else {
        ctx.fillRect(labelX, labelY, labelW, labelH);
      }
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(labelText, labelX + 3, slY);

      const dividerX_sl = labelX + textW + 4;
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(dividerX_sl, labelY);
      ctx.lineTo(dividerX_sl, labelY + labelH);
      ctx.stroke();

      const isSLCloseHovered =
        hoveredObject &&
        hoveredObject.type === "preview_close_btn" &&
        hoveredObject.lineType === "sl";
      ctx.fillStyle = isSLCloseHovered ? "#ffccd5" : "#ffffff";
      ctx.font = "9px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("✕", dividerX_sl + 8, slY);

      // Draw scale label
      const scaleY_sl = slY - scaleH / 2;
      ctx.fillStyle = "#ef5350";
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(scaleX, scaleY_sl, scaleW, scaleH, 3);
      else ctx.rect(scaleX, scaleY_sl, scaleW, scaleH);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 9px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(sl.toFixed(5), scaleX + scaleW / 2, slY);
    }
  }

  ctx.restore();
}

function drawOrderPreview(ctx) {
  // No more preview mode drawn separate from active positions
}

function calculatePnlForLevel(pos, targetPrice) {
  if (!pos || !targetPrice) return 0;
  const units = (pos.size || 1.0) * 100000;
  let pnl = 0;
  if (pos.type === "buy" || pos.type === "Long" || pos.type === "long") {
    pnl = (targetPrice - pos.entryPrice) * units;
  } else {
    pnl = (pos.entryPrice - targetPrice) * units;
  }
  const isJpy = state.symbol && (state.symbol.endsWith("_JPY") || state.symbol.includes("JPY"));
  if (isJpy) {
    pnl = pnl / targetPrice;
  }
  return pnl;
}

function getInitialTpSlStep() {
  const isJpy = state.symbol && (state.symbol.endsWith("_JPY") || state.symbol.includes("JPY"));
  return isJpy ? 1.00 : 0.00100;
}

function getButtonUnderMouse(mouseX, mouseY) {
  if (!state.positions || state.positions.length === 0) return null;
  for (let i = 0; i < state.positions.length; i++) {
    const pos = state.positions[i];
    const entryBounds = getPositionLabelBounds(pos, "entry");
    if (!entryBounds) continue;

    const y = entryBounds.yCenter;
    const btnH = 14;
    const btnW = 28;
    const btnY = y - btnH / 2;

    const tpBtnX = entryBounds.x + entryBounds.w + 6;
    const slBtnX = tpBtnX + 34;

    // Check TP button
    if (
      mouseX >= tpBtnX &&
      mouseX <= tpBtnX + btnW &&
      mouseY >= btnY &&
      mouseY <= btnY + btnH
    ) {
      return { type: "TP_btn", posId: pos.id, position: pos };
    }

    // Check SL button
    if (
      mouseX >= slBtnX &&
      mouseX <= slBtnX + btnW &&
      mouseY >= btnY &&
      mouseY <= btnY + btnH
    ) {
      return { type: "SL_btn", posId: pos.id, position: pos };
    }

    // Check Confirm button
    if (pos.status === "draft") {
      const confirmBtnX = slBtnX + 34;
      const confirmBtnW = 60;
      if (
        mouseX >= confirmBtnX &&
        mouseX <= confirmBtnX + confirmBtnW &&
        mouseY >= btnY &&
        mouseY <= btnY + btnH
      ) {
        return { type: "CONFIRM_btn", posId: pos.id, position: pos };
      }
    }
  }
  return null;
}

function getPositionLabelBounds(pos, type) {
  const plotArea = getChartPlotArea();
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.font = "bold 10px Inter, sans-serif";

  let y = null;
  let text = "";
  const labelX = plotArea.left + 10;
  const labelH = 18;

  const isJpy = state.symbol && (state.symbol.endsWith("_JPY") || state.symbol.includes("JPY"));
  const decimals = isJpy ? 3 : 5;

  if (type === "entry") {
    y = candlestickSeries.priceToCoordinate(pos.entryPrice);
    if (pos.status === "draft") {
      text = ` [DRAFT] ${pos.type.toUpperCase()} ${pos.size} L @ ${pos.entryPrice.toFixed(decimals)} `;
    } else if (pos.status === "pending") {
      text = ` ${pos.type.toUpperCase()} ${pos.size} L @ ${pos.entryPrice.toFixed(decimals)} `;
    } else {
      let currPrice = pos.entryPrice;
      const arr = state.isBacktestActive
        ? state.backtestVisibleCandles
        : state.historicalCandles;
      if (arr.length > 0) currPrice = arr[arr.length - 1].close;
      let pnl = 0;
      const units = pos.size * 100000;
      if (pos.type === "buy") {
        pnl = (currPrice - pos.entryPrice) * units;
      } else {
        pnl = (pos.entryPrice - currPrice) * units;
      }
      if (pos.symbol.endsWith("_JPY")) pnl = pnl / currPrice;
      text = ` ${pos.type.toUpperCase()} ${pos.size} L @ ${pos.entryPrice.toFixed(decimals)} (${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}) `;
    }
  } else if (type === "tp") {
    if (!pos.takeProfit || pos.takeProfit <= 0) {
      ctx.restore();
      return null;
    }
    y = candlestickSeries.priceToCoordinate(pos.takeProfit);
    const tpPnl = calculatePnlForLevel(pos, pos.takeProfit);
    const sign = tpPnl >= 0 ? "+" : "";
    text = ` TP: ${pos.takeProfit.toFixed(decimals)} (${sign}${tpPnl.toFixed(2)} USD) `;
  } else if (type === "sl") {
    if (!pos.stopLoss || pos.stopLoss <= 0) {
      ctx.restore();
      return null;
    }
    y = candlestickSeries.priceToCoordinate(pos.stopLoss);
    const slPnl = calculatePnlForLevel(pos, pos.stopLoss);
    const sign = slPnl >= 0 ? "+" : "";
    text = ` SL: ${pos.stopLoss.toFixed(decimals)} (${sign}${slPnl.toFixed(2)} USD) `;
  }

  if (y === null || isNaN(y)) {
    ctx.restore();
    return null;
  }

  const textW = ctx.measureText(text).width;
  let labelW = textW + 24; // text plus divider and cross button space
  if (type === "entry") {
    let rrText = "RR: -";
    if (pos.takeProfit && pos.stopLoss && pos.takeProfit > 0 && pos.stopLoss > 0) {
      const tpDiff = Math.abs(pos.takeProfit - pos.entryPrice);
      const slDiff = Math.abs(pos.stopLoss - pos.entryPrice);
      if (slDiff > 0) {
        rrText = `RR: ${(tpDiff / slDiff).toFixed(1)}`;
      }
    }
    ctx.save();
    ctx.font = "bold 9px Inter, sans-serif";
    const rrTextW = ctx.measureText(rrText).width;
    ctx.restore();
    labelW += 20 + rrTextW + 4; // Space for second divider + rr text + padding
  }
  const labelY = y - labelH / 2;
  ctx.restore();

  return {
    x: labelX,
    y: labelY,
    w: labelW,
    h: labelH,
    yCenter: y,
    dividerX: labelX + textW + 4,
    textWidth: textW,
  };
}

function hexToRgba(hex, alpha) {
  let c;
  if(/^#([A-Fa-f0-9]{3}){1,2}$/.test(hex)){
    c= hex.substring(1).split('');
    if(c.length== 3){
      c= [c[0], c[0], c[1], c[1], c[2], c[2]];
    }
    c= '0x' + c.join('');
    return 'rgba('+[(c>>16)&255, (c>>8)&255, c&255].join(',')+','+alpha+')';
  }
  return 'rgba(59, 130, 246, ' + alpha + ')';
}

function drawAllOnCanvas() {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(
    0,
    0,
    canvas.width / (window.devicePixelRatio || 1),
    canvas.height / (window.devicePixelRatio || 1),
  );

  renderDrawings(ctx);

  drawHistoricalTradesOnCanvas(ctx);
  drawOrderPreview(ctx);
  drawOHLCChOnCanvas(ctx);
  updateHTMLOverlays();
}

let isDrawAllScheduled = false;
function requestDrawAllOnCanvas() {
  if (!isDrawAllScheduled) {
    isDrawAllScheduled = true;
    requestAnimationFrame(() => {
      isDrawAllScheduled = false;
      drawAllOnCanvas();
    });
  }
}

const CURRENCY_FLAGS = {
  "EUR": "https://flagcdn.com/w40/eu.png",
  "USD": "https://flagcdn.com/w40/us.png",
  "GBP": "https://flagcdn.com/w40/gb.png",
  "JPY": "https://flagcdn.com/w40/jp.png",
  "CAD": "https://flagcdn.com/w40/ca.png",
  "AUD": "https://flagcdn.com/w40/au.png",
  "CHF": "https://flagcdn.com/w40/ch.png",
  "NZD": "https://flagcdn.com/w40/nz.png"
};

const flagImageCache = {};

function getFlagImage(currency) {
  const url = CURRENCY_FLAGS[currency];
  if (!url) return null;
  if (!flagImageCache[currency]) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = url + "?cors=1";
    img.onload = () => {
      if (typeof drawAllOnCanvas === "function") {
        drawAllOnCanvas();
      }
    };
    img.onerror = () => {
      console.warn("Failed to load flag image with CORS for currency: " + currency + ", trying fallback without CORS...");
      const fallbackImg = new Image();
      fallbackImg.src = url;
      fallbackImg.onload = () => {
        flagImageCache[currency] = fallbackImg;
        if (typeof drawAllOnCanvas === "function") {
          drawAllOnCanvas();
        }
      };
      fallbackImg.onerror = () => {
        console.error("Failed to load flag image completely for currency: " + currency);
      };
    };
    flagImageCache[currency] = img;
  }
  return flagImageCache[currency];
}

function drawVectorFlag(ctx, currency, cx, cy, r) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.clip();

  const w = r * 2;
  const h = r * 2;
  const x = cx - r;
  const y = cy - r;

  switch (currency) {
    case "EUR": {
      // Blue background
      ctx.fillStyle = "#001489";
      ctx.fillRect(x, y, w, h);
      // Gold stars in a circle
      ctx.fillStyle = "#FFCC00";
      const numStars = 12;
      const starRadius = r * 0.12;
      const circleRadius = r * 0.55;
      for (let i = 0; i < numStars; i++) {
        const angle = (i * 2 * Math.PI) / numStars - Math.PI / 2;
        const sx = cx + Math.cos(angle) * circleRadius;
        const sy = cy + Math.sin(angle) * circleRadius;
        ctx.beginPath();
        ctx.arc(sx, sy, starRadius, 0, 2 * Math.PI);
        ctx.fill();
      }
      break;
    }
    case "USD": {
      // White background first
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(x, y, w, h);
      // 13 Stripes (red and white)
      ctx.fillStyle = "#B22234";
      const stripeH = h / 13;
      for (let i = 0; i < 13; i += 2) {
        ctx.fillRect(x, y + i * stripeH, w, stripeH);
      }
      // Blue Canton (top-left)
      ctx.fillStyle = "#3C3B6E";
      const cantonW = w * 0.5;
      const cantonH = stripeH * 7;
      ctx.fillRect(x, y, cantonW, cantonH);
      // Some tiny white stars
      ctx.fillStyle = "#FFFFFF";
      const starRows = 3;
      const starCols = 4;
      const stepX = cantonW / (starCols + 1);
      const stepY = cantonH / (starRows + 1);
      for (let rIdx = 1; rIdx <= starRows; rIdx++) {
        for (let cIdx = 1; cIdx <= starCols; cIdx++) {
          if ((rIdx + cIdx) % 2 === 0) {
            ctx.beginPath();
            ctx.arc(x + cIdx * stepX, y + rIdx * stepY, 0.6, 0, 2 * Math.PI);
            ctx.fill();
          }
        }
      }
      break;
    }
    case "JPY": {
      // White background
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(x, y, w, h);
      // Red disc
      ctx.fillStyle = "#BC002D";
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.55, 0, 2 * Math.PI);
      ctx.fill();
      break;
    }
    case "GBP": {
      // Blue background
      ctx.fillStyle = "#012169";
      ctx.fillRect(x, y, w, h);

      // St George's cross and saltires
      ctx.lineWidth = r * 0.3;
      ctx.strokeStyle = "#FFFFFF";
      
      // Diagonals (white)
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(x + w, y + h);
      ctx.moveTo(x + w, y); ctx.lineTo(x, y + h);
      ctx.stroke();

      // Diagonals (red)
      ctx.lineWidth = r * 0.12;
      ctx.strokeStyle = "#C8102E";
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(x + w, y + h);
      ctx.moveTo(x + w, y); ctx.lineTo(x, y + h);
      ctx.stroke();

      // Horizontal/Vertical white cross
      ctx.lineWidth = r * 0.45;
      ctx.strokeStyle = "#FFFFFF";
      ctx.beginPath();
      ctx.moveTo(cx, y); ctx.lineTo(cx, y + h);
      ctx.moveTo(x, cy); ctx.lineTo(x + w, cy);
      ctx.stroke();

      // Horizontal/Vertical red cross
      ctx.lineWidth = r * 0.25;
      ctx.strokeStyle = "#C8102E";
      ctx.beginPath();
      ctx.moveTo(cx, y); ctx.lineTo(cx, y + h);
      ctx.moveTo(x, cy); ctx.lineTo(x + w, cy);
      ctx.stroke();
      break;
    }
    case "CAD": {
      // Red sides, white center
      ctx.fillStyle = "#FF0000";
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(x + w * 0.25, y, w * 0.5, h);

      // Red maple leaf (stylized)
      ctx.fillStyle = "#FF0000";
      ctx.beginPath();
      const leafSize = r * 0.45;
      ctx.moveTo(cx, cy - leafSize);
      ctx.lineTo(cx + leafSize * 0.2, cy - leafSize * 0.3);
      ctx.lineTo(cx + leafSize * 0.5, cy - leafSize * 0.4);
      ctx.lineTo(cx + leafSize * 0.4, cy);
      ctx.lineTo(cx + leafSize * 0.7, cy + leafSize * 0.1);
      ctx.lineTo(cx + leafSize * 0.3, cy + leafSize * 0.3);
      ctx.lineTo(cx + leafSize * 0.1, cy + leafSize * 0.2);
      ctx.lineTo(cx, cy + leafSize * 0.6); // stem
      ctx.lineTo(cx - leafSize * 0.1, cy + leafSize * 0.2);
      ctx.lineTo(cx - leafSize * 0.3, cy + leafSize * 0.3);
      ctx.lineTo(cx - leafSize * 0.7, cy + leafSize * 0.1);
      ctx.lineTo(cx - leafSize * 0.4, cy);
      ctx.lineTo(cx - leafSize * 0.5, cy - leafSize * 0.4);
      ctx.lineTo(cx - leafSize * 0.2, cy - leafSize * 0.3);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "CHF": {
      // Red background
      ctx.fillStyle = "#D52B1E";
      ctx.fillRect(x, y, w, h);
      // White cross
      ctx.fillStyle = "#FFFFFF";
      const crossW = w * 0.6;
      const crossThick = w * 0.18;
      ctx.fillRect(cx - crossW / 2, cy - crossThick / 2, crossW, crossThick);
      ctx.fillRect(cx - crossThick / 2, cy - crossW / 2, crossThick, crossW);
      break;
    }
    case "XAU": {
      // Background color requested by the user
      ctx.fillStyle = "rgb(173, 136, 0)";
      ctx.fillRect(x, y, w, h);

      // Scale factor to scale the 24x24 SVG path perfectly inside the circular bounds
      const S = (r * 1.33) / 24;

      // Draw the exact path provided: M4 6L8 3H16L20 6V18L16 21H8L4 18V6Z
      ctx.beginPath();
      ctx.moveTo(cx - 8 * S, cy - 6 * S);   // M4 6
      ctx.lineTo(cx - 4 * S, cy - 9 * S);   // L8 3
      ctx.lineTo(cx + 4 * S, cy - 9 * S);   // H16
      ctx.lineTo(cx + 8 * S, cy - 6 * S);   // L20 6
      ctx.lineTo(cx + 8 * S, cy + 6 * S);   // V18
      ctx.lineTo(cx + 4 * S, cy + 9 * S);   // L16 21
      ctx.lineTo(cx - 4 * S, cy + 9 * S);   // H8
      ctx.lineTo(cx - 8 * S, cy + 6 * S);   // L4 18
      ctx.closePath();

      // Fill with requested Gold color (#FFD700)
      ctx.fillStyle = "#FFD700";
      ctx.fill();

      // Stroke with black border and round joins
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = Math.max(1, r * 0.08);
      ctx.lineJoin = "round";
      ctx.stroke();

      break;
    }
    case "AUD":
    case "NZD": {
      // Blue background
      ctx.fillStyle = "#012169";
      ctx.fillRect(x, y, w, h);

      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w * 0.5, h * 0.5);
      ctx.clip();
      
      const cw = w * 0.5;
      const ch = h * 0.5;
      const ccx = x + cw / 2;
      const ccy = y + ch / 2;

      ctx.lineWidth = r * 0.15;
      ctx.strokeStyle = "#FFFFFF";
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(x + cw, y + ch);
      ctx.moveTo(x + cw, y); ctx.lineTo(x, y + ch);
      ctx.stroke();

      ctx.lineWidth = r * 0.06;
      ctx.strokeStyle = "#C8102E";
      ctx.beginPath();
      ctx.moveTo(x, y); ctx.lineTo(x + cw, y + ch);
      ctx.moveTo(x + cw, y); ctx.lineTo(x, y + ch);
      ctx.stroke();

      ctx.lineWidth = r * 0.22;
      ctx.strokeStyle = "#FFFFFF";
      ctx.beginPath();
      ctx.moveTo(ccx, y); ctx.lineTo(ccx, y + ch);
      ctx.moveTo(x, ccy); ctx.lineTo(x + cw, ccy);
      ctx.stroke();

      ctx.lineWidth = r * 0.12;
      ctx.strokeStyle = "#C8102E";
      ctx.beginPath();
      ctx.moveTo(ccx, y); ctx.lineTo(ccx, y + ch);
      ctx.moveTo(x, ccy); ctx.lineTo(x + cw, ccy);
      ctx.stroke();

      ctx.restore();

      ctx.fillStyle = currency === "AUD" ? "#FFFFFF" : "#CC0000";
      if (currency === "NZD") {
        ctx.strokeStyle = "#FFFFFF";
        ctx.lineWidth = 0.5;
      }
      
      const stars = [
        { sx: x + w * 0.75, sy: y + h * 0.25 },
        { sx: x + w * 0.88, sy: y + h * 0.5 },
        { sx: x + w * 0.75, sy: y + h * 0.78 },
        { sx: x + w * 0.62, sy: y + h * 0.55 }
      ];
      
      stars.forEach(s => {
        ctx.beginPath();
        ctx.arc(s.sx, s.sy, 1, 0, 2 * Math.PI);
        ctx.fill();
        if (currency === "NZD") {
          ctx.stroke();
        }
      });
      break;
    }
    default: {
      ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 8px 'JetBrains Mono', monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(currency.slice(0, 2), cx, cy);
    }
  }

  ctx.restore();
}

function drawFlagCircle(ctx, currency, cx, cy, r) {
  drawVectorFlag(ctx, currency, cx, cy, r);

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawFlags(ctx, symbolStr, x, y) {
  const cleanSymbol = symbolStr.replace("_", "/");
  const parts = cleanSymbol.split("/");
  
  const radius = 9;
  const centerY = y + 5.5;
  
  if (parts.length >= 2) {
    const curr1 = parts[0];
    const curr2 = parts[1];
    
    // Draw first flag
    drawFlagCircle(ctx, curr1, x + radius, centerY, radius);
    
    // Cutout circle background
    ctx.beginPath();
    ctx.arc(x + radius + 11, centerY, radius + 1, 0, 2 * Math.PI);
    ctx.fillStyle = "#131722"; // Chart background color
    ctx.fill();
    
    // Draw second flag
    drawFlagCircle(ctx, curr2, x + radius + 11, centerY, radius);
    
    return radius * 2 + 11;
  } else {
    drawFlagCircle(ctx, cleanSymbol.slice(0, 3), x + radius, centerY, radius);
    return radius * 2;
  }
}

function drawOHLCChOnCanvas(ctx) {
  const plotArea = getChartPlotArea();
  if (!plotArea) return;

  let candle = canvasCurrentCandle;
  if (!candle) {
    const arr = state.isBacktestActive
      ? state.backtestVisibleCandles
      : state.historicalCandles;
    if (arr && arr.length > 0) {
      candle = arr[arr.length - 1];
    }
  }

  if (!candle) return;

  const o = typeof candle.open === "number" ? candle.open.toFixed(5) : "—";
  const h = typeof candle.high === "number" ? candle.high.toFixed(5) : "—";
  const l = typeof candle.low === "number" ? candle.low.toFixed(5) : "—";
  const c = typeof candle.close === "number" ? candle.close.toFixed(5) : "—";

  const isUp = (candle.close >= candle.open);
  const candleColor = isUp ? "#10b981" : "#ef4444";

  let chText = "—";
  if (typeof candle.open === "number" && typeof candle.close === "number") {
    const diff = candle.close - candle.open;
    const pct = (diff / candle.open) * 100;
    const sign = diff >= 0 ? "+" : "";
    chText = `${sign}${diff.toFixed(5)} (${sign}${pct.toFixed(2)}%)`;
  }

  ctx.save();
  ctx.font = "bold 11px 'JetBrains Mono', 'Fira Code', monospace";
  ctx.textBaseline = "top";

  let x = plotArea.left + 12;
  const y = plotArea.top + 10;

  // 1. Отрисовка круглых флагов валютной пары
  const symbolStr = (state.symbol || (pairSelector ? pairSelector.value : "EUR_USD")).replace("_", "/");
  const flagsWidth = drawFlags(ctx, symbolStr, x, y);
  x += flagsWidth + 8;

  // 2. Шаблон строки: [Название пары] | [Таймфрейм] |
  const tf = state.timeframe || "15m";
  const displayTf = tf.replace("m", "м").replace("h", "ч").replace("d", "д").replace("w", "н").replace("M", "мес");
  const headerText = `${symbolStr} | ${displayTf} | `;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(headerText, x, y);
  x += ctx.measureText(headerText).width;

  // 3. Рисуем O, H, L, C, Ch с динамическими цветами
  const drawField = (label, value, valueColor) => {
    // Label
    ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
    ctx.fillText(label + " ", x, y);
    x += ctx.measureText(label + " ").width;

    // Value
    ctx.fillStyle = valueColor;
    ctx.fillText(value, x, y);
    x += ctx.measureText(value).width + 12;
  };

  drawField("O", o, candleColor);
  drawField("H", h, candleColor);
  drawField("L", l, candleColor);
  drawField("C", c, candleColor);
  drawField("Ch", chText, candleColor);

  ctx.restore();
}

function applyLineDashStyle(ctx, style) {
  if (style === "dashed") {
    ctx.setLineDash([5, 4]);
  } else if (style === "dotted") {
    ctx.setLineDash([2, 3]);
  } else {
    ctx.setLineDash([]);
  }
}

function getDefaultFibLevels() {
  return [
    { level: 0, color: "#787b86", enabled: true },
    { level: 0.236, color: "#f23645", enabled: true },
    { level: 0.382, color: "#ff9800", enabled: true },
    { level: 0.5, color: "#4caf50", enabled: true },
    { level: 0.618, color: "#089981", enabled: true },
    { level: 0.65, color: "#00bcd4", enabled: true },
    { level: 0.705, color: "#2962ff", enabled: true },
    { level: 0.786, color: "#ab47bc", enabled: true },
    { level: 1, color: "#787b86", enabled: true },
    { level: 1.272, color: "#9c27b0", enabled: true },
    { level: 1.414, color: "#673ab7", enabled: true },
    { level: 1.618, color: "#2196f3", enabled: true },
    { level: 2.618, color: "#f23645", enabled: true },
    { level: 3.618, color: "#ff9800", enabled: true },
    { level: 4.236, color: "#4caf50", enabled: true },
  ];
}

function createDefaultFib(startPoint, endPoint, color = "#3b82f6") {
  return {
    id: Math.random().toString(36).substr(2, 9),
    type: "fib",
    startPoint: startPoint,
    endPoint: endPoint,
    color: color,
    reverse: false,
    extendLeft: false,
    extendRight: false,
    lineWidth: 1,
    lineStyle: "solid",
    fillBackground: true,
    fillOpacity: 0.08,
    trendLine: {
      visible: true,
      color: "#787b86",
      width: 1,
      style: "dashed",
    },
    labels: {
      showCoeff: true,
      showPrices: true,
      showPercent: false,
      showPoints: true,
      showPips: true,
      position: "left",
      vPosition: "above",
      fontSize: 11,
    },
    levels: getDefaultFibLevels(),
  };
}

function calculateFibLevelPrice(fib, level) {
  const pA = fib.startPoint.price;
  const pB = fib.endPoint.price;
  if (!fib.reverse) {
    return pB + (pA - pB) * level;
  } else {
    return pA + (pB - pA) * level;
  }
}

function getFibLabelText(fib, lvlObj, levelPrice, decimals, pipSize, baseZeroPrice) {
  const labelsCfg = fib.labels || {};
  const parts = [];
  const subParts = [];

  if (labelsCfg.showCoeff !== false) {
    parts.push(`${lvlObj.level}`);
  }
  if (labelsCfg.showPercent) {
    parts.push(`${(lvlObj.level * 100).toFixed(1).replace(/\.0$/, "")}%`);
  }
  if (labelsCfg.showPrices !== false) {
    subParts.push(levelPrice.toFixed(decimals));
  }
  if (labelsCfg.showPoints !== false && labelsCfg.showPips !== false) {
    const pips = formatPips(Math.abs(levelPrice - baseZeroPrice) / pipSize);
    subParts.push(`${pips} pips`);
  }

  if (subParts.length > 0) {
    if (parts.length > 0) {
      return `${parts.join(" ")} (${subParts.join(" | ")})`;
    } else {
      return subParts.join(" | ");
    }
  }

  return parts.join(" ") || `${lvlObj.level}`;
}

function drawFibonacciRetracement(ctx, fib, idx) {
  if (!fib || !fib.startPoint || !fib.endPoint) return;
  const startX = getXFromPoint(fib.startPoint);
  const startY = candlestickSeries.priceToCoordinate(fib.startPoint.price);
  const endX = getXFromPoint(fib.endPoint);
  const endY = candlestickSeries.priceToCoordinate(fib.endPoint.price);
  if (startX === null || startY === null || endX === null || endY === null) return;

  const plotArea = getChartPlotArea();
  if (!plotArea) return;
  const minSafeY = getOHLCBottomY();

  const isHovered = hoveredObject && (hoveredObject.type === "fib" || hoveredObject.type === "fib_handle") && hoveredObject.index === idx;
  const isSelected = activeSelectedObject && (activeSelectedObject.type === "fib" || activeSelectedObject.type === "fib_handle") && activeSelectedObject.index === idx;

  const currentSymbol = state.symbol || "EUR_USD";
  const decimals = typeof getSymbolDecimals === "function" ? getSymbolDecimals(currentSymbol) : 5;
  const pointSize = typeof getSymbolMinMove === "function" ? getSymbolMinMove(currentSymbol) : (decimals === 2 ? 0.01 : decimals === 3 ? 0.001 : 0.00001);
  const pipSize = typeof getSymbolPipSize === "function" ? getSymbolPipSize(currentSymbol) : pointSize * 10;
  const baseZeroPrice = fib.reverse ? fib.startPoint.price : fib.endPoint.price;

  const leftX = Math.min(startX, endX);
  const rightX = Math.max(startX, endX);

  const lineStartX = fib.extendLeft ? plotArea.left : leftX;
  const lineEndX = fib.extendRight ? plotArea.right : rightX;

  const rawLevels = fib.levels || getDefaultFibLevels();
  const enabledLevels = rawLevels
    .filter((lvl) => lvl.enabled !== false)
    .map((lvl) => {
      const price = calculateFibLevelPrice(fib, lvl.level);
      const y = candlestickSeries.priceToCoordinate(price);
      return {
        ...lvl,
        price,
        y,
      };
    })
    .filter((lvl) => lvl.y !== null);

  ctx.save();

  // 1. Draw Background Fills between adjacent levels
  if (fib.fillBackground !== false && enabledLevels.length > 1) {
    const sortedLevels = [...enabledLevels].sort((a, b) => a.level - b.level);
    const fillOpacity = typeof fib.fillOpacity === "number" ? fib.fillOpacity : 0.08;

    for (let i = 0; i < sortedLevels.length - 1; i++) {
      const l1 = sortedLevels[i];
      const l2 = sortedLevels[i + 1];
      const topY = Math.max(minSafeY, Math.min(l1.y, l2.y));
      const botY = Math.min(plotArea.bottom, Math.max(l1.y, l2.y));
      const fillHeight = botY - topY;

      if (fillHeight > 0 && lineEndX > lineStartX) {
        ctx.fillStyle = hexToRgba(l1.color || fib.color || "#3b82f6", fillOpacity);
        ctx.fillRect(lineStartX, topY, lineEndX - lineStartX, fillHeight);
      }
    }
  }

  // 2. Draw Trend Line between Point A and Point B
  if (!fib.trendLine || fib.trendLine.visible !== false) {
    ctx.beginPath();
    ctx.strokeStyle = (fib.trendLine && fib.trendLine.color) || "#787b86";
    ctx.lineWidth = (fib.trendLine && fib.trendLine.width) || 1;
    applyLineDashStyle(ctx, (fib.trendLine && fib.trendLine.style) || "dashed");
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 3. Draw Horizontal Level Lines & Labels
  const labelsCfg = fib.labels || {};
  const fontSize = labelsCfg.fontSize || 11;
  const labelPos = labelsCfg.position || "left";
  const labelVPos = labelsCfg.vPosition || "above";

  enabledLevels.forEach((lvl) => {
    const y = lvl.y;
    if (y < minSafeY - 20 || y > plotArea.bottom + 20) return;

    // Line
    ctx.beginPath();
    ctx.strokeStyle = lvl.color || fib.color || "#3b82f6";
    ctx.lineWidth = isHovered || isSelected ? (fib.lineWidth || 1) + 1.5 : fib.lineWidth || 1;
    applyLineDashStyle(ctx, fib.lineStyle || "solid");
    ctx.moveTo(lineStartX, y);
    ctx.lineTo(lineEndX, y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Label Text
    const labelText = getFibLabelText(fib, lvl, lvl.price, decimals, pipSize, baseZeroPrice);
    if (labelText) {
      ctx.font = `bold ${fontSize}px Inter, sans-serif`;
      const textMetrics = ctx.measureText(labelText);
      const textWidth = textMetrics.width;

      let textX = lineStartX + 6;
      if (labelPos === "center") {
        textX = (lineStartX + lineEndX) / 2;
        ctx.textAlign = "center";
      } else if (labelPos === "right") {
        textX = lineEndX - 6;
        ctx.textAlign = "right";
      } else {
        ctx.textAlign = "left";
      }

      let textY = y - 4;
      if (labelVPos === "middle") {
        textY = y;
        ctx.textBaseline = "middle";
      } else if (labelVPos === "below") {
        textY = y + 4;
        ctx.textBaseline = "top";
      } else {
        ctx.textBaseline = "bottom";
      }

      textY = Math.max(minSafeY + 12, textY);

      // Subtle background badge for text readability
      ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
      let badgeX = textX;
      if (labelPos === "center") badgeX = textX - textWidth / 2 - 3;
      else if (labelPos === "right") badgeX = textX - textWidth - 3;
      else badgeX = textX - 3;

      let badgeY = textY - fontSize;
      if (labelVPos === "middle") badgeY = textY - fontSize / 2 - 1;
      else if (labelVPos === "below") badgeY = textY;

      ctx.fillRect(badgeX, badgeY, textWidth + 6, fontSize + 4);

      ctx.fillStyle = lvl.color || fib.color || "#ffffff";
      ctx.fillText(labelText, textX, textY);
    }
  });

  // 4. Handles at Point A and Point B
  if (isHovered || isSelected) {
    drawHandle(ctx, startX, startY, "circle", fib.color || "#3b82f6");
    drawHandle(ctx, endX, endY, "circle", fib.color || "#3b82f6");
  }

  ctx.restore();
}

function drawLongPosition(ctx, pos, idx) {
  const startX = getXFromPosition(pos);
  if (startX === null) return;
  const entryY = candlestickSeries.priceToCoordinate(pos.entryPrice);
  const targetY = candlestickSeries.priceToCoordinate(pos.targetPrice);
  const stopY = candlestickSeries.priceToCoordinate(pos.stopPrice);
  if (entryY === null || targetY === null || stopY === null) return;

  const plotArea = getChartPlotArea();
  let barSpacing = getBarSpacing();
  const widthInCandles = pos.widthInCandles || 70;
  const width = Math.max(30, Math.round(widthInCandles * barSpacing));
  const endX = startX + width;
  const isLong = pos.type === "long" || pos.type === "Long" || pos.type === "buy";

  pos.hitBox = {
    x: startX,
    y: Math.min(entryY, targetY, stopY),
    width: width,
    height: Math.max(entryY, targetY, stopY) - Math.min(entryY, targetY, stopY),
  };
  pos.x = pos.hitBox.x;
  pos.y = pos.hitBox.y;
  pos.width = pos.hitBox.width;
  pos.height = pos.hitBox.height;

  ctx.save();

  // (а) Ограничение зоны по ширине конкретным диапазоном X-координат (от startX до endX)
  // (б) Раздельные красная (риск) и зелёная (прибыль) заливки с чёткой горизонтальной границей на уровне entry
  const greenTopY = isLong ? targetY : entryY;
  const greenHeight = Math.abs(entryY - targetY);
  ctx.fillStyle = "rgba(38, 166, 154, 0.22)";
  ctx.fillRect(startX, greenTopY, width, greenHeight);
  ctx.strokeStyle = "rgba(38, 166, 154, 0.75)";
  ctx.lineWidth = 1;
  ctx.strokeRect(startX, greenTopY, width, greenHeight);

  const redTopY = isLong ? entryY : stopY;
  const redHeight = Math.abs(entryY - stopY);
  ctx.fillStyle = "rgba(239, 83, 80, 0.22)";
  ctx.fillRect(startX, redTopY, width, redHeight);
  ctx.strokeStyle = "rgba(239, 83, 80, 0.75)";
  ctx.lineWidth = 1;
  ctx.strokeRect(startX, redTopY, width, redHeight);

  // Горизонтальная линия входа
  ctx.beginPath();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.moveTo(startX, entryY);
  ctx.lineTo(endX, entryY);
  ctx.stroke();
  ctx.setLineDash([]);

  // (в) Позиционирование текстовых подписей так, чтобы не перекрывать OHLC-строку
  const profitPct = Math.abs(
    ((pos.targetPrice - pos.entryPrice) / pos.entryPrice) * 100,
  );
  const lossPct = Math.abs(
    ((pos.stopPrice - pos.entryPrice) / pos.entryPrice) * 100,
  );
  const rr = lossPct > 0 ? (profitPct / lossPct).toFixed(2) : "0.00";

  const currentSymbol = (state && state.symbol) || "EUR_USD";
  const decimals = typeof getSymbolDecimals === "function" ? getSymbolDecimals(currentSymbol) : 5;
  const pointSize = typeof getSymbolMinMove === "function" ? getSymbolMinMove(currentSymbol) : (decimals === 2 ? 0.01 : decimals === 3 ? 0.001 : 0.00001);
  const pipSize = typeof getSymbolPipSize === "function" ? getSymbolPipSize(currentSymbol) : pointSize * 10;
  const targetPips = formatPips(Math.abs(pos.entryPrice - pos.targetPrice) / pipSize);
  const stopPips = formatPips(Math.abs(pos.entryPrice - pos.stopPrice) / pipSize);

  const tpText = `Цель: ${pos.targetPrice.toFixed(decimals)} (${profitPct.toFixed(2)}%) | ${targetPips} pips`;
  const slText = `Стоп: ${pos.stopPrice.toFixed(decimals)} (${lossPct.toFixed(2)}%) | ${stopPips} pips`;
  const rrText = `R/R: ${rr}`;

  // Безопасный отступ от верхней панели OHLC (plotArea.top + 40px)
  const minSafeY = (plotArea ? plotArea.top : 0) + 40;

  let timeScaleHeight = 28;
  try {
    if (typeof chart !== "undefined" && chart && chart.timeScale && typeof chart.timeScale().height === "function") {
      const h = chart.timeScale().height();
      if (typeof h === "number" && h > 0) timeScaleHeight = h;
    }
  } catch (e) {}

  const dpr = window.devicePixelRatio || 1;
  const canvasCssHeight = (typeof canvas !== "undefined" && canvas)
    ? canvas.height / dpr
    : ((typeof container !== "undefined" && container) ? container.clientHeight : 600);

  const maxSafeY = (canvasCssHeight - timeScaleHeight) - 16;

  ctx.font = "bold 12px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Подпись "Цель"
  const tpW = ctx.measureText(tpText).width + 14;
  const tpH = 22;
  const tpX = startX + width / 2 - tpW / 2;
  const rawTpY = isLong ? targetY - tpH / 2 - 4 : targetY + tpH / 2 + 4;
  const tpYPos = Math.min(maxSafeY, Math.max(minSafeY, rawTpY));

  ctx.fillStyle = "#26a69a";
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(tpX, tpYPos - tpH / 2, tpW, tpH, 4);
  } else {
    ctx.rect(tpX, tpYPos - tpH / 2, tpW, tpH);
  }
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(tpText, startX + width / 2, tpYPos);

  // Подпись "Стоп"
  const slW = ctx.measureText(slText).width + 14;
  const slH = 22;
  const slX = startX + width / 2 - slW / 2;
  const rawSlY = isLong ? stopY + slH / 2 + 4 : stopY - slH / 2 - 4;
  const slYPos = Math.min(maxSafeY, Math.max(minSafeY, rawSlY));

  ctx.fillStyle = "#ef5350";
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(slX, slYPos - slH / 2, slW, slH, 4);
  } else {
    ctx.rect(slX, slYPos - slH / 2, slW, slH);
  }
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(slText, startX + width / 2, slYPos);

  // Подпись "R/R"
  const rrW = ctx.measureText(rrText).width + 16;
  const rrH = 24;
  const rrX = startX + width / 2 - rrW / 2;
  const rrYPos = Math.min(maxSafeY, Math.max(minSafeY, entryY));

  ctx.fillStyle = "rgba(19, 23, 34, 0.9)";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(rrX, rrYPos - rrH / 2, rrW, rrH, 4);
  } else {
    ctx.rect(rrX, rrYPos - rrH / 2, rrW, rrH);
  }
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(rrText, startX + width / 2, rrYPos);

  ctx.restore();

  const isHovered =
    hoveredObject &&
    hoveredObject.type === "position" &&
    hoveredObject.index === idx;
  const isSelected =
    activeSelectedObject &&
    activeSelectedObject.type === "position" &&
    activeSelectedObject.index === idx;

  if (isHovered || isSelected) {
    const topY = isLong ? targetY : stopY;
    const botY = isLong ? stopY : targetY;
    drawHandle(ctx, startX, entryY, "circle", "#3b82f6");
    drawHandle(ctx, endX, entryY, "square", "#3b82f6");
    drawHandle(
      ctx,
      startX + width / 2,
      topY,
      "square",
      isLong ? "#10b981" : "#ef4444",
    );
    drawHandle(
      ctx,
      startX + width / 2,
      botY,
      "square",
      isLong ? "#ef4444" : "#10b981",
    );
  }
}

function renderDrawings(ctx) {
  const plotArea = getChartPlotArea();
  if (!plotArea) return;

  const topBoundary = getOHLCBottomY();

  ctx.save();
  ctx.beginPath();
  ctx.rect(
    plotArea.left,
    topBoundary,
    plotArea.width,
    Math.max(0, plotArea.bottom - topBoundary)
  );
  ctx.clip();

  drawings.brushPaths.forEach((path) => {
    if (path.points.length < 1) return;
    ctx.beginPath();
    ctx.strokeStyle = path.color || "#3b82f6";
    ctx.lineWidth = path.width || 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const pts = [];
    path.points.forEach((pt) => {
      const x = getXFromPoint(pt);
      const y = candlestickSeries.priceToCoordinate(pt.price);
      if (x !== null && y !== null) {
        pts.push({ x, y });
      }
    });
    path.screenPoints = pts;
    if (pts.length > 0) {
      ctx.moveTo(pts[0].x, pts[0].y);
      if (pts.length === 1) {
        ctx.lineTo(pts[0].x, pts[0].y);
      } else if (pts.length === 2) {
        ctx.lineTo(pts[1].x, pts[1].y);
      } else {
        for (let i = 1; i < pts.length - 1; i++) {
          const xc = (pts[i].x + pts[i + 1].x) / 2;
          const yc = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
        }
        ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      }
    }
    ctx.stroke();
  });

  if (
    isDrawingBrush &&
    currentBrushPath &&
    currentBrushPath.points.length >= 1
  ) {
    ctx.beginPath();
    ctx.strokeStyle = currentBrushPath.color;
    ctx.lineWidth = currentBrushPath.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const pts = [];
    currentBrushPath.points.forEach((pt) => {
      const x = getXFromPoint(pt);
      const y = candlestickSeries.priceToCoordinate(pt.price);
      if (x !== null && y !== null) {
        pts.push({ x, y });
      }
    });
    if (pts.length > 0) {
      ctx.moveTo(pts[0].x, pts[0].y);
      if (pts.length === 1) {
        ctx.lineTo(pts[0].x, pts[0].y);
      } else if (pts.length === 2) {
        ctx.lineTo(pts[1].x, pts[1].y);
      } else {
        for (let i = 1; i < pts.length - 1; i++) {
          const xc = (pts[i].x + pts[i + 1].x) / 2;
          const yc = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
        }
        ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
      }
    }
    ctx.stroke();
  }

  if (state.positions && state.positions.length > 0) {
    state.positions.forEach((pos) => {
      // 1. Draw Entry
      const y = candlestickSeries.priceToCoordinate(pos.entryPrice);
      if (y !== null && y >= plotArea.top && y <= plotArea.bottom) {
        const isEntryHovered =
          hoveredObject &&
          hoveredObject.id === pos.id &&
          (hoveredObject.type === "pos_entry" ||
            hoveredObject.type === "pos_active_entry");

        const isFocused =
          (hoveredObject && hoveredObject.id === pos.id) ||
          (draggedElement && draggedElement.orderId === pos.id) ||
          (hoveredElement && hoveredElement.orderId === pos.id);

        // Draw Profit/Loss background zones if focused (hovered/dragged)
        if (isFocused) {
          const isBuy = pos.type === "buy" || pos.type === "Long" || pos.type === "long";
          
          if (pos.takeProfit && pos.takeProfit > 0) {
            const tpY = candlestickSeries.priceToCoordinate(pos.takeProfit);
            if (tpY !== null) {
              const clampedTpY = Math.max(plotArea.top, Math.min(plotArea.bottom, tpY));
              ctx.fillStyle = "rgba(0, 150, 136, 0.2)"; // transparent green
              const fillTop = Math.min(y, clampedTpY);
              const fillHeight = Math.abs(y - clampedTpY);
              ctx.fillRect(plotArea.left, fillTop, plotArea.width, fillHeight);
            }
          }

          if (pos.stopLoss && pos.stopLoss > 0) {
            const slY = candlestickSeries.priceToCoordinate(pos.stopLoss);
            if (slY !== null) {
              const clampedSlY = Math.max(plotArea.top, Math.min(plotArea.bottom, slY));
              ctx.fillStyle = "rgba(255, 82, 82, 0.2)"; // transparent red
              const fillTop = Math.min(y, clampedSlY);
              const fillHeight = Math.abs(y - clampedSlY);
              ctx.fillRect(plotArea.left, fillTop, plotArea.width, fillHeight);
            }
          }
        }

        ctx.beginPath();
        ctx.strokeStyle =
          pos.type === "buy"
            ? "#26a69a" // Blue-green for Buy
            : "#ef5350"; // Red for Sell
        ctx.lineWidth = isEntryHovered ? 2.5 : 1.5;
        if (pos.status === "draft") {
          ctx.setLineDash([2, 3]);
        } else if (pos.status === "pending") {
          ctx.setLineDash([4, 4]);
        } else {
          ctx.setLineDash([8, 4]);
        }
        ctx.moveTo(plotArea.left, y);
        ctx.lineTo(plotArea.right, y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw Label
        const bounds = getPositionLabelBounds(pos, "entry");
        if (bounds) {
          ctx.save();
          ctx.font = "bold 10px Inter, sans-serif";

          // Background - aligned to transaction direction (Buy vs Sell)
          ctx.fillStyle =
            pos.type === "buy"
              ? "rgba(38, 166, 154, 0.95)" // blue-green
              : "rgba(239, 83, 80, 0.95)"; // red
          if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(bounds.x, bounds.y, bounds.w, bounds.h, 4);
            ctx.fill();
          } else {
            ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
          }

          // Highlight close btn if hovered
          const isCloseHovered =
            hoveredObject &&
            hoveredObject.id === pos.id &&
            hoveredObject.type === "pos_close_btn" &&
            hoveredObject.lineType === "entry";

          // Draw Text
          ctx.fillStyle = "#ffffff";
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";

          const isJpy = state.symbol && (state.symbol.endsWith("_JPY") || state.symbol.includes("JPY"));
          const decimals = isJpy ? 3 : 5;

          let text = "";
          if (pos.status === "draft") {
            text = ` [DRAFT] ${pos.type.toUpperCase()} ${pos.size} L @ ${pos.entryPrice.toFixed(decimals)} `;
          } else if (pos.status === "pending") {
            text = ` ${pos.type.toUpperCase()} ${pos.size} L @ ${pos.entryPrice.toFixed(decimals)} `;
          } else {
            let currPrice = pos.entryPrice;
            const arr = state.isBacktestActive
              ? state.backtestVisibleCandles
              : state.historicalCandles;
            if (arr.length > 0) currPrice = arr[arr.length - 1].close;
            let pnl = 0;
            const units = pos.size * 100000;
            if (pos.type === "buy") {
              pnl = (currPrice - pos.entryPrice) * units;
            } else {
              pnl = (pos.entryPrice - currPrice) * units;
            }
            if (pos.symbol.endsWith("_JPY")) pnl = pnl / currPrice;
            text = ` ${pos.type.toUpperCase()} ${pos.size} L @ ${pos.entryPrice.toFixed(decimals)} (${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}) `;
          }
          ctx.fillText(text, bounds.x + 2, y);

          // Divider Line
          ctx.strokeStyle = "rgba(255,255,255,0.25)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(bounds.dividerX, bounds.y);
          ctx.lineTo(bounds.dividerX, bounds.y + bounds.h);
          ctx.stroke();

          // [X] Close button
          ctx.fillStyle = isCloseHovered ? "#ffccd5" : "#ffffff";
          ctx.font = "10px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("✕", bounds.dividerX + 10, y);

          // Divider 2 (for RR)
          ctx.strokeStyle = "rgba(255,255,255,0.25)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(bounds.dividerX + 20, bounds.y);
          ctx.lineTo(bounds.dividerX + 20, bounds.y + bounds.h);
          ctx.stroke();

          // Draw RR block background (embedded dark pill/badge)
          const rrPillX = bounds.dividerX + 21;
          const rrPillY = bounds.y + 2;
          const rrPillW = (bounds.x + bounds.w) - rrPillX - 2;
          const rrPillH = bounds.h - 4;

          ctx.fillStyle = "#131722"; // Chart background color (neutral dark)
          if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(rrPillX, rrPillY, rrPillW, rrPillH, 3);
            ctx.fill();
          } else {
            ctx.fillRect(rrPillX, rrPillY, rrPillW, rrPillH);
          }

          // Subtle border around the RR block
          ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
          ctx.lineWidth = 1;
          if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(rrPillX, rrPillY, rrPillW, rrPillH, 3);
            ctx.stroke();
          } else {
            ctx.strokeRect(rrPillX, rrPillY, rrPillW, rrPillH);
          }

          // RR Text
          let rrText = "RR: -";
          if (pos.takeProfit && pos.stopLoss && pos.takeProfit > 0 && pos.stopLoss > 0) {
            const tpDiff = Math.abs(pos.takeProfit - pos.entryPrice);
            const slDiff = Math.abs(pos.stopLoss - pos.entryPrice);
            if (slDiff > 0) {
              rrText = `RR: ${(tpDiff / slDiff).toFixed(1)}`;
            }
          }
          ctx.fillStyle = "#f0f3fa"; // Clear light gray / white text for maximum contrast
          ctx.font = "bold 9px Inter, sans-serif";
          ctx.textAlign = "center";
          ctx.fillText(rrText, rrPillX + rrPillW / 2, y);

          // Draw ALWAYS visible "ТП" and "СЛ" buttons next to the Entry label
          const btnW = 28;
          const btnH = 14;
          const btnY = y - btnH / 2;
          const tpBtnX = bounds.x + bounds.w + 6;
          const slBtnX = tpBtnX + 34;

          ctx.font = "bold 9px Inter, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";

          // ТП Button
          const tpActive = pos.takeProfit && pos.takeProfit > 0;
          ctx.fillStyle = tpActive ? "#009688" : "rgba(255, 255, 255, 0.15)";
          if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(tpBtnX, btnY, btnW, btnH, 3);
            ctx.fill();
          } else {
            ctx.fillRect(tpBtnX, btnY, btnW, btnH);
          }
          ctx.fillStyle = tpActive ? "#ffffff" : "#cccccc";
          ctx.fillText("ТП", tpBtnX + btnW / 2, y);

          if (!tpActive) {
            ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
            ctx.lineWidth = 0.8;
            ctx.strokeRect(tpBtnX, btnY, btnW, btnH);
          }

          // СЛ Button
          const slActive = pos.stopLoss && pos.stopLoss > 0;
          ctx.fillStyle = slActive ? "#ff5252" : "rgba(255, 255, 255, 0.15)";
          if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(slBtnX, btnY, btnW, btnH, 3);
            ctx.fill();
          } else {
            ctx.fillRect(slBtnX, btnY, btnW, btnH);
          }
          ctx.fillStyle = slActive ? "#ffffff" : "#cccccc";
          ctx.fillText("СЛ", slBtnX + btnW / 2, y);

          if (!slActive) {
            ctx.strokeStyle = "rgba(255, 255, 255, 0.3)";
            ctx.lineWidth = 0.8;
            ctx.strokeRect(slBtnX, btnY, btnW, btnH);
          }

          // Confirm button
          if (pos.status === "draft") {
            const confirmBtnX = slBtnX + 34;
            const confirmBtnW = 60;
            const isConfirmHovered =
              hoveredObject &&
              hoveredObject.id === pos.id &&
              hoveredObject.type === "pos_confirm_btn";

            ctx.fillStyle = isConfirmHovered ? "#2e7d32" : "#4caf50";
            if (ctx.roundRect) {
              ctx.beginPath();
              ctx.roundRect(confirmBtnX, btnY, confirmBtnW, btnH, 3);
              ctx.fill();
            } else {
              ctx.fillRect(confirmBtnX, btnY, confirmBtnW, btnH);
            }
            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 8px Inter, sans-serif";
            ctx.fillText("CONFIRM", confirmBtnX + confirmBtnW / 2, y);
          }

          ctx.restore();
        }
      }

      // 2. Draw TP
      if (pos.takeProfit && pos.takeProfit > 0) {
        const tpY = candlestickSeries.priceToCoordinate(pos.takeProfit);
        if (tpY !== null && tpY >= plotArea.top && tpY <= plotArea.bottom) {
          const isTPHovered =
            hoveredObject &&
            hoveredObject.id === pos.id &&
            hoveredObject.type === "pos_tp";
          ctx.beginPath();
          ctx.strokeStyle = "#26a69a"; // green
          ctx.lineWidth = isTPHovered ? 2.5 : 1.2;
          ctx.setLineDash([3, 3]);
          ctx.moveTo(plotArea.left, tpY);
          ctx.lineTo(plotArea.right, tpY);
          ctx.stroke();
          ctx.setLineDash([]);

          // Draw Label
          const bounds = getPositionLabelBounds(pos, "tp");
          if (bounds) {
            ctx.save();
            ctx.font = "bold 9px Inter, sans-serif";

            // Background
            ctx.fillStyle = "rgba(38, 166, 154, 0.95)";
            if (ctx.roundRect) {
              ctx.beginPath();
              ctx.roundRect(bounds.x, bounds.y, bounds.w, bounds.h, 3);
              ctx.fill();
            } else {
              ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
            }

            const isCloseHovered =
              hoveredObject &&
              hoveredObject.id === pos.id &&
              hoveredObject.type === "pos_close_btn" &&
              hoveredObject.lineType === "tp";

            const tpPnl = calculatePnlForLevel(pos, pos.takeProfit);
            const sign = tpPnl >= 0 ? "+" : "";
            const isJpy = state.symbol && (state.symbol.endsWith("_JPY") || state.symbol.includes("JPY"));
            const decimals = isJpy ? 3 : 5;

            // Draw Text with USD calculated in real-time
            ctx.fillStyle = "#ffffff";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(
              ` TP: ${pos.takeProfit.toFixed(decimals)} (${sign}${tpPnl.toFixed(2)} USD) `,
              bounds.x + 2,
              tpY,
            );

            // Divider Line
            ctx.strokeStyle = "rgba(255,255,255,0.25)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(bounds.dividerX, bounds.y);
            ctx.lineTo(bounds.dividerX, bounds.y + bounds.h);
            ctx.stroke();

            // [X] Close button
            ctx.fillStyle = isCloseHovered ? "#ffccd5" : "#ffffff";
            ctx.font = "9px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("✕", bounds.dividerX + 9, tpY);

            ctx.restore();
          }
        }
      }

      // 3. Draw SL
      if (pos.stopLoss && pos.stopLoss > 0) {
        const slY = candlestickSeries.priceToCoordinate(pos.stopLoss);
        if (slY !== null && slY >= plotArea.top && slY <= plotArea.bottom) {
          const isSLHovered =
            hoveredObject &&
            hoveredObject.id === pos.id &&
            hoveredObject.type === "pos_sl";
          ctx.beginPath();
          ctx.strokeStyle = "#ef5350"; // red
          ctx.lineWidth = isSLHovered ? 2.5 : 1.2;
          ctx.setLineDash([3, 3]);
          ctx.moveTo(plotArea.left, slY);
          ctx.lineTo(plotArea.right, slY);
          ctx.stroke();
          ctx.setLineDash([]);

          // Draw Label
          const bounds = getPositionLabelBounds(pos, "sl");
          if (bounds) {
            ctx.save();
            ctx.font = "bold 9px Inter, sans-serif";

            // Background
            ctx.fillStyle = "rgba(239, 83, 80, 0.95)";
            if (ctx.roundRect) {
              ctx.beginPath();
              ctx.roundRect(bounds.x, bounds.y, bounds.w, bounds.h, 3);
              ctx.fill();
            } else {
              ctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
            }

            const isCloseHovered =
              hoveredObject &&
              hoveredObject.id === pos.id &&
              hoveredObject.type === "pos_close_btn" &&
              hoveredObject.lineType === "sl";

            const slPnl = calculatePnlForLevel(pos, pos.stopLoss);
            const sign = slPnl >= 0 ? "+" : "";
            const isJpy = state.symbol && (state.symbol.endsWith("_JPY") || state.symbol.includes("JPY"));
            const decimals = isJpy ? 3 : 5;

            // Draw Text with USD calculated in real-time
            ctx.fillStyle = "#ffffff";
            ctx.textAlign = "left";
            ctx.textBaseline = "middle";
            ctx.fillText(
              ` SL: ${pos.stopLoss.toFixed(decimals)} (${sign}${slPnl.toFixed(2)} USD) `,
              bounds.x + 2,
              slY,
            );

            // Divider Line
            ctx.strokeStyle = "rgba(255,255,255,0.25)";
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(bounds.dividerX, bounds.y);
            ctx.lineTo(bounds.dividerX, bounds.y + bounds.h);
            ctx.stroke();

            // [X] Close button
            ctx.fillStyle = isCloseHovered ? "#ffccd5" : "#ffffff";
            ctx.font = "9px sans-serif";
            ctx.textAlign = "center";
            ctx.fillText("✕", bounds.dividerX + 9, slY);

            ctx.restore();
          }
        }
      }
    });
  }
  ctx.restore();

  drawings.positions.forEach((pos, idx) => {
    drawLongPosition(ctx, pos, idx);
  });

  if (drawings.horizontalLines) {
    const canvasWidth = canvas.width / (window.devicePixelRatio || 1);
    drawings.horizontalLines.forEach((line) => {
      const y = candlestickSeries.priceToCoordinate(line.price);
      if (y !== null) {
        line.hitBox = { x: 0, y: y - 8, width: canvasWidth, height: 16 };
        line.x = line.hitBox.x;
        line.y = line.hitBox.y;
        line.width = line.hitBox.width;
        line.height = line.hitBox.height;
        ctx.beginPath();
        ctx.strokeStyle = line.color || "#3b82f6";
        ctx.lineWidth = 1.5;
        ctx.moveTo(0, y);
        ctx.lineTo(canvasWidth, y);
        ctx.stroke();
        ctx.fillStyle = line.color || "#3b82f6";
        ctx.font = "10px Inter, sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText(`— ${line.price.toFixed(5)}`, canvasWidth - 75, y - 6);
      }
    });
  }

  if (drawings.waitLevels) {
    const canvasWidth = canvas.width / (window.devicePixelRatio || 1);
    drawings.waitLevels.forEach((level, idx) => {
      const y = candlestickSeries.priceToCoordinate(level.price);
      if (y !== null) {
        level.hitBox = { x: 0, y: y - 8, width: canvasWidth, height: 16 };
        level.x = level.hitBox.x;
        level.y = level.hitBox.y;
        level.width = level.hitBox.width;
        level.height = level.hitBox.height;

        const isSelected =
          activeSelectedObject &&
          activeSelectedObject.type === "wait_level" &&
          activeSelectedObject.index === idx;
        const isHovered =
          hoveredObject &&
          (hoveredObject.type === "wait_level" || hoveredObject.type === "wait_level_ff") &&
          hoveredObject.index === idx;

        const color = level.color || "#f59e0b";

        ctx.save();
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = isSelected || isHovered ? 2.5 : 1.75;
        ctx.setLineDash([8, 4]);
        ctx.moveTo(0, y);
        ctx.lineTo(canvasWidth, y);
        ctx.stroke();
        ctx.setLineDash([]);

        // Interactive "⏩ Перемотка" button badge
        const badgeW = 150;
        const badgeH = 22;
        const badgeX = canvasWidth - badgeW - 90;
        const badgeY = y - badgeH / 2;
        level.ffBtnHitBox = { x: badgeX, y: badgeY, width: badgeW, height: badgeH };

        const isBtnHovered =
          hoveredObject &&
          hoveredObject.type === "wait_level_ff" &&
          hoveredObject.index === idx;

        ctx.fillStyle = isBtnHovered
          ? "rgba(245, 158, 11, 0.45)"
          : isSelected
          ? "rgba(245, 158, 11, 0.3)"
          : "rgba(15, 23, 42, 0.85)";
        ctx.strokeStyle = isBtnHovered || isSelected ? color : "rgba(245, 158, 11, 0.5)";
        ctx.lineWidth = isBtnHovered ? 1.5 : 1;

        if (ctx.roundRect) {
          ctx.beginPath();
          ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 4);
          ctx.fill();
          ctx.stroke();
        } else {
          ctx.fillRect(badgeX, badgeY, badgeW, badgeH);
          ctx.strokeRect(badgeX, badgeY, badgeW, badgeH);
        }

        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 10px Inter, sans-serif";
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.fillText(`⏩ Перемотка: ${level.price.toFixed(5)}`, badgeX + badgeW / 2, y);

        ctx.textAlign = "left";
        ctx.fillStyle = color;
        ctx.fillText(`— ${level.price.toFixed(5)}`, canvasWidth - 75, y - 6);

        if (isSelected || isHovered) {
          drawHandle(ctx, 40, y, "circle", color, 4);
          drawHandle(ctx, canvasWidth / 2, y, "circle", color, 4);
        }
        ctx.restore();
      }
    });
  }

  if (drawings.vladRays) {
    const canvasWidth = canvas.width / (window.devicePixelRatio || 1);
    drawings.vladRays.forEach((ray, idx) => {
      const startX = getXFromPoint(ray.startPoint);
      const y = candlestickSeries.priceToCoordinate(ray.price);
      if (startX !== null && y !== null) {
        if (startX <= canvasWidth) {
          ctx.save();
          ctx.beginPath();
          ctx.strokeStyle = ray.color || "#3b82f6";
          ctx.lineWidth = ray.width || 2;
          ctx.moveTo(startX, y);
          ctx.lineTo(canvasWidth, y);
          ctx.stroke();

          ctx.fillStyle = ray.color || "#3b82f6";
          ctx.font = "10px Inter, sans-serif";
          ctx.textBaseline = "middle";
          ctx.fillText(`— ${ray.price.toFixed(5)} (Влад)`, canvasWidth - 95, y - 6);

          const isSelected = activeSelectedObject && (activeSelectedObject.type === "vlad_ray" || activeSelectedObject.type === "vlad_ray_handle") && activeSelectedObject.index === idx;
          const isHovered = hoveredObject && (hoveredObject.type === "vlad_ray" || hoveredObject.type === "vlad_ray_handle") && hoveredObject.index === idx;

          if (isSelected || isHovered) {
            drawHandle(ctx, startX, y, "circle", ray.color || "#3b82f6", 5);
          }
          ctx.restore();
        }
      }
    });
  }

  // Отрисовка стрелок входа/выхода для выделенной сделки из дневника
  if (state.selectedTradeId && tradeHistory) {
    const selectedTrade = tradeHistory.find(
      (t) => t.id === state.selectedTradeId,
    );
    if (selectedTrade) {
      ctx.save();

      // 0. Тонкая пунктирная соединительная линия между входом и выходом
      if (selectedTrade.entryTime && selectedTrade.exitTime) {
        const entryX = chart
          .timeScale()
          .timeToCoordinate(selectedTrade.entryTime);
        const entryY = candlestickSeries.priceToCoordinate(
          selectedTrade.entryPrice,
        );
        const exitX = chart
          .timeScale()
          .timeToCoordinate(selectedTrade.exitTime);
        const exitY = candlestickSeries.priceToCoordinate(
          selectedTrade.exitPrice,
        );

        if (
          entryX !== null &&
          entryY !== null &&
          exitX !== null &&
          exitY !== null
        ) {
          ctx.save();
          ctx.beginPath();
          ctx.strokeStyle =
            (selectedTrade.pnl || 0) >= 0
              ? "rgba(16, 185, 129, 0.7)"
              : "rgba(239, 68, 68, 0.7)";
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 4]);
          ctx.moveTo(entryX, entryY);
          ctx.lineTo(exitX, exitY);
          ctx.stroke();

          // Небольшой прямоугольник с PnL посередине линии
          const midX = (entryX + exitX) / 2;
          const midY = (entryY + exitY) / 2;
          ctx.restore();

          ctx.save();
          const pnlText = `${(selectedTrade.pnl || 0) >= 0 ? "+" : ""}$${(selectedTrade.pnl || 0).toFixed(2)}`;
          ctx.font = "bold 9px Inter, sans-serif";
          const textWidth = ctx.measureText(pnlText).width;

          ctx.fillStyle =
            (selectedTrade.pnl || 0) >= 0
              ? "rgba(16, 185, 129, 0.95)"
              : "rgba(239, 68, 68, 0.95)";
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1;

          // Draw bubble background
          ctx.beginPath();
          ctx.roundRect(
            midX - textWidth / 2 - 4,
            midY - 7,
            textWidth + 8,
            14,
            3,
          );
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = "#ffffff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(pnlText, midX, midY);
          ctx.restore();
        }
      }

      // 1. Стрелка входа
      if (selectedTrade.entryTime) {
        const entryX = chart
          .timeScale()
          .timeToCoordinate(selectedTrade.entryTime);
        const entryY = candlestickSeries.priceToCoordinate(
          selectedTrade.entryPrice,
        );
        if (
          entryX !== null &&
          entryY !== null &&
          entryX >= plotArea.left &&
          entryX <= plotArea.right
        ) {
          ctx.save();
          const isBuy = selectedTrade.type === "buy";
          ctx.fillStyle = isBuy ? "#10b981" : "#ef4444";
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          const arrowY = isBuy ? entryY + 18 : entryY - 18;
          const tipY = isBuy ? entryY - 4 : entryY + 4;
          ctx.moveTo(entryX, tipY);
          ctx.lineTo(entryX - 6, arrowY);
          ctx.lineTo(entryX - 2, arrowY);
          ctx.lineTo(entryX - 2, arrowY + (isBuy ? 10 : -10));
          ctx.lineTo(entryX + 2, arrowY + (isBuy ? 10 : -10));
          ctx.lineTo(entryX + 2, arrowY);
          ctx.lineTo(entryX + 6, arrowY);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();

          ctx.font = "bold 8px Inter, sans-serif";
          ctx.fillStyle = "#ffffff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("ENTRY", entryX, arrowY + (isBuy ? 18 : -18));
          ctx.restore();
        }
      }
      // 2. Стрелка выхода
      if (selectedTrade.exitTime) {
        const exitX = chart
          .timeScale()
          .timeToCoordinate(selectedTrade.exitTime);
        const exitY = candlestickSeries.priceToCoordinate(
          selectedTrade.exitPrice,
        );
        if (
          exitX !== null &&
          exitY !== null &&
          exitX >= plotArea.left &&
          exitX <= plotArea.right
        ) {
          ctx.save();
          const isBuy = selectedTrade.type === "buy"; // buy close is a sell (down arrow), sell close is a buy (up arrow)
          ctx.fillStyle = isBuy ? "#ef4444" : "#10b981";
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          const arrowY = isBuy ? exitY - 18 : exitY + 18;
          const tipY = isBuy ? exitY + 4 : exitY - 4;
          ctx.moveTo(exitX, tipY);
          ctx.lineTo(exitX - 6, arrowY);
          ctx.lineTo(exitX - 2, arrowY);
          ctx.lineTo(exitX - 2, arrowY + (isBuy ? -10 : 10));
          ctx.lineTo(exitX + 2, arrowY + (isBuy ? -10 : 10));
          ctx.lineTo(exitX + 2, arrowY);
          ctx.lineTo(exitX + 6, arrowY);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();

          ctx.font = "bold 8px Inter, sans-serif";
          ctx.fillStyle = "#ffffff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("EXIT", exitX, arrowY + (isBuy ? -18 : 18));
          ctx.restore();
        }
      }
      ctx.restore();
    }
  }

  // 4. Отрисовка линий (lines)
  if (drawings.lines) {
    drawings.lines.forEach((line, idx) => {
      const startX = getXFromPoint(line.startPoint);
      const startY = candlestickSeries.priceToCoordinate(line.startPoint.price);
      const endX = getXFromPoint(line.endPoint);
      const endY = candlestickSeries.priceToCoordinate(line.endPoint.price);
      if (startX !== null && startY !== null && endX !== null && endY !== null) {
        ctx.save();
        const isHovered = hoveredObject && hoveredObject.type === "line" && hoveredObject.index === idx;
        const isSelected = activeSelectedObject && activeSelectedObject.type === "line" && activeSelectedObject.index === idx;
        
        ctx.beginPath();
        ctx.strokeStyle = line.color || "#3b82f6";
        ctx.lineWidth = isHovered || isSelected ? 4.5 : 2;
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();

        if (isHovered || isSelected) {
          drawHandle(ctx, startX, startY, "circle", line.color);
          drawHandle(ctx, endX, endY, "circle", line.color);
        }
        ctx.restore();
      }
    });
  }

  // 5. Отрисовка прямоугольников (rectangles)
  if (drawings.rectangles) {
    drawings.rectangles.forEach((rect, idx) => {
      const startX = getXFromPoint(rect.startPoint);
      const startY = candlestickSeries.priceToCoordinate(rect.startPoint.price);
      const endX = getXFromPoint(rect.endPoint);
      const endY = candlestickSeries.priceToCoordinate(rect.endPoint.price);
      if (startX !== null && startY !== null && endX !== null && endY !== null) {
        ctx.save();
        const isHovered = hoveredObject && hoveredObject.type === "rect" && hoveredObject.index === idx;
        const isSelected = activeSelectedObject && activeSelectedObject.type === "rect" && activeSelectedObject.index === idx;
        
        ctx.beginPath();
        ctx.strokeStyle = rect.color || "#3b82f6";
        ctx.lineWidth = isHovered || isSelected ? 4.5 : 2;
        ctx.fillStyle = hexToRgba(rect.color || "#3b82f6", 0.15);
        ctx.rect(startX, startY, endX - startX, endY - startY);
        ctx.fill();
        ctx.stroke();

        if (isHovered || isSelected) {
          // Corner handles
          drawHandle(ctx, startX, startY, "square", rect.color);
          drawHandle(ctx, endX, startY, "square", rect.color);
          drawHandle(ctx, startX, endY, "square", rect.color);
          drawHandle(ctx, endX, endY, "square", rect.color);

          // Mid-side handles
          const midX = (startX + endX) / 2;
          const midY = (startY + endY) / 2;
          drawHandle(ctx, midX, startY, "circle", rect.color);
          drawHandle(ctx, midX, endY, "circle", rect.color);
          drawHandle(ctx, startX, midY, "circle", rect.color);
          drawHandle(ctx, endX, midY, "circle", rect.color);
        }
        ctx.restore();
      }
    });
  }

  // 5.1. Отрисовка уровней Фибоначчи (fibs)
  if (drawings.fibs) {
    drawings.fibs.forEach((fib, idx) => {
      drawFibonacciRetracement(ctx, fib, idx);
    });
  }

  // 6. Отрисовка временного чертежа (tempDrawing)
  if (tempDrawing) {
    if (tempDrawing.type === "fib") {
      drawFibonacciRetracement(ctx, tempDrawing, -1);
    } else {
      const startX = getXFromPoint(tempDrawing.startPoint);
      const startY = candlestickSeries.priceToCoordinate(tempDrawing.startPoint.price);
      const endX = getXFromPoint(tempDrawing.endPoint);
      const endY = candlestickSeries.priceToCoordinate(tempDrawing.endPoint.price);
      if (startX !== null && startY !== null && endX !== null && endY !== null) {
        ctx.save();
        ctx.beginPath();
        ctx.strokeStyle = tempDrawing.color;
        ctx.lineWidth = 2.5;
        if (tempDrawing.type === "line") {
          ctx.moveTo(startX, startY);
          ctx.lineTo(endX, endY);
          ctx.stroke();
        } else if (tempDrawing.type === "rect") {
          ctx.fillStyle = hexToRgba(tempDrawing.color, 0.15);
          ctx.rect(startX, startY, endX - startX, endY - startY);
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }
    }
  }

  // 7. Отрисовка текстовых заметок (texts)
  if (drawings.texts) {
    drawings.texts.forEach((txtObj, idx) => {
      const x = getXFromPoint(txtObj.point);
      const y = candlestickSeries.priceToCoordinate(txtObj.point.price);
      if (x !== null && y !== null) {
        ctx.save();
        const isHovered = hoveredObject && hoveredObject.type === "text" && hoveredObject.index === idx;
        const isSelected = activeSelectedObject && activeSelectedObject.type === "text" && activeSelectedObject.index === idx;

        const fontSize = txtObj.fontSize || 14;
        ctx.font = `${fontSize}px Inter, sans-serif`;
        const lines = (txtObj.text || "").split("\n");
        let maxWidth = 0;
        lines.forEach(line => {
          const w = ctx.measureText(line).width;
          if (w > maxWidth) maxWidth = w;
        });
        const lineHeight = fontSize * 1.35;
        const totalHeight = lines.length * lineHeight;
        const padding = 6;

        const boxX = x;
        const boxY = y;
        const boxWidth = Math.max(40, maxWidth + padding * 2);
        const boxHeight = Math.max(24, totalHeight + padding * 2);

        // Background box
        ctx.fillStyle = txtObj.bgColor || "rgba(15, 23, 42, 0.85)";
        ctx.fillRect(boxX, boxY, boxWidth, boxHeight);

        // Border
        ctx.strokeStyle = isHovered || isSelected ? (txtObj.color || "#3b82f6") : (txtObj.borderColor || "rgba(255,255,255,0.2)");
        ctx.lineWidth = isHovered || isSelected ? 2 : 1;
        ctx.strokeRect(boxX, boxY, boxWidth, boxHeight);

        // Text
        ctx.fillStyle = txtObj.color || "#ffffff";
        ctx.textBaseline = "top";
        lines.forEach((line, i) => {
          ctx.fillText(line, boxX + padding, boxY + padding + i * lineHeight);
        });

        if (isHovered || isSelected) {
          drawHandle(ctx, boxX, boxY, "square", txtObj.color || "#3b82f6");
          drawHandle(ctx, boxX + boxWidth, boxY, "square", txtObj.color || "#3b82f6");
          drawHandle(ctx, boxX, boxY + boxHeight, "square", txtObj.color || "#3b82f6");
          drawHandle(ctx, boxX + boxWidth, boxY + boxHeight, "square", txtObj.color || "#3b82f6");
        }

        txtObj._bounds = { boxX, boxY, boxWidth, boxHeight };
        ctx.restore();
      }
    });
  }

  // 8. Отрисовка ломаных линий / Траекторий (paths)
  if (drawings.paths) {
    drawings.paths.forEach((pathObj, idx) => {
      if (!pathObj.points || pathObj.points.length < 2) return;
      const isHovered = hoveredObject && (hoveredObject.type === "path" || hoveredObject.type === "path_handle") && hoveredObject.index === idx;
      const isSelected = activeSelectedObject && (activeSelectedObject.type === "path" || activeSelectedObject.type === "path_handle") && activeSelectedObject.index === idx;

      ctx.save();
      ctx.beginPath();
      ctx.strokeStyle = pathObj.color || "#3b82f6";
      ctx.lineWidth = isHovered || isSelected ? (pathObj.width || 2.5) + 2 : (pathObj.width || 2.5);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      let first = true;
      let prevPtCoords = null;
      let lastPtCoords = null;

      pathObj.points.forEach((pt, pIdx) => {
        const x = getXFromPoint(pt);
        const y = candlestickSeries.priceToCoordinate(pt.price);
        if (x !== null && y !== null) {
          if (first) {
            ctx.moveTo(x, y);
            first = false;
          } else {
            ctx.lineTo(x, y);
          }
          if (pIdx === pathObj.points.length - 2) {
            prevPtCoords = { x, y };
          }
          if (pIdx === pathObj.points.length - 1) {
            lastPtCoords = { x, y };
          }
        }
      });
      ctx.stroke();

      if (prevPtCoords && lastPtCoords) {
        drawArrowHead(ctx, prevPtCoords.x, prevPtCoords.y, lastPtCoords.x, lastPtCoords.y, pathObj.color || "#3b82f6", 14);
      }

      if (isHovered || isSelected) {
        pathObj.points.forEach((pt, pIdx) => {
          const x = getXFromPoint(pt);
          const y = candlestickSeries.priceToCoordinate(pt.price);
          if (x !== null && y !== null) {
            const isLast = pIdx === pathObj.points.length - 1;
            drawHandle(ctx, x, y, isLast ? "square" : "circle", pathObj.color || "#3b82f6", isLast ? 6 : 4.5);
          }
        });
      }
      ctx.restore();
    });
  }

  // 9. Отрисовка временной траектории (tempPath)
  if (tempPath && tempPath.points && tempPath.points.length > 0) {
    ctx.save();
    ctx.beginPath();
    ctx.strokeStyle = tempPath.color || activeColor;
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    let first = true;
    let lastDrawnPoint = null;
    let prevDrawnPoint = null;

    tempPath.points.forEach((pt) => {
      const x = getXFromPoint(pt);
      const y = candlestickSeries.priceToCoordinate(pt.price);
      if (x !== null && y !== null) {
        if (first) {
          ctx.moveTo(x, y);
          first = false;
        } else {
          ctx.lineTo(x, y);
        }
        prevDrawnPoint = lastDrawnPoint;
        lastDrawnPoint = { x, y };
      }
    });

    let previewPoint = null;
    if (mousePreviewPt) {
      const mx = getXFromPoint(mousePreviewPt);
      const my = candlestickSeries.priceToCoordinate(mousePreviewPt.price);
      if (mx !== null && my !== null) {
        ctx.lineTo(mx, my);
        previewPoint = { x: mx, y: my };
      }
    }
    ctx.stroke();

    if (previewPoint && lastDrawnPoint) {
      drawArrowHead(ctx, lastDrawnPoint.x, lastDrawnPoint.y, previewPoint.x, previewPoint.y, tempPath.color || activeColor, 14);
    } else if (prevDrawnPoint && lastDrawnPoint) {
      drawArrowHead(ctx, prevDrawnPoint.x, prevDrawnPoint.y, lastDrawnPoint.x, lastDrawnPoint.y, tempPath.color || activeColor, 14);
    }

    tempPath.points.forEach((pt, pIdx) => {
      const x = getXFromPoint(pt);
      const y = candlestickSeries.priceToCoordinate(pt.price);
      if (x !== null && y !== null) {
        const isLast = pIdx === tempPath.points.length - 1;
        drawHandle(ctx, x, y, isLast ? "square" : "circle", tempPath.color || activeColor, isLast ? 6 : 4.5);
      }
    });
    ctx.restore();
  }

  ctx.restore();
}

// Фильтрация сделок по дате
function filterTradesByDate(date) {
  if (!date) return [];
  const targetDate = new Date(date);
  const targetYear = targetDate.getFullYear();
  const targetMonth = targetDate.getMonth();
  const targetDay = targetDate.getDate();

  return tradeHistory.filter((trade) => {
    const tTime = trade.closeTime || trade.timestamp || trade.openTime;
    if (!tTime) return false;
    const d = new Date(tTime);
    return d.getFullYear() === targetYear &&
           d.getMonth() === targetMonth &&
           d.getDate() === targetDay;
  });
}

// Отрисовка исторических сделок за выбранный день на Canvas
function drawHistoricalTradesOnCanvas(ctx) {
  if (!selectedHistoryTrades || selectedHistoryTrades.length === 0) return;
  const plotArea = getChartPlotArea();

  selectedHistoryTrades.forEach((t) => {
    if (!t.entryTime || !t.exitTime) return;

    const entryX = chart.timeScale().timeToCoordinate(t.entryTime);
    const entryY = candlestickSeries.priceToCoordinate(t.entryPrice);
    const exitX = chart.timeScale().timeToCoordinate(t.exitTime);
    const exitY = candlestickSeries.priceToCoordinate(t.exitPrice);

    if (
      entryX === null ||
      entryY === null ||
      exitX === null ||
      exitY === null
    ) {
      return;
    }

    ctx.save();

    // Ограничиваем отрисовку областью графика
    ctx.beginPath();
    ctx.rect(plotArea.left, plotArea.top, plotArea.width, plotArea.height);
    ctx.clip();

    // Рисуем пунктирную линию между входом и выходом
    ctx.beginPath();
    const isWin = (t.pnl || 0) >= 0;
    ctx.strokeStyle = isWin ? "rgba(16, 185, 129, 0.55)" : "rgba(239, 68, 68, 0.55)";
    ctx.lineWidth = hoveredHistTradeId === t.id ? 3 : 1.5;
    ctx.setLineDash([3, 3]);
    ctx.moveTo(entryX, entryY);
    ctx.lineTo(exitX, exitY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Отрисовка стрелки входа
    const isBuy = t.type === "buy" || t.type === "Long" || t.type === "long";
    ctx.fillStyle = isBuy ? "#10b981" : "#ef4444";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const arrowY = isBuy ? entryY + 14 : entryY - 14;
    const tipY = isBuy ? entryY - 2 : entryY + 2;
    ctx.moveTo(entryX, tipY);
    ctx.lineTo(entryX - 4, arrowY);
    ctx.lineTo(entryX - 1.5, arrowY);
    ctx.lineTo(entryX - 1.5, arrowY + (isBuy ? 6 : -6));
    ctx.lineTo(entryX + 1.5, arrowY + (isBuy ? 6 : -6));
    ctx.lineTo(entryX + 1.5, arrowY);
    ctx.lineTo(entryX + 4, arrowY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Отрисовка стрелки выхода
    ctx.fillStyle = isBuy ? "#ef4444" : "#10b981";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const exitArrowY = isBuy ? exitY - 14 : exitY + 14;
    const exitTipY = isBuy ? exitY + 2 : exitY - 2;
    ctx.moveTo(exitX, exitTipY);
    ctx.lineTo(exitX - 4, exitArrowY);
    ctx.lineTo(exitX - 1.5, exitArrowY);
    ctx.lineTo(exitX - 1.5, exitArrowY + (isBuy ? -6 : 6));
    ctx.lineTo(exitX + 1.5, exitArrowY + (isBuy ? -6 : 6));
    ctx.lineTo(exitX + 1.5, exitArrowY);
    ctx.lineTo(exitX + 4, exitArrowY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Небольшой прямоугольник с PnL посередине линии
    const midX = (entryX + exitX) / 2;
    const midY = (entryY + exitY) / 2;
    const pnlText = `${isWin ? "+" : ""}$${(t.pnl || 0).toFixed(2)}`;
    ctx.font = "bold 8px Inter, sans-serif";
    const textWidth = ctx.measureText(pnlText).width;

    ctx.fillStyle = isWin ? "rgba(16, 185, 129, 0.9)" : "rgba(239, 68, 68, 0.9)";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(midX - textWidth / 2 - 3, midY - 6, textWidth + 6, 12, 2);
    } else {
      ctx.fillRect(midX - textWidth / 2 - 3, midY - 6, textWidth + 6, 12);
    }
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(pnlText, midX, midY);

    // Если есть заметки, рисуем иконку блокнота над точкой входа
    const hasNotes = t.notes && (t.notes.noteBefore || t.notes.noteDuring || t.notes.noteAfter);
    if (hasNotes) {
      ctx.font = "14px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("📝", entryX, entryY - 24);
    }

    ctx.restore();
  });
}

// Поиск исторической сделки по координатам мыши
function findHistoricalTradeAtCoords(mouseX, mouseY) {
  if (!selectedHistoryTrades || selectedHistoryTrades.length === 0) return null;

  for (let i = 0; i < selectedHistoryTrades.length; i++) {
    const t = selectedHistoryTrades[i];
    if (!t.entryTime || !t.exitTime) continue;

    const entryX = chart.timeScale().timeToCoordinate(t.entryTime);
    const entryY = candlestickSeries.priceToCoordinate(t.entryPrice);
    const exitX = chart.timeScale().timeToCoordinate(t.exitTime);
    const exitY = candlestickSeries.priceToCoordinate(t.exitPrice);

    if (entryX === null || entryY === null || exitX === null || exitY === null) continue;

    // Расстояние до точки входа или иконки блокнота
    const distToEntry = Math.sqrt((mouseX - entryX) ** 2 + (mouseY - entryY) ** 2);
    const hasNotes = t.notes && (t.notes.noteBefore || t.notes.noteDuring || t.notes.noteAfter);
    
    let distToIcon = Infinity;
    if (hasNotes) {
      const iconX = entryX;
      const iconY = entryY - 24;
      distToIcon = Math.sqrt((mouseX - iconX) ** 2 + (mouseY - iconY) ** 2);
    }

    // Расстояние до точки выхода
    const distToExit = Math.sqrt((mouseX - exitX) ** 2 + (mouseY - exitY) ** 2);

    // Расстояние до соединительной линии
    const lineDist = getDistanceToSegment(mouseX, mouseY, entryX, entryY, exitX, exitY);

    if (distToIcon < 15) {
      return { type: "hist_note_icon", trade: t, x: entryX, y: entryY - 24 };
    }
    if (distToEntry < 20) {
      return { type: "hist_entry", trade: t, x: entryX, y: entryY };
    }
    if (distToExit < 20) {
      return { type: "hist_exit", trade: t, x: exitX, y: exitY };
    }
    if (lineDist < 10) {
      return { type: "hist_line", trade: t, x: (entryX + exitX) / 2, y: (entryY + exitY) / 2 };
    }
  }
  return null;
}

function getDistanceToSegment(x, y, x1, y1, x2, y2) {
  const A = x - x1;
  const B = y - y1;
  const C = x2 - x1;
  const D = y2 - y1;

  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = -1;
  if (lenSq !== 0) param = dot / lenSq;

  let xx, yy;
  if (param < 0) {
    xx = x1;
    yy = y1;
  } else if (param > 1) {
    xx = x2;
    yy = y2;
  } else {
    xx = x1 + param * C;
    yy = y1 + param * D;
  }

  const dx = x - xx;
  const dy = y - yy;
  return Math.sqrt(dx * dx + dy * dy);
}

// Управление отображением красивого тултипа для исторической сделки
function showHistoricalTradeTooltip(clientX, clientY, t) {
  let tooltip = document.getElementById("historical-trade-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "historical-trade-tooltip";
    tooltip.style.position = "fixed";
    tooltip.style.backgroundColor = "rgba(19, 23, 34, 0.96)";
    tooltip.style.border = "1px solid rgba(255, 255, 255, 0.15)";
    tooltip.style.borderRadius = "8px";
    tooltip.style.padding = "12px";
    tooltip.style.boxShadow = "0 8px 32px rgba(0, 0, 0, 0.5)";
    tooltip.style.color = "#ffffff";
    tooltip.style.zIndex = "10000";
    tooltip.style.pointerEvents = "none";
    tooltip.style.maxWidth = "300px";
    tooltip.style.fontFamily = "Inter, sans-serif";
    tooltip.style.fontSize = "12px";
    document.body.appendChild(tooltip);
  }

  const isWin = (t.pnl || 0) >= 0;
  const pnlColor = isWin ? "#10b981" : "#ef4444";
  const pnlSign = isWin ? "+" : "";

  const symbolStr = (t.symbol || "").replace("_", "/");
  const typeStr = (t.type || "").toUpperCase();
  const dateStr = new Date(t.closeTime || t.timestamp).toLocaleDateString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit"
  });

  const notesHtml = t.notes && (t.notes.noteBefore || t.notes.noteDuring || t.notes.noteAfter)
    ? `
      <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.1);">
        <div style="font-weight: bold; color: #a0aec0; margin-bottom: 4px;">📝 Заметки к сделке:</div>
        ${t.notes.noteBefore ? `<div style="margin-bottom: 2px;">• <i>До:</i> ${t.notes.noteBefore}</div>` : ""}
        ${t.notes.noteDuring ? `<div style="margin-bottom: 2px;">• <i>В процессе:</i> ${t.notes.noteDuring}</div>` : ""}
        ${t.notes.noteAfter ? `<div>• <i>После:</i> ${t.notes.noteAfter}</div>` : ""}
      </div>
    `
    : "";

  tooltip.innerHTML = `
    <div style="font-weight: bold; margin-bottom: 6px; display: flex; justify-content: space-between; align-items: center;">
      <span>${symbolStr} (${typeStr})</span>
      <span style="color: ${pnlColor}; font-weight: bold;">${pnlSign}$${(t.pnl || 0).toFixed(2)}</span>
    </div>
    <div style="color: #cbd5e0; font-size: 11px; line-height: 1.4;">
      <div><b>Дата закрытия:</b> ${dateStr}</div>
      <div><b>Размер:</b> ${t.size} L | Плечо: 1:${t.leverage || 100}</div>
      <div><b>Вход:</b> ${t.entryPrice.toFixed(5)} → <b>Выход:</b> ${t.exitPrice.toFixed(5)}</div>
      ${t.reason ? `<div><b>Причина:</b> ${t.reason}</div>` : ""}
    </div>
    ${notesHtml}
    <div style="margin-top: 6px; font-size: 9px; color: #a0aec0; text-align: center; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 4px;">
      Кликните на сделку на графике, чтобы открыть дневник
    </div>
  `;

  tooltip.style.display = "block";
  tooltip.style.left = `${clientX + 15}px`;
  tooltip.style.top = `${clientY + 15}px`;
}

function hideHistoricalTradeTooltip() {
  const tooltip = document.getElementById("historical-trade-tooltip");
  if (tooltip) {
    tooltip.style.display = "none";
  }
}

// Клик по дню в календаре
function selectHistoricalTradesDate(dateString) {
  // Открываем панель Журнала, если она закрыта
  const panel = document.getElementById("trade-history-panel");
  const toggleBtn = document.getElementById("toggle-history-btn");
  if (panel && (panel.style.display === "none" || panel.style.display === "")) {
    panel.style.display = "flex";
    panel.classList.remove("collapsed");
    localStorage.setItem("win_hidden", "false");
    localStorage.setItem("win_collapsed", "false");
    if (toggleBtn) {
      toggleBtn.style.background = "rgba(75, 85, 99, 0.35)";
      toggleBtn.style.borderColor = "var(--color-accent)";
    }
  }

  if (selectedHistoryDateStr === dateString) {
    selectedHistoryDateStr = null;
    selectedHistoryTrades = [];
    
    // Сбрасываем фильтры точной даты в журнале
    currentHistoryFilter.exactDate = "";
    const exactDateInput = document.getElementById("filter-exact-date");
    if (exactDateInput) exactDateInput.value = "";
    
    // Переключаем на все сделки
    const periodButtons = document.querySelectorAll(".filter-period-btn");
    periodButtons.forEach((b) => b.classList.remove("active"));
    const allBtn = document.querySelector('.filter-period-btn[data-period="all"]');
    if (allBtn) allBtn.classList.add("active");
    currentHistoryFilter.period = "all";
    
    updateTradeHistoryUI();
  } else {
    selectedHistoryDateStr = dateString;
    selectedHistoryTrades = filterTradesByDate(dateString);
    
    // Передаем дату в функцию отрисовки Журнала сделок
    updateTradeHistoryUI(dateString);

    if (selectedHistoryTrades.length > 0) {
      showToast(`Сделок за ${dateString}: ${selectedHistoryTrades.length}`, "info");
      const firstT = selectedHistoryTrades[0];
      if (firstT.entryTime && chart) {
        try {
          chart.timeScale().scrollToPosition(0, false);
          const coord = chart.timeScale().timeToCoordinate(firstT.entryTime);
          if (coord === null) {
            chart.timeScale().fitContent();
          }
        } catch(e) {}
      }
    } else {
      showToast(`Сделок за этот день не найдено (${dateString})`, "info");
    }
  }
  renderHeatmapCalendar();
  drawAllOnCanvas();
}

function recenterView() {
  try {
    if (chart) {
      const arr = state.isBacktestActive ? state.backtestVisibleCandles : state.historicalCandles;
      const total = arr ? arr.length : 0;
      const tfMinutes = timeframeToMinutes(state.timeframe);
      const isWeeklyOrSmall = tfMinutes >= 10080 || total <= 100;
      const N = 190;
      const rightMargin = 15;

      chart.priceScale('right').applyOptions({ autoScale: true });
      chart.timeScale().resetTimeScale();
      
      if (total > 0) {
        if (isWeeklyOrSmall) {
          chart.timeScale().fitContent();
        } else {
          chart.timeScale().setVisibleLogicalRange({
            from: Math.max(0, total - N),
            to: total + rightMargin
          });
        }
      } else {
        chart.timeScale().fitContent();
      }

      setTimeout(() => {
        try {
          const freshArr = state.isBacktestActive ? state.backtestVisibleCandles : state.historicalCandles;
          const freshTotal = freshArr ? freshArr.length : 0;
          const freshTfMinutes = timeframeToMinutes(state.timeframe);
          const freshIsWeeklyOrSmall = freshTfMinutes >= 10080 || freshTotal <= 100;

          chart.priceScale('right').applyOptions({ autoScale: true });
          if (freshTotal > 0) {
            if (freshIsWeeklyOrSmall) {
              chart.timeScale().fitContent();
            } else {
              chart.timeScale().setVisibleLogicalRange({
                from: Math.max(0, freshTotal - N),
                to: freshTotal + rightMargin
              });
            }
          } else {
            chart.timeScale().fitContent();
          }
          if (typeof syncCOTTimeScaleWithMain === "function") {
            syncCOTTimeScaleWithMain();
          }
        } catch (err) {}
      }, 50);
    }
  } catch (e) {}
}

function findObjectAtCoords(mouseX, mouseY) {
  if (state.positions && state.positions.length > 0) {
    // First check for close button clicks so they take priority
    for (let i = 0; i < state.positions.length; i++) {
      const pos = state.positions[i];

      // Entry close button
      const entryBounds = getPositionLabelBounds(pos, "entry");
      if (entryBounds) {
        if (
          mouseX >= entryBounds.dividerX - 5 &&
          mouseX <= entryBounds.dividerX + 20 &&
          mouseY >= entryBounds.y - 15 &&
          mouseY <= entryBounds.y + entryBounds.h + 15
        ) {
          return {
            type: "pos_close_btn",
            lineType: "entry",
            id: pos.id,
            position: pos,
          };
        }
      }
      // TP close button
      const tpBounds = getPositionLabelBounds(pos, "tp");
      if (tpBounds) {
        if (
          mouseX >= tpBounds.dividerX - 15 &&
          mouseX <= tpBounds.x + tpBounds.w + 15 &&
          mouseY >= tpBounds.y - 15 &&
          mouseY <= tpBounds.y + tpBounds.h + 15
        ) {
          return {
            type: "pos_close_btn",
            lineType: "tp",
            id: pos.id,
            position: pos,
          };
        }
      }
      // SL close button
      const slBounds = getPositionLabelBounds(pos, "sl");
      if (slBounds) {
        if (
          mouseX >= slBounds.dividerX - 15 &&
          mouseX <= slBounds.x + slBounds.w + 15 &&
          mouseY >= slBounds.y - 15 &&
          mouseY <= slBounds.y + slBounds.h + 15
        ) {
          return {
            type: "pos_close_btn",
            lineType: "sl",
            id: pos.id,
            position: pos,
          };
        }
      }
    }

    // Check for dragging or hovering label/line
    for (let i = 0; i < state.positions.length; i++) {
      const pos = state.positions[i];

      // Entry Line or label body
      const entryBounds = getPositionLabelBounds(pos, "entry");
      if (entryBounds) {
        const onLabel =
          mouseX >= entryBounds.x &&
          mouseX < entryBounds.dividerX &&
          mouseY >= entryBounds.y &&
          mouseY <= entryBounds.y + entryBounds.h;
        const onLine = Math.abs(mouseY - entryBounds.yCenter) < 8;
        if (onLabel || onLine) {
          if (pos.status === "pending" || pos.status === "draft") {
            return { type: "pos_entry", id: pos.id, position: pos };
          } else {
            return { type: "pos_active_entry", id: pos.id, position: pos };
          }
        }
      }
      // TP Line or label body
      const tpBounds = getPositionLabelBounds(pos, "tp");
      if (tpBounds) {
        const onLabel =
          mouseX >= tpBounds.x &&
          mouseX < tpBounds.dividerX &&
          mouseY >= tpBounds.y &&
          mouseY <= tpBounds.y + tpBounds.h;
        const onLine = Math.abs(mouseY - tpBounds.yCenter) < 8;
        if (onLabel || onLine) {
          return { type: "pos_tp", id: pos.id, position: pos };
        }
      }
      // SL Line or label body
      const slBounds = getPositionLabelBounds(pos, "sl");
      if (slBounds) {
        const onLabel =
          mouseX >= slBounds.x &&
          mouseX < slBounds.dividerX &&
          mouseY >= slBounds.y &&
          mouseY <= slBounds.y + slBounds.h;
        const onLine = Math.abs(mouseY - slBounds.yCenter) < 8;
        if (onLabel || onLine) {
          return { type: "pos_sl", id: pos.id, position: pos };
        }
      }
    }
  }

  for (let i = 0; i < drawings.positions.length; i++) {
    const pos = drawings.positions[i];
    const startX = getXFromPosition(pos);
    if (startX === null) continue;
    const barSpacing = getBarSpacing();
    const widthInCandles = pos.widthInCandles || 70;
    const width = Math.round(widthInCandles * barSpacing);
    const endX = startX + width;
    const entryY = candlestickSeries.priceToCoordinate(pos.entryPrice);
    const targetY = candlestickSeries.priceToCoordinate(pos.targetPrice);
    const stopY = candlestickSeries.priceToCoordinate(pos.stopPrice);
    if (entryY !== null && targetY !== null && stopY !== null) {
      const isLong = pos.type === "long";
      const topY = isLong ? targetY : stopY;
      const botY = isLong ? stopY : targetY;
      if (Math.hypot(mouseX - startX, mouseY - entryY) < 15) {
        return { type: "position", index: i, part: "left_handle" };
      }
      if (Math.hypot(mouseX - endX, mouseY - entryY) < 15) {
        return { type: "position", index: i, part: "right_handle" };
      }
      if (Math.hypot(mouseX - (startX + width / 2), mouseY - topY) < 15) {
        return { type: "position", index: i, part: "top_handle" };
      }
      if (Math.hypot(mouseX - (startX + width / 2), mouseY - botY) < 15) {
        return { type: "position", index: i, part: "bottom_handle" };
      }
    }
  }
  if (drawings.horizontalLines) {
    for (let i = 0; i < drawings.horizontalLines.length; i++) {
      const line = drawings.horizontalLines[i];
      const y = candlestickSeries.priceToCoordinate(line.price);
      if (y !== null && Math.abs(mouseY - y) < 14) {
        return { type: "hline", index: i };
      }
    }
  }
  if (drawings.waitLevels) {
    for (let i = 0; i < drawings.waitLevels.length; i++) {
      const level = drawings.waitLevels[i];
      if (
        level.ffBtnHitBox &&
        mouseX >= level.ffBtnHitBox.x &&
        mouseX <= level.ffBtnHitBox.x + level.ffBtnHitBox.width &&
        mouseY >= level.ffBtnHitBox.y &&
        mouseY <= level.ffBtnHitBox.y + level.ffBtnHitBox.height
      ) {
        return { type: "wait_level_ff", index: i };
      }
      const y = candlestickSeries.priceToCoordinate(level.price);
      if (y !== null && Math.abs(mouseY - y) < 14) {
        return { type: "wait_level", index: i };
      }
    }
  }
  if (drawings.vladRays) {
    for (let i = 0; i < drawings.vladRays.length; i++) {
      const ray = drawings.vladRays[i];
      const startX = getXFromPoint(ray.startPoint);
      const y = candlestickSeries.priceToCoordinate(ray.price);
      if (startX !== null && y !== null) {
        const isSelected = activeSelectedObject && (activeSelectedObject.type === "vlad_ray" || activeSelectedObject.type === "vlad_ray_handle") && activeSelectedObject.index === i;
        if (isSelected || Math.hypot(mouseX - startX, mouseY - y) < 14) {
          if (Math.hypot(mouseX - startX, mouseY - y) < 14) {
            return { type: "vlad_ray_handle", index: i, part: "start" };
          }
        }
        if (mouseX >= startX - 8 && Math.abs(mouseY - y) < 14) {
          return { type: "vlad_ray", index: i };
        }
      }
    }
  }
  for (let i = 0; i < drawings.positions.length; i++) {
    const pos = drawings.positions[i];
    const startX = getXFromPosition(pos);
    if (startX === null) continue;
    const barSpacing = getBarSpacing();
    const widthInCandles = pos.widthInCandles || 70;
    const width = Math.round(widthInCandles * barSpacing);
    const endX = startX + width;
    if (mouseX >= startX - 8 && mouseX <= endX + 8) {
      const entryY = candlestickSeries.priceToCoordinate(pos.entryPrice);
      const targetY = candlestickSeries.priceToCoordinate(pos.targetPrice);
      const stopY = candlestickSeries.priceToCoordinate(pos.stopPrice);
      if (entryY !== null && targetY !== null && stopY !== null) {
        if (Math.abs(mouseY - entryY) < 12) {
          return { type: "position", index: i, part: "entry_line" };
        }
        const isLong = pos.type === "long";
        const topTP = isLong ? targetY : entryY;
        const botTP = isLong ? entryY : targetY;
        const topSL = isLong ? entryY : stopY;
        const botSL = isLong ? stopY : entryY;
        if (
          mouseY >= Math.min(topTP, botTP) - 5 &&
          mouseY <= Math.max(topTP, botTP) + 5
        ) {
          return { type: "position", index: i, part: "target_box" };
        }
        if (
          mouseY >= Math.min(topSL, botSL) - 5 &&
          mouseY <= Math.max(topSL, botSL) + 5
        ) {
          return { type: "position", index: i, part: "stop_box" };
        }
      }
    }
  }
  if (drawings.brushPaths) {
    for (let i = 0; i < drawings.brushPaths.length; i++) {
      const path = drawings.brushPaths[i];
      for (const pt of path.points) {
        const px = getXFromPoint(pt);
        const py = candlestickSeries.priceToCoordinate(pt.price);
        if (px !== null && py !== null) {
          if (Math.hypot(mouseX - px, mouseY - py) < 18) {
            return { type: "brush", index: i };
          }
        }
      }
    }
  }

  if (drawings.lines) {
    for (let i = 0; i < drawings.lines.length; i++) {
      const line = drawings.lines[i];
      const startX = getXFromPoint(line.startPoint);
      const startY = candlestickSeries.priceToCoordinate(line.startPoint.price);
      const endX = getXFromPoint(line.endPoint);
      const endY = candlestickSeries.priceToCoordinate(line.endPoint.price);
      if (startX !== null && startY !== null && endX !== null && endY !== null) {
        const isSelected = activeSelectedObject && activeSelectedObject.type === "line" && activeSelectedObject.index === i;
        if (isSelected) {
          if (Math.hypot(mouseX - startX, mouseY - startY) < 14) {
            return { type: "line_handle", index: i, part: "start" };
          }
          if (Math.hypot(mouseX - endX, mouseY - endY) < 14) {
            return { type: "line_handle", index: i, part: "end" };
          }
        }

        const A = mouseX - startX;
        const B = mouseY - startY;
        const C = endX - startX;
        const D = endY - startY;
        const dot = A * C + B * D;
        const lenSq = C * C + D * D;
        let param = -1;
        if (lenSq !== 0) param = dot / lenSq;
        let xx, yy;
        if (param < 0) {
          xx = startX;
          yy = startY;
        } else if (param > 1) {
          xx = endX;
          yy = endY;
        } else {
          xx = startX + param * C;
          yy = startY + param * D;
        }
        const dist = Math.hypot(mouseX - xx, mouseY - yy);
        if (dist < 15) {
          return { type: "line", index: i };
        }
      }
    }
  }

  if (drawings.rectangles) {
    for (let i = 0; i < drawings.rectangles.length; i++) {
      const rect = drawings.rectangles[i];
      const startX = getXFromPoint(rect.startPoint);
      const startY = candlestickSeries.priceToCoordinate(rect.startPoint.price);
      const endX = getXFromPoint(rect.endPoint);
      const endY = candlestickSeries.priceToCoordinate(rect.endPoint.price);
      if (startX !== null && startY !== null && endX !== null && endY !== null) {
        const isSelected = activeSelectedObject && activeSelectedObject.type === "rect" && activeSelectedObject.index === i;
        if (isSelected) {
          if (Math.hypot(mouseX - startX, mouseY - startY) < 14) {
            return { type: "rect_handle", index: i, part: "top_left" };
          }
          if (Math.hypot(mouseX - endX, mouseY - startY) < 14) {
            return { type: "rect_handle", index: i, part: "top_right" };
          }
          if (Math.hypot(mouseX - startX, mouseY - endY) < 14) {
            return { type: "rect_handle", index: i, part: "bottom_left" };
          }
          if (Math.hypot(mouseX - endX, mouseY - endY) < 14) {
            return { type: "rect_handle", index: i, part: "bottom_right" };
          }
          
          // Mid-side handles
          const midX = (startX + endX) / 2;
          const midY = (startY + endY) / 2;
          if (Math.hypot(mouseX - midX, mouseY - startY) < 14) {
            return { type: "rect_handle", index: i, part: "mid_top" };
          }
          if (Math.hypot(mouseX - midX, mouseY - endY) < 14) {
            return { type: "rect_handle", index: i, part: "mid_bottom" };
          }
          if (Math.hypot(mouseX - startX, mouseY - midY) < 14) {
            return { type: "rect_handle", index: i, part: "mid_left" };
          }
          if (Math.hypot(mouseX - endX, mouseY - midY) < 14) {
            return { type: "rect_handle", index: i, part: "mid_right" };
          }
        }

        const minX = Math.min(startX, endX);
        const maxX = Math.max(startX, endX);
        const minY = Math.min(startY, endY);
        const maxY = Math.max(startY, endY);
        
        const nearLeft = Math.abs(mouseX - minX) < 12 && mouseY >= minY - 6 && mouseY <= maxY + 6;
        const nearRight = Math.abs(mouseX - maxX) < 12 && mouseY >= minY - 6 && mouseY <= maxY + 6;
        const nearTop = Math.abs(mouseY - minY) < 12 && mouseX >= minX - 6 && mouseX <= maxX + 6;
        const nearBottom = Math.abs(mouseY - maxY) < 12 && mouseX >= minX - 6 && mouseX <= maxX + 6;
        
        if (nearLeft || nearRight || nearTop || nearBottom) {
          return { type: "rect", index: i };
        }
      }
    }
  }

  if (drawings.texts) {
    for (let i = 0; i < drawings.texts.length; i++) {
      const txtObj = drawings.texts[i];
      if (txtObj._bounds) {
        const b = txtObj._bounds;
        if (
          mouseX >= b.boxX - 4 &&
          mouseX <= b.boxX + b.boxWidth + 4 &&
          mouseY >= b.boxY - 4 &&
          mouseY <= b.boxY + b.boxHeight + 4
        ) {
          return { type: "text", index: i };
        }
      }
    }
  }

  if (drawings.paths) {
    for (let i = 0; i < drawings.paths.length; i++) {
      const pathObj = drawings.paths[i];
      if (!pathObj.points || pathObj.points.length < 2) continue;

      const isSelected = activeSelectedObject && (activeSelectedObject.type === "path" || activeSelectedObject.type === "path_handle") && activeSelectedObject.index === i;

      // Check point handles (checking last point first with enlarged 18px hitbox)
      if (pathObj.points) {
        for (let pIdx = pathObj.points.length - 1; pIdx >= 0; pIdx--) {
          const pt = pathObj.points[pIdx];
          const px = getXFromPoint(pt);
          const py = candlestickSeries.priceToCoordinate(pt.price);
          if (px !== null && py !== null) {
            const isLast = pIdx === pathObj.points.length - 1;
            const hitRadius = isLast ? 18 : 14;
            if (Math.hypot(mouseX - px, mouseY - py) < hitRadius) {
              return { type: "path_handle", index: i, pointIndex: pIdx };
            }
          }
        }
      }

      for (let pIdx = 0; pIdx < pathObj.points.length - 1; pIdx++) {
        const pt1 = pathObj.points[pIdx];
        const pt2 = pathObj.points[pIdx + 1];
        const x1 = getXFromPoint(pt1);
        const y1 = candlestickSeries.priceToCoordinate(pt1.price);
        const x2 = getXFromPoint(pt2);
        const y2 = candlestickSeries.priceToCoordinate(pt2.price);

        if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
          const d = distToSegment(mouseX, mouseY, x1, y1, x2, y2);
          if (d < 14) {
            return { type: "path", index: i };
          }
        }
      }
    }
  }

  if (drawings.fibs) {
    for (let i = 0; i < drawings.fibs.length; i++) {
      const fib = drawings.fibs[i];
      if (!fib || !fib.startPoint || !fib.endPoint) continue;
      const startX = getXFromPoint(fib.startPoint);
      const startY = candlestickSeries.priceToCoordinate(fib.startPoint.price);
      const endX = getXFromPoint(fib.endPoint);
      const endY = candlestickSeries.priceToCoordinate(fib.endPoint.price);
      if (startX !== null && startY !== null && endX !== null && endY !== null) {
        const isSelected = activeSelectedObject && (activeSelectedObject.type === "fib" || activeSelectedObject.type === "fib_handle") && activeSelectedObject.index === i;
        if (isSelected) {
          if (Math.hypot(mouseX - startX, mouseY - startY) < 14) {
            return { type: "fib_handle", index: i, part: "start" };
          }
          if (Math.hypot(mouseX - endX, mouseY - endY) < 14) {
            return { type: "fib_handle", index: i, part: "end" };
          }
        }

        // Check trend line
        const dTrend = distToSegment(mouseX, mouseY, startX, startY, endX, endY);
        if (dTrend < 14) {
          return { type: "fib", index: i };
        }

        const plotArea = getChartPlotArea();
        const leftX = Math.min(startX, endX);
        const rightX = Math.max(startX, endX);
        const lineStartX = fib.extendLeft && plotArea ? plotArea.left : leftX;
        const lineEndX = fib.extendRight && plotArea ? plotArea.right : rightX;

        // Check horizontal levels
        const rawLevels = fib.levels || getDefaultFibLevels();
        for (let j = 0; j < rawLevels.length; j++) {
          const lvl = rawLevels[j];
          if (lvl.enabled === false) continue;
          const p = calculateFibLevelPrice(fib, lvl.level);
          const y = candlestickSeries.priceToCoordinate(p);
          if (y !== null && mouseX >= lineStartX - 8 && mouseX <= lineEndX + 8 && Math.abs(mouseY - y) < 10) {
            return { type: "fib", index: i };
          }
        }

        // Inside fill area between min level Y and max level Y
        if (mouseX >= lineStartX && mouseX <= lineEndX) {
          const pMin = calculateFibLevelPrice(fib, 0);
          const pMax = calculateFibLevelPrice(fib, 1);
          const y1 = candlestickSeries.priceToCoordinate(pMin);
          const y2 = candlestickSeries.priceToCoordinate(pMax);
          if (y1 !== null && y2 !== null) {
            const minY = Math.min(y1, y2);
            const maxY = Math.max(y1, y2);
            if (mouseY >= minY && mouseY <= maxY) {
              return { type: "fib", index: i };
            }
          }
        }
      }
    }
  }

  return null;
}

let orderPlacementMouseDownX = null;
let orderPlacementMouseDownY = null;
let orderPlacementMouseDownTime = 0;

container.addEventListener(
  "mousedown",
  (e) => {
    const menu = document.getElementById("custom-ctx-menu");
    if (menu && menu.contains(e.target)) return;
    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    hideContextMenu();
    if (e.button === 2) return;

    if (activeTool !== "cursor") {
      e.stopPropagation();
      if (activeTool === "brush") {
        const plotArea = getChartPlotArea();
        const clampedX = Math.max(
          plotArea.left,
          Math.min(plotArea.right, mouseX),
        );
        const clampedY = Math.max(
          plotArea.top,
          Math.min(plotArea.bottom, mouseY),
        );
        isDrawingBrush = true;
        const pt = getPointFromCoords(clampedX, clampedY);
        if (pt) {
          currentBrushPath = {
            id: Math.random().toString(36).substr(2, 9),
            color: activeColor,
            width: 2.5,
            points: [pt],
          };
          drawAllOnCanvas();
        }
      } else if (activeTool === "hline") {
        const price = candlestickSeries.coordinateToPrice(mouseY);
        if (price !== null) {
          saveState();
          drawings.horizontalLines.push({
            id: Math.random().toString(36).substr(2, 9),
            price: price,
            color: activeColor,
          });
          saveDrawings();
          setActiveTool("cursor");
          showToast("Горизонтальная линия установлена", "success");
        }
      } else if (activeTool === "wait_level") {
        const price = candlestickSeries.coordinateToPrice(mouseY);
        if (price !== null) {
          saveState();
          if (!Array.isArray(drawings.waitLevels)) drawings.waitLevels = [];
          drawings.waitLevels.push({
            id: Math.random().toString(36).substr(2, 9),
            price: price,
            color: activeColor === "#3b82f6" ? "#f59e0b" : activeColor,
            style: "dashed",
            title: "Уровень ожидания",
          });
          activeSelectedObject = { type: "wait_level", index: drawings.waitLevels.length - 1 };
          saveDrawings();
          setActiveTool("cursor");
          showToast("Уровень ожидания установлен", "success");
          drawAllOnCanvas();
        }
      } else if (activeTool === "vlad_ray") {
        const plotArea = getChartPlotArea();
        const clampedX = Math.max(plotArea.left, Math.min(plotArea.right, mouseX));
        const clampedY = Math.max(plotArea.top, Math.min(plotArea.bottom, mouseY));
        const pt = getPointFromCoords(clampedX, clampedY);
        if (pt) {
          saveState();
          if (!Array.isArray(drawings.vladRays)) drawings.vladRays = [];
          drawings.vladRays.push({
            id: Math.random().toString(36).substr(2, 9),
            price: pt.price,
            startPoint: pt,
            color: activeColor,
            width: 2.0
          });
          saveDrawings();
          setActiveTool("cursor");
          showToast("Инструмент 'Для Влада' установлен", "success");
          drawAllOnCanvas();
        }
      } else if (activeTool === "long" || activeTool === "short") {
        const pt = getPointFromCoords(mouseX, mouseY);
        if (pt) {
          const entryPrice = pt.price;
          let barSpacing = getBarSpacing();
          const dynamicWidth = Math.max(60, Math.round(70 * barSpacing));
          const visibleHeight = container.clientHeight || 400;
          let visiblePriceRange = entryPrice * 0.02;
          const maxVisiblePrice = candlestickSeries.coordinateToPrice(0);
          const minVisiblePrice =
            candlestickSeries.coordinateToPrice(visibleHeight);
          if (maxVisiblePrice !== null && minVisiblePrice !== null) {
            visiblePriceRange = Math.abs(maxVisiblePrice - minVisiblePrice);
          }
          const targetPrice =
            activeTool === "long"
              ? entryPrice + visiblePriceRange * 0.15
              : entryPrice - visiblePriceRange * 0.15;
          const stopPrice =
            activeTool === "long"
              ? entryPrice - visiblePriceRange * 0.15
              : entryPrice + visiblePriceRange * 0.15;

          saveState();
          drawings.positions.push({
            id: Math.random().toString(36).substr(2, 9),
            type: activeTool,
            time: pt.time,
            offsetXFraction: pt.offsetXFraction,
            entryPrice: entryPrice,
            targetPrice: targetPrice,
            stopPrice: stopPrice,
            color: activeColor,
            widthInCandles: 70,
            width: dynamicWidth,
          });
          saveDrawings();
          setActiveTool("cursor");
          showToast("Инструмент позиции добавлен", "success");
        }
      } else if (activeTool === "line" || activeTool === "rect" || activeTool === "fib") {
        const plotArea = getChartPlotArea();
        const clampedX = Math.max(plotArea.left, Math.min(plotArea.right, mouseX));
        const clampedY = Math.max(plotArea.top, Math.min(plotArea.bottom, mouseY));
        const pt = getPointFromCoords(clampedX, clampedY);
        if (pt) {
          if (!tempDrawing) {
            isDrawingLineOrRect = true;
            drawingMouseDownPos = { x: e.clientX, y: e.clientY };
            if (activeTool === "fib") {
              tempDrawing = createDefaultFib(pt, pt, activeColor);
            } else {
              tempDrawing = {
                id: Math.random().toString(36).substr(2, 9),
                type: activeTool,
                startPoint: pt,
                endPoint: pt,
                color: activeColor,
                width: 2.5
              };
            }
            drawAllOnCanvas();
          } else {
            // Second click: finalize object
            tempDrawing.endPoint = pt;
            if (!Array.isArray(drawings.rectangles)) drawings.rectangles = [];
            if (!Array.isArray(drawings.lines)) drawings.lines = [];
            if (!Array.isArray(drawings.fibs)) drawings.fibs = [];

            saveState();
            const finalizedObj = JSON.parse(JSON.stringify(tempDrawing));
            if (tempDrawing.type === "line") {
              drawings.lines.push(finalizedObj);
              activeSelectedObject = { type: "line", index: drawings.lines.length - 1 };
            } else if (tempDrawing.type === "rect") {
              drawings.rectangles.push(finalizedObj);
              activeSelectedObject = { type: "rect", index: drawings.rectangles.length - 1 };
            } else if (tempDrawing.type === "fib") {
              drawings.fibs.push(finalizedObj);
              activeSelectedObject = { type: "fib", index: drawings.fibs.length - 1 };
            }
            saveDrawings();
            showToast(tempDrawing.type === "line" ? "Линия тренда добавлена" : tempDrawing.type === "rect" ? "Прямоугольник добавлен" : "Коррекция Фибоначчи построена", "success");

            tempDrawing = null;
            isDrawingLineOrRect = false;
            drawingMouseDownPos = null;
            setActiveTool("cursor");
            drawAllOnCanvas();
          }
        }
      } else if (activeTool === "text") {
        const plotArea = getChartPlotArea();
        const clampedX = Math.max(plotArea.left, Math.min(plotArea.right, mouseX));
        const clampedY = Math.max(plotArea.top, Math.min(plotArea.bottom, mouseY));
        const pt = getPointFromCoords(clampedX, clampedY);
        if (pt) {
          openInlineTextEditor(pt);
          setActiveTool("cursor");
        }
      } else if (activeTool === "path") {
        const plotArea = getChartPlotArea();
        const clampedX = Math.max(plotArea.left, Math.min(plotArea.right, mouseX));
        const clampedY = Math.max(plotArea.top, Math.min(plotArea.bottom, mouseY));
        const pt = getPointFromCoords(clampedX, clampedY);
        if (pt) {
          const now = Date.now();
          if (lastPathClickTime && now - lastPathClickTime < 250) {
            finishPath();
            return;
          }
          lastPathClickTime = now;

          if (!tempPath) {
            tempPath = {
              id: Math.random().toString(36).substr(2, 9),
              type: "path",
              points: [pt],
              color: activeColor,
              width: 2.5
            };
            showToast("Траектория: кликайте для добавления точек. Двойной клик или клик на последней точке для завершения", "info");
          } else {
            const lastPt = tempPath.points[tempPath.points.length - 1];
            const lastX = getXFromPoint(lastPt);
            const lastY = candlestickSeries.priceToCoordinate(lastPt.price);
            if (lastX !== null && lastY !== null && Math.hypot(mouseX - lastX, mouseY - lastY) < 18) {
              finishPath();
              return;
            }
            tempPath.points.push(pt);
          }
          drawAllOnCanvas();
        }
      }
      return;
    }

    const hit = findObjectAtCoords(mouseX, mouseY);
    if (hit) {
      if (hit.type === "line_handle") {
        activeSelectedObject = { type: "line", index: hit.index };
      } else if (hit.type === "rect_handle") {
        activeSelectedObject = { type: "rect", index: hit.index };
      } else {
        activeSelectedObject = hit;
      }
    } else {
      activeSelectedObject = null;
    }
    drawAllOnCanvas();

    if (hit) {
      if (hit.type === "wait_level_ff") {
        e.preventDefault();
        e.stopPropagation();
        const lvl = drawings.waitLevels[hit.index];
        if (lvl) {
          executeFastForwardToPrice(lvl.price);
        }
        return;
      }

      if (hit.type === "pos_close_btn") {
        e.preventDefault();
        e.stopPropagation();
        if (hit.lineType === "tp") {
          const pos = state.positions.find((p) => p.id === hit.id);
          if (pos) {
            pos.takeProfit = 0;
            pos.tp = 0;
            saveSimulatorState();
            updateSimulatorUI();
            drawAllOnCanvas();
            showToast("Уровень TP удален", "success");
          }
        } else if (hit.lineType === "sl") {
          const pos = state.positions.find((p) => p.id === hit.id);
          if (pos) {
            pos.stopLoss = 0;
            pos.sl = 0;
            saveSimulatorState();
            updateSimulatorUI();
            drawAllOnCanvas();
            showToast("Уровень SL удален", "success");
          }
        } else {
          closePosition(hit.id);
        }
        return;
      }

      const startPrice = candlestickSeries.coordinateToPrice(mouseY);
      if (startPrice !== null) {
        e.preventDefault();
        e.stopPropagation();

        saveState(); // Сэйв перед началом перетаскивания

        if (hit.type === "hline") {
          const line = drawings.horizontalLines[hit.index];
          activeDrag = {
            type: "hline",
            index: hit.index,
            startPrice: startPrice,
            originalPrice: line.price,
          };
        } else if (hit.type === "wait_level") {
          const line = drawings.waitLevels[hit.index];
          activeDrag = {
            type: "wait_level",
            index: hit.index,
            startPrice: startPrice,
            originalPrice: line.price,
          };
        } else if (hit.type === "vlad_ray_handle") {
          const ray = drawings.vladRays[hit.index];
          const startTimeX = getXFromPoint(ray.startPoint);
          activeDrag = {
            type: "vlad_ray_handle",
            index: hit.index,
            startPrice: startPrice,
            originalStartPoint: { ...ray.startPoint },
            originalTimeX: startTimeX !== null ? startTimeX : mouseX,
            startX: mouseX
          };
          container.style.cursor = "move";
        } else if (hit.type === "vlad_ray") {
          const ray = drawings.vladRays[hit.index];
          const startTimeX = getXFromPoint(ray.startPoint);
          activeDrag = {
            type: "vlad_ray",
            index: hit.index,
            startPrice: startPrice,
            originalStartPoint: { ...ray.startPoint },
            originalTimeX: startTimeX !== null ? startTimeX : mouseX,
            startX: mouseX
          };
          container.style.cursor = "move";
        } else if (hit.type === "pos_entry") {
          activeDrag = {
            type: "pos_entry",
            id: hit.id,
            startPrice: startPrice,
            originalPrice: hit.position.entryPrice,
            originalTP: hit.position.takeProfit,
            originalSL: hit.position.stopLoss,
          };
          container.style.cursor = "ns-resize";
        } else if (hit.type === "pos_tp") {
          activeDrag = {
            type: "pos_tp",
            id: hit.id,
            startPrice: startPrice,
            originalPrice: hit.position.takeProfit,
          };
          container.style.cursor = "ns-resize";
        } else if (hit.type === "pos_sl") {
          activeDrag = {
            type: "pos_sl",
            id: hit.id,
            startPrice: startPrice,
            originalPrice: hit.position.stopLoss,
          };
          container.style.cursor = "ns-resize";
        } else if (hit.type === "position") {
          const pos = drawings.positions[hit.index];
          const startX = getXFromPosition(pos);
          const barSpacing = getBarSpacing();
          const widthInCandles = pos.widthInCandles || 70;
          const dynamicWidth = Math.round(widthInCandles * barSpacing);
          activeDrag = {
            type: "position",
            index: hit.index,
            part: hit.part,
            startX: mouseX,
            startPrice: startPrice,
            originalTime: pos.time,
            originalOffsetXFraction: pos.offsetXFraction || 0,
            originalStartX: startX !== null ? startX : mouseX,
            originalWidth: dynamicWidth,
            originalEntry: pos.entryPrice,
            originalTarget: pos.targetPrice,
            originalStop: pos.stopPrice,
          };
          if (hit.part === "left_handle" || hit.part === "right_handle") {
            container.style.cursor = "ew-resize";
          } else if (
            hit.part === "top_handle" ||
            hit.part === "bottom_handle"
          ) {
            container.style.cursor = "ns-resize";
          } else {
            container.style.cursor = "move";
          }
        } else if (hit.type === "line_handle") {
          activeDrag = {
            type: "line_handle",
            index: hit.index,
            part: hit.part,
            startPrice: startPrice,
          };
          container.style.cursor = "move";
        } else if (hit.type === "line") {
          const line = drawings.lines[hit.index];
          const startTimeX = getXFromPoint(line.startPoint);
          const endTimeX = getXFromPoint(line.endPoint);
          activeDrag = {
            type: "line",
            index: hit.index,
            startPrice: startPrice,
            startPoint: { ...line.startPoint },
            endPoint: { ...line.endPoint },
            originalTimeX: startTimeX !== null ? startTimeX : mouseX,
            originalEndTimeX: endTimeX !== null ? endTimeX : mouseX,
            startX: mouseX,
          };
          container.style.cursor = "move";
        } else if (hit.type === "rect_handle") {
          activeDrag = {
            type: "rect_handle",
            index: hit.index,
            part: hit.part,
            startPrice: startPrice,
          };
          if (hit.part === "top_left" || hit.part === "bottom_right") {
            container.style.cursor = "nwse-resize";
          } else if (hit.part === "top_right" || hit.part === "bottom_left") {
            container.style.cursor = "nesw-resize";
          } else if (hit.part === "mid_top" || hit.part === "mid_bottom") {
            container.style.cursor = "ns-resize";
          } else if (hit.part === "mid_left" || hit.part === "mid_right") {
            container.style.cursor = "ew-resize";
          } else {
            container.style.cursor = "move";
          }
        } else if (hit.type === "rect") {
          const rect = drawings.rectangles[hit.index];
          const startTimeX = getXFromPoint(rect.startPoint);
          const endTimeX = getXFromPoint(rect.endPoint);
          activeDrag = {
            type: "rect",
            index: hit.index,
            startPrice: startPrice,
            startPoint: { ...rect.startPoint },
            endPoint: { ...rect.endPoint },
            originalTimeX: startTimeX !== null ? startTimeX : mouseX,
            originalEndTimeX: endTimeX !== null ? endTimeX : mouseX,
            startX: mouseX,
          };
          container.style.cursor = "move";
        } else if (hit.type === "text") {
          const txtObj = drawings.texts[hit.index];
          activeDrag = {
            type: "text",
            index: hit.index,
            startPrice: startPrice,
            startX: mouseX,
            originalPoint: { ...txtObj.point }
          };
          container.style.cursor = "move";
        } else if (hit.type === "path_handle") {
          activeDrag = {
            type: "path_handle",
            index: hit.index,
            pointIndex: hit.pointIndex,
            startPrice: startPrice
          };
          container.style.cursor = "move";
        } else if (hit.type === "path") {
          const pathObj = drawings.paths[hit.index];
          activeDrag = {
            type: "path",
            index: hit.index,
            startPrice: startPrice,
            startX: mouseX,
            originalPoints: JSON.parse(JSON.stringify(pathObj.points))
          };
          container.style.cursor = "move";
        }
      }
    } else {
      if (state.isTradeModeActive && activeTool === "cursor") {
        const orderTypeSelect = document.getElementById("order-type-select");
        if (orderTypeSelect) {
          const plotArea = getChartPlotArea();
          if (
            mouseX >= plotArea.left &&
            mouseX <= plotArea.right &&
            mouseY >= plotArea.top &&
            mouseY <= plotArea.bottom
          ) {
            if (orderTypeSelect.value === "market") {
              // Record start coordinates of click so we don't block chart drag/scroll
              orderPlacementMouseDownX = e.clientX;
              orderPlacementMouseDownY = e.clientY;
              orderPlacementMouseDownTime = Date.now();
            } else {
              e.preventDefault();
              e.stopPropagation();
              const clickedPrice = candlestickSeries.coordinateToPrice(mouseY);
              if (clickedPrice !== null) {
                console.log("Попытка создания ордера на уровне:", clickedPrice);
                const isBuy = getOrderPreviewType();
                const priceInput = document.getElementById("order-price-input");
                if (priceInput) priceInput.value = clickedPrice.toFixed(5);
                placeOrder(isBuy, clickedPrice);
                
                // Reset creation mode in the sidebar automatically
                orderTypeSelect.value = "market";
                orderTypeSelect.dispatchEvent(new Event("change"));
              }
            }
          }
        }
      }
    }
  },
  true,
);

function isHoveredObjectEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.type === b.type && a.index === b.index && a.id === b.id && a.part === b.part && a.lineIndex === b.lineIndex;
}

container.addEventListener(
  "mousemove",
  (e) => {
    const rect = cachedContainerRect || container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    if (activeTool === "path" && tempPath) {
      const plotArea = getChartPlotArea();
      const clampedX = Math.max(plotArea.left, Math.min(plotArea.right, mouseX));
      const clampedY = Math.max(plotArea.top, Math.min(plotArea.bottom, mouseY));
      mousePreviewPt = getPointFromCoords(clampedX, clampedY);
      requestDrawAllOnCanvas();
      return;
    }

    if (activeDrag) {
      e.preventDefault();
      e.stopPropagation();
      if (activeDrag.isButton) {
        activeDrag.hasMoved = true;
      }
      const currentPrice = candlestickSeries.coordinateToPrice(mouseY);
      if (currentPrice !== null) {
        const deltaPrice = currentPrice - activeDrag.startPrice;
        if (activeDrag.type === "hline") {
          drawings.horizontalLines[activeDrag.index].price =
            activeDrag.originalPrice + deltaPrice;
        } else if (activeDrag.type === "wait_level") {
          drawings.waitLevels[activeDrag.index].price =
            activeDrag.originalPrice + deltaPrice;
        } else if (activeDrag.type === "vlad_ray_handle") {
          const ray = drawings.vladRays[activeDrag.index];
          if (ray) {
            const pt = getPointFromCoords(mouseX, mouseY);
            if (pt) {
              ray.startPoint = pt;
              ray.price = pt.price;
            }
          }
        } else if (activeDrag.type === "vlad_ray") {
          const ray = drawings.vladRays[activeDrag.index];
          if (ray) {
            const deltaX = mouseX - activeDrag.startX;
            const newStartX = activeDrag.originalTimeX + deltaX;
            const newPt = getPointFromCoords(newStartX, mouseY);
            if (newPt) {
              ray.startPoint = newPt;
            }
            ray.price = activeDrag.originalStartPoint.price + deltaPrice;
          }
        } else if (activeDrag.type === "pos_entry") {
          const pos = state.positions.find((p) => p.id === activeDrag.id);
          if (pos) {
            const newEntry = parseFloat(
              (activeDrag.originalPrice + deltaPrice).toFixed(5),
            );
            pos.entryPrice = newEntry;
            pos.triggerPrice = pos.entryPrice;
            if (activeDrag.originalTP && activeDrag.originalTP > 0) {
              pos.takeProfit = parseFloat(
                (activeDrag.originalTP + deltaPrice).toFixed(5),
              );
              const tpGlobal = document.getElementById("order-tp-input");
              if (tpGlobal) tpGlobal.value = pos.takeProfit.toFixed(5);
            }
            if (activeDrag.originalSL && activeDrag.originalSL > 0) {
              pos.stopLoss = parseFloat(
                (activeDrag.originalSL + deltaPrice).toFixed(5),
              );
              const slGlobal = document.getElementById("order-sl-input");
              if (slGlobal) slGlobal.value = pos.stopLoss.toFixed(5);
            }
            const priceInput = document.getElementById("order-price-input");
            if (priceInput) priceInput.value = pos.entryPrice.toFixed(5);
          }
        } else if (activeDrag.type === "pos_tp") {
          const pos = state.positions.find((p) => p.id === activeDrag.id);
          if (pos) {
            const mousePrice = activeDrag.originalPrice + deltaPrice;
            let val = mousePrice;
            if (pos.type === "buy") {
              val = Math.max(mousePrice, pos.entryPrice);
            } else if (pos.type === "sell") {
              val = Math.min(mousePrice, pos.entryPrice);
            }
            pos.takeProfit = parseFloat(val.toFixed(5));
            const tpGlobal = document.getElementById("order-tp-input");
            if (tpGlobal) tpGlobal.value = pos.takeProfit.toFixed(5);
            const tpInput = document.getElementById(`pos-tp-input-${pos.id}`);
            if (tpInput) {
              tpInput.value = pos.takeProfit.toFixed(5);
            }
          }
        } else if (activeDrag.type === "pos_sl") {
          const pos = state.positions.find((p) => p.id === activeDrag.id);
          if (pos) {
            const mousePrice = activeDrag.originalPrice + deltaPrice;
            let val = mousePrice;
            if (pos.type === "buy") {
              val = Math.min(mousePrice, pos.entryPrice);
            } else if (pos.type === "sell") {
              val = Math.max(mousePrice, pos.entryPrice);
            }
            pos.stopLoss = parseFloat(val.toFixed(5));
            const slGlobal = document.getElementById("order-sl-input");
            if (slGlobal) slGlobal.value = pos.stopLoss.toFixed(5);
            const slInput = document.getElementById(`pos-sl-input-${pos.id}`);
            if (slInput) {
              slInput.value = pos.stopLoss.toFixed(5);
            }
          }
        } else if (activeDrag.type === "position") {
          const pos = drawings.positions[activeDrag.index];
          const barSpacing = getBarSpacing();
          if (activeDrag.part === "right_handle") {
            const deltaX = mouseX - activeDrag.startX;
            const newWidth = Math.max(20, activeDrag.originalWidth + deltaX);
            pos.width = newWidth;
            pos.widthInCandles = Math.max(1, Math.round(newWidth / barSpacing));
          } else if (activeDrag.part === "left_handle") {
            const deltaX = mouseX - activeDrag.startX;
            const newWidth = Math.max(20, activeDrag.originalWidth - deltaX);
            const currentStartX = activeDrag.originalStartX + deltaX;
            const pt = getPointFromCoords(currentStartX, mouseY);
            if (pt) {
              pos.time = pt.time;
              pos.offsetXFraction = pt.offsetXFraction;
              pos.width = newWidth;
              pos.widthInCandles = Math.max(
                1,
                Math.round(newWidth / barSpacing),
              );
            }
          } else if (activeDrag.part === "top_handle") {
            if (pos.type === "long") {
              pos.targetPrice = currentPrice;
            } else {
              pos.stopPrice = currentPrice;
            }
          } else if (activeDrag.part === "bottom_handle") {
            if (pos.type === "long") {
              pos.stopPrice = currentPrice;
            } else {
              pos.targetPrice = currentPrice;
            }
          } else if (
            activeDrag.part === "entry_line" ||
            activeDrag.part === "target_box" ||
            activeDrag.part === "stop_box"
          ) {
            const deltaX = mouseX - activeDrag.startX;
            const currentStartX = activeDrag.originalStartX + deltaX;
            const pt = getPointFromCoords(currentStartX, mouseY);
            if (pt) {
              pos.time = pt.time;
              pos.offsetXFraction = pt.offsetXFraction;
            }
            pos.entryPrice = activeDrag.originalEntry + deltaPrice;
            pos.targetPrice = activeDrag.originalTarget + deltaPrice;
            pos.stopPrice = activeDrag.originalStop + deltaPrice;
          }
        } else if (activeDrag.type === "line_handle") {
          const pt = getPointFromCoords(mouseX, mouseY);
          if (pt) {
            const line = drawings.lines[activeDrag.index];
            if (activeDrag.part === "start") {
              line.startPoint = pt;
            } else if (activeDrag.part === "end") {
              line.endPoint = pt;
            }
          }
        } else if (activeDrag.type === "line") {
          const deltaPrice = currentPrice - activeDrag.startPrice;
          const deltaX = mouseX - activeDrag.startX;
          
          const newStartX = activeDrag.originalTimeX + deltaX;
          const newEndX = activeDrag.originalEndTimeX + deltaX;
          
          const ptStart = getPointFromCoords(newStartX, mouseY);
          const ptEnd = getPointFromCoords(newEndX, mouseY);
          
          const line = drawings.lines[activeDrag.index];
          line.startPoint.price = activeDrag.startPoint.price + deltaPrice;
          line.endPoint.price = activeDrag.endPoint.price + deltaPrice;
          
          if (ptStart) {
            line.startPoint.time = ptStart.time;
            line.startPoint.offsetXFraction = ptStart.offsetXFraction;
          }
          if (ptEnd) {
            line.endPoint.time = ptEnd.time;
            line.endPoint.offsetXFraction = ptEnd.offsetXFraction;
          }
        } else if (activeDrag.type === "rect_handle") {
          const pt = getPointFromCoords(mouseX, mouseY);
          if (pt) {
            const rect = drawings.rectangles[activeDrag.index];
            if (activeDrag.part === "top_left") {
              rect.startPoint = pt;
            } else if (activeDrag.part === "bottom_right") {
              rect.endPoint = pt;
            } else if (activeDrag.part === "top_right") {
              rect.startPoint.price = pt.price;
              rect.endPoint.time = pt.time;
              rect.endPoint.offsetXFraction = pt.offsetXFraction;
            } else if (activeDrag.part === "bottom_left") {
              rect.startPoint.time = pt.time;
              rect.startPoint.offsetXFraction = pt.offsetXFraction;
              rect.endPoint.price = pt.price;
            } else if (activeDrag.part === "mid_top") {
              rect.startPoint.price = pt.price;
            } else if (activeDrag.part === "mid_bottom") {
              rect.endPoint.price = pt.price;
            } else if (activeDrag.part === "mid_left") {
              rect.startPoint.time = pt.time;
              rect.startPoint.offsetXFraction = pt.offsetXFraction;
            } else if (activeDrag.part === "mid_right") {
              rect.endPoint.time = pt.time;
              rect.endPoint.offsetXFraction = pt.offsetXFraction;
            }
          }
        } else if (activeDrag.type === "rect") {
          const deltaPrice = currentPrice - activeDrag.startPrice;
          const deltaX = mouseX - activeDrag.startX;
          
          const newStartX = activeDrag.originalTimeX + deltaX;
          const newEndX = activeDrag.originalEndTimeX + deltaX;
          
          const ptStart = getPointFromCoords(newStartX, mouseY);
          const ptEnd = getPointFromCoords(newEndX, mouseY);
          
          const rect = drawings.rectangles[activeDrag.index];
          rect.startPoint.price = activeDrag.startPoint.price + deltaPrice;
          rect.endPoint.price = activeDrag.endPoint.price + deltaPrice;
          
          if (ptStart) {
            rect.startPoint.time = ptStart.time;
            rect.startPoint.offsetXFraction = ptStart.offsetXFraction;
          }
          if (ptEnd) {
            rect.endPoint.time = ptEnd.time;
            rect.endPoint.offsetXFraction = ptEnd.offsetXFraction;
          }
        } else if (activeDrag.type === "text") {
          const txtObj = drawings.texts[activeDrag.index];
          if (txtObj) {
            const priceDiff = currentPrice - activeDrag.startPrice;
            const newPt = getPointFromCoords(mouseX, mouseY);
            if (newPt) {
              txtObj.point = newPt;
            } else {
              txtObj.point.price = activeDrag.originalPoint.price + priceDiff;
            }
          }
        } else if (activeDrag.type === "fib_handle") {
          const pt = getPointFromCoords(mouseX, mouseY);
          if (pt) {
            const fib = drawings.fibs[activeDrag.index];
            if (activeDrag.part === "start") {
              fib.startPoint = pt;
            } else {
              fib.endPoint = pt;
            }
          }
        } else if (activeDrag.type === "fib") {
          const deltaPrice = currentPrice - activeDrag.startPrice;
          const deltaX = mouseX - activeDrag.startX;

          const newStartX = activeDrag.originalTimeX + deltaX;
          const newEndX = activeDrag.originalEndTimeX + deltaX;

          const ptStart = getPointFromCoords(newStartX, mouseY);
          const ptEnd = getPointFromCoords(newEndX, mouseY);

          const fib = drawings.fibs[activeDrag.index];
          fib.startPoint.price = activeDrag.startPoint.price + deltaPrice;
          fib.endPoint.price = activeDrag.endPoint.price + deltaPrice;

          if (ptStart) {
            fib.startPoint.time = ptStart.time;
            fib.startPoint.offsetXFraction = ptStart.offsetXFraction;
          }
          if (ptEnd) {
            fib.endPoint.time = ptEnd.time;
            fib.endPoint.offsetXFraction = ptEnd.offsetXFraction;
          }
        } else if (activeDrag.type === "path_handle") {
          const pathObj = drawings.paths[activeDrag.index];
          if (pathObj && pathObj.points && pathObj.points[activeDrag.pointIndex]) {
            const newPt = getPointFromCoords(mouseX, mouseY);
            if (newPt) {
              pathObj.points[activeDrag.pointIndex] = newPt;
            }
          }
        } else if (activeDrag.type === "path") {
          const pathObj = drawings.paths[activeDrag.index];
          if (pathObj && activeDrag.originalPoints) {
            const priceDiff = currentPrice - activeDrag.startPrice;
            const xDiff = mouseX - activeDrag.startX;
            const startPriceY = candlestickSeries.priceToCoordinate(activeDrag.startPrice);
            pathObj.points = activeDrag.originalPoints.map((origPt) => {
              const origX = getXFromPoint(origPt);
              if (origX !== null) {
                const newX = origX + xDiff;
                const origY = candlestickSeries.priceToCoordinate(origPt.price);
                if (origY !== null && startPriceY !== null) {
                  const newY = origY + (mouseY - startPriceY);
                  const ptNew = getPointFromCoords(newX, newY);
                  if (ptNew) return ptNew;
                }
              }
              return {
                ...origPt,
                price: origPt.price + priceDiff
              };
            });
          }
        } else if (activeDrag.type === "preview_entry") {
          const oldPrice = state.orderPreviewPrice;
          const newPrice = parseFloat(currentPrice.toFixed(5));
          const priceDiff = newPrice - oldPrice;
          state.orderPreviewPrice = newPrice;
          if (state.orderPreviewTP)
            state.orderPreviewTP = parseFloat(
              (state.orderPreviewTP + priceDiff).toFixed(5),
            );
          if (state.orderPreviewSL)
            state.orderPreviewSL = parseFloat(
              (state.orderPreviewSL + priceDiff).toFixed(5),
            );

          const priceInput = document.getElementById("order-price-input");
          if (priceInput) priceInput.value = state.orderPreviewPrice.toFixed(5);
          const tpInput = document.getElementById("order-tp-input");
          if (tpInput && state.orderPreviewTPEnabled && state.orderPreviewTP)
            tpInput.value = state.orderPreviewTP.toFixed(5);
          const slInput = document.getElementById("order-sl-input");
          if (slInput && state.orderPreviewSLEnabled && state.orderPreviewSL)
            slInput.value = state.orderPreviewSL.toFixed(5);
        } else if (activeDrag.type === "preview_tp") {
          const isBuy = getOrderPreviewType();
          const entry = state.orderPreviewPrice;
          let val = currentPrice;
          if (isBuy === "buy") {
            val = Math.max(currentPrice, entry);
          } else {
            val = Math.min(currentPrice, entry);
          }
          state.orderPreviewTP = parseFloat(val.toFixed(5));
          const tpInput = document.getElementById("order-tp-input");
          if (tpInput) tpInput.value = state.orderPreviewTP.toFixed(5);
        } else if (activeDrag.type === "preview_sl") {
          const isBuy = getOrderPreviewType();
          const entry = state.orderPreviewPrice;
          let val = currentPrice;
          if (isBuy === "buy") {
            val = Math.min(currentPrice, entry);
          } else {
            val = Math.max(currentPrice, entry);
          }
          state.orderPreviewSL = parseFloat(val.toFixed(5));
          const slInput = document.getElementById("order-sl-input");
          if (slInput) slInput.value = state.orderPreviewSL.toFixed(5);
        }
        saveDrawings();
        requestDrawAllOnCanvas();
      }
      return;
    }

    if (isDrawingLineOrRect && tempDrawing) {
      e.stopPropagation();
      const plotArea = getChartPlotArea();
      const clampedX = Math.max(plotArea.left, Math.min(plotArea.right, mouseX));
      const clampedY = Math.max(plotArea.top, Math.min(plotArea.bottom, mouseY));
      const pt = getPointFromCoords(clampedX, clampedY);
      if (pt) {
        tempDrawing.endPoint = pt;
        requestDrawAllOnCanvas();
      }
      return;
    }

    if (isDrawingBrush && activeTool === "brush" && currentBrushPath) {
      e.stopPropagation();
      const plotArea = getChartPlotArea();
      const clampedX = Math.max(
        plotArea.left,
        Math.min(plotArea.right, mouseX),
      );
      const clampedY = Math.max(
        plotArea.top,
        Math.min(plotArea.bottom, mouseY),
      );
      const pt = getPointFromCoords(clampedX, clampedY);
      if (pt) {
        currentBrushPath.points.push(pt);
        requestDrawAllOnCanvas();
      }
      return;
    }

    if (activeTool === "cursor") {
      const orderTypeSelect = document.getElementById("order-type-select");

      const hit = findObjectAtCoords(mouseX, mouseY);
      const oldHovered = hoveredObject;
      hoveredObject = hit;
      if (!isHoveredObjectEqual(oldHovered, hoveredObject)) {
        requestDrawAllOnCanvas();
      }
      if (hit) {
        canvas.style.pointerEvents = "auto";
        if (hit.type === "pos_close_btn" || hit.type === "wait_level_ff") {
          container.style.cursor = "pointer";
          canvas.style.cursor = "pointer";
        } else if (
          hit.type === "hline" ||
          hit.type === "wait_level" ||
          hit.type === "pos_entry" ||
          hit.type === "pos_tp" ||
          hit.type === "pos_sl"
        ) {
          container.style.cursor = "ns-resize";
        } else if (hit.type === "pos_active_entry") {
          container.style.cursor = "default";
        } else if (hit.type === "position") {
          if (hit.part === "left_handle" || hit.part === "right_handle") {
            container.style.cursor = "ew-resize";
          } else if (
            hit.part === "top_handle" ||
            hit.part === "bottom_handle"
          ) {
            container.style.cursor = "ns-resize";
          } else {
            container.style.cursor = "move";
          }
        } else if (hit.type === "brush" || hit.type === "line" || hit.type === "rect" || hit.type === "text" || hit.type === "path") {
          container.style.cursor = "pointer";
        } else if (hit.type === "path_handle") {
          container.style.cursor = "move";
        } else if (hit.type === "rect_handle") {
          if (hit.part === "top_left" || hit.part === "bottom_right") {
            container.style.cursor = "nwse-resize";
          } else if (hit.part === "top_right" || hit.part === "bottom_left") {
            container.style.cursor = "nesw-resize";
          } else if (hit.part === "mid_top" || hit.part === "mid_bottom") {
            container.style.cursor = "ns-resize";
          } else if (hit.part === "mid_left" || hit.part === "mid_right") {
            container.style.cursor = "ew-resize";
          } else {
            container.style.cursor = "move";
          }
        }
      } else {
        if (orderTypeSelect && orderTypeSelect.value !== "market") {
          canvas.style.pointerEvents = "auto";
          container.style.cursor = "crosshair";
        } else {
          canvas.style.pointerEvents = "none";
          container.style.cursor = "default";
        }
      }
    }
  },
  true,
);

window.addEventListener("mouseup", (e) => {
  if (activeDrag) {
    const wasCustomOrder =
      activeDrag.type === "pos_entry" ||
      activeDrag.type === "pos_tp" ||
      activeDrag.type === "pos_sl";
    activeDrag = null;
    container.style.cursor = "default";
    if (wasCustomOrder) {
      saveSimulatorState();
      updateSimulatorUI();
      showToast("Параметры ордера обновлены", "success");
    } else {
      showToast("Положение объекта сохранено", "success");
    }
  }
  if (isDrawingLineOrRect && tempDrawing && drawingMouseDownPos) {
    const distMoved = Math.hypot(e.clientX - drawingMouseDownPos.x, e.clientY - drawingMouseDownPos.y);
    if (distMoved > 10) {
      // User dragged and released mouse
      if (!Array.isArray(drawings.rectangles)) drawings.rectangles = [];
      if (!Array.isArray(drawings.lines)) drawings.lines = [];

      saveState();
      const finalizedObj = JSON.parse(JSON.stringify(tempDrawing));
      if (tempDrawing.type === "line") {
        drawings.lines.push(finalizedObj);
        activeSelectedObject = { type: "line", index: drawings.lines.length - 1 };
      } else if (tempDrawing.type === "rect") {
        drawings.rectangles.push(finalizedObj);
        activeSelectedObject = { type: "rect", index: drawings.rectangles.length - 1 };
      } else if (tempDrawing.type === "fib") {
        if (!Array.isArray(drawings.fibs)) drawings.fibs = [];
        drawings.fibs.push(finalizedObj);
        activeSelectedObject = { type: "fib", index: drawings.fibs.length - 1 };
      }
      saveDrawings();
      showToast(tempDrawing.type === "line" ? "Линия тренда добавлена" : tempDrawing.type === "rect" ? "Прямоугольник добавлен" : "Коррекция Фибоначчи построена", "success");

      tempDrawing = null;
      isDrawingLineOrRect = false;
      drawingMouseDownPos = null;
      setActiveTool("cursor");
      drawAllOnCanvas();
    } else {
      // Small click/release - clear down position so 2nd click works without mouseup interference
      drawingMouseDownPos = null;
    }
  }
  if (isDrawingBrush) {
    isDrawingBrush = false;
    if (currentBrushPath && currentBrushPath.points.length > 1) {
      saveState();
      drawings.brushPaths.push(currentBrushPath);
      saveDrawings();
    }
    currentBrushPath = null;
    drawAllOnCanvas();
  }
});

container.addEventListener("dblclick", (e) => {
  const menu = document.getElementById("custom-ctx-menu");
  if (menu && menu.contains(e.target)) return;
  const rect = container.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;

  if (activeTool === "path" && tempPath) {
    finishPath();
    return;
  }

  const hit = findObjectAtCoords(mouseX, mouseY);
  if (hit) {
    if (hit.type === "text" && drawings.texts[hit.index]) {
      const textObj = drawings.texts[hit.index];
      openInlineTextEditor(textObj.point, textObj, hit.index);
    } else if ((hit.type === "fib" || hit.type === "fib_handle") && drawings.fibs && drawings.fibs[hit.index]) {
      openFibSettingsModal(hit.index);
    }
  }
});

window.addEventListener("keydown", (e) => {
  if (activeTool === "path" && tempPath && (e.key === "Escape" || e.key === "Enter")) {
    finishPath();
    return;
  }

  if (
    document.activeElement &&
    (document.activeElement.tagName === "INPUT" ||
      document.activeElement.tagName === "TEXTAREA" ||
      document.activeElement.isContentEditable)
  ) {
    return;
  }

  // Режим записи горячих клавиш в настройках
  if (typeof isRecordingHotkey !== "undefined" && isRecordingHotkey) {
    if (typeof handleHotkeyRecordingKeydown === "function") {
      handleHotkeyRecordingKeydown(e);
      return;
    }
  }

  // Модальное окно подтверждения закрытия всех позиций
  const closeAllModal = document.getElementById("close-all-positions-confirm-modal");
  if (closeAllModal && closeAllModal.style.display !== "none" && closeAllModal.style.display !== "") {
    if (e.key === "Escape") {
      e.preventDefault();
      closeAllModal.style.display = "none";
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      closeAllModal.style.display = "none";
      if (typeof executeCloseAllPositions === "function") {
        executeCloseAllPositions();
      }
      return;
    }
  }

  // Горячая клавиша быстрой перемотки бэктеста до результата сделки (TP/SL)
  if (typeof checkAndTriggerFastForwardHotkey === "function") {
    if (checkAndTriggerFastForwardHotkey(e)) {
      return;
    }
  }

  // Пользовательские горячие клавиши (Play/Pause, шаги, скорость, таймфреймы 1-9, индикатор)
  if (typeof dispatchCustomHotkeys === "function") {
    if (dispatchCustomHotkeys(e)) {
      return;
    }
  }

  // Обработка Ctrl+Z и Ctrl+Y (Undo / Redo)
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
    return;
  }
  if (
    (e.ctrlKey || e.metaKey) &&
    (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))
  ) {
    e.preventDefault();
    redo();
    return;
  }

  if (!activeSelectedObject) return;
  const key = e.key;
  let handled = false;

  if (key === "Delete" || key === "Backspace") {
    let { type, index } = activeSelectedObject;
    if (type === "line_handle") type = "line";
    if (type === "rect_handle") type = "rect";
    if (type === "path_handle") type = "path";
    if (type === "vlad_ray_handle") type = "vlad_ray";
    if (type === "fib_handle") type = "fib";

    saveState();
    if (type === "hline") {
      drawings.horizontalLines.splice(index, 1);
    } else if (type === "wait_level") {
      if (drawings.waitLevels) drawings.waitLevels.splice(index, 1);
    } else if (type === "vlad_ray") {
      if (drawings.vladRays) drawings.vladRays.splice(index, 1);
    } else if (type === "fib") {
      if (drawings.fibs) drawings.fibs.splice(index, 1);
    } else if (type === "position") {
      drawings.positions.splice(index, 1);
    } else if (type === "brush") {
      drawings.brushPaths.splice(index, 1);
    } else if (type === "line") {
      drawings.lines.splice(index, 1);
    } else if (type === "rect") {
      drawings.rectangles.splice(index, 1);
    } else if (type === "text") {
      if (drawings.texts) drawings.texts.splice(index, 1);
    } else if (type === "path") {
      if (drawings.paths) drawings.paths.splice(index, 1);
    }
    activeSelectedObject = null;
    if (
      hoveredObject &&
      (hoveredObject.type === type || (type === "line" && hoveredObject.type === "line_handle") || (type === "rect" && hoveredObject.type === "rect_handle") || (type === "path" && hoveredObject.type === "path_handle") || (type === "vlad_ray" && hoveredObject.type === "vlad_ray_handle") || (type === "fib" && hoveredObject.type === "fib_handle") || hoveredObject.type === "wait_level_ff") &&
      hoveredObject.index === index
    ) {
      hoveredObject = null;
    }
    saveDrawings();
    
    // Explicitly clear canvas
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    
    drawAllOnCanvas();
    requestAnimationFrame(() => {
      drawAllOnCanvas();
    });
    showToast("Объект удален", "info");
    handled = true;
  } else if (
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowRight"
  ) {
    let { type, index } = activeSelectedObject;
    if (type === "vlad_ray_handle") type = "vlad_ray";

    if (type === "hline") {
      const line = drawings.horizontalLines[index];
      if (line) {
        saveState();
        const step = 0.0001;
        if (key === "ArrowUp") line.price += step;
        else if (key === "ArrowDown") line.price -= step;
        saveDrawings();
        drawAllOnCanvas();
        handled = true;
      }
    } else if (type === "wait_level") {
      const line = drawings.waitLevels[index];
      if (line) {
        saveState();
        const step = 0.0001;
        if (key === "ArrowUp") line.price += step;
        else if (key === "ArrowDown") line.price -= step;
        saveDrawings();
        drawAllOnCanvas();
        handled = true;
      }
    } else if (type === "vlad_ray") {
      const ray = drawings.vladRays[index];
      if (ray) {
        saveState();
        const step = 0.0001;
        if (key === "ArrowUp") ray.price += step;
        else if (key === "ArrowDown") ray.price -= step;
        else if (key === "ArrowLeft" || key === "ArrowRight") {
          const curX = getXFromPoint(ray.startPoint);
          if (curX !== null) {
            const deltaX = key === "ArrowLeft" ? -10 : 10;
            const newPt = getPointFromCoords(curX + deltaX, candlestickSeries.priceToCoordinate(ray.price) || 0);
            if (newPt) ray.startPoint = newPt;
          }
        }
        saveDrawings();
        drawAllOnCanvas();
        handled = true;
      }
    } else if (type === "fib") {
      const fib = drawings.fibs[index];
      if (fib) {
        saveState();
        const step = 0.0001;
        if (key === "ArrowUp") {
          fib.startPoint.price += step;
          fib.endPoint.price += step;
          handled = true;
        } else if (key === "ArrowDown") {
          fib.startPoint.price -= step;
          fib.endPoint.price -= step;
          handled = true;
        } else if (key === "ArrowLeft" || key === "ArrowRight") {
          const curStartX = getXFromPoint(fib.startPoint);
          const curEndX = getXFromPoint(fib.endPoint);
          if (curStartX !== null && curEndX !== null) {
            const deltaX = key === "ArrowLeft" ? -10 : 10;
            const ptStart = getPointFromCoords(curStartX + deltaX, candlestickSeries.priceToCoordinate(fib.startPoint.price) || 0);
            const ptEnd = getPointFromCoords(curEndX + deltaX, candlestickSeries.priceToCoordinate(fib.endPoint.price) || 0);
            if (ptStart) fib.startPoint = ptStart;
            if (ptEnd) fib.endPoint = ptEnd;
            handled = true;
          }
        }
        if (handled) {
          saveDrawings();
          drawAllOnCanvas();
        }
      }
    } else if (type === "position") {
      const pos = drawings.positions[index];
      if (pos) {
        saveState();
        const step = 0.0001;
        if (key === "ArrowUp") {
          pos.entryPrice += step;
          pos.targetPrice += step;
          pos.stopPrice += step;
          handled = true;
        } else if (key === "ArrowDown") {
          pos.entryPrice -= step;
          pos.targetPrice -= step;
          pos.stopPrice -= step;
          handled = true;
        } else if (key === "ArrowLeft" || key === "ArrowRight") {
          const allCandles = state.historicalCandles;
          if (allCandles && allCandles.length > 0) {
            const currentIdx = allCandles.findIndex((c) => c.time === pos.time);
            if (currentIdx !== -1) {
              if (key === "ArrowLeft" && currentIdx > 0) {
                pos.time = allCandles[currentIdx - 1].time;
                handled = true;
              } else if (
                key === "ArrowRight" &&
                currentIdx < allCandles.length - 1
              ) {
                pos.time = allCandles[currentIdx + 1].time;
                handled = true;
              }
            }
          }
        }
        if (handled) {
          saveDrawings();
          drawAllOnCanvas();
        }
      }
    }
  }
  if (handled) {
    e.preventDefault();
  }
});

chart.timeScale().subscribeVisibleTimeRangeChange(() => requestDrawAllOnCanvas());
chart.timeScale().subscribeVisibleLogicalRangeChange(() => requestDrawAllOnCanvas());

container.addEventListener("wheel", () => requestDrawAllOnCanvas(), { passive: true });
container.addEventListener("mousedown", () => requestDrawAllOnCanvas(), {
  passive: true,
});
container.addEventListener("mouseup", () => requestDrawAllOnCanvas(), {
  passive: true,
});

container.addEventListener("click", (e) => {
  const menu = document.getElementById("custom-ctx-menu");
  if (menu && menu.contains(e.target)) return;

  if (state.isTradeModeActive && activeTool === "cursor" && orderPlacementMouseDownX !== null && orderPlacementMouseDownY !== null) {
    const dx = e.clientX - orderPlacementMouseDownX;
    const dy = e.clientY - orderPlacementMouseDownY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const duration = Date.now() - orderPlacementMouseDownTime;

    // Reset coords
    orderPlacementMouseDownX = null;
    orderPlacementMouseDownY = null;

    if (dist < 6 && duration < 400) {
      const orderTypeSelect = document.getElementById("order-type-select");
      if (orderTypeSelect && orderTypeSelect.value === "market") {
        const hasDraft = state.positions.some(pos => pos.status === "draft");
        if (hasDraft) {
          showToast("У вас уже есть неподтвержденный черновик ордера!", "warning");
          return;
        }

        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const plotArea = getChartPlotArea();

        if (
          mouseX >= plotArea.left &&
          mouseX <= plotArea.right &&
          mouseY >= plotArea.top &&
          mouseY <= plotArea.bottom
        ) {
          const clickedPrice = candlestickSeries.coordinateToPrice(mouseY);
          if (clickedPrice !== null) {
            const isBuy = getOrderPreviewType();
            placeOrder(isBuy, clickedPrice);
          }
        }
      }
    }
  } else {
    // Reset coords if trade mode is off or tool is active
    orderPlacementMouseDownX = null;
    orderPlacementMouseDownY = null;
  }
});

toolCursorBtn.addEventListener("click", () => setActiveTool("cursor"));
toolBrushBtn.addEventListener("click", () => setActiveTool("brush"));
toolHlineBtn.addEventListener("click", () => setActiveTool("hline"));
if (toolWaitLevelBtn) {
  toolWaitLevelBtn.addEventListener("click", () => setActiveTool("wait_level"));
}
if (toolVladRayBtn) {
  toolVladRayBtn.addEventListener("click", () => setActiveTool("vlad_ray"));
  
  let vladTooltipEl = null;
  let vladHoverTimer = null;

  const hideVladTooltip = () => {
    if (vladHoverTimer) {
      clearTimeout(vladHoverTimer);
      vladHoverTimer = null;
    }
    if (vladTooltipEl) {
      const el = vladTooltipEl;
      vladTooltipEl = null;
      el.style.opacity = "0";
      el.style.transform = "translateY(4px)";
      setTimeout(() => {
        if (el && el.parentNode) el.parentNode.removeChild(el);
      }, 200);
    }
  };

  const showVladTooltip = () => {
    if (vladTooltipEl) return;
    vladTooltipEl = document.createElement("div");
    vladTooltipEl.className = "custom-vlad-tooltip";
    vladTooltipEl.textContent = "Я знаю ты этим часто пользуешься❤️";
    vladTooltipEl.style.position = "fixed";
    vladTooltipEl.style.backgroundColor = "rgba(15, 23, 42, 0.96)";
    vladTooltipEl.style.color = "#ffffff";
    vladTooltipEl.style.border = "1px solid rgba(255, 255, 255, 0.15)";
    vladTooltipEl.style.borderRadius = "6px";
    vladTooltipEl.style.padding = "6px 12px";
    vladTooltipEl.style.fontSize = "12px";
    vladTooltipEl.style.fontWeight = "500";
    vladTooltipEl.style.fontFamily = "Inter, sans-serif";
    vladTooltipEl.style.boxShadow = "0 6px 20px rgba(0, 0, 0, 0.45)";
    vladTooltipEl.style.pointerEvents = "none";
    vladTooltipEl.style.zIndex = "100000";
    vladTooltipEl.style.opacity = "0";
    vladTooltipEl.style.transform = "translateY(4px)";
    vladTooltipEl.style.transition = "opacity 0.2s ease, transform 0.2s ease";
    vladTooltipEl.style.whiteSpace = "nowrap";

    document.body.appendChild(vladTooltipEl);

    const rect = toolVladRayBtn.getBoundingClientRect();
    const tooltipWidth = vladTooltipEl.offsetWidth || 230;
    const tooltipHeight = vladTooltipEl.offsetHeight || 30;

    let top = rect.top - tooltipHeight - 8;
    let left = rect.left + (rect.width / 2) - (tooltipWidth / 2);

    if (top < 10) {
      top = rect.bottom + 8;
    }
    if (left < 10) left = 10;
    if (left + tooltipWidth > window.innerWidth - 10) {
      left = window.innerWidth - tooltipWidth - 10;
    }

    vladTooltipEl.style.left = `${left}px`;
    vladTooltipEl.style.top = `${top}px`;

    requestAnimationFrame(() => {
      if (vladTooltipEl) {
        vladTooltipEl.style.opacity = "1";
        vladTooltipEl.style.transform = "translateY(0)";
      }
    });
  };

  toolVladRayBtn.addEventListener("mouseenter", () => {
    hideVladTooltip();
    vladHoverTimer = setTimeout(showVladTooltip, 300);
  });
  toolVladRayBtn.addEventListener("mouseleave", hideVladTooltip);
  toolVladRayBtn.addEventListener("click", hideVladTooltip);
}
toolLongBtn.addEventListener("click", () => setActiveTool("long"));
toolShortBtn.addEventListener("click", () => setActiveTool("short"));
if (toolLineBtn) toolLineBtn.addEventListener("click", () => setActiveTool("line"));
if (toolRectBtn) toolRectBtn.addEventListener("click", () => setActiveTool("rect"));
if (toolFibBtn) toolFibBtn.addEventListener("click", () => setActiveTool("fib"));
if (toolTextBtn) toolTextBtn.addEventListener("click", () => setActiveTool("text"));
if (toolPathBtn) toolPathBtn.addEventListener("click", () => setActiveTool("path"));
drawingColorInput.addEventListener("input", (e) => {
  activeColor = e.target.value;
  localStorage.setItem("drawing_color", activeColor);
});

toolClearBtn.addEventListener("click", () => {
  saveState();
  drawings.brushPaths = [];
  drawings.positions = [];
  drawings.horizontalLines = [];
  drawings.waitLevels = [];
  drawings.vladRays = [];
  drawings.lines = [];
  drawings.rectangles = [];
  drawings.texts = [];
  drawings.paths = [];
  drawings.fibs = [];
  saveDrawings();
  drawAllOnCanvas();
  showToast("Графическая разметка полностью очищена!", "info");
});

// Инициализация кнопки "Скриншот" на верхней панели инструментов
const toolbarScreenshotBtn = document.getElementById("toolbar-screenshot-btn");

if (toolbarScreenshotBtn) {
  toolbarScreenshotBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    captureAndSave("1080p");
  });
}

async function captureAndSave(quality) {
  if (typeof chart === "undefined" || !chart) {
    showToast("Ошибка: График не инициализирован!", "error");
    return;
  }
  
  const chartCanvas = chart.takeScreenshot();
  if (!chartCanvas) {
    showToast("Не удалось захватить график!", "error");
    return;
  }
  
  const drawingCanvas = document.getElementById("drawing-canvas");
  
  let targetHeight = 1080;
  if (quality === "144p") targetHeight = 144;
  else if (quality === "360p") targetHeight = 360;
  else if (quality === "720p") targetHeight = 720;
  else if (quality === "1080p") targetHeight = 1080;
  
  const originalWidth = chartCanvas.width || 800;
  const originalHeight = chartCanvas.height || 600;
  const aspectRatio = originalWidth / originalHeight;
  const targetWidth = Math.round(targetHeight * aspectRatio);
  
  const tempCanvas = document.createElement("canvas");
  tempCanvas.width = targetWidth;
  tempCanvas.height = targetHeight;
  const tempCtx = tempCanvas.getContext("2d");
  
  if (!tempCtx) {
    showToast("Ошибка создания холста скриншота!", "error");
    return;
  }
  
  tempCtx.imageSmoothingEnabled = true;
  tempCtx.imageSmoothingQuality = "high";
  
  // 1. Отрисовка графика
  tempCtx.drawImage(chartCanvas, 0, 0, targetWidth, targetHeight);
  
  // 2. Наложение графической разметки
  if (drawingCanvas) {
    tempCtx.drawImage(drawingCanvas, 0, 0, targetWidth, targetHeight);
  }
  
  const fileName = `chart_${quality}_${Date.now()}.png`;
  
  // Получаем blob
  tempCanvas.toBlob(async (blob) => {
    if (!blob) {
      showToast("Ошибка получения данных скриншота!", "error");
      return;
    }
    
    // Проверяем поддержку showSaveFilePicker и то, что мы не находимся во фрейме
    const canUseFilePicker = ('showSaveFilePicker' in window) && (window.self === window.top);
    if (canUseFilePicker) {
      try {
        const options = {
          suggestedName: fileName,
          types: [{
            description: 'PNG Image',
            accept: {
              'image/png': ['.png'],
            },
          }],
        };
        const handle = await window.showSaveFilePicker(options);
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        showToast("Скриншот успешно сохранен на диск!", "success");
      } catch (err) {
        if (err.name === 'AbortError') {
          showToast("Сохранение отменено пользователем", "info");
        } else {
          console.warn("Служебное предупреждение: перенаправление на скачивание через браузер:", err);
          triggerFallbackDownload(blob, fileName);
        }
      }
    } else {
      triggerFallbackDownload(blob, fileName);
    }
  }, "image/png");
}

function triggerFallbackDownload(blob, fileName) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("Скриншот скачан через браузер!", "success");
  } catch (err) {
    console.error("Ошибка при стандартном скачивании:", err);
    showToast("Не удалось сохранить скриншот!", "error");
  }
}

let activeContextObject = null;

function showContextMenu(hit, clientX, clientY) {
  activeContextObject = hit;
  const menu = document.getElementById("custom-ctx-menu");
  if (!menu) return;

  const ctxSettingsBtn = document.getElementById("ctx-settings-btn");
  if (ctxSettingsBtn) {
    if (hit.type === "fib" || hit.type === "fib_handle") {
      ctxSettingsBtn.style.display = "flex";
      ctxSettingsBtn.onclick = () => {
        hideContextMenu();
        openFibSettingsModal(hit.index);
      };
    } else {
      ctxSettingsBtn.style.display = "none";
      ctxSettingsBtn.onclick = null;
    }
  }
  const ctxFFLevelBtn = document.getElementById("ctx-ff-level-btn");
  if (ctxFFLevelBtn) {
    if (hit.type === "wait_level") {
      ctxFFLevelBtn.style.display = "flex";
    } else {
      ctxFFLevelBtn.style.display = "none";
    }
  }
  const colorsRow = document.getElementById("ctx-colors-row");
  if (colorsRow && colorsRow.children.length === 0) {
    const colors = ["#3b82f6", "#10b981", "#ef4444", "#f59e0b", "#8b5cf6"];
    colors.forEach((c) => {
      const btn = document.createElement("div");
      btn.className = "ctx-color-btn";
      btn.setAttribute("data-color", c);
      btn.style.cssText = `width: 18px; height: 18px; border-radius: 50%; background-color: ${c}; cursor: pointer; border: 1px solid rgba(255,255,255,0.15); transition: transform 0.15s ease, border-color 0.15s ease;`;
      btn.addEventListener("mouseenter", () => {
        btn.style.transform = "scale(1.2)";
        btn.style.borderColor = "#ffffff";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.transform = "scale(1)";
        btn.style.borderColor = "rgba(255,255,255,0.15)";
      });
      btn.addEventListener("click", () => {
        if (activeContextObject) {
          let { type, index } = activeContextObject;
          if (type === "line_handle") type = "line";
          if (type === "rect_handle") type = "rect";
          if (type === "vlad_ray_handle") type = "vlad_ray";
          if (type === "fib_handle") type = "fib";

          saveState();
          if (type === "hline") {
            if (drawings.horizontalLines[index])
              drawings.horizontalLines[index].color = c;
          } else if (type === "wait_level") {
            if (drawings.waitLevels && drawings.waitLevels[index])
              drawings.waitLevels[index].color = c;
          } else if (type === "vlad_ray") {
            if (drawings.vladRays[index])
              drawings.vladRays[index].color = c;
          } else if (type === "fib") {
            if (drawings.fibs && drawings.fibs[index]) {
              drawings.fibs[index].color = c;
            }
          } else if (type === "position") {
            if (drawings.positions[index]) drawings.positions[index].color = c;
          } else if (type === "brush") {
            if (drawings.brushPaths[index])
              drawings.brushPaths[index].color = c;
          } else if (type === "line") {
            if (drawings.lines[index])
              drawings.lines[index].color = c;
          } else if (type === "rect") {
            if (drawings.rectangles[index])
              drawings.rectangles[index].color = c;
          }
          saveDrawings();
          drawAllOnCanvas();
          showToast("Цвет изменен", "success");
        }
        hideContextMenu();
      });
      colorsRow.appendChild(btn);
    });
  }
  menu.style.display = "block";
  const menuWidth = menu.offsetWidth || 150;
  const menuHeight = menu.offsetHeight || 120;
  let x = clientX;
  let y = clientY;
  if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 10;
  if (y + menuHeight > window.innerHeight)
    y = window.innerHeight - menuHeight - 10;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

function hideContextMenu() {
  const menu = document.getElementById("custom-ctx-menu");
  if (menu) menu.style.display = "none";
  activeContextObject = null;
}

const menuEl = document.getElementById("custom-ctx-menu");
if (menuEl) {
  menuEl.addEventListener("mousedown", (e) => e.stopPropagation());
  menuEl.addEventListener("mouseup", (e) => e.stopPropagation());
  menuEl.addEventListener("click", (e) => e.stopPropagation());
  menuEl.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
}

document.getElementById("ctx-delete-btn")?.addEventListener("click", () => {
  if (activeContextObject) {
    let { type, index } = activeContextObject;
    if (type === "line_handle") type = "line";
    if (type === "rect_handle") type = "rect";
    if (type === "path_handle") type = "path";
    if (type === "vlad_ray_handle") type = "vlad_ray";
    if (type === "fib_handle") type = "fib";

    saveState();
    if (type === "hline") {
      drawings.horizontalLines.splice(index, 1);
    } else if (type === "wait_level") {
      if (drawings.waitLevels) drawings.waitLevels.splice(index, 1);
    } else if (type === "vlad_ray") {
      if (drawings.vladRays) drawings.vladRays.splice(index, 1);
    } else if (type === "fib") {
      if (drawings.fibs) drawings.fibs.splice(index, 1);
    } else if (type === "position") {
      drawings.positions.splice(index, 1);
    } else if (type === "brush") {
      drawings.brushPaths.splice(index, 1);
    } else if (type === "line") {
      drawings.lines.splice(index, 1);
    } else if (type === "rect") {
      drawings.rectangles.splice(index, 1);
    } else if (type === "text") {
      if (drawings.texts) drawings.texts.splice(index, 1);
    } else if (type === "path") {
      if (drawings.paths) drawings.paths.splice(index, 1);
    }
    if (
      activeSelectedObject &&
      (activeSelectedObject.type === type || (type === "line" && activeSelectedObject.type === "line_handle") || (type === "rect" && activeSelectedObject.type === "rect_handle") || (type === "path" && activeSelectedObject.type === "path_handle") || (type === "vlad_ray" && activeSelectedObject.type === "vlad_ray_handle") || (type === "fib" && activeSelectedObject.type === "fib_handle") || activeSelectedObject.type === "wait_level_ff") &&
      activeSelectedObject.index === index
    ) {
      activeSelectedObject = null;
    }
    if (
      hoveredObject &&
      (hoveredObject.type === type || (type === "line" && hoveredObject.type === "line_handle") || (type === "rect" && hoveredObject.type === "rect_handle") || (type === "path" && hoveredObject.type === "path_handle") || (type === "vlad_ray" && hoveredObject.type === "vlad_ray_handle") || (type === "fib" && hoveredObject.type === "fib_handle") || hoveredObject.type === "wait_level_ff") &&
      hoveredObject.index === index
    ) {
      hoveredObject = null;
    }
    saveDrawings();

    // Explicitly clear canvas
    const ctx = canvas.getContext("2d");
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    drawAllOnCanvas();
    requestAnimationFrame(() => {
      drawAllOnCanvas();
    });
    showToast("Объект успешно удален", "info");
  }
  hideContextMenu();
});

document.getElementById("ctx-ff-level-btn")?.addEventListener("click", () => {
  if (activeContextObject && activeContextObject.type === "wait_level") {
    const lvl = drawings.waitLevels[activeContextObject.index];
    hideContextMenu();
    if (lvl) {
      executeFastForwardToPrice(lvl.price);
    }
  }
});

const ctxSpectrumBtn = document.getElementById("ctx-spectrum-btn");
const ctxSpectrumPicker = document.getElementById("ctx-spectrum-picker");
ctxSpectrumBtn?.addEventListener("click", () => {
  saveState(); // Сэйв перед открытием спектр-пикера
  ctxSpectrumPicker?.click();
});
ctxSpectrumPicker?.addEventListener("input", (e) => {
  const color = e.target.value;
  if (color && activeContextObject) {
    let { type, index } = activeContextObject;
    if (type === "line_handle") type = "line";
    if (type === "rect_handle") type = "rect";
    if (type === "path_handle") type = "path";
    if (type === "vlad_ray_handle") type = "vlad_ray";
    if (type === "fib_handle") type = "fib";

    if (type === "hline") {
      if (drawings.horizontalLines[index])
        drawings.horizontalLines[index].color = color;
    } else if (type === "wait_level") {
      if (drawings.waitLevels && drawings.waitLevels[index])
        drawings.waitLevels[index].color = color;
    } else if (type === "vlad_ray") {
      if (drawings.vladRays[index])
        drawings.vladRays[index].color = color;
    } else if (type === "fib") {
      if (drawings.fibs && drawings.fibs[index])
        drawings.fibs[index].color = color;
    } else if (type === "position") {
      if (drawings.positions[index]) drawings.positions[index].color = color;
    } else if (type === "brush") {
      if (drawings.brushPaths[index]) drawings.brushPaths[index].color = color;
    } else if (type === "line") {
      if (drawings.lines[index]) drawings.lines[index].color = color;
    } else if (type === "rect") {
      if (drawings.rectangles[index]) drawings.rectangles[index].color = color;
    } else if (type === "text") {
      if (drawings.texts[index]) drawings.texts[index].color = color;
    } else if (type === "path") {
      if (drawings.paths[index]) drawings.paths[index].color = color;
    }
    saveDrawings();
    drawAllOnCanvas();
  }
});
ctxSpectrumPicker?.addEventListener("change", () => {
  hideContextMenu();
});

const toggleKeyVisibilityBtn = document.getElementById("toggle-key-visibility");
toggleKeyVisibilityBtn?.addEventListener("click", () => {
  if (tokenInput.type === "password") {
    tokenInput.type = "text";
    toggleKeyVisibilityBtn.innerHTML =
      '<i data-lucide="eye-off" style="width: 14px; height: 14px;"></i>';
  } else {
    tokenInput.type = "password";
    toggleKeyVisibilityBtn.innerHTML =
      '<i data-lucide="eye" style="width: 14px; height: 14px;"></i>';
  }
  lucide.createIcons();
});

const sidebarPaletteBtns = document.querySelectorAll(".palette-color-btn");
const sidebarSpectrumBtn = document.getElementById("sidebar-spectrum-btn");

sidebarPaletteBtns.forEach((btn) => {
  if (btn.getAttribute("data-color") === activeColor) {
    btn.classList.add("active");
  } else {
    btn.classList.remove("active");
  }
  btn.addEventListener("click", () => {
    sidebarPaletteBtns.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeColor = btn.getAttribute("data-color");
    localStorage.setItem("drawing_color", activeColor);
    if (drawingColorInput) drawingColorInput.value = activeColor;
    showToast("Выбран цвет: " + activeColor, "success");
  });
});

sidebarSpectrumBtn?.addEventListener("click", () => {
  drawingColorInput?.click();
});
drawingColorInput?.addEventListener("input", (e) => {
  activeColor = e.target.value;
  localStorage.setItem("drawing_color", activeColor);
  sidebarPaletteBtns.forEach((btn) => {
    if (
      btn.getAttribute("data-color").toLowerCase() === activeColor.toLowerCase()
    ) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
});

function updateProviderBadge() {
  const badge = document.getElementById("provider-badge");
  if (!badge) return;
  const val = tokenInput.value.trim();
  if (val) {
    badge.textContent = "Twelve Data (Свой ключ)";
    badge.style.cssText =
      "font-size:10px; margin-top:4px; padding:2px 6px; border-radius:4px; width:fit-content; font-weight:500; text-transform:uppercase; background-color: rgba(38, 166, 154, 0.15); color: #4db6ac; border: 1px solid rgba(38, 166, 154, 0.3);";
  } else {
    badge.textContent = "Twelve Data (Пул ключей)";
    badge.style.cssText =
      "font-size:10px; margin-top:4px; padding:2px 6px; border-radius:4px; width:fit-content; font-weight:500; text-transform:uppercase; background-color: rgba(75, 85, 99, 0.2); color: #d1d5db; border: 1px solid rgba(75, 85, 99, 0.45);";
  }
}

function getActiveApiKey() {
  const val = tokenInput.value.trim();
  if (val !== "") return val;
  return TWELVE_DATA_KEYS[Math.floor(Math.random() * TWELVE_DATA_KEYS.length)];
}

function triggerDataLoader() {
  if (state.isBacktestActive) {
    console.log("[triggerDataLoader] Bypassed because backtest is active.");
    return Promise.resolve();
  }
  if (state.currentProvider === "mt5") {
    return loadMT5Data();
  } else {
    if (tokenInput.value.trim()) {
      return loadMarketData();
    } else {
      loadDemoData();
      return Promise.resolve();
    }
  }
}

tokenInput.addEventListener("input", () => {
  const val = tokenInput.value.trim();
  localStorage.setItem("twelve_data_saved_key", val);
  updateProviderBadge();
  if (state.currentProvider === "twelvedata") {
    if (val) {
      loadMarketData();
    } else {
      loadDemoData();
    }
  }
});

const loadDataBtn = document.getElementById("load-data-btn");
if (loadDataBtn) {
  loadDataBtn.addEventListener("click", () => {
    triggerDataLoader();
  });
}

function updatePairTooltip(symbol) {
  const tooltipEl = document.getElementById("pair-tooltip-info");
  if (tooltipEl) {
    const cleanSym = (symbol || "EUR_USD").replace("_", "");
    tooltipEl.setAttribute("title", `Убедитесь, что символ [${cleanSym}] есть в Обзоре рынка вашего MT5 под точно таким именем`);
  }
}
window.updatePairTooltip = updatePairTooltip;

function applySymbolSelection(newSymbol) {
  if (!newSymbol) return;
  state.symbol = newSymbol;
  updatePairTooltip(state.symbol);
  updateHeaderPairDisplay(state.symbol);
  updateChartPrecision(state.symbol);
  
  const pairSelector = document.getElementById("pair-selector");
  if (pairSelector) {
    let opt = Array.from(pairSelector.options).find(o => o.value === newSymbol);
    if (!opt) {
      opt = document.createElement("option");
      opt.value = newSymbol;
      opt.textContent = newSymbol.replace("_", "/");
      pairSelector.appendChild(opt);
    }
    pairSelector.value = newSymbol;
  }

  if (typeof updateCOTChartData === "function" && typeof cotChartState !== "undefined" && cotChartState.active) {
    updateCOTChartData();
  }
  triggerDataLoader();
}
window.applySymbolSelection = applySymbolSelection;

if (pairSelector) {
  pairSelector.addEventListener("change", (e) => {
    applySymbolSelection(e.target.value);
  });
}

// ==========================================
// HISTORY VOLUME PRESETS & DURATION UTILITIES
// ==========================================

function pluralize(value, words) {
  if (!Number.isInteger(value)) {
    return words[1]; // e.g. "года", "месяца" (genitive singular for floats)
  }
  const valueAbs = Math.abs(value) % 100;
  const num = valueAbs % 10;
  if (valueAbs > 10 && valueAbs < 20) return words[2]; // e.g. "лет", "месяцев"
  if (num > 1 && num < 5) return words[1]; // e.g. "года", "месяца"
  if (num === 1) return words[0]; // e.g. "год", "месяц"
  return words[2];
}

function getDurationEstimate(barsCount, timeframe) {
  let tfInMinutes = 15;
  const tfMatch = timeframe.match(/^(\d+)([mhdwM])$/i) || timeframe.match(/^(\d+)([M])$/);
  if (tfMatch) {
    const val = parseInt(tfMatch[1], 10);
    const unit = tfMatch[2].toLowerCase();
    const isUpperM = tfMatch[2] === "M";
    if (unit === 'm') {
      if (isUpperM) {
        tfInMinutes = val * 30 * 24 * 60;
      } else {
        tfInMinutes = val;
      }
    } else if (unit === 'h') {
      tfInMinutes = val * 60;
    } else if (unit === 'd') {
      tfInMinutes = val * 24 * 60;
    } else if (unit === 'w') {
      tfInMinutes = val * 7 * 24 * 60;
    }
  } else {
    if (timeframe === "1M") {
      tfInMinutes = 30 * 24 * 60;
    } else if (timeframe === "12M") {
      tfInMinutes = 365 * 24 * 60;
    }
  }

  const totalMinutes = barsCount * tfInMinutes;
  
  const minutesInYear = 365 * 24 * 60;
  const minutesInMonth = 30 * 24 * 60;
  const minutesInDay = 24 * 60;
  const minutesInHour = 60;

  if (totalMinutes >= minutesInYear) {
    const years = (totalMinutes / minutesInYear).toFixed(1);
    return `≈ ${years} ${pluralize(parseFloat(years), ['год', 'года', 'лет'])}`;
  } else if (totalMinutes >= minutesInMonth) {
    const months = (totalMinutes / minutesInMonth).toFixed(1);
    return `≈ ${months} ${pluralize(parseFloat(months), ['месяц', 'месяца', 'месяцев'])}`;
  } else if (totalMinutes >= minutesInDay) {
    const days = (totalMinutes / minutesInDay).toFixed(1);
    return `≈ ${days} ${pluralize(parseFloat(days), ['день', 'дня', 'дней'])}`;
  } else if (totalMinutes >= minutesInHour) {
    const hours = (totalMinutes / minutesInHour).toFixed(1);
    return `≈ ${hours} ${pluralize(parseFloat(hours), ['час', 'часа', 'часов'])}`;
  } else {
    return `≈ ${totalMinutes} ${pluralize(totalMinutes, ['минута', 'минуты', 'минут'])}`;
  }
}

function updateHistoryDurationEstimate() {
  const presetSelect = document.getElementById("history-preset-select");
  const estimateEl = document.getElementById("history-duration-estimate");
  const tfSelect = document.getElementById("timeframe-select");
  
  if (!presetSelect || !estimateEl || !tfSelect) return;
  
  const barsCount = parseInt(presetSelect.value, 10);
  const timeframe = tfSelect.value;
  
  estimateEl.textContent = getDurationEstimate(barsCount, timeframe);
}

// Since the DOM might have already loaded, we run it immediately as well
setTimeout(updateHistoryDurationEstimate, 100);

function resampleAndSetFileCandles() {
  if (!state.isFileLoaded || !state.importedBaseCandles || state.importedBaseCandles.length === 0) return;

  const targetMinutes = timeframeToMinutes(state.timeframe);
  const baseMinutes = state.importedBaseMinutes || 15;

  let resampled;
  if (targetMinutes > baseMinutes) {
    resampled = aggregateCandles(state.importedBaseCandles, targetMinutes);
    console.log(`[Resampling] Aggregated ${state.importedBaseCandles.length} base candles (${baseMinutes}m) to ${resampled.length} candles (${state.timeframe} / ${targetMinutes}m).`);
  } else if (targetMinutes === baseMinutes) {
    resampled = state.importedBaseCandles;
    console.log(`[Resampling] Using raw base candles (${state.importedBaseCandles.length} candles) because selected timeframe matches base timeframe ${baseMinutes}m.`);
  } else {
    // targetMinutes < baseMinutes: aggregation is physically impossible!
    showToast("Нельзя получить более мелкий таймфрейм из сохранённого файла — пересохраните историю с более высоким базовым таймфреймом", "error");
    window.showBannerNotification("<strong>Ошибка:</strong> Нельзя получить более мелкий таймфрейм из сохранённого файла — пересохраните историю с более высоким базовым таймфреймом", 10);
    return;
  }

  state.historicalCandles = resampled;
  candlestickSeries.setData(resampled);
  
  if (resampled.length > 0) {
    updateLegend(resampled[resampled.length - 1]);
  }
  
  if (typeof updateCOTChartData === "function" && typeof cotChartState !== "undefined" && cotChartState.active) {
    updateCOTChartData();
  }
  
  drawAllOnCanvas();
}

const timeframeSelect = document.getElementById("timeframe-select");
if (timeframeSelect) {
  timeframeSelect.addEventListener("change", (e) => {
    const newTf = e.target.value;
    const oldTf = state.timeframe;

    if (state.isFileLoaded && state.importedBaseCandles && state.importedBaseCandles.length > 0) {
      const targetMinutes = timeframeToMinutes(newTf);
      const baseMinutes = state.importedBaseMinutes || 15;

      if (targetMinutes < baseMinutes) {
        // Revert select dropdown
        timeframeSelect.value = oldTf;
        showToast("Нельзя получить более мелкий таймфрейм из сохранённого файла — пересохраните историю с более высоким базовым таймфреймом", "error");
        window.showBannerNotification("<strong>Ошибка:</strong> Нельзя получить более мелкий таймфрейм из сохранённого файла — пересохраните историю с более высоким базовым таймфреймом", 10);
        return;
      }
    }

    state.timeframe = newTf;
    updateHistoryDurationEstimate();
    if (state.isBacktestActive && state.currentReplayTimestamp) {
      updateBacktestVisibleCandles();
      state.lastRenderedCandlesArray = null;
      candlestickSeries.setData(state.backtestVisibleCandles);
      const lastVisible = state.backtestVisibleCandles[state.backtestVisibleCandles.length - 1];
      if (lastVisible) {
        updateLegend(lastVisible);
      }
      if (typeof updateCOTChartData === "function" && typeof cotChartState !== "undefined" && cotChartState.active) {
        updateCOTChartData();
      }
      recenterView();
      drawAllOnCanvas();
    } else {
      if (state.isFileLoaded) {
        resampleAndSetFileCandles();
        recenterView();
      } else {
        triggerDataLoader().then(() => {
          recenterView();
        }).catch(() => {
          recenterView();
        });
      }
    }
  });
}

const historyPresetSelect = document.getElementById("history-preset-select");
if (historyPresetSelect) {
  historyPresetSelect.addEventListener("change", () => {
    updateHistoryDurationEstimate();
    triggerDataLoader();
  });
}

function updateConnectionStatus(status, type = "demo") {
  if (type === "active") {
    statusDot.className = "status-dot active";
  } else if (type === "demo") {
    statusDot.className = "status-dot demo";
  } else {
    statusDot.className = "status-dot";
  }
  statusText.textContent = status;
}

function saveBalance(val) {
  balance = val;
  localStorage.setItem("balance", balance.toString());
  updateSimulatorUI();
}

async function restoreVoiceNotesForTrades(trades) {
  if (!Array.isArray(trades)) return;

  // Clear stale blob URLs immediately to avoid broken players on startup
  trades.forEach((trade) => {
    if (trade.voiceNoteUrl && trade.voiceNoteUrl.indexOf("blob:") === 0) {
      trade.voiceNoteUrl = null;
    }
  });

  try {
    const notes = await getAllVoiceNotes();
    const notesMap = new Map();
    notes.forEach((note) => {
      notesMap.set(note.id, note.audio);
    });

    let hasUpdates = false;

    for (const trade of trades) {
      const id = `voice_note_${trade.id}`;
      let audioBlob = notesMap.get(id);

      if (!audioBlob) {
        try {
          const generalBlob = await getData(id);
          if (generalBlob instanceof Blob) {
            audioBlob = generalBlob;
          }
        } catch (e) {
          console.error("General store blob check failed for", id, e);
        }
      }

      if (!audioBlob && trade.voiceNoteBase64) {
        try {
          const arr = trade.voiceNoteBase64.split(",");
          const mime = arr[0].match(/:(.*?);/)[1];
          const bstr = atob(arr[1]);
          let n = bstr.length;
          const u8arr = new Uint8Array(n);
          while (n--) {
            u8arr[n] = bstr.charCodeAt(n);
          }
          audioBlob = new Blob([u8arr], { type: mime });
        } catch (err) {
          console.error("Base64 audio fallback conversion failed:", err);
        }
      }

      if (audioBlob instanceof Blob) {
        trade.voiceNoteUrl = URL.createObjectURL(audioBlob);
        hasUpdates = true;
      }
    }

    if (hasUpdates) {
      updateTradeHistoryUI();
    }
  } catch (err) {
    console.error("restoreVoiceNotesForTrades failed:", err);
  }
}

// --- PROP FIRM & PERSONAL ACCOUNTS MODULE ---

async function saveAccountState(accId = activeAccountId) {
  if (!accId) return;
  const targetAcc = accounts.find((a) => a.id === accId);
  if (!targetAcc) return;

  if (accId === activeAccountId) {
    targetAcc.current_balance = balance;
  }
  targetAcc.updated_at = new Date().toISOString();

  const levInput = document.getElementById("leverage-input");
  const currentLev = levInput ? (parseInt(levInput.value, 10) || 100) : 100;

  const accPositions = accId === activeAccountId
    ? (state.positions || [])
    : (state.positions || []).filter((p) => p.account_id === accId);

  const accTradeHistory = accId === activeAccountId
    ? (tradeHistory || [])
    : (tradeHistory || []).filter((t) => t.account_id === accId);

  const journalNotes = {};
  accTradeHistory.forEach((t) => {
    if (t.id) {
      journalNotes[t.id] = {
        thoughtBefore: t.thoughtBefore || (t.notes ? t.notes.noteBefore : "") || "",
        thoughtDuring: t.thoughtDuring || (t.notes ? t.notes.noteDuring : "") || "",
        thoughtAfter: t.thoughtAfter || (t.notes ? t.notes.noteAfter : "") || "",
        close_reason: t.close_reason || "MANUAL",
        tags: Array.isArray(t.tags) ? t.tags : [],
        comment: t.comment || "",
      };
    }
  });

  const accountStateData = {
    id: accId,
    accountInfo: { ...targetAcc },
    balance: accId === activeAccountId ? balance : (targetAcc.current_balance ?? targetAcc.initial_balance ?? 10000.0),
    leverage: currentLev,
    positions: accPositions,
    tradeHistory: accTradeHistory,
    journalNotes: journalNotes,
    updated_at: new Date().toISOString(),
  };

  try {
    await saveData(`account_${accId}`, accountStateData);

    if (accId === activeAccountId) {
      await saveData("active_account_id", activeAccountId);
      localStorage.setItem("plbt_active_account_id", activeAccountId);
    }
    saveAccountsToStorage();
  } catch (err) {
    console.error(`[AccountStorage] Failed to save state for account ${accId}:`, err);
  }
}

async function loadAccountState(accId) {
  if (!accId) return false;

  try {
    const key = `account_${accId}`;
    let accountData = await getData(key);

    const acc = accounts.find((a) => a.id === accId);
    if (!acc && !accountData) return false;

    if (accountData) {
      if (acc && accountData.accountInfo) {
        Object.assign(acc, accountData.accountInfo);
      }

      if (typeof accountData.balance === "number" && !isNaN(accountData.balance)) {
        balance = accountData.balance;
      } else if (acc && typeof acc.current_balance === "number") {
        balance = acc.current_balance;
      } else {
        balance = 10000.0;
      }
      if (acc) acc.current_balance = balance;

      if (accountData.leverage) {
        const levInput = document.getElementById("leverage-input");
        if (levInput) levInput.value = accountData.leverage;
        const fLev = document.getElementById("floating-order-leverage");
        if (fLev) fLev.value = accountData.leverage;
      }

      state.positions = Array.isArray(accountData.positions) ? accountData.positions : [];
      state.positions.forEach((p) => {
        if (!p.account_id) p.account_id = accId;
        if (!p.status) p.status = "active";
      });

      tradeHistory = Array.isArray(accountData.tradeHistory) ? accountData.tradeHistory : [];
      tradeHistory.forEach((t) => {
        if (!t.account_id) t.account_id = accId;
        if (accountData.journalNotes && accountData.journalNotes[t.id]) {
          const notes = accountData.journalNotes[t.id];
          if (notes.thoughtBefore && !t.thoughtBefore) t.thoughtBefore = notes.thoughtBefore;
          if (notes.thoughtDuring && !t.thoughtDuring) t.thoughtDuring = notes.thoughtDuring;
          if (notes.thoughtAfter && !t.thoughtAfter) t.thoughtAfter = notes.thoughtAfter;
          if (notes.close_reason && !t.close_reason) t.close_reason = notes.close_reason;
          if (notes.comment && !t.comment) t.comment = notes.comment;
          if (notes.tags && (!t.tags || t.tags.length === 0)) t.tags = notes.tags;
        }
      });
    } else if (acc) {
      balance = typeof acc.current_balance === "number" ? acc.current_balance : (acc.initial_balance || 10000.0);
      state.positions = [];
      tradeHistory = [];
      await saveAccountState(accId);
    }

    activeAccountId = accId;
    localStorage.setItem("plbt_active_account_id", activeAccountId);
    saveData("active_account_id", activeAccountId).catch(() => {});

    activeOrders = state.positions.filter((p) => p.status === "pending");
    openPositions = state.positions.filter((p) => p.status === "active");

    await restoreVoiceNotesForTrades(tradeHistory);

    if (capitalInput) capitalInput.value = balance;
    updateSimulatorUI();
    updateTradeHistoryUI();
    renderAccountSelector();
    renderHistoryAccountFilterSelect();

    return true;
  } catch (err) {
    console.error(`[AccountStorage] Failed to load state for account ${accId}:`, err);
    return false;
  }
}

async function initAccounts() {
  try {
    const savedAccounts = localStorage.getItem("plbt_accounts");
    if (savedAccounts) {
      accounts = JSON.parse(savedAccounts);
    }
  } catch (e) {
    accounts = [];
  }

  if (!Array.isArray(accounts) || accounts.length === 0) {
    const defaultAccount = {
      id: "acc-default-personal",
      name: "Основной личный счёт",
      type: "PERSONAL",
      broker_or_firm: "Основной Брокер",
      phase: "NOT_APPLICABLE",
      initial_balance: parseFloat(localStorage.getItem("balance")) || 10000.0,
      current_balance: parseFloat(localStorage.getItem("balance")) || 10000.0,
      currency: "USD",
      max_daily_drawdown_percent: null,
      max_total_drawdown_percent: null,
      profit_target_percent: null,
      profit_split_percent: 100,
      payouts_history: [],
      status: "ACTIVE",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    accounts = [defaultAccount];
  }

  let savedActiveId = await getData("active_account_id");
  if (!savedActiveId) {
    savedActiveId = localStorage.getItem("plbt_active_account_id");
  }

  if (savedActiveId && accounts.some((a) => a.id === savedActiveId)) {
    activeAccountId = savedActiveId;
  } else {
    activeAccountId = accounts[0].id;
  }

  saveAccountsToStorage();
  renderAccountSelector();
  renderHistoryAccountFilterSelect();
}

function getActiveAccount() {
  if (!accounts || accounts.length === 0) return null;
  return accounts.find(a => a.id === activeAccountId) || accounts[0];
}

function saveAccountsToStorage() {
  const activeAcc = getActiveAccount();
  if (activeAcc) {
    activeAcc.current_balance = balance;
    activeAcc.updated_at = new Date().toISOString();
  }
  try {
    localStorage.setItem("plbt_accounts", JSON.stringify(accounts));
    if (activeAccountId) {
      localStorage.setItem("plbt_active_account_id", activeAccountId);
    }
  } catch (e) {
    console.error("Failed to save accounts:", e);
  }
}

async function setActiveAccount(accountId, skipNotify = false) {
  if (!accountId) return;
  const targetAcc = accounts.find(a => a.id === accountId);
  if (!targetAcc) return;

  if (activeAccountId && activeAccountId !== accountId) {
    await saveAccountState(activeAccountId);
  }

  await loadAccountState(accountId);

  if (!skipNotify && typeof showToast === "function") {
    showToast(`Переключено на счёт: ${targetAcc.name}`, "info");
  }
}

function renderAccountSelector() {
  const activeAcc = getActiveAccount();
  if (!activeAcc) return;

  // 1. Active Account Indicator Dot on Header Hamburger Icon
  const dotEl = document.getElementById("account-active-indicator-dot");
  if (dotEl) {
    const isProp = activeAcc.type === "PROP";
    dotEl.className = `account-active-dot ${isProp ? "prop" : "personal"}`;
    dotEl.title = `Активный счёт: ${activeAcc.name} (${isProp ? "Prop Firm" : "Personal"})`;
  }

  // 2. Active Account Card inside Dropdown Menu
  const pillEl = document.getElementById("acc-card-pill");
  const brokerEl = document.getElementById("acc-card-broker");
  const nameEl = document.getElementById("acc-card-name");
  const balEl = document.getElementById("acc-card-balance");

  if (pillEl) {
    pillEl.textContent = activeAcc.type === "PROP" ? "PROP" : "PERSONAL";
    pillEl.className = `acc-type-pill ${activeAcc.type === "PROP" ? "prop" : "personal"}`;
  }
  if (brokerEl) {
    const phaseStr = (activeAcc.type === "PROP" && activeAcc.phase && activeAcc.phase !== "NOT_APPLICABLE") 
      ? ` • ${getPhaseLabel(activeAcc.phase)}` 
      : "";
    brokerEl.textContent = `${activeAcc.broker_or_firm}${phaseStr}`;
  }
  if (nameEl) {
    nameEl.textContent = activeAcc.name;
    nameEl.title = `${activeAcc.name} (${activeAcc.broker_or_firm})`;
  }
  if (balEl) {
    balEl.textContent = `$${activeAcc.current_balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

function renderAccountDropdownList() {
  const listEl = document.getElementById("account-dropdown-list");
  if (!listEl) return;

  if (!accounts || accounts.length === 0) {
    listEl.innerHTML = `<div style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 11px;">Счёта не найдены</div>`;
    return;
  }

  listEl.innerHTML = accounts.map(acc => {
    const isActive = acc.id === activeAccountId;
    const typeClass = acc.type === "PROP" ? "prop" : "personal";
    const phaseTag = (acc.type === "PROP" && acc.phase && acc.phase !== "NOT_APPLICABLE") ? ` <span style="font-size: 9px; opacity: 0.8;">[${getPhaseLabel(acc.phase)}]</span>` : "";
    let pendingBadge = "";
    if (acc.status === "PHASE1_COMPLETED_PENDING") {
      pendingBadge = ` <span style="font-size: 8px; background: rgba(245, 158, 11, 0.25); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.4); border-radius: 4px; padding: 1px 4px; font-weight: 700;">Фаза 1 пройдена</span>`;
    } else if (acc.status === "PHASE2_COMPLETED_PENDING") {
      pendingBadge = ` <span style="font-size: 8px; background: rgba(59, 130, 246, 0.25); color: #3b82f6; border: 1px solid rgba(59, 130, 246, 0.4); border-radius: 4px; padding: 1px 4px; font-weight: 700;">Фаза 2 пройдена</span>`;
    }

    const pnl = acc.current_balance - acc.initial_balance;
    const pnlSign = pnl >= 0 ? "+" : "";
    const pnlColor = pnl >= 0 ? "var(--color-up)" : "var(--color-down)";

    return `
      <div class="account-dropdown-item ${isActive ? 'active' : ''}" data-account-id="${acc.id}">
        <div style="display: flex; flex-direction: column; gap: 2px; overflow: hidden; max-width: 170px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="acc-type-pill ${typeClass}">${acc.type}</span>
            <span style="font-weight: 700; font-size: 11px; color: #fff; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${acc.name}</span>
          </div>
          <span style="font-size: 10px; color: var(--text-muted); text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${acc.broker_or_firm}${phaseTag}${pendingBadge}</span>
        </div>
        <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 2px;">
          <span class="font-mono" style="font-weight: 700; font-size: 11px; color: #fff;">$${acc.current_balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          <span class="font-mono" style="font-size: 9px; color: ${pnlColor};">${pnlSign}$${pnl.toFixed(2)}</span>
        </div>
      </div>
    `;
  }).join("");

  listEl.querySelectorAll(".account-dropdown-item").forEach(item => {
    item.addEventListener("click", () => {
      const accId = item.getAttribute("data-account-id");
      if (accId) {
        setActiveAccount(accId);
        const dropdown = document.getElementById("account-selector-dropdown");
        if (dropdown) dropdown.style.display = "none";
      }
    });
  });
}

function getPhaseLabel(phase) {
  switch (phase) {
    case "EVALUATION_1": return "Фаза 1";
    case "EVALUATION_2": return "Фаза 2";
    case "FUNDED": return "Фандед";
    default: return "";
  }
}

function getFilteredAccounts(category = "ALL") {
  if (!Array.isArray(accounts)) return [];

  const targetCategory = (category || "ALL").toString().toUpperCase();

  return accounts.filter((acc) => {
    if (!acc) return false;
    // Exclude deleted or archived accounts if status field is present
    if (acc.status === "DELETED" || acc.status === "ARCHIVED" || acc.deleted) {
      return false;
    }

    if (targetCategory === "ALL") return true;

    const rawType = (acc.type || acc.accountType || "PERSONAL").toString().toUpperCase();

    if (targetCategory === "PROP") {
      return rawType === "PROP" || rawType === "PROP_FIRM" || rawType === "PROP-FIRM";
    }

    if (targetCategory === "PERSONAL") {
      return rawType === "PERSONAL" || rawType === "PRIVATE";
    }

    return rawType === targetCategory;
  });
}

function getAccountCategoryCounts() {
  return {
    ALL: getFilteredAccounts("ALL").length,
    PERSONAL: getFilteredAccounts("PERSONAL").length,
    PROP: getFilteredAccounts("PROP").length
  };
}

function renderHistoryAccountFilterSelect() {
  const selectEl = document.getElementById("history-account-filter-select");
  if (!selectEl) return;

  const filteredAccounts = getFilteredAccounts(currentAccountCategoryFilter);

  selectEl.innerHTML = `<option value="ALL">Все счёта (${filteredAccounts.length})</option>` +
    filteredAccounts.map(acc => `
      <option value="${acc.id}" ${currentAccountSpecificFilter === acc.id ? 'selected' : ''}>
        [${acc.type}] ${acc.name} ($${acc.current_balance.toFixed(2)})
      </option>
    `).join("");
}

function openAccountsModal() {
  const modal = document.getElementById("accounts-modal");
  if (!modal) return;
  modal.style.display = "flex";
  renderAccountsModalCards();
  if (typeof lucide !== "undefined" && lucide.createIcons) {
    lucide.createIcons();
  }
}

function closeAccountsModal() {
  const modal = document.getElementById("accounts-modal");
  if (!modal) return;
  modal.style.display = "none";
}

function renderAccountsModalCards() {
  const grid = document.getElementById("accounts-cards-grid");
  if (!grid) return;

  const counts = getAccountCategoryCounts();

  const countAllEl = document.getElementById("acc-modal-count-all");
  const countPersonalEl = document.getElementById("acc-modal-count-personal");
  const countPropEl = document.getElementById("acc-modal-count-prop");

  if (countAllEl) countAllEl.textContent = counts.ALL;
  if (countPersonalEl) countPersonalEl.textContent = counts.PERSONAL;
  if (countPropEl) countPropEl.textContent = counts.PROP;

  const filtered = getFilteredAccounts(currentAccountModalTab);

  if (filtered.length === 0) {
    grid.innerHTML = `<div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--text-muted); font-size: 12px;">Счёта данной категории не найдены. Создайте свой первый счёт!</div>`;
    return;
  }

  grid.innerHTML = filtered.map(acc => {
    const isActive = acc.id === activeAccountId;
    const pnl = acc.current_balance - acc.initial_balance;
    const pnlPercent = acc.initial_balance > 0 ? (pnl / acc.initial_balance) * 100 : 0;
    const pnlSign = pnl >= 0 ? "+" : "";
    const pnlColor = pnl >= 0 ? "var(--color-up)" : "var(--color-down)";

    const accTrades = tradeHistory.filter(t => t.account_id === acc.id);
    const winTrades = accTrades.filter(t => (t.pnl || 0) > 0).length;
    const winRate = accTrades.length > 0 ? ((winTrades / accTrades.length) * 100).toFixed(1) : "0.0";

    let propMetricsHtml = "";
    if (acc.type === "PROP") {
      const targetPercent = acc.profit_target_percent || 10;
      const targetAmount = (acc.initial_balance * targetPercent) / 100;
      const targetProgress = Math.min(100, Math.max(0, (pnl / targetAmount) * 100));

      const dailyDdPercent = acc.max_daily_drawdown_percent || 5;
      const totalDdPercent = acc.max_total_drawdown_percent || 10;

      let maxDdAmount = 0;
      let peak = acc.initial_balance;
      let running = acc.initial_balance;
      const dailyPnL = {};

      accTrades.forEach(t => {
        running += (t.pnl || 0);
        if (running > peak) peak = running;
        const dd = peak - running;
        if (dd > maxDdAmount) maxDdAmount = dd;

        const timeVal = t.exitTime || t.closeTime || t.timestamp;
        if (timeVal) {
          let dateStr = "";
          if (typeof timeVal === "string") {
            dateStr = timeVal.split("T")[0] || timeVal.split(" ")[0];
          } else if (typeof timeVal === "number") {
            const d = new Date(timeVal > 1e11 ? timeVal : timeVal * 1000);
            dateStr = !isNaN(d.getTime()) ? d.toISOString().split("T")[0] : String(timeVal);
          } else if (typeof timeVal === "object" && timeVal !== null) {
            if (timeVal.year) {
              dateStr = `${timeVal.year}-${String(timeVal.month).padStart(2, "0")}-${String(timeVal.day).padStart(2, "0")}`;
            } else if (timeVal instanceof Date && !isNaN(timeVal.getTime())) {
              dateStr = timeVal.toISOString().split("T")[0];
            }
          }
          if (dateStr) {
            dailyPnL[dateStr] = (dailyPnL[dateStr] || 0) + (t.pnl || 0);
          }
        }
      });

      let worstDayLoss = 0;
      Object.values(dailyPnL).forEach(val => {
        if (val < worstDayLoss) worstDayLoss = val;
      });
      worstDayLoss = Math.abs(worstDayLoss);

      const maxDdPercent = acc.initial_balance > 0 ? (maxDdAmount / acc.initial_balance) * 100 : 0;
      const worstDayLossPercent = acc.initial_balance > 0 ? (worstDayLoss / acc.initial_balance) * 100 : 0;

      const dailyDdBarWidth = Math.min(100, (worstDayLossPercent / dailyDdPercent) * 100);
      const totalDdBarWidth = Math.min(100, (maxDdPercent / totalDdPercent) * 100);

      propMetricsHtml = `
        <div style="border-top: 1px solid rgba(255,255,255,0.08); padding-top: 10px; margin-top: 4px; display: flex; flex-direction: column; gap: 8px;">
          <div>
            <div class="acc-metric-row">
              <span class="acc-metric-label"><i data-lucide="target" style="width:11px;height:11px;display:inline;"></i> Profit Target (${targetPercent}%):</span>
              <span class="acc-metric-val" style="color: ${pnl >= targetAmount ? '#10b981' : '#fff'};">$${pnl.toFixed(2)} / $${targetAmount.toFixed(2)} (${targetProgress.toFixed(1)}%)</span>
            </div>
            <div class="prop-progress-bar-bg">
              <div class="prop-progress-bar-fill target" style="width: ${targetProgress}%;"></div>
            </div>
          </div>

          <div>
            <div class="acc-metric-row">
              <span class="acc-metric-label"><i data-lucide="alert-triangle" style="width:11px;height:11px;display:inline;"></i> Дневная просадка (лимит ${dailyDdPercent}%):</span>
              <span class="acc-metric-val" style="color: ${worstDayLossPercent >= dailyDdPercent ? '#ef4444' : '#fff'};">-${worstDayLoss.toFixed(2)} (${worstDayLossPercent.toFixed(1)}%)</span>
            </div>
            <div class="prop-progress-bar-bg">
              <div class="prop-progress-bar-fill drawdown" style="width: ${dailyDdBarWidth}%; background: ${worstDayLossPercent >= dailyDdPercent ? '#ef4444' : ''};"></div>
            </div>
          </div>

          <div>
            <div class="acc-metric-row">
              <span class="acc-metric-label"><i data-lucide="shield-alert" style="width:11px;height:11px;display:inline;"></i> Общая просадка (лимит ${totalDdPercent}%):</span>
              <span class="acc-metric-val" style="color: ${maxDdPercent >= totalDdPercent ? '#ef4444' : '#fff'};">-${maxDdAmount.toFixed(2)} (${maxDdPercent.toFixed(1)}%)</span>
            </div>
            <div class="prop-progress-bar-bg">
              <div class="prop-progress-bar-fill drawdown" style="width: ${totalDdBarWidth}%; background: ${maxDdPercent >= totalDdPercent ? '#ef4444' : ''};"></div>
            </div>
          </div>
        </div>
      `;
    }

    let statusBadgeText = acc.status || 'ACTIVE';
    if (acc.status === 'PHASE1_COMPLETED_PENDING') statusBadgeText = 'ФАЗА 1 ПРОЙДЕНА';
    else if (acc.status === 'PHASE2_COMPLETED_PENDING') statusBadgeText = 'ФАЗА 2 ПРОЙДЕНА';

    const isPendingTransition = acc.status === 'PHASE1_COMPLETED_PENDING' || acc.status === 'PHASE2_COMPLETED_PENDING';

    return `
      <div class="account-card ${isActive ? 'active-card' : ''}">
        <div class="acc-card-header">
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <div class="acc-card-title">
              <span class="acc-type-pill ${acc.type === 'PROP' ? 'prop' : 'personal'}">${acc.type}</span>
              <span>${acc.name}</span>
            </div>
            <span class="acc-card-sub">${acc.broker_or_firm} ${acc.type === 'PROP' && acc.phase ? `• ${getPhaseLabel(acc.phase)}` : ''}</span>
          </div>
          <span class="acc-status-badge ${acc.status || 'ACTIVE'}">${statusBadgeText}</span>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; background: rgba(0,0,0,0.25); padding: 10px; border-radius: 6px;">
          <div>
            <span style="font-size: 9px; color: var(--text-muted); text-transform: uppercase;">Баланс</span>
            <div class="font-mono" style="font-size: 13px; font-weight: 700; color: #fff;">$${acc.current_balance.toLocaleString("en-US", { minimumFractionDigits: 2 })}</div>
          </div>
          <div>
            <span style="font-size: 9px; color: var(--text-muted); text-transform: uppercase;">Доходность / PnL</span>
            <div class="font-mono" style="font-size: 13px; font-weight: 700; color: ${pnlColor};">${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${pnlPercent.toFixed(1)}%)</div>
          </div>
        </div>

        <div style="display: flex; justify-content: space-between; font-size: 10px; color: var(--text-muted);">
          <span>Сделок: <strong style="color: #fff;">${accTrades.length}</strong></span>
          <span>Win Rate: <strong style="color: #fff;">${winRate}%</strong></span>
          <span>Старт: <strong style="color: #fff;">$${acc.initial_balance.toLocaleString()}</strong></span>
        </div>

        ${propMetricsHtml}

        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 10px; margin-top: auto;">
          ${isPendingTransition ? `
            <button class="acc-continue-phase-btn trade-btn" data-account-id="${acc.id}" data-target-phase="${acc.status === 'PHASE1_COMPLETED_PENDING' ? 'EVALUATION_2' : 'FUNDED'}" style="height: 28px; padding: 0 10px; font-size: 10px; background: linear-gradient(135deg, #10b981 0%, #059669 100%); color: #fff; border: none; border-radius: 6px; cursor: pointer; margin: 0; width: auto; font-weight: bold; box-shadow: 0 2px 8px rgba(16, 185, 129, 0.4);">
              <i data-lucide="award" style="width: 12px; height: 12px; display: inline;"></i> ${acc.status === 'PHASE1_COMPLETED_PENDING' ? 'Начать Фазу 2' : 'Перейти на Фандед'}
            </button>
          ` : (isActive ? `
            <button class="trade-btn" style="height: 28px; padding: 0 12px; font-size: 10px; background-color: rgba(16, 185, 129, 0.2); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.4); border-radius: 6px; cursor: default; margin: 0; width: auto;">
              <i data-lucide="check-circle" style="width: 12px; height: 12px; display: inline;"></i> Активный счёт
            </button>
          ` : `
            <button class="acc-activate-btn history-btn" data-account-id="${acc.id}" style="padding: 5px 12px; font-size: 10px; color: var(--color-accent); border-color: rgba(59, 130, 246, 0.4);">
              Сделать активным
            </button>
          `)}

          <div style="display: flex; gap: 6px; margin-left: auto;">
            <button class="acc-edit-btn history-btn" data-account-id="${acc.id}" title="Редактировать счёт">
              <i data-lucide="edit-3" style="width: 12px; height: 12px;"></i>
            </button>
            ${accounts.length > 1 ? `
              <button class="acc-delete-btn delete-account-btn history-btn danger" data-account-id="${acc.id}" title="Удалить / Архивировать счёт">
                <i data-lucide="trash-2" style="width: 12px; height: 12px;"></i>
              </button>
            ` : ''}
          </div>
        </div>
      </div>
    `;
  }).join("");

  grid.querySelectorAll(".acc-activate-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-account-id");
      if (id) {
        setActiveAccount(id);
        renderAccountsModalCards();
      }
    });
  });

  grid.querySelectorAll(".acc-continue-phase-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const id = btn.getAttribute("data-account-id");
      const targetPhase = btn.getAttribute("data-target-phase");
      const acc = accounts.find(a => a.id === id);
      if (acc) {
        openPropPhaseTransitionModal(acc, targetPhase);
      }
    });
  });

  grid.querySelectorAll(".acc-edit-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-account-id");
      const acc = accounts.find(a => a.id === id);
      if (acc) openAccountFormModal(acc);
    });
  });

  grid.querySelectorAll(".acc-delete-btn, .delete-account-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const id = btn.getAttribute("data-account-id") || btn.dataset.accountId;
      if (id) deleteAccount(id);
    });
  });

  if (!grid.dataset.delegated) {
    grid.dataset.delegated = "true";
    grid.addEventListener("click", (e) => {
      const deleteBtn = e.target.closest(".acc-delete-btn, .delete-account-btn");
      if (deleteBtn) {
        e.stopPropagation();
        e.preventDefault();
        const id = deleteBtn.getAttribute("data-account-id") || deleteBtn.dataset.accountId;
        if (id) deleteAccount(id);
      }
    });
  }

  if (typeof lucide !== "undefined" && lucide.createIcons) {
    lucide.createIcons();
  }
}

function initPropPhaseTabs() {
  document.querySelectorAll(".prop-phase-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".prop-phase-tab").forEach(t => {
        t.classList.remove("active");
        t.style.background = "transparent";
        t.style.color = "#94a3b8";
      });
      tab.classList.add("active");
      tab.style.background = "rgba(139, 92, 246, 0.3)";
      tab.style.color = "#fff";

      const targetTab = tab.getAttribute("data-phase-tab");
      document.querySelectorAll(".prop-phase-content").forEach(c => c.style.display = "none");
      const content = document.getElementById(`prop-phase-content-${targetTab}`);
      if (content) content.style.display = "flex";
    });
  });
}

function openAccountFormModal(accToEdit = null) {
  const modal = document.getElementById("account-form-modal");
  if (!modal) return;

  const titleEl = document.getElementById("account-form-title");
  const idEl = document.getElementById("acc-form-id");
  const nameEl = document.getElementById("acc-form-name");
  const brokerEl = document.getElementById("acc-form-broker");
  const balanceEl = document.getElementById("acc-form-balance");
  const currencyEl = document.getElementById("acc-form-currency");

  const p1TargetEl = document.getElementById("acc-form-p1-target");
  const p1DailyDdEl = document.getElementById("acc-form-p1-daily-dd");
  const p1TotalDdEl = document.getElementById("acc-form-p1-total-dd");

  const p2TargetEl = document.getElementById("acc-form-p2-target");
  const p2DailyDdEl = document.getElementById("acc-form-p2-daily-dd");
  const p2TotalDdEl = document.getElementById("acc-form-p2-total-dd");

  const fundedDailyDdEl = document.getElementById("acc-form-funded-daily-dd");
  const fundedTotalDdEl = document.getElementById("acc-form-funded-total-dd");
  const splitEl = document.getElementById("acc-form-profit-split");

  const propFieldsBlock = document.getElementById("acc-form-prop-fields");
  const badgeEl = document.getElementById("acc-form-current-phase-badge");

  initPropPhaseTabs();

  if (accToEdit) {
    titleEl.textContent = "Редактирование счёта";
    idEl.value = accToEdit.id;
    nameEl.value = accToEdit.name;
    brokerEl.value = accToEdit.broker_or_firm;
    balanceEl.value = accToEdit.initial_balance;
    currencyEl.value = accToEdit.currency || "USD";

    setFormAccountType(accToEdit.type);

    if (accToEdit.type === "PROP") {
      propFieldsBlock.style.display = "flex";
      if (p1TargetEl) p1TargetEl.value = accToEdit.p1_target_percent || accToEdit.profit_target_percent || 10;
      if (p1DailyDdEl) p1DailyDdEl.value = accToEdit.p1_daily_dd_percent || accToEdit.max_daily_drawdown_percent || 5;
      if (p1TotalDdEl) p1TotalDdEl.value = accToEdit.p1_total_dd_percent || accToEdit.max_total_drawdown_percent || 10;

      if (p2TargetEl) p2TargetEl.value = accToEdit.p2_target_percent || 5;
      if (p2DailyDdEl) p2DailyDdEl.value = accToEdit.p2_daily_dd_percent || 5;
      if (p2TotalDdEl) p2TotalDdEl.value = accToEdit.p2_total_dd_percent || 10;

      if (fundedDailyDdEl) fundedDailyDdEl.value = accToEdit.funded_daily_dd_percent || 5;
      if (fundedTotalDdEl) fundedTotalDdEl.value = accToEdit.funded_total_dd_percent || 10;
      if (splitEl) splitEl.value = accToEdit.profit_split_percent || 80;

      const autoPhaseEl = document.getElementById("acc-form-auto-phase");
      if (autoPhaseEl) autoPhaseEl.checked = accToEdit.auto_phase_transition !== false;

      if (badgeEl) badgeEl.textContent = `Текущий этап: ${getPhaseLabel(accToEdit.phase || "EVALUATION_1")}`;
    } else {
      propFieldsBlock.style.display = "none";
    }
  } else {
    titleEl.textContent = "Создание нового счёта";
    idEl.value = "";
    nameEl.value = "";
    brokerEl.value = "";
    balanceEl.value = "10000";
    currencyEl.value = "USD";
    setFormAccountType("PERSONAL");
    propFieldsBlock.style.display = "none";

    if (p1TargetEl) p1TargetEl.value = "10";
    if (p1DailyDdEl) p1DailyDdEl.value = "5";
    if (p1TotalDdEl) p1TotalDdEl.value = "10";

    if (p2TargetEl) p2TargetEl.value = "5";
    if (p2DailyDdEl) p2DailyDdEl.value = "5";
    if (p2TotalDdEl) p2TotalDdEl.value = "10";

    if (fundedDailyDdEl) fundedDailyDdEl.value = "5";
    if (fundedTotalDdEl) fundedTotalDdEl.value = "10";
    if (splitEl) splitEl.value = "80";

    const autoPhaseEl = document.getElementById("acc-form-auto-phase");
    if (autoPhaseEl) autoPhaseEl.checked = true;

    if (badgeEl) badgeEl.textContent = "Старт: Фаза 1";
  }

  modal.style.display = "flex";
}

function setFormAccountType(type) {
  const optPersonal = document.getElementById("acc-type-option-personal");
  const optProp = document.getElementById("acc-type-option-prop");
  const propFieldsBlock = document.getElementById("acc-form-prop-fields");
  const balancePresetsBlock = document.getElementById("acc-form-balance-presets");

  if (type === "PROP") {
    optProp.classList.add("active");
    optProp.querySelector("input").checked = true;
    optPersonal.classList.remove("active");
    if (propFieldsBlock) propFieldsBlock.style.display = "flex";
    if (balancePresetsBlock) balancePresetsBlock.style.display = "flex";
  } else {
    optPersonal.classList.add("active");
    optPersonal.querySelector("input").checked = true;
    optProp.classList.remove("active");
    if (propFieldsBlock) propFieldsBlock.style.display = "none";
    if (balancePresetsBlock) balancePresetsBlock.style.display = "none";
  }
}

function closeAccountFormModal() {
  const modal = document.getElementById("account-form-modal");
  if (modal) modal.style.display = "none";
}

function saveAccountForm(e) {
  if (e && typeof e.preventDefault === "function") e.preventDefault();

  const idEl = document.getElementById("acc-form-id");
  const nameEl = document.getElementById("acc-form-name");
  const brokerEl = document.getElementById("acc-form-broker");
  const balanceEl = document.getElementById("acc-form-balance");
  const currencyEl = document.getElementById("acc-form-currency");

  const id = idEl ? idEl.value : "";
  let name = nameEl ? nameEl.value.trim() : "";
  let broker = brokerEl ? brokerEl.value.trim() : "";
  let balanceVal = balanceEl ? parseFloat(balanceEl.value) : 10000;
  const currency = currencyEl ? currencyEl.value : "USD";

  const radioChecked = document.querySelector('input[name="acc-type-radio"]:checked');
  const selectedType = radioChecked ? radioChecked.value : "PERSONAL";

  if (!name) {
    name = selectedType === "PROP" ? "Проп-счёт #" + (accounts.length + 1) : "Личный счёт #" + (accounts.length + 1);
  }
  if (!broker) {
    broker = selectedType === "PROP" ? "Проп-провайдер" : "Личный брокер";
  }
  if (isNaN(balanceVal) || balanceVal <= 0) {
    balanceVal = 10000;
  }

  let phase = "NOT_APPLICABLE";
  let p1Target = 10, p1DailyDd = 5, p1TotalDd = 10;
  let p2Target = 5, p2DailyDd = 5, p2TotalDd = 10;
  let fundedDailyDd = 5, fundedTotalDd = 10, split = 80;
  let autoPhaseTransition = true;

  if (selectedType === "PROP") {
    const p1TargetEl = document.getElementById("acc-form-p1-target");
    const p1DailyDdEl = document.getElementById("acc-form-p1-daily-dd");
    const p1TotalDdEl = document.getElementById("acc-form-p1-total-dd");

    const p2TargetEl = document.getElementById("acc-form-p2-target");
    const p2DailyDdEl = document.getElementById("acc-form-p2-daily-dd");
    const p2TotalDdEl = document.getElementById("acc-form-p2-total-dd");

    const fundedDailyDdEl = document.getElementById("acc-form-funded-daily-dd");
    const fundedTotalDdEl = document.getElementById("acc-form-funded-total-dd");
    const splitEl = document.getElementById("acc-form-profit-split");
    const autoPhaseEl = document.getElementById("acc-form-auto-phase");

    p1Target = p1TargetEl ? (parseFloat(p1TargetEl.value) || 10) : 10;
    p1DailyDd = p1DailyDdEl ? (parseFloat(p1DailyDdEl.value) || 5) : 5;
    p1TotalDd = p1TotalDdEl ? (parseFloat(p1TotalDdEl.value) || 10) : 10;

    p2Target = p2TargetEl ? (parseFloat(p2TargetEl.value) || 5) : 5;
    p2DailyDd = p2DailyDdEl ? (parseFloat(p2DailyDdEl.value) || 5) : 5;
    p2TotalDd = p2TotalDdEl ? (parseFloat(p2TotalDdEl.value) || 10) : 10;

    fundedDailyDd = fundedDailyDdEl ? (parseFloat(fundedDailyDdEl.value) || 5) : 5;
    fundedTotalDd = fundedTotalDdEl ? (parseFloat(fundedTotalDdEl.value) || 10) : 10;
    split = splitEl ? (parseFloat(splitEl.value) || 80) : 80;
    autoPhaseTransition = autoPhaseEl ? autoPhaseEl.checked : true;
    phase = "EVALUATION_1";
  }

  if (id) {
    const acc = accounts.find(a => a.id === id);
    if (acc) {
      acc.name = name;
      acc.broker_or_firm = broker;
      acc.type = selectedType;
      acc.currency = currency;

      if (acc.initial_balance !== balanceVal) {
        const diff = balanceVal - acc.initial_balance;
        acc.initial_balance = balanceVal;
        acc.current_balance += diff;
        if (acc.id === activeAccountId) {
          balance = acc.current_balance;
        }
      }

      if (selectedType === "PROP") {
        acc.p1_target_percent = p1Target;
        acc.p1_daily_dd_percent = p1DailyDd;
        acc.p1_total_dd_percent = p1TotalDd;
        acc.p2_target_percent = p2Target;
        acc.p2_daily_dd_percent = p2DailyDd;
        acc.p2_total_dd_percent = p2TotalDd;
        acc.funded_daily_dd_percent = fundedDailyDd;
        acc.funded_total_dd_percent = fundedTotalDd;
        acc.profit_split_percent = split;
        acc.auto_phase_transition = autoPhaseTransition;

        if (!acc.phase || acc.phase === "NOT_APPLICABLE") acc.phase = "EVALUATION_1";

        if (acc.phase === "EVALUATION_1") {
          acc.profit_target_percent = p1Target;
          acc.max_daily_drawdown_percent = p1DailyDd;
          acc.max_total_drawdown_percent = p1TotalDd;
        } else if (acc.phase === "EVALUATION_2") {
          acc.profit_target_percent = p2Target;
          acc.max_daily_drawdown_percent = p2DailyDd;
          acc.max_total_drawdown_percent = p2TotalDd;
        } else if (acc.phase === "FUNDED") {
          acc.profit_target_percent = 0;
          acc.max_daily_drawdown_percent = fundedDailyDd;
          acc.max_total_drawdown_percent = fundedTotalDd;
        }
      }

      acc.updated_at = new Date().toISOString();
      if (typeof showToast === "function") showToast("Счёт «" + name + "» успешно обновлён!", "success");
    }
  } else {
    const newAcc = {
      id: "acc-" + Date.now(),
      name: name,
      type: selectedType,
      broker_or_firm: broker,
      phase: selectedType === "PROP" ? "EVALUATION_1" : "NOT_APPLICABLE",
      initial_balance: balanceVal,
      current_balance: balanceVal,
      currency: currency,
      p1_target_percent: p1Target,
      p1_daily_dd_percent: p1DailyDd,
      p1_total_dd_percent: p1TotalDd,
      p2_target_percent: p2Target,
      p2_daily_dd_percent: p2DailyDd,
      p2_total_dd_percent: p2TotalDd,
      funded_daily_dd_percent: fundedDailyDd,
      funded_total_dd_percent: fundedTotalDd,
      max_daily_drawdown_percent: selectedType === "PROP" ? p1DailyDd : null,
      max_total_drawdown_percent: selectedType === "PROP" ? p1TotalDd : null,
      profit_target_percent: selectedType === "PROP" ? p1Target : null,
      profit_split_percent: split,
      auto_phase_transition: autoPhaseTransition,
      payouts_history: [],
      status: "ACTIVE",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    accounts.push(newAcc);
    setActiveAccount(newAcc.id, true);
    if (typeof showToast === "function") showToast("Счёт «" + name + "» успешно создан!", "success");
  }

  saveAccountsToStorage();
  closeAccountFormModal();
  renderAccountsModalCards();
  renderAccountSelector();
  renderHistoryAccountFilterSelect();
  if (typeof updateSimulatorUI === "function") updateSimulatorUI();
  if (typeof updateTradeHistoryUI === "function") updateTradeHistoryUI();
}

let accountPendingDeletionId = null;

function openDeleteAccountConfirmModal(accountId) {
  if (!accountId) return;

  if (accounts.length <= 1) {
    if (typeof showToast === "function") showToast("Нельзя удалить единственный счёт!", "error");
    return;
  }

  const targetAccount = accounts.find(a => a.id === accountId);
  if (!targetAccount) return;

  accountPendingDeletionId = accountId;

  const modal = document.getElementById("delete-account-confirm-modal");
  const textEl = document.getElementById("delete-account-modal-text");

  if (textEl) {
    const isCurrentActive = (activeAccountId === accountId);
    const activeNote = isCurrentActive ? `<br><span style="color: #f59e0b; font-size: 11px;">⚠️ Это активный счёт. После удаления будет автоматически активирован другой счёт.</span>` : ``;
    textEl.innerHTML = `Вы уверены, что хотите удалить счёт «<strong style="color: #fff;">${targetAccount.name || 'Счёт'}</strong>»?${activeNote}<br><span style="font-size: 11px; opacity: 0.8; display: block; margin-top: 4px;">Сделки и история останутся в журнале.</span>`;
  }

  if (modal) modal.style.display = "flex";
}

function closeDeleteAccountConfirmModal() {
  accountPendingDeletionId = null;
  const modal = document.getElementById("delete-account-confirm-modal");
  if (modal) modal.style.display = "none";
}

async function executeAccountDeletion() {
  if (!accountPendingDeletionId) return;

  const accountId = accountPendingDeletionId;
  closeDeleteAccountConfirmModal();

  if (accounts.length <= 1) {
    if (typeof showToast === "function") showToast("Нельзя удалить единственный счёт!", "error");
    return;
  }

  const targetAccount = accounts.find(a => a.id === accountId);
  if (!targetAccount) return;

  const accountName = targetAccount.name || "Счёт";
  const wasActive = (activeAccountId === accountId);

  accounts = accounts.filter(a => a.id !== accountId);

  if (wasActive && accounts.length > 0) {
    await setActiveAccount(accounts[0].id, true);
  }

  saveAccountsToStorage();
  if (typeof deleteData === "function") {
    deleteData("account_" + accountId).catch(err => console.error("IndexedDB account delete error:", err));
  }
  saveSimulatorState();

  renderAccountsModalCards();
  renderAccountSelector();
  renderAccountDropdownList();
  renderHistoryAccountFilterSelect();
  if (typeof updateSimulatorUI === "function") updateSimulatorUI();
  if (typeof updateTradeHistoryUI === "function") updateTradeHistoryUI();

  if (typeof showToast === "function") {
    showToast(`Счёт "${accountName}" успешно удалён`, "success");
  }
}

function deleteAccount(accountId) {
  openDeleteAccountConfirmModal(accountId);
}

window.deleteAccount = deleteAccount;

function deleteOrArchiveAccount(accountId) {
  openDeleteAccountConfirmModal(accountId);
}

window.deleteOrArchiveAccount = deleteOrArchiveAccount;

function initAccountEventListeners() {
  const menuToggleBtn = document.getElementById("account-menu-toggle-btn");
  const selectorBtn = document.getElementById("account-selector-btn");
  const toggleBtn = menuToggleBtn || selectorBtn;
  const dropdown = document.getElementById("account-selector-dropdown");

  if (toggleBtn && dropdown) {
    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isVisible = dropdown.style.display === "block";
      dropdown.style.display = isVisible ? "none" : "block";
      if (!isVisible) {
        renderAccountSelector();
        renderAccountDropdownList();
        if (typeof lucide !== "undefined" && lucide.createIcons) {
          lucide.createIcons();
        }
      }
    });

    document.addEventListener("click", (e) => {
      if (!dropdown.contains(e.target) && !toggleBtn.contains(e.target)) {
        dropdown.style.display = "none";
      }
    });
  }

  const dropdownManageBtn = document.getElementById("dropdown-manage-accounts-btn");
  const dropdownAddBtn = document.getElementById("dropdown-add-account-btn");
  const historyManageBtn = document.getElementById("history-manage-accounts-btn");

  if (dropdownManageBtn) {
    dropdownManageBtn.addEventListener("click", () => {
      if (dropdown) dropdown.style.display = "none";
      openAccountsModal();
    });
  }
  if (dropdownAddBtn) {
    dropdownAddBtn.addEventListener("click", () => {
      if (dropdown) dropdown.style.display = "none";
      openAccountFormModal();
    });
  }
  if (historyManageBtn) {
    historyManageBtn.addEventListener("click", openAccountsModal);
  }

  // Hamburger Main Items
  const menuItemIndicators = document.getElementById("menu-item-indicators");
  const menuItemProfile = document.getElementById("menu-item-profile");
  const menuItemProp = document.getElementById("menu-item-prop");
  const menuItemComp = document.getElementById("menu-item-competition");
  const menuItemApiSync = document.getElementById("menu-item-api-sync");

  if (menuItemIndicators) {
    menuItemIndicators.addEventListener("click", () => {
      if (dropdown) dropdown.style.display = "none";
      const catalogModal = document.getElementById("modal-indicator-catalog");
      if (catalogModal) catalogModal.style.display = "flex";
      if (typeof updateCatalogCotButtonState === "function") updateCatalogCotButtonState();
      if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
    });
  }
  if (menuItemProfile) {
    menuItemProfile.addEventListener("click", () => {
      if (dropdown) dropdown.style.display = "none";
      openProfileModal();
    });
  }
  if (menuItemProp) {
    menuItemProp.addEventListener("click", () => {
      if (dropdown) dropdown.style.display = "none";
      openAccountsModal();
    });
  }
  if (menuItemComp) {
    menuItemComp.addEventListener("click", () => {
      if (dropdown) dropdown.style.display = "none";
      openCompetitionModal();
    });
  }
  if (menuItemApiSync) {
    menuItemApiSync.addEventListener("click", () => {
      if (dropdown) dropdown.style.display = "none";
      if (typeof openApiSyncModal === "function") {
        openApiSyncModal();
      }
    });
  }

  // Profile Modal listeners
  const profileCloseBtn = document.getElementById("profile-modal-close-btn");
  if (profileCloseBtn) profileCloseBtn.addEventListener("click", closeProfileModal);
  document.querySelectorAll(".achieve-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".achieve-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const diff = tab.getAttribute("data-difficulty") || "ALL";
      renderAchievements(diff);
    });
  });

  // Delete Account Confirmation Modal listeners
  const confirmDeleteBtn = document.getElementById("delete-account-confirm-submit-btn");
  const cancelDeleteBtn = document.getElementById("delete-account-confirm-cancel-btn");
  if (confirmDeleteBtn) confirmDeleteBtn.addEventListener("click", executeAccountDeletion);
  if (cancelDeleteBtn) cancelDeleteBtn.addEventListener("click", closeDeleteAccountConfirmModal);

  // Competition Modal listeners
  const compCloseBtn = document.getElementById("competition-modal-close-btn");
  const compCancelBtn = document.getElementById("competition-modal-cancel-btn");
  const compSubmitBtn = document.getElementById("competition-modal-submit-btn");

  if (compCloseBtn) compCloseBtn.addEventListener("click", closeCompetitionModal);
  if (compCancelBtn) compCancelBtn.addEventListener("click", closeCompetitionModal);
  if (compSubmitBtn) compSubmitBtn.addEventListener("click", createCompetitionAccount);

  const compTabAcc = document.getElementById("comp-tab-account-btn");
  const compTabLead = document.getElementById("comp-tab-leaderboard-btn");
  if (compTabAcc) compTabAcc.addEventListener("click", () => switchCompetitionTab("account"));
  if (compTabLead) compTabLead.addEventListener("click", () => switchCompetitionTab("leaderboard"));

  const compMyRatingBtn = document.getElementById("comp-my-rating-btn");
  if (compMyRatingBtn) compMyRatingBtn.addEventListener("click", () => showMyRating());

  const scrollToMeBtn = document.getElementById("leaderboard-scroll-to-me-btn");
  if (scrollToMeBtn) {
    scrollToMeBtn.addEventListener("click", () => {
      const userRow = document.getElementById("leaderboard-user-row");
      if (userRow) {
        userRow.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  }

  const leadSearchInput = document.getElementById("leaderboard-search-input");
  if (leadSearchInput) {
    leadSearchInput.addEventListener("input", () => renderLeaderboardTable());
  }

  const leadStatusFilter = document.getElementById("leaderboard-status-filter");
  if (leadStatusFilter) {
    leadStatusFilter.addEventListener("change", () => renderLeaderboardTable());
  }

  // Violation Modal listeners
  const violCloseBtn = document.getElementById("violation-modal-close-btn");
  const violOkBtn = document.getElementById("violation-modal-ok-btn");
  if (violCloseBtn) violCloseBtn.addEventListener("click", closeViolationModal);
  if (violOkBtn) violOkBtn.addEventListener("click", closeViolationModal);

  document.querySelectorAll(".comp-bal-preset-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".comp-bal-preset-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const val = btn.getAttribute("data-val") || "25000";
      const customInput = document.getElementById("competition-custom-balance");
      if (customInput) customInput.value = val;
    });
  });

  // Payout Modal listeners
  const payoutCloseBtn = document.getElementById("payout-modal-close-btn");
  const payoutCancelBtn = document.getElementById("payout-modal-cancel-btn");
  const payoutSubmitBtn = document.getElementById("payout-modal-submit-btn");
  const addPayoutBtn = document.getElementById("add-payout-btn");

  if (payoutCloseBtn) payoutCloseBtn.addEventListener("click", closePayoutModal);
  if (payoutCancelBtn) payoutCancelBtn.addEventListener("click", closePayoutModal);
  if (payoutSubmitBtn) payoutSubmitBtn.addEventListener("click", savePayoutForm);
  if (addPayoutBtn) addPayoutBtn.addEventListener("click", openPayoutModal);

  // Withdrawal Modal listeners
  const withdrawalCloseBtn = document.getElementById("withdrawal-modal-close-btn");
  const withdrawalCancelBtn = document.getElementById("withdrawal-modal-cancel-btn");
  const withdrawalSubmitBtn = document.getElementById("withdrawal-modal-submit-btn");
  const openWithdrawalBtn = document.getElementById("open-withdrawal-modal-btn");

  if (withdrawalCloseBtn) withdrawalCloseBtn.addEventListener("click", closeWithdrawalModal);
  if (withdrawalCancelBtn) withdrawalCancelBtn.addEventListener("click", closeWithdrawalModal);
  if (withdrawalSubmitBtn) withdrawalSubmitBtn.addEventListener("click", saveWithdrawalForm);
  if (openWithdrawalBtn) openWithdrawalBtn.addEventListener("click", openWithdrawalModal);

  // Journal View Mode Tabs (Журнал / Аналитика / Компенсации)
  const tabBtnJournal = document.getElementById("tab-btn-journal");
  const tabBtnAnalytics = document.getElementById("tab-btn-analytics");
  const tabBtnPayouts = document.getElementById("tab-btn-payouts");

  const viewJournal = document.getElementById("view-journal-container");
  const viewAnalytics = document.getElementById("view-analytics-container");
  const viewPayouts = document.getElementById("view-payouts-container");

  const switchJournalView = (viewName) => {
    [tabBtnJournal, tabBtnAnalytics, tabBtnPayouts].forEach(b => b?.classList.remove("active"));
    [viewJournal, viewAnalytics, viewPayouts].forEach(v => v?.classList.remove("active"));

    if (viewName === "journal") {
      tabBtnJournal?.classList.add("active");
      viewJournal?.classList.add("active");
      isAnalyticsActive = false;
    } else if (viewName === "analytics") {
      tabBtnAnalytics?.classList.add("active");
      viewAnalytics?.classList.add("active");
      isAnalyticsActive = true;
      if (typeof drawPnLEquityChart === "function") drawPnLEquityChart();
      if (typeof renderHeatmapCalendar === "function") renderHeatmapCalendar();
    } else if (viewName === "payouts") {
      tabBtnPayouts?.classList.add("active");
      viewPayouts?.classList.add("active");
      isAnalyticsActive = false;
      renderPayoutsTable();
    }
  };

  if (tabBtnJournal) tabBtnJournal.addEventListener("click", () => switchJournalView("journal"));
  if (tabBtnAnalytics) tabBtnAnalytics.addEventListener("click", () => switchJournalView("analytics"));
  if (tabBtnPayouts) tabBtnPayouts.addEventListener("click", () => switchJournalView("payouts"));

  const accModalCloseBtn = document.getElementById("accounts-modal-close-btn");
  const accModalAddBtn = document.getElementById("acc-modal-add-btn");

  if (accModalCloseBtn) accModalCloseBtn.addEventListener("click", closeAccountsModal);
  if (accModalAddBtn) accModalAddBtn.addEventListener("click", () => openAccountFormModal());

  document.querySelectorAll(".acc-modal-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".acc-modal-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      currentAccountModalTab = tab.getAttribute("data-tab") || "ALL";
      renderAccountsModalCards();
    });
  });

  const formCloseBtn = document.getElementById("account-form-close-btn");
  const formCancelBtn = document.getElementById("account-form-cancel-btn");
  const formSubmitBtn = document.getElementById("account-form-submit-btn");

  if (formCloseBtn) formCloseBtn.addEventListener("click", closeAccountFormModal);
  if (formCancelBtn) formCancelBtn.addEventListener("click", closeAccountFormModal);
  if (formSubmitBtn) formSubmitBtn.addEventListener("click", saveAccountForm);

  const optPersonal = document.getElementById("acc-type-option-personal");
  const optProp = document.getElementById("acc-type-option-prop");

  if (optPersonal) optPersonal.addEventListener("click", () => setFormAccountType("PERSONAL"));
  if (optProp) optProp.addEventListener("click", () => setFormAccountType("PROP"));

  document.querySelectorAll(".acc-balance-preset-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const amount = btn.getAttribute("data-amount");
      const balanceInput = document.getElementById("acc-form-balance");
      if (balanceInput && amount) {
        balanceInput.value = amount;
      }
    });
  });

  // Account filters in History Journal
  document.querySelectorAll(".acc-category-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".acc-category-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      currentAccountCategoryFilter = tab.getAttribute("data-category") || "ALL";
      currentAccountSpecificFilter = "ALL";
      renderHistoryAccountFilterSelect();
      updateTradeHistoryUI();
    });
  });

  const historyAccSelect = document.getElementById("history-account-filter-select");
  if (historyAccSelect) {
    historyAccSelect.addEventListener("change", () => {
      currentAccountSpecificFilter = historyAccSelect.value;
      updateTradeHistoryUI();
    });
  }
}

async function loadSimulatorState() {
  await initAccounts();
  await loadAccountState(activeAccountId);
}

function saveSimulatorState() {
  saveAccountState(activeAccountId);

  localStorage.setItem("balance", balance.toString());
  localStorage.setItem("oanda_sim_positions", JSON.stringify(state.positions));

  const sanitizedHistory = (tradeHistory || []).map(t => {
    const clone = { ...t };
    if (clone.screenshots) {
      delete clone.screenshots;
    }
    if (clone.screenshot && clone.screenshot.length > 500) {
      delete clone.screenshot;
    }
    return clone;
  });
  localStorage.setItem("plbt_trade_history", JSON.stringify(sanitizedHistory));
  saveAccountsToStorage();

  if (typeof syncCurrentScenarioState === "function") {
    syncCurrentScenarioState(false);
  }

  if (typeof ensurePendingOrdersChecking === "function") {
    ensurePendingOrdersChecking();
  }
}

function checkPendingOrders(candle) {
  if (!candle) return;
  checkTPSLHit(candle);
  if (typeof checkAccountRiskLimits === "function") {
    checkAccountRiskLimits(candle);
  }
  let changed = false;
  state.positions.forEach((pos) => {
    if (pos.status === "pending") {
      let triggered = false;
      const type = pos.type; // 'buy' or 'sell'
      const orderType = pos.orderType; // 'limit' or 'stop'
      const triggerPrice = pos.triggerPrice;

      if (type === "buy") {
        if (orderType === "limit") {
          if (candle.low <= triggerPrice) {
            triggered = true;
          }
        } else if (orderType === "stop") {
          if (candle.high >= triggerPrice) {
            triggered = true;
          }
        }
      } else if (type === "sell") {
        if (orderType === "limit") {
          if (candle.high >= triggerPrice) {
            triggered = true;
          }
        } else if (orderType === "stop") {
          if (candle.low <= triggerPrice) {
            triggered = true;
          }
        }
      }

      if (triggered) {
        pos.status = "active";
        pos.entryPrice = triggerPrice; // Execute at trigger price
        pos.timestamp = new Date().toISOString();
        pos.entryTime = candle.time;
        if (!pos.notes) {
          pos.notes = { noteBefore: "", noteDuring: "", noteAfter: "" };
        }
        changed = true;
        showToast(
          `Сработал отложенный ордер ${orderType.toUpperCase()} ${type.toUpperCase()} по цене ${triggerPrice.toFixed(5)}`,
          "success",
        );
      }
    }
  });
  if (changed) {
    saveSimulatorState();
  }
}

function checkTPSLHit(candle) {
  if (!candle) return;
  let changed = false;
  for (let i = state.positions.length - 1; i >= 0; i--) {
    const pos = state.positions[i];
    if (pos.status === "active") {
      let hit = false;
      let hitPrice = 0;
      let hitType = "";

      if (pos.type === "buy") {
        if (pos.takeProfit && candle.high >= pos.takeProfit) {
          hit = true;
          hitPrice = pos.takeProfit;
          hitType = "Take Profit (TP)";
        } else if (pos.stopLoss && candle.low <= pos.stopLoss) {
          hit = true;
          hitPrice = pos.stopLoss;
          hitType = "Stop Loss (SL)";
        }
      } else if (pos.type === "sell") {
        if (pos.takeProfit && candle.low <= pos.takeProfit) {
          hit = true;
          hitPrice = pos.takeProfit;
          hitType = "Take Profit (TP)";
        } else if (pos.stopLoss && candle.high >= pos.stopLoss) {
          hit = true;
          hitPrice = pos.stopLoss;
          hitType = "Stop Loss (SL)";
        }
      }

      if (hit) {
        if (hitType === "Take Profit (TP)") {
          playSound("win");
        } else if (hitType === "Stop Loss (SL)") {
          playSound("loss");
        }
        const units = pos.size * 100000;
        let pnl = 0;
        if (pos.type === "buy") {
          pnl = (hitPrice - pos.entryPrice) * units;
        } else {
          pnl = (pos.entryPrice - hitPrice) * units;
        }
        if (pos.symbol.endsWith("_JPY")) {
          pnl = pnl / hitPrice;
        }

        balance += pnl;
        saveBalance(balance);

        let closeReason = "MANUAL";
        if (hitType === "Take Profit (TP)") {
          closeReason = Math.abs(pnl) <= 1.0 ? "BU" : "TP";
        } else if (hitType === "Stop Loss (SL)") {
          closeReason = Math.abs(pnl) <= 1.0 ? "BU" : "SL";
        }

        tradeHistory.push({
          id: pos.id,
          account_id: pos.account_id || activeAccountId,
          symbol: pos.symbol,
          type: pos.type,
          entryPrice: pos.entryPrice,
          exitPrice: hitPrice,
          size: pos.size,
          leverage: pos.leverage || 100,
          commission: pos.commission || 0,
          pnl: pnl,
          close_reason: closeReason,
          timestamp: new Date().toISOString(),
          openTime: pos.timestamp,
          closeTime: new Date().toISOString(),
          entryTime: pos.entryTime,
          exitTime: candle.time,
          reason: hitType,
          notes: {
            noteBefore: pos.notes ? pos.notes.noteBefore : "",
            noteDuring: pos.notes ? pos.notes.noteDuring : "",
            noteAfter: pos.notes ? pos.notes.noteAfter : "",
          },
        });
        localStorage.setItem(
          "plbt_trade_history",
          JSON.stringify(tradeHistory),
        );

        state.positions.splice(i, 1);
        changed = true;
        showToast(
          `Позиция закрыта по ${hitType} на цене ${hitPrice.toFixed(5)}! PnL: $${pnl.toFixed(2)}`,
          "success",
        );
        const closedTradeObj = tradeHistory[tradeHistory.length - 1];
        if (closedTradeObj) {
          triggerPostTradeJournalReminder(closedTradeObj);
        }
      }
    }
  }
  if (changed) {
    saveSimulatorState();
    updateSimulatorUI();
    updateTradeHistoryUI();
    drawAllOnCanvas();
  }
}

function updateSimulatorUI() {
  footerBalance.textContent = `$${balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
  if (capitalInput) capitalInput.value = balance.toFixed(2);

  const displayPositions = state.positions;
  if (displayPositions.length === 0) {
    positionsList.innerHTML =
      '<div class="no-positions">У вас нет открытых позиций</div>';
    return;
  }
  positionsList.innerHTML = "";
  displayPositions.forEach((pos) => {
    if (pos.status === "draft") {
      const posEl = document.createElement("div");
      posEl.className = "position-item draft-order";
      posEl.style.border = "1px dashed var(--color-warning)";
      posEl.style.background = "rgba(245, 158, 11, 0.05)";
      posEl.innerHTML = `
                <div class="position-header">
                    <span class="position-symbol-badge">${pos.symbol.replace("_", "/")}</span>
                    <span class="position-type ${pos.type}" style="background-color: var(--color-warning); color: #000000; padding: 2px 6px; border-radius: 3px; font-weight: bold; font-size: 10px;">DRAFT ${pos.orderType ? pos.orderType.toUpperCase() : "MARKET"} ${pos.type.toUpperCase()}</span>
                    <button class="close-pos-btn" onclick="closePosition(${pos.id})">Отмена</button>
                </div>
                <div class="position-details">
                    <div class="position-row"><span>Цена входа:</span><span>${pos.entryPrice.toFixed(5)}</span></div>
                    <div class="position-row"><span>Объем:</span><span>${pos.size} L</span></div>
                    <div class="position-row"><span>Статус:</span><span style="color: var(--color-warning); font-weight: 600;">Черновик</span></div>
                    <div class="position-row" style="margin-top: 6px;">
                        <span>TP:</span>
                        <input type="number" step="0.0001" id="pos-tp-input-${pos.id}" class="pos-tp-input" value="${pos.takeProfit ? pos.takeProfit.toFixed(5) : ""}" onchange="updatePositionTPSL(${pos.id}, 'tp', this.value)" style="width: 75px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 2px 4px; border-radius: 3px; font-size: 11px;">
                    </div>
                    <div class="position-row">
                        <span>SL:</span>
                        <input type="number" step="0.0001" id="pos-sl-input-${pos.id}" class="pos-sl-input" value="${pos.stopLoss ? pos.stopLoss.toFixed(5) : ""}" onchange="updatePositionTPSL(${pos.id}, 'sl', this.value)" style="width: 75px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 2px 4px; border-radius: 3px; font-size: 11px;">
                    </div>
                    <div style="margin-top: 8px; display: flex; gap: 6px;">
                        <button onclick="confirmDraftOrder(${pos.id})" style="flex: 1; height: 26px; border: none; background: #0f9d58; color: white; border-radius: 4px; font-weight: bold; font-size: 11px; cursor: pointer; transition: opacity 0.2s;" onmouseover="this.style.opacity='0.9'" onmouseout="this.style.opacity='1'">Подтвердить</button>
                    </div>
                </div>
            `;
      positionsList.appendChild(posEl);
      return;
    }

    if (pos.status === "pending") {
      const posEl = document.createElement("div");
      posEl.className = "position-item pending-order";
      posEl.innerHTML = `
                <div class="position-header">
                    <span class="position-symbol-badge">${pos.symbol.replace("_", "/")}</span>
                    <span class="position-type ${pos.type}" style="background-color: var(--color-warning); color: #000000; padding: 2px 6px; border-radius: 3px; font-weight: bold; font-size: 10px;">${pos.orderType ? pos.orderType.toUpperCase() : "LIMIT"} ${pos.type.toUpperCase()}</span>
                    <button class="close-pos-btn" onclick="closePosition(${pos.id})">Отмена</button>
                </div>
                <div class="position-details">
                    <div class="position-row"><span>Цена триггера:</span><span>${pos.triggerPrice.toFixed(5)}</span></div>
                    <div class="position-row"><span>Объем:</span><span>${pos.size} L</span></div>
                    <div class="position-row"><span>Статус:</span><span style="color: var(--color-warning); font-weight: 600;">Отложенный</span></div>
                    <div class="position-row" style="margin-top: 6px;">
                        <span>TP:</span>
                        <input type="number" step="0.0001" id="pos-tp-input-${pos.id}" class="pos-tp-input" value="${pos.takeProfit ? pos.takeProfit.toFixed(5) : ""}" onchange="updatePositionTPSL(${pos.id}, 'tp', this.value)" style="width: 75px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 2px 4px; border-radius: 3px; font-size: 11px;">
                    </div>
                    <div class="position-row">
                        <span>SL:</span>
                        <input type="number" step="0.0001" id="pos-sl-input-${pos.id}" class="pos-sl-input" value="${pos.stopLoss ? pos.stopLoss.toFixed(5) : ""}" onchange="updatePositionTPSL(${pos.id}, 'sl', this.value)" style="width: 75px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 2px 4px; border-radius: 3px; font-size: 11px;">
                    </div>
                </div>
            `;
      positionsList.appendChild(posEl);
      return;
    }

    let currPrice = pos.entryPrice;
    const arr = state.isBacktestActive
      ? state.backtestVisibleCandles
      : state.historicalCandles;
    if (arr.length > 0) currPrice = arr[arr.length - 1].close;
    let pnl = 0;
    const units = pos.size * 100000;
    if (pos.type === "buy") {
      pnl = (currPrice - pos.entryPrice) * units;
    } else {
      pnl = (pos.entryPrice - currPrice) * units;
    }
    if (pos.symbol.endsWith("_JPY")) {
      pnl = pnl / currPrice;
    }
    const cls = pnl >= 0 ? "profit" : "loss";
    const sign = pnl >= 0 ? "+" : "";
    const posEl = document.createElement("div");
    posEl.className = "position-item";
    posEl.innerHTML = `
            <div class="position-header">
                <span class="position-symbol-badge">${pos.symbol.replace("_", "/")}</span>
                <span class="position-type ${pos.type}">${pos.type.toUpperCase()}</span>
                <button class="close-pos-btn" onclick="closePosition(${pos.id})">Закрыть</button>
            </div>
            <div class="position-details">
                <div class="position-row"><span>Вход:</span><span>${pos.entryPrice.toFixed(5)}</span></div>
                <div class="position-row"><span>Объем:</span><span>${pos.size} L</span></div>
                <div class="position-row"><span>Комиссия:</span><span>$${pos.commission.toFixed(2)}</span></div>
                <div class="position-row" style="margin-top: 6px;">
                    <span>TP:</span>
                    <input type="number" step="0.0001" id="pos-tp-input-${pos.id}" class="pos-tp-input" value="${pos.takeProfit ? pos.takeProfit.toFixed(5) : ""}" onchange="updatePositionTPSL(${pos.id}, 'tp', this.value)" style="width: 75px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 2px 4px; border-radius: 3px; font-size: 11px;">
                </div>
                <div class="position-row">
                    <span>SL:</span>
                    <input type="number" step="0.0001" id="pos-sl-input-${pos.id}" class="pos-sl-input" value="${pos.stopLoss ? pos.stopLoss.toFixed(5) : ""}" onchange="updatePositionTPSL(${pos.id}, 'sl', this.value)" style="width: 75px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 2px 4px; border-radius: 3px; font-size: 11px;">
                </div>
            </div>
            <div class="position-pnl">
                <span class="input-label" style="margin-bottom:0">Текущий PnL:</span>
                <span class="pnl-value ${cls}">${sign}$${pnl.toFixed(2)}</span>
            </div>
        `;
    positionsList.appendChild(posEl);
  });
}

window.updatePositionTPSL = (id, field, val) => {
  const pos = state.positions.find((p) => p.id === id);
  if (!pos) return;
  const price = parseFloat(val);
  if (isNaN(price) || price <= 0) {
    if (field === "tp") delete pos.takeProfit;
    else if (field === "sl") delete pos.stopLoss;
  } else {
    if (field === "tp") pos.takeProfit = price;
    else if (field === "sl") pos.stopLoss = price;
  }
  saveSimulatorState();
  drawAllOnCanvas();
};

function placeLimitOrder(type, clickPrice) {
  try {
    const activeAcc = getActiveAccount();
    if (activeAcc && (activeAcc.status === "FAILED" || activeAcc.status === "FINISHED")) {
      showToast(`Торговля заблокирована: счёт находится в статусе ${activeAcc.status}!`, "error");
      return;
    }

    // Очищаем предыдущие черновики ордеров, чтобы на графике был только один актуальный черновик
    state.positions = state.positions.filter((pos) => pos.status !== "draft");

    const arr = state.isBacktestActive
      ? state.backtestVisibleCandles
      : state.historicalCandles;
    if (!arr || arr.length === 0) {
      showToast(
        state.isBacktestActive
          ? "Кликните на свечу для старта бэктеста!"
          : "Пожалуйста, подождите загрузки котировок!",
        "error",
      );
      return;
    }
    const candle = arr[arr.length - 1];
    const price = candle.close;
    const size = parseFloat(volumeInput.value) || 1.0;
    const leverage = parseInt(leverageInput.value) || 100;
    const commission = size * state.commissionPerLot;

    const orderTypeSelect = document.getElementById("order-type-select");
    const orderType = orderTypeSelect ? orderTypeSelect.value : "limit";

    const priceInput = document.getElementById("order-price-input");
    const customPrice = !isNaN(clickPrice) && clickPrice !== null && clickPrice !== undefined
      ? clickPrice
      : (priceInput ? parseFloat(priceInput.value) : NaN);

    if (isNaN(customPrice) || customPrice <= 0) {
      showToast("Пожалуйста, введите корректную цену ордера!", "error");
      return;
    }

    const requiredMargin = (size * 100000 * customPrice) / leverage;
    let marginUSD = state.symbol.endsWith("_JPY")
      ? requiredMargin / customPrice
      : requiredMargin;
    if (marginUSD + commission > balance) {
      showToast("Недостаточно средств для сделки!", "error");
      return;
    }

    // Automatically adjust orderType if needed to match current price
    let adjustedOrderType = orderType;
    if (type === "buy") {
      adjustedOrderType = customPrice < price ? "limit" : "stop";
    } else if (type === "sell") {
      adjustedOrderType = customPrice > price ? "limit" : "stop";
    }
    if (orderTypeSelect && orderTypeSelect.value !== adjustedOrderType) {
      orderTypeSelect.value = adjustedOrderType;
      updateOrderDirectionUI();
    }

    // Deduct commission immediately for pending order
    balance -= commission;
    saveBalance(balance);

    // Calculate hard-bound TP and SL based on the user's algorithm (100 pips)
    const isJpy = state.symbol && (state.symbol.endsWith("_JPY") || state.symbol.includes("JPY"));
    const pipStep = isJpy ? 0.100 : 0.00100;
    const decimals = isJpy ? 3 : 5;

    let takeProfit;
    let stopLoss;

    if (type === "buy") {
      takeProfit = customPrice + pipStep;
      stopLoss = customPrice - pipStep;
    } else {
      takeProfit = customPrice - pipStep;
      stopLoss = customPrice + pipStep;
    }

    // Round values to appropriate decimals
    takeProfit = parseFloat(takeProfit.toFixed(decimals));
    stopLoss = parseFloat(stopLoss.toFixed(decimals));

    const newOrder = {
      id: Date.now(),
      account_id: activeAccountId,
      symbol: state.symbol,
      type: type, // 'buy' or 'sell'
      price: parseFloat(customPrice.toFixed(decimals)),
      entryPrice: parseFloat(customPrice.toFixed(decimals)),
      size: size,
      volume: size,
      leverage: leverage,
      commission: commission,
      timestamp: new Date().toISOString(),
      status: "draft",
      orderType: adjustedOrderType,
      triggerPrice: parseFloat(customPrice.toFixed(decimals)),
      takeProfit: takeProfit,
      tp: takeProfit,
      stopLoss: stopLoss,
      sl: stopLoss,
      notes: {
        noteBefore: "",
        noteDuring: "",
        noteAfter: "",
      },
    };

    state.positions.push(newOrder);
    pendingOrder = null;
    isDraftMode = false;

    const tpInput = document.getElementById("order-tp-input");
    const slInput = document.getElementById("order-sl-input");
    if (tpInput) tpInput.value = "";
    if (slInput) slInput.value = "";

    saveSimulatorState();
    updateSimulatorUI();
    drawAllOnCanvas();
    showToast(
      `Создан черновик отложенного ордера ${adjustedOrderType.toUpperCase()} ${type.toUpperCase()} по цене ${customPrice.toFixed(decimals)}. Пожалуйста, подтвердите его.`,
      "success",
    );
  } catch (err) {
    console.error(err);
  }
}

function placeOrder(type, clickPrice) {
  try {
    const activeAcc = getActiveAccount();
    if (activeAcc && (activeAcc.status === "FAILED" || activeAcc.status === "FINISHED")) {
      showToast(`Торговля заблокирована: счёт находится в статусе ${activeAcc.status}!`, "error");
      return;
    }

    const orderTypeSelect = document.getElementById("order-type-select");
    const orderType = orderTypeSelect ? orderTypeSelect.value : "market";

    if (orderType !== "market") {
      placeLimitOrder(type, clickPrice);
      return;
    }

    const arr = state.isBacktestActive
      ? state.backtestVisibleCandles
      : state.historicalCandles;
    if (!arr || arr.length === 0) {
      showToast(
        state.isBacktestActive
          ? "Кликните на свечу для старта бэктеста!"
          : "Пожалуйста, подождите загрузки котировок!",
        "error",
      );
      return;
    }
    const candle = arr[arr.length - 1];
    const price = candle.close;
    const size = parseFloat(volumeInput.value) || 1.0;
    const leverage = parseInt(leverageInput.value) || 100;
    const commission = size * state.commissionPerLot;
    const requiredMargin = (size * 100000 * price) / leverage;
    let marginUSD = state.symbol.endsWith("_JPY")
      ? requiredMargin / price
      : requiredMargin;

    if (marginUSD + commission > balance) {
      showToast("Недостаточно средств для сделки!", "error");
      return;
    }

    balance -= commission;
    saveBalance(balance);

    const tpInput = document.getElementById("order-tp-input");
    const slInput = document.getElementById("order-sl-input");
    
    // Calculate hard-bound TP and SL if not provided (100 pips)
    const isJpy = state.symbol && (state.symbol.endsWith("_JPY") || state.symbol.includes("JPY"));
    const pipStep = isJpy ? 0.100 : 0.00100;
    const decimals = isJpy ? 3 : 5;

    let takeProfit =
      tpInput && tpInput.value ? parseFloat(tpInput.value) : undefined;
    let stopLoss =
      slInput && slInput.value ? parseFloat(slInput.value) : undefined;

    if (!takeProfit) {
      takeProfit = type === "buy" ? price + pipStep : price - pipStep;
    }
    if (!stopLoss) {
      stopLoss = type === "buy" ? price - pipStep : price + pipStep;
    }

    takeProfit = parseFloat(takeProfit.toFixed(decimals));
    stopLoss = parseFloat(stopLoss.toFixed(decimals));

    state.positions.push({
      id: Date.now(),
      account_id: activeAccountId,
      symbol: state.symbol,
      type: type,
      entryPrice: price,
      size: size,
      leverage: leverage,
      commission: commission,
      timestamp: new Date().toISOString(),
      entryTime: candle ? candle.time : undefined,
      status: "draft",
      orderType: "market",
      triggerPrice: price,
      takeProfit: takeProfit,
      tp: takeProfit,
      stopLoss: stopLoss,
      sl: stopLoss,
      notes: {
        noteBefore: "",
        noteDuring: "",
        noteAfter: "",
      },
    });

    if (tpInput) tpInput.value = "";
    if (slInput) slInput.value = "";

    saveSimulatorState();
    updateSimulatorUI();
    drawAllOnCanvas();
    showToast(
      `Создан черновик рыночного ордера ${type.toUpperCase()} по цене ${price.toFixed(decimals)}. Пожалуйста, подтвердите его.`,
      "success",
    );
  } catch (err) {
    console.error(err);
  }
}

window.closePosition = (id) => {
  const idx = state.positions.findIndex((p) => p.id === id);
  if (idx === -1) return;
  const pos = state.positions[idx];
  playSound("close");
  if (pos.status === "pending" || pos.status === "draft") {
    if (pos.commission) {
      balance += pos.commission;
      saveBalance(balance);
    }
    state.positions.splice(idx, 1);
    pendingOrder = null;
    isDraftMode = false;
    saveSimulatorState();
    updateSimulatorUI();
    drawAllOnCanvas();
    showToast(pos.status === "draft" ? "Черновик ордера отменен!" : "Отложенный ордер отменен!", "info");
    return;
  }
  const arr = state.isBacktestActive
    ? state.backtestVisibleCandles
    : state.historicalCandles;
  const price = arr.length > 0 ? arr[arr.length - 1].close : pos.entryPrice;
  const closingCandleTime =
    arr.length > 0 ? arr[arr.length - 1].time : undefined;
  let pnl = 0;
  const units = pos.size * 100000;
  if (pos.type === "buy") {
    pnl = (price - pos.entryPrice) * units;
  } else {
    pnl = (pos.entryPrice - price) * units;
  }
  if (pos.symbol.endsWith("_JPY")) pnl = pnl / price;
  balance += pnl;
  saveBalance(balance);
  saveAccountsToStorage();
  const closedTrade = {
    id: pos.id,
    account_id: pos.account_id || activeAccountId,
    symbol: pos.symbol,
    type: pos.type,
    size: pos.size,
    leverage: pos.leverage,
    commission: pos.commission,
    entryPrice: pos.entryPrice,
    exitPrice: price,
    pnl: pnl,
    close_reason: Math.abs(pnl) <= 1.0 ? "BU" : "MANUAL",
    openTime: pos.timestamp,
    closeTime: new Date().toISOString(),
    timestamp: new Date().toISOString(),
    entryTime: pos.entryTime,
    exitTime: closingCandleTime,
    notes: {
      noteBefore: pos.notes ? pos.notes.noteBefore : "",
      noteDuring: pos.notes ? pos.notes.noteDuring : "",
      noteAfter: pos.notes ? pos.notes.noteAfter : "",
    },
  };
  tradeHistory.push(closedTrade);
  localStorage.setItem("plbt_trade_history", JSON.stringify(tradeHistory));
  updateTradeHistoryUI();
  state.positions.splice(idx, 1);
  saveSimulatorState();
  updateSimulatorUI();
  drawAllOnCanvas();
  showToast(
    `Позиция закрыта! Результат: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
    pnl >= 0 ? "success" : "error",
  );
  triggerPostTradeJournalReminder(closedTrade);
  if (typeof updateJournalMotivationUI === "function") updateJournalMotivationUI();
  if (typeof evaluateAndNotifyAchievements === "function") evaluateAndNotifyAchievements(false);
};

let currentHistoryFilter = {
  period: "all",
  exactDate: "",
  startDate: "",
  endDate: "",
};

function filterTrades(trades) {
  if (!trades) return [];

  const now = new Date();

  const formatLocalDate = (d) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  const todayStr = formatLocalDate(now);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yesterdayStr = formatLocalDate(yesterday);

  return trades.filter((trade) => {
    // 0. Account Category & Specific Account Filter
    const tradeAccId = trade.account_id || (accounts && accounts[0] ? accounts[0].id : activeAccountId);
    if (currentAccountCategoryFilter !== "ALL") {
      const acc = accounts.find(a => a.id === tradeAccId);
      if (!acc || acc.type !== currentAccountCategoryFilter) {
        return false;
      }
    }
    if (currentAccountSpecificFilter !== "ALL") {
      if (tradeAccId !== currentAccountSpecificFilter) {
        return false;
      }
    }
    if (currentCloseReasonFilter && currentCloseReasonFilter !== "ALL") {
      const reason = trade.close_reason || "MANUAL";
      if (reason !== currentCloseReasonFilter) {
        return false;
      }
    }

    const tradeTimeStr =
      trade.closeTime || trade.openTime || new Date().toISOString();
    const tradeDate = new Date(tradeTimeStr);
    const tradeDateStr = formatLocalDate(tradeDate);

    // 1. Exact Date Filter (if set, overrides period)
    if (currentHistoryFilter.exactDate) {
      return tradeDateStr === currentHistoryFilter.exactDate;
    }

    // 2. Custom Date Range (if set, overrides period)
    if (currentHistoryFilter.startDate || currentHistoryFilter.endDate) {
      let matches = true;
      if (currentHistoryFilter.startDate) {
        matches = matches && tradeDateStr >= currentHistoryFilter.startDate;
      }
      if (currentHistoryFilter.endDate) {
        matches = matches && tradeDateStr <= currentHistoryFilter.endDate;
      }
      return matches;
    }

    // 3. Period Filter
    if (currentHistoryFilter.period === "all") {
      return true;
    } else if (currentHistoryFilter.period === "today") {
      return tradeDateStr === todayStr;
    } else if (currentHistoryFilter.period === "yesterday") {
      return tradeDateStr === yesterdayStr;
    } else if (currentHistoryFilter.period === "week") {
      const oneWeekAgo = new Date();
      oneWeekAgo.setDate(now.getDate() - 7);
      oneWeekAgo.setHours(0, 0, 0, 0);
      return tradeDate >= oneWeekAgo;
    } else if (currentHistoryFilter.period === "month") {
      const oneMonthAgo = new Date();
      oneMonthAgo.setMonth(now.getMonth() - 1);
      oneMonthAgo.setHours(0, 0, 0, 0);
      return tradeDate >= oneMonthAgo;
    } else if (currentHistoryFilter.period === "3months") {
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(now.getMonth() - 3);
      threeMonthsAgo.setHours(0, 0, 0, 0);
      return tradeDate >= threeMonthsAgo;
    }

    return true;
  });
}

// Media Recording for Voice Notes in Trade Journal and Modal Fields
let mediaRecorder = null;
let audioChunks = [];
let recordingTradeId = null;
let recordingFieldKey = null;

function getNormalizedFieldKey(fieldKey) {
  if (fieldKey === 'during' || fieldKey === 'во время') return 'time';
  if (fieldKey === 'после') return 'after';
  if (fieldKey === 'перед') return 'before';
  return fieldKey;
}

async function toggleVoiceRecording(tradeId, fieldKeyOrBtn) {
  let fieldKey = null;
  let btn = null;
  let isModalField = false;

  if (typeof fieldKeyOrBtn === "string") {
    fieldKey = getNormalizedFieldKey(fieldKeyOrBtn);
    btn = document.getElementById(`voice-record-btn-${fieldKey}`);
    isModalField = true;
  } else {
    btn = fieldKeyOrBtn;
    fieldKey = "journal"; 
  }

  const textSpan = btn ? btn.querySelector(".record-btn-text") : null;
  const trade = tradeHistory.find(t => t.id === tradeId);
  if (!trade) return;

  if (mediaRecorder && mediaRecorder.state === "recording") {
    if (recordingTradeId === tradeId && recordingFieldKey === fieldKey) {
      mediaRecorder.stop();
      return;
    } else {
      mediaRecorder.stop();
      showToast("Предыдущая запись остановлена.", "info");
      return;
    }
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    recordingTradeId = tradeId;
    recordingFieldKey = fieldKey;

    let options = {};
    if (MediaRecorder.isTypeSupported('audio/webm')) {
      options = { mimeType: 'audio/webm' };
    } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
      options = { mimeType: 'audio/mp4' };
    }

    mediaRecorder = new MediaRecorder(stream, options);

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: options.mimeType || 'audio/webm' });
      const audioUrl = URL.createObjectURL(audioBlob);

      const dbKey = isModalField ? `voice_note_${tradeId}_${fieldKey}` : `voice_note_${tradeId}`;
      try {
        await saveVoiceNote(dbKey, audioBlob);
      } catch (err) {
        console.error("Failed to save audio Blob via saveVoiceNote to IndexedDB:", err);
      }

      if (isModalField) {
        const player = document.getElementById(`voice-audio-player-${fieldKey}`);
        const deleteBtn = document.getElementById(`voice-delete-btn-${fieldKey}`);
        const wrapper = document.getElementById(`voice-audio-wrapper-${fieldKey}`);
        if (player) {
          player.src = audioUrl;
          player.style.display = "none";
        }
        if (deleteBtn) {
          deleteBtn.style.display = "inline-flex";
        }
        if (wrapper) {
          wrapper.style.display = "flex";
        }
        initCustomAudioPlayer(fieldKey);
      } else {
        trade.voiceNoteUrl = audioUrl;
        const reader = new FileReader();
        reader.onloadend = () => {
          trade.voiceNoteBase64 = reader.result;
          localStorage.setItem("plbt_trade_history", JSON.stringify(tradeHistory));
          updateTradeHistoryUI();
        };
        reader.readAsDataURL(audioBlob);
      }

      stream.getTracks().forEach(track => track.stop());
      mediaRecorder = null;
      recordingTradeId = null;
      recordingFieldKey = null;
      showToast("Голосовая заметка успешно записана!", "success");

      if (btn) {
        btn.style.background = "rgba(255, 255, 255, 0.05)";
        btn.style.color = "#94a3b8";
        btn.style.borderColor = "rgba(255, 255, 255, 0.1)";
        if (textSpan) textSpan.textContent = "Записать войс";
        btn.classList.remove("recording-pulse");
      }
    };

    mediaRecorder.start();

    if (btn) {
      btn.style.background = "#ef4444";
      btn.style.color = "#ffffff";
      btn.style.borderColor = "#dc2626";
      if (textSpan) textSpan.textContent = "Запись...";
      btn.classList.add("recording-pulse");
    }

    if (!document.getElementById("voice-pulse-css")) {
      const style = document.createElement("style");
      style.id = "voice-pulse-css";
      style.innerHTML = `
        @keyframes recording-pulse-anim {
          0% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.6; transform: scale(0.97); }
          100% { opacity: 1; transform: scale(1); }
        }
        .recording-pulse {
          animation: recording-pulse-anim 1s infinite ease-in-out;
        }
      `;
      document.head.appendChild(style);
    }

  } catch (err) {
    console.error("Ошибка при получении доступа к микрофону:", err);
    showToast("Не удалось получить доступ к микрофону: " + err.message, "error");
    mediaRecorder = null;
    recordingTradeId = null;
    recordingFieldKey = null;
  }
}

async function deleteModalVoiceNote(tradeId, fieldKey) {
  const normalizedKey = getNormalizedFieldKey(fieldKey);
  const dbKey = `voice_note_${tradeId}_${normalizedKey}`;
  
  try {
    await deleteVoiceNoteFromDB(dbKey);
    showToast("Голосовая заметка удалена.", "info");
  } catch (err) {
    console.error("Failed to delete voice note from IndexedDB:", err);
  }

  const player = document.getElementById(`voice-audio-player-${normalizedKey}`);
  if (player) {
    player.removeAttribute("src");
    player.load();
    player.style.display = "none";
  }
  const deleteBtn = document.getElementById(`voice-delete-btn-${normalizedKey}`);
  if (deleteBtn) {
    deleteBtn.style.display = "none";
  }
  const wrapper = document.getElementById(`voice-audio-wrapper-${normalizedKey}`);
  if (wrapper) {
    wrapper.style.display = "none";
  }
  initCustomAudioPlayer(normalizedKey);
}

function initCustomAudioPlayer(fieldKey) {
  const audio = document.getElementById(`voice-audio-player-${fieldKey}`);
  if (!audio) return;

  const playBtn = document.getElementById(`voice-play-btn-${fieldKey}`);
  const fill = document.getElementById(`voice-progress-fill-${fieldKey}`);
  const knob = document.getElementById(`voice-progress-knob-${fieldKey}`);
  const timer = document.getElementById(`voice-timer-${fieldKey}`);
  const progressContainer = document.getElementById(`voice-progress-container-${fieldKey}`);

  const formatTime = (secs) => {
    if (isNaN(secs) || secs === Infinity) return "0:00";
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const updateUI = () => {
    const cur = audio.currentTime || 0;
    const dur = audio.duration || 0;
    const pct = dur > 0 ? (cur / dur) * 100 : 0;
    
    if (fill) fill.style.width = `${pct}%`;
    if (knob) knob.style.left = `${pct}%`;
    if (timer) timer.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
  };

  const resetUI = () => {
    if (playBtn) {
      const playIcon = playBtn.querySelector('.play-icon');
      const pauseIcon = playBtn.querySelector('.pause-icon');
      if (playIcon) playIcon.style.display = 'inline-block';
      if (pauseIcon) pauseIcon.style.display = 'none';
    }
    updateUI();
  };

  if (playBtn) {
    playBtn.onclick = (e) => {
      e.stopPropagation();
      if (!audio.src) return;
      if (audio.paused) {
        document.querySelectorAll('audio').forEach(otherAudio => {
          if (otherAudio !== audio && !otherAudio.paused) {
            otherAudio.pause();
          }
        });
        audio.play().then(() => {
          const playIcon = playBtn.querySelector('.play-icon');
          const pauseIcon = playBtn.querySelector('.pause-icon');
          if (playIcon) playIcon.style.display = 'none';
          if (pauseIcon) pauseIcon.style.display = 'inline-block';
        }).catch(err => {
          console.error("Failed to play custom audio:", err);
        });
      } else {
        audio.pause();
        const playIcon = playBtn.querySelector('.play-icon');
        const pauseIcon = playBtn.querySelector('.pause-icon');
        if (playIcon) playIcon.style.display = 'inline-block';
        if (pauseIcon) pauseIcon.style.display = 'none';
      }
    };
  }

  audio.onplay = () => {
    if (playBtn) {
      const playIcon = playBtn.querySelector('.play-icon');
      const pauseIcon = playBtn.querySelector('.pause-icon');
      if (playIcon) playIcon.style.display = 'none';
      if (pauseIcon) pauseIcon.style.display = 'inline-block';
    }
  };

  audio.onpause = () => {
    if (playBtn) {
      const playIcon = playBtn.querySelector('.play-icon');
      const pauseIcon = playBtn.querySelector('.pause-icon');
      if (playIcon) playIcon.style.display = 'inline-block';
      if (pauseIcon) pauseIcon.style.display = 'none';
    }
  };

  audio.onended = () => {
    if (playBtn) {
      const playIcon = playBtn.querySelector('.play-icon');
      const pauseIcon = playBtn.querySelector('.pause-icon');
      if (playIcon) playIcon.style.display = 'inline-block';
      if (pauseIcon) pauseIcon.style.display = 'none';
    }
    updateUI();
  };

  audio.onloadedmetadata = () => {
    updateUI();
  };

  audio.ontimeupdate = () => {
    updateUI();
  };

  if (progressContainer) {
    const handleSeek = (clientX) => {
      if (!audio.duration) return;
      const rect = progressContainer.getBoundingClientRect();
      const x = clientX - rect.left;
      let pct = x / rect.width;
      if (pct < 0) pct = 0;
      if (pct > 1) pct = 1;
      audio.currentTime = pct * audio.duration;
      updateUI();
    };

    let isDragging = false;

    progressContainer.onmousedown = (e) => {
      isDragging = true;
      handleSeek(e.clientX);
      
      const onMouseMove = (moveEvent) => {
        if (isDragging) {
          handleSeek(moveEvent.clientX);
        }
      };

      const onMouseUp = () => {
        isDragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    };

    progressContainer.ontouchstart = (e) => {
      isDragging = true;
      if (e.touches && e.touches.length > 0) {
        handleSeek(e.touches[0].clientX);
      }

      const onTouchMove = (moveEvent) => {
        if (isDragging && moveEvent.touches && moveEvent.touches.length > 0) {
          handleSeek(moveEvent.touches[0].clientX);
        }
      };

      const onTouchEnd = () => {
        isDragging = false;
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', onTouchEnd);
      };

      document.addEventListener('touchmove', onTouchMove);
      document.addEventListener('touchend', onTouchEnd);
    };
  }

  resetUI();
}

function deleteVoiceNote(tradeId) {
  const trade = tradeHistory.find(t => t.id === tradeId);
  if (trade) {
    delete trade.voiceNoteUrl;
    delete trade.voiceNoteBase64;
    localStorage.setItem("plbt_trade_history", JSON.stringify(tradeHistory));
    deleteData(`voice_note_${tradeId}`).catch(e => console.error("Failed to delete voice note from IndexedDB:", e));
    deleteVoiceNoteFromDB(`voice_note_${tradeId}`).catch(e => console.error("Failed to delete voice note from separate store in IndexedDB:", e));
    updateTradeHistoryUI();
    showToast("Голосовая заметка удалена.", "info");
  }
}

function updateJournalMotivationUI() {
  const streakCountEl = document.getElementById("journal-streak-count");
  const streakBadgeEl = document.getElementById("journal-streak-badge");
  const heatmapSummaryEl = document.getElementById("journal-heatmap-summary");
  const heatmapGridEl = document.getElementById("journal-heatmap-grid");

  if (!streakCountEl || !heatmapGridEl) return;

  const datesWithEntries = new Set();
  const dayTradeCounts = {};

  (tradeHistory || []).forEach((trade) => {
    if (!trade) return;
    const hasNotes = trade.notes && (
      (trade.notes.noteBefore && trade.notes.noteBefore.trim()) ||
      (trade.notes.noteDuring && trade.notes.noteDuring.trim()) ||
      (trade.notes.noteAfter && trade.notes.noteAfter.trim())
    );
    const hasTags = Array.isArray(trade.tags) && trade.tags.length > 0;
    const hasVoice = Boolean(trade.voiceNoteUrl || trade.voiceNoteBase64);

    if (hasNotes || hasTags || hasVoice) {
      const rawTime = trade.closeTime || trade.timestamp || trade.openTime || "";
      if (rawTime) {
        const dateStr = rawTime.split("T")[0];
        if (dateStr && dateStr.length === 10) {
          datesWithEntries.add(dateStr);
          dayTradeCounts[dateStr] = (dayTradeCounts[dateStr] || 0) + 1;
        }
      }
    }
  });

  const today = new Date();
  let streak = 0;
  let checkDate = new Date(today);

  const todayStr = checkDate.toISOString().split("T")[0];
  if (!datesWithEntries.has(todayStr)) {
    checkDate.setDate(checkDate.getDate() - 1);
  }

  while (true) {
    const dStr = checkDate.toISOString().split("T")[0];
    if (datesWithEntries.has(dStr)) {
      streak++;
      checkDate.setDate(checkDate.getDate() - 1);
    } else {
      break;
    }
  }

  streakCountEl.textContent = `${streak} дн.`;
  if (streakBadgeEl) {
    if (streak >= 7) {
      streakBadgeEl.textContent = "🔥 Легендарная дисциплина!";
      streakBadgeEl.style.background = "rgba(239, 68, 68, 0.2)";
      streakBadgeEl.style.color = "#fca5a5";
    } else if (streak >= 3) {
      streakBadgeEl.textContent = "⚡ Отличный разгон!";
      streakBadgeEl.style.background = "rgba(245, 158, 11, 0.2)";
      streakBadgeEl.style.color = "#fcd34d";
    } else if (streak >= 1) {
      streakBadgeEl.textContent = "👍 Хорошее начало";
      streakBadgeEl.style.background = "rgba(16, 185, 129, 0.2)";
      streakBadgeEl.style.color = "#6ee7b7";
    } else {
      streakBadgeEl.textContent = "Начните стрик!";
      streakBadgeEl.style.background = "rgba(249, 115, 22, 0.2)";
      streakBadgeEl.style.color = "#fdba74";
    }
  }

  heatmapGridEl.innerHTML = "";
  let filledDays14 = 0;

  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dStr = d.toISOString().split("T")[0];
    const count = dayTradeCounts[dStr] || 0;

    if (count > 0) filledDays14++;

    const dayName = d.toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "short" });
    const square = document.createElement("div");
    square.style.cssText = `
      width: 14px;
      height: 14px;
      border-radius: 3px;
      cursor: pointer;
      transition: transform 0.15s ease, filter 0.15s ease;
      position: relative;
    `;

    if (count === 0) {
      square.style.background = "rgba(255, 255, 255, 0.06)";
      square.style.border = "1px solid rgba(255, 255, 255, 0.08)";
    } else if (count === 1) {
      square.style.background = "#10b981";
      square.style.boxShadow = "0 0 6px rgba(16, 185, 129, 0.4)";
    } else {
      square.style.background = "#34d399";
      square.style.boxShadow = "0 0 8px rgba(52, 211, 153, 0.6)";
    }

    square.title = `${dayName}: ${count} ${count === 1 ? 'запись' : count > 1 && count < 5 ? 'записи' : 'записей'} в журнале`;
    square.addEventListener("mouseenter", () => square.style.transform = "scale(1.25)");
    square.addEventListener("mouseleave", () => square.style.transform = "scale(1)");

    heatmapGridEl.appendChild(square);
  }

  if (heatmapSummaryEl) {
    heatmapSummaryEl.textContent = `${filledDays14}/14 дней с записями`;
  }
}

function triggerPostTradeJournalReminder(trade) {
  if (typeof isNotificationsEnabled !== "undefined" && !isNotificationsEnabled) return;
  if (!trade || !trade.id) return;

  const cont = document.getElementById("toast-container");
  if (!cont) return;

  const t = document.createElement("div");
  t.className = "toast toast-info";
  t.style.cssText =
    "pointer-events:auto; min-width:310px; max-width:400px; padding:12px 16px; border-radius:8px; background:#0f172a; border:1px solid rgba(249,115,22,0.4); font-size:12px; font-weight:500; line-height:1.4; box-shadow:0 10px 30px rgba(0,0,0,0.6); display:flex; flex-direction:column; gap:8px; opacity:0; transform:translateY(-20px); transition:all 0.4s cubic-bezier(0.16, 1, 0.3, 1); margin-top:6px;";

  const pnlVal = trade.pnl || 0;
  const pnlSign = pnlVal >= 0 ? "+" : "";
  const pnlFormatted = `$${pnlVal.toFixed(2)}`;

  t.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; width:100%;">
      <div style="display:flex; align-items:center; gap:6px; font-weight:700; color:#ffffff;">
        <span style="font-size:14px;">🔥</span>
        <span>Журнал эмоций</span>
      </div>
      <span style="font-size:10px; color:${pnlVal >= 0 ? '#10b981' : '#f87171'}; font-weight:700;">${trade.symbol || ''} (${pnlSign}${pnlFormatted})</span>
    </div>
    <div style="font-size:11px; color:#cbd5e1;">Сделка закрыта. Заполните эмоции и заметку в журнале для поддержания стрика!</div>
    <div style="display:flex; gap:8px; margin-top:2px;">
      <button class="fill-journal-btn" style="flex:1; padding:6px 10px; background:#f97316; border:none; border-radius:4px; color:#fff; font-size:11px; font-weight:600; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:4px;">
        📝 Заполнить эмоцию
      </button>
      <button class="dismiss-journal-btn" style="padding:6px 10px; background:transparent; border:1px solid rgba(255,255,255,0.2); border-radius:4px; color:var(--text-muted); font-size:11px; cursor:pointer;">
        Позже
      </button>
    </div>
  `;

  const fillBtn = t.querySelector(".fill-journal-btn");
  const dismissBtn = t.querySelector(".dismiss-journal-btn");

  fillBtn?.addEventListener("click", () => {
    t.style.opacity = "0";
    t.style.transform = "translateY(-20px)";
    setTimeout(() => t.remove(), 400);

    const journalBtn = document.getElementById("tab-btn-journal");
    if (journalBtn) journalBtn.click();
    if (typeof window.openTradeNotesModal === "function") {
      window.openTradeNotesModal(trade.id);
    }
  });

  dismissBtn?.addEventListener("click", () => {
    t.style.opacity = "0";
    t.style.transform = "translateY(-20px)";
    setTimeout(() => t.remove(), 400);
  });

  cont.appendChild(t);
  requestAnimationFrame(() => {
    t.style.opacity = "1";
    t.style.transform = "translateY(0)";
  });

  setTimeout(() => {
    if (t.parentNode) {
      t.style.opacity = "0";
      t.style.transform = "translateY(-20px)";
      setTimeout(() => t.remove(), 400);
    }
  }, 9000);
}

function updateCloseReasonFilterVisuals() {
  const reasonSelect = document.getElementById("filter-close-reason-select");
  const resetReasonBtn = document.getElementById("reset-close-reason-btn");
  if (!reasonSelect) return;
  if (reasonSelect.value !== currentCloseReasonFilter) {
    reasonSelect.value = currentCloseReasonFilter || "ALL";
  }
  if (currentCloseReasonFilter && currentCloseReasonFilter !== "ALL") {
    reasonSelect.style.borderColor = "#38bdf8";
    reasonSelect.style.background = "rgba(56, 189, 248, 0.15)";
    reasonSelect.style.color = "#38bdf8";
    reasonSelect.style.fontWeight = "600";
    reasonSelect.style.boxShadow = "0 0 8px rgba(56, 189, 248, 0.25)";
    if (resetReasonBtn) resetReasonBtn.style.display = "inline-flex";
  } else {
    reasonSelect.style.borderColor = "var(--border-color)";
    reasonSelect.style.background = "rgba(0,0,0,0.3)";
    reasonSelect.style.color = "#cbd5e1";
    reasonSelect.style.fontWeight = "normal";
    reasonSelect.style.boxShadow = "none";
    if (resetReasonBtn) resetReasonBtn.style.display = "none";
  }
}

function updateTradeHistoryUI(selectedDate) {
  const tableBody = document.getElementById("history-table-body");
  const placeholder = document.getElementById("no-history-placeholder");
  const tableEl = document.getElementById("history-table-el");
  const totalTradesEl = document.getElementById("stat-total-trades");
  const winrateEl = document.getElementById("stat-winrate");
  const profitFactorEl = document.getElementById("stat-profit-factor");
  const netProfitEl = document.getElementById("stat-net-profit");

  updateCloseReasonFilterVisuals();

  if (!tableBody) return;
  tableBody.innerHTML = "";

  // Если передана выбранная дата, автоматически обновляем фильтры в журнале и вкладку
  if (selectedDate) {
    currentHistoryFilter.exactDate = selectedDate;
    currentHistoryFilter.period = "all";
    currentHistoryFilter.startDate = "";
    currentHistoryFilter.endDate = "";

    const exactDateInput = document.getElementById("filter-exact-date");
    if (exactDateInput) exactDateInput.value = selectedDate;

    const startDateInput = document.getElementById("filter-start-date");
    if (startDateInput) startDateInput.value = "";

    const endDateInput = document.getElementById("filter-end-date");
    if (endDateInput) endDateInput.value = "";

    const periodButtons = document.querySelectorAll(".filter-period-btn");
    periodButtons.forEach((b) => b.classList.remove("active"));

    // Переключаем вкладку на Журнал (view-journal-container)
    const journalBtn = document.getElementById("tab-btn-journal");
    const analyticsBtn = document.getElementById("tab-btn-analytics");
    const journalView = document.getElementById("view-journal-container");
    const analyticsView = document.getElementById("view-analytics-container");

    journalBtn?.classList.add("active");
    analyticsBtn?.classList.remove("active");
    journalView?.classList.add("active");
    analyticsView?.classList.remove("active");
    isAnalyticsActive = false;
  }

  if (!tradeHistory || tradeHistory.length === 0) {
    if (placeholder) {
      placeholder.style.display = "flex";
      const textSpan = placeholder.querySelector("span");
      if (textSpan) {
        if (currentHistoryFilter.exactDate) {
          textSpan.textContent = "Сделок за этот день не найдено.";
        } else {
          textSpan.textContent =
            "История сделок пуста. Закройте позицию в симуляторе, чтобы сделать запись.";
        }
      }
    }
    if (tableEl) tableEl.style.display = "none";
    if (totalTradesEl) totalTradesEl.textContent = "0";
    if (winrateEl) {
      winrateEl.textContent = "0%";
      winrateEl.className = "value";
    }
    if (profitFactorEl) {
      profitFactorEl.textContent = "0.00";
      profitFactorEl.className = "value";
    }
    if (netProfitEl) {
      netProfitEl.textContent = "$0.00 (Прибыльных: 0 | Убыточных: 0)";
      netProfitEl.className = "value";
    }

    // Refresh analytics anyway
    if (isAnalyticsActive) {
      drawPnLEquityChart();
      renderHeatmapCalendar();
    }
    return;
  }

  const filteredHistory = filterTrades(tradeHistory);

  if (!filteredHistory || filteredHistory.length === 0) {
    if (placeholder) {
      placeholder.style.display = "flex";
      const textSpan = placeholder.querySelector("span");
      if (textSpan) {
        if (currentHistoryFilter.exactDate) {
          textSpan.textContent = "Сделок за этот день не найдено.";
        } else {
          textSpan.textContent =
            "Нет сделок, соответствующих выбранным фильтрам.";
        }
      }
    }
    if (tableEl) tableEl.style.display = "none";
    if (totalTradesEl) totalTradesEl.textContent = "0";
    if (winrateEl) {
      winrateEl.textContent = "0%";
      winrateEl.className = "value";
    }
    if (profitFactorEl) {
      profitFactorEl.textContent = "0.00";
      profitFactorEl.className = "value";
    }
    if (netProfitEl) {
      netProfitEl.textContent = "$0.00 (Прибыльных: 0 | Убыточных: 0)";
      netProfitEl.className = "value";
    }

    if (isAnalyticsActive) {
      drawPnLEquityChart();
      renderHeatmapCalendar();
    }
    return;
  }

  if (placeholder) placeholder.style.display = "none";
  if (tableEl) tableEl.style.display = "table";

  let winTrades = 0;
  let lossTrades = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let netProfit = 0;
  const sortedHistory = [...filteredHistory].reverse();
  sortedHistory.forEach((trade) => {
    const tr = document.createElement("tr");
    tr.style.cursor = "pointer";
    
    const pnl = trade.pnl || 0;
    netProfit += pnl;
    if (pnl > 0) {
      winTrades++;
      grossProfit += pnl;
      tr.classList.add("trade-row-profit");
    } else {
      lossTrades++;
      grossLoss += Math.abs(pnl);
      tr.classList.add("trade-row-loss");
    }
    
    tr.title = "Кликните, чтобы показать сделку на графике и развернуть детали";

    const pnlClass = pnl >= 0 ? "pnl-value profit" : "pnl-value loss";
    const pnlSign = pnl >= 0 ? "+" : "";
    const formattedOpenTime = trade.openTime
      ? new Date(trade.openTime).toLocaleString("ru-RU", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          day: "2-digit",
          month: "2-digit",
        })
      : "—";
    const formattedCloseTime = trade.closeTime
      ? new Date(trade.closeTime).toLocaleString("ru-RU", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          day: "2-digit",
          month: "2-digit",
        })
      : "—";

    const currentComment = trade.comment || (trade.notes ? (trade.notes.noteAfter || trade.notes.noteBefore || trade.notes.noteDuring) : "") || "";
    const isExpanded = expandedTradeIds.has(trade.id);
    const rotation = isExpanded ? "180deg" : "0deg";

    const tradeAccId = trade.account_id || (accounts && accounts[0] ? accounts[0].id : activeAccountId);
    const tradeAcc = accounts.find(a => a.id === tradeAccId);
    const accName = tradeAcc ? tradeAcc.name : "Счёт";
    const accType = tradeAcc ? tradeAcc.type : "PERSONAL";
    const accBadgeClass = accType === "PROP" ? "prop" : (accType === "COMPETITION" ? "competition" : "personal");

    tr.innerHTML = `
            <td style="font-weight: 600; vertical-align: middle;">
                <div style="display: flex; align-items: center; gap: 6px;">
                    <span>${(trade.symbol || "").replace("_", "/")}</span>
                    <div class="trade-indicators" style="display: inline-flex; gap: 4px; align-items: center; vertical-align: middle;">
                        ${currentComment ? `<i data-lucide="message-square" style="width: 10px; height: 10px; color: var(--color-accent); opacity: 0.8;" title="Есть комментарий"></i>` : ""}
                        ${trade.voiceNoteUrl ? `<i data-lucide="mic" style="width: 10px; height: 10px; color: var(--color-up); opacity: 0.8;" title="Есть аудиозаметка"></i>` : ""}
                    </div>
                </div>
            </td>
            <td style="vertical-align: middle;">
                <span class="account-badge ${accBadgeClass}" title="${accName} (${tradeAcc ? tradeAcc.broker_or_firm : ''})">
                    ${accName}
                </span>
            </td>
            <td><span class="history-badge ${trade.type}">${(trade.type || "").toUpperCase()}</span></td>
            <td class="font-mono">${trade.size} L</td>
            <td class="font-mono">1:${trade.leverage || 100}</td>
            <td class="font-mono">$${(trade.commission || 0).toFixed(2)}</td>
            <td class="font-mono">${(trade.entryPrice || 0).toFixed(5)}</td>
            <td class="font-mono">${(trade.exitPrice || 0).toFixed(5)}</td>
            <td class="${pnlClass}" style="font-weight: bold;">${pnlSign}$${pnl.toFixed(2)}</td>
            <td style="vertical-align: middle;">
                <select class="trade-close-reason-select" data-trade-id="${trade.id}" style="background: rgba(0,0,0,0.3); border: 1px solid var(--border-color); border-radius: 4px; color: #fff; font-size: 10px; padding: 2px 4px; cursor: pointer;">
                    <option value="TP" ${(trade.close_reason === 'TP') ? 'selected' : ''}>🎯 TP</option>
                    <option value="SL" ${(trade.close_reason === 'SL') ? 'selected' : ''}>🛑 SL</option>
                    <option value="BU" ${(trade.close_reason === 'BU') ? 'selected' : ''}>⚖️ BU</option>
                    <option value="MANUAL" ${(!trade.close_reason || trade.close_reason === 'MANUAL') ? 'selected' : ''}>✋ MANUAL</option>
                </select>
            </td>
            <td style="color: var(--text-muted); font-size: 10px;">${formattedOpenTime}</td>
            <td style="color: var(--text-muted); font-size: 10px;">${formattedCloseTime}</td>
            <td style="vertical-align: middle; max-width: 250px; white-space: normal !important;">
                <div class="trade-tags-cell-container" data-trade-id="${trade.id}" style="display: flex; flex-wrap: wrap; gap: 5px; max-width: 250px; position: relative; min-height: 18px; white-space: normal !important; align-items: center;">
                </div>
            </td>
            <td style="text-align: center; border-bottom: 1px solid var(--border-color); vertical-align: middle;">
                <div style="display: inline-flex; gap: 4px; align-items: center; justify-content: center;">
                    <button class="row-action-btn btn-view-chart" title="Показать сделку на графике" style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: var(--text-primary); border-radius: 4px; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.2s;">
                        <i data-lucide="eye" style="width: 12px; height: 12px;"></i>
                    </button>
                    <button class="row-action-btn btn-edit-notes" title="Открыть заметки / дневник сделки" style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: var(--text-primary); border-radius: 4px; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.2s;">
                        <i data-lucide="file-text" style="width: 12px; height: 12px;"></i>
                    </button>
                    <button class="row-action-btn btn-toggle-comment" title="Показать/скрыть комментарий" style="background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); color: var(--text-primary); border-radius: 4px; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.2s;">
                        <i data-lucide="chevron-down" style="width: 12px; height: 12px; transition: transform 0.2s; transform: rotate(${rotation});"></i>
                    </button>
                </div>
            </td>
        `;

    const reasonSelect = tr.querySelector(".trade-close-reason-select");
    reasonSelect?.addEventListener("click", (e) => e.stopPropagation());
    reasonSelect?.addEventListener("change", (e) => {
      trade.close_reason = e.target.value;
      localStorage.setItem("plbt_trade_history", JSON.stringify(tradeHistory));
      saveData("plbt_trade_history", tradeHistory).catch(err => console.error(err));
      updateTradeHistoryUI();
      showToast(`Причина закрытия сделки обновлена на: ${e.target.value}`, "info");
    });

    const viewBtn = tr.querySelector(".btn-view-chart");
    viewBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      window.scrollToTrade(trade.id);
    });

    const notesBtn = tr.querySelector(".btn-edit-notes");
    notesBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      window.openTradeNotesModal(trade.id);
    });

    const tagsContainer = tr.querySelector(`.trade-tags-cell-container[data-trade-id="${trade.id}"]`);
    if (tagsContainer) {
      renderTradeRowTags(trade, tagsContainer);
    }

    // Создаем дополнительную строку для ввода/редактирования комментария и голосовой заметки
    const commentTr = document.createElement("tr");
    commentTr.style.background = "rgba(255, 255, 255, 0.01)";
    commentTr.style.borderBottom = "1px solid var(--border-color)";
    commentTr.style.display = isExpanded ? "table-row" : "none";
    
    commentTr.innerHTML = `
      <td colspan="12" style="padding: 6px 16px 10px 16px; border-bottom: 1px solid var(--border-color);">
        <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
          <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 200px;">
            <span style="font-size: 10px; color: var(--text-muted); font-weight: 500; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;">
              <i data-lucide="message-square" style="width: 10px; height: 10px; color: var(--color-accent);"></i>
              Комментарий:
            </span>
            <input type="text" class="trade-inline-comment-input" placeholder="Добавить комментарий к этой сделке..." value="${currentComment.replace(/"/g, '&quot;')}" style="flex: 1; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.08); border-radius: 4px; padding: 4px 10px; color: #fff; font-size: 11px; outline: none; transition: all 0.2s; font-family: var(--font-sans);" />
          </div>

          <!-- Голосовые заметки (MediaRecorder) -->
          <div class="voice-note-container" style="display: flex; align-items: center; gap: 8px;">
            <button class="voice-record-btn" title="Записать голосовую заметку" style="background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1); color: #94a3b8; border-radius: 4px; padding: 4px 10px; display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; cursor: pointer; transition: all 0.2s; height: 26px; white-space: nowrap; flex-shrink: 0;" onmouseover="this.style.background='rgba(255, 255, 255, 0.1)'; this.style.color='#f8fafc'; this.style.borderColor='rgba(255, 255, 255, 0.2)';" onmouseout="if(!this.classList.contains('recording-pulse')){ this.style.background='rgba(255, 255, 255, 0.05)'; this.style.color='#94a3b8'; this.style.borderColor='rgba(255, 255, 255, 0.1)'; }">
              <i data-lucide="mic" style="width: 12px; height: 12px; color: var(--color-accent);"></i>
              <span class="record-btn-text">Записать войс-заметку</span>
            </button>
            <div class="voice-player-wrapper" style="${trade.voiceNoteUrl ? 'display: inline-flex' : 'display: none'}; align-items: center; gap: 8px; background: rgba(255, 255, 255, 0.05); padding: 2px 8px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.1); height: 26px;">
              <audio class="voice-audio-player" src="${trade.voiceNoteUrl || ''}" style="display: none;"></audio>
              <button class="voice-play-pause-btn" title="Воспроизвести / Пауза" style="background: none; border: none; color: var(--color-accent, #38bdf8); cursor: pointer; display: inline-flex; align-items: center; justify-content: center; padding: 0; outline: none; transition: transform 0.2s; width: 16px; height: 16px;">
                <i data-lucide="play" style="width: 12px; height: 12px;"></i>
              </button>
              <input type="range" class="voice-seek-slider" min="0" max="100" value="0" style="width: 80px; height: 4px; -webkit-appearance: none; appearance: none; background: rgba(255,255,255,0.2); border-radius: 2px; outline: none; cursor: pointer; transition: background 0.3s; margin: 0 2px;" />
              <span class="voice-time-display" style="font-size: 9px; color: #94a3b8; font-family: var(--font-mono); min-width: 24px; text-align: right; user-select: none; margin-right: 2px;">0:00</span>
              <button class="voice-delete-btn" title="Удалить голосовую заметку" style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.2); color: #ef4444; border-radius: 4px; width: 18px; height: 18px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; font-size: 9px; transition: all 0.2s;" onmouseover="this.style.background='rgba(239, 68, 68, 0.25)'" onmouseout="this.style.background='rgba(239, 68, 68, 0.15)'">✕</button>
            </div>
          </div>
        </div>
      </td>
    `;

    const updateIndicators = () => {
      const indicatorContainer = tr.querySelector(".trade-indicators");
      if (!indicatorContainer) return;
      const actualComment = trade.comment || (trade.notes ? (trade.notes.noteAfter || trade.notes.noteBefore || trade.notes.noteDuring) : "") || "";
      const hasVoice = !!trade.voiceNoteUrl;
      
      indicatorContainer.innerHTML = `
        ${actualComment ? `<i data-lucide="message-square" style="width: 10px; height: 10px; color: var(--color-accent); opacity: 0.8;" title="Есть комментарий"></i>` : ""}
        ${hasVoice ? `<i data-lucide="mic" style="width: 10px; height: 10px; color: var(--color-up); opacity: 0.8;" title="Есть аудиозаметка"></i>` : ""}
      `;
      if (window.lucide) window.lucide.createIcons();
    };

    const toggleCommentRow = () => {
      const currentlyExpanded = expandedTradeIds.has(trade.id);
      const icon = tr.querySelector(".btn-toggle-comment i");
      if (currentlyExpanded) {
        expandedTradeIds.delete(trade.id);
        commentTr.style.display = "none";
        if (icon) {
          icon.style.transform = "rotate(0deg)";
        }
      } else {
        expandedTradeIds.add(trade.id);
        commentTr.style.display = "table-row";
        if (icon) {
          icon.style.transform = "rotate(180deg)";
        }
        window.scrollToTrade(trade.id);
      }
    };

    tr.addEventListener("click", (e) => {
      if (
        e.target.closest("button") ||
        e.target.closest("input") ||
        e.target.closest("audio") ||
        e.target.closest("a") ||
        e.target.closest("svg") ||
        e.target.closest("i")
      ) {
        return;
      }
      toggleCommentRow();
    });

    const toggleBtn = tr.querySelector(".btn-toggle-comment");
    toggleBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleCommentRow();
    });

    const commentInput = commentTr.querySelector(".trade-inline-comment-input");
    commentInput?.addEventListener("click", (e) => {
      e.stopPropagation();
    });
    commentInput?.addEventListener("input", (e) => {
      const val = e.target.value;
      trade.comment = val;
      if (!trade.notes) {
        trade.notes = { noteBefore: "", noteDuring: "", noteAfter: "" };
      }
      trade.notes.noteAfter = val;
      localStorage.setItem("plbt_trade_history", JSON.stringify(tradeHistory));
      updateIndicators();
      if (typeof updateJournalMotivationUI === "function") updateJournalMotivationUI();
      if (typeof evaluateAndNotifyAchievements === "function") evaluateAndNotifyAchievements(false);
    });

    const voiceBtn = commentTr.querySelector(".voice-record-btn");
    voiceBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleVoiceRecording(trade.id, voiceBtn);
    });

    // Custom audio controller events
    const playPauseBtn = commentTr.querySelector(".voice-play-pause-btn");
    const audioEl = commentTr.querySelector(".voice-audio-player");
    const slider = commentTr.querySelector(".voice-seek-slider");
    const timeDisplay = commentTr.querySelector(".voice-time-display");

    if (playPauseBtn && audioEl && slider) {
      // Fix for WebM Infinity duration bug in Chrome/Safari:
      const forceFetchDuration = () => {
        if (audioEl.duration === Infinity) {
          audioEl.currentTime = 1e101;
          const onSeeked = () => {
            audioEl.removeEventListener("seeked", onSeeked);
            audioEl.currentTime = 0;
          };
          audioEl.addEventListener("seeked", onSeeked);
        }
      };

      audioEl.addEventListener("loadedmetadata", forceFetchDuration);
      audioEl.addEventListener("durationchange", forceFetchDuration);

      playPauseBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (audioEl.paused) {
          // Pause other audio players for clean sound
          document.querySelectorAll(".voice-audio-player").forEach((otherAudio) => {
            if (otherAudio !== audioEl) {
              otherAudio.pause();
              const otherBtn = otherAudio.parentElement?.querySelector(".voice-play-pause-btn");
              if (otherBtn) {
                otherBtn.innerHTML = '<i data-lucide="play" style="width: 12px; height: 12px;"></i>';
                if (window.lucide) window.lucide.createIcons();
              }
            }
          });
          audioEl.play().catch(err => console.error("Audio play failed:", err));
          playPauseBtn.innerHTML = '<i data-lucide="pause" style="width: 12px; height: 12px;"></i>';
        } else {
          audioEl.pause();
          playPauseBtn.innerHTML = '<i data-lucide="play" style="width: 12px; height: 12px;"></i>';
        }
        if (window.lucide) window.lucide.createIcons();
      });

      audioEl.addEventListener("timeupdate", () => {
        const duration = audioEl.duration;
        if (duration > 0 && duration !== Infinity) {
          const progress = (audioEl.currentTime / duration) * 100;
          slider.value = progress;
          if (timeDisplay) {
            const curMins = Math.floor(audioEl.currentTime / 60);
            const curSecs = Math.floor(audioEl.currentTime % 60).toString().padStart(2, "0");
            timeDisplay.textContent = `${curMins}:${curSecs}`;
          }
        }
      });

      audioEl.addEventListener("ended", () => {
        playPauseBtn.innerHTML = '<i data-lucide="play" style="width: 12px; height: 12px;"></i>';
        slider.value = 0;
        if (timeDisplay) timeDisplay.textContent = "0:00";
        if (window.lucide) window.lucide.createIcons();
      });

      const handleSeek = (e) => {
        e.stopPropagation();
        const duration = audioEl.duration;
        if (duration > 0 && duration !== Infinity) {
          audioEl.currentTime = (slider.value / 100) * duration;
        }
      };
      slider.addEventListener("click", (e) => e.stopPropagation());
      slider.addEventListener("input", handleSeek);
      slider.addEventListener("change", handleSeek);
    }

    const voiceDelBtn = commentTr.querySelector(".voice-delete-btn");
    voiceDelBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteVoiceNote(trade.id);
    });

    tableBody.appendChild(tr);
    tableBody.appendChild(commentTr);
  });

  const totalTrades = filteredHistory.length;
  const winrate = totalTrades > 0 ? (winTrades / totalTrades) * 100 : 0;

  let profitFactorText = "0.00";
  if (grossProfit === 0 && grossLoss === 0) {
    profitFactorText = "0.00";
  } else if (grossLoss === 0 && grossProfit > 0) {
    profitFactorText = "∞";
  } else {
    profitFactorText = (grossProfit / grossLoss).toFixed(2);
  }

  if (totalTradesEl) {
    if (filteredHistory && tradeHistory && filteredHistory.length !== tradeHistory.length) {
      totalTradesEl.textContent = `${filteredHistory.length} / ${tradeHistory.length}`;
      totalTradesEl.title = `Показано ${filteredHistory.length} из ${tradeHistory.length} сделок`;
    } else {
      totalTradesEl.textContent = totalTrades.toString();
      totalTradesEl.title = `Всего сделок: ${totalTrades}`;
    }
  }
  if (winrateEl) {
    winrateEl.textContent = `${winrate.toFixed(1)}%`;
    winrateEl.className = "value";
    if (winrate >= 55) {
      winrateEl.classList.add("stat-val-green");
    } else if (winrate >= 40) {
      winrateEl.classList.add("stat-val-yellow");
    } else {
      winrateEl.classList.add("stat-val-red");
    }
  }
  if (profitFactorEl) {
    profitFactorEl.textContent = profitFactorText;
    profitFactorEl.className = "value";
    const pfVal = parseFloat(profitFactorText);
    if (profitFactorText === "∞") {
      profitFactorEl.classList.add("stat-val-green");
    } else if (!isNaN(pfVal)) {
      if (pfVal >= 1.5) {
        profitFactorEl.classList.add("stat-val-green");
      } else if (pfVal >= 1.0) {
        profitFactorEl.classList.add("stat-val-yellow");
      } else {
        profitFactorEl.classList.add("stat-val-red");
      }
    }
  }
  if (netProfitEl) {
    netProfitEl.textContent = `${netProfit >= 0 ? "+" : ""}$${netProfit.toFixed(2)} (Прибыльных: ${winTrades} | Убыточных: ${lossTrades})`;
    netProfitEl.className = `value ${netProfit >= 0 ? "profit" : "loss"}`;
  }

  // Calculate close_reason stats for filteredHistory
  let tpCount = 0, tpPnl = 0;
  let slCount = 0, slPnl = 0;
  let buCount = 0, buPnl = 0;
  let manualCount = 0, manualPnl = 0;

  filteredHistory.forEach((trade) => {
    const reason = trade.close_reason || "MANUAL";
    const pnl = trade.pnl || 0;
    if (reason === "TP") { tpCount++; tpPnl += pnl; }
    else if (reason === "SL") { slCount++; slPnl += pnl; }
    else if (reason === "BU") { buCount++; buPnl += pnl; }
    else { manualCount++; manualPnl += pnl; }
  });

  const tpCountEl = document.getElementById("stat-tp-count");
  const tpPnlEl = document.getElementById("stat-tp-pnl");
  if (tpCountEl) tpCountEl.textContent = tpCount.toString();
  if (tpPnlEl) tpPnlEl.textContent = `${tpPnl >= 0 ? "+" : ""}$${tpPnl.toFixed(2)}`;

  const slCountEl = document.getElementById("stat-sl-count");
  const slPnlEl = document.getElementById("stat-sl-pnl");
  if (slCountEl) slCountEl.textContent = slCount.toString();
  if (slPnlEl) slPnlEl.textContent = `${slPnl >= 0 ? "+" : ""}$${slPnl.toFixed(2)}`;

  const buCountEl = document.getElementById("stat-bu-count");
  const buPnlEl = document.getElementById("stat-bu-pnl");
  if (buCountEl) buCountEl.textContent = buCount.toString();
  if (buPnlEl) buPnlEl.textContent = `${buPnl >= 0 ? "+" : ""}$${buPnl.toFixed(2)}`;

  const manualCountEl = document.getElementById("stat-manual-count");
  const manualPnlEl = document.getElementById("stat-manual-pnl");
  if (manualCountEl) manualCountEl.textContent = manualCount.toString();
  if (manualPnlEl) manualPnlEl.textContent = `${manualPnl >= 0 ? "+" : ""}$${manualPnl.toFixed(2)}`;

  if (isAnalyticsActive) {
    drawPnLEquityChart();
    renderHeatmapCalendar();
  }

  updateJournalMotivationUI();
  if (typeof evaluateAndNotifyAchievements === "function") {
    evaluateAndNotifyAchievements(true);
  }

  if (window.lucide) {
    window.lucide.createIcons();
  }
}

window.scrollToTrade = (tradeId) => {
  const trade = tradeHistory.find((t) => t.id === tradeId);
  if (!trade) return;

  // Автоматически выбираем дату этой сделки на календаре
  const tTime = trade.closeTime || trade.timestamp || trade.openTime;
  if (tTime) {
    const d = new Date(tTime);
    const paddedMonth = String(d.getMonth() + 1).padStart(2, "0");
    const paddedDay = String(d.getDate()).padStart(2, "0");
    const dateString = `${d.getFullYear()}-${paddedMonth}-${paddedDay}`;
    
    selectedHistoryDateStr = dateString;
    selectedHistoryTrades = filterTradesByDate(dateString);
    renderHeatmapCalendar();
  }

  const arr = state.isBacktestActive
    ? state.backtestVisibleCandles
    : state.historicalCandles;
  if (!arr || arr.length === 0) return;

  // Ищем индекс свечи по entryTime
  let idx = -1;
  if (trade.entryTime) {
    idx = arr.findIndex((c) => c.time === trade.entryTime);
  }

  // Если не нашли по entryTime, пробуем сопоставить по openTime (timestamp)
  if (idx === -1 && trade.openTime) {
    const openDateStr = new Date(trade.openTime).toDateString();
    idx = arr.findIndex((c) => {
      const cDateStr = new Date(c.time * 1000).toDateString();
      return cDateStr === openDateStr;
    });
  }

  if (idx !== -1) {
    // Центрируем график на найденном индексе
    const halfVisible = 30; // 30 свечей слева и справа для центрирования
    chart.timeScale().setVisibleLogicalRange({
      from: idx - halfVisible,
      to: idx + halfVisible,
    });

    // Устанавливаем флаг выделенной сделки для отрисовки стрелок на Canvas
    state.selectedTradeId = trade.id;

    drawAllOnCanvas();
    showToast(`График сфокусирован на сделке #${trade.id}`, "info");
  } else {
    showToast("Свеча сделки не найдена в текущей истории котировок", "warning");
  }
};

window.getPnlChartData = () => {
  const filteredTrades = filterTrades(tradeHistory);
  // Сортируем сделки в хронологическом порядке (от старых к новым)
  const sortedTrades = [...filteredTrades].sort((a, b) => {
    const timeA = new Date(a.closeTime || a.timestamp).getTime();
    const timeB = new Date(b.closeTime || b.timestamp).getTime();
    return timeA - timeB;
  });

  let currentBal = 10000; // Начальный баланс по умолчанию
  const balanceHistory = localStorage.getItem("plbt_balance_history");
  if (balanceHistory) {
    try {
      const parsed = JSON.parse(balanceHistory);
      if (parsed && parsed.length > 0) {
        currentBal = parsed[0].balance;
      }
    } catch (e) {}
  } else {
    const totalPnl = sortedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    currentBal = Math.max(100, balance - totalPnl);
  }

  const points = [];
  // Начальная точка перед первой сделкой
  if (sortedTrades.length > 0) {
    const firstTradeTime = new Date(
      sortedTrades[0].closeTime || sortedTrades[0].timestamp,
    );
    const startPointTime = new Date(firstTradeTime.getTime() - 4 * 3600 * 1000); // 4 часа назад
    points.push({
      time: startPointTime.toISOString(),
      balance: currentBal,
      formattedTime: startPointTime.toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
    });
  } else {
    const now = new Date();
    points.push({
      time: now.toISOString(),
      balance: currentBal,
      formattedTime: now.toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
    });
  }

  sortedTrades.forEach((trade) => {
    currentBal += trade.pnl || 0;
    const tradeTime = new Date(trade.closeTime || trade.timestamp);
    points.push({
      time: tradeTime.toISOString(),
      balance: parseFloat(currentBal.toFixed(2)),
      formattedTime: tradeTime.toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
      pnl: trade.pnl,
      symbol: trade.symbol,
      type: trade.type,
    });
  });

  return points;
};

function exportTradeHistoryCSV() {
  if (!tradeHistory || tradeHistory.length === 0) {
    showToast("Нет закрытых сделок для экспорта!", "info");
    return;
  }
  let csv =
    "ID,Account,AccountType,Symbol,Type,Size,Leverage,Commission,EntryPrice,ExitPrice,PnL,OpenTime,CloseTime\n";
  tradeHistory.forEach((t) => {
    const acc = accounts.find(a => a.id === t.account_id);
    const accName = acc ? acc.name : "Личный счёт";
    const accType = acc ? acc.type : "PERSONAL";
    csv += `${t.id},"${accName}",${accType},${t.symbol},${t.type},${t.size},${t.leverage},${t.commission},${t.entryPrice},${t.exitPrice},${t.pnl},${t.openTime},${t.closeTime}\n`;
  });
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.setAttribute("download", `trade_history_${Date.now()}.csv`);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast("Журнал экспортирован в CSV!", "success");
}

function clearTradeHistory() {
  tradeHistory = [];
  localStorage.removeItem("plbt_trade_history");
  clearDB().catch(e => console.error("Failed to clear IndexedDB:", e));
  updateTradeHistoryUI();
  showToast("История сделок очищена", "success");
}

function initHistoryPanelEvents() {
  const toggleBtn = document.getElementById("toggle-history-btn");
  const closePanelBtn = document.getElementById("close-history-panel-btn");
  const panel = document.getElementById("trade-history-panel");
  const clearBtn = document.getElementById("clear-history-btn");
  const exportBtn = document.getElementById("export-history-btn");

  if (!panel) return;

  // Move panel to body so it isn't clipped by any overflow: hidden parent
  document.body.appendChild(panel);

  // Load saved dimensions/positions
  const savedX = localStorage.getItem("win_x");
  const savedY = localStorage.getItem("win_y");
  const savedW = localStorage.getItem("win_w");
  const savedH = localStorage.getItem("win_h");
  const savedCollapsed = localStorage.getItem("win_collapsed") === "true";
  const savedMaximized = localStorage.getItem("win_maximized") === "true";
  const savedHidden = localStorage.getItem("win_hidden") !== "false"; // default hidden if not explicitly opened

  // Set and validate loaded positions to prevent off-screen loss and style-stretching conflicts
  let posX = savedX ? parseInt(savedX, 10) : null;
  let posY = savedY ? parseInt(savedY, 10) : null;

  if (posX !== null || posY !== null) {
    const minVisible = 50;
    const isXInvalid = posX !== null && (posX < -800 || posX > window.innerWidth - minVisible);
    const isYInvalid = posY !== null && (posY < 0 || posY > window.innerHeight - minVisible);

    if (isXInvalid || isYInvalid) {
      console.warn("[TradeHistory] Saved coordinates were off-screen. Resetting to default bottom/right style.");
      panel.style.left = "auto";
      panel.style.top = "auto";
      panel.style.right = "20px";
      panel.style.bottom = "40px";
      localStorage.removeItem("win_x");
      localStorage.removeItem("win_y");
    } else {
      if (posX !== null) panel.style.left = posX + "px";
      if (posY !== null) panel.style.top = posY + "px";
      panel.style.bottom = "auto";
      panel.style.right = "auto";
    }
  }

  // Set and validate saved dimensions
  if (savedW) {
    const validW = Math.min(window.innerWidth - 20, Math.max(600, parseInt(savedW, 10)));
    panel.style.width = validW + "px";
  }
  if (savedH) {
    const validH = Math.min(window.innerHeight - 20, Math.max(300, parseInt(savedH, 10)));
    panel.style.height = validH + "px";
  }

  // Explicitly apply/remove collapsed class to prevent HTML-statically inherited desync
  if (savedCollapsed) {
    panel.classList.add("collapsed");
  } else {
    panel.classList.remove("collapsed");
  }

  if (savedMaximized) {
    panel.classList.add("maximized");
  } else {
    panel.classList.remove("maximized");
  }

  // Unified function to change panel visibility and keep everything perfectly synced
  function setPanelVisibility(visible) {
    if (visible) {
      panel.style.display = "flex";
      // Clicking the toggle button to open the panel always uncollapses it so it is fully visible
      panel.classList.remove("collapsed");
      localStorage.setItem("win_hidden", "false");
      localStorage.setItem("win_collapsed", "false");
      if (toggleBtn) {
        toggleBtn.style.background = "rgba(75, 85, 99, 0.35)";
        toggleBtn.style.borderColor = "var(--color-accent)";
      }
      if (isAnalyticsActive) {
        setTimeout(drawPnLEquityChart, 50);
      }
    } else {
      panel.style.display = "none";
      localStorage.setItem("win_hidden", "true");
      if (toggleBtn) {
        toggleBtn.style.background = "rgba(75, 85, 99, 0.2)";
        toggleBtn.style.borderColor = "rgba(75, 85, 99, 0.45)";
      }
    }
  }

  // Expose toggle function globally to allow bulletproof access from anywhere (and inline listeners if needed)
  window.toggleTradeHistoryPanel = function(forceState) {
    if (!panel) return;
    
    // Check if the panel is currently visually closed (either hidden completely or collapsed with 0px height)
    const isCurrentlyHidden = panel.style.display === "none" || panel.style.display === "";
    const isCurrentlyCollapsed = panel.classList.contains("collapsed");
    
    let targetVisible;
    if (typeof forceState === "boolean") {
      targetVisible = forceState;
    } else {
      targetVisible = (isCurrentlyHidden || isCurrentlyCollapsed);
    }
    
    setPanelVisibility(targetVisible);
    console.log(`[TradeHistory] Toggled panel. Visible: ${targetVisible}, collapsed class removed.`);
  };

  // Initial state display setup
  if (savedHidden) {
    setPanelVisibility(false);
  } else {
    setPanelVisibility(true);
    // Overwrite the setPanelVisibility call side-effect of setting win_collapsed to false if it was saved as collapsed
    if (savedCollapsed) {
      panel.classList.add("collapsed");
      localStorage.setItem("win_collapsed", "true");
    }
  }

  // Toggle Button (from footer) - safeguarded against double-binding in Live Server environments
  if (toggleBtn && !toggleBtn._hasHistoryListener) {
    toggleBtn._hasHistoryListener = true;
    toggleBtn.addEventListener("click", () => {
      window.toggleTradeHistoryPanel();
    });
  }

  // Close Button (header control) - safeguarded against double-binding
  if (closePanelBtn && !closePanelBtn._hasHistoryListener) {
    closePanelBtn._hasHistoryListener = true;
    closePanelBtn.addEventListener("click", () => {
      window.toggleTradeHistoryPanel(false);
    });
  }

  // Minimize Button - safeguarded against double-binding
  const minimizeBtn = document.getElementById("win-minimize-btn");
  if (minimizeBtn && !minimizeBtn._hasHistoryListener) {
    minimizeBtn._hasHistoryListener = true;
    minimizeBtn.addEventListener("click", () => {
      panel.classList.toggle("collapsed");
      const isCollapsed = panel.classList.contains("collapsed");
      localStorage.setItem("win_collapsed", isCollapsed);
      if (!isCollapsed && isAnalyticsActive) {
        setTimeout(drawPnLEquityChart, 50);
      }
    });
  }

  // Maximize Button - safeguarded against double-binding
  const maximizeBtn = document.getElementById("win-maximize-btn");
  if (maximizeBtn && !maximizeBtn._hasHistoryListener) {
    maximizeBtn._hasHistoryListener = true;
    maximizeBtn.addEventListener("click", () => {
      panel.classList.toggle("maximized");
      const isMaximized = panel.classList.contains("maximized");
      localStorage.setItem("win_maximized", isMaximized);
      if (isAnalyticsActive) {
        setTimeout(drawPnLEquityChart, 50);
      }
    });
  }

  // Dragging Logic (title bar)
  const dragHandle = document.getElementById("history-panel-drag-handle");
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  dragHandle?.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (
      e.target.closest(".win-control-btn") ||
      e.target.closest(".view-mode-tabs") ||
      e.target.closest(".scenario-tabs-container")
    )
      return;
    if (panel.classList.contains("maximized")) return;

    isDragging = true;
    const rect = panel.getBoundingClientRect();
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;

    document.body.style.userSelect = "none";
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;

    let newX = e.clientX - dragOffsetX;
    let newY = e.clientY - dragOffsetY;

    // Constraint boundaries (allows dragging almost completely off-screen, keeping only 30px of the header/handle visible at bottom or 50px at left/right)
    const minVisibleW = 50;
    const minVisibleH = 30;
    newX = Math.max(
      -panel.offsetWidth + minVisibleW,
      Math.min(window.innerWidth - minVisibleW, newX),
    );
    newY = Math.max(0, Math.min(window.innerHeight - minVisibleH, newY));

    panel.style.left = newX + "px";
    panel.style.top = newY + "px";
    panel.style.bottom = "auto";
    panel.style.right = "auto";

    localStorage.setItem("win_x", newX);
    localStorage.setItem("win_y", newY);
  });

  window.addEventListener("mouseup", () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.userSelect = "";
    }
  });

  // Resizing Logic (multi-direction handles)
  const resizeHandles = panel.querySelectorAll(".win-resize-handle");
  let isResizing = false;
  let resizeDir = "";
  let startRect = {};
  let startMouse = {};

  resizeHandles.forEach((handle) => {
    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (
        panel.classList.contains("maximized") ||
        panel.classList.contains("collapsed")
      )
        return;

      isResizing = true;
      resizeDir = handle.className
        .split(" ")
        .find((c) => c !== "win-resize-handle");
      const rect = panel.getBoundingClientRect();
      startRect = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
      startMouse = {
        x: e.clientX,
        y: e.clientY,
      };

      document.body.style.userSelect = "none";
      document.body.style.cursor = window.getComputedStyle(handle).cursor;
      e.preventDefault();
      e.stopPropagation();
    });
  });

  window.addEventListener("mousemove", (e) => {
    if (!isResizing) return;

    const dx = e.clientX - startMouse.x;
    const dy = e.clientY - startMouse.y;

    let newWidth = startRect.width;
    let newHeight = startRect.height;
    let newLeft = startRect.left;
    let newTop = startRect.top;

    const minW = 600;
    const minH = 300;

    if (resizeDir.includes("e")) {
      newWidth = Math.max(minW, startRect.width + dx);
    }
    if (resizeDir.includes("s")) {
      newHeight = Math.max(minH, startRect.height + dy);
    }
    if (resizeDir.includes("w")) {
      const potentialWidth = startRect.width - dx;
      if (potentialWidth >= minW) {
        newWidth = potentialWidth;
        newLeft = startRect.left + dx;
      }
    }
    if (resizeDir.includes("n")) {
      const potentialHeight = startRect.height - dy;
      if (potentialHeight >= minH) {
        newHeight = potentialHeight;
        newTop = startRect.top + dy;
      }
    }

    panel.style.width = newWidth + "px";
    panel.style.height = newHeight + "px";
    panel.style.left = newLeft + "px";
    panel.style.top = newTop + "px";
    panel.style.bottom = "auto";
    panel.style.right = "auto";

    localStorage.setItem("win_w", newWidth);
    localStorage.setItem("win_h", newHeight);
    localStorage.setItem("win_x", newLeft);
    localStorage.setItem("win_y", newTop);
  });

  window.addEventListener("mouseup", () => {
    if (isResizing) {
      isResizing = false;
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      if (isAnalyticsActive) {
        drawPnLEquityChart();
      }
    }
  });

  clearBtn?.addEventListener("click", clearTradeHistory);
  exportBtn?.addEventListener("click", exportTradeHistoryCSV);

  // Date and reason filters event handling
  const periodButtons = document.querySelectorAll(".filter-period-btn");
  const exactDateInput = document.getElementById("filter-exact-date");
  const startDateInput = document.getElementById("filter-start-date");
  const endDateInput = document.getElementById("filter-end-date");
  const resetFiltersBtn = document.getElementById("reset-filters-btn");
  const reasonSelect = document.getElementById("filter-close-reason-select");
  const resetReasonBtn = document.getElementById("reset-close-reason-btn");

  reasonSelect?.addEventListener("change", (e) => {
    currentCloseReasonFilter = e.target.value;
    updateCloseReasonFilterVisuals();
    updateTradeHistoryUI();
  });

  resetReasonBtn?.addEventListener("click", () => {
    currentCloseReasonFilter = "ALL";
    if (reasonSelect) reasonSelect.value = "ALL";
    updateCloseReasonFilterVisuals();
    updateTradeHistoryUI();
  });

  periodButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      periodButtons.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      currentHistoryFilter.period = btn.getAttribute("data-period") || "all";
      currentHistoryFilter.exactDate = "";
      currentHistoryFilter.startDate = "";
      currentHistoryFilter.endDate = "";

      if (exactDateInput) exactDateInput.value = "";
      if (startDateInput) startDateInput.value = "";
      if (endDateInput) endDateInput.value = "";

      updateTradeHistoryUI();
    });
  });

  exactDateInput?.addEventListener("change", () => {
    periodButtons.forEach((b) => b.classList.remove("active"));

    currentHistoryFilter.exactDate = exactDateInput.value;
    currentHistoryFilter.period = "all";
    currentHistoryFilter.startDate = "";
    currentHistoryFilter.endDate = "";

    if (startDateInput) startDateInput.value = "";
    if (endDateInput) endDateInput.value = "";

    updateTradeHistoryUI();
  });

  const handleRangeChange = () => {
    periodButtons.forEach((b) => b.classList.remove("active"));

    currentHistoryFilter.startDate = startDateInput ? startDateInput.value : "";
    currentHistoryFilter.endDate = endDateInput ? endDateInput.value : "";
    currentHistoryFilter.period = "all";
    currentHistoryFilter.exactDate = "";

    if (exactDateInput) exactDateInput.value = "";

    updateTradeHistoryUI();
  };

  startDateInput?.addEventListener("change", handleRangeChange);
  endDateInput?.addEventListener("change", handleRangeChange);

  resetFiltersBtn?.addEventListener("click", () => {
    periodButtons.forEach((b) => b.classList.remove("active"));
    const allBtn = document.querySelector(
      '.filter-period-btn[data-period="all"]',
    );
    if (allBtn) allBtn.classList.add("active");

    currentHistoryFilter = {
      period: "all",
      exactDate: "",
      startDate: "",
      endDate: "",
    };

    currentCloseReasonFilter = "ALL";
    if (reasonSelect) reasonSelect.value = "ALL";
    updateCloseReasonFilterVisuals();

    if (exactDateInput) exactDateInput.value = "";
    if (startDateInput) startDateInput.value = "";
    if (endDateInput) endDateInput.value = "";

    updateTradeHistoryUI();
  });
}

/**
 * Вспомогательная функция для нормализации недельных свечей строго к понедельнику 00:00:00 UTC
 */
function normalizeWeeklyCandleTime(candleTime) {
  const d = new Date(Number(candleTime) * 1000);
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  if (day === 0) {
    // Воскресенье (MT5 W1 свечи со штампом вск) -> понедельник торговой недели
    d.setUTCDate(d.getUTCDate() + 1);
  } else if (day > 1) {
    d.setUTCDate(d.getUTCDate() - (day - 1));
  }
  return Math.floor(d.getTime() / 1000);
}

/**
 * Вспомогательная функция для округления времени свечи до кратного целевому таймфрейму (в минутах)
 * с учетом локального часового пояса (чтобы свечи совпадали с MT5 / локальным временем).
 */
function getBucketTime(candleTime, targetTimeframeMinutes, useUTC = true) {
  // В JS getTimezoneOffset() возвращает разницу в минутах (UTC - Local).
  // Нам нужно противоположное значение для смещения от UTC, например, +180 для GMT+3.
  const localOffsetMinutes = useUTC ? 0 : -new Date(candleTime * 1000).getTimezoneOffset();
  const offsetSeconds = localOffsetMinutes * 60;
  
  // Корректируем UTC время на смещение, чтобы округление/группировка шли по локальным суткам/неделям/месяцам
  const adjustedTime = candleTime + offsetSeconds;

  // 1 День (1D / 1440 мин)
  if (targetTimeframeMinutes === 1440) {
    const d = new Date(adjustedTime * 1000);
    d.setUTCHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000) - offsetSeconds;
  }
  
  // 1 Неделя (1W / 10080 мин) - строго понедельник 00:00:00 UTC
  if (targetTimeframeMinutes === 10080) {
    return normalizeWeeklyCandleTime(candleTime);
  }
  
  // 1 Месяц (1M / 43200 мин)
  if (targetTimeframeMinutes === 43200) {
    const d = new Date(adjustedTime * 1000);
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000) - offsetSeconds;
  }
  
  // 1 Год (12M / >= 518400 мин)
  if (targetTimeframeMinutes >= 518400) {
    const d = new Date(adjustedTime * 1000);
    d.setUTCMonth(0, 1);
    d.setUTCHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000) - offsetSeconds;
  }

  const timeframeSeconds = targetTimeframeMinutes * 60;
  const roundedAdjusted = Math.floor(adjustedTime / timeframeSeconds) * timeframeSeconds;
  
  // Возвращаем скорректированное обратно в UTC время
  return roundedAdjusted - offsetSeconds;
}

let aggregationCache = {
  baseCandles: null,
  targetTimeframeMinutes: null,
  baseCandlesLength: 0,
  fullAggregated: [],
  bucketMap: new Map(),
  bucketKeys: []
};

let aggregationSliceCache = {
  baseCandles: null,
  targetTimeframeMinutes: null,
  pivotIndex: -1,
  completedCandles: [],
  resultArray: [],
  formingCandle: null
};

function rebuildAggregationCache(baseCandles, targetTimeframeMinutes) {
  const bucketMap = new Map();
  const bucketKeys = [];

  for (let i = 0; i < baseCandles.length; i++) {
    const c = baseCandles[i];
    if (!c || c.time === undefined || c.time === null || isNaN(c.time)) continue;
    const bTime = getBucketTime(Number(c.time), targetTimeframeMinutes);
    let arr = bucketMap.get(bTime);
    if (!arr) {
      arr = [];
      bucketMap.set(bTime, arr);
      bucketKeys.push(bTime);
    }
    arr.push(c);
  }

  bucketKeys.sort((a, b) => a - b);

  const fullAggregated = [];
  for (let i = 0; i < bucketKeys.length; i++) {
    const bTime = bucketKeys[i];
    const candlesInBucket = bucketMap.get(bTime);
    if (!candlesInBucket || candlesInBucket.length === 0) continue;

    candlesInBucket.sort((a, b) => Number(a.time) - Number(b.time));

    const first = candlesInBucket[0];
    const last = candlesInBucket[candlesInBucket.length - 1];

    let high = -Infinity;
    let low = Infinity;
    let volume = 0;

    for (let j = 0; j < candlesInBucket.length; j++) {
      const cb = candlesInBucket[j];
      const h = Number(cb.high);
      const l = Number(cb.low);
      if (!isNaN(h) && h > high) high = h;
      if (!isNaN(l) && l < low) low = l;
      if (cb.volume !== undefined && cb.volume !== null && !isNaN(cb.volume)) {
        volume += cb.volume;
      }
    }

    const openVal = Number(first.open);
    const closeVal = Number(last.close);

    if (high === -Infinity || isNaN(high)) high = Math.max(openVal, closeVal);
    else high = Math.max(high, openVal, closeVal);

    if (low === Infinity || isNaN(low)) low = Math.min(openVal, closeVal);
    else low = Math.min(low, openVal, closeVal);

    // Для всех агрегированных периодов (включая 1W) используем каноническое время начала бакета bTime (понедельник 00:00:00 UTC)
    const candleTimestamp = Number(bTime);

    fullAggregated.push({
      time: candleTimestamp,
      open: parseFloat(openVal.toFixed(5)),
      high: parseFloat(high.toFixed(5)),
      low: parseFloat(low.toFixed(5)),
      close: parseFloat(closeVal.toFixed(5)),
      volume: volume
    });
  }

  // Сортировка и дедупликация: гарантируем строго возрастающие уникальные timestamps без слипшихся баров
  fullAggregated.sort((a, b) => a.time - b.time);
  const cleanAggregated = [];
  for (let i = 0; i < fullAggregated.length; i++) {
    const item = fullAggregated[i];
    if (cleanAggregated.length === 0) {
      cleanAggregated.push(item);
    } else {
      const prev = cleanAggregated[cleanAggregated.length - 1];
      if (item.time > prev.time) {
        cleanAggregated.push(item);
      } else if (item.time === prev.time) {
        // Объединяем совпадающие бары (если возникли на границе бакета)
        prev.high = Math.max(prev.high, item.high);
        prev.low = Math.min(prev.low, item.low);
        prev.close = item.close;
        prev.volume = (prev.volume || 0) + (item.volume || 0);
      }
    }
  }

  aggregationCache = {
    baseCandles: baseCandles,
    targetTimeframeMinutes: targetTimeframeMinutes,
    baseCandlesLength: baseCandles.length,
    fullAggregated: cleanAggregated,
    bucketMap: bucketMap,
    bucketKeys: bucketKeys
  };
}

/**
 * Агрегирует базовые свечи (например, 15m) в более старший таймфрейм (например, 30m, 1h, 4h, 1d)
 * на лету прямо в браузере, ограничивая исторические данные текущей точкой воспроизведения бэктеста.
 * 
 * @param {Array} baseCandles - Массив базовых свечей (например, 15m)
 * @param {number} targetTimeframeMinutes - Целевой таймфрейм в минутах (30, 60, 240, 1440 и т.д.)
 * @param {number} currentReplayTimestamp - Текущая временная метка бэктеста (Unix timestamp в секундах)
 * @returns {Array} Агрегированные свечи старшего таймфрейма
 */
function aggregateCandles(baseCandles, targetTimeframeMinutes, currentReplayTimestamp) {
  if (!baseCandles || baseCandles.length === 0) return [];

  // Определяем текущую позицию воспроизведения бэктеста или плеера
  let replayTimestamp = currentReplayTimestamp;
  if (replayTimestamp === undefined || replayTimestamp === null) {
    if (state.isBacktestActive && state.currentReplayTimestamp) {
      replayTimestamp = state.currentReplayTimestamp;
    } else if (baseCandles.length > 0) {
      // В режиме реального времени: текущая позиция плеера = самая последняя загруженная свеча
      replayTimestamp = baseCandles[baseCandles.length - 1].time;
    }
  }

  const replayTimeNum = Number(replayTimestamp);
  if (isNaN(replayTimeNum)) {
    if (
      aggregationCache.baseCandles !== baseCandles ||
      aggregationCache.targetTimeframeMinutes !== targetTimeframeMinutes ||
      aggregationCache.baseCandlesLength !== baseCandles.length
    ) {
      rebuildAggregationCache(baseCandles, targetTimeframeMinutes);
    }
    return aggregationCache.fullAggregated;
  }

  // Перестраиваем кэш, если изменился исходный массив или настройки
  if (
    aggregationCache.baseCandles !== baseCandles ||
    aggregationCache.targetTimeframeMinutes !== targetTimeframeMinutes ||
    aggregationCache.baseCandlesLength !== baseCandles.length
  ) {
    rebuildAggregationCache(baseCandles, targetTimeframeMinutes);
  }

  const currentBucketTime = getBucketTime(replayTimeNum, targetTimeframeMinutes);

  // С помощью бинарного поиска находим индекс текущего бакета во всех доступных ключах
  const keys = aggregationCache.bucketKeys;
  let left = 0;
  let right = keys.length - 1;
  let pivotIndex = -1;

  while (left <= right) {
    const mid = (left + right) >> 1;
    if (keys[mid] === currentBucketTime) {
      pivotIndex = mid;
      break;
    } else if (keys[mid] < currentBucketTime) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  if (pivotIndex === -1) {
    pivotIndex = left;
  }

  // Срежем все полностью завершенные свечи старшего ТФ с использованием кэша срезов
  if (
    aggregationSliceCache.baseCandles !== baseCandles ||
    aggregationSliceCache.targetTimeframeMinutes !== targetTimeframeMinutes ||
    aggregationSliceCache.pivotIndex !== pivotIndex
  ) {
    const completed = aggregationCache.fullAggregated.slice(0, pivotIndex);
    aggregationSliceCache = {
      baseCandles: baseCandles,
      targetTimeframeMinutes: targetTimeframeMinutes,
      pivotIndex: pivotIndex,
      completedCandles: completed,
      resultArray: [...completed],
      formingCandle: null
    };
  } else {
    // Сбросим длину до завершенных свечей, чтобы убрать старую формирующуюся свечу
    aggregationSliceCache.resultArray.length = aggregationSliceCache.completedCandles.length;
  }

  const result = aggregationSliceCache.resultArray;

  // Добавим и агрегируем только ту свечу, которая формируется в данный момент
  const candlesInBucket = aggregationCache.bucketMap.get(currentBucketTime);
  if (candlesInBucket && candlesInBucket.length > 0) {
    let first = null;
    let last = null;
    let high = -Infinity;
    let low = Infinity;
    let volume = 0;
    let count = 0;

    for (let j = 0; j < candlesInBucket.length; j++) {
      const cb = candlesInBucket[j];
      if (Number(cb.time) <= replayTimeNum) {
        if (first === null) first = cb;
        last = cb;
        if (cb.high > high) high = cb.high;
        if (cb.low < low) low = cb.low;
        if (cb.volume !== undefined && cb.volume !== null) {
          volume += cb.volume;
        }
        count++;
      }
    }

    if (count > 0) {
      const openVal = Number(first.open);
      const closeVal = Number(last.close);
      const finalHigh = Math.max(high, openVal, closeVal);
      const finalLow = Math.min(low, openVal, closeVal);

      const fc = {
        time: currentBucketTime,
        open: parseFloat(openVal.toFixed(5)),
        high: parseFloat(finalHigh.toFixed(5)),
        low: parseFloat(finalLow.toFixed(5)),
        close: parseFloat(closeVal.toFixed(5)),
        volume: volume
      };
      result.push(fc);
    }
  }

  return result;
}

function timeframeToMinutes(tf) {
  if (!tf) return 15;
  const normalized = tf.toUpperCase();
  if (normalized === "1D" || normalized === "D1") return 1440;
  if (normalized === "1W" || normalized === "W1") return 10080;
  if (normalized === "1M" || normalized === "MN") return 43200;
  if (normalized === "12M") return 525600;

  const match = tf.match(/^(\d+)([mhdMwW])$/);
  if (!match) {
    return 15;
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === "m") return value;
  if (unit === "M") return value * 43200;
  if (unit.toLowerCase() === "h") return value * 60;
  if (unit.toLowerCase() === "d") return value * 1440;
  if (unit.toLowerCase() === "w") return value * 10080;
  return value;
}

function updateBacktestVisibleCandles() {
  if (!state.isBacktestActive || !state.currentReplayTimestamp) return;
  const tfMinutes = timeframeToMinutes(state.timeframe);
  const baseCandles = state.backtestBaseCandles || state.historicalCandles;
  
  state.backtestVisibleCandles = aggregateCandles(
    baseCandles,
    tfMinutes,
    state.currentReplayTimestamp
  );
  
  // Синхронизируем старые переменные состояния
  state.currentReplayIndex = state.backtestVisibleCandles.length - 1;
  window.currentReplayIndex = state.currentReplayIndex;
}

function filterWeekendCandles(candles, symbol) {
  if (!candles || candles.length === 0) return [];
  
  // Clean, sanitize, ensure seconds timestamp and valid numeric values
  const validCandles = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c || c.time === undefined || c.time === null) continue;
    let t = Number(c.time);
    if (isNaN(t)) continue;
    if (t > 1e11) { // If timestamp is in milliseconds instead of seconds
      t = Math.floor(t / 1000);
    }
    const o = Number(c.open);
    const h = Number(c.high);
    const l = Number(c.low);
    const cl = Number(c.close);
    if (isNaN(o) || isNaN(h) || isNaN(l) || isNaN(cl)) continue;
    
    // Ensure logical high and low
    const trueHigh = Math.max(h, o, cl);
    const trueLow = Math.min(l, o, cl);
    
    validCandles.push({
      time: t,
      open: o,
      high: trueHigh,
      low: trueLow,
      close: cl,
      volume: Number(c.volume || c.tick_volume || 0)
    });
  }
  
  if (validCandles.length === 0) return [];

  // Sort strictly ascending by time
  validCandles.sort((a, b) => a.time - b.time);

  // Remove duplicates or non-strictly increasing timestamps
  const deduped = [];
  for (let i = 0; i < validCandles.length; i++) {
    const item = validCandles[i];
    if (deduped.length === 0) {
      deduped.push(item);
    } else {
      const prev = deduped[deduped.length - 1];
      if (item.time === prev.time) {
        deduped[deduped.length - 1] = item; // Keep latest
      } else if (item.time > prev.time) {
        deduped.push(item);
      }
    }
  }

  const s = (symbol || state.symbol || "").toUpperCase();
  const isCrypto = ["BTC", "ETH", "SOL", "XRP"].some((crypto) =>
    s.includes(crypto),
  );
  if (isCrypto) return deduped;

  const tfMinutes = timeframeToMinutes(state.timeframe);
  if (tfMinutes === 10080) {
    // 1W: Гарантируем, что недельные бары (включая MT5 со штампом вск) строго выровнены на понедельник 00:00:00 UTC
    const weeklyMap = new Map();
    for (let i = 0; i < deduped.length; i++) {
      const item = deduped[i];
      const normTime = normalizeWeeklyCandleTime(item.time);
      if (!weeklyMap.has(normTime)) {
        weeklyMap.set(normTime, {
          time: normTime,
          open: item.open,
          high: item.high,
          low: item.low,
          close: item.close,
          volume: item.volume || 0
        });
      } else {
        const existing = weeklyMap.get(normTime);
        existing.high = Math.max(existing.high, item.high);
        existing.low = Math.min(existing.low, item.low);
        existing.close = item.close;
        existing.volume = (existing.volume || 0) + (item.volume || 0);
      }
    }
    return Array.from(weeklyMap.values()).sort((a, b) => a.time - b.time);
  }
  if (tfMinutes > 10080) {
    return deduped; // Monthly
  }

  return deduped.filter((candle) => {
    const date = new Date(candle.time * 1000);
    const day = date.getUTCDay();
    return day !== 0 && day !== 6;
  });
}

function generateDemoCandles(count = 250, endDate = new Date()) {
  const data = [];
  let currentPrice = getSymbolInitialPrice(state.symbol);
  const tfMinutes = timeframeToMinutes(state.timeframe);
  const isCrypto = ["BTC", "ETH", "SOL", "XRP"].some(c => (state.symbol || "").toUpperCase().includes(c));
  const skipWeekend = !isCrypto && tfMinutes < 10080;
  const tfSec = tfMinutes * 60;

  let curTime = new Date(endDate.getTime());
  // If weekend and forex/commodity, roll back to Friday 21:00 UTC
  if (skipWeekend) {
    const day = curTime.getUTCDay();
    if (day === 6) { // Saturday
      curTime.setUTCDate(curTime.getUTCDate() - 1);
      curTime.setUTCHours(21, 0, 0, 0);
    } else if (day === 0) { // Sunday
      curTime.setUTCDate(curTime.getUTCDate() - 2);
      curTime.setUTCHours(21, 0, 0, 0);
    }
  }

  // Align to timeframe boundary
  let curTimestamp = Math.floor(curTime.getTime() / 1000);
  if (tfMinutes === 10080) {
    // 1W: Align strictly to Monday 00:00:00 UTC
    const d = new Date(curTimestamp * 1000);
    d.setUTCHours(0, 0, 0, 0);
    const day = d.getUTCDay();
    const diffDays = (day + 6) % 7; // Monday = 0, Tuesday = 1, ..., Sunday = 6
    d.setUTCDate(d.getUTCDate() - diffDays);
    curTimestamp = Math.floor(d.getTime() / 1000);
  } else if (tfMinutes === 43200) {
    // 1M: Align to 1st day of month 00:00:00 UTC
    const d = new Date(curTimestamp * 1000);
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    curTimestamp = Math.floor(d.getTime() / 1000);
  } else if (tfMinutes === 1440) {
    // 1D: Align to 00:00:00 UTC
    const d = new Date(curTimestamp * 1000);
    d.setUTCHours(0, 0, 0, 0);
    curTimestamp = Math.floor(d.getTime() / 1000);
  } else {
    curTimestamp = Math.floor(curTimestamp / tfSec) * tfSec;
  }

  const timestamps = [];
  let t = curTimestamp;
  let safetyLoop = 0;

  if (tfMinutes === 43200) {
    let mDate = new Date(curTimestamp * 1000);
    while (timestamps.length < count && safetyLoop < count * 5) {
      safetyLoop++;
      timestamps.push(Math.floor(mDate.getTime() / 1000));
      mDate.setUTCMonth(mDate.getUTCMonth() - 1);
    }
  } else if (tfMinutes === 10080) {
    const weekSec = 7 * 86400;
    while (timestamps.length < count && safetyLoop < count * 5) {
      safetyLoop++;
      timestamps.push(t);
      t -= weekSec;
    }
  } else {
    while (timestamps.length < count && safetyLoop < count * 5) {
      safetyLoop++;
      const d = new Date(t * 1000);
      const day = d.getUTCDay();
      if (skipWeekend && (day === 0 || day === 6)) {
        t -= tfSec;
        continue;
      }
      timestamps.push(t);
      t -= tfSec;
    }
  }
  timestamps.reverse();

  const volatility = getSymbolVolatility(state.symbol);
  const decimals = getSymbolDecimals(state.symbol);

  for (let i = 0; i < timestamps.length; i++) {
    const candleTime = timestamps[i];
    const change = (Math.random() - 0.495) * volatility * currentPrice;
    const open = currentPrice;
    const close = currentPrice + change;
    const high =
      Math.max(open, close) + Math.random() * volatility * 0.5 * currentPrice;
    const low =
      Math.min(open, close) - Math.random() * volatility * 0.5 * currentPrice;
    data.push({
      time: candleTime,
      open: parseFloat(open.toFixed(decimals)),
      high: parseFloat(high.toFixed(decimals)),
      low: parseFloat(low.toFixed(decimals)),
      close: parseFloat(close.toFixed(decimals)),
      volume: Math.floor(Math.random() * 500 + 50)
    });
    currentPrice = close;
  }
  return data;
}

function loadDemoData() {
  if (state.isBacktestActive) return;
  state.isFileLoaded = false;
  if (typeof candlestickSeries !== "undefined" && candlestickSeries) {
    candlestickSeries.setData([]);
  }
  updateChartPrecision(state.symbol);
  updateHeaderPairDisplay(state.symbol);

  updateConnectionStatus("Демо-Режим (Оффлайн)", "demo");
  window.showBannerNotification(
    "<strong>Режим симуляции.</strong> Нажмите «Загрузить историю» для подключения к реальному потоку, либо проводите тест на демо-данных.",
    10,
  );
  const badge = document.getElementById("instrument-exchange");
  if (badge) badge.textContent = "Демо-Данные";
  const demo = generateDemoCandles(250);
  const filteredDemo = filterWeekendCandles(demo, state.symbol);
  state.historicalCandles = filteredDemo;
  state.loadedCandlesSymbol = state.symbol;
  candlestickSeries.setData(filteredDemo);
  updateLegend(filteredDemo[filteredDemo.length - 1]);
  if (typeof updateCOTChartData === "function" && typeof cotChartState !== "undefined" && cotChartState.active) {
    updateCOTChartData();
  }
  if (dbLatency) dbLatency.textContent = "—";
  setTimeout(() => {
    loadingOverlay.classList.add("hidden");
    drawAllOnCanvas();
    recenterView();
  }, 500);
}

async function fetchTwelveDataHistory(symbol, timeframe) {
  const key = getActiveApiKey();
  if (!key) throw new Error("Ключ Twelve Data не найден");
  const fmtSymbol = symbol.replace("_", "/");
  const fmtInterval = TIMEFRAME_MAPPING[timeframe] || "15min";
  let url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(fmtSymbol)}&interval=${fmtInterval}&outputsize=2000&apikey=${key}`;
  if (useProxyCheckbox.checked) {
    url = `https://corsproxy.io/?${encodeURIComponent(url)}`;
  }
  const start = performance.now();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Ошибка Twelve Data: ${res.status}`);
  }
  const data = await res.json();
  if (!data || data.status === "error" || !data.values) {
    throw new Error(data ? data.message : "Неверный ответ от API");
  }
  if (dbLatency)
    dbLatency.textContent = `${Math.round(performance.now() - start)}ms`;
  const parsed = data.values
    .map((item) => ({
      time: Math.floor(new Date(item.datetime).getTime() / 1000),
      open: parseFloat(item.open),
      high: parseFloat(item.high),
      low: parseFloat(item.low),
      close: parseFloat(item.close),
    }))
    .filter((item) => !isNaN(item.time) && !isNaN(item.open));
  parsed.sort((a, b) => a.time - b.time);
  return parsed;
}

async function loadMarketData() {
  if (state.isBacktestActive) return;
  state.isFileLoaded = false;
  if (typeof candlestickSeries !== "undefined" && candlestickSeries) {
    candlestickSeries.setData([]);
  }
  updateChartPrecision(state.symbol);
  updateHeaderPairDisplay(state.symbol);

  loadingOverlay.classList.remove("hidden");
  let pName = "Twelve Data";
  loadingStatus.textContent = `Загрузка котировок ${pName} для ${state.symbol.replace("_", "/")}...`;
  updateConnectionStatus("Подключение...", "");
  try {
    let candles = await fetchTwelveDataHistory(state.symbol, state.timeframe);
    if (!candles || candles.length === 0) throw new Error("Свечи не найдены");
    const filteredCandles = filterWeekendCandles(candles, state.symbol);
    state.historicalCandles = filteredCandles;
    state.loadedCandlesSymbol = state.symbol;
    candlestickSeries.setData(filteredCandles);
    updateLegend(filteredCandles[filteredCandles.length - 1]);
    if (typeof updateCOTChartData === "function" && typeof cotChartState !== "undefined" && cotChartState.active) {
      updateCOTChartData();
    }
    window.closeBanner();
    updateConnectionStatus("ONLINE", "active");
    const b = document.getElementById("instrument-exchange");
    if (b) b.textContent = pName;
    loadingOverlay.classList.add("hidden");
    showToast("Котировки успешно загружены!", "success");
    drawAllOnCanvas();
    recenterView();
  } catch (e) {
    console.warn(e);
    updateConnectionStatus("Ошибка API", "demo");
    window.showBannerNotification(`<strong>Ошибка:</strong> ${e.message}`, 10);
    loadDemoData();
  }
}

function formatSyncRemainingTime(remainingSeconds) {
  const totalSec = Math.max(0, Math.round(remainingSeconds));
  if (totalSec >= 60) {
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    if (secs > 0) {
      return `Осталось примерно ~${mins}м ${secs}с`;
    }
    return `Осталось примерно ~${mins}м`;
  }
  return `Осталось примерно ~${totalSec}с`;
}

let activeMT5SyncCancel = null;

async function loadMT5Data() {
  if (state.isBacktestActive) return;
  state.isFileLoaded = false;
  if (typeof candlestickSeries !== "undefined" && candlestickSeries) {
    candlestickSeries.setData([]);
  }
  updateChartPrecision(state.symbol);
  updateHeaderPairDisplay(state.symbol);

  // If there's an ongoing sync, cancel it before starting new one
  if (typeof activeMT5SyncCancel === "function") {
    activeMT5SyncCancel();
    activeMT5SyncCancel = null;
  }

  const cleanSymbol = state.symbol.replace("_", "");
  const formattedSymbol = state.symbol.replace("_", "/");
  const tf = state.timeframe;
  const presetSelect = document.getElementById("history-preset-select");
  const count = presetSelect ? parseInt(presetSelect.value, 10) : 150000;
  console.log("[BARS DEBUG] Selected count:", count, typeof count);

  updateConnectionStatus("Подключение к MT5...", "demo");
  const badge = document.getElementById("instrument-exchange");
  if (badge) badge.textContent = "MT5 Terminal";

  // Check one-time sync status from localStorage
  const syncStorageKey = `mt5_synced_${state.symbol}_${tf}`;
  const rawSaved = localStorage.getItem(syncStorageKey);
  const savedSyncedCount = parseInt(rawSaved || "0", 10);
  const isAlreadySynced = savedSyncedCount >= count && savedSyncedCount > 0;
  console.log(`[MT5 Cache Check] Key: "${syncStorageKey}", Read value from localStorage: "${rawSaved}" (parsed: ${savedSyncedCount}), Requested count: ${count}`);

  // 1. FAST PATH: Already synced for this symbol and timeframe with >= target count
  if (isAlreadySynced) {
    console.log(`[MT5 Cache Hit] Symbol ${state.symbol} (${tf}) is already synced (${savedSyncedCount} >= ${count}). Skipping sync modal and fetching directly...`);
    loadingOverlay.classList.remove("hidden");
    loadingStatus.textContent = `Загрузка котировок MT5 для ${formattedSymbol}...`;

    try {
      const url = `http://127.0.0.1:8000/history?symbol=${cleanSymbol}&timeframe=${tf}&count=${count}`;
      const res = await fetch(url);
      const data = await res.json();

      if (data && data.status === "ok" && data.candles && data.candles.length > 0) {
        const candles = data.candles;
        const filteredCandles = filterWeekendCandles(candles, state.symbol);

        if (!filteredCandles || filteredCandles.length === 0) {
          throw new Error("MT5 не вернул данные по этому запросу (все бары отфильтрованы или пустые)");
        }

        state.historicalCandles = filteredCandles;
        state.loadedCandlesSymbol = state.symbol;

        candlestickSeries.setData(filteredCandles);
        updateLegend(filteredCandles[filteredCandles.length - 1]);
        if (typeof updateCOTChartData === "function" && typeof cotChartState !== "undefined" && cotChartState.active) {
          updateCOTChartData();
        }

        updateConnectionStatus("ONLINE (MT5)", "active");
        if (dbLatency) dbLatency.textContent = "MT5 Bridge";
        loadingOverlay.classList.add("hidden");

        showToast(`Загружено ${candles.length.toLocaleString()} баров (${formattedSymbol})`, "success");
        drawAllOnCanvas();
        recenterView();
        return;
      } else {
        const failMsg = (data && data.message) ? data.message : "MT5 не вернул данные по этому запросу";
        throw new Error(failMsg);
      }
    } catch (err) {
      console.warn("MT5 direct history loading failed:", err);
      updateConnectionStatus("Ожидание MT5...", "demo");
      loadingOverlay.classList.add("hidden");
      const errMsg = err.message || "";
      if (errMsg.includes("Symbol") && (errMsg.includes("not found") || errMsg.includes("не найден"))) {
        showToast("Ошибка: Символ не найден в MT5!", "error");
        if (window.showBannerNotification) {
          window.showBannerNotification(`<strong>Ошибка:</strong> Символ <strong>${cleanSymbol}</strong> не найден в MT5. Убедитесь, что этот символ добавлен в Обзор рынка (Market Watch) вашего терминала MetaTrader 5.`, 15);
        }
      } else {
        showToast(`Ошибка загрузки: ${errMsg}`, "error");
      }
      return;
    }
  }

  // 2. SYNC PATH: First run or requested count exceeds previously synced count
  const progressModal = document.getElementById("modal-history-progress");
  const progressCloseBtn = document.getElementById("history-progress-close-btn");
  const progressCancelBtn = document.getElementById("history-progress-cancel-btn");
  const progressBgBtn = document.getElementById("history-progress-bg-btn");

  const progressSymbolEl = document.getElementById("history-progress-symbol");
  const progressBarsTextEl = document.getElementById("history-progress-bars-text");
  const progressPercentEl = document.getElementById("history-progress-percent");
  const progressBarFillEl = document.getElementById("history-progress-bar-fill");
  const progressStatusMsgEl = document.getElementById("history-progress-status-msg");
  const progressStatusBadgeEl = document.getElementById("history-progress-status-badge");
  const progressEtaTextEl = document.getElementById("history-progress-eta-text");

  // Background floating badge elements
  const bgBadgeEl = document.getElementById("history-progress-bg-badge");
  const bgBadgePercentEl = document.getElementById("bg-badge-percent");
  const bgBadgeCountsEl = document.getElementById("bg-badge-counts");
  const bgBadgeProgressFillEl = document.getElementById("bg-badge-progress-fill");
  const bgBadgeOpenBtn = document.getElementById("bg-badge-open-btn");

  const initialPct = savedSyncedCount > 0 ? Math.min(100, Math.round((savedSyncedCount / count) * 100)) : 0;
  if (progressSymbolEl) progressSymbolEl.textContent = formattedSymbol;
  if (progressBarsTextEl) progressBarsTextEl.textContent = `Загружено ${savedSyncedCount > 0 ? savedSyncedCount.toLocaleString() : "0"} из ${count.toLocaleString()} баров`;
  if (progressPercentEl) progressPercentEl.textContent = `${initialPct}%`;
  if (progressBarFillEl) progressBarFillEl.style.width = `${initialPct}%`;
  if (progressStatusMsgEl) progressStatusMsgEl.textContent = "Синхронизация локального кэша MT5 с сервером брокера...";
  if (progressStatusBadgeEl) progressStatusBadgeEl.textContent = "Загрузка";
  if (progressEtaTextEl) progressEtaTextEl.textContent = "Считаем скорость загрузки...";

  if (bgBadgePercentEl) bgBadgePercentEl.textContent = `${initialPct}%`;
  if (bgBadgeCountsEl) bgBadgeCountsEl.textContent = `(${savedSyncedCount > 0 ? savedSyncedCount.toLocaleString() : "0"} / ${count.toLocaleString()})`;
  if (bgBadgeProgressFillEl) bgBadgeProgressFillEl.style.width = `${initialPct}%`;

  if (progressModal) {
    progressModal.style.display = "flex";
    if (typeof lucide !== "undefined" && lucide.createIcons) {
      lucide.createIcons();
    }
  }

  let isCancelled = false;
  let isBackground = false;
  let progressInterval = null;
  let latestKnownCurrent = savedSyncedCount > 0 ? savedSyncedCount : 0;
  let isRenderingHistory = false;
  let lastRenderedBarCount = 0;
  let lastRenderedTime = 0;

  const cleanupSyncUI = () => {
    if (progressModal) progressModal.style.display = "none";
    if (bgBadgeEl) bgBadgeEl.style.display = "none";
    loadingOverlay.classList.add("hidden");
  };

  const fetchAndRenderHistory = async (fetchCount, isInitialBackground = false) => {
    if (isCancelled || fetchCount <= 0 || isRenderingHistory) return null;
    isRenderingHistory = true;
    try {
      const url = `http://127.0.0.1:8000/history?symbol=${cleanSymbol}&timeframe=${tf}&count=${fetchCount}`;
      const res = await fetch(url);
      const data = await res.json();

      if (isCancelled) return null;

      if (data && data.status === "ok" && data.candles && data.candles.length > 0) {
        const candles = data.candles;
        const filteredCandles = filterWeekendCandles(candles, state.symbol);

        if (!filteredCandles || filteredCandles.length === 0) {
          return null;
        }

        state.historicalCandles = filteredCandles;
        state.loadedCandlesSymbol = state.symbol;
        state.isFileLoaded = false;

        candlestickSeries.setData(filteredCandles);
        updateLegend(filteredCandles[filteredCandles.length - 1]);
        if (typeof updateCOTChartData === "function" && typeof cotChartState !== "undefined" && cotChartState.active) {
          updateCOTChartData();
        }

        updateConnectionStatus("ONLINE (MT5)", "active");
        if (dbLatency) dbLatency.textContent = "MT5 Bridge";

        drawAllOnCanvas();
        if (isInitialBackground) {
          recenterView();
        }

        lastRenderedBarCount = filteredCandles.length;
        lastRenderedTime = Date.now();
        return filteredCandles;
      }
    } catch (renderErr) {
      console.warn("[MT5 Bridge] Background history render error:", renderErr);
    } finally {
      isRenderingHistory = false;
    }
    return null;
  };

  const handleCancelSync = () => {
    isCancelled = true;
    if (progressInterval) {
      clearTimeout(progressInterval);
      clearInterval(progressInterval);
      progressInterval = null;
    }
    cleanupSyncUI();
    activeMT5SyncCancel = null;
  };

  const handleContinueInBackground = () => {
    isBackground = true;
    if (progressModal) progressModal.style.display = "none";
    if (bgBadgeEl) {
      bgBadgeEl.style.display = "flex";
      if (typeof lucide !== "undefined" && lucide.createIcons) {
        lucide.createIcons();
      }
    }
    // Immediately render whatever bars are already downloaded so the chart isn't empty
    const available = latestKnownCurrent > 0 ? latestKnownCurrent : (savedSyncedCount > 0 ? savedSyncedCount : 0);
    if (available > 0) {
      fetchAndRenderHistory(available, true);
    }
  };

  const handleReopenModal = () => {
    isBackground = false;
    if (bgBadgeEl) bgBadgeEl.style.display = "none";
    if (progressModal && !isCancelled) {
      progressModal.style.display = "flex";
      if (typeof lucide !== "undefined" && lucide.createIcons) {
        lucide.createIcons();
      }
    }
  };

  if (progressCloseBtn) progressCloseBtn.onclick = handleCancelSync;
  if (progressCancelBtn) progressCancelBtn.onclick = handleCancelSync;
  if (progressBgBtn) progressBgBtn.onclick = handleContinueInBackground;
  if (bgBadgeOpenBtn) bgBadgeOpenBtn.onclick = handleReopenModal;

  activeMT5SyncCancel = handleCancelSync;

  try {
    // 1. Trigger background download on MT5 (fire-and-forget)
    try {
      await fetch(`http://127.0.0.1:8000/history-start-download?symbol=${cleanSymbol}&timeframe=${tf}`, {
        method: "POST"
      });
    } catch (triggerErr) {
      console.warn("[MT5 Bridge] Trigger history-start-download:", triggerErr);
    }

    // 2. Poll progress with real-time UI updates and remaining time estimation
    await new Promise((resolve) => {
      let consecutiveStagnant = 0;
      let consecutiveNoGrowth = 0;
      let lastCount = savedSyncedCount;
      let nextPollDelay = 250;
      let syncStartTime = Date.now();
      let syncStartBars = typeof savedSyncedCount === "number" && savedSyncedCount > 0 ? savedSyncedCount : 0;
      const maxDurationMs = 30000;

      const schedulePoll = (delay) => {
        if (isCancelled) return;
        progressInterval = setTimeout(pollStep, delay);
      };

      const pollStep = async () => {
        if (isCancelled) {
          if (progressInterval) {
            clearTimeout(progressInterval);
            clearInterval(progressInterval);
            progressInterval = null;
          }
          resolve({ cancelled: true });
          return;
        }

        try {
          const pRes = await fetch(`http://127.0.0.1:8000/history-progress?symbol=${cleanSymbol}&timeframe=${tf}&target=${count}`);
          const pData = await pRes.json();

          if (isCancelled) {
            if (progressInterval) {
              clearTimeout(progressInterval);
              clearInterval(progressInterval);
              progressInterval = null;
            }
            resolve({ cancelled: true });
            return;
          }

          if (pData && pData.status === "ok") {
            const current = pData.current || 0;
            const target = pData.target || count;
            const pct = Math.min(100, Math.max(0, Math.round((current / target) * 100)));
            latestKnownCurrent = current;

            // Background incremental update (throttled: >=5000 bars OR >=3s with >=500 bars)
            if (isBackground && current > 0 && current < target && !isRenderingHistory) {
              const barsSinceLastRender = current - lastRenderedBarCount;
              const timeSinceLastRender = Date.now() - lastRenderedTime;
              if (barsSinceLastRender >= 5000 || (timeSinceLastRender >= 3000 && barsSinceLastRender >= 500)) {
                fetchAndRenderHistory(current, false);
              }
            }

            // Rate and ETA estimation
            const elapsedSec = (Date.now() - syncStartTime) / 1000;
            const barsLoaded = current - syncStartBars;
            let etaText = "Считаем скорость загрузки...";

            if (current >= target && target > 0) {
              etaText = "Синхронизация завершена";
            } else if (elapsedSec >= 1 && (barsLoaded > 0 || current > 0)) {
              const effectiveBars = barsLoaded > 0 ? barsLoaded : current;
              const rate = effectiveBars / elapsedSec; // баров в секунду
              const remaining = target - current;
              const remainingSec = Math.max(0, Math.round(remaining / rate));
              const mins = Math.floor(remainingSec / 60);
              const secs = remainingSec % 60;
              const timeStr = mins > 0 ? `${mins}м ${secs}с` : `${secs}с`;
              etaText = `Осталось примерно: ${timeStr}`;
            } else {
              etaText = "Считаем скорость загрузки...";
            }

            // Immediately update DOM on every poll iteration
            const applyDOMUpdates = () => {
              if (progressBarsTextEl) {
                progressBarsTextEl.textContent = `Загружено ${current.toLocaleString()} из ${target.toLocaleString()} баров`;
              }
              if (progressPercentEl) {
                progressPercentEl.textContent = `${pct}%`;
              }
              if (progressBarFillEl) {
                progressBarFillEl.style.width = `${pct}%`;
              }
              if (progressEtaTextEl) {
                progressEtaTextEl.textContent = etaText;
              }

              // Update background badge UI
              if (bgBadgePercentEl) {
                bgBadgePercentEl.textContent = `${pct}%`;
              }
              if (bgBadgeCountsEl) {
                bgBadgeCountsEl.textContent = `(${current.toLocaleString()} / ${target.toLocaleString()})`;
              }
              if (bgBadgeProgressFillEl) {
                bgBadgeProgressFillEl.style.width = `${pct}%`;
              }
            };

            applyDOMUpdates();
            if (typeof requestAnimationFrame === "function") {
              requestAnimationFrame(applyDOMUpdates);
            }

            // Condition A: Target reached
            if (current >= target && target > 0) {
              if (progressStatusMsgEl) {
                progressStatusMsgEl.textContent = `Загрузка завершена: ${current.toLocaleString()} баров!`;
              }
              if (progressStatusBadgeEl) {
                progressStatusBadgeEl.textContent = "Готово";
              }
              if (progressEtaTextEl) {
                progressEtaTextEl.textContent = "Синхронизация завершена";
              }
              if (progressInterval) {
                clearTimeout(progressInterval);
                clearInterval(progressInterval);
                progressInterval = null;
              }
              const saveVal = Math.max(current, target, count);
              localStorage.setItem(syncStorageKey, saveVal.toString());
              console.log(`[MT5 Cache Save] Target reached. Key: "${syncStorageKey}", Saved value: "${saveVal}"`);
              setTimeout(resolve, 300);
              return;
            }

            // Condition B: Stagnant across consecutive polls (broker returned maximum available)
            if (current === lastCount && current > 0) {
              consecutiveStagnant++;
              if (consecutiveStagnant >= 4) {
                if (progressStatusMsgEl) {
                  progressStatusMsgEl.textContent = `Загружено максимум доступных баров: ${current.toLocaleString()}`;
                }
                if (progressStatusBadgeEl) {
                  progressStatusBadgeEl.textContent = "Синхронизировано";
                }
                if (progressEtaTextEl) {
                  progressEtaTextEl.textContent = "Синхронизация завершена";
                }
                if (progressInterval) {
                  clearTimeout(progressInterval);
                  clearInterval(progressInterval);
                  progressInterval = null;
                }
                const saveVal = Math.max(current, count);
                localStorage.setItem(syncStorageKey, saveVal.toString());
                console.log(`[MT5 Cache Save] Broker max reached (stagnant). Key: "${syncStorageKey}", Saved value: "${saveVal}" (current: ${current})`);
                setTimeout(resolve, 400);
                return;
              }
            } else {
              consecutiveStagnant = 0;
            }

            // Real-time responsive delay (250-300ms during active download)
            const delta = current - lastCount;
            if (delta > 0) {
              nextPollDelay = 250;
              consecutiveNoGrowth = 0;
            } else {
              consecutiveNoGrowth++;
              nextPollDelay = consecutiveNoGrowth >= 3 ? 800 : (consecutiveNoGrowth >= 2 ? 500 : 350);
            }

            lastCount = current;
          } else if (pData && pData.status === "error") {
            if (pData.message && (pData.message.includes("not found") || pData.message.includes("Failed to connect"))) {
              if (progressInterval) {
                clearTimeout(progressInterval);
                clearInterval(progressInterval);
                progressInterval = null;
              }
              resolve({ error: pData.message });
              return;
            }
          }
        } catch (pollErr) {
          console.warn("[MT5 Bridge] Progress poll error:", pollErr);
          consecutiveNoGrowth++;
          nextPollDelay = consecutiveNoGrowth >= 2 ? 1000 : 500;
        }

        // Condition C: General timeout 30 seconds
        if (Date.now() - syncStartTime >= maxDurationMs) {
          if (progressStatusMsgEl) {
            progressStatusMsgEl.textContent = "Таймаут синхронизации. Загрузка полученных данных...";
          }
          if (progressInterval) {
            clearTimeout(progressInterval);
            clearInterval(progressInterval);
            progressInterval = null;
          }
          if (lastCount > 0) {
            const saveVal = Math.max(lastCount, count);
            localStorage.setItem(syncStorageKey, saveVal.toString());
            console.log(`[MT5 Cache Save] Sync timeout completed. Key: "${syncStorageKey}", Saved value: "${saveVal}"`);
          }
          resolve({ timeout: true });
          return;
        }

        schedulePoll(nextPollDelay);
      };

      // Первый опрос запускаем быстро (через 150мс)
      schedulePoll(150);
    });

    if (isCancelled) return;

    // 3. Final fetch from /history with full count to load and render data
    if (progressStatusMsgEl) {
      progressStatusMsgEl.textContent = "Отрисовка котировок на графике...";
    }
    const url = `http://127.0.0.1:8000/history?symbol=${cleanSymbol}&timeframe=${tf}&count=${count}`;
    const res = await fetch(url);
    const data = await res.json();

    if (isCancelled) return;

    if (data && data.status === "ok" && data.candles && data.candles.length > 0) {
      const candles = data.candles;
      const filteredCandles = filterWeekendCandles(candles, state.symbol);

      if (!filteredCandles || filteredCandles.length === 0) {
        throw new Error("MT5 не вернул данные по этому запросу (все бары отфильтрованы или пустые)");
      }

      state.historicalCandles = filteredCandles;
      state.loadedCandlesSymbol = state.symbol;

      console.log('ДАННЫЕ ПЕРЕД РЕНДЕРОМ ' + state.timeframe.toUpperCase() + ':', JSON.stringify(filteredCandles.slice(0, 10)));
      console.log('Всего баров:', filteredCandles.length);

      candlestickSeries.setData(filteredCandles);
      updateLegend(filteredCandles[filteredCandles.length - 1]);
      if (typeof updateCOTChartData === "function" && typeof cotChartState !== "undefined" && cotChartState.active) {
        updateCOTChartData();
      }

      updateConnectionStatus("ONLINE (MT5)", "active");
      if (dbLatency) dbLatency.textContent = "MT5 Bridge";
      cleanupSyncUI();
      activeMT5SyncCancel = null;

      // Update localStorage with final loaded candle count
      const finalSaveVal = Math.max(candles.length, count);
      localStorage.setItem(syncStorageKey, finalSaveVal.toString());
      console.log(`[MT5 Cache Save] History loaded & rendered. Key: "${syncStorageKey}", Saved value: "${finalSaveVal}" (candles: ${candles.length})`);

      showToast(`Запрошено ${count.toLocaleString()}, получено от брокера ${candles.length.toLocaleString()} баров`, "success");
      if (candles.length < count) {
        window.showBannerNotification(`<strong>Информация:</strong> Запрошено ${count.toLocaleString()} баров, получено от брокера ${candles.length.toLocaleString()} баров (ограничение доступной истории в торговом терминале)`, 12);
      }

      drawAllOnCanvas();
      recenterView();
    } else {
      const failMsg = (data && data.message) ? data.message : "MT5 не вернул данные по этому запросу";
      throw new Error(failMsg);
    }
  } catch (err) {
    if (isCancelled) return;
    console.warn("MT5 history loading failed:", err);
    updateConnectionStatus("Ожидание MT5...", "demo");
    const errMsg = err.message || "";
    cleanupSyncUI();
    activeMT5SyncCancel = null;

    if (errMsg.includes("Symbol") && (errMsg.includes("not found") || errMsg.includes("не найден"))) {
      showToast("Ошибка: Символ не найден в MT5!", "error");
      if (window.showBannerNotification) {
        window.showBannerNotification(`<strong>Ошибка:</strong> Символ <strong>${state.symbol.replace("_", "")}</strong> не найден в MT5. Убедитесь, что этот символ добавлен в Обзор рынка (Market Watch) вашего терминала MetaTrader 5 под точно таким именем.`, 15);
      }
      return;
    }

    if (errMsg.includes("MT5 не вернул данные") || errMsg.includes("ограничение доступной истории") || errMsg.includes("все бары отфильтрованы")) {
      showToast(`Ошибка: ${errMsg}`, "error");
    } else if (errMsg.includes("fetch") || errMsg.includes("Failed to fetch") || errMsg.includes("NetworkError") || errMsg.includes("Unexpected token")) {
      showToast("Не удалось подключиться к MT5. Проверьте запуск bridge.py", "error");
    } else {
      showToast(`Ошибка загрузки: ${errMsg}`, "error");
    }
  }
}

let liveInterval = null;
function startRealtimePolling() {
  if (liveInterval) clearInterval(liveInterval);
  liveInterval = setInterval(async () => {
    if (state.isBacktestActive) return;
    const len = state.historicalCandles.length;
    if (len === 0) return;
    
    // Prevent updating if candles are not yet loaded for the current symbol
    if (state.loadedCandlesSymbol && state.loadedCandlesSymbol !== state.symbol) {
      console.log(`[Realtime] Skipping update: loaded candles are for ${state.loadedCandlesSymbol}, but current symbol is ${state.symbol}`);
      return;
    }
    
    const last = state.historicalCandles[len - 1];
    const decimals = getSymbolDecimals(state.symbol);
    const tfMinutes = timeframeToMinutes(state.timeframe || "15m");

    if (state.currentProvider === "mt5") {
      try {
        const cleanSymbol = state.symbol.replace("_", "");
        const res = await fetch(`http://127.0.0.1:8000/?symbol=${cleanSymbol}`);
        const data = await res.json();
        
        if (data && data.status === "ok") {
          const realPrice = data.last || (data.bid + data.ask) / 2;
          const tickTime = data.time || Math.floor(Date.now() / 1000);
          const currentBucket = getBucketTime(tickTime, tfMinutes);
          const lastBucket = getBucketTime(Number(last.time), tfMinutes);

          let currentBar;
          if (currentBucket > lastBucket) {
            // New bar/bucket started! Push new candle with open=realPrice
            currentBar = {
              time: currentBucket,
              open: parseFloat(realPrice.toFixed(decimals)),
              high: parseFloat(realPrice.toFixed(decimals)),
              low: parseFloat(realPrice.toFixed(decimals)),
              close: parseFloat(realPrice.toFixed(decimals)),
            };
            state.historicalCandles.push(currentBar);
          } else {
            // Same bucket — update current forming candle
            currentBar = {
              ...last,
              close: parseFloat(realPrice.toFixed(decimals)),
              high: parseFloat(Math.max(last.high, realPrice).toFixed(decimals)),
              low: parseFloat(Math.min(last.low, realPrice).toFixed(decimals)),
            };
            state.historicalCandles[state.historicalCandles.length - 1] = currentBar;
          }

          candlestickSeries.update(currentBar);
          updateLegend(currentBar);
          
          // Update price tickers
          const headerLastPrice = document.getElementById("price-display");
          if (headerLastPrice) {
            headerLastPrice.textContent = realPrice.toFixed(decimals);
            headerLastPrice.style.color = realPrice >= currentBar.open ? "#10b981" : "#ef4444";
          }
          const buyBtnPrice = document.getElementById("buy-btn-price");
          const sellBtnPrice = document.getElementById("sell-btn-price");
          if (buyBtnPrice) buyBtnPrice.textContent = realPrice.toFixed(decimals);
          if (sellBtnPrice) sellBtnPrice.textContent = realPrice.toFixed(decimals);

          const fBuyPrice = document.getElementById("floating-buy-price");
          const fSellPrice = document.getElementById("floating-sell-price");
          if (fBuyPrice) fBuyPrice.textContent = realPrice.toFixed(decimals);
          if (fSellPrice) fSellPrice.textContent = realPrice.toFixed(decimals);
          
          checkPendingOrders(currentBar);
          updateSimulatorUI();
          updateConnectionStatus("ONLINE (MT5)", "active");
        } else {
          updateConnectionStatus("Ожидание MT5...", "demo");
        }
      } catch (err) {
        updateConnectionStatus("Ожидание MT5...", "demo");
      }
    } else {
      // Twelve Data / Offline simulator ticks
      const nowSec = Math.floor(Date.now() / 1000);
      const currentBucket = getBucketTime(nowSec, tfMinutes);
      const lastBucket = getBucketTime(Number(last.time), tfMinutes);
      const vol = getSymbolVolatility(state.symbol);

      // Realistic tick noise relative to current price
      const change = (Math.random() - 0.495) * vol * 0.05 * last.close;
      const targetPrice = parseFloat((last.close + change).toFixed(decimals));

      let currentBar;
      if (currentBucket > lastBucket) {
        currentBar = {
          time: currentBucket,
          open: targetPrice,
          high: targetPrice,
          low: targetPrice,
          close: targetPrice,
        };
        state.historicalCandles.push(currentBar);
      } else {
        currentBar = {
          ...last,
          close: targetPrice,
          high: parseFloat(Math.max(last.high, targetPrice).toFixed(decimals)),
          low: parseFloat(Math.min(last.low, targetPrice).toFixed(decimals)),
        };
        state.historicalCandles[state.historicalCandles.length - 1] = currentBar;
      }

      candlestickSeries.update(currentBar);
      updateLegend(currentBar);
      
      const headerLastPrice = document.getElementById("price-display");
      if (headerLastPrice) {
        headerLastPrice.textContent = currentBar.close.toFixed(decimals);
        headerLastPrice.style.color = currentBar.close >= currentBar.open ? "#10b981" : "#ef4444";
      }
      const buyBtnPrice = document.getElementById("buy-btn-price");
      const sellBtnPrice = document.getElementById("sell-btn-price");
      if (buyBtnPrice) buyBtnPrice.textContent = currentBar.close.toFixed(decimals);
      if (sellBtnPrice) sellBtnPrice.textContent = currentBar.close.toFixed(decimals);

      const fBuyPrice = document.getElementById("floating-buy-price");
      const fSellPrice = document.getElementById("floating-sell-price");
      if (fBuyPrice) fBuyPrice.textContent = currentBar.close.toFixed(decimals);
      if (fSellPrice) fSellPrice.textContent = currentBar.close.toFixed(decimals);

      checkPendingOrders(currentBar);
      updateSimulatorUI();
      updateConnectionStatus("ONLINE", "active");
    }
  }, 1000);
}

// Global diagnostic helper for Step 4 testing
window.getAggregatedBars = function(tf = "W1") {
  const tfMinutes = timeframeToMinutes(tf);
  const baseCandles = state.importedBaseCandles || state.backtestBaseCandles || state.historicalCandles;
  if (!baseCandles || baseCandles.length === 0) return state.historicalCandles || [];
  return aggregateCandles(baseCandles, tfMinutes);
};

function updateDeckStatus(status) {
  const indicator = document.getElementById("deck-status-indicator");
  const led = document.getElementById("deck-led");
  if (indicator) indicator.textContent = status;
  if (led) {
    led.className = "deck-led";
    if (status === "PLAYING") {
      led.classList.add("playing");
    } else if (status === "PAUSED" || status === "READY") {
      led.classList.add("active");
    }
  }
}

function exitBacktestModeQuietly() {
  state.isBacktestActive = false;
  if (state.isFastForwarding) {
    state.isFastForwarding = false;
    if (typeof showFastForwardIndicator === "function") {
      showFastForwardIndicator(false);
    }
  }
  backtestToggleBtn.style.display = "flex";
  const deckControls = document.getElementById("deck-controls");
  if (deckControls) deckControls.style.display = "none";
  stopAutoplay();
  updateDeckStatus("STANDBY");
  state.backtestVisibleCandles = [];
  state.backtestFutureCandles = [];
  state.backtestInitialIdx = null;
}

function updateBalanceUIState() {
  if (isDeposit) {
    if (tabDeposit) {
      tabDeposit.className = "balance-tab active deposit-mode";
    }
    if (tabWithdraw) {
      tabWithdraw.className = "balance-tab";
    }
    if (balanceInputLabel) {
      balanceInputLabel.textContent = "Сумма пополнения ($)";
    }
    if (depositBtn) {
      depositBtn.textContent = "Пополнить";
      depositBtn.style.backgroundColor = "var(--color-up)";
    }
  } else {
    if (tabDeposit) {
      tabDeposit.className = "balance-tab";
    }
    if (tabWithdraw) {
      tabWithdraw.className = "balance-tab active withdraw-mode";
    }
    if (balanceInputLabel) {
      balanceInputLabel.textContent = "Сумма списания ($)";
    }
    if (depositBtn) {
      depositBtn.textContent = "Списать";
      depositBtn.style.backgroundColor = "var(--color-down)";
    }
  }
}

if (tabDeposit) {
  tabDeposit.addEventListener("click", () => {
    isDeposit = true;
    updateBalanceUIState();
  });
}

if (tabWithdraw) {
  tabWithdraw.addEventListener("click", () => {
    isDeposit = false;
    updateBalanceUIState();
  });
}

depositBtn.addEventListener("click", () => {
  const amt = parseFloat(depositInput.value);
  if (isNaN(amt) || amt <= 0) {
    showToast("Введите корректную сумму!", "error");
    return;
  }
  if (isDeposit) {
    balance += amt;
    saveBalance(balance);
    showToast(`Ваш счет пополнен на $${amt.toLocaleString()}!`, "success");
  } else {
    if (amt > balance) {
      showToast("Недостаточно средств для списания!", "error");
      return;
    }
    balance -= amt;
    saveBalance(balance);
    showToast(`Списано $${amt.toLocaleString()} с вашего счета!`, "success");
  }
});

// Initialize on script load
updateBalanceUIState();

const buyBtn = document.getElementById("buy-btn");
if (buyBtn) {
  buyBtn.addEventListener("click", () => {
    placeOrder("buy");
  });
}

const sellBtn = document.getElementById("sell-btn");
if (sellBtn) {
  sellBtn.addEventListener("click", () => {
    placeOrder("sell");
  });
}

backtestToggleBtn.addEventListener("click", () => {
  if (!state.isBacktestActive) {
    state.isBacktestActive = true;
    
    // Initialize protected backtestData once from loaded JSON/history
    if (state.isFileLoaded && state.importedBaseCandles && state.importedBaseCandles.length > 0) {
      state.backtestData = [...state.importedBaseCandles];
    } else if (state.historicalCandles && state.historicalCandles.length > 0) {
      state.backtestData = [...state.historicalCandles];
    } else {
      state.backtestData = [];
    }
    
    state.backtestBaseCandles = state.backtestData;
    state.baseTimeframeCache = state.backtestData;
    state.backtestBaseTimeframe = state.importedBaseMinutes ? (state.importedBaseMinutes + "m") : "15m";

    backtestToggleBtn.style.display = "none";
    const deckControls = document.getElementById("deck-controls");
    if (deckControls) deckControls.style.display = "flex";
    updateDeckStatus("READY");
    if (backtestPrevBtn) {
      backtestPrevBtn.disabled = true;
      backtestPrevBtn.style.opacity = "0.4";
      backtestPrevBtn.style.cursor = "not-allowed";
    }
    backtestNextBtn.disabled = true;
    backtestNextBtn.style.opacity = "0.4";
    backtestNextBtn.style.cursor = "not-allowed";
    backtestAutoplayBtn.disabled = true;
    backtestAutoplayBtn.style.opacity = "0.4";
    backtestAutoplayBtn.style.cursor = "not-allowed";
    if (backtestFastForwardBtn) {
      backtestFastForwardBtn.disabled = true;
      backtestFastForwardBtn.style.opacity = "0.4";
      backtestFastForwardBtn.style.cursor = "not-allowed";
    }
    if (liveInterval) {
      clearInterval(liveInterval);
      liveInterval = null;
    }
    showToast("Бэктест запущен! Кликните на любую свечу на графике.", "info");
  }
});

document.getElementById("deck-exit-btn")?.addEventListener("click", () => {
  exitBacktestModeQuietly();
  candlestickSeries.setData(state.historicalCandles);
  if (state.historicalCandles.length > 0)
    updateLegend(state.historicalCandles[state.historicalCandles.length - 1]);
  startRealtimePolling();
  if (typeof updateCOTChartData === "function" && typeof cotChartState !== "undefined" && cotChartState.active) {
    updateCOTChartData();
  }
  showToast("Бэктест завершен.", "info");
  recenterView();
});

document.getElementById("deck-reset-btn")?.addEventListener("click", () => {
  if (!state.isBacktestActive) return;
  if (state.isFastForwarding) {
    state.isFastForwarding = false;
    if (typeof showFastForwardIndicator === "function") {
      showFastForwardIndicator(false);
    }
  }
  if (state.backtestInitialIdx === null || !state.backtestBaseCandles) {
    showToast("Кликните по любой свече!", "warning");
    return;
  }
  stopAutoplay();
  
  const initialCandle = state.backtestBaseCandles[state.backtestInitialIdx];
  if (initialCandle) {
    state.currentReplayTimestamp = initialCandle.time;
  }

  // Capture visible range BEFORE modifying data
  const timeScale = chart.timeScale();
  const visibleLogicalRangeBefore = timeScale ? timeScale.getVisibleLogicalRange() : null;
  
  updateBacktestVisibleCandles();

  state.lastRenderedCandlesArray = null;
  candlestickSeries.setData(state.backtestVisibleCandles);

  // Restore visible range
  if (timeScale && visibleLogicalRangeBefore) {
    try {
      timeScale.setVisibleLogicalRange(visibleLogicalRangeBefore);
    } catch (e) {}
    requestAnimationFrame(() => {
      try {
        timeScale.setVisibleLogicalRange(visibleLogicalRangeBefore);
      } catch (e) {}
    });
    setTimeout(() => {
      try {
        timeScale.setVisibleLogicalRange(visibleLogicalRangeBefore);
      } catch (e) {}
    }, 50);
  }

  const lastVisible = state.backtestVisibleCandles[state.backtestVisibleCandles.length - 1];
  if (lastVisible) {
    updateLegend(lastVisible);
  }
  updateSimulatorUI();
  drawAllOnCanvas();
  if (typeof updateCOTChartData === "function" && typeof cotChartState !== "undefined" && cotChartState.active) {
    updateCOTChartData();
  }
  updateDeckStatus("PAUSED");
  showToast("График сброшен к началу!", "info");
});

let isChartRenderScheduled = false;
let lastRenderedBacktestCount = 0;
let lastRenderedBacktestSymbol = "";
let lastRenderedBacktestTf = "";

function scheduleVisualUpdate() {
  if (!isChartRenderScheduled) {
    isChartRenderScheduled = true;
    requestAnimationFrame(performVisualUpdate);
  }
}

function performVisualUpdate() {
  isChartRenderScheduled = false;
  if (!state.isBacktestActive) return;

  const candles = state.backtestVisibleCandles;
  if (!candles || candles.length === 0) return;

  const lastVisible = candles[candles.length - 1];
  const currentCount = candles.length;

  const isSequentialAppend =
    lastRenderedBacktestSymbol === state.symbol &&
    lastRenderedBacktestTf === state.timeframe &&
    (currentCount === lastRenderedBacktestCount || currentCount === lastRenderedBacktestCount + 1);

  if (isSequentialAppend && lastRenderedBacktestCount > 0) {
    // Ultra-fast incremental bar update O(1) instead of heavy full-series rebuild
    candlestickSeries.update(lastVisible);
  } else {
    // Rebuild full dataset only on jumps, resets, seeks, timeframe changes, or new loads
    candlestickSeries.setData(candles);
  }

  lastRenderedBacktestCount = currentCount;
  lastRenderedBacktestSymbol = state.symbol;
  lastRenderedBacktestTf = state.timeframe;
  state.lastRenderedCandlesArray = candles;

  if (lastVisible) {
    updateLegend(lastVisible);
  }

  updateSimulatorUI();
  drawAllOnCanvas();

  // Update COT indicator series if active during backtest replay
  if (typeof updateCOTChartDataForReplay === "function" && typeof cotChartState !== "undefined" && cotChartState.active) {
    updateCOTChartDataForReplay(state.currentReplayTimestamp);
  }
}

function stepBacktestForward() {
  if (!state.isBacktestActive) return false;
  
  const baseCandles = state.baseTimeframeCache && state.baseTimeframeCache.length > 0
    ? state.baseTimeframeCache
    : state.backtestBaseCandles;

  if (!baseCandles || baseCandles.length === 0) {
    showToast("Нет базовых свечей для бэктеста!", "warning");
    stopAutoplay();
    return false;
  }

  // Находим первую свечу, время которой строго больше текущего currentReplayTimestamp
  const nextCandle = baseCandles.find(c => c.time > state.currentReplayTimestamp);

  if (!nextCandle) {
    console.log('Достигнут конец загруженной истории бэктеста');
    showToast("Вы дошли до конца истории бэктеста!", "info");
    stopAutoplay();
    return false;
  }

  state.currentReplayTimestamp = nextCandle.time;
  updateBacktestVisibleCandles();

  const lastVisible = state.backtestVisibleCandles[state.backtestVisibleCandles.length - 1];
  if (lastVisible) {
    checkPendingOrders(lastVisible);
  }

  scheduleVisualUpdate();
  return true;
}

function stepBacktestBackward() {
  if (!state.isBacktestActive) return false;
  if (isAutoplayRunning) stopAutoplay();

  const baseCandles = state.baseTimeframeCache && state.baseTimeframeCache.length > 0
    ? state.baseTimeframeCache
    : state.backtestBaseCandles;

  if (!baseCandles || baseCandles.length === 0) {
    showToast("Нет базовых свечей для бэктеста!", "warning");
    return false;
  }

  let prevCandle = null;
  for (let i = baseCandles.length - 1; i >= 0; i--) {
    if (baseCandles[i].time < state.currentReplayTimestamp) {
      if (state.backtestInitialIdx !== null && i < state.backtestInitialIdx) {
        showToast("Вы достигли начальной точки бэктеста!", "info");
        return false;
      }
      prevCandle = baseCandles[i];
      break;
    }
  }

  if (!prevCandle) {
    showToast("Вы находитесь в самом начале бэктеста!", "info");
    return false;
  }

  state.currentReplayTimestamp = prevCandle.time;
  updateBacktestVisibleCandles();

  lastRenderedBacktestCount = 0;
  scheduleVisualUpdate();
  return true;
}

if (backtestPrevBtn) {
  backtestPrevBtn.addEventListener("click", () => {
    if (!state.isBacktestActive) return;
    if (isAutoplayRunning) stopAutoplay();
    stepBacktestBackward();
  });
}

backtestNextBtn.addEventListener("click", () => {
  if (!state.isBacktestActive) return;
  if (isAutoplayRunning) stopAutoplay();
  stepBacktestForward();
});

if (backtestFastForwardBtn) {
  backtestFastForwardBtn.addEventListener("click", () => {
    executeFastForwardToOutcome();
  });
}

let isAutoplayRunning = false;
let autoplayTimer = null;

function stopAutoplay() {
  isAutoplayRunning = false;
  if (autoplayTimer) {
    clearTimeout(autoplayTimer);
    autoplayTimer = null;
  }
  updateDeckStatus("PAUSED");
  const autoplayIcon = document.getElementById("autoplay-icon");
  if (autoplayIcon) {
    autoplayIcon.setAttribute("data-lucide", "play");
    if (window.lucide) window.lucide.createIcons();
  }
}

function startAutoplay() {
  if (!state.isBacktestActive || !state.currentReplayTimestamp) {
    showToast("Кликните на любую свечу!", "error");
    return;
  }
  const baseCandles = state.baseTimeframeCache && state.baseTimeframeCache.length > 0
    ? state.baseTimeframeCache
    : state.backtestBaseCandles;

  if (!baseCandles || baseCandles.length === 0) {
    showToast("Нет базовых свечей!", "error");
    return;
  }
  
  const hasNext = baseCandles.some(c => c.time > state.currentReplayTimestamp);
  if (!hasNext) {
    showToast("Вы дошли до конца истории!", "info");
    return;
  }
  
  isAutoplayRunning = true;
  updateDeckStatus("PLAYING");
  const autoplayIcon = document.getElementById("autoplay-icon");
  if (autoplayIcon) {
    autoplayIcon.setAttribute("data-lucide", "pause");
    if (window.lucide) window.lucide.createIcons();
  }
  runAutoplayStep();
}

function runAutoplayStep() {
  if (!isAutoplayRunning) return;
  const stepped = stepBacktestForward();
  if (stepped) {
    autoplayTimer = setTimeout(runAutoplayStep, replayDelay);
  }
}

backtestAutoplayBtn.addEventListener("click", () => {
  if (!state.isBacktestActive) return;
  if (isAutoplayRunning) stopAutoplay();
  else startAutoplay();
});

function parseDateTime(dateStr, timeStr = "") {
  let d = (dateStr || "").trim().replace(/^["']|["']$/g, "");
  let t = (timeStr || "").trim().replace(/^["']|["']$/g, "");
  if (!d && t) {
    d = t;
    t = "";
  }
  if (!t) {
    const parts = d.split(/[\s\t]+/);
    if (parts.length > 1) {
      d = parts[0];
      t = parts[1];
    }
  }
  d = d.trim();
  t = t.trim();
  const fullStr = t ? `${d} ${t}` : d;
  const normalizedFullStr = fullStr.replace(/\./g, "-");
  let nativeTS = Date.parse(fullStr) || Date.parse(normalizedFullStr);
  if (!isNaN(nativeTS)) {
    return Math.floor(nativeTS / 1000);
  }
  if (/^\d{10}$/.test(d)) {
    return parseInt(d);
  }
  if (/^\d{13}$/.test(d)) {
    return Math.floor(parseInt(d) / 1000);
  }

  let year,
    month,
    day,
    hour = 0,
    minute = 0,
    second = 0;
  if (/^\d{8}$/.test(d)) {
    year = parseInt(d.substring(0, 4));
    month = parseInt(d.substring(4, 6)) - 1;
    day = parseInt(d.substring(6, 8));
  } else {
    let s = d.split(/[\.\-\/]/);
    if (s.length === 3) {
      s = s.map((part) => part.trim());
      if (s[0].length === 4) {
        year = parseInt(s[0]);
        month = parseInt(s[1]) - 1;
        day = parseInt(s[2]);
      } else {
        year = parseInt(s[2]);
        if (s[2].length === 2) year += 2000;
        const p0 = parseInt(s[0]);
        const p1 = parseInt(s[1]);
        if (p0 > 12) {
          day = p0;
          month = p1 - 1;
        } else if (p1 > 12) {
          day = p1;
          month = p0 - 1;
        } else {
          day = p0;
          month = p1 - 1;
        }
      }
    }
  }
  if (t) {
    if (/^\d{6}$/.test(t)) {
      hour = parseInt(t.substring(0, 2)) || 0;
      minute = parseInt(t.substring(2, 4)) || 0;
      second = parseInt(t.substring(4, 6)) || 0;
    } else if (/^\d{4}$/.test(t)) {
      hour = parseInt(t.substring(0, 2)) || 0;
      minute = parseInt(t.substring(2, 4)) || 0;
    } else {
      let s = t.split(":");
      if (s.length >= 2) {
        hour = parseInt(s[0]) || 0;
        minute = parseInt(s[1]) || 0;
        if (s[2]) second = parseInt(s[2]) || 0;
      }
    }
  }
  if (
    year !== undefined &&
    month !== undefined &&
    day !== undefined &&
    !isNaN(year) &&
    !isNaN(month) &&
    !isNaN(day)
  ) {
    const dateObj = new Date(Date.UTC(year, month, day, hour, minute, second));
    let ts = Math.floor(dateObj.getTime() / 1000);
    if (!isNaN(ts)) return ts;
  }
  return NaN;
}

function handleFileImport(file) {
  if (!file) return;
  loadingOverlay.classList.remove("hidden");
  loadingStatus.textContent = `Чтение файла ${file.name}...`;

  Papa.parse(file, {
    skipEmptyLines: "greedy",
    complete: function (results) {
      try {
        let rows = results.data;
        if (!rows || !Array.isArray(rows) || rows.length === 0) {
          throw new Error("Файл пуст.");
        }

        const cleanRowCells = (rList) => {
          for (let i = 0; i < rList.length; i++) {
            if (rList[i] && Array.isArray(rList[i])) {
              for (let j = 0; j < rList[i].length; j++) {
                if (typeof rList[i][j] === "string") {
                  rList[i][j] = rList[i][j]
                    .replace(/^\ufeff/, "")
                    .replace(/^["']|["']$/g, "")
                    .replace(/^#\s*/, "")
                    .trim();
                }
              }
            }
          }
        };
        cleanRowCells(rows);
        let delimiter = results.meta.delimiter || ",";
        const parsed = [];

        let isCustomFormat = false;
        for (let i = 0; i < Math.min(rows.length, 10); i++) {
          const row = rows[i];
          if (row && Array.isArray(row) && row.length >= 5) {
            const col0 = (row[0] || "").toString().trim();
            const dtParts = col0.split(/[\s\t]+/);
            if (dtParts.length >= 2 && /^\d{8}$/.test(dtParts[0])) {
              isCustomFormat = true;
              break;
            }
          }
        }

        if (isCustomFormat) {
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row || !Array.isArray(row) || row.length < 5) continue;
            const col0 = (row[0] || "").toString().trim();
            const dtParts = col0.split(/[\s\t]+/);
            if (dtParts.length < 2) continue;
            const timestamp = parseDateTime(dtParts[0], dtParts[1]);
            if (isNaN(timestamp)) continue;
            const openVal = parseFloat(
              (row[1] || "").toString().replace(",", "."),
            );
            const highVal = parseFloat(
              (row[2] || "").toString().replace(",", "."),
            );
            const lowVal = parseFloat(
              (row[3] || "").toString().replace(",", "."),
            );
            const closeVal = parseFloat(
              (row[4] || "").toString().replace(",", "."),
            );
            if (isNaN(openVal)) continue;
            parsed.push({
              time: timestamp,
              open: openVal,
              high: highVal,
              low: lowVal,
              close: closeVal,
            });
          }
        } else {
          let colMap = { date: 0, open: 1, high: 2, low: 3, close: 4 };
          for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (!row || !Array.isArray(row) || row.length < 5) continue;
            const dateStr = row[colMap.date];
            const openVal = parseFloat(
              (row[colMap.open] || "").toString().replace(",", "."),
            );
            const highVal = parseFloat(
              (row[colMap.high] || "").toString().replace(",", "."),
            );
            const lowVal = parseFloat(
              (row[colMap.low] || "").toString().replace(",", "."),
            );
            const closeVal = parseFloat(
              (row[colMap.close] || "").toString().replace(",", "."),
            );
            if (isNaN(openVal)) continue;
            const timestamp = parseDateTime(dateStr, "");
            if (isNaN(timestamp)) continue;
            parsed.push({
              time: timestamp,
              open: openVal,
              high: highVal,
              low: lowVal,
              close: closeVal,
            });
          }
        }

        if (parsed.length === 0) {
          throw new Error("Не удалось спарсить котировки.");
        }
        parsed.sort((a, b) => a.time - b.time);

        const uniqueCandles = [];
        const seenTimes = new Set();
        for (const c of parsed) {
          if (!seenTimes.has(c.time)) {
            seenTimes.add(c.time);
            uniqueCandles.push(c);
          }
        }

        let filteredUniqueCandles = filterWeekendCandles(
          uniqueCandles,
          state.symbol,
        );
        if (filteredUniqueCandles.length === 0)
          filteredUniqueCandles = uniqueCandles;

        // Detect base timeframe of the imported CSV file
        let detectedBaseMinutes = 15; // default fallback
        if (filteredUniqueCandles.length >= 2) {
          const sortedCopy = [...filteredUniqueCandles].sort((a, b) => a.time - b.time);
          const diffSeconds = sortedCopy[1].time - sortedCopy[0].time;
          if (diffSeconds > 0 && diffSeconds < 86400 * 30) {
            detectedBaseMinutes = Math.round(diffSeconds / 60);
          }
        }

        state.importedBaseCandles = filteredUniqueCandles;
        state.importedBaseMinutes = detectedBaseMinutes;
        state.isFileLoaded = true;

        // Populate protected backtestData state
        state.backtestData = [...filteredUniqueCandles];
        if (state.isBacktestActive) {
          state.backtestBaseCandles = state.backtestData;
          state.baseTimeframeCache = state.backtestData;
          state.backtestBaseTimeframe = state.importedBaseMinutes ? (state.importedBaseMinutes + "m") : "15m";
        }

        let targetMinutes = timeframeToMinutes(state.timeframe);
        if (targetMinutes < state.importedBaseMinutes) {
          showToast("Нельзя получить более мелкий таймфрейм из сохранённого файла — пересохраните историю с более высоким базовым таймфреймом", "error");
          window.showBannerNotification("<strong>Ошибка:</strong> Нельзя получить более мелкий таймфрейм из сохранённого файла — пересохраните историю с более высоким базовым таймфреймом", 10);
          
          let matchingTf = "15m";
          if (state.importedBaseMinutes === 1) matchingTf = "1m";
          else if (state.importedBaseMinutes === 5) matchingTf = "5m";
          else if (state.importedBaseMinutes === 15) matchingTf = "15m";
          else if (state.importedBaseMinutes === 30) matchingTf = "30m";
          else if (state.importedBaseMinutes === 60) matchingTf = "1h";
          else if (state.importedBaseMinutes === 240) matchingTf = "4h";
          else if (state.importedBaseMinutes === 1440) matchingTf = "1d";
          else if (state.importedBaseMinutes === 10080) matchingTf = "1w";
          else if (state.importedBaseMinutes === 43200) matchingTf = "1M";
          else if (state.importedBaseMinutes === 525600) matchingTf = "12M";
          else {
            const standardTfs = [
              { name: "1m", min: 1 },
              { name: "5m", min: 5 },
              { name: "15m", min: 15 },
              { name: "30m", min: 30 },
              { name: "1h", min: 60 },
              { name: "4h", min: 240 },
              { name: "1d", min: 1440 },
              { name: "1w", min: 10080 },
              { name: "1M", min: 43200 },
              { name: "12M", min: 525600 }
            ];
            const found = standardTfs.find(t => t.min >= state.importedBaseMinutes);
            if (found) {
              matchingTf = found.name;
            } else {
              matchingTf = "1d";
            }
          }
          
          state.timeframe = matchingTf;
          if (timeframeSelect) timeframeSelect.value = matchingTf;
          updateHistoryDurationEstimate();
          targetMinutes = timeframeToMinutes(matchingTf);
        }

        if (targetMinutes > state.importedBaseMinutes) {
          state.historicalCandles = aggregateCandles(state.importedBaseCandles, targetMinutes);
          console.log(`[Import] Resampled loaded ${state.importedBaseMinutes}m data to ${state.timeframe}`);
        } else {
          state.historicalCandles = state.importedBaseCandles;
          console.log(`[Import] Used raw loaded ${state.importedBaseMinutes}m data (timeframe match: ${state.timeframe})`);
        }

        if (state.isBacktestActive) exitBacktestModeQuietly();
        candlestickSeries.setData(state.historicalCandles);
        updateLegend(state.historicalCandles[state.historicalCandles.length - 1]);
        window.closeBanner();
        updateConnectionStatus("Файл загружен", "active");
        const badge = document.getElementById("instrument-exchange");
        if (badge) badge.textContent = "CSV Файл";
        showToast(`Файл загружен! Свечей: ${uniqueCandles.length}`, "success");
        loadingOverlay.classList.add("hidden");
        drawAllOnCanvas();
        recenterView();
      } catch (err) {
        console.error(err);
        showToast(err.message || "Ошибка импорта файла", "error");
        loadingOverlay.classList.add("hidden");
      }
    },
    error: function (err) {
      showToast("Ошибка при чтении файла", "error");
      loadingOverlay.classList.add("hidden");
    },
  });
}

document.getElementById("fileInput").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (file) handleFileImport(file);
});

// ==========================================
// JSON HISTORY EXPORT AND IMPORT
// ==========================================

const saveHistoryBtn = document.getElementById("save-history-file-btn");
if (saveHistoryBtn) {
  saveHistoryBtn.addEventListener("click", () => {
    if (!state.historicalCandles || state.historicalCandles.length === 0) {
      showToast("Нет загруженных свечей для сохранения!", "error");
      return;
    }
    
    try {
      // Filter out invalid or null candles before exporting
      const validCandles = state.historicalCandles.filter(c => c && c.time !== undefined && c.time !== null);
      if (validCandles.length === 0) {
        showToast("Нет валидных свечей для сохранения!", "error");
        return;
      }
      
      // Serialize current historical candles to unformatted JSON (faster/smaller for large data)
      const jsonString = JSON.stringify(validCandles);
      const blob = new Blob([jsonString], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      
      const a = document.createElement("a");
      a.href = url;
      // Extract clean symbol name and timeframe for filename
      const sym = state.symbol.replace("_", "");
      const tf = state.timeframe;
      a.download = `history_${sym}_${tf}_${validCandles.length}_bars_${Date.now()}.json`;
      
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      showToast(`История (${validCandles.length.toLocaleString()} бар.) успешно экспортирована!`, "success");
    } catch (err) {
      console.error("Не удалось сохранить историю в файл:", err);
      showToast("Ошибка при сохранении файла истории", "error");
    }
  });
}

const jsonFileInput = document.getElementById("jsonFileInput");
if (jsonFileInput) {
  jsonFileInput.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;
    
    loadingOverlay.classList.remove("hidden");
    loadingStatus.textContent = `Импорт файла истории ${file.name}...`;
    
    const reader = new FileReader();
    reader.onload = function(e) {
      try {
        const rawContent = e.target.result;
        const parsedData = JSON.parse(rawContent);
        
        // Validation
        if (!Array.isArray(parsedData)) {
          throw new Error("Файл должен содержать JSON-массив объектов свечей.");
        }
        
        // Filter out any null/undefined elements immediately
        const filteredData = parsedData.filter(c => c !== null && c !== undefined);
        
        if (filteredData.length === 0) {
          throw new Error("Импортируемый файл пуст или не содержит валидных объектов.");
        }
        
        // Validate required candle properties: time, open, high, low, close
        for (let i = 0; i < Math.min(filteredData.length, 100); i++) {
          const c = filteredData[i];
          if (c === null || typeof c !== "object") {
            throw new Error(`Свеча под индексом ${i} повреждена (пустое значение или не является объектом).`);
          }
          if (c.time === undefined || c.open === undefined || c.high === undefined || c.low === undefined || c.close === undefined) {
            throw new Error(`Свеча под индексом ${i} не содержит обязательных полей (time, open, high, low, close).`);
          }
        }
        
        // Detect base timeframe of the imported JSON file
        let detectedBaseMinutes = 15; // default fallback
        if (filteredData.length >= 2) {
          const sortedCopy = [...filteredData].sort((a, b) => a.time - b.time);
          const diffSeconds = sortedCopy[1].time - sortedCopy[0].time;
          if (diffSeconds > 0 && diffSeconds < 86400 * 30) {
            detectedBaseMinutes = Math.round(diffSeconds / 60);
          }
        }
        
        state.importedBaseCandles = filteredData;
        state.importedBaseMinutes = detectedBaseMinutes;
        state.isFileLoaded = true;
        
        // Populate protected backtestData state
        state.backtestData = [...filteredData];
        if (state.isBacktestActive) {
          state.backtestBaseCandles = state.backtestData;
          state.baseTimeframeCache = state.backtestData;
          state.backtestBaseTimeframe = state.importedBaseMinutes ? (state.importedBaseMinutes + "m") : "15m";
        }
        
        let targetMinutes = timeframeToMinutes(state.timeframe);
        if (targetMinutes < state.importedBaseMinutes) {
          showToast("Нельзя получить более мелкий таймфрейм из сохранённого файла — пересохраните историю с более высоким базовым таймфреймом", "error");
          window.showBannerNotification("<strong>Ошибка:</strong> Нельзя получить более мелкий таймфрейм из сохранённого файла — пересохраните историю с более высоким базовым таймфреймом", 10);
          
          let matchingTf = "15m";
          if (state.importedBaseMinutes === 1) matchingTf = "1m";
          else if (state.importedBaseMinutes === 5) matchingTf = "5m";
          else if (state.importedBaseMinutes === 15) matchingTf = "15m";
          else if (state.importedBaseMinutes === 30) matchingTf = "30m";
          else if (state.importedBaseMinutes === 60) matchingTf = "1h";
          else if (state.importedBaseMinutes === 240) matchingTf = "4h";
          else if (state.importedBaseMinutes === 1440) matchingTf = "1d";
          else if (state.importedBaseMinutes === 10080) matchingTf = "1w";
          else if (state.importedBaseMinutes === 43200) matchingTf = "1M";
          else if (state.importedBaseMinutes === 525600) matchingTf = "12M";
          else {
            const standardTfs = [
              { name: "1m", min: 1 },
              { name: "5m", min: 5 },
              { name: "15m", min: 15 },
              { name: "30m", min: 30 },
              { name: "1h", min: 60 },
              { name: "4h", min: 240 },
              { name: "1d", min: 1440 },
              { name: "1w", min: 10080 },
              { name: "1M", min: 43200 },
              { name: "12M", min: 525600 }
            ];
            const found = standardTfs.find(t => t.min >= state.importedBaseMinutes);
            if (found) {
              matchingTf = found.name;
            } else {
              matchingTf = "1d";
            }
          }
          
          state.timeframe = matchingTf;
          if (timeframeSelect) timeframeSelect.value = matchingTf;
          updateHistoryDurationEstimate();
          targetMinutes = timeframeToMinutes(matchingTf);
        }

        if (targetMinutes > state.importedBaseMinutes) {
          state.historicalCandles = aggregateCandles(state.importedBaseCandles, targetMinutes);
          console.log(`[Import] Resampled loaded ${state.importedBaseMinutes}m data to ${state.timeframe}`);
        } else {
          state.historicalCandles = state.importedBaseCandles;
          console.log(`[Import] Used raw loaded ${state.importedBaseMinutes}m data (timeframe match: ${state.timeframe})`);
        }
        
        candlestickSeries.setData(state.historicalCandles);
        if (state.historicalCandles.length > 0) {
          updateLegend(state.historicalCandles[state.historicalCandles.length - 1]);
        }
        
        // Update UI source indicators
        updateConnectionStatus("ONLINE (Файл JSON)", "active");
        const badge = document.getElementById("instrument-exchange");
        if (badge) badge.textContent = "Offline JSON File";
        
        showToast(`Успешно импортировано ${filteredData.length.toLocaleString()} баров из файла!`, "success");
        drawAllOnCanvas();
        recenterView();
      } catch (err) {
        console.error("JSON parsing/validation failed:", err);
        showToast(`Ошибка валидации: ${err.message}`, "error");
        window.showBannerNotification(`<strong>Ошибка импорта JSON:</strong> ${err.message}`, 12);
      } finally {
        loadingOverlay.classList.add("hidden");
        // Clear value to allow re-uploading same file
        jsonFileInput.value = "";
      }
    };
    reader.onerror = function() {
      showToast("Не удалось прочитать файл!", "error");
      loadingOverlay.classList.add("hidden");
      jsonFileInput.value = "";
    };
    reader.readAsText(file);
  });
}

// ==========================================
// DETAILED JOURNALING & ANALYTICS MODULES
// ==========================================
let isAnalyticsActive = false;
let heatmapCurrentDate = new Date();
let currentNotesTradeId = null;
let currentScreenshotBase64 = "";
let currentScreenshots = [];
let activeScreenshotIndex = 0;

// 1. SCENARIOS (MULTIPLE TRADING STRATEGIES)
function initScenarios() {
  if (!state.scenarios) {
    try {
      state.scenarios =
        JSON.parse(localStorage.getItem("trade_scenarios")) || [];
    } catch (e) {
      state.scenarios = [];
    }
  }

  if (state.scenarios.length === 0) {
    state.scenarios = [
      {
        id: "scen-default",
        name: "Основная стратегия",
        balance: balance,
        tradeHistory: [...tradeHistory],
        positions: [...(state.positions || [])],
        description: "",
      },
      {
        id: "scen-scalping",
        name: "Скальпинг EMA",
        balance: 10000,
        tradeHistory: [],
        positions: [],
        description: "",
      },
      {
        id: "scen-breakout",
        name: "Пробой уровней",
        balance: 25000,
        tradeHistory: [],
        positions: [],
        description: "",
      },
    ];
    saveScenariosState();
  }

  state.activeScenarioId =
    localStorage.getItem("active_scenario_id") || "scen-default";

  let activeScen = state.scenarios.find((s) => s.id === state.activeScenarioId);
  if (!activeScen) {
    activeScen = state.scenarios[0];
    state.activeScenarioId = activeScen.id;
    localStorage.setItem("active_scenario_id", state.activeScenarioId);
  }

  syncCurrentScenarioState(true); // load from active

  const addScenBtn = document.getElementById("add-scenario-btn");
  addScenBtn?.addEventListener("click", async () => {
    const name = await showCustomPrompt(
      "Введите название новой торговой стратегии (сценария):",
      `Сценарий ${state.scenarios.length + 1}`,
    );
    if (name && name.trim()) {
      const initialBalancePrompt = await showCustomPrompt(
        "Введите начальный баланс для этого сценария ($):",
        "10000",
      );
      let initialBalance = parseFloat(initialBalancePrompt) || 10000;
      if (initialBalance <= 0) initialBalance = 10000;

      const newId = "scen-" + Date.now();
      const newScen = {
        id: newId,
        name: name.trim(),
        balance: initialBalance,
        tradeHistory: [],
        positions: [],
        description: "",
      };

      state.scenarios.push(newScen);
      saveScenariosState();
      switchScenario(newId);
      showToast(`Сценарий "${name}" успешно создан!`, "success");
    }
  });

  const descTextarea = document.getElementById("scenario-description-textarea");
  descTextarea?.addEventListener("input", () => {
    const active = state.scenarios.find((s) => s.id === state.activeScenarioId);
    if (active) {
      active.description = descTextarea.value;
      saveScenariosState();
    }
  });

  updateScenarioDescriptionUI();
  renderScenarioTabs();
}

function updateScenarioDescriptionUI() {
  const descTextarea = document.getElementById("scenario-description-textarea");
  if (!descTextarea) return;
  const active = state.scenarios.find((s) => s.id === state.activeScenarioId);
  if (active) {
    descTextarea.value = active.description || "";
  } else {
    descTextarea.value = "";
  }
}

function saveScenariosState() {
  localStorage.setItem("trade_scenarios", JSON.stringify(state.scenarios));
}

function syncCurrentScenarioState(loadFromActive = false) {
  if (!state.scenarios || !state.activeScenarioId) return;

  const idx = state.scenarios.findIndex((s) => s.id === state.activeScenarioId);
  if (idx === -1) return;

  if (loadFromActive) {
    balance = state.scenarios[idx].balance;
    tradeHistory = state.scenarios[idx].tradeHistory || [];
    state.positions = state.scenarios[idx].positions || [];

    localStorage.setItem("balance", balance.toString());
    localStorage.setItem(
      "oanda_sim_positions",
      JSON.stringify(state.positions),
    );
    localStorage.setItem("plbt_trade_history", JSON.stringify(tradeHistory));
    restoreVoiceNotesForTrades(tradeHistory);
  } else {
    state.scenarios[idx].balance = balance;
    state.scenarios[idx].tradeHistory = [...tradeHistory];
    state.scenarios[idx].positions = [...(state.positions || [])];
    saveScenariosState();
  }
}

function switchScenario(scenarioId) {
  if (!state.scenarios) return;

  syncCurrentScenarioState(false);

  state.activeScenarioId = scenarioId;
  localStorage.setItem("active_scenario_id", scenarioId);

  syncCurrentScenarioState(true);

  updateScenarioDescriptionUI();
  renderScenarioTabs();
  updateSimulatorUI();
  updateTradeHistoryUI();
  drawAllOnCanvas();

  showToast(
    `Переключено на стратегию: "${state.scenarios.find((s) => s.id === scenarioId)?.name}"`,
    "info",
  );
}

async function deleteScenario(scenarioId, event) {
  if (event) event.stopPropagation();
  if (!state.scenarios || state.scenarios.length <= 1) {
    showToast("Невозможно удалить единственный сценарий!", "error");
    return;
  }

  const idx = state.scenarios.findIndex((s) => s.id === scenarioId);
  if (idx === -1) return;

  const name = state.scenarios[idx].name;
  const confirmed = await showCustomConfirm(
    `Вы действительно хотите удалить сценарий "${name}"? Все сделки этого сценария будут стерты.`,
  );
  if (confirmed) {
    state.scenarios.splice(idx, 1);
    saveScenariosState();

    if (state.activeScenarioId === scenarioId) {
      state.activeScenarioId = state.scenarios[0].id;
      localStorage.setItem("active_scenario_id", state.activeScenarioId);
    }

    syncCurrentScenarioState(true);
    updateScenarioDescriptionUI();
    renderScenarioTabs();
    updateSimulatorUI();
    updateTradeHistoryUI();
    drawAllOnCanvas();
    showToast(`Сценарий "${name}" удален.`, "info");
  }
}

function renderScenarioTabs() {
  const container = document.getElementById("scenario-tabs-el");
  if (!container || !state.scenarios) return;

  container.innerHTML = "";
  state.scenarios.forEach((scen) => {
    const btn = document.createElement("button");
    btn.className = `scenario-tab-btn ${scen.id === state.activeScenarioId ? "active" : ""}`;
    btn.title = `Стратегия: ${scen.name} (Двойной клик для изменения названия)`;

    btn.innerHTML = `
            <span class="scenario-name-span">${scen.name}</span>
            <span class="scenario-tab-delete" title="Удалить сценарий">✕</span>
        `;

    btn.addEventListener("click", (e) => {
      if (e.target.classList.contains("scenario-tab-delete")) return;
      if (scen.id !== state.activeScenarioId) {
        switchScenario(scen.id);
      }
    });

    btn.addEventListener("dblclick", async (e) => {
      e.stopPropagation();
      const newName = await showCustomPrompt(
        "Введите новое название торговой стратегии:",
        scen.name,
      );
      if (newName && newName.trim()) {
        scen.name = newName.trim();
        saveScenariosState();
        renderScenarioTabs();
        showToast(`Сценарий переименован в "${scen.name}"`, "success");
      }
    });

    const deleteBtn = btn.querySelector(".scenario-tab-delete");
    deleteBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteScenario(scen.id, e);
    });

    container.appendChild(btn);
  });
}

// 2. TRADE DIARY MODAL (NOTES & SCREENSHOTS)
window.openTradeNotesModal = async (tradeId) => {
  let trade = tradeHistory.find((t) => String(t.id) === String(tradeId));
  if (!trade && state && Array.isArray(state.positions)) {
    trade = state.positions.find((p) => String(p.id) === String(tradeId));
  }
  if (!trade) return;

  currentNotesTradeId = tradeId;

  const modal = document.getElementById("notes-modal");
  if (modal) {
    modal.style.display = "flex";
    modal.classList.add("active");
  }

  const symbolStr = (trade.symbol || "").replace("_", "/");
  const pnlSign = (trade.pnl || 0) >= 0 ? "+" : "";
  const pnlStr = `${pnlSign}$${(trade.pnl || 0).toFixed(2)}`;
  
  const titleEl = document.getElementById("notes-modal-title");
  if (titleEl) {
    titleEl.innerHTML = `ДНЕВНИК СДЕЛКИ: <span style="color: var(--color-accent); font-weight: bold; font-family: var(--font-mono);">${symbolStr}</span> (${(trade.type || "BUY").toUpperCase()})`;
  }

  const badge = document.getElementById("notes-modal-badge");
  if (badge) {
    const isProfit = (trade.pnl || 0) >= 0;
    badge.style.display = "inline-block";
    badge.style.fontSize = "20px";
    badge.style.fontWeight = "500";
    badge.style.borderRadius = "8px";
    badge.style.padding = "6px 14px";
    badge.style.fontFamily = "var(--font-mono)";
    
    if (isProfit) {
      badge.style.background = "rgba(34, 197, 94, 0.12)";
      badge.style.border = "1px solid rgba(34, 197, 94, 0.3)";
      badge.style.color = "#4ade80";
    } else {
      badge.style.background = "rgba(239, 68, 68, 0.12)";
      badge.style.border = "1px solid rgba(239, 68, 68, 0.3)";
      badge.style.color = "#f87171";
    }
    badge.textContent = pnlStr;
  }

  const reasonSelect = document.getElementById("notes-modal-close-reason");
  if (reasonSelect) {
    reasonSelect.value = trade.close_reason || trade.reason || "MANUAL";
  }

  if (!trade.notes) {
    trade.notes = { noteBefore: "", noteDuring: "", noteAfter: "" };
  }

  const beforeVal = trade.thoughtBefore || trade.notes?.noteBefore || "";
  const duringVal = trade.thoughtDuring || trade.notes?.noteDuring || "";
  const afterVal = trade.thoughtAfter || trade.notes?.noteAfter || "";

  const noteBeforeInput = document.getElementById("note-before-input");
  const noteDuringInput = document.getElementById("note-during-input");
  const noteAfterInput = document.getElementById("note-after-input");
  if (noteBeforeInput) noteBeforeInput.value = beforeVal;
  if (noteDuringInput) noteDuringInput.value = duringVal;
  if (noteAfterInput) noteAfterInput.value = afterVal;

  if (Array.isArray(trade.screenshots) && trade.screenshots.length > 0) {
    currentScreenshots = [...trade.screenshots];
  } else if (trade.screenshot) {
    currentScreenshots = [trade.screenshot];
  } else {
    currentScreenshots = [];
  }
  activeScreenshotIndex = 0;
  currentScreenshotBase64 = currentScreenshots[0] || "";
  updateScreenshotPreviewUI();

  // Async load additional data from DB
  try {
    const dbScreenshots = await getData(`trade_screenshots_${tradeId}`);
    if (Array.isArray(dbScreenshots) && dbScreenshots.length > 0) {
      currentScreenshots = [...dbScreenshots];
      currentScreenshotBase64 = currentScreenshots[0] || "";
      updateScreenshotPreviewUI();
    }
  } catch (err) {
    console.error("Failed to load screenshots from IndexedDB:", err);
  }

  try {
    const dbThoughts = await getTradeThoughts(tradeId);
    if (dbThoughts) {
      if (noteBeforeInput && dbThoughts.thoughtBefore) noteBeforeInput.value = dbThoughts.thoughtBefore;
      if (noteDuringInput && dbThoughts.thoughtDuring) noteDuringInput.value = dbThoughts.thoughtDuring;
      if (noteAfterInput && dbThoughts.thoughtAfter) noteAfterInput.value = dbThoughts.thoughtAfter;
    }
  } catch (err) {
    console.error("Failed to load thoughts from IndexedDB:", err);
  }

  // Load voice notes from IndexedDB
  try {
    if (typeof window.loadAllVoiceNotes === "function") {
      const allVoiceNotes = await window.loadAllVoiceNotes();
      const beforeNote = allVoiceNotes.find(vn => vn.id === `voice_note_${tradeId}_before`);
      const timeNote = allVoiceNotes.find(vn => vn.id === `voice_note_${tradeId}_time`);
      const afterNote = allVoiceNotes.find(vn => vn.id === `voice_note_${tradeId}_after`);

      const bPlayer = document.getElementById("voice-audio-player-before");
      const bDelBtn = document.getElementById("voice-delete-btn-before");
      const bWrapper = document.getElementById("voice-audio-wrapper-before");
      if (bPlayer && bDelBtn) {
        if (beforeNote) {
          bPlayer.src = beforeNote.url;
          bPlayer.style.display = "none";
          bDelBtn.style.display = "inline-flex";
          if (bWrapper) bWrapper.style.display = "flex";
        } else {
          bPlayer.removeAttribute("src");
          bPlayer.load();
          bPlayer.style.display = "none";
          bDelBtn.style.display = "none";
          if (bWrapper) bWrapper.style.display = "none";
        }
        initCustomAudioPlayer("before");
      }

      const tPlayer = document.getElementById("voice-audio-player-time");
      const tDelBtn = document.getElementById("voice-delete-btn-time");
      const tWrapper = document.getElementById("voice-audio-wrapper-time");
      if (tPlayer && tDelBtn) {
        if (timeNote) {
          tPlayer.src = timeNote.url;
          tPlayer.style.display = "none";
          tDelBtn.style.display = "inline-flex";
          if (tWrapper) tWrapper.style.display = "flex";
        } else {
          tPlayer.removeAttribute("src");
          tPlayer.load();
          tPlayer.style.display = "none";
          tDelBtn.style.display = "none";
          if (tWrapper) tWrapper.style.display = "none";
        }
        initCustomAudioPlayer("time");
      }

      const aPlayer = document.getElementById("voice-audio-player-after");
      const aDelBtn = document.getElementById("voice-delete-btn-after");
      const aWrapper = document.getElementById("voice-audio-wrapper-after");
      if (aPlayer && aDelBtn) {
        if (afterNote) {
          aPlayer.src = afterNote.url;
          aPlayer.style.display = "none";
          aDelBtn.style.display = "inline-flex";
          if (aWrapper) aWrapper.style.display = "flex";
        } else {
          aPlayer.removeAttribute("src");
          aPlayer.load();
          aPlayer.style.display = "none";
          aDelBtn.style.display = "none";
          if (aWrapper) aWrapper.style.display = "none";
        }
        initCustomAudioPlayer("after");
      }
    }
  } catch (err) {
    console.error("Failed to load modal voice notes from IndexedDB:", err);
  }

  // Set up click handlers for recording buttons
  const recBtnBefore = document.getElementById("voice-record-btn-before");
  const recBtnTime = document.getElementById("voice-record-btn-time");
  const recBtnAfter = document.getElementById("voice-record-btn-after");

  if (recBtnBefore) recBtnBefore.onclick = () => toggleVoiceRecording(tradeId, "before");
  if (recBtnTime) recBtnTime.onclick = () => toggleVoiceRecording(tradeId, "time");
  if (recBtnAfter) recBtnAfter.onclick = () => toggleVoiceRecording(tradeId, "after");

  // Set up click handlers for delete buttons
  const delBtnBefore = document.getElementById("voice-delete-btn-before");
  const delBtnTime = document.getElementById("voice-delete-btn-time");
  const delBtnAfter = document.getElementById("voice-delete-btn-after");

  if (delBtnBefore) delBtnBefore.onclick = () => deleteModalVoiceNote(tradeId, "before");
  if (delBtnTime) delBtnTime.onclick = () => deleteModalVoiceNote(tradeId, "time");
  if (delBtnAfter) delBtnAfter.onclick = () => deleteModalVoiceNote(tradeId, "after");
};

let overlayCurrentIndex = 0;
let overlayScreenshots = [];

function openScreenshotOverlay(indexOrSrc, screenshotsList) {
  let overlay = document.getElementById("screenshot-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "screenshot-overlay";
    overlay.style.cssText = "display: none; justify-content: center; align-items: center; background: rgba(0,0,0,0.88); z-index: 30000; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;";
    overlay.innerHTML = `
      <div id="screenshot-overlay-content" style="position: relative; display: flex; flex-direction: column; align-items: center; gap: 15px; max-width: 90vw; max-height: 90vh;">
          <div style="position: relative; display: flex; justify-content: center; align-items: center; max-width: 100%;">
            <button id="screenshot-overlay-prev-btn" style="position: absolute; left: -50px; background: rgba(30, 41, 59, 0.9); color: white; border: 1px solid rgba(255,255,255,0.2); border-radius: 50%; width: 42px; height: 42px; cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.5); z-index: 10; outline: none;">&#10094;</button>
            <img id="screenshot-overlay-img" style="max-width: 100%; max-height: 75vh; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); object-fit: contain;" referrerPolicy="no-referrer" />
            <button id="screenshot-overlay-next-btn" style="position: absolute; right: -50px; background: rgba(30, 41, 59, 0.9); color: white; border: 1px solid rgba(255,255,255,0.2); border-radius: 50%; width: 42px; height: 42px; cursor: pointer; font-size: 18px; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(0,0,0,0.5); z-index: 10; outline: none;">&#10095;</button>
          </div>
          <div id="screenshot-overlay-controls" style="display: flex; gap: 14px; align-items: center; background: rgba(30, 41, 59, 0.9); padding: 8px 16px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15);" onclick="event.stopPropagation()">
              <span id="screenshot-overlay-counter" style="color: #94a3b8; font-size: 12px; font-weight: 600;">1 / 1</span>
              <label style="color: #94a3b8; font-size: 12px; font-weight: 600; margin: 0;">Качество для скачивания:</label>
              <select id="screenshot-overlay-quality" style="width: auto; height: 28px; padding: 0 8px; background: #1e293b; color: #f8fafc; border: 1px solid #475569; border-radius: 4px; font-size: 12px; outline: none; cursor: pointer;">
                  <option value="144p">144p (256x144)</option>
                  <option value="360p">360p (640x360)</option>
                  <option value="720p">720p (1280x720)</option>
                  <option value="1080p" selected>1080p (1920x1080)</option>
              </select>
              <button id="screenshot-overlay-download-btn" style="height: 28px; padding: 0 14px; font-size: 12px; font-weight: bold; background-color: var(--color-accent, #3b82f6); color: white; border: none; border-radius: 4px; cursor: pointer; font-family: var(--font-sans, inherit);">
                  Скачать
              </button>
          </div>
          <button id="screenshot-overlay-close-btn" style="position: absolute; top: -10px; right: -10px; background: rgba(239, 68, 68, 0.9); color: white; border: none; border-radius: 50%; width: 28px; height: 28px; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 10px rgba(0,0,0,0.3); outline: none;">✕</button>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", () => {
      overlay.style.display = "none";
    });

    const closeBtn = document.getElementById("screenshot-overlay-close-btn");
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      overlay.style.display = "none";
    });

    const prevBtn = document.getElementById("screenshot-overlay-prev-btn");
    prevBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (overlayScreenshots.length > 0) {
        overlayCurrentIndex = (overlayCurrentIndex - 1 + overlayScreenshots.length) % overlayScreenshots.length;
        updateOverlayImage();
      }
    });

    const nextBtn = document.getElementById("screenshot-overlay-next-btn");
    nextBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (overlayScreenshots.length > 0) {
        overlayCurrentIndex = (overlayCurrentIndex + 1) % overlayScreenshots.length;
        updateOverlayImage();
      }
    });

    window.addEventListener("keydown", (e) => {
      if (overlay.style.display === "flex") {
        if (e.key === "ArrowLeft" && overlayScreenshots.length > 1) {
          overlayCurrentIndex = (overlayCurrentIndex - 1 + overlayScreenshots.length) % overlayScreenshots.length;
          updateOverlayImage();
        } else if (e.key === "ArrowRight" && overlayScreenshots.length > 1) {
          overlayCurrentIndex = (overlayCurrentIndex + 1) % overlayScreenshots.length;
          updateOverlayImage();
        } else if (e.key === "Escape") {
          overlay.style.display = "none";
        }
      }
    });

    const downloadBtn = document.getElementById("screenshot-overlay-download-btn");
    downloadBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const imgElement = document.getElementById("screenshot-overlay-img");
      const qualitySelect = document.getElementById("screenshot-overlay-quality");
      downloadScreenshot(imgElement.src, qualitySelect.value);
    });
  }

  if (Array.isArray(screenshotsList) && screenshotsList.length > 0) {
    overlayScreenshots = [...screenshotsList];
    overlayCurrentIndex = typeof indexOrSrc === "number" ? indexOrSrc : 0;
  } else {
    overlayScreenshots = [typeof indexOrSrc === "string" ? indexOrSrc : ""];
    overlayCurrentIndex = 0;
  }

  updateOverlayImage();
  overlay.style.display = "flex";
}

function updateOverlayImage() {
  const overlayImg = document.getElementById("screenshot-overlay-img");
  const counterSpan = document.getElementById("screenshot-overlay-counter");
  const prevBtn = document.getElementById("screenshot-overlay-prev-btn");
  const nextBtn = document.getElementById("screenshot-overlay-next-btn");

  if (overlayImg && overlayScreenshots.length > 0) {
    overlayImg.src = overlayScreenshots[overlayCurrentIndex] || "";
  }
  if (counterSpan) {
    counterSpan.textContent = `${overlayCurrentIndex + 1} / ${overlayScreenshots.length}`;
  }
  if (prevBtn && nextBtn) {
    const showNav = overlayScreenshots.length > 1;
    prevBtn.style.display = showNav ? "flex" : "none";
    nextBtn.style.display = showNav ? "flex" : "none";
  }
}

function downloadScreenshot(imageData, quality) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.referrerPolicy = "no-referrer";
  img.onload = () => {
    let targetHeight = 1080;
    if (quality === "144p") targetHeight = 144;
    else if (quality === "360p") targetHeight = 360;
    else if (quality === "720p") targetHeight = 720;
    else if (quality === "1080p") targetHeight = 1080;

    const originalWidth = img.naturalWidth || img.width || 800;
    const originalHeight = img.naturalHeight || img.height || 600;
    const aspectRatio = originalWidth / originalHeight;
    const targetWidth = Math.round(targetHeight * aspectRatio);

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
      try {
        const url = canvas.toDataURL("image/png");
        const a = document.createElement("a");
        a.href = url;
        a.download = `diary_screenshot_${quality}_${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        showToast("Скриншот успешно скачан!", "success");
      } catch (err) {
        console.error("Не удалось скачать скриншот:", err);
        showToast("Не удалось скачать скриншот!", "error");
      }
    }
  };
  img.src = imageData;
}

function updateScreenshotPreviewUI() {
  const emptyState = document.getElementById("screenshot-empty-state");
  const previewContainer = document.getElementById("note-screenshot-preview-container");
  const uploadBtn = document.getElementById("note-upload-btn");
  if (!previewContainer) return;

  if (activeScreenshotIndex < 0) activeScreenshotIndex = 0;
  if (activeScreenshotIndex >= currentScreenshots.length && currentScreenshots.length > 0) {
    activeScreenshotIndex = currentScreenshots.length - 1;
  }

  // Update upload button visual state
  if (uploadBtn) {
    if (currentScreenshots.length >= 10) {
      uploadBtn.disabled = true;
      uploadBtn.style.opacity = "0.5";
      uploadBtn.style.cursor = "not-allowed";
      uploadBtn.title = "Достигнут лимит 10 скриншотов";
      const btnSpan = uploadBtn.querySelector("span");
      if (btnSpan) btnSpan.textContent = "Лимит (10/10)";
    } else {
      uploadBtn.disabled = false;
      uploadBtn.style.opacity = "1";
      uploadBtn.style.cursor = "pointer";
      uploadBtn.title = "Загрузить скриншот";
      const btnSpan = uploadBtn.querySelector("span");
      if (btnSpan) btnSpan.textContent = `Добавить скриншот (${currentScreenshots.length}/10)`;
    }
  }

  // Remove existing elements
  const existingThumbs = previewContainer.querySelectorAll(".screenshot-thumbnail-wrapper, .screenshot-header-info");
  existingThumbs.forEach(thumb => thumb.remove());

  const existingLargePreview = previewContainer.querySelector(".screenshot-large-preview-container");
  if (existingLargePreview) existingLargePreview.remove();

  const activePreview = document.getElementById("screenshot-active-preview");
  if (activePreview) activePreview.style.display = "none";

  if (currentScreenshots && currentScreenshots.length > 0) {
    if (emptyState) emptyState.style.display = "none";

    previewContainer.style.height = "auto";
    previewContainer.style.minHeight = "160px";
    previewContainer.style.display = "flex";
    previewContainer.style.flexDirection = "column";
    previewContainer.style.gap = "12px";
    previewContainer.style.padding = "14px";
    previewContainer.style.justifyContent = "flex-start";
    previewContainer.style.border = "1px solid rgba(255, 255, 255, 0.1)";
    previewContainer.style.backgroundColor = "rgba(0, 0, 0, 0.3)";
    previewContainer.style.borderRadius = "8px";

    // Header counter row
    const thumbsHeader = document.createElement("div");
    thumbsHeader.className = "screenshot-header-info";
    thumbsHeader.style.cssText = "display: flex; justify-content: space-between; align-items: center; width: 100%; font-size: 12px; color: #94a3b8; font-weight: 500;";
    thumbsHeader.innerHTML = `
      <span>Галерея скриншотов (${currentScreenshots.length} из 10):</span>
      ${currentScreenshots.length >= 10 ? '<span style="color: #f87171; font-size: 11px; font-weight: bold;">⚠️ Максимум 10 скриншотов</span>' : ''}
    `;
    previewContainer.appendChild(thumbsHeader);

    // Thumbs row container
    const thumbsRowContainer = document.createElement("div");
    thumbsRowContainer.className = "screenshot-thumbnail-wrapper";
    thumbsRowContainer.style.cssText = "display: flex; flex-wrap: wrap; gap: 8px; width: 100%;";
    previewContainer.appendChild(thumbsRowContainer);

    currentScreenshots.forEach((src, idx) => {
      const thumb = document.createElement("div");
      const isSelected = idx === activeScreenshotIndex;
      thumb.style.cssText = `position: relative; width: 64px; height: 64px; border-radius: 6px; border: ${isSelected ? "2px solid var(--color-accent, #38bdf8)" : "1px solid rgba(255,255,255,0.15)"}; overflow: hidden; background: rgba(0,0,0,0.3); flex-shrink: 0; cursor: pointer; transition: all 0.15s;`;

      const img = document.createElement("img");
      img.src = src;
      img.style.cssText = "width: 100%; height: 100%; object-fit: cover; display: block;";
      img.referrerPolicy = "no-referrer";
      img.onclick = (e) => {
        e.stopPropagation();
        activeScreenshotIndex = idx;
        updateScreenshotPreviewUI();
      };
      thumb.appendChild(img);

      const delBtn = document.createElement("button");
      delBtn.className = "screenshot-thumb-delete-btn";
      delBtn.innerText = "✕";
      delBtn.title = "Удалить скриншот";
      delBtn.style.cssText = "position: absolute; top: 2px; right: 2px; background: rgba(239, 68, 68, 0.9); color: #ffffff; border: none; border-radius: 50%; width: 18px; height: 18px; display: flex; align-items: center; justify-content: center; font-size: 9px; font-weight: bold; cursor: pointer; outline: none; box-shadow: 0 1px 4px rgba(0,0,0,0.6);";

      delBtn.onclick = async (e) => {
        e.stopPropagation();
        currentScreenshots.splice(idx, 1);
        if (activeScreenshotIndex >= currentScreenshots.length) {
          activeScreenshotIndex = Math.max(0, currentScreenshots.length - 1);
        }
        if (currentNotesTradeId) {
          try {
            await saveData(`trade_screenshots_${currentNotesTradeId}`, currentScreenshots);
          } catch (err) {
            console.error("IndexedDB screenshot update failed:", err);
          }
        }
        updateScreenshotPreviewUI();
      };

      thumb.appendChild(delBtn);
      thumbsRowContainer.appendChild(thumb);
    });

    // Large preview container
    const largePreviewContainer = document.createElement("div");
    largePreviewContainer.className = "screenshot-large-preview-container";
    largePreviewContainer.style.cssText = "width: 100%; margin-top: 4px; position: relative; border-radius: 6px; overflow: hidden; border: 1px solid rgba(255,255,255,0.08); background: rgba(0,0,0,0.5); display: flex; justify-content: center; align-items: center;";

    const largeImg = document.createElement("img");
    largeImg.src = currentScreenshots[activeScreenshotIndex];
    largeImg.style.cssText = "width: 100%; max-height: 320px; object-fit: contain; display: block; cursor: zoom-in;";
    largeImg.referrerPolicy = "no-referrer";
    largeImg.onclick = () => {
      openScreenshotOverlay(activeScreenshotIndex, currentScreenshots);
    };
    largePreviewContainer.appendChild(largeImg);

    if (currentScreenshots.length > 1) {
      const prevBtn = document.createElement("button");
      prevBtn.innerHTML = "&#10094;";
      prevBtn.title = "Предыдущий скриншот";
      prevBtn.style.cssText = "position: absolute; left: 8px; top: 50%; transform: translateY(-50%); background: rgba(15, 23, 42, 0.85); color: white; border: 1px solid rgba(255,255,255,0.2); border-radius: 50%; width: 32px; height: 32px; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; outline: none;";
      prevBtn.onclick = (e) => {
        e.stopPropagation();
        activeScreenshotIndex = (activeScreenshotIndex - 1 + currentScreenshots.length) % currentScreenshots.length;
        updateScreenshotPreviewUI();
      };

      const nextBtn = document.createElement("button");
      nextBtn.innerHTML = "&#10095;";
      nextBtn.title = "Следующий скриншот";
      nextBtn.style.cssText = "position: absolute; right: 8px; top: 50%; transform: translateY(-50%); background: rgba(15, 23, 42, 0.85); color: white; border: 1px solid rgba(255,255,255,0.2); border-radius: 50%; width: 32px; height: 32px; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; outline: none;";
      nextBtn.onclick = (e) => {
        e.stopPropagation();
        activeScreenshotIndex = (activeScreenshotIndex + 1) % currentScreenshots.length;
        updateScreenshotPreviewUI();
      };

      largePreviewContainer.appendChild(prevBtn);
      largePreviewContainer.appendChild(nextBtn);
    }

    previewContainer.appendChild(largePreviewContainer);
  } else {
    if (emptyState) emptyState.style.display = "flex";
    previewContainer.style.height = "auto";
    previewContainer.style.minHeight = "0";
    previewContainer.style.border = "none";
    previewContainer.style.background = "none";
    previewContainer.style.padding = "0";
    previewContainer.style.marginTop = "6px";
    previewContainer.style.display = "block";
  }
}

function initNotesModalEvents() {
  const modal = document.getElementById("notes-modal");
  const closeHeaderBtn = document.getElementById("notes-close-header-btn");
  const cancelBtn = document.getElementById("notes-cancel-btn");
  const saveBtn = document.getElementById("notes-save-btn");
  const uploadBtn = document.getElementById("note-upload-btn");
  const fileInput = document.getElementById("note-screenshot-input");
  const deleteScreenshotBtn = document.getElementById(
    "note-delete-screenshot-btn",
  );
  const previewContainer = document.getElementById(
    "note-screenshot-preview-container",
  );

  const closeModal = () => {
    if (modal) {
      modal.style.display = "none";
      modal.classList.remove("active");
    }
    if (mediaRecorder && mediaRecorder.state === "recording") {
      try {
        mediaRecorder.stop();
      } catch (err) {
        console.error("Failed to stop media recorder on close:", err);
      }
    }
    ['before', 'time', 'after'].forEach(key => {
      const player = document.getElementById(`voice-audio-player-${key}`);
      if (player) {
        try {
          player.pause();
          player.currentTime = 0;
        } catch (err) {
          console.error(`Failed to pause audio player-${key} on close:`, err);
        }
      }
    });
    currentNotesTradeId = null;
    currentScreenshotBase64 = "";
  };

  closeHeaderBtn?.addEventListener("click", closeModal);
  cancelBtn?.addEventListener("click", closeModal);

  modal?.addEventListener("click", (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });

  uploadBtn?.addEventListener("click", () => {
    if (currentScreenshots.length >= 10) {
      showToast("Достигнут лимит 10 скриншотов на сделку!", "error");
      return;
    }
    fileInput?.click();
  });

  const processImageFiles = (files) => {
    if (!files || files.length === 0) return;
    const remainingSpace = 10 - currentScreenshots.length;
    if (remainingSpace <= 0) {
      showToast("Достигнут лимит 10 скриншотов на сделку!", "error");
      return;
    }
    const validFiles = Array.from(files).filter(f => f.type.startsWith("image/"));
    if (validFiles.length > remainingSpace) {
      showToast(`Загружены первые ${remainingSpace} файлов. Лимит: 10 скриншотов.`, "warning");
    }
    const filesToProcess = validFiles.slice(0, remainingSpace);
    let countProcessed = 0;
    filesToProcess.forEach((file) => {
      const reader = new FileReader();
      reader.onload = async (event) => {
        if (currentScreenshots.length < 10) {
          currentScreenshots.push(event.target.result);
        }
        countProcessed++;
        if (countProcessed === filesToProcess.length) {
          activeScreenshotIndex = currentScreenshots.length - 1;
          if (currentNotesTradeId) {
            try {
              await saveData(`trade_screenshots_${currentNotesTradeId}`, currentScreenshots);
            } catch (err) {
              console.error("IndexedDB screenshot save failed:", err);
            }
          }
          updateScreenshotPreviewUI();
        }
      };
      reader.readAsDataURL(file);
    });
  };

  fileInput?.addEventListener("change", (e) => {
    processImageFiles(e.target.files);
    if (fileInput) fileInput.value = "";
  });

  previewContainer?.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (previewContainer) {
      previewContainer.style.borderColor = "var(--color-accent)";
      previewContainer.style.background = "rgba(59, 130, 246, 0.05)";
    }
  });

  const resetDragStyles = () => {
    if (previewContainer) {
      previewContainer.style.borderColor = "rgba(255, 255, 255, 0.06)";
      previewContainer.style.background = "rgba(0, 0, 0, 0.2)";
    }
  };

  previewContainer?.addEventListener("dragleave", resetDragStyles);
  previewContainer?.addEventListener("dragend", resetDragStyles);

  previewContainer?.addEventListener("drop", (e) => {
    e.preventDefault();
    resetDragStyles();
    if (e.dataTransfer?.files) {
      processImageFiles(e.dataTransfer.files);
    }
  });

  deleteScreenshotBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    currentScreenshots = [];
    currentScreenshotBase64 = "";
    activeScreenshotIndex = 0;
    if (currentNotesTradeId) {
      try {
        await saveData(`trade_screenshots_${currentNotesTradeId}`, []);
      } catch (err) {
        console.error("IndexedDB screenshot deletion failed:", err);
      }
    }
    updateScreenshotPreviewUI();
    if (fileInput) fileInput.value = "";
  });

  const debounce = (func, delay) => {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => func(...args), delay);
    };
  };

  const autoSaveThoughts = debounce(async () => {
    if (!currentNotesTradeId) return;
    const trade = tradeHistory.find((t) => t.id === currentNotesTradeId);
    if (!trade) return;

    const beforeVal = document.getElementById("note-before-input").value;
    const duringVal = document.getElementById("note-during-input").value;
    const afterVal = document.getElementById("note-after-input").value;

    if (!trade.notes) {
      trade.notes = { noteBefore: "", noteDuring: "", noteAfter: "" };
    }

    trade.notes.noteBefore = beforeVal;
    trade.notes.noteDuring = duringVal;
    trade.notes.noteAfter = afterVal;

    trade.thoughtBefore = beforeVal;
    trade.thoughtDuring = duringVal;
    trade.thoughtAfter = afterVal;

    try {
      await saveTradeThoughts(currentNotesTradeId, beforeVal, duringVal, afterVal);
      await saveData(`trade_screenshots_${currentNotesTradeId}`, currentScreenshots);
    } catch (err) {
      console.error("Auto-save to IndexedDB failed:", err);
    }

    saveSimulatorState();
    updateTradeHistoryUI();
    if (typeof updateJournalMotivationUI === "function") updateJournalMotivationUI();
    if (typeof evaluateAndNotifyAchievements === "function") evaluateAndNotifyAchievements(false);
  }, 500);

  const beforeInput = document.getElementById("note-before-input");
  const duringInput = document.getElementById("note-during-input");
  const afterInput = document.getElementById("note-after-input");

  beforeInput?.addEventListener("input", autoSaveThoughts);
  duringInput?.addEventListener("input", autoSaveThoughts);
  afterInput?.addEventListener("input", autoSaveThoughts);

  beforeInput?.addEventListener("blur", autoSaveThoughts);
  duringInput?.addEventListener("blur", autoSaveThoughts);
  afterInput?.addEventListener("blur", autoSaveThoughts);

  const reasonSelectEl = document.getElementById("notes-modal-close-reason");
  reasonSelectEl?.addEventListener("change", (e) => {
    if (!currentNotesTradeId) return;
    const trade = tradeHistory.find((t) => t.id === currentNotesTradeId);
    if (trade) {
      trade.close_reason = e.target.value;
      saveSimulatorState();
      updateTradeHistoryUI();
    }
  });

  saveBtn?.addEventListener("click", async () => {
    if (!currentNotesTradeId) return;

    const trade = tradeHistory.find((t) => t.id === currentNotesTradeId);
    if (trade) {
      if (!trade.notes) {
        trade.notes = { noteBefore: "", noteDuring: "", noteAfter: "" };
      }

      const beforeVal = document.getElementById("note-before-input").value;
      const duringVal = document.getElementById("note-during-input").value;
      const afterVal = document.getElementById("note-after-input").value;

      const reasonVal = document.getElementById("notes-modal-close-reason")?.value;
      if (reasonVal) {
        trade.close_reason = reasonVal;
      }

      trade.notes.noteBefore = beforeVal;
      trade.notes.noteDuring = duringVal;
      trade.notes.noteAfter = afterVal;

      trade.thoughtBefore = beforeVal;
      trade.thoughtDuring = duringVal;
      trade.thoughtAfter = afterVal;

      try {
        await saveTradeThoughts(currentNotesTradeId, beforeVal, duringVal, afterVal);
        await saveData(`trade_screenshots_${currentNotesTradeId}`, currentScreenshots);
      } catch (err) {
        console.error("Manual save to IndexedDB failed:", err);
      }

      saveSimulatorState();

      showToast("Дневник сделки успешно обновлен!", "success");
      closeModal();
      updateTradeHistoryUI();
      if (typeof updateJournalMotivationUI === "function") updateJournalMotivationUI();
      if (typeof evaluateAndNotifyAchievements === "function") evaluateAndNotifyAchievements(false);
    }
  });
}

function generateFallbackEconomicEvents(fromStr, toStr) {
  const startDate = new Date(fromStr);
  const endDate = new Date(toStr);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return [];

  const templateEvents = [
    { currency: "USD", impact: "high", event: "Решение по процентной ставке ФРС (Fed Rate)", time: "21:00", actual: "5.25%", forecast: "5.25%", previous: "5.50%" },
    { currency: "USD", impact: "high", event: "Индекс потребительских цен (CPI y/y)", time: "15:30", actual: "3.1%", forecast: "3.2%", previous: "3.4%" },
    { currency: "USD", impact: "high", event: "Число занятых в несельскохозяйственном секторе (NFP)", time: "15:30", actual: "216K", forecast: "170K", previous: "173K" },
    { currency: "USD", impact: "medium", event: "Заявки на пособие по безработице (Initial Jobless Claims)", time: "15:30", actual: "202K", forecast: "210K", previous: "211K" },
    { currency: "EUR", impact: "high", event: "Решение ЕЦБ по процентной ставке", time: "15:15", actual: "4.50%", forecast: "4.50%", previous: "4.50%" },
    { currency: "EUR", impact: "high", event: "Пресс-конференция ЕЦБ (ECB Press Conference)", time: "15:45", actual: "—", forecast: "—", previous: "—" },
    { currency: "EUR", impact: "medium", event: "Индекс деловой активности в секторе услуг (Services PMI)", time: "11:00", actual: "48.8", forecast: "48.1", previous: "47.8" },
    { currency: "GBP", impact: "high", event: "Решение Банка Англии по процентной ставке", time: "14:00", actual: "5.25%", forecast: "5.25%", previous: "5.25%" },
    { currency: "GBP", impact: "medium", event: "Объём розничных продаж (m/m)", time: "09:00", actual: "1.3%", forecast: "0.4%", previous: "-0.2%" },
    { currency: "JPY", impact: "high", event: "Решение Банка Японии по процентной ставке", time: "06:00", actual: "0.10%", forecast: "0.10%", previous: "0.00%" },
    { currency: "JPY", impact: "medium", event: "Индекс потребительских цен Токио (CPI)", time: "02:30", actual: "2.4%", forecast: "2.5%", previous: "2.6%" },
    { currency: "AUD", impact: "high", event: "Решение Резервного банка Австралии (RBA)", time: "07:30", actual: "4.35%", forecast: "4.35%", previous: "4.35%" },
    { currency: "CAD", impact: "medium", event: "Изменение занятости в Канаде", time: "15:30", actual: "12.3K", forecast: "15.0K", previous: "24.9K" }
  ];

  const events = [];
  const curr = new Date(startDate);
  while (curr <= endDate) {
    const dayOfWeek = curr.getDay();
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      const year = curr.getFullYear();
      const month = String(curr.getMonth() + 1).padStart(2, "0");
      const day = String(curr.getDate()).padStart(2, "0");
      const dateStr = `${year}-${month}-${day}`;

      const dayHash = (curr.getDate() * 7 + (curr.getMonth() + 1) * 13) % templateEvents.length;
      const evCount = 2 + (curr.getDate() % 3);
      for (let i = 0; i < evCount; i++) {
        const evTemplate = templateEvents[(dayHash + i * 3) % templateEvents.length];
        events.push({
          date: dateStr,
          is_mock: true,
          ...evTemplate
        });
      }
    }
    curr.setDate(curr.getDate() + 1);
  }

  return events;
}

function fetchCalendarData(from, to) {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), 1200) : null;

  return fetch(`http://127.0.0.1:8001/economic-calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, {
    signal: controller ? controller.signal : undefined
  })
    .then((response) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error(`HTTP status: ${response.status}`);
      }
      return response.json();
    })
    .catch(() => {
      if (timeoutId) clearTimeout(timeoutId);
      return generateFallbackEconomicEvents(from, to);
    });
}

let rawCalendarEvents = [];
let activeCalendarCurrencyFilters = JSON.parse(localStorage.getItem("plbt_calendar_currency_filters") || "[]");

function getActiveCurrenciesSet() {
  if (!activeCalendarCurrencyFilters || activeCalendarCurrencyFilters.length === 0 || activeCalendarCurrencyFilters.includes("ALL")) {
    return null;
  }
  const set = new Set();
  activeCalendarCurrencyFilters.forEach(item => {
    if (item.includes("/")) {
      item.split("/").forEach(p => set.add(p.trim().toUpperCase()));
    } else {
      set.add(item.trim().toUpperCase());
    }
  });
  return set;
}

function renderCalendarCurrencyChips() {
  const container = document.getElementById("calendar-currency-chips");
  if (!container) return;

  const chipOptions = [
    { label: "Все события", value: "ALL" },
    { label: "EUR/USD", value: "EUR/USD" },
    { label: "GBP/USD", value: "GBP/USD" },
    { label: "USD/JPY", value: "USD/JPY" },
    { label: "AUD/USD", value: "AUD/USD" },
    { label: "USD/CAD", value: "USD/CAD" },
    { label: "USD/CHF", value: "USD/CHF" },
    { label: "NZD/USD", value: "NZD/USD" },
    { label: "EUR/GBP", value: "EUR/GBP" },
    { label: "EUR/JPY", value: "EUR/JPY" },
    { label: "GBP/JPY", value: "GBP/JPY" },
    { label: "EUR", value: "EUR" },
    { label: "USD", value: "USD" },
    { label: "GBP", value: "GBP" },
    { label: "JPY", value: "JPY" },
    { label: "AUD", value: "AUD" },
    { label: "CAD", value: "CAD" },
    { label: "CHF", value: "CHF" },
    { label: "NZD", value: "NZD" }
  ];

  const isAllActive = !activeCalendarCurrencyFilters || activeCalendarCurrencyFilters.length === 0 || activeCalendarCurrencyFilters.includes("ALL");

  container.innerHTML = chipOptions.map(opt => {
    const isActive = opt.value === "ALL" ? isAllActive : activeCalendarCurrencyFilters.includes(opt.value);
    const bg = isActive ? "var(--color-accent, #38bdf8)" : "rgba(255, 255, 255, 0.06)";
    const color = isActive ? "#000000" : "#d1d5db";
    const border = isActive ? "1px solid var(--color-accent, #38bdf8)" : "1px solid rgba(255, 255, 255, 0.12)";
    const fontWeight = isActive ? "700" : "500";
    return `<button class="calendar-currency-chip" data-val="${opt.value}" style="padding: 4px 10px; font-size: 11px; font-weight: ${fontWeight}; background: ${bg}; color: ${color}; border: ${border}; border-radius: 4px; cursor: pointer; transition: all 0.15s; outline: none;">${opt.label}</button>`;
  }).join("");

  container.querySelectorAll(".calendar-currency-chip").forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const val = btn.getAttribute("data-val");
      if (val === "ALL") {
        activeCalendarCurrencyFilters = [];
      } else {
        const idx = activeCalendarCurrencyFilters.indexOf(val);
        if (idx >= 0) {
          activeCalendarCurrencyFilters.splice(idx, 1);
        } else {
          const allIdx = activeCalendarCurrencyFilters.indexOf("ALL");
          if (allIdx >= 0) activeCalendarCurrencyFilters.splice(allIdx, 1);
          activeCalendarCurrencyFilters.push(val);
        }
      }
      localStorage.setItem("plbt_calendar_currency_filters", JSON.stringify(activeCalendarCurrencyFilters));
      renderCalendarCurrencyChips();
      renderCalendar(rawCalendarEvents, true);
    };
  });
}

function renderCalendar(events, isFilterOnly = false) {
  const container = document.getElementById("calendar-container");
  if (!container) return;

  if (events) {
    rawCalendarEvents = events;
  } else {
    events = rawCalendarEvents;
  }

  renderCalendarCurrencyChips();

  const activeCurrenciesSet = getActiveCurrenciesSet();
  let filteredEvents = events;
  if (activeCurrenciesSet && activeCurrenciesSet.size > 0) {
    filteredEvents = events.filter(ev => activeCurrenciesSet.has((ev.currency || "").trim().toUpperCase()));
  }

  if (!filteredEvents || filteredEvents.length === 0) {
    container.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; color: #9ca3af; gap: 8px; padding: 40px 0;">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity: 0.5;"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        <span>Нет важных экономических событий по выбранным критериям</span>
      </div>
    `;
    return;
  }

  // Group events by date
  const grouped = {};
  filteredEvents.forEach((ev) => {
    if (!grouped[ev.date]) {
      grouped[ev.date] = [];
    }
    grouped[ev.date].push(ev);
  });

  let html = `
    <div style="width: 100%; overflow-x: auto;">
      <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; color: #e2e8f0;">
        <thead>
          <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.1); background: rgba(15, 23, 42, 0.4);">
            <th style="padding: 10px 12px; font-weight: 600; color: #94a3b8; width: 90px;">Время</th>
            <th style="padding: 10px 12px; font-weight: 600; color: #94a3b8; width: 80px;">Валюта</th>
            <th style="padding: 10px 12px; font-weight: 600; color: #94a3b8; width: 100px;">Важность</th>
            <th style="padding: 10px 12px; font-weight: 600; color: #94a3b8;">Событие</th>
            <th style="padding: 10px 12px; font-weight: 600; color: #94a3b8; width: 100px; text-align: right;">Факт</th>
            <th style="padding: 10px 12px; font-weight: 600; color: #94a3b8; width: 100px; text-align: right;">Прогноз</th>
            <th style="padding: 10px 12px; font-weight: 600; color: #94a3b8; width: 100px; text-align: right;">Предыд.</th>
          </tr>
        </thead>
        <tbody>
  `;

  // Sort dates
  const sortedDates = Object.keys(grouped).sort();

  sortedDates.forEach((dateStr) => {
    const dateObj = new Date(dateStr);
    const formattedDate = dateObj.toLocaleDateString("ru-RU", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    html += `
      <tr style="background: rgba(30, 41, 59, 0.3);">
        <td colspan="7" style="padding: 10px 12px; font-weight: bold; color: var(--color-accent, #38bdf8); border-bottom: 1px solid rgba(255, 255, 255, 0.05); text-transform: capitalize;">
          ${formattedDate}
        </td>
      </tr>
    `;

    grouped[dateStr].forEach((ev) => {
      let impactBadge = "";
      if (ev.impact === "high") {
        impactBadge = `<span style="background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3); padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase;">Высокая</span>`;
      } else if (ev.impact === "medium") {
        impactBadge = `<span style="background: rgba(245, 158, 11, 0.15); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase;">Средняя</span>`;
      } else if (ev.impact === "low") {
        impactBadge = `<span style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase;">Низкая</span>`;
      } else {
        impactBadge = `<span style="background: rgba(107, 114, 128, 0.15); color: #9ca3af; border: 1px solid rgba(107, 114, 128, 0.3); padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase;">Нет</span>`;
      }

      // Check actual vs forecast values to color actual
      let actualColorStyle = "color: #fff;";
      if (ev.actual && ev.forecast) {
        try {
          const actNum = parseFloat(ev.actual.replace(/[^0-9.-]/g, ""));
          const fcNum = parseFloat(ev.forecast.replace(/[^0-9.-]/g, ""));
          if (!isNaN(actNum) && !isNaN(fcNum)) {
            if (actNum > fcNum) {
              actualColorStyle = "color: #34d399; font-weight: bold;";
            } else if (actNum < fcNum) {
              actualColorStyle = "color: #f87171; font-weight: bold;";
            }
          }
        } catch (e) {}
      }

      const mockBadge = ev.is_mock === true
        ? `<span title="Реальные данные ForexFactory временно недоступны. Показаны демонстрационные события для тестирования интерфейса." style="display: inline-flex; align-items: center; gap: 3px; margin-left: 8px; padding: 1px 6px; border-radius: 4px; font-size: 10px; font-weight: 600; color: #fbbf24; background: rgba(245, 158, 11, 0.12); border: 1px solid rgba(245, 158, 11, 0.3); vertical-align: middle; cursor: help; letter-spacing: 0.02em; user-select: none;">
             <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0; opacity: 0.85;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
             Demo
           </span>`
        : "";

      html += `
        <tr style="border-bottom: 1px solid rgba(255, 255, 255, 0.03); transition: background 0.1s; background: transparent;" onmouseover="this.style.backgroundColor='rgba(255,255,255,0.02)'" onmouseout="this.style.backgroundColor='transparent'">
          <td style="padding: 10px 12px; color: #cbd5e1; font-family: monospace;">${ev.time || "All Day"}</td>
          <td style="padding: 10px 12px; font-weight: 600; color: #fff;">${ev.currency}</td>
          <td style="padding: 10px 12px;">${impactBadge}</td>
          <td style="padding: 10px 12px; color: #e2e8f0; font-weight: 500;">
            <span style="vertical-align: middle;">${ev.event}</span>${mockBadge}
          </td>
          <td style="padding: 10px 12px; text-align: right; ${actualColorStyle}">${ev.actual || "—"}</td>
          <td style="padding: 10px 12px; text-align: right; color: #94a3b8; font-family: monospace;">${ev.forecast || "—"}</td>
          <td style="padding: 10px 12px; text-align: right; color: #94a3b8; font-family: monospace;">${ev.previous || "—"}</td>
        </tr>
      `;
    });
  });

  html += `
        </tbody>
      </table>
    </div>
  `;

  container.innerHTML = html;
}

function initCalendarModalEvents() {
  const toggleBtn = document.getElementById("toggle-calendar-btn");
  const modal = document.getElementById("calendar-modal");
  const closeHeaderBtn = document.getElementById("calendar-close-header-btn");
  const container = document.getElementById("calendar-container");

  if (!toggleBtn || !modal || !closeHeaderBtn || !container) {
    console.warn("Calendar modal elements not found");
    return;
  }

  const spinner = document.getElementById("calendar-loading-spinner");
  const fromInput = document.getElementById("calendar-from-date");
  const toInput = document.getElementById("calendar-to-date");
  const fetchBtn = document.getElementById("calendar-fetch-btn");
  const quickRangeBtns = document.querySelectorAll(".calendar-quick-range");

  // Format date helper: YYYY-MM-DD
  const formatDate = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  const getActiveSimulationDate = () => {
    if (state.isBacktestActive && state.backtestVisibleCandles && state.backtestVisibleCandles.length > 0) {
      const lastCandle = state.backtestVisibleCandles[state.backtestVisibleCandles.length - 1];
      if (lastCandle && lastCandle.time) {
        const t = typeof lastCandle.time === "number" ? lastCandle.time * 1000 : lastCandle.time;
        return new Date(t);
      }
    }
    return new Date();
  };

  const setDefaultDates = (daysBack = 1, daysForward = 1) => {
    const baseDate = getActiveSimulationDate();
    const fromDate = new Date(baseDate);
    fromDate.setDate(fromDate.getDate() - daysBack);
    const toDate = new Date(baseDate);
    toDate.setDate(toDate.getDate() + daysForward);

    if (fromInput) fromInput.value = formatDate(fromDate);
    if (toInput) toInput.value = formatDate(toDate);
  };

  const loadData = () => {
    if (!fromInput || !toInput) return;

    if (spinner) spinner.style.display = "flex";

    fetchCalendarData(fromInput.value, toInput.value)
      .then((events) => {
        renderCalendar(events);
      })
      .finally(() => {
        if (spinner) spinner.style.display = "none";
      });
  };

  // Setup quick range button click handlers
  quickRangeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const days = parseInt(btn.getAttribute("data-days") || "0", 10);
      if (days === 0) {
        setDefaultDates(0, 0);
      } else {
        setDefaultDates(days, 0);
      }
      loadData();
    });
  });

  if (fetchBtn) {
    fetchBtn.addEventListener("click", loadData);
  }

  const openModal = () => {
    modal.style.display = "flex";
    modal.classList.add("active");

    setDefaultDates(3, 1);
    loadData();
  };

  const closeModal = () => {
    modal.style.display = "none";
    modal.classList.remove("active");
  };

  toggleBtn.addEventListener("click", openModal);
  closeHeaderBtn.addEventListener("click", closeModal);

  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });
}

// 3. DETAILED ANALYTICS (EQUITY CURVE & HEATMAP)
function drawPnLEquityChart() {
  const canvas = document.getElementById("pnl-equity-canvas");
  if (!canvas) return;

  const wrapper = canvas.parentElement;
  if (!wrapper) return;

  canvas.width = wrapper.clientWidth;
  canvas.height = wrapper.clientHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const filteredHistory = filterTrades(tradeHistory);

  const points = [10000];
  if (state.scenarios && state.activeScenarioId) {
    const activeScen = state.scenarios.find(
      (s) => s.id === state.activeScenarioId,
    );
    if (activeScen) {
      const totalPnL = filteredHistory.reduce(
        (sum, t) => sum + (t.pnl || 0),
        0,
      );
      points[0] = Math.max(100, activeScen.balance - totalPnL);
    }
  }

  let tempBalance = points[0];
  filteredHistory.forEach((trade) => {
    tempBalance += trade.pnl || 0;
    points.push(tempBalance);
  });

  const numPoints = points.length;
  if (numPoints < 2) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
    ctx.font = "11px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      "Недостаточно данных для графика PnL. Совершите хотя бы одну сделку.",
      canvas.width / 2,
      canvas.height / 2,
    );
    return;
  }

  const padding = { top: 20, right: 25, bottom: 25, left: 55 };
  const chartW = canvas.width - padding.left - padding.right;
  const chartH = canvas.height - padding.top - padding.bottom;

  const minVal = Math.min(...points) * 0.99;
  const maxVal = Math.max(...points) * 1.01;
  const valRange = maxVal - minVal || 100;

  ctx.strokeStyle = "rgba(255, 255, 255, 0.03)";
  ctx.lineWidth = 1;

  const gridRows = 5;
  ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
  ctx.font = "9px var(--font-mono)";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let i = 0; i <= gridRows; i++) {
    const y = padding.top + (chartH / gridRows) * i;
    const val = maxVal - (valRange / gridRows) * i;

    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(canvas.width - padding.right, y);
    ctx.stroke();

    ctx.fillText(`$${val.toFixed(2)}`, padding.left - 8, y);
  }

  const baseVal = points[0];
  if (baseVal > minVal && baseVal < maxVal) {
    const zeroY = padding.top + chartH * (1 - (baseVal - minVal) / valRange);
    ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padding.left, zeroY);
    ctx.lineTo(canvas.width - padding.right, zeroY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const coordinates = points.map((val, idx) => {
    const x = padding.left + (chartW / (numPoints - 1)) * idx;
    const y = padding.top + chartH * (1 - (val - minVal) / valRange);
    let dateText = "Стартовый баланс";
    if (idx > 0) {
      const trade = filteredHistory[idx - 1];
      const dateStr = trade.closeTime || trade.timestamp || trade.openTime;
      if (dateStr) {
        dateText = new Date(dateStr).toLocaleString("ru-RU", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        });
      }
    }
    return { x, y, value: val, date: dateText };
  });

  const gradient = ctx.createLinearGradient(
    0,
    padding.top,
    0,
    canvas.height - padding.bottom,
  );
  gradient.addColorStop(0, "rgba(59, 130, 246, 0.2)");
  gradient.addColorStop(1, "rgba(59, 130, 246, 0.0)");

  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.moveTo(coordinates[0].x, canvas.height - padding.bottom);
  coordinates.forEach((pt) => ctx.lineTo(pt.x, pt.y));
  ctx.lineTo(coordinates[numPoints - 1].x, canvas.height - padding.bottom);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(coordinates[0].x, coordinates[0].y);
  for (let i = 1; i < numPoints; i++) {
    ctx.lineTo(coordinates[i].x, coordinates[i].y);
  }
  ctx.stroke();

  ctx.fillStyle = "#ffffff";
  coordinates.forEach((pt, idx) => {
    if (idx === 0 || idx === numPoints - 1 || numPoints < 15) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#3b82f6";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  });

  pnlPoints = coordinates;
}

let pnlPoints = [];

function initPnLChartTooltip() {
  const canvas = document.getElementById("pnl-equity-canvas");
  const tooltip = document.getElementById("pnl-chart-tooltip");

  if (!canvas || !tooltip) return;

  canvas.addEventListener("mousemove", (e) => {
    if (pnlPoints.length === 0) return;

    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    let closest = null;
    let minDist = Infinity;
    let closestIdx = -1;

    pnlPoints.forEach((pt, idx) => {
      const dist = Math.abs(pt.x - mouseX);
      if (dist < minDist) {
        minDist = dist;
        closest = pt;
        closestIdx = idx;
      }
    });

    if (closest && minDist < 20) {
      tooltip.style.display = "block";
      
      const tooltipX = canvas.offsetLeft + closest.x;
      const tooltipY = canvas.offsetTop + closest.y;
      
      // Позиционируем тултип аккуратно над точкой, сдвигая влево или вправо, чтобы избежать выхода за границы
      if (closest.x > canvas.width / 2) {
        tooltip.style.left = `${tooltipX - 10}px`;
        tooltip.style.transform = "translate(-100%, -100%)";
      } else {
        tooltip.style.left = `${tooltipX + 10}px`;
        tooltip.style.transform = "translate(0, -100%)";
      }
      tooltip.style.top = `${tooltipY - 10}px`;

      const change = closest.value - pnlPoints[0].value;
      const changeSign = change >= 0 ? "+" : "";
      const changeClass = change >= 0 ? "profit" : "loss";

      tooltip.innerHTML = `
                <div style="font-weight: 700; font-size: 10px; margin-bottom: 2px;">СДЕЛКА #${closestIdx}</div>
                <div style="font-size: 10px; color: var(--text-muted); margin-bottom: 4px;">${closest.date}</div>
                <div style="font-family: var(--font-mono); font-size: 11px;">
                    Баланс: <span style="font-weight: bold; color: #fff;">$${closest.value.toFixed(2)}</span><br/>
                    PnL: <span class="${changeClass}" style="font-weight: bold;">${changeSign}$${change.toFixed(2)}</span>
                </div>
            `;
    } else {
      tooltip.style.display = "none";
    }
  });

  canvas.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
  });
}

function renderHeatmapCalendar() {
  const container =
    document.getElementById("heatmap-calendar-grid") ||
    document.getElementById("heatmap-grid-el");
  const monthYearLabel =
    document.getElementById("heatmap-month-year") ||
    document.getElementById("heatmap-month-label");
  if (!container || !monthYearLabel) return;

  container.innerHTML = "";

  const year = heatmapCurrentDate.getFullYear();
  const month = heatmapCurrentDate.getMonth();

  const monthsRu = [
    "Январь",
    "Февраль",
    "Март",
    "Апрель",
    "Май",
    "Июнь",
    "Июль",
    "Август",
    "Сентябрь",
    "Октябрь",
    "Ноябрь",
    "Декабрь",
  ];
  monthYearLabel.textContent = `${monthsRu[month].toUpperCase()} ${year}`;

  const daysRu = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  daysRu.forEach((day) => {
    const header = document.createElement("div");
    header.className = "heatmap-cell-header";
    header.textContent = day;
    container.appendChild(header);
  });

  const firstDay = new Date(year, month, 1);
  let startOffset = firstDay.getDay() - 1;
  if (startOffset < 0) startOffset = 6;

  const numDays = new Date(year, month + 1, 0).getDate();

  for (let i = 0; i < startOffset; i++) {
    const cell = document.createElement("div");
    cell.className = "heatmap-cell empty";
    container.appendChild(cell);
  }

  const tradesByDay = {};
  const filteredHistory = tradeHistory; // Use all trades of the current month being viewed

  filteredHistory.forEach((trade) => {
    const closeTimeStr = trade.closeTime || trade.timestamp || trade.openTime;
    if (!closeTimeStr) return;
    const closeDate = new Date(closeTimeStr);
    if (closeDate.getFullYear() === year && closeDate.getMonth() === month) {
      const dayNum = closeDate.getDate();
      if (!tradesByDay[dayNum]) {
        tradesByDay[dayNum] = { pnl: 0, count: 0, wins: 0, losses: 0 };
      }
      tradesByDay[dayNum].pnl += trade.pnl || 0;
      tradesByDay[dayNum].count++;
      if ((trade.pnl || 0) > 0) {
        tradesByDay[dayNum].wins++;
      } else {
        tradesByDay[dayNum].losses++;
      }
    }
  });

  const getTradesWord = (count) => {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) {
      return "сделка";
    } else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
      return "сделки";
    } else {
      return "сделок";
    }
  };

  for (let day = 1; day <= numDays; day++) {
    const cell = document.createElement("div");
    cell.className = "heatmap-cell";

    const paddedMonth = String(month + 1).padStart(2, "0");
    const paddedDay = String(day).padStart(2, "0");
    const dateString = `${year}-${paddedMonth}-${paddedDay}`;

    if (selectedHistoryDateStr === dateString) {
      cell.classList.add("selected");
      cell.style.boxShadow = "0 0 0 2px #3b82f6 inset";
      cell.style.borderColor = "#3b82f6";
    }

    const dayLabel = document.createElement("span");
    dayLabel.className = "day-num";
    dayLabel.textContent = day;
    cell.appendChild(dayLabel);

    const dayData = tradesByDay[day];
    if (dayData) {
      cell.style.cursor = "pointer";
      const dailyPnl = dayData.pnl;
      const pnlSign = dailyPnl >= 0 ? "+" : "";
      const pnlStr = `${pnlSign}$${dailyPnl.toFixed(1)}`;

      if (dailyPnl > 0) {
        cell.classList.add("profit");
      } else if (dailyPnl < 0) {
        cell.classList.add("loss");
      }

      const dataContainer = document.createElement("div");
      dataContainer.className = "day-data-container";
      dataContainer.style.display = "flex";
      dataContainer.style.flexDirection = "column";
      dataContainer.style.alignItems = "flex-end";
      dataContainer.style.marginTop = "auto";

      const valBadge = document.createElement("span");
      valBadge.className = "day-val";
      valBadge.textContent = pnlStr;
      dataContainer.appendChild(valBadge);

      const countBadge = document.createElement("span");
      countBadge.className = "day-count-label";
      countBadge.style.fontSize = "8px";
      countBadge.style.color = "rgba(255, 255, 255, 0.4)";
      countBadge.style.marginTop = "1px";
      countBadge.textContent = `${dayData.count} ${getTradesWord(dayData.count)}`;
      dataContainer.appendChild(countBadge);

      cell.appendChild(dataContainer);

      cell.title = `Дата: ${day}.${month + 1}.${year}\nЧистая прибыль: ${pnlStr}\nВсего сделок: ${dayData.count} (Победы: ${dayData.wins}, Потери: ${dayData.losses})`;

      cell.addEventListener("click", () => {
        selectHistoricalTradesDate(dateString);
      });
    } else {
      cell.classList.add("no-activity");
      cell.style.cursor = "default";
    }

    container.appendChild(cell);
  }
}

// Ensure both renderHeatmap and renderHeatmapCalendar names can be called interchangeably
function renderHeatmap() {
  renderHeatmapCalendar();
}
window.renderHeatmap = renderHeatmap;

function initHeatmapNavigation() {
  const prevBtn =
    document.getElementById("heatmap-prev-btn") ||
    document.getElementById("heatmap-prev-month");
  const nextBtn =
    document.getElementById("heatmap-next-btn") ||
    document.getElementById("heatmap-next-month");

  prevBtn?.addEventListener("click", () => {
    heatmapCurrentDate.setMonth(heatmapCurrentDate.getMonth() - 1);
    renderHeatmapCalendar();
  });

  nextBtn?.addEventListener("click", () => {
    heatmapCurrentDate.setMonth(heatmapCurrentDate.getMonth() + 1);
    renderHeatmapCalendar();
  });
}

// 4. VIEW SWITCHING (JOURNAL VS ANALYTICS TABS)
function initViewTabs() {
  const journalBtn = document.getElementById("tab-btn-journal");
  const analyticsBtn = document.getElementById("tab-btn-analytics");
  const journalView = document.getElementById("view-journal-container");
  const analyticsView = document.getElementById("view-analytics-container");

  journalBtn?.addEventListener("click", () => {
    journalBtn.classList.add("active");
    analyticsBtn?.classList.remove("active");
    journalView?.classList.add("active");
    analyticsView?.classList.remove("active");
    isAnalyticsActive = false;
  });

  analyticsBtn?.addEventListener("click", () => {
    analyticsBtn.classList.add("active");
    journalBtn?.classList.remove("active");
    analyticsView?.classList.add("active");
    journalView?.classList.remove("active");
    isAnalyticsActive = true;

    setTimeout(() => {
      drawPnLEquityChart();
      renderHeatmapCalendar();
    }, 50);
  });
}

function scrollToDate(targetDateStr) {
  if (!targetDateStr) return;
  const targetDate = new Date(targetDateStr);
  if (isNaN(targetDate.getTime())) {
    showToast("Некорректный формат даты", "error");
    return;
  }
  const targetTime = Math.floor(targetDate.getTime() / 1000);

  const arr = state.historicalCandles;
  if (!arr || arr.length === 0) {
    showToast("Данные графика не загружены", "error");
    return;
  }

  // Находим ближайшую свечу
  let closestIdx = -1;
  let minDiff = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const diff = Math.abs(arr[i].time - targetTime);
    if (diff < minDiff) {
      minDiff = diff;
      closestIdx = i;
    }
  }

  if (closestIdx !== -1) {
    const barCount = 100; // количество отображаемых свечей в видимой области
    const fromIdx = Math.max(0, closestIdx - Math.floor(barCount / 2));
    const toIdx = Math.min(arr.length - 1, fromIdx + barCount);
    
    const fromTime = arr[fromIdx].time;
    const toTime = arr[toIdx].time;
    
    try {
      chart.timeScale().setVisibleRange({
        from: fromTime,
        to: toTime
      });
      
      const dateFormatted = new Date(arr[closestIdx].time * 1000).toLocaleDateString();
      showToast(`График перемещен к ${dateFormatted}`, "success");
    } catch (e) {
      console.error("Error setting visible range:", e);
      showToast("Не удалось переместить график к этой дате", "error");
    }
  } else {
    showToast("Ближайшая свеча не найдена", "error");
  }
}

async function initApp() {
  window.showToast = showToast;
  try {
    await runMigrations();
  } catch (migErr) {
    console.error("[DataMigration] App startup migration warning:", migErr);
  }

  await loadSimulatorState();
  initScenarios();
  
  // Восстановление рисунков из IndexedDB (асинхронно для предотвращения блокировки UI)
  getData("drawings").then((dbDrawings) => {
    if (dbDrawings && typeof dbDrawings === "object") {
      drawings = dbDrawings;
      drawAllOnCanvas();
    }
  }).catch((err) => {
    console.error("Failed to load drawings from IndexedDB:", err);
  });

  initHistoryPanelEvents();
  initAccountEventListeners();
  initNotesModalEvents();
  initCalendarModalEvents();
  initPnLChartTooltip();
  initHeatmapNavigation();
  initViewTabs();

  // Биндинг кнопок Undo/Redo
  document.getElementById("btn-undo")?.addEventListener("click", () => {
    undo();
  });
  document.getElementById("btn-redo")?.addEventListener("click", () => {
    redo();
  });

  const twDataBtn = document.getElementById("provider-twelvedata-btn");
  const mt5Btn = document.getElementById("provider-mt5-btn");
  const twConfigGroup = document.getElementById("twelvedata-config-group");

  function switchProvider(provider) {
    state.currentProvider = provider;
    localStorage.setItem("plbt_data_provider", provider);

    if (provider === "twelvedata") {
      twDataBtn?.classList.add("active");
      mt5Btn?.classList.remove("active");
      if (twConfigGroup) twConfigGroup.style.display = "block";
      
      const savedKey = localStorage.getItem("twelve_data_saved_key") || "";
      if (savedKey) {
        loadMarketData();
      } else {
        loadDemoData();
      }
    } else {
      twDataBtn?.classList.remove("active");
      mt5Btn?.classList.add("active");
      if (twConfigGroup) twConfigGroup.style.display = "none";
      
      loadMT5Data();
    }
  }

  twDataBtn?.addEventListener("click", () => switchProvider("twelvedata"));
  mt5Btn?.addEventListener("click", () => switchProvider("mt5"));

  const savedProvider = localStorage.getItem("plbt_data_provider") || "twelvedata";
  tokenInput.value = localStorage.getItem("twelve_data_saved_key") || "";
  switchProvider(savedProvider);
  if (typeof updatePairTooltip === "function") {
    updatePairTooltip(state.symbol);
  }
  if (typeof updateHeaderPairDisplay === "function") {
    updateHeaderPairDisplay(state.symbol);
  }
  if (typeof updateChartPrecision === "function") {
    updateChartPrecision(state.symbol);
  }
  startRealtimePolling();
  setActiveTool("cursor");
  if (window.lucide) {
    window.lucide.createIcons();
  }

  const sidebarBtn = document.getElementById("sidebar-toggle-btn");
  const sidebarPanel = document.getElementById("sidebar-panel");
  if (sidebarBtn && sidebarPanel) {
    sidebarBtn.addEventListener("click", () => {
      sidebarPanel.classList.toggle("collapsed");
      sidebarBtn.classList.toggle("collapsed");
      sidebarBtn.textContent = sidebarPanel.classList.contains("collapsed")
        ? "▶"
        : "◀";
      let count = 0;
      let lastW = 0;
      let lastH = 0;
      const interval = setInterval(() => {
        const rect = container.getBoundingClientRect();
        if (rect.width !== lastW || rect.height !== lastH) {
          lastW = rect.width;
          lastH = rect.height;
          chart.resize(rect.width, rect.height);
          resizeCanvas();
        }
        count++;
        if (count > 20) clearInterval(interval);
      }, 20);
    });
  }

  // Обработчик кнопки перехода к дате
  const gotoBtn = document.getElementById("chart-goto-btn");
  const gotoDateInput = document.getElementById("chart-goto-date");
  if (gotoBtn && gotoDateInput) {
    gotoBtn.addEventListener("click", () => {
      const targetDateVal = gotoDateInput.value;
      if (!targetDateVal) {
        showToast("Пожалуйста, выберите дату", "error");
        return;
      }
      scrollToDate(targetDateVal);
    });
  }
}

initBanSystem().then((allowed) => {
  if (allowed) {
    initApp();
  }
});

const tools = drawings.positions;
function render() {
  saveDrawings();
  drawAllOnCanvas();
}

function onCanvasContextMenu(e) {
  const rect = canvas.getBoundingClientRect();
  const mouseX = e.clientX - rect.left;
  const mouseY = e.clientY - rect.top;
  const hit = findObjectAtCoords(mouseX, mouseY);
  if (hit) {
    e.preventDefault();
    e.stopPropagation();
    if (
      hit.type === "pos_entry" ||
      hit.type === "pos_active_entry" ||
      hit.type === "pos_tp" ||
      hit.type === "pos_sl" ||
      hit.type === "pos_close_btn"
    ) {
      const id = hit.id;
      const idx = state.positions.findIndex((p) => p.id === id);
      if (idx !== -1) {
        saveState();
        state.positions.splice(idx, 1);
        saveSimulatorState();
        updateSimulatorUI();
        drawAllOnCanvas();
        showToast("Ордер удален вместе с TP/SL", "info");
      }
      return;
    }
    showContextMenu(hit, e.clientX, e.clientY);
  }
}

canvas.addEventListener("contextmenu", onCanvasContextMenu);
document.addEventListener(
  "contextmenu",
  function (e) {
    if (container.contains(e.target) || e.target === canvas) {
      onCanvasContextMenu(e);
    }
  },
  true,
);

// CUSTOM PROMPT AND CONFIRM MODAL SYSTEM
function showCustomPrompt(title, defaultValue = "") {
  return new Promise((resolve) => {
    const modal = document.getElementById("custom-modal");
    const modalTitle = document.getElementById("custom-modal-title");
    const modalMsg = document.getElementById("custom-modal-message");
    const modalInputContainer = document.getElementById(
      "custom-modal-input-container",
    );
    const modalInput = document.getElementById("custom-modal-input");
    const cancelBtn = document.getElementById("custom-modal-cancel-btn");
    const submitBtn = document.getElementById("custom-modal-submit-btn");
    const closeBtn = document.getElementById("custom-modal-close-header-btn");
    const modalIcon = document.getElementById("custom-modal-icon");

    if (!modal || !modalTitle || !modalMsg || !modalInput || !submitBtn) {
      resolve(defaultValue);
      return;
    }

    modalTitle.textContent = "Ввод данных";
    modalMsg.textContent = title;
    modalInputContainer.style.display = "block";
    modalInput.value = defaultValue;
    cancelBtn.style.display = "block";
    modal.style.display = "flex";

    if (modalIcon) {
      modalIcon.setAttribute("data-lucide", "help-circle");
      modalIcon.style.color = "var(--color-accent)";
      if (window.lucide) {
        window.lucide.createIcons();
      }
    }

    setTimeout(() => {
      modalInput.focus();
      modalInput.select();
    }, 50);

    function cleanup() {
      submitBtn.removeEventListener("click", onSubmit);
      cancelBtn.removeEventListener("click", onCancel);
      closeBtn.removeEventListener("click", onCancel);
      modalInput.removeEventListener("keydown", onKeyDown);
      modal.style.display = "none";
    }

    function onSubmit() {
      const val = modalInput.value;
      cleanup();
      resolve(val);
    }

    function onCancel() {
      cleanup();
      resolve(null);
    }

    function onKeyDown(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        onSubmit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    }

    submitBtn.addEventListener("click", onSubmit);
    cancelBtn.addEventListener("click", onCancel);
    closeBtn.addEventListener("click", onCancel);
    modalInput.addEventListener("keydown", onKeyDown);
  });
}

function showCustomConfirm(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById("custom-modal");
    const modalTitle = document.getElementById("custom-modal-title");
    const modalMsg = document.getElementById("custom-modal-message");
    const modalInputContainer = document.getElementById(
      "custom-modal-input-container",
    );
    const cancelBtn = document.getElementById("custom-modal-cancel-btn");
    const submitBtn = document.getElementById("custom-modal-submit-btn");
    const closeBtn = document.getElementById("custom-modal-close-header-btn");
    const modalIcon = document.getElementById("custom-modal-icon");

    if (!modal || !modalTitle || !modalMsg || !submitBtn) {
      resolve(false);
      return;
    }

    modalTitle.textContent = "Подтверждение";
    modalMsg.textContent = message;
    modalInputContainer.style.display = "none";
    cancelBtn.style.display = "block";
    modal.style.display = "flex";

    if (modalIcon) {
      modalIcon.setAttribute("data-lucide", "alert-triangle");
      modalIcon.style.color = "var(--color-down)";
      if (window.lucide) {
        window.lucide.createIcons();
      }
    }

    function cleanup() {
      submitBtn.removeEventListener("click", onSubmit);
      cancelBtn.removeEventListener("click", onCancel);
      closeBtn.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKeyDown);
      modal.style.display = "none";
    }

    function onSubmit() {
      cleanup();
      resolve(true);
    }

    function onCancel() {
      cleanup();
      resolve(false);
    }

    function onKeyDown(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        onSubmit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    }

    submitBtn.addEventListener("click", onSubmit);
    cancelBtn.addEventListener("click", onCancel);
    closeBtn.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKeyDown);
  });
}

function showNotification(message) {
  if (typeof showToast === "function") {
    showToast(message, "success");
  } else {
    alert(message);
  }
}

function checkOrderExecution() {
  activeOrders = state.positions.filter((pos) => pos.status === "pending");
  openPositions = state.positions.filter((pos) => pos.status === "active");

  const arr = state.isBacktestActive
    ? state.backtestVisibleCandles
    : state.historicalCandles;
  if (!arr || arr.length === 0) return;
  const currentPrice = arr[arr.length - 1].close;

  let changed = false;

  for (let i = activeOrders.length - 1; i >= 0; i--) {
    const order = activeOrders[i];
    const orderPrice = order.triggerPrice;
    const type = order.type; // 'buy' or 'sell'
    const orderType = order.orderType; // 'limit' or 'stop'
    let triggered = false;

    if (type === "buy") {
      if (orderType === "limit") {
        if (currentPrice <= orderPrice) {
          triggered = true;
        }
      } else if (orderType === "stop") {
        if (currentPrice >= orderPrice) {
          triggered = true;
        }
      }
    } else if (type === "sell") {
      if (orderType === "limit") {
        if (currentPrice >= orderPrice) {
          triggered = true;
        }
      } else if (orderType === "stop") {
        if (currentPrice <= orderPrice) {
          triggered = true;
        }
      }
    }

    if (triggered) {
      order.status = "active";
      order.entryPrice = orderPrice; // Executed at order price
      order.timestamp = new Date().toISOString();
      order.entryTime = arr[arr.length - 1].time;

      // Move in local arrays
      activeOrders.splice(i, 1);
      openPositions.push(order);
      changed = true;

      showNotification(
        `Ордер №${order.id} активирован по цене ${orderPrice.toFixed(5)}`,
      );
    }
  }

  if (changed) {
    state.positions = [
      ...activeOrders,
      ...openPositions,
    ];
    saveSimulatorState();
    updateSimulatorUI();
    drawAllOnCanvas();
  }
}

let pendingOrderPollTimer = null;

function ensurePendingOrdersChecking() {
  const hasPending = state.positions && state.positions.some((p) => p.status === "pending" || p.status === "draft");
  if (hasPending) {
    if (!pendingOrderPollTimer) {
      pendingOrderPollTimer = setInterval(() => {
        if (document.visibilityState !== "hidden") {
          const stillPending = state.positions && state.positions.some((p) => p.status === "pending" || p.status === "draft");
          if (stillPending) {
            checkOrderExecution();
          } else {
            clearInterval(pendingOrderPollTimer);
            pendingOrderPollTimer = null;
          }
        }
      }, 500);
    }
  } else if (pendingOrderPollTimer) {
    clearInterval(pendingOrderPollTimer);
    pendingOrderPollTimer = null;
  }
}

// Initial safety check on boot without spinning a continuous rAF loop
ensurePendingOrdersChecking();

// --- TradingView-style Interactive Order/Level Visual Dragging on Canvas ---

function getHoveredOrderElement(mouseY) {
  if (window.state && window.state.positions) {
    activeOrders = window.state.positions.filter(
      (pos) => pos.status === "pending" || pos.status === "draft",
    );
    openPositions = window.state.positions.filter(
      (pos) => pos.status === "active",
    );
  }

  if (!activeOrders && !openPositions) return null;

  // Check active pending orders (Limit/Stop)
  if (Array.isArray(activeOrders)) {
    for (const order of activeOrders) {
      // 1. Entry Line (draggable)
      const entryPrice = order.triggerPrice || order.entryPrice;
      if (entryPrice) {
        const y = candlestickSeries.priceToCoordinate(entryPrice);
        if (y !== null && Math.abs(mouseY - y) <= 5) {
          return {
            type: "Entry",
            orderId: order.id,
            orderType: "pending",
            originalObject: order,
            originalPrice: entryPrice,
          };
        }
      }
      // 2. Take Profit Line (draggable)
      if (order.takeProfit && order.takeProfit > 0) {
        const y = candlestickSeries.priceToCoordinate(order.takeProfit);
        if (y !== null && Math.abs(mouseY - y) <= 5) {
          return {
            type: "TP",
            orderId: order.id,
            orderType: "pending",
            originalObject: order,
            originalPrice: order.takeProfit,
          };
        }
      }
      // 3. Stop Loss Line (draggable)
      if (order.stopLoss && order.stopLoss > 0) {
        const y = candlestickSeries.priceToCoordinate(order.stopLoss);
        if (y !== null && Math.abs(mouseY - y) <= 5) {
          return {
            type: "SL",
            orderId: order.id,
            orderType: "pending",
            originalObject: order,
            originalPrice: order.stopLoss,
          };
        }
      }
    }
  }

  // Check open positions (Market already executed)
  if (Array.isArray(openPositions)) {
    for (const pos of openPositions) {
      // Entry line is NOT draggable for active market positions as per requirements
      // 1. Take Profit Line (draggable)
      if (pos.takeProfit && pos.takeProfit > 0) {
        const y = candlestickSeries.priceToCoordinate(pos.takeProfit);
        if (y !== null && Math.abs(mouseY - y) <= 5) {
          return {
            type: "TP",
            orderId: pos.id,
            orderType: "position",
            originalObject: pos,
            originalPrice: pos.takeProfit,
          };
        }
      }
      // 2. Stop Loss Line (draggable)
      if (pos.stopLoss && pos.stopLoss > 0) {
        const y = candlestickSeries.priceToCoordinate(pos.stopLoss);
        if (y !== null && Math.abs(mouseY - y) <= 5) {
          return {
            type: "SL",
            orderId: pos.id,
            orderType: "position",
            originalObject: pos,
            originalPrice: pos.stopLoss,
          };
        }
      }
    }
  }

  return null;
}

// Attach listeners to container parent to ensure our capture phase runs before the standard chart events
const parentEl = container ? container.parentElement || document : document;

parentEl.addEventListener(
  "mousemove",
  (e) => {
    if (!container || !candlestickSeries) return;

    const rect = cachedContainerRect || container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Проверка наведения на исторические сделки
    const histHit = findHistoricalTradeAtCoords(mouseX, mouseY);
    if (histHit) {
      const oldHoveredId = hoveredHistTradeId;
      hoveredHistTradeId = histHit.trade.id;
      canvas.style.pointerEvents = "auto";
      canvas.style.cursor = "pointer";
      container.style.cursor = "pointer";
      showHistoricalTradeTooltip(e.clientX, e.clientY, histHit.trade);
      if (oldHoveredId !== hoveredHistTradeId) {
        requestDrawAllOnCanvas();
      }
      e.stopPropagation();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    } else {
      const oldHoveredId = hoveredHistTradeId;
      if (oldHoveredId !== null) {
        hoveredHistTradeId = null;
        hideHistoricalTradeTooltip();
        requestDrawAllOnCanvas();
      }
    }

    // Check boundaries
    if (
      mouseX < 0 ||
      mouseX > rect.width ||
      mouseY < 0 ||
      mouseY > rect.height
    ) {
      if (draggedElement === null) {
        if (hoveredElement !== null) {
          hoveredElement = null;
          hoveredObject = null;
          canvas.style.pointerEvents = "none";
          canvas.style.cursor = "default";
          container.style.cursor = "default";
          requestDrawAllOnCanvas();
        }
      }
      return;
    }

    if (draggedElement !== null) {
      // Drag in progress! Prevent chart panning and other UI moves
      e.stopPropagation();
      e.preventDefault();
      e.stopImmediatePropagation();

      const currentPrice = candlestickSeries.coordinateToPrice(mouseY);
      if (currentPrice !== null) {
        const pos = state.positions.find(
          (p) => p.id === draggedElement.orderId,
        );
        if (pos) {
          const roundedPrice = parseFloat(currentPrice.toFixed(5));
          if (draggedElement.type === "Entry") {
            pos.triggerPrice = roundedPrice;
            pos.entryPrice = roundedPrice;
            pos.price = roundedPrice;

            // If it's a draft order and we drag its entry price, update orderType between limit/stop based on current market price
            if (pos.status === "draft") {
              const arr = state.isBacktestActive ? state.backtestVisibleCandles : state.historicalCandles;
              if (arr && arr.length > 0) {
                const currentMarketPrice = arr[arr.length - 1].close;
                const isBuy = pos.type === "buy" || pos.type === "Long" || pos.type === "long";
                pos.orderType = isBuy
                  ? (roundedPrice < currentMarketPrice ? "limit" : "stop")
                  : (roundedPrice > currentMarketPrice ? "limit" : "stop");
              }
            }

            // Move SL and TP proportionally with entry
            if (activeDragInfo.originalTP) {
              const tpDelta =
                activeDragInfo.originalTP - activeDragInfo.originalEntryPrice;
              pos.takeProfit = parseFloat((roundedPrice + tpDelta).toFixed(5));
              pos.tp = pos.takeProfit;
            }
            if (activeDragInfo.originalSL) {
              const slDelta =
                activeDragInfo.originalSL - activeDragInfo.originalEntryPrice;
              pos.stopLoss = parseFloat((roundedPrice + slDelta).toFixed(5));
              pos.sl = pos.stopLoss;
            }
          } else if (draggedElement.type === "TP") {
            pos.takeProfit = roundedPrice;
            pos.tp = roundedPrice;
          } else if (draggedElement.type === "SL") {
            pos.stopLoss = roundedPrice;
            pos.sl = roundedPrice;
          }

          // Smoothly draw movement
          requestDrawAllOnCanvas();
        }
      }
      return;
    }

    // Custom button hover priority
    const btnHit = getButtonUnderMouse(mouseX, mouseY);
    if (btnHit) {
      hoveredElement = null; // deactivate standard line hover when over button
      canvas.style.pointerEvents = "auto";
      canvas.style.cursor = "pointer";
      container.style.cursor = "pointer";

      const oldHovered = hoveredObject;
      if (btnHit.type === "CONFIRM_btn") {
        hoveredObject = { id: btnHit.posId, type: "pos_confirm_btn" };
      } else {
        hoveredObject = { id: btnHit.posId, type: btnHit.type === "TP_btn" ? "pos_tp_btn" : "pos_sl_btn" };
      }

      if (!isHoveredObjectEqual(oldHovered, hoveredObject)) {
        requestDrawAllOnCanvas();
      }

      e.stopPropagation();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    // Close button hover priority
    const closeBtnHit = findObjectAtCoords(mouseX, mouseY);
    if (closeBtnHit && closeBtnHit.type === "pos_close_btn") {
      hoveredElement = null; // deactivate standard line hover when over button
      canvas.style.pointerEvents = "auto";
      canvas.style.cursor = "pointer";
      container.style.cursor = "pointer";

      const oldHovered = hoveredObject;
      hoveredObject = closeBtnHit;

      if (!isHoveredObjectEqual(oldHovered, hoveredObject)) {
        requestDrawAllOnCanvas();
      }

      e.stopPropagation();
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }

    // Hover effect check
    const hit = getHoveredOrderElement(mouseY);
    if (hit !== null) {
      hoveredElement = hit;
      canvas.style.pointerEvents = "auto";
      canvas.style.cursor = "ns-resize";
      container.style.cursor = "ns-resize";

      // Visually highlight line in drawAllOnCanvas
      const oldHovered = hoveredObject;
      if (hit.type === "Entry") {
        hoveredObject = { id: hit.orderId, type: "pos_entry" };
      } else if (hit.type === "TP") {
        hoveredObject = { id: hit.orderId, type: "pos_tp" };
      } else if (hit.type === "SL") {
        hoveredObject = { id: hit.orderId, type: "pos_sl" };
      }

      if (!isHoveredObjectEqual(oldHovered, hoveredObject)) {
        requestDrawAllOnCanvas();
      }

      // Prevent other capture hover events on chart
      e.stopPropagation();
      e.preventDefault();
      e.stopImmediatePropagation();
    } else {
      if (hoveredElement !== null || hoveredObject !== null) {
        hoveredElement = null;
        hoveredObject = null;
        canvas.style.pointerEvents = "none";
        canvas.style.cursor = "default";
        container.style.cursor = "default";
        requestDrawAllOnCanvas();
      }
    }
  },
  true,
);

parentEl.addEventListener(
  "mousedown",
  (e) => {
    if (e.button !== 0) return; // Only handle left clicks

    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // Проверка клика по историческим сделкам
    const histHit = findHistoricalTradeAtCoords(mouseX, mouseY);
    if (histHit) {
      e.stopPropagation();
      e.preventDefault();
      e.stopImmediatePropagation();
      
      // Открываем дневник сделок / заметок
      if (typeof window.openTradeNotesModal === "function") {
        window.openTradeNotesModal(histHit.trade.id);
      } else {
        showToast("Функция дневника недоступна", "error");
      }
      return;
    }

    // Check close button click first to intercept it before standard logic
    const closeBtnHit = findObjectAtCoords(mouseX, mouseY);
    if (closeBtnHit && closeBtnHit.type === "pos_close_btn") {
      e.stopPropagation();
      e.preventDefault();
      e.stopImmediatePropagation();

      if (closeBtnHit.lineType === "tp") {
        const pos = state.positions.find((p) => p.id === closeBtnHit.id);
        if (pos) {
          pos.takeProfit = 0;
          pos.tp = 0;
          saveSimulatorState();
          updateSimulatorUI();
          drawAllOnCanvas();
          showToast("Уровень TP удален", "success");
        }
      } else if (closeBtnHit.lineType === "sl") {
        const pos = state.positions.find((p) => p.id === closeBtnHit.id);
        if (pos) {
          pos.stopLoss = 0;
          pos.sl = 0;
          saveSimulatorState();
          updateSimulatorUI();
          drawAllOnCanvas();
          showToast("Уровень SL удален", "success");
        }
      } else {
        closePosition(closeBtnHit.id);
      }
      return;
    }

    // Check custom button click first
    const btnHit = getButtonUnderMouse(mouseX, mouseY);
    if (btnHit) {
      e.stopPropagation();
      e.preventDefault();
      e.stopImmediatePropagation();

      const pos = btnHit.position;
      const isLong = pos.type === "buy" || pos.type === "Long" || pos.type === "long";
      const step = getInitialTpSlStep();

      if (btnHit.type === "CONFIRM_btn") {
        if (typeof window.confirmDraftOrder === "function") {
          window.confirmDraftOrder(pos.id);
        }
        return;
      }

      if (btnHit.type === "TP_btn") {
        if (!pos.takeProfit || pos.takeProfit <= 0) {
          pos.takeProfit = isLong ? (pos.entryPrice + step) : (pos.entryPrice - step);
          pos.tp = pos.takeProfit;
          showToast("Активирован уровень Take Profit", "success");
        }
        draggedElement = {
          type: "TP",
          orderId: pos.id,
          orderType: (pos.status === "pending" || pos.status === "draft") ? "pending" : "position",
          originalObject: pos,
          originalPrice: pos.takeProfit,
        };
      } else {
        if (!pos.stopLoss || pos.stopLoss <= 0) {
          pos.stopLoss = isLong ? (pos.entryPrice - step) : (pos.entryPrice + step);
          pos.sl = pos.stopLoss;
          showToast("Активирован уровень Stop Loss", "success");
        }
        draggedElement = {
          type: "SL",
          orderId: pos.id,
          orderType: (pos.status === "pending" || pos.status === "draft") ? "pending" : "position",
          originalObject: pos,
          originalPrice: pos.stopLoss,
        };
      }

      activeDragInfo = {
        startPrice: draggedElement.originalPrice,
        originalPrice: draggedElement.originalPrice,
        originalEntryPrice: pos.entryPrice,
        originalTP: pos.takeProfit || null,
        originalSL: pos.stopLoss || null,
      };

      canvas.style.pointerEvents = "auto";
      canvas.style.cursor = "ns-resize";
      container.style.cursor = "ns-resize";

      saveSimulatorState();
      updateSimulatorUI();
      drawAllOnCanvas();

      // Block standard chart navigation
      if (chart) {
        chart.applyOptions({
          handleScroll: {
            pressedMouseMove: false,
          },
        });
      }
      return;
    }

    if (hoveredElement !== null) {
      e.stopPropagation();
      e.preventDefault();
      e.stopImmediatePropagation();

      draggedElement = hoveredElement;

      const pos = state.positions.find((p) => p.id === draggedElement.orderId);
      if (pos) {
        const entryVal = pos.triggerPrice || pos.entryPrice;
        activeDragInfo = {
          startPrice: draggedElement.originalPrice,
          originalPrice: draggedElement.originalPrice,
          originalEntryPrice: entryVal,
          originalTP: pos.takeProfit || null,
          originalSL: pos.stopLoss || null,
        };
      }

      // Block standard chart navigation
      if (chart) {
        chart.applyOptions({
          handleScroll: {
            pressedMouseMove: false,
          },
        });
      }
    }
  },
  true,
);

window.addEventListener(
  "mouseup",
  (e) => {
    if (draggedElement !== null) {
      e.stopPropagation();
      e.preventDefault();
      e.stopImmediatePropagation();

      const pos = state.positions.find((p) => p.id === draggedElement.orderId);
      if (pos) {
        let isValid = true;
        const entryVal = pos.triggerPrice || pos.entryPrice;
        const isLong = pos.type === "buy";

        // Base TradingView Constraints (Requirement 5)
        if (pos.takeProfit && pos.takeProfit > 0) {
          if (isLong) {
            if (pos.takeProfit < entryVal) isValid = false;
          } else {
            if (pos.takeProfit > entryVal) isValid = false;
          }
        }
        if (pos.stopLoss && pos.stopLoss > 0) {
          if (isLong) {
            if (pos.stopLoss > entryVal) isValid = false;
          } else {
            if (pos.stopLoss < entryVal) isValid = false;
          }
        }

        if (!isValid) {
          // Rollback to original prices on invalid drag
          if (draggedElement.type === "Entry") {
            pos.triggerPrice = activeDragInfo.originalEntryPrice;
            pos.entryPrice = activeDragInfo.originalEntryPrice;
            pos.price = activeDragInfo.originalEntryPrice;
            pos.takeProfit = activeDragInfo.originalTP;
            pos.tp = activeDragInfo.originalTP;
            pos.stopLoss = activeDragInfo.originalSL;
            pos.sl = activeDragInfo.originalSL;
          } else if (draggedElement.type === "TP") {
            pos.takeProfit = activeDragInfo.originalTP;
            pos.tp = activeDragInfo.originalTP;
          } else if (draggedElement.type === "SL") {
            pos.stopLoss = activeDragInfo.originalSL;
            pos.sl = activeDragInfo.originalSL;
          }
          showToast("Недопустимый уровень SL/TP!", "error");
        } else {
          // Succeeded! Round values cleanly
          if (pos.takeProfit) {
            pos.takeProfit = parseFloat(pos.takeProfit.toFixed(5));
            pos.tp = pos.takeProfit;
          }
          if (pos.stopLoss) {
            pos.stopLoss = parseFloat(pos.stopLoss.toFixed(5));
            pos.sl = pos.stopLoss;
          }
          if (pos.entryPrice) {
            pos.entryPrice = parseFloat(pos.entryPrice.toFixed(5));
            pos.price = pos.entryPrice;
          }
          if (pos.triggerPrice) {
            pos.triggerPrice = parseFloat(pos.triggerPrice.toFixed(5));
          }

          // Sync sidebar input values
          const priceInput = document.getElementById("order-price-input");
          if (priceInput && draggedElement.type === "Entry") {
            priceInput.value = pos.entryPrice.toFixed(5);
          }
          const tpInput = document.getElementById("order-tp-input");
          if (tpInput && draggedElement.type === "TP") {
            tpInput.value = pos.takeProfit ? pos.takeProfit.toFixed(5) : "";
          }
          const slInput = document.getElementById("order-sl-input");
          if (slInput && draggedElement.type === "SL") {
            slInput.value = pos.stopLoss ? pos.stopLoss.toFixed(5) : "";
          }

          // Requirement 3 Output Console Log
          const finalPrice =
            draggedElement.type === "Entry"
              ? entryVal
              : draggedElement.type === "TP"
                ? pos.takeProfit
                : pos.stopLoss;
          console.log(
            "Ордер/Уровень изменен: ID " +
              draggedElement.orderId +
              " новая цена: " +
              finalPrice.toFixed(5),
          );
          showToast("Уровень успешно обновлен", "success");
        }

        // Save state and update UI
        saveSimulatorState();
        updateSimulatorUI();
        drawAllOnCanvas();
      }

      // Reset state
      draggedElement = null;
      activeDragInfo = null;

      // Restore standard chart scrolling/panning
      if (chart) {
        chart.applyOptions({
          handleScroll: {
            pressedMouseMove: true,
          },
        });
      }
    }
  },
  true,
);

function updateHTMLOverlays() {
  const overlaysContainer = document.getElementById("html-overlays-container");
  if (overlaysContainer) {
    overlaysContainer.innerHTML = "";
  }
}
window.updateHTMLOverlays = updateHTMLOverlays;

function executePartialClose(id, percent) {
  const idx = state.positions.findIndex((p) => p.id === id);
  if (idx === -1) return;
  const pos = state.positions[idx];

  if (percent >= 1.0) {
    closePosition(id);
    return;
  }

  const size = pos.size;
  const closingVolume = parseFloat((size * percent).toFixed(2));
  if (closingVolume <= 0) {
    showToast("Недопустимый объем для закрытия!", "error");
    return;
  }

  const remainingVolume = parseFloat((size - closingVolume).toFixed(2));
  if (remainingVolume <= 0) {
    closePosition(id);
    return;
  }

  const arr = state.isBacktestActive
    ? state.backtestVisibleCandles
    : state.historicalCandles;
  const price = arr.length > 0 ? arr[arr.length - 1].close : pos.entryPrice;
  const closingCandleTime =
    arr.length > 0 ? arr[arr.length - 1].time : undefined;

  let pnl = 0;
  const units = closingVolume * 100000;
  if (pos.type === "buy") {
    pnl = (price - pos.entryPrice) * units;
  } else {
    pnl = (pos.entryPrice - price) * units;
  }
  if (pos.symbol.endsWith("_JPY")) {
    pnl = pnl / price;
  }

  const closedCommission = parseFloat((pos.commission * percent).toFixed(2));
  balance += pnl;
  saveBalance(balance);

  const closedTrade = {
    id: pos.id + "-" + Date.now(),
    account_id: pos.account_id || activeAccountId,
    symbol: pos.symbol,
    type: pos.type,
    size: closingVolume,
    leverage: pos.leverage,
    commission: closedCommission,
    entryPrice: pos.entryPrice,
    exitPrice: price,
    pnl: pnl,
    openTime: pos.timestamp,
    closeTime: new Date().toISOString(),
    timestamp: new Date().toISOString(),
    entryTime: pos.entryTime,
    exitTime: closingCandleTime,
    notes: {
      noteBefore: pos.notes ? pos.notes.noteBefore : "",
      noteDuring: pos.notes ? pos.notes.noteDuring : "",
      noteAfter: pos.notes ? pos.notes.noteAfter : "",
    },
  };
  tradeHistory.push(closedTrade);
  localStorage.setItem("plbt_trade_history", JSON.stringify(tradeHistory));
  updateTradeHistoryUI();

  pos.size = remainingVolume;
  pos.commission = parseFloat((pos.commission - closedCommission).toFixed(2));

  saveSimulatorState();
  updateSimulatorUI();
  drawAllOnCanvas();

  showToast(
    `Частично закрыто ${closingVolume} L. Результат: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
    pnl >= 0 ? "success" : "error",
  );
}
window.executePartialClose = executePartialClose;

// ==========================================
// HOTKEYS & FAST-FORWARD TO OUTCOME SYSTEM
// ==========================================

const DEFAULT_HOTKEYS = {
  backtestPlayPause: {
    id: "backtest_play_pause",
    actionName: "Play / Pause бэктеста",
    actionDesc: "Воспроизведение или пауза бэктеста",
    type: "combo",
    code: "KeyP",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "P"
  },
  backtestStepForward: {
    id: "backtest_step_forward",
    actionName: "Шаг на 1 бар вперёд",
    actionDesc: "Следующий бар в бэктесте",
    type: "combo",
    code: "KeyL",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "L"
  },
  backtestStepBackward: {
    id: "backtest_step_backward",
    actionName: "Шаг на 1 бар назад",
    actionDesc: "Предыдущий бар в бэктесте",
    type: "combo",
    code: "KeyJ",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "J"
  },
  backtestSpeedUp: {
    id: "backtest_speed_up",
    actionName: "Увеличить скорость воспроизведения",
    actionDesc: "Ускорить воспроизведение бэктеста",
    type: "combo",
    code: "BracketRight",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "]"
  },
  backtestSpeedDown: {
    id: "backtest_speed_down",
    actionName: "Уменьшить скорость воспроизведения",
    actionDesc: "Замедлить воспроизведение бэктеста",
    type: "combo",
    code: "BracketLeft",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "["
  },
  fastForward: {
    id: "backtest_ff_outcome",
    actionName: "Перемотка до результата сделки",
    actionDesc: "Быстрая перемотка до TP/SL в бэктесте",
    type: "double",
    code: "Space",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "2× Пробел"
  },
  fastForwardToLevel: {
    id: "backtest_ff_level",
    actionName: "Перемотка к уровню ожидания",
    actionDesc: "Быстрая перемотка до выбранного уровня ожидания",
    type: "combo",
    code: "KeyW",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "W"
  },
  restoreLastIndicator: {
    id: "restore_last_indicator",
    actionName: "Добавить последний индикатор",
    actionDesc: "Включить последний индикатор с прежними настройками",
    type: "combo",
    code: "KeyI",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "I"
  },
  tf_1: {
    id: "tf_1m",
    actionName: "Таймфрейм 1m",
    timeframe: "1m",
    type: "combo",
    code: "Digit1",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "1"
  },
  tf_2: {
    id: "tf_5m",
    actionName: "Таймфрейм 5m",
    timeframe: "5m",
    type: "combo",
    code: "Digit2",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "2"
  },
  tf_3: {
    id: "tf_15m",
    actionName: "Таймфрейм 15m",
    timeframe: "15m",
    type: "combo",
    code: "Digit3",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "3"
  },
  tf_4: {
    id: "tf_30m",
    actionName: "Таймфрейм 30m",
    timeframe: "30m",
    type: "combo",
    code: "Digit4",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "4"
  },
  tf_5: {
    id: "tf_1h",
    actionName: "Таймфрейм 1h",
    timeframe: "1h",
    type: "combo",
    code: "Digit5",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "5"
  },
  tf_6: {
    id: "tf_4h",
    actionName: "Таймфрейм 4h",
    timeframe: "4h",
    type: "combo",
    code: "Digit6",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "6"
  },
  tf_7: {
    id: "tf_1d",
    actionName: "Таймфрейм 1d",
    timeframe: "1d",
    type: "combo",
    code: "Digit7",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "7"
  },
  tf_8: {
    id: "tf_1w",
    actionName: "Таймфрейм 1w",
    timeframe: "1w",
    type: "combo",
    code: "Digit8",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "8"
  },
  tf_9: {
    id: "tf_1M",
    actionName: "Таймфрейм 1M",
    timeframe: "1M",
    type: "combo",
    code: "Digit9",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "9"
  },
  zoomIn: {
    id: "chart_zoom_in",
    actionName: "Увеличить масштаб (Zoom in)",
    actionDesc: "Плавное приближение графика",
    type: "combo",
    code: "Equal",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "+"
  },
  zoomOut: {
    id: "chart_zoom_out",
    actionName: "Уменьшить масштаб (Zoom out)",
    actionDesc: "Плавное отдаление графика",
    type: "combo",
    code: "Minus",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "-"
  },
  scrollLeft: {
    id: "chart_scroll_left",
    actionName: "Скролл графика влево",
    actionDesc: "Сдвиг видимого диапазона в историю",
    type: "combo",
    code: "ArrowLeft",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "←"
  },
  scrollRight: {
    id: "chart_scroll_right",
    actionName: "Скролл графика вправо",
    actionDesc: "Сдвиг видимого диапазона к настоящему",
    type: "combo",
    code: "ArrowRight",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "→"
  },
  fitContent: {
    id: "chart_fit_content",
    actionName: "Сброс масштаба графика",
    actionDesc: "Стандартный обзор графика (Fit content)",
    type: "combo",
    code: "KeyR",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "R"
  },
  quickBuy: {
    id: "trade_quick_buy",
    actionName: "Быстрый Buy (Маркет)",
    actionDesc: "Покупка по текущему объёму в панели",
    type: "combo",
    code: "KeyB",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "B"
  },
  quickSell: {
    id: "trade_quick_sell",
    actionName: "Быстрый Sell (Маркет)",
    actionDesc: "Продажа по текущему объёму в панели",
    type: "combo",
    code: "KeyS",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "S"
  },
  closeAllPositions: {
    id: "trade_close_all_positions",
    actionName: "Закрыть все позиции",
    actionDesc: "Массовое закрытие всех открытых сделок",
    type: "combo",
    code: "KeyX",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "X"
  },
  toggleTradeJournal: {
    id: "ui_toggle_trade_journal",
    actionName: "Дневник / Журнал сделок",
    actionDesc: "Открыть или закрыть панель журнала",
    type: "combo",
    code: "KeyD",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    label: "D"
  }
};

let appHotkeys = {};
for (const key of Object.keys(DEFAULT_HOTKEYS)) {
  appHotkeys[key] = Object.assign({}, DEFAULT_HOTKEYS[key]);
  try {
    const saved = localStorage.getItem("plbt_hotkey_" + key) || (key === "fastForward" ? localStorage.getItem("plbt_hotkey_ff_outcome") : null);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && parsed.code) {
        appHotkeys[key] = Object.assign({}, DEFAULT_HOTKEYS[key], parsed);
      }
    }
  } catch (e) {
    console.warn("Failed to load hotkeys from localStorage:", e);
  }
}

// Built-in system shortcuts used for conflict detection
const SYSTEM_ACTIONS_SHORTCUTS = [
  { actionName: "Отмена действия (Undo)", ctrl: true, alt: false, shift: false, code: "KeyZ" },
  { actionName: "Повтор действия (Redo)", ctrl: true, alt: false, shift: false, code: "KeyY" },
  { actionName: "Повтор действия (Redo)", ctrl: true, alt: false, shift: true, code: "KeyZ" },
  { actionName: "Удаление объектов на графике", ctrl: false, alt: false, shift: false, code: "Delete" },
  { actionName: "Удаление объектов на графике", ctrl: false, alt: false, shift: false, code: "Backspace" },
  { actionName: "Снятие выделения / отмена инструментов", ctrl: false, alt: false, shift: false, code: "Escape" },
  { actionName: "Завершение рисования / подтверждение", ctrl: false, alt: false, shift: false, code: "Enter" }
];

// Checks if candidate shortcut conflicts with system actions or other configured hotkeys
function checkHotkeyConflict(candidate, currentActionKey) {
  if (candidate.type !== "double") {
    const ctrl = Boolean(candidate.ctrl);
    const alt = Boolean(candidate.alt);
    const shift = Boolean(candidate.shift);
    const code = candidate.code;

    for (const sys of SYSTEM_ACTIONS_SHORTCUTS) {
      if (
        sys.code === code &&
        sys.ctrl === ctrl &&
        sys.alt === alt &&
        sys.shift === shift
      ) {
        return sys.actionName;
      }
    }
  }

  for (const [key, existing] of Object.entries(appHotkeys)) {
    if (key === currentActionKey || !existing) continue;

    if (existing.type === candidate.type && existing.code === candidate.code) {
      if (candidate.type === "double") {
        return existing.actionName || "Другое действие";
      }
      const sameCtrl = Boolean(existing.ctrl) === Boolean(candidate.ctrl);
      const sameAlt = Boolean(existing.alt) === Boolean(candidate.alt);
      const sameShift = Boolean(existing.shift) === Boolean(candidate.shift);
      if (sameCtrl && sameAlt && sameShift) {
        return existing.actionName || "Другое действие";
      }
    }
  }

  return null;
}

function formatKeyName(code) {
  if (!code) return "";
  if (code === "Space") return "Пробел";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code === "BracketLeft") return "[";
  if (code === "BracketRight") return "]";
  if (code === "Semicolon") return ";";
  if (code === "Quote") return "'";
  if (code === "Comma") return ",";
  if (code === "Period") return ".";
  if (code === "Slash") return "/";
  if (code === "Backslash") return "\\";
  if (code === "ArrowLeft") return "←";
  if (code === "ArrowRight") return "→";
  if (code === "ArrowUp") return "↑";
  if (code === "ArrowDown") return "↓";
  if (code === "Equal") return "+";
  if (code === "Minus") return "-";
  if (code === "Tab") return "Tab";
  return code;
}

function formatComboLabel(ctrl, alt, shift, code) {
  const parts = [];
  if (ctrl) parts.push("Ctrl");
  if (alt) parts.push("Alt");
  if (shift) parts.push("Shift");
  parts.push(formatKeyName(code));
  return parts.join(" + ");
}

let lastDoubleTapTimestamp = 0;

/**
 * Checks if the keydown event triggers the Fast-Forward shortcut.
 * Crucial behavior:
 * - When configured as "double" (e.g. 2x Space), the first press simply saves
 *   the timestamp and returns false WITHOUT preventing default, so single press
 *   passes through untouched for normal interaction.
 * - Only a rapid second press within 450ms returns true and triggers fast-forward.
 */
function checkAndTriggerFastForwardHotkey(e) {
  const hk = appHotkeys.fastForward;
  if (!hk) return false;

  if (hk.type === "double") {
    const isSameCode = e.code === hk.code;
    const noModifiers = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;

    if (isSameCode && noModifiers) {
      const now = Date.now();
      if (lastDoubleTapTimestamp > 0 && (now - lastDoubleTapTimestamp) <= 450) {
        // Second press within 450ms -> confirmed double tap!
        e.preventDefault();
        lastDoubleTapTimestamp = 0;
        executeFastForwardToOutcome();
        return true;
      } else {
        // First press: record timestamp, do NOT preventDefault, pass through!
        lastDoubleTapTimestamp = now;
        return false;
      }
    } else {
      // Pressed a different key -> clear double-tap window
      lastDoubleTapTimestamp = 0;
      return false;
    }
  } else {
    // Combination or single key with/without modifiers
    const matchCtrl = Boolean(hk.ctrl) === (e.ctrlKey || e.metaKey);
    const matchAlt = Boolean(hk.alt) === e.altKey;
    const matchShift = Boolean(hk.shift) === e.shiftKey;
    const matchCode = e.code === hk.code;

    if (matchCode && matchCtrl && matchAlt && matchShift) {
      e.preventDefault();
      executeFastForwardToOutcome();
      return true;
    }
    return false;
  }
}

// Visual indicator control
function showFastForwardIndicator(visible) {
  const el = document.getElementById("fast-forward-indicator");
  if (el) {
    el.style.display = visible ? "flex" : "none";
    if (visible && window.lucide) {
      window.lucide.createIcons();
    }
  }
  const btn = document.getElementById("backtest-fast-forward-btn");
  if (btn) {
    if (visible) {
      btn.style.background = "rgba(56, 189, 248, 0.25)";
      btn.style.borderColor = "#38bdf8";
    } else {
      btn.style.background = "rgba(56, 189, 248, 0.08)";
      btn.style.borderColor = "rgba(56, 189, 248, 0.35)";
    }
  }
}

/**
 * Generic fast-forward engine for backtest
 */
function executeGenericFastForward({ stopCondition, successMessage, endOfDataMessage }) {
  if (!state.isBacktestActive) {
    showToast("Бэктест не активен!", "warning");
    return;
  }

  if (state.isFastForwarding) {
    return;
  }

  const baseCandles =
    state.baseTimeframeCache && state.baseTimeframeCache.length > 0
      ? state.baseTimeframeCache
      : state.backtestBaseCandles;

  if (!baseCandles || baseCandles.length === 0) {
    showToast("Нет свечей для бэктеста!", "warning");
    return;
  }

  let nextIdx = baseCandles.findIndex((c) => c.time > state.currentReplayTimestamp);
  if (nextIdx === -1) {
    showToast("Вы уже находитесь в конце доступной истории!", "info");
    return;
  }

  if (isAutoplayRunning) {
    stopAutoplay();
  }

  state.isFastForwarding = true;
  updateDeckStatus("PLAYING");
  showFastForwardIndicator(true);

  let currentIdx = nextIdx;
  const BATCH_SIZE = 500; // Batch processing for ultra-fast calculation without freezing UI

  function processFastForwardBatch() {
    if (!state.isFastForwarding || !state.isBacktestActive) {
      finishFastForward(false, "cancelled");
      return;
    }

    const endIdx = Math.min(currentIdx + BATCH_SIZE, baseCandles.length);
    let hitTarget = false;

    for (let i = currentIdx; i < endIdx; i++) {
      const candle = baseCandles[i];
      state.currentReplayTimestamp = candle.time;

      // checkPendingOrders checks TP/SL on active positions, and executes pending limit/stop orders
      checkPendingOrders(candle);

      if (stopCondition(candle)) {
        hitTarget = true;
        currentIdx = i;
        break;
      }
    }

    if (hitTarget) {
      finishFastForward(true, "hit");
    } else if (endIdx >= baseCandles.length) {
      finishFastForward(false, "end_of_data");
    } else {
      currentIdx = endIdx;
      setTimeout(processFastForwardBatch, 0);
    }
  }

  function finishFastForward(hit, reason) {
    state.isFastForwarding = false;
    showFastForwardIndicator(false);

    if (reason === "cancelled") {
      updateDeckStatus("PAUSED");
      return;
    }

    // Final visual synchronization on the target bar
    updateBacktestVisibleCandles();
    state.lastRenderedCandlesArray = null;
    lastRenderedBacktestCount = 0;
    candlestickSeries.setData(state.backtestVisibleCandles);

    const lastVisible =
      state.backtestVisibleCandles[state.backtestVisibleCandles.length - 1];
    if (lastVisible) {
      updateLegend(lastVisible);
    }
    updateSimulatorUI();
    updateTradeHistoryUI();
    drawAllOnCanvas();

    if (
      typeof updateCOTChartDataForReplay === "function" &&
      typeof cotChartState !== "undefined" &&
      cotChartState.active
    ) {
      updateCOTChartDataForReplay(state.currentReplayTimestamp);
    }

    updateDeckStatus("PAUSED");

    try {
      const timeScale = chart.timeScale();
      if (timeScale) {
        timeScale.scrollToPosition(2, false);
      }
    } catch (e) {}

    if (hit) {
      if (successMessage) showToast(successMessage, "success");
    } else if (reason === "end_of_data") {
      if (endOfDataMessage) showToast(endOfDataMessage, "info");
    }
  }

  processFastForwardBatch();
}

/**
 * Fast-forward backtest to outcome (TP/SL)
 */
function executeFastForwardToOutcome() {
  if (!state.isBacktestActive) {
    return;
  }

  // Find all active or pending positions
  const candidatePositions = (state.positions || []).filter(
    (p) => p.status === "active" || p.status === "pending"
  );

  // If no position exists, do nothing (as strictly required)
  if (candidatePositions.length === 0) {
    return;
  }

  // Check if at least one position has a TP or SL target
  const hasTarget = candidatePositions.some(
    (p) => (p.takeProfit && p.takeProfit > 0) || (p.stopLoss && p.stopLoss > 0)
  );

  if (!hasTarget) {
    showToast("Для перемотки у позиции должен быть задан Take Profit или Stop Loss!", "warning");
    return;
  }

  const initialHistoryLen = tradeHistory.length;
  const initialPosIds = new Set(candidatePositions.map((p) => p.id));

  executeGenericFastForward({
    stopCondition: () => {
      return (
        tradeHistory.length > initialHistoryLen ||
        !state.positions.some(
          (p) => initialPosIds.has(p.id) && (p.status === "active" || p.status === "pending")
        )
      );
    },
    successMessage: "Перемотка завершена: позиция закрыта по TP/SL!",
    endOfDataMessage: "Конец истории: TP или SL не были достигнуты."
  });
}

/**
 * Fast-forward backtest to a specific target price (Expectation Level)
 */
function executeFastForwardToPrice(targetPrice) {
  if (!state.isBacktestActive) {
    showToast("Режим бэктеста не активен!", "warning");
    return;
  }
  if (typeof targetPrice !== "number" || isNaN(targetPrice)) {
    showToast("Некорректная цена для перемотки!", "error");
    return;
  }

  executeGenericFastForward({
    stopCondition: (candle) => {
      const high = candle.high !== undefined ? candle.high : candle.close;
      const low = candle.low !== undefined ? candle.low : candle.close;
      return high >= targetPrice && low <= targetPrice;
    },
    successMessage: `Перемотка завершена: цена достигла уровня ${targetPrice.toFixed(5)}!`,
    endOfDataMessage: "Для данного значения нет точки пересечения"
  });
}

/**
 * Fast-forward backtest to the currently selected Expectation Level
 */
function executeFastForwardToSelectedLevel() {
  if (!activeSelectedObject) {
    showToast("Сначала выделите уровень ожидания на графике!", "warning");
    return;
  }
  let index = activeSelectedObject.index;
  if (activeSelectedObject.type === "wait_level" || activeSelectedObject.type === "wait_level_ff") {
    const lvl = drawings.waitLevels && drawings.waitLevels[index];
    if (lvl) {
      executeFastForwardToPrice(lvl.price);
      return;
    }
  }
  showToast("Сначала выделите уровень ожидания на графике!", "warning");
}

// Hotkey recording state for settings panel
let isRecordingHotkey = false;
let activeRecordingAction = null;
let activeRecordingBadge = null;
let recordingLastKey = null;
let recordingLastTime = 0;
let recordingSingleTimer = null;

function updateHotkeyUIDisplay() {
  document.querySelectorAll(".hotkey-pill[data-action]").forEach((badge) => {
    const actionKey = badge.getAttribute("data-action");
    if (actionKey && appHotkeys[actionKey]) {
      badge.textContent = appHotkeys[actionKey].label || "";
      badge.classList.remove("recording");
    }
  });

  const ffBtn = document.getElementById("backtest-fast-forward-btn");
  if (ffBtn && appHotkeys.fastForward) {
    ffBtn.title = `Перемотка до результата сделки (${appHotkeys.fastForward.label || "2× Пробел"})`;
  }
  const nextBtn = document.getElementById("backtest-next-btn");
  if (nextBtn && appHotkeys.backtestStepForward) {
    nextBtn.title = `Следующий шаг (Свеча) [${appHotkeys.backtestStepForward.label || "L"}]`;
  }
  const prevBtn = document.getElementById("backtest-prev-btn");
  if (prevBtn && appHotkeys.backtestStepBackward) {
    prevBtn.title = `Шаг назад (Свеча) [${appHotkeys.backtestStepBackward.label || "J"}]`;
  }
  const autoplayBtn = document.getElementById("backtest-autoplay-btn");
  if (autoplayBtn && appHotkeys.backtestPlayPause) {
    autoplayBtn.title = `Автопроигрывание [${appHotkeys.backtestPlayPause.label || "P"}]`;
  }

  const buyBtn = document.getElementById("buy-btn");
  if (buyBtn && appHotkeys.quickBuy) {
    buyBtn.title = `BUY [${appHotkeys.quickBuy.label || "B"}]`;
  }
  const sellBtn = document.getElementById("sell-btn");
  if (sellBtn && appHotkeys.quickSell) {
    sellBtn.title = `SELL [${appHotkeys.quickSell.label || "S"}]`;
  }
  const floatBuyBtn = document.getElementById("floating-buy-btn");
  if (floatBuyBtn && appHotkeys.quickBuy) {
    floatBuyBtn.title = `BUY [${appHotkeys.quickBuy.label || "B"}]`;
  }
  const floatSellBtn = document.getElementById("floating-sell-btn");
  if (floatSellBtn && appHotkeys.quickSell) {
    floatSellBtn.title = `SELL [${appHotkeys.quickSell.label || "S"}]`;
  }
  const toggleHistoryBtn = document.getElementById("toggle-history-btn");
  if (toggleHistoryBtn && appHotkeys.toggleTradeJournal) {
    toggleHistoryBtn.title = `Журнал сделок [${appHotkeys.toggleTradeJournal.label || "D"}]`;
  }
}

function startListeningHotkey(badgeEl, actionKey) {
  if (isRecordingHotkey && activeRecordingAction === actionKey) {
    cancelHotkeyRecording();
    return;
  }
  if (isRecordingHotkey) {
    cancelHotkeyRecording();
  }

  isRecordingHotkey = true;
  activeRecordingAction = actionKey;
  activeRecordingBadge = badgeEl;
  recordingLastKey = null;
  recordingLastTime = 0;
  if (recordingSingleTimer) {
    clearTimeout(recordingSingleTimer);
    recordingSingleTimer = null;
  }

  badgeEl.classList.add("recording");
  badgeEl.textContent = "Нажмите клавишу...";
}

function cancelHotkeyRecording() {
  if (recordingSingleTimer) {
    clearTimeout(recordingSingleTimer);
    recordingSingleTimer = null;
  }
  if (activeRecordingBadge && activeRecordingAction) {
    activeRecordingBadge.classList.remove("recording");
    const current = appHotkeys[activeRecordingAction];
    activeRecordingBadge.textContent = current?.label || "";
  }
  isRecordingHotkey = false;
  activeRecordingAction = null;
  activeRecordingBadge = null;
  recordingLastKey = null;
  recordingLastTime = 0;
}

function saveCandidateOrShowConflict(candidate, actionKey) {
  const conflict = checkHotkeyConflict(candidate, actionKey);

  if (conflict) {
    showToast(`Эта клавиша уже используется для: ${conflict}`, "error");
    cancelHotkeyRecording();
    return;
  }

  // No conflict! Save candidate
  appHotkeys[actionKey] = Object.assign({}, appHotkeys[actionKey], candidate);

  try {
    localStorage.setItem("plbt_hotkey_" + actionKey, JSON.stringify(appHotkeys[actionKey]));
    if (actionKey === "fastForward") {
      localStorage.setItem("plbt_hotkey_ff_outcome", JSON.stringify(appHotkeys.fastForward));
    }
  } catch (err) {
    console.warn("Failed to persist hotkey:", err);
  }

  if (activeRecordingBadge) {
    activeRecordingBadge.classList.remove("recording");
    activeRecordingBadge.textContent = candidate.label;
  }

  updateHotkeyUIDisplay();

  isRecordingHotkey = false;
  activeRecordingAction = null;
  activeRecordingBadge = null;
  recordingLastKey = null;
  recordingLastTime = 0;

  showToast(`Горячая клавиша сохранена: ${candidate.label}`, "success");
}

function handleHotkeyRecordingKeydown(e) {
  e.preventDefault();
  e.stopPropagation();

  if (!isRecordingHotkey || !activeRecordingAction || !activeRecordingBadge) return;

  if (e.key === "Escape") {
    cancelHotkeyRecording();
    return;
  }

  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) {
    return;
  }

  const hasModifiers = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey;
  const currentDef = appHotkeys[activeRecordingAction] || {};

  if (hasModifiers) {
    if (recordingSingleTimer) {
      clearTimeout(recordingSingleTimer);
      recordingSingleTimer = null;
    }
    recordingLastKey = null;
    recordingLastTime = 0;

    const candidate = {
      id: currentDef.id || "hotkey_" + activeRecordingAction,
      actionName: currentDef.actionName || "Горячая клавиша",
      actionDesc: currentDef.actionDesc || "",
      timeframe: currentDef.timeframe,
      type: "combo",
      code: e.code,
      ctrl: e.ctrlKey || e.metaKey,
      alt: e.altKey,
      shift: e.shiftKey,
      meta: false,
      label: formatComboLabel(e.ctrlKey || e.metaKey, e.altKey, e.shiftKey, e.code)
    };

    saveCandidateOrShowConflict(candidate, activeRecordingAction);
  } else {
    // Single key press without modifiers: can be double-tap or single key
    const now = Date.now();
    if (recordingLastKey === e.code && (now - recordingLastTime) <= 450) {
      // Confirmed double-press!
      if (recordingSingleTimer) {
        clearTimeout(recordingSingleTimer);
        recordingSingleTimer = null;
      }
      recordingLastKey = null;
      recordingLastTime = 0;

      const candidate = {
        id: currentDef.id || "hotkey_" + activeRecordingAction,
        actionName: currentDef.actionName || "Горячая клавиша",
        actionDesc: currentDef.actionDesc || "",
        timeframe: currentDef.timeframe,
        type: "double",
        code: e.code,
        ctrl: false,
        alt: false,
        shift: false,
        meta: false,
        label: `2× ${formatKeyName(e.code)}`
      };
      saveCandidateOrShowConflict(candidate, activeRecordingAction);
    } else {
      recordingLastKey = e.code;
      recordingLastTime = now;

      if (recordingSingleTimer) {
        clearTimeout(recordingSingleTimer);
      }

      if (activeRecordingBadge) {
        activeRecordingBadge.textContent = `${formatKeyName(e.code)}...`;
      }

      recordingSingleTimer = setTimeout(() => {
        recordingLastKey = null;
        recordingLastTime = 0;
        const candidate = {
          id: currentDef.id || "hotkey_" + activeRecordingAction,
          actionName: currentDef.actionName || "Горячая клавиша",
          actionDesc: currentDef.actionDesc || "",
          timeframe: currentDef.timeframe,
          type: "combo",
          code: e.code,
          ctrl: false,
          alt: false,
          shift: false,
          meta: false,
          label: formatKeyName(e.code)
        };
        saveCandidateOrShowConflict(candidate, activeRecordingAction);
      }, 450);
    }
  }
}

// ----------------------------------------------------
// HOTKEY ACTION HANDLERS & HELPERS
// ----------------------------------------------------

function toggleBacktestPlayPause() {
  if (!state.isBacktestActive) {
    showToast("Бэктест не активен", "warning");
    return;
  }
  if (isAutoplayRunning) {
    stopAutoplay();
    showToast("Бэктест: Пауза", "info");
  } else {
    startAutoplay();
    showToast("Бэктест: Воспроизведение", "info");
  }
}

function increaseBacktestSpeed() {
  if (!state.isBacktestActive) {
    showToast("Бэктест не активен", "warning");
    return;
  }
  const currentVal = parseFloat(autoplaySpeedInput ? autoplaySpeedInput.value : 1.0) || 1.0;
  let newVal = currentVal;
  // Increase playback speed = reduce delay
  if (currentVal > 1.0) {
    newVal = Math.max(0.05, currentVal - 0.25);
  } else if (currentVal > 0.2) {
    newVal = Math.max(0.05, currentVal - 0.1);
  } else {
    newVal = Math.max(0.05, currentVal - 0.05);
  }
  newVal = Math.round(newVal * 100) / 100;
  updateSpeed(newVal);
  showToast(`Скорость: ${newVal.toFixed(2)} с/бар`, "info");
}

function decreaseBacktestSpeed() {
  if (!state.isBacktestActive) {
    showToast("Бэктест не активен", "warning");
    return;
  }
  const currentVal = parseFloat(autoplaySpeedInput ? autoplaySpeedInput.value : 1.0) || 1.0;
  let newVal = currentVal;
  // Decrease playback speed = increase delay
  if (currentVal < 0.2) {
    newVal = Math.min(3.0, currentVal + 0.05);
  } else if (currentVal < 1.0) {
    newVal = Math.min(3.0, currentVal + 0.1);
  } else {
    newVal = Math.min(3.0, currentVal + 0.25);
  }
  newVal = Math.round(newVal * 100) / 100;
  updateSpeed(newVal);
  showToast(`Скорость: ${newVal.toFixed(2)} с/бар`, "info");
}

function switchTimeframe(targetTf) {
  const tfSelect = document.getElementById("timeframe-select");
  if (!tfSelect) return;
  if (state.timeframe === targetTf) return;

  const option = Array.from(tfSelect.options).find((o) => o.value === targetTf);
  if (!option) {
    showToast(`Таймфрейм ${targetTf} не найден`, "warning");
    return;
  }

  if (option.disabled) {
    showToast(`Таймфрейм ${targetTf} меньше базового таймфрейма данных`, "warning");
    return;
  }

  tfSelect.value = targetTf;
  tfSelect.dispatchEvent(new Event("change"));
  showToast(`Таймфрейм изменён на ${option.textContent.trim() || targetTf}`, "info");
}

// Indicator persistence and restoration
try {
  const savedLastInd = localStorage.getItem("plbt_last_indicator");
  if (savedLastInd) {
    state.lastIndicator = JSON.parse(savedLastInd);
  }
} catch (e) {}

function recordLastIndicator(id, name, customSettings) {
  const panel = document.getElementById("cot-indicator-panel");
  const height = panel ? parseInt(panel.style.height || "210", 10) : 210;

  const settings = customSettings || {
    reportType: (typeof cotChartState !== "undefined" && cotChartState.reportType) || "combined",
    market: (typeof cotChartState !== "undefined" && cotChartState.market) || "AUTO",
    displayMode: (typeof cotChartState !== "undefined" && cotChartState.displayMode) || "histogram",
    blindMode: (typeof cotChartState !== "undefined" && Boolean(cotChartState.blindMode)) || false,
    visibles: (typeof cotChartState !== "undefined" && cotChartState.visibles) ? Object.assign({}, cotChartState.visibles) : { nonComm: true, comm: true, retail: true, oi: true },
    height: !isNaN(height) && height >= 80 ? height : 210
  };

  const indicatorData = {
    id: id || "cot",
    name: name || "COT Report (CFTC)",
    settings,
    savedAt: Date.now()
  };

  state.lastIndicator = indicatorData;
  try {
    localStorage.setItem("plbt_last_indicator", JSON.stringify(indicatorData));
  } catch (err) {
    console.warn("Failed to persist last indicator:", err);
  }
}

function restoreLastIndicator() {
  const last = state.lastIndicator;
  if (!last || !last.id) {
    showToast("Нет недавнего индикатора для добавления", "info");
    return;
  }

  if (last.id === "cot") {
    // If indicator is already active, do nothing
    if (typeof cotChartState !== "undefined" && cotChartState.active) {
      return;
    }

    if (last.settings) {
      if (last.settings.reportType) {
        cotChartState.reportType = last.settings.reportType;
        localStorage.setItem("plbt_cot_report_type", cotChartState.reportType);
        const reportTypeSelect = document.getElementById("cot-report-type-select");
        if (reportTypeSelect) reportTypeSelect.value = cotChartState.reportType;
      }
      if (last.settings.market) {
        cotChartState.market = last.settings.market;
        const marketSelect = document.getElementById("cot-market-select");
        if (marketSelect) marketSelect.value = cotChartState.market;
      }
      if (last.settings.displayMode) {
        cotChartState.displayMode = last.settings.displayMode;
        const modeSelect = document.getElementById("cot-display-mode-select");
        if (modeSelect) modeSelect.value = cotChartState.displayMode;
      }
      if (typeof last.settings.blindMode === "boolean") {
        cotChartState.blindMode = last.settings.blindMode;
        localStorage.setItem("plbt_cot_blind_mode", cotChartState.blindMode ? "true" : "false");
        const cotToggleBlindMode = document.getElementById("cot-toggle-blind-mode");
        const cotCfgBlindMode = document.getElementById("cot-cfg-blind-mode");
        if (cotToggleBlindMode) cotToggleBlindMode.checked = cotChartState.blindMode;
        if (cotCfgBlindMode) cotCfgBlindMode.checked = cotChartState.blindMode;
      }
      if (last.settings.visibles) {
        cotChartState.visibles = Object.assign(cotChartState.visibles, last.settings.visibles);
        const cotToggleNonComm = document.getElementById("cot-toggle-noncomm");
        const cotToggleComm = document.getElementById("cot-toggle-comm");
        const cotToggleRetail = document.getElementById("cot-toggle-retail");
        const cotToggleOI = document.getElementById("cot-toggle-oi");
        if (cotToggleNonComm) cotToggleNonComm.checked = cotChartState.visibles.nonComm;
        if (cotToggleComm) cotToggleComm.checked = cotChartState.visibles.comm;
        if (cotToggleRetail) cotToggleRetail.checked = cotChartState.visibles.retail;
        if (cotToggleOI) cotToggleOI.checked = cotChartState.visibles.oi;
      }
      if (last.settings.height && typeof COT_STORAGE_HEIGHT_KEY !== "undefined") {
        localStorage.setItem(COT_STORAGE_HEIGHT_KEY, last.settings.height.toString());
      }
    }

    if (typeof openCOTIndicatorPanel === "function") {
      openCOTIndicatorPanel();
    }
    if (typeof applyCOTSeriesVisibility === "function") {
      applyCOTSeriesVisibility();
    }
    showToast(`Восстановлен индикатор: ${last.name || "COT Report"}`, "success");
  } else {
    showToast(`Индикатор ${last.name || last.id} недоступен`, "info");
  }
}

// ----------------------------------------------------
// CHART ZOOM, SCROLL & NAVIGATION HELPERS
// ----------------------------------------------------

function zoomChart(factor) {
  try {
    if (!chart || typeof chart.timeScale !== "function") return;
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) return;

    const span = range.to - range.from;
    if (span <= 0) return;

    // factor: +0.15 (zoom in) or -0.15 (zoom out)
    const delta = span * factor;
    const newSpan = span - delta;

    if (factor > 0 && newSpan < 4) return;
    if (factor < 0 && newSpan > 6000) return;

    const half = delta / 2;
    ts.setVisibleLogicalRange({
      from: range.from + half,
      to: range.to - half
    });

    if (typeof syncCOTTimeScaleWithMain === "function") {
      syncCOTTimeScaleWithMain();
    }
    if (typeof requestDrawAllOnCanvas === "function") {
      requestDrawAllOnCanvas();
    } else if (typeof drawAllOnCanvas === "function") {
      drawAllOnCanvas();
    }
  } catch (err) {
    console.warn("zoomChart error:", err);
  }
}

function scrollChart(direction) {
  try {
    if (!chart || typeof chart.timeScale !== "function") return;
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (!range) return;

    const span = range.to - range.from;
    if (span <= 0) return;

    // direction: -1 (left / history), +1 (right / forward)
    const step = Math.max(2, Math.min(25, Math.round(span * 0.075)));
    const shift = direction * step;

    ts.setVisibleLogicalRange({
      from: range.from + shift,
      to: range.to + shift
    });

    if (typeof syncCOTTimeScaleWithMain === "function") {
      syncCOTTimeScaleWithMain();
    }
    if (typeof requestDrawAllOnCanvas === "function") {
      requestDrawAllOnCanvas();
    } else if (typeof drawAllOnCanvas === "function") {
      drawAllOnCanvas();
    }
  } catch (err) {
    console.warn("scrollChart error:", err);
  }
}

function fitChartContent() {
  try {
    if (typeof recenterView === "function") {
      recenterView();
      showToast("Масштаб графика сброшен", "info");
    } else if (chart && typeof chart.timeScale === "function") {
      chart.timeScale().fitContent();
      if (typeof chart.priceScale === "function") {
        chart.priceScale("right").applyOptions({ autoScale: true });
      }
      showToast("Масштаб графика сброшен", "info");
    }
  } catch (err) {
    console.warn("fitChartContent error:", err);
  }
}

// ----------------------------------------------------
// QUICK TRADING OPERATIONS (BUY, SELL, CLOSE ALL)
// ----------------------------------------------------

function executeQuickOrder(type) {
  try {
    const activeAcc = getActiveAccount();
    if (activeAcc && (activeAcc.status === "FAILED" || activeAcc.status === "FINISHED")) {
      showToast(`Торговля заблокирована: счёт находится в статусе ${activeAcc.status}!`, "error");
      return;
    }

    const arr = state.isBacktestActive
      ? state.backtestVisibleCandles
      : state.historicalCandles;
    if (!arr || arr.length === 0) {
      showToast(
        state.isBacktestActive
          ? "Кликните на свечу для старта бэктеста!"
          : "Пожалуйста, подождите загрузки котировок!",
        "error"
      );
      return;
    }

    const candle = arr[arr.length - 1];
    const price = candle.close;
    const size = parseFloat(volumeInput ? volumeInput.value : 1.0) || 1.0;
    const leverage = parseInt(leverageInput ? leverageInput.value : 100) || 100;
    const commission = size * (state.commissionPerLot || 0);
    const requiredMargin = (size * 100000 * price) / leverage;
    let marginUSD = (state.symbol && state.symbol.endsWith("_JPY"))
      ? requiredMargin / price
      : requiredMargin;

    if (marginUSD + commission > balance) {
      showToast("Недостаточно средств для сделки!", "error");
      return;
    }

    balance -= commission;
    saveBalance(balance);

    const tpInput = document.getElementById("order-tp-input");
    const slInput = document.getElementById("order-sl-input");
    const isJpy = state.symbol && (state.symbol.endsWith("_JPY") || state.symbol.includes("JPY"));
    const pipStep = isJpy ? 0.100 : 0.00100;
    const decimals = isJpy ? 3 : 5;

    let takeProfit = tpInput && tpInput.value ? parseFloat(tpInput.value) : undefined;
    let stopLoss = slInput && slInput.value ? parseFloat(slInput.value) : undefined;

    if (!takeProfit) {
      takeProfit = type === "buy" ? price + pipStep : price - pipStep;
    }
    if (!stopLoss) {
      stopLoss = type === "buy" ? price - pipStep : price + pipStep;
    }

    takeProfit = parseFloat(takeProfit.toFixed(decimals));
    stopLoss = parseFloat(stopLoss.toFixed(decimals));

    const newPosition = {
      id: Date.now(),
      account_id: activeAccountId,
      symbol: state.symbol,
      type: type,
      entryPrice: price,
      size: size,
      leverage: leverage,
      commission: commission,
      timestamp: new Date().toISOString(),
      entryTime: candle ? candle.time : undefined,
      status: "active",
      orderType: "market",
      triggerPrice: price,
      takeProfit: takeProfit,
      tp: takeProfit,
      stopLoss: stopLoss,
      sl: stopLoss,
      notes: {
        noteBefore: "",
        noteDuring: "",
        noteAfter: "",
      },
    };

    state.positions.push(newPosition);

    if (tpInput) tpInput.value = "";
    if (slInput) slInput.value = "";

    playSound("open");
    saveSimulatorState();
    updateSimulatorUI();
    if (typeof drawAllOnCanvas === "function") {
      drawAllOnCanvas();
    }

    showToast(
      `Быстрый ${type.toUpperCase()}: открыта позиция ${size} L @ ${price.toFixed(decimals)}`,
      "success"
    );
  } catch (err) {
    console.error("executeQuickOrder error:", err);
  }
}

function getActiveOpenPositions() {
  if (!state.positions || !Array.isArray(state.positions)) return [];
  return state.positions.filter((p) => {
    const isSameAccount = !p.account_id || p.account_id === activeAccountId;
    const isActive = p.status === "active" || (!p.status && p.status !== "draft" && p.status !== "pending");
    return isSameAccount && isActive;
  });
}

function promptCloseAllPositions() {
  const openPositions = getActiveOpenPositions();
  // Если открытых позиций нет в момент нажатия — ничего не делать (не показывать диалог)
  if (openPositions.length === 0) {
    return;
  }

  const modal = document.getElementById("close-all-positions-confirm-modal");
  const modalText = document.getElementById("close-all-positions-modal-text");
  if (modal) {
    if (modalText) {
      const count = openPositions.length;
      modalText.innerHTML = `Вы действительно хотите закрыть все <b>${count}</b> открытых сделок на счёте по текущим ценам?<br><span style="color: #94a3b8; font-size: 11px; margin-top: 4px; display: block;">Это действие необратимо и сразу зафиксирует финансовый результат.</span>`;
    }
    modal.style.display = "flex";
  }
}

function executeCloseAllPositions() {
  try {
    const openPositions = getActiveOpenPositions();
    if (openPositions.length === 0) return;

    const count = openPositions.length;
    let totalPnl = 0;

    const arr = state.isBacktestActive
      ? state.backtestVisibleCandles
      : state.historicalCandles;
    const currentCandle = arr && arr.length > 0 ? arr[arr.length - 1] : null;
    const price = currentCandle ? currentCandle.close : null;
    const closingCandleTime = currentCandle ? currentCandle.time : undefined;

    openPositions.forEach((pos) => {
      const exitPrice = price !== null ? price : pos.entryPrice;
      let pnl = 0;
      const units = pos.size * 100000;
      if (pos.type === "buy") {
        pnl = (exitPrice - pos.entryPrice) * units;
      } else {
        pnl = (pos.entryPrice - exitPrice) * units;
      }
      if (pos.symbol && pos.symbol.endsWith("_JPY")) {
        pnl = pnl / exitPrice;
      }
      totalPnl += pnl;
      balance += pnl;

      const closedTrade = {
        id: pos.id,
        account_id: pos.account_id || activeAccountId,
        symbol: pos.symbol,
        type: pos.type,
        size: pos.size,
        leverage: pos.leverage,
        commission: pos.commission,
        entryPrice: pos.entryPrice,
        exitPrice: exitPrice,
        pnl: pnl,
        close_reason: Math.abs(pnl) <= 1.0 ? "BU" : "MANUAL",
        openTime: pos.timestamp,
        closeTime: new Date().toISOString(),
        timestamp: new Date().toISOString(),
        entryTime: pos.entryTime,
        exitTime: closingCandleTime,
        notes: {
          noteBefore: pos.notes ? pos.notes.noteBefore : "",
          noteDuring: pos.notes ? pos.notes.noteDuring : "",
          noteAfter: pos.notes ? pos.notes.noteAfter : "",
        },
      };
      tradeHistory.push(closedTrade);

      const idx = state.positions.findIndex((p) => p.id === pos.id);
      if (idx !== -1) {
        state.positions.splice(idx, 1);
      }
    });

    playSound("close");
    saveBalance(balance);
    saveAccountsToStorage();
    try {
      localStorage.setItem("plbt_trade_history", JSON.stringify(tradeHistory));
    } catch (e) {}
    if (typeof updateTradeHistoryUI === "function") {
      updateTradeHistoryUI();
    }
    saveSimulatorState();
    updateSimulatorUI();
    if (typeof drawAllOnCanvas === "function") {
      drawAllOnCanvas();
    }

    const sign = totalPnl >= 0 ? "+" : "";
    showToast(
      `Закрыто сделок: ${count}. Итог: ${sign}$${totalPnl.toFixed(2)}`,
      totalPnl >= 0 ? "success" : "error"
    );
  } catch (err) {
    console.error("executeCloseAllPositions error:", err);
  }
}

function initCloseAllConfirmModalEvents() {
  const modal = document.getElementById("close-all-positions-confirm-modal");
  const submitBtn = document.getElementById("close-all-positions-confirm-submit-btn");
  const cancelBtn = document.getElementById("close-all-positions-confirm-cancel-btn");

  if (!modal) return;

  function closeModal() {
    modal.style.display = "none";
  }

  if (submitBtn && !submitBtn._hasCloseAllListener) {
    submitBtn._hasCloseAllListener = true;
    submitBtn.addEventListener("click", () => {
      closeModal();
      executeCloseAllPositions();
    });
  }

  if (cancelBtn && !cancelBtn._hasCloseAllListener) {
    cancelBtn._hasCloseAllListener = true;
    cancelBtn.addEventListener("click", closeModal);
  }

  if (!modal._hasCloseAllBackdropListener) {
    modal._hasCloseAllBackdropListener = true;
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closeModal();
      }
    });
  }
}

// ----------------------------------------------------
// UI INTERFACE HELPERS (TRADE JOURNAL TOGGLE)
// ----------------------------------------------------

function toggleTradeJournalUI() {
  try {
    const notesModal = document.getElementById("notes-modal");
    if (notesModal && (notesModal.style.display === "flex" || notesModal.classList.contains("active"))) {
      const closeNotesBtn = document.getElementById("notes-close-header-btn");
      if (closeNotesBtn) {
        closeNotesBtn.click();
      } else {
        notesModal.style.display = "none";
        notesModal.classList.remove("active");
      }
      return;
    }

    if (typeof window.toggleTradeHistoryPanel === "function") {
      window.toggleTradeHistoryPanel();
    } else {
      const panel = document.getElementById("trade-history-panel");
      if (panel) {
        const isHidden = panel.style.display === "none" || panel.style.display === "" || panel.classList.contains("collapsed");
        panel.style.display = isHidden ? "flex" : "none";
        panel.classList.toggle("collapsed", !isHidden);
      }
    }
  } catch (err) {
    console.warn("toggleTradeJournalUI error:", err);
  }
}

let customHotkeysLastTap = {};

function executeCustomHotkeyAction(actionKey, hk) {
  switch (actionKey) {
    case "backtestPlayPause":
      toggleBacktestPlayPause();
      return true;
    case "backtestStepForward":
      if (isAutoplayRunning) stopAutoplay();
      stepBacktestForward();
      return true;
    case "backtestStepBackward":
      stepBacktestBackward();
      return true;
    case "backtestSpeedUp":
      increaseBacktestSpeed();
      return true;
    case "backtestSpeedDown":
      decreaseBacktestSpeed();
      return true;
    case "fastForwardToLevel":
      executeFastForwardToSelectedLevel();
      return true;
    case "restoreLastIndicator":
      restoreLastIndicator();
      return true;
    case "zoomIn":
      zoomChart(0.15);
      return true;
    case "zoomOut":
      zoomChart(-0.15);
      return true;
    case "scrollLeft":
      scrollChart(-1);
      return true;
    case "scrollRight":
      scrollChart(1);
      return true;
    case "fitContent":
      fitChartContent();
      return true;
    case "quickBuy":
      executeQuickOrder("buy");
      return true;
    case "quickSell":
      executeQuickOrder("sell");
      return true;
    case "closeAllPositions":
      promptCloseAllPositions();
      return true;
    case "toggleTradeJournal":
      toggleTradeJournalUI();
      return true;
    default:
      if (actionKey.startsWith("tf_") && hk.timeframe) {
        switchTimeframe(hk.timeframe);
        return true;
      }
      break;
  }
  return false;
}

function dispatchCustomHotkeys(e) {
  const actionKeys = Object.keys(appHotkeys);

  for (const actionKey of actionKeys) {
    if (actionKey === "fastForward") continue;
    const hk = appHotkeys[actionKey];
    if (!hk) continue;

    if (hk.type === "double") {
      const isSameCode = e.code === hk.code;
      const noModifiers = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
      if (isSameCode && noModifiers) {
        const now = Date.now();
        if (customHotkeysLastTap[actionKey] && (now - customHotkeysLastTap[actionKey]) <= 450) {
          e.preventDefault();
          customHotkeysLastTap[actionKey] = 0;
          return executeCustomHotkeyAction(actionKey, hk);
        } else {
          customHotkeysLastTap[actionKey] = now;
          return false;
        }
      } else {
        customHotkeysLastTap[actionKey] = 0;
      }
    } else {
      const matchCtrl = Boolean(hk.ctrl) === (e.ctrlKey || e.metaKey);
      const matchAlt = Boolean(hk.alt) === e.altKey;
      const matchShift = Boolean(hk.shift) === e.shiftKey;
      const matchCode = e.code === hk.code;

      if (matchCode && matchCtrl && matchAlt && matchShift) {
        e.preventDefault();
        return executeCustomHotkeyAction(actionKey, hk);
      }
    }
  }

  return false;
}

function initHotkeysSettingsUI() {
  if (typeof lucide !== "undefined" && lucide.createIcons) {
    lucide.createIcons();
  }

  initCloseAllConfirmModalEvents();

  // Click on pill directly to enter listening mode
  document.querySelectorAll(".hotkey-pill[data-action]").forEach((badge) => {
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      const actionKey = badge.getAttribute("data-action");
      if (actionKey) {
        startListeningHotkey(badge, actionKey);
      }
    });
  });

  // Timeframe group accordion header toggle
  const tfGroupHeader = document.getElementById("hotkey-tf-group-header");
  const tfGroupItems = document.getElementById("hotkey-tf-group-items");
  const tfGroupChevron = document.getElementById("hotkey-tf-group-chevron");

  if (tfGroupHeader && tfGroupItems) {
    tfGroupHeader.addEventListener("click", (e) => {
      e.stopPropagation();
      const isOpen = tfGroupItems.style.display === "flex";
      tfGroupItems.style.display = isOpen ? "none" : "flex";
      if (tfGroupChevron) {
        tfGroupChevron.style.transform = isOpen ? "rotate(0deg)" : "rotate(180deg)";
      }
    });
  }

  const resetDefaultBtn = document.getElementById("hotkey-reset-default-btn");
  if (resetDefaultBtn) {
    resetDefaultBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      cancelHotkeyRecording();
      Object.keys(DEFAULT_HOTKEYS).forEach((key) => {
        appHotkeys[key] = Object.assign({}, DEFAULT_HOTKEYS[key]);
        try {
          localStorage.removeItem("plbt_hotkey_" + key);
        } catch (err) {}
      });
      try {
        localStorage.removeItem("plbt_hotkey_ff_outcome");
      } catch (err) {}
      updateHotkeyUIDisplay();
      showToast("Все горячие клавиши сброшены по умолчанию", "info");
    });
  }

  updateHotkeyUIDisplay();
}

// ==========================================
// SETTINGS GEAR & SOUND TOGGLE INTERACTION
// ==========================================
function initSettingsMenu() {
  const settingsToggleBtn = document.getElementById("settings-toggle-btn");
  const settingsDropdown = document.getElementById("settings-dropdown");
  const viewMain = document.getElementById("settings-view-main");
  const viewHotkeys = document.getElementById("settings-view-hotkeys");
  const navToHotkeysBtn = document.getElementById("settings-nav-hotkeys-btn");
  const backToMainBtn = document.getElementById("settings-back-to-main-btn");
  const toggleSoundEffects = document.getElementById("toggle-sound-effects");
  const toggleSystemNotifications = document.getElementById("toggle-system-notifications");

  if (settingsToggleBtn && settingsDropdown) {
    settingsToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isVisible = settingsDropdown.style.display === "block";
      if (isVisible) {
        cancelHotkeyRecording();
        settingsDropdown.style.display = "none";
      } else {
        // Always show main settings view first when opened
        if (viewMain) viewMain.style.display = "block";
        if (viewHotkeys) viewHotkeys.style.display = "none";
        settingsDropdown.style.display = "block";
        if (typeof lucide !== "undefined" && lucide.createIcons) {
          lucide.createIcons();
        }
      }
    });

    // Close on click outside settings dropdown
    document.addEventListener("click", (e) => {
      if (settingsDropdown.style.display === "block" && !settingsDropdown.contains(e.target) && e.target !== settingsToggleBtn) {
        cancelHotkeyRecording();
        settingsDropdown.style.display = "none";
        if (viewMain) viewMain.style.display = "block";
        if (viewHotkeys) viewHotkeys.style.display = "none";
      }
    });
  }

  // Navigation: Main View -> Hotkeys Subview
  if (navToHotkeysBtn) {
    navToHotkeysBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (viewMain) viewMain.style.display = "none";
      if (viewHotkeys) viewHotkeys.style.display = "block";
      updateHotkeyUIDisplay();
      if (typeof lucide !== "undefined" && lucide.createIcons) {
        lucide.createIcons();
      }
    });
  }

  // Navigation: Hotkeys Subview -> Main View
  if (backToMainBtn) {
    backToMainBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      cancelHotkeyRecording();
      if (viewHotkeys) viewHotkeys.style.display = "none";
      if (viewMain) viewMain.style.display = "block";
      if (typeof lucide !== "undefined" && lucide.createIcons) {
        lucide.createIcons();
      }
    });
  }

  // Outside click when in hotkey recording mode (cancels without changes)
  document.addEventListener("click", (e) => {
    if (isRecordingHotkey && activeRecordingBadge) {
      if (!activeRecordingBadge.contains(e.target) && e.target !== activeRecordingBadge) {
        cancelHotkeyRecording();
      }
    }
  });

  if (toggleSoundEffects) {
    toggleSoundEffects.checked = isSoundEnabled;
    toggleSoundEffects.addEventListener("change", (e) => {
      isSoundEnabled = e.target.checked;
      localStorage.setItem("is_sound_enabled", isSoundEnabled);
      showToast(`Звуковые эффекты ${isSoundEnabled ? "включены" : "выключены"}`, "info");
    });
  }

  if (toggleSystemNotifications) {
    toggleSystemNotifications.checked = isNotificationsEnabled;
    toggleSystemNotifications.addEventListener("change", (e) => {
      isNotificationsEnabled = e.target.checked;
      localStorage.setItem("is_notifications_enabled", isNotificationsEnabled ? "true" : "false");
      if (isNotificationsEnabled) {
        showToast("Системные уведомления включены", "info");
      }
    });
  }

  initHotkeysSettingsUI();
}

// Initialize settings
initSettingsMenu();

// ==========================================
// DRAFT ORDER CONFIRMATION & SMART NOTIFICATIONS
// ==========================================
window.confirmDraftOrder = (id) => {
  const pos = state.positions.find((p) => p.id === id);
  if (!pos) return;

  const isJpy = state.symbol && (state.symbol.endsWith("_JPY") || state.symbol.includes("JPY"));
  const decimals = isJpy ? 3 : 5;

  // 1. Сохранение цены (No Teleport):
  // При нажатии на CONFIRM функция ОБЯЗАНА брать ту цену, на которой сейчас физически стоит плашка драфта (координата Y / draftPrice).
  // КАТЕГОРИЧЕСКИ ЗАПРЕЩАЕТСЯ приравнивать цену этого ордера к текущей рыночной цене для лимитных/стоп ордеров.
  if (pos.orderType === "limit" || pos.orderType === "stop") {
    // Keep pos.entryPrice and pos.triggerPrice exactly as they are on the draft!
    // No-op, we do not touch or change them.
  } else if (pos.orderType === "market") {
    const arr = state.isBacktestActive
      ? state.backtestVisibleCandles
      : state.historicalCandles;
    if (arr && arr.length > 0) {
      const actualPrice = arr[arr.length - 1].close;
      // If a market order draft was dragged away from the market price, convert it to a limit/stop pending order
      const priceTolerance = 0.00001;
      if (Math.abs(pos.entryPrice - actualPrice) > priceTolerance) {
        const isBuy = pos.type === "buy" || pos.type === "Long" || pos.type === "long";
        pos.orderType = isBuy
          ? (pos.entryPrice < actualPrice ? "limit" : "stop")
          : (pos.entryPrice > actualPrice ? "limit" : "stop");
      } else {
        // Not dragged, execute immediately at actual market price
        pos.entryPrice = actualPrice;
        pos.triggerPrice = actualPrice;
        
        let tpDiff = undefined;
        let slDiff = undefined;
        if (pos.takeProfit && pos.takeProfit > 0) {
          tpDiff = Math.abs(pos.takeProfit - pos.entryPrice);
        }
        if (pos.stopLoss && pos.stopLoss > 0) {
          slDiff = Math.abs(pos.stopLoss - pos.entryPrice);
        }
        
        const isBuy = pos.type === "buy" || pos.type === "Long" || pos.type === "long";
        if (tpDiff !== undefined) {
          const newTP = isBuy ? (actualPrice + tpDiff) : (actualPrice - tpDiff);
          pos.takeProfit = parseFloat(newTP.toFixed(decimals));
          pos.tp = pos.takeProfit;
        }
        if (slDiff !== undefined) {
          const newSL = isBuy ? (actualPrice - slDiff) : (actualPrice + slDiff);
          pos.stopLoss = parseFloat(newSL.toFixed(decimals));
          pos.sl = pos.stopLoss;
        }
      }
    }
  }

  // 2. Смена статуса (Draft -> Pending для лимитных/стоп, или Active для рыночных):
  const targetStatus = (pos.orderType === "market" ? "active" : "pending");
  pos.status = targetStatus;

  playSound("open");
  saveSimulatorState();
  updateSimulatorUI();
  drawAllOnCanvas();

  showToast(
    targetStatus === "active"
      ? `Ордер подтвержден! Позиция открыта по цене ${pos.entryPrice.toFixed(decimals)}`
      : `Ордер подтвержден! Отложенный ордер ${pos.orderType.toUpperCase()} выставлен по цене ${pos.entryPrice.toFixed(decimals)}`,
    "success"
  );
};

// Smart transparency for notification banner & toast notifications
let toastRafPending = false;
document.addEventListener("mousemove", (e) => {
  if (toastRafPending) return;
  const toastContainer = document.getElementById("toast-container");
  const banner = document.getElementById("notification-banner");
  const hasToasts = toastContainer && toastContainer.children.length > 0;
  const hasBanner = banner && banner.style.display !== "none" && !banner.classList.contains("closing");
  if (!hasToasts && !hasBanner) return;

  toastRafPending = true;
  const x = e.clientX;
  const y = e.clientY;

  requestAnimationFrame(() => {
    toastRafPending = false;

    // 1. Check if mouse is over any of the right-side top header controls or floating window controls
    let isOverControls = false;
    const selectors = ["#toggle-history-btn", ".win-control-btn"];
    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        if (
          x >= rect.left &&
          x <= rect.right &&
          y >= rect.top &&
          y <= rect.bottom
        ) {
          isOverControls = true;
          break;
        }
      }
      if (isOverControls) break;
    }

    // 2. Process all toast notifications inside #toast-container
    if (hasToasts) {
      const toasts = document.querySelectorAll("#toast-container > div");
      toasts.forEach((toast) => {
        toast.style.transition = "opacity 0.2s ease, transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)";
        const rect = toast.getBoundingClientRect();
        const isOverToast = (
          x >= rect.left &&
          x <= rect.right &&
          y >= rect.top &&
          y <= rect.bottom
        );

        if (isOverToast) {
          toast.style.opacity = "0.2";
          toast.style.pointerEvents = isOverControls ? "none" : "auto";
        } else {
          toast.style.opacity = "1";
          toast.style.pointerEvents = "auto";
        }
      });
    }

    // 3. Process notification banner
    if (hasBanner) {
      banner.style.transition = "opacity 0.2s ease, transform 0.5s ease";
      const rect = banner.getBoundingClientRect();
      const isOverBanner = (
        x >= rect.left &&
        x <= rect.right &&
        y >= rect.top &&
        y <= rect.bottom
      );

      if (isOverBanner) {
        banner.style.opacity = "0.2";
        banner.style.pointerEvents = isOverControls ? "none" : "auto";
      } else {
        banner.style.opacity = "1";
        banner.style.pointerEvents = "auto";
      }
    }
  });
}, { passive: true });

// ==========================================
// FLOATING TRADE PANEL INITIALIZATION
// ==========================================
function initFloatingTradePanel() {
  const fTradeBtn = document.getElementById("floating-trade-btn");
  const fTradeDropdown = document.getElementById("floating-trade-dropdown");
  const fOtTabs = document.querySelectorAll(".floating-ot-tab");
  const fPriceGroup = document.getElementById("floating-price-group");
  const orderTypeSelect = document.getElementById("order-type-select");
  const fPrice = document.getElementById("floating-order-price");
  const priceInput = document.getElementById("order-price-input");
  const fVol = document.getElementById("floating-order-volume");
  const fLev = document.getElementById("floating-order-leverage");
  const fTp = document.getElementById("floating-order-tp");
  const tpInput = document.getElementById("order-tp-input");
  const fSl = document.getElementById("floating-order-sl");
  const slInput = document.getElementById("order-sl-input");
  const fBuyBtn = document.getElementById("floating-buy-btn");
  const fSellBtn = document.getElementById("floating-sell-btn");

  if (fTradeBtn && fTradeDropdown) {
    fTradeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.isTradeModeActive = !state.isTradeModeActive;

      if (state.isTradeModeActive) {
        // Active Trade Mode style (green border/outline)
        fTradeBtn.style.border = "2px solid #10b981"; // green border
        fTradeBtn.style.boxShadow = "0 0 10px rgba(16, 185, 129, 0.4)";
        fTradeDropdown.style.display = "block";

        // Sync values on open
        if (fVol && volumeInput) fVol.value = volumeInput.value;
        if (fLev && leverageInput) fLev.value = leverageInput.value;
        if (fTp && tpInput) fTp.value = tpInput.value;
        if (fSl && slInput) fSl.value = slInput.value;
        if (fPrice && priceInput) fPrice.value = priceInput.value;
        showToast("Режим торговли АКТИВИРОВАН. Нажмите на график для создания ордера.", "success");
      } else {
        // Normal state style
        fTradeBtn.style.border = "1px solid var(--border-hover)";
        fTradeBtn.style.boxShadow = "none";
        fTradeDropdown.style.display = "none";
        showToast("Режим торговли ДЕАКТИВИРОВАН.", "info");
      }
    });

    fTradeDropdown.addEventListener("mousedown", (e) => {
      e.stopPropagation();
    });
    fTradeDropdown.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    document.addEventListener("click", (e) => {
      if (fTradeDropdown.style.display === "block" && !fTradeDropdown.contains(e.target) && e.target !== fTradeBtn) {
        fTradeDropdown.style.display = "none";
        state.isTradeModeActive = false;
        fTradeBtn.style.border = "1px solid var(--border-hover)";
        fTradeBtn.style.boxShadow = "none";
      }
    });
  }

  function refreshFloatingTabStyles() {
    fOtTabs.forEach((t) => {
      if (t.classList.contains("active")) {
        t.style.background = "#1e293b";
        t.style.color = "#ffffff";
        t.style.borderColor = "var(--color-accent)";
      } else {
        t.style.background = "rgba(255,255,255,0.02)";
        t.style.color = "#94a3b8";
        t.style.borderColor = "#1e293b";
      }
    });
  }

  if (fOtTabs) {
    refreshFloatingTabStyles();
    fOtTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        fOtTabs.forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        refreshFloatingTabStyles();
        const oType = tab.getAttribute("data-type");
        if (orderTypeSelect) {
          orderTypeSelect.value = oType;
          orderTypeSelect.dispatchEvent(new Event("change"));
        }
        if (oType === "market") {
          fPriceGroup.style.display = "none";
        } else {
          fPriceGroup.style.display = "flex";
          const arr = state.isBacktestActive ? state.backtestVisibleCandles : state.historicalCandles;
          if (fPrice && arr && arr.length > 0 && !fPrice.value) {
            fPrice.value = arr[arr.length - 1].close.toFixed(5);
            if (priceInput) {
              priceInput.value = fPrice.value;
              priceInput.dispatchEvent(new Event("input"));
            }
          }
        }
      });
    });
  }

  if (fVol && volumeInput) {
    fVol.value = volumeInput.value;
    fVol.addEventListener("input", () => {
      volumeInput.value = fVol.value;
      volumeInput.dispatchEvent(new Event("input"));
    });
  }

  if (fLev && leverageInput) {
    fLev.value = leverageInput.value;
    fLev.addEventListener("change", () => {
      leverageInput.value = fLev.value;
      leverageInput.dispatchEvent(new Event("change"));
    });
  }

  if (fTp && tpInput) {
    fTp.addEventListener("input", () => {
      tpInput.value = fTp.value;
      tpInput.dispatchEvent(new Event("input"));
    });
  }

  if (fSl && slInput) {
    fSl.addEventListener("input", () => {
      slInput.value = fSl.value;
      slInput.dispatchEvent(new Event("input"));
    });
  }

  if (fPrice && priceInput) {
    fPrice.addEventListener("input", () => {
      priceInput.value = fPrice.value;
      priceInput.dispatchEvent(new Event("input"));
    });
  }

  if (fBuyBtn) {
    fBuyBtn.addEventListener("click", () => {
      placeOrder("buy");
    });
  }

  if (fSellBtn) {
    fSellBtn.addEventListener("click", () => {
      placeOrder("sell");
    });
  }
}

// Run floating trade panel setup
initFloatingTradePanel();

function enableAudioSeeking(audio, slider) {
    slider.addEventListener('input', () => {
        if (audio.duration) audio.currentTime = (slider.value / 100) * audio.duration;
    });
    audio.addEventListener('timeupdate', () => {
        if (audio.duration) slider.value = (audio.currentTime / audio.duration) * 100;
    });
}

document.addEventListener('DOMContentLoaded', () => {
    // Автоматическое связывание элементов на странице при их наличии
    document.querySelectorAll('.voice-player-wrapper').forEach(wrapper => {
        const audio = wrapper.querySelector('.voice-audio-player');
        const slider = wrapper.querySelector('.voice-seek-slider');
        if (audio && slider) {
            enableAudioSeeking(audio, slider);
        }
    });
});

// Глобальные функции работы с IndexedDB для голосовых заметок (без import/export)
window.dbInstancePromise = null;

window.initVoiceNotesDB = function() {
    if (window.dbInstancePromise) return window.dbInstancePromise;
    window.dbInstancePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open("PLBT_VoiceNotesDB", 1);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains("voice_notes")) {
                db.createObjectStore("voice_notes", { keyPath: "id" });
            }
        };
        request.onsuccess = (event) => {
            resolve(event.target.result);
        };
        request.onerror = (event) => {
            console.error("IndexedDB open error:", event.target.error);
            reject(event.target.error);
        };
    });
    return window.dbInstancePromise;
};

window.saveVoiceNote = async function(id, blob) {
    try {
        const db = await window.initVoiceNotesDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction("voice_notes", "readwrite");
            const store = transaction.objectStore("voice_notes");
            const request = store.put({ id: id, audio: blob, timestamp: Date.now() });
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    } catch (err) {
        console.error("Error in saveVoiceNote:", err);
    }
};

window.loadAllVoiceNotes = async function() {
    try {
        const db = await window.initVoiceNotesDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction("voice_notes", "readonly");
            const store = transaction.objectStore("voice_notes");
            const request = store.getAll();
            request.onsuccess = (e) => resolve(e.target.result || []);
            request.onerror = (e) => reject(e.target.error);
        });
    } catch (err) {
        console.error("Error in loadAllVoiceNotes:", err);
        return [];
    }
};

window.deleteVoiceNote = async function(id) {
    try {
        const db = await window.initVoiceNotesDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction("voice_notes", "readwrite");
            const store = transaction.objectStore("voice_notes");
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = (e) => reject(e.target.error);
        });
    } catch (err) {
        console.error("Error in deleteVoiceNote:", err);
    }
};

window.restoreAudioURL = function(blob) {
    if (blob instanceof Blob) {
        return URL.createObjectURL(blob);
    }
    return "";
};

window.saveVoice = function(id, blob) {
    var request = indexedDB.open("PLBT_Database", 2);
    request.onupgradeneeded = function(e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains("voice_notes")) {
            db.createObjectStore("voice_notes", { keyPath: "id" });
        }
    };
    request.onsuccess = function(e) {
        var db = e.target.result;
        var tx = db.transaction("voice_notes", "readwrite");
        tx.objectStore("voice_notes").put({id: id, audio: blob, timestamp: Date.now()});
    };
};

window.loadAllVoices = function(callback) {
    var request = indexedDB.open("PLBT_Database", 2);
    request.onupgradeneeded = function(e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains("voice_notes")) {
            db.createObjectStore("voice_notes", { keyPath: "id" });
        }
    };
    request.onsuccess = function(e) {
        var db = e.target.result;
        var tx = db.transaction("voice_notes", "readonly");
        var store = tx.objectStore("voice_notes");
        var getReq = store.getAll();
        getReq.onsuccess = function(ev) {
            if (typeof callback === "function") {
                callback(ev.target.result || []);
            }
        };
    };
};

window.saveVoiceNote = function(id, blob) {
    return new Promise(function(resolve, reject) {
        try {
            if (!id || !(blob instanceof Blob)) {
                reject(new Error("Invalid parameters"));
                return;
            }
            var request = indexedDB.open("PLBT_Database", 2);
            request.onupgradeneeded = function(e) {
                var db = e.target.result;
                if (!db.objectStoreNames.contains("voice_notes")) {
                    db.createObjectStore("voice_notes", { keyPath: "id" });
                }
            };
            request.onsuccess = function(e) {
                var db = e.target.result;
                try {
                    var tx = db.transaction("voice_notes", "readwrite");
                    var store = tx.objectStore("voice_notes");
                    var putRequest = store.put({ id: id, audio: blob, timestamp: Date.now() });
                    putRequest.onsuccess = function() {
                        resolve();
                    };
                    putRequest.onerror = function(ev) {
                        reject(ev.target.error);
                    };
                } catch (err) {
                    reject(err);
                }
            };
            request.onerror = function(e) {
                reject(e.target.error);
            };
        } catch (globalErr) {
            reject(globalErr);
        }
    });
};

window.loadAllVoiceNotes = function() {
    return new Promise(function(resolve, reject) {
        try {
            var request = indexedDB.open("PLBT_Database", 2);
            request.onupgradeneeded = function(e) {
                var db = e.target.result;
                if (!db.objectStoreNames.contains("voice_notes")) {
                    db.createObjectStore("voice_notes", { keyPath: "id" });
                }
            };
            request.onsuccess = function(e) {
                var db = e.target.result;
                try {
                    var tx = db.transaction("voice_notes", "readonly");
                    var store = tx.objectStore("voice_notes");
                    var getRequest = store.getAll();
                    getRequest.onsuccess = function(ev) {
                        var records = ev.target.result || [];
                        var formatted = [];
                        for (var i = 0; i < records.length; i++) {
                            var record = records[i];
                            if (record && record.audio instanceof Blob) {
                                formatted.push({
                                    id: record.id,
                                    blob: record.audio,
                                    url: URL.createObjectURL(record.audio)
                                });
                            }
                        }
                        resolve(formatted);
                    };
                    getRequest.onerror = function(ev) {
                        reject(ev.target.error);
                    };
                } catch (err) {
                    reject(err);
                }
            };
            request.onerror = function(e) {
                reject(e.target.error);
            };
        } catch (globalErr) {
            reject(globalErr);
        }
    });
};

window.saveVoice = function(id, blob) {
    if (!id || !(blob instanceof Blob)) return;
    var request = indexedDB.open("PLBT_Database", 2);
    request.onupgradeneeded = function(e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains("voice_notes")) {
            db.createObjectStore("voice_notes", { keyPath: "id" });
        }
    };
    request.onsuccess = function(e) {
        var db = e.target.result;
        try {
            var tx = db.transaction("voice_notes", "readwrite");
            var store = tx.objectStore("voice_notes");
            store.put({id: id, audio: blob, timestamp: Date.now()});
        } catch (err) {
            console.error("saveVoice failed", err);
        }
    };
};

window.loadVoices = function(callback) {
    var request = indexedDB.open("PLBT_Database", 2);
    request.onupgradeneeded = function(e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains("voice_notes")) {
            db.createObjectStore("voice_notes", { keyPath: "id" });
        }
    };
    request.onsuccess = function(e) {
        var db = e.target.result;
        try {
            var tx = db.transaction("voice_notes", "readonly");
            var store = tx.objectStore("voice_notes");
            var getReq = store.getAll();
            getReq.onsuccess = function(ev) {
                var records = ev.target.result || [];
                var formatted = [];
                for (var i = 0; i < records.length; i++) {
                    var record = records[i];
                    if (record && record.audio instanceof Blob) {
                        formatted.push({
                            id: record.id,
                            blob: record.audio,
                            url: URL.createObjectURL(record.audio)
                        });
                    }
                }
                if (typeof callback === "function") {
                    callback(formatted);
                }
            };
        } catch (err) {
            console.error("loadVoices failed", err);
        }
    };
};

/* ==========================================================================
   FEATURE 3 & 4: PROFILE (ACHIEVEMENTS), COMPETITION & PAYOUTS SYSTEM
   ========================================================================== */

let payoutsList = [];

function loadPayouts() {
  const saved = localStorage.getItem("plbt_payouts");
  if (saved) {
    try {
      payoutsList = JSON.parse(saved) || [];
    } catch (e) {
      payoutsList = [];
    }
  } else {
    payoutsList = [];
  }
}

function savePayouts() {
  localStorage.setItem("plbt_payouts", JSON.stringify(payoutsList));
}

loadPayouts();

function openPayoutModal() {
  const modal = document.getElementById("payout-modal");
  const accSelect = document.getElementById("payout-form-account");
  if (!modal || !accSelect) return;

  accSelect.innerHTML = "";
  accounts.forEach(acc => {
    const opt = document.createElement("option");
    opt.value = acc.id;
    opt.textContent = `${acc.name} (${acc.broker_or_firm || "Account"}) — $${(acc.current_balance || 0).toLocaleString()}`;
    if (acc.id === activeAccountId) opt.selected = true;
    accSelect.appendChild(opt);
  });

  const dateInput = document.getElementById("payout-form-date");
  if (dateInput) {
    const today = new Date().toISOString().split("T")[0];
    dateInput.value = today;
  }

  modal.style.display = "flex";
  if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
}

function closePayoutModal() {
  const modal = document.getElementById("payout-modal");
  if (modal) modal.style.display = "none";
}

function savePayoutForm(e) {
  if (e && typeof e.preventDefault === "function") e.preventDefault();

  const accSelect = document.getElementById("payout-form-account");
  const amountInput = document.getElementById("payout-form-amount");
  const dateInput = document.getElementById("payout-form-date");
  const commentInput = document.getElementById("payout-form-comment");

  const accId = accSelect ? accSelect.value : activeAccountId;
  const amount = amountInput ? parseFloat(amountInput.value) : 0;
  const dateStr = dateInput && dateInput.value ? dateInput.value : new Date().toISOString().split("T")[0];
  const comment = commentInput ? commentInput.value.trim() : "Payout";

  if (!accId || isNaN(amount) || amount <= 0) {
    if (typeof showToast === "function") showToast("Укажите корректную сумму выплаты (>0)", "error");
    return;
  }

  const newPayout = {
    id: "payout-" + Date.now(),
    account_id: accId,
    amount: amount,
    date: dateStr,
    comment: comment || "Выплата",
    status: "APPROVED",
    created_at: new Date().toISOString()
  };

  payoutsList.push(newPayout);
  savePayouts();

  const targetAcc = accounts.find(a => a.id === accId);
  if (targetAcc) {
    if (!Array.isArray(targetAcc.payouts_history)) targetAcc.payouts_history = [];
    targetAcc.payouts_history.push(newPayout);
    saveAccountsToStorage();
    awardCertificate("FIRST_PAYOUT", targetAcc, { amount: amount });
  }

  closePayoutModal();
  renderPayoutsTable();
  if (typeof showToast === "function") showToast(`Выплата $${amount.toLocaleString()} успешно зафиксирована!`, "success");
}

function renderPayoutsTable() {
  const container = document.getElementById("payouts-list-grid");
  const totalSumEl = document.getElementById("payouts-total-sum");
  if (!container) return;

  container.innerHTML = "";

  let targetAccId = currentAccountSpecificFilter;
  if (targetAccId === "ALL") {
    targetAccId = activeAccountId;
  }

  const filteredPayouts = payoutsList.filter(p => p.account_id === targetAccId);
  const totalSum = filteredPayouts.reduce((sum, p) => sum + (p.amount || 0), 0);

  if (totalSumEl) {
    totalSumEl.textContent = `$${totalSum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  if (filteredPayouts.length === 0) {
    container.innerHTML = `
      <div style="padding: 24px; text-align: center; color: var(--text-muted); font-size: 12px; background: rgba(0,0,0,0.2); border-radius: 8px; border: 1px dashed var(--border-color);">
        По текущему счёту пока нет зафиксированных выплат.
      </div>
    `;
    return;
  }

  filteredPayouts.sort((a, b) => new Date(b.date) - new Date(a.date)).forEach(payout => {
    const acc = accounts.find(a => a.id === payout.account_id);
    const card = document.createElement("div");
    card.style.cssText = "display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: rgba(15, 23, 42, 0.6); border: 1px solid var(--border-color); border-radius: 8px; font-size: 12px;";

    const isWithdrawal = payout.type === "WITHDRAWAL";
    const iconBg = isWithdrawal ? "rgba(239, 68, 68, 0.15)" : "rgba(16, 185, 129, 0.15)";
    const iconColor = isWithdrawal ? "#ef4444" : "#10b981";
    const iconName = isWithdrawal ? "arrow-up-right" : "check-circle-2";
    const amountColor = isWithdrawal ? "#ef4444" : "var(--color-up)";
    const amountSign = isWithdrawal ? "-" : "+";

    card.innerHTML = `
      <div style="display: flex; align-items: center; gap: 10px;">
        <div style="width: 32px; height: 32px; border-radius: 6px; background: ${iconBg}; color: ${iconColor}; display: flex; align-items: center; justify-content: center;">
          <i data-lucide="${iconName}" style="width: 16px; height: 16px;"></i>
        </div>
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <div style="font-weight: 700; color: #fff;">${payout.comment || (isWithdrawal ? "Вывод средств (Withdrawal)" : "Выплата (Payout)")}</div>
          <div style="font-size: 10px; color: var(--text-muted); display: flex; align-items: center; gap: 6px;">
            <span>Счёт: <b>${acc ? acc.name : "Неизвестно"}</b></span> • <span>${payout.date}</span>
          </div>
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 12px;">
        <span class="font-mono" style="font-size: 15px; font-weight: 800; color: ${amountColor};">${amountSign}$${(payout.amount || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
        <button class="history-btn danger" style="padding: 4px 8px; font-size: 10px;" onclick="deletePayout('${payout.id}')" title="Удалить запись">
          <i data-lucide="trash-2" style="width: 12px; height: 12px;"></i>
        </button>
      </div>
    `;

    container.appendChild(card);
  });

  if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
}

window.deletePayout = function(payoutId) {
  if (!confirm("Удалить эту запись?")) return;
  payoutsList = payoutsList.filter(p => p.id !== payoutId);
  savePayouts();
  renderPayoutsTable();
  if (typeof showToast === "function") showToast("Запись удалена", "info");
};

function openWithdrawalModal() {
  const acc = getActiveAccount();
  if (!acc || acc.type !== "PERSONAL") {
    if (typeof showToast === "function") {
      showToast("Вывод средств доступен только для Личных счетов (PERSONAL)", "error");
    }
    return;
  }

  const modal = document.getElementById("withdrawal-modal");
  const balEl = document.getElementById("withdrawal-modal-balance-val");
  const dateInput = document.getElementById("withdrawal-form-date");
  const amountInput = document.getElementById("withdrawal-form-amount");
  const commentInput = document.getElementById("withdrawal-form-comment");

  if (balEl) balEl.textContent = `$${(acc.current_balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  if (dateInput) dateInput.value = new Date().toISOString().split("T")[0];
  if (amountInput) amountInput.value = "";
  if (commentInput) commentInput.value = "";

  if (modal) modal.style.display = "flex";
  if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
}

function closeWithdrawalModal() {
  const modal = document.getElementById("withdrawal-modal");
  if (modal) modal.style.display = "none";
}

function saveWithdrawalForm(e) {
  if (e && typeof e.preventDefault === "function") e.preventDefault();

  const acc = getActiveAccount();
  if (!acc || acc.type !== "PERSONAL") {
    if (typeof showToast === "function") showToast("Ошибка: Вывод средств доступен только для Личных счетов (PERSONAL)", "error");
    return;
  }

  const amountInput = document.getElementById("withdrawal-form-amount");
  const dateInput = document.getElementById("withdrawal-form-date");
  const commentInput = document.getElementById("withdrawal-form-comment");

  const amount = amountInput ? parseFloat(amountInput.value) : 0;
  const dateStr = dateInput && dateInput.value ? dateInput.value : new Date().toISOString().split("T")[0];
  const comment = commentInput && commentInput.value.trim() ? commentInput.value.trim() : "Вывод средств";

  if (isNaN(amount) || amount <= 0) {
    if (typeof showToast === "function") showToast("Укажите корректную сумму вывода (>0)", "error");
    return;
  }

  if (amount > acc.current_balance) {
    if (typeof showToast === "function") showToast(`Нельзя вывести больше доступного баланса ($${acc.current_balance.toLocaleString()})`, "error");
    return;
  }

  acc.current_balance -= amount;
  if (acc.id === activeAccountId) {
    balance = acc.current_balance;
    saveBalance(balance);
  }
  saveAccountsToStorage();

  const newWithdrawal = {
    id: "withdrawal-" + Date.now(),
    account_id: acc.id,
    amount: amount,
    type: "WITHDRAWAL",
    date: dateStr,
    comment: comment,
    status: "APPROVED",
    created_at: new Date().toISOString()
  };

  payoutsList.push(newWithdrawal);
  savePayouts();

  closeWithdrawalModal();
  renderPayoutsTable();
  updateSimulatorUI();
  renderAccountsModalCards();
  if (typeof showToast === "function") showToast(`Успешно выведено $${amount.toLocaleString()} с Личного счёта!`, "success");
}

function showMyRating() {
  switchCompetitionTab("leaderboard");
  setTimeout(() => {
    const userRow = document.getElementById("leaderboard-user-row");
    if (userRow) {
      userRow.scrollIntoView({ behavior: "smooth", block: "center" });
      userRow.style.outline = "2px solid var(--color-accent)";
      setTimeout(() => {
        userRow.style.outline = "none";
      }, 2000);
    }
  }, 100);
}
window.showMyRating = showMyRating;

// PROFILE & ACHIEVEMENTS
const ACHIEVEMENTS_DATA = [
  // ЛЁГКИЕ (EASY)
  { id: "ach-1", diff: "EASY", title: "Первый шаг", desc: "Совершить 1-ю сделку в терминале", icon: "footprints" },
  { id: "ach-2", diff: "EASY", title: "Первая прибыль", desc: "Закрыть сделку с положительным результатом", icon: "trending-up" },
  { id: "ach-3", diff: "EASY", title: "Проп-трейдер", desc: "Создать или настроить проп-счёт", icon: "award" },
  { id: "ach-4", diff: "EASY", title: "Активный старт", desc: "Совершить не менее 5 сделок", icon: "list-todo" },
  { id: "ach-j1", diff: "EASY", title: "Первая запись", desc: "Оставить хотя бы 1 запись в журнале эмоций", icon: "edit-3" },
  { id: "ach-j2", diff: "EASY", title: "Начало пути", desc: "Оставить 10 записей в журнале эмоций", icon: "book-open" },
  { id: "ach-j3", diff: "EASY", title: "Втянулся", desc: "Оставить 25 записей в журнале эмоций", icon: "file-text" },
  { id: "ach-cj1", diff: "EASY", title: "Разогрев", desc: "Заполнить журнал по 10 сделкам подряд", icon: "flame" },

  // СРЕДНИЕ (MEDIUM)
  { id: "ach-5", diff: "MEDIUM", title: "Контроль рисков", desc: "Соблюдать лимиты и не превышать дневную просадку", icon: "shield-check" },
  { id: "ach-6", diff: "MEDIUM", title: "Серия побед", desc: "Закрыть 3 прибыльные сделки подряд", icon: "zap" },
  { id: "ach-7", diff: "MEDIUM", title: "Эффективность", desc: "Достичь Profit Factor выше 1.5 (при >5 сделках)", icon: "pie-chart" },
  { id: "ach-8", diff: "MEDIUM", title: "Первая выплата", desc: "Зафиксировать первую выплату (Payout)", icon: "dollar-sign" },
  { id: "ach-j4", diff: "MEDIUM", title: "Дисциплина", desc: "Оставить 50 записей в журнале эмоций", icon: "check-square" },
  { id: "ach-j5", diff: "MEDIUM", title: "Привычка", desc: "Оставить 100 записей в журнале эмоций", icon: "bookmark" },
  { id: "ach-j6", diff: "MEDIUM", title: "Половина пути", desc: "Оставить 250 записей в журнале эмоций", icon: "layers" },
  { id: "ach-cj2", diff: "MEDIUM", title: "Стабильность", desc: "Заполнить журнал по 50 сделкам подряд", icon: "zap" },

  // СЛОЖНЫЕ (HARD)
  { id: "ach-9", diff: "HARD", title: "Проп-Мастер", desc: "Достичь целевой прибыли (Profit Target) на проп-счёте", icon: "trophy" },
  { id: "ach-10", diff: "HARD", title: "Турнирный боец", desc: "Запустить соревновательный счёт в Демо Конкуренции", icon: "swords" },
  { id: "ach-11", diff: "HARD", title: "Опытный статистик", desc: "Совершить более 20 сделок в дневнике", icon: "bar-chart-2" },
  { id: "ach-12", diff: "HARD", title: "Финансовый успех", desc: "Заработать чистую прибыль более $5,000", icon: "sparkles" },
  { id: "ach-j7", diff: "HARD", title: "Мастер рефлексии", desc: "Оставить 500 записей в журнале эмоций", icon: "brain" },
  { id: "ach-j8", diff: "HARD", title: "Легенда журнала", desc: "Оставить 1000 записей в журнале эмоций", icon: "crown" },
  { id: "ach-cj3", diff: "HARD", title: "Железная дисциплина", desc: "Заполнить журнал по 100 сделкам подряд", icon: "shield" },
  { id: "ach-cj4", diff: "HARD", title: "Абсолютная концентрация", desc: "Заполнить журнал по 1000 сделкам подряд", icon: "award" }
];

function hasTradeJournalEntry(trade) {
  if (!trade) return false;
  const hasNotes = Boolean(
    (trade.notes && (
      (trade.notes.noteBefore && trade.notes.noteBefore.trim()) ||
      (trade.notes.noteDuring && trade.notes.noteDuring.trim()) ||
      (trade.notes.noteAfter && trade.notes.noteAfter.trim())
    )) ||
    (trade.thoughtBefore && trade.thoughtBefore.trim()) ||
    (trade.thoughtDuring && trade.thoughtDuring.trim()) ||
    (trade.thoughtAfter && trade.thoughtAfter.trim()) ||
    (trade.comment && trade.comment.trim())
  );
  const hasTags = Array.isArray(trade.tags) && trade.tags.length > 0;
  const hasVoice = Boolean(trade.voiceNoteUrl || trade.voiceNoteBase64 || trade.voiceNote);
  return hasNotes || hasTags || hasVoice;
}

function getJournalAchievementStats() {
  const trades = tradeHistory || [];
  const sortedTrades = [...trades].sort((a, b) => {
    const timeA = new Date(a.closeTime || a.timestamp || a.openTime || 0).getTime();
    const timeB = new Date(b.closeTime || b.timestamp || b.openTime || 0).getTime();
    return timeA - timeB;
  });

  let totalJournaled = 0;
  let currentStreak = 0;
  let maxStreak = 0;

  sortedTrades.forEach((t) => {
    if (hasTradeJournalEntry(t)) {
      totalJournaled++;
      currentStreak++;
      if (currentStreak > maxStreak) {
        maxStreak = currentStreak;
      }
    } else {
      currentStreak = 0;
    }
  });

  const storedTotal = parseInt(localStorage.getItem("plbt_total_journal_comments_count") || "0", 10);
  const storedLongest = parseInt(localStorage.getItem("plbt_longest_consecutive_journaled_trades") || "0", 10);

  const finalTotal = Math.max(totalJournaled, storedTotal);
  const finalMaxStreak = Math.max(maxStreak, storedLongest);

  if (finalTotal > storedTotal) {
    localStorage.setItem("plbt_total_journal_comments_count", finalTotal.toString());
  }
  if (finalMaxStreak > storedLongest) {
    localStorage.setItem("plbt_longest_consecutive_journaled_trades", finalMaxStreak.toString());
  }

  return {
    totalJournaled: finalTotal,
    currentStreak: currentStreak,
    maxStreak: finalMaxStreak
  };
}

function evaluateAchievements() {
  const trades = tradeHistory || [];
  const accs = accounts || [];
  const payouts = payoutsList || [];

  const totalTrades = trades.length;
  const winTrades = trades.filter(t => (t.pnl || 0) > 0);
  const totalProfit = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  
  let winStreak = 0;
  let maxWinStreak = 0;
  trades.forEach(t => {
    if ((t.pnl || 0) > 0) {
      winStreak++;
      if (winStreak > maxWinStreak) maxWinStreak = winStreak;
    } else {
      winStreak = 0;
    }
  });

  const grossProfit = trades.filter(t => (t.pnl || 0) > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter(t => (t.pnl || 0) < 0).reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? 99 : 0);

  const hasPropAcc = accs.some(a => a.type === "PROP");
  const hasCompAcc = accs.some(a => a.type === "COMPETITION");
  const hasPayout = payouts.length > 0;
  const passedProp = accs.some(a => a.type === "PROP" && a.current_balance >= a.initial_balance * (1 + (a.profit_target_percent || 10) / 100));

  const jStats = getJournalAchievementStats();
  const totalJournalComments = jStats.totalJournaled;
  const maxConsecutiveJournal = jStats.maxStreak;

  return ACHIEVEMENTS_DATA.map(ach => {
    let unlocked = false;

    if (ach.id === "ach-1") unlocked = totalTrades >= 1;
    else if (ach.id === "ach-2") unlocked = winTrades.length >= 1;
    else if (ach.id === "ach-3") unlocked = hasPropAcc;
    else if (ach.id === "ach-4") unlocked = totalTrades >= 5;
    else if (ach.id === "ach-5") unlocked = totalTrades >= 3;
    else if (ach.id === "ach-6") unlocked = maxWinStreak >= 3;
    else if (ach.id === "ach-7") unlocked = totalTrades >= 5 && pf >= 1.5;
    else if (ach.id === "ach-8") unlocked = hasPayout;
    else if (ach.id === "ach-9") unlocked = passedProp;
    else if (ach.id === "ach-10") unlocked = hasCompAcc;
    else if (ach.id === "ach-11") unlocked = totalTrades >= 20;
    else if (ach.id === "ach-12") unlocked = totalProfit >= 5000;
    // TYPE 1: Journal Comments Total
    else if (ach.id === "ach-j1") unlocked = totalJournalComments >= 1;
    else if (ach.id === "ach-j2") unlocked = totalJournalComments >= 10;
    else if (ach.id === "ach-j3") unlocked = totalJournalComments >= 25;
    else if (ach.id === "ach-j4") unlocked = totalJournalComments >= 50;
    else if (ach.id === "ach-j5") unlocked = totalJournalComments >= 100;
    else if (ach.id === "ach-j6") unlocked = totalJournalComments >= 250;
    else if (ach.id === "ach-j7") unlocked = totalJournalComments >= 500;
    else if (ach.id === "ach-j8") unlocked = totalJournalComments >= 1000;
    // TYPE 2: Consecutive Journaled Trades
    else if (ach.id === "ach-cj1") unlocked = maxConsecutiveJournal >= 10;
    else if (ach.id === "ach-cj2") unlocked = maxConsecutiveJournal >= 50;
    else if (ach.id === "ach-cj3") unlocked = maxConsecutiveJournal >= 100;
    else if (ach.id === "ach-cj4") unlocked = maxConsecutiveJournal >= 1000;

    return { ...ach, unlocked };
  });
}

function evaluateAndNotifyAchievements(silent = false) {
  const evaluated = evaluateAchievements();

  let unlockedSet;
  const raw = localStorage.getItem("plbt_unlocked_achievements");
  const isFirstRun = !raw;
  try {
    unlockedSet = new Set(raw ? JSON.parse(raw) : []);
  } catch (e) {
    unlockedSet = new Set();
  }

  evaluated.forEach((ach) => {
    if (ach.unlocked) {
      if (!unlockedSet.has(ach.id)) {
        unlockedSet.add(ach.id);
        if (!silent && !isFirstRun) {
          if (typeof showToast === "function") {
            showToast(`🏆 Новое достижение: "${ach.title}"!`, "success");
          }
        }
      }
    }
  });

  localStorage.setItem("plbt_unlocked_achievements", JSON.stringify([...unlockedSet]));
  return evaluated;
}

function openProfileModal() {
  const modal = document.getElementById("profile-modal");
  if (!modal) return;

  const evaluated = evaluateAndNotifyAchievements(true);
  const unlockedCount = evaluated.filter(a => a.unlocked).length;
  const totalCount = evaluated.length;
  const pct = Math.round((unlockedCount / totalCount) * 100);

  const label = document.getElementById("achievements-progress-label");
  const bar = document.getElementById("achievements-progress-bar");
  if (label) label.textContent = `Получено ${unlockedCount} из ${totalCount} (${pct}%)`;
  if (bar) bar.style.width = `${pct}%`;

  const tradesCount = (tradeHistory || []).length;
  const winCount = (tradeHistory || []).filter(t => (t.pnl || 0) > 0).length;
  const winrate = tradesCount > 0 ? Math.round((winCount / tradesCount) * 100) : 0;

  const statTrades = document.getElementById("profile-stat-trades");
  const statWinrate = document.getElementById("profile-stat-winrate");
  const statAccounts = document.getElementById("profile-stat-accounts");
  const statJournalTotal = document.getElementById("profile-stat-journal-total");
  const statJournalStreak = document.getElementById("profile-stat-journal-streak");

  if (statTrades) statTrades.textContent = tradesCount;
  if (statWinrate) statWinrate.textContent = `${winrate}%`;
  if (statAccounts) statAccounts.textContent = accounts.length;

  const jStats = getJournalAchievementStats();
  if (statJournalTotal) statJournalTotal.textContent = jStats.totalJournaled;
  if (statJournalStreak) statJournalStreak.textContent = `${jStats.currentStreak} дн.`;

  renderAchievements("ALL");
  renderCertificatesInProfile();

  modal.style.display = "flex";
  if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
}

function closeProfileModal() {
  const modal = document.getElementById("profile-modal");
  if (modal) modal.style.display = "none";
}

function renderAchievements(filterDiff = "ALL") {
  const grid = document.getElementById("achievements-grid");
  if (!grid) return;

  grid.innerHTML = "";
  const evaluated = evaluateAndNotifyAchievements(true);

  const cAll = document.getElementById("achieve-count-all");
  const cEasy = document.getElementById("achieve-count-easy");
  const cMed = document.getElementById("achieve-count-medium");
  const cHard = document.getElementById("achieve-count-hard");

  if (cAll) cAll.textContent = evaluated.length;
  if (cEasy) cEasy.textContent = evaluated.filter(a => a.diff === "EASY").length;
  if (cMed) cMed.textContent = evaluated.filter(a => a.diff === "MEDIUM").length;
  if (cHard) cHard.textContent = evaluated.filter(a => a.diff === "HARD").length;

  const filtered = filterDiff === "ALL" ? evaluated : evaluated.filter(a => a.diff === filterDiff);

  filtered.forEach(ach => {
    const card = document.createElement("div");
    card.className = `achieve-card ${ach.unlocked ? "unlocked" : "locked"}`;

    card.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <span class="achieve-diff-badge ${ach.diff}">${ach.diff}</span>
        <span style="font-size: 10px; font-weight: 700; color: ${ach.unlocked ? "#38bdf8" : "#64748b"}; display: flex; align-items: center; gap: 4px;">
          <i data-lucide="${ach.unlocked ? "check-circle-2" : "lock"}" style="width: 12px; height: 12px;"></i>
          ${ach.unlocked ? "Получено" : "Заблокировано"}
        </span>
      </div>
      <div style="display: flex; align-items: center; gap: 10px; margin-top: 4px;">
        <div style="width: 34px; height: 34px; border-radius: 8px; background: ${ach.unlocked ? "rgba(56, 189, 248, 0.15)" : "rgba(255,255,255,0.05)"}; color: ${ach.unlocked ? "#38bdf8" : "#94a3b8"}; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
          <i data-lucide="${ach.icon || "award"}" style="width: 18px; height: 18px;"></i>
        </div>
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <div style="font-size: 12px; font-weight: 700; color: #fff;">${ach.title}</div>
          <div style="font-size: 10px; color: var(--text-muted); line-height: 1.3;">${ach.desc}</div>
        </div>
      </div>
    `;

    grid.appendChild(card);
  });

  if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
}

// DEMO COMPETITION & LEADERBOARD
let leaderboardCache = null;

function switchCompetitionTab(tabName) {
  const btnAcc = document.getElementById("comp-tab-account-btn");
  const btnLeaderboard = document.getElementById("comp-tab-leaderboard-btn");
  const contentAcc = document.getElementById("comp-tab-content-account");
  const contentLeaderboard = document.getElementById("comp-tab-content-leaderboard");

  if (tabName === "account") {
    btnAcc?.classList.add("active");
    btnLeaderboard?.classList.remove("active");
    if (contentAcc) contentAcc.style.display = "flex";
    if (contentLeaderboard) contentLeaderboard.style.display = "none";
  } else if (tabName === "leaderboard") {
    btnLeaderboard?.classList.add("active");
    btnAcc?.classList.remove("active");
    if (contentAcc) contentAcc.style.display = "none";
    if (contentLeaderboard) contentLeaderboard.style.display = "flex";
    renderLeaderboardTable();
  }
}

function generateLeaderboardData() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  
  // Find user's active competition account if any
  const compAcc = (accounts || []).find(a => a.type === "COMPETITION" && a.status !== "ARCHIVED");
  
  let userPnlPercent = 0;
  let userBalance = 25000;
  let userWinrate = 0;
  let userTradesCount = 0;
  let userStatus = "SPECTATOR";
  let userName = "Вы (Участник)";

  if (compAcc) {
    userBalance = compAcc.current_balance;
    const initBal = compAcc.initial_balance || 25000;
    userPnlPercent = initBal > 0 ? ((userBalance - initBal) / initBal) * 100 : 0;
    
    const accTrades = (tradeHistory || []).filter(t => t.account_id === compAcc.id);
    userTradesCount = accTrades.length;
    const wins = accTrades.filter(t => (t.pnl || 0) > 0).length;
    userWinrate = userTradesCount > 0 ? Math.round((wins / userTradesCount) * 100) : 0;
    userStatus = compAcc.status || "ACTIVE";
    userName = compAcc.name || "Ваш турнирный счёт";
  }

  // Generate 999 mock participants deterministically
  const firstNames = ["Александр", "Дмитрий", "Максим", "Артем", "Сергей", "Егор", "Иван", "Михаил", "Никита", "Андрей", "Alex", "David", "Michael", "James", "Elena", "Sophia", "Viktor", "Satoshi", "Daniel", "Roman"];
  const nickTags = ["Trader", "Quant", "Pro", "Sniper", "Alpha", "Apex", "FX", "Crypto", "Wave", "Master", "Sigma", "God", "X", "Prime", "Legend", "Hunter", "Flow", "Beast", "Rider", "Bot"];

  const participants = [];

  function pseudoRandom(seed) {
    const x = Math.sin(seed++) * 10000;
    return x - Math.floor(x);
  }

  for (let i = 1; i <= 999; i++) {
    const r1 = pseudoRandom(i * 17 + month * 100);
    const r2 = pseudoRandom(i * 31 + year);
    const r3 = pseudoRandom(i * 47);
    const r4 = pseudoRandom(i * 89);

    const fn = firstNames[Math.floor(r1 * firstNames.length)];
    const tag = nickTags[Math.floor(r2 * nickTags.length)];
    const pName = `${fn}_${tag}_${i}`;

    let pnlPct = 0;
    if (i <= 10) {
      pnlPct = 35 + (10 - i) * 3.2 + r3 * 2.5;
    } else if (i <= 80) {
      pnlPct = 15 + r3 * 19.8;
    } else if (i <= 400) {
      pnlPct = 1.0 + r3 * 13.9;
    } else if (i <= 750) {
      pnlPct = -5.0 + r3 * 5.9;
    } else {
      pnlPct = -11.5 + r3 * 6.0;
    }

    pnlPct = parseFloat(pnlPct.toFixed(2));

    const initialCap = 25000;
    const currentBal = parseFloat((initialCap * (1 + pnlPct / 100)).toFixed(2));
    const winrate = Math.round(35 + r3 * 45);
    const tradesCount = Math.floor(5 + r4 * 65);
    const status = pnlPct <= -10.0 ? "FAILED" : "ACTIVE";

    participants.push({
      id: `bot-${i}`,
      isUser: false,
      name: pName,
      balance: currentBal,
      pnlPercent: pnlPct,
      winrate: winrate,
      tradesCount: tradesCount,
      status: status
    });
  }

  // Add real user participant
  participants.push({
    id: compAcc ? compAcc.id : "user-spectator",
    isUser: true,
    name: userName,
    balance: userBalance,
    pnlPercent: userPnlPercent,
    winrate: userWinrate,
    tradesCount: userTradesCount,
    status: userStatus
  });

  // Sort all 1000 participants by pnlPercent descending
  participants.sort((a, b) => b.pnlPercent - a.pnlPercent);

  // Assign ranks
  let userRank = -1;
  participants.forEach((p, idx) => {
    p.rank = idx + 1;
    if (p.isUser) userRank = p.rank;
  });

  leaderboardCache = {
    participants,
    userRank,
    userPnlPercent,
    userBalance,
    hasCompAccount: !!compAcc
  };

  return leaderboardCache;
}

function renderLeaderboardTable() {
  const tbody = document.getElementById("leaderboard-table-body");
  if (!tbody) return;

  const data = generateLeaderboardData();
  const searchInput = document.getElementById("leaderboard-search-input");
  const statusFilter = document.getElementById("leaderboard-status-filter");

  const query = searchInput ? searchInput.value.trim().toLowerCase() : "";
  const statusVal = statusFilter ? statusFilter.value : "ALL";

  const userRankCircle = document.getElementById("leaderboard-user-rank-circle");
  const userNameTitle = document.getElementById("leaderboard-user-name-title");
  const userSubInfo = document.getElementById("leaderboard-user-sub-info");
  const userPnlVal = document.getElementById("leaderboard-user-pnl-val");
  const rankBadge = document.getElementById("comp-user-rank-badge");

  if (userRankCircle) userRankCircle.textContent = `#${data.userRank}`;
  if (userNameTitle) userNameTitle.textContent = data.hasCompAccount ? "Вы (Турнирный Трейдер)" : "Вы (Наблюдатель)";
  if (userSubInfo) {
    userSubInfo.textContent = data.hasCompAccount 
      ? `Турнирный счёт активен • Место среди 1000 участников: #${data.userRank}` 
      : "Турнирный счёт не запущен • Нажмите 'Мой счёт', чтобы участвовать!";
  }
  if (userPnlVal) {
    const sign = data.userPnlPercent >= 0 ? "+" : "";
    userPnlVal.textContent = `${sign}${data.userPnlPercent.toFixed(2)}%`;
    userPnlVal.style.color = data.userPnlPercent >= 0 ? "var(--color-up)" : "var(--color-down)";
  }
  if (rankBadge) {
    rankBadge.textContent = `Место: #${data.userRank} / 1000`;
  }

  let filtered = data.participants;

  if (query) {
    filtered = filtered.filter(p => p.name.toLowerCase().includes(query));
  }
  if (statusVal !== "ALL") {
    filtered = filtered.filter(p => p.status === statusVal);
  }

  tbody.innerHTML = "";

  filtered.forEach((p) => {
    const tr = document.createElement("tr");
    if (p.isUser) {
      tr.id = "leaderboard-user-row";
      tr.style.cssText = "background: linear-gradient(90deg, rgba(245, 158, 11, 0.25), rgba(59, 130, 246, 0.25)); border: 1px solid #f59e0b; font-weight: 700;";
    } else {
      tr.style.cssText = "border-bottom: 1px solid rgba(255,255,255,0.05);";
    }

    let rankBadgeHtml = `<span style="font-weight: 700; color: #cbd5e1;">#${p.rank}</span>`;
    if (p.rank === 1) rankBadgeHtml = `<span style="background: #f59e0b; color: #000; font-weight: 900; padding: 2px 8px; border-radius: 12px; font-size: 10px;">🥇 1</span>`;
    else if (p.rank === 2) rankBadgeHtml = `<span style="background: #94a3b8; color: #000; font-weight: 900; padding: 2px 8px; border-radius: 12px; font-size: 10px;">🥈 2</span>`;
    else if (p.rank === 3) rankBadgeHtml = `<span style="background: #b45309; color: #fff; font-weight: 900; padding: 2px 8px; border-radius: 12px; font-size: 10px;">🥉 3</span>`;

    const pnlSign = p.pnlPercent >= 0 ? "+" : "";
    const pnlColor = p.pnlPercent >= 0 ? "var(--color-up)" : "var(--color-down)";
    const statusBadge = p.status === "FAILED"
      ? `<span class="acc-status-badge FAILED" style="font-size: 9px; padding: 2px 6px;">FAILED</span>`
      : `<span class="acc-status-badge ACTIVE" style="font-size: 9px; padding: 2px 6px;">ACTIVE</span>`;

    tr.innerHTML = `
      <td style="padding: 8px 10px;">${rankBadgeHtml}</td>
      <td style="padding: 8px 10px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <div style="width: 24px; height: 24px; border-radius: 50%; background: ${p.isUser ? '#f59e0b' : 'rgba(255,255,255,0.1)'}; color: ${p.isUser ? '#000' : '#fff'}; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 800;">
            ${p.isUser ? 'ВЫ' : p.name.charAt(0).toUpperCase()}
          </div>
          <span style="color: ${p.isUser ? '#38bdf8' : '#fff'}; font-weight: ${p.isUser ? '800' : '500'};">${p.name} ${p.isUser ? ' (ВЫ)' : ''}</span>
        </div>
      </td>
      <td style="padding: 8px 10px;" class="font-mono">$${(p.balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
      <td style="padding: 8px 10px;" class="font-mono"><strong style="color: ${pnlColor};">${pnlSign}${p.pnlPercent.toFixed(2)}%</strong></td>
      <td style="padding: 8px 10px;" class="font-mono">${p.winrate}%</td>
      <td style="padding: 8px 10px;">${p.tradesCount}</td>
      <td style="padding: 8px 10px;">${statusBadge}</td>
    `;

    tbody.appendChild(tr);
  });
}

function openCompetitionModal() {
  const modal = document.getElementById("competition-modal");
  const datesLabel = document.getElementById("competition-dates-label");
  if (!modal) return;

  const now = new Date();
  const year = now.getFullYear();
  const monthName = now.toLocaleString("ru-RU", { month: "long" });
  const lastDay = new Date(year, now.getMonth() + 1, 0).getDate();

  if (datesLabel) {
    datesLabel.textContent = `1 ${monthName} — ${lastDay} ${monthName} ${year}`;
  }

  // Populate active competition account card if exists
  const compAcc = (accounts || []).find(a => a.type === "COMPETITION" && a.status !== "ARCHIVED");
  const activeCard = document.getElementById("comp-active-account-card");
  const startForm = document.getElementById("comp-start-form");

  if (compAcc) {
    if (activeCard) activeCard.style.display = "flex";
    if (startForm) startForm.style.display = "none";

    const nameEl = document.getElementById("comp-acc-card-name");
    const balEl = document.getElementById("comp-acc-card-balance");
    const pnlEl = document.getElementById("comp-acc-card-pnl");
    const wrEl = document.getElementById("comp-acc-card-winrate");
    const tradesEl = document.getElementById("comp-acc-card-trades");

    if (nameEl) nameEl.textContent = compAcc.name;
    if (balEl) balEl.textContent = `$${(compAcc.current_balance || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    
    const initBal = compAcc.initial_balance || 25000;
    const pnlPct = initBal > 0 ? ((compAcc.current_balance - initBal) / initBal) * 100 : 0;
    if (pnlEl) {
      const sign = pnlPct >= 0 ? "+" : "";
      pnlEl.textContent = `${sign}${pnlPct.toFixed(2)}%`;
      pnlEl.style.color = pnlPct >= 0 ? "var(--color-up)" : "var(--color-down)";
    }

    const accTrades = (tradeHistory || []).filter(t => t.account_id === compAcc.id);
    const wins = accTrades.filter(t => (t.pnl || 0) > 0).length;
    const wr = accTrades.length > 0 ? Math.round((wins / accTrades.length) * 100) : 0;
    if (wrEl) wrEl.textContent = `${wr}%`;
    if (tradesEl) tradesEl.textContent = accTrades.length;
  } else {
    if (activeCard) activeCard.style.display = "none";
    if (startForm) startForm.style.display = "flex";
  }

  generateLeaderboardData();

  modal.style.display = "flex";
  if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
}

function closeCompetitionModal() {
  const modal = document.getElementById("competition-modal");
  if (modal) modal.style.display = "none";
}

function createCompetitionAccount() {
  const inputEl = document.getElementById("competition-custom-balance");
  const bal = inputEl ? (parseFloat(inputEl.value) || 25000) : 25000;

  const now = new Date();
  const monthName = now.toLocaleString("ru-RU", { month: "long" });
  const year = now.getFullYear();

  const compAcc = {
    id: "acc-comp-" + Date.now(),
    name: `Турнир (${monthName} ${year})`,
    type: "COMPETITION",
    broker_or_firm: "Демо соревнование",
    phase: "COMPETITION",
    initial_balance: bal,
    current_balance: bal,
    currency: "USD",
    max_daily_drawdown_percent: 5,
    max_total_drawdown_percent: 10,
    profit_target_percent: 10,
    profit_split_percent: 100,
    payouts_history: [],
    status: "ACTIVE",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };

  accounts.push(compAcc);
  setActiveAccount(compAcc.id, true);

  saveAccountsToStorage();
  closeCompetitionModal();

  renderAccountsModalCards();
  renderAccountSelector();
  renderHistoryAccountFilterSelect();

  if (typeof showToast === "function") {
    showToast(`🏆 Турнирный счёт на $${bal.toLocaleString()} запущен! Удачи в соревновании!`, "success");
  }
}

// RISK LIMIT MONITORING & AUTO-LIQUIDATION
function checkAccountRiskLimits(candle) {
  if (!accounts || accounts.length === 0) return;

  // Guard 1: Рыночные данные / свечи ещё не загружены
  if (!state.historicalCandles || state.historicalCandles.length === 0) {
    return;
  }

  const currentPrice = candle ? candle.close : (state.historicalCandles && state.historicalCandles.length > 0 ? state.historicalCandles[state.historicalCandles.length - 1].close : 0);
  
  // Guard 2: Рыночные данные ещё не загружены или котировка невалидна — пропускаем проверку
  if (!currentPrice || typeof currentPrice !== "number" || isNaN(currentPrice) || currentPrice <= 0 || !isFinite(currentPrice)) {
    return;
  }

  accounts.forEach((acc) => {
    if ((acc.type !== "PROP" && acc.type !== "COMPETITION") || acc.status !== "ACTIVE") return;

    const accPositions = (state.positions || []).filter(p => p.account_id === acc.id && p.status === "active");
    const accTrades = (tradeHistory || []).filter(t => t.account_id === acc.id);

    // Guard 3: Защитная проверка — если 0 закрытых сделок и 0 открытых позиций, просадка физически не может возникнуть
    if (accTrades.length === 0 && accPositions.length === 0) {
      return;
    }

    const initialBal = (typeof acc.initial_balance === "number" && !isNaN(acc.initial_balance) && acc.initial_balance > 0 && isFinite(acc.initial_balance))
      ? acc.initial_balance
      : 10000;

    const currentBal = (typeof acc.current_balance === "number" && !isNaN(acc.current_balance) && isFinite(acc.current_balance) && acc.current_balance >= 0)
      ? acc.current_balance
      : initialBal;

    let floatingPnL = 0;
    if (currentPrice > 0) {
      accPositions.forEach(pos => {
        const units = pos.size * 100000;
        let pnl = pos.type === "buy" ? (currentPrice - pos.entryPrice) * units : (pos.entryPrice - currentPrice) * units;
        if (pos.symbol && pos.symbol.endsWith("_JPY")) pnl = pnl / currentPrice;
        floatingPnL += pnl;
      });
    }

    const equity = currentBal + floatingPnL;

    // Guard 4: Если equity не является конечным положительным числом (!isFinite(equity) || equity <= 0) — пропускаем проверку на "слит"
    if (typeof equity !== "number" || !isFinite(equity) || isNaN(equity) || equity <= 0) {
      return;
    }

    const totalDdAmount = initialBal - equity;
    const totalDdPercent = initialBal > 0 ? (totalDdAmount / initialBal) * 100 : 0;

    const currentPhase = acc.phase || "EVALUATION_1";
    let maxDailyDdPercent = acc.max_daily_drawdown_percent || 5;
    let maxTotalDdPercent = acc.max_total_drawdown_percent || 10;
    let profitTargetPercent = acc.profit_target_percent || 10;

    if (acc.type === "PROP") {
      if (currentPhase === "EVALUATION_1") {
        maxDailyDdPercent = acc.p1_daily_dd_percent || acc.max_daily_drawdown_percent || 5;
        maxTotalDdPercent = acc.p1_total_dd_percent || acc.max_total_drawdown_percent || 10;
        profitTargetPercent = acc.p1_target_percent || acc.profit_target_percent || 10;
      } else if (currentPhase === "EVALUATION_2") {
        maxDailyDdPercent = acc.p2_daily_dd_percent || 5;
        maxTotalDdPercent = acc.p2_total_dd_percent || 10;
        profitTargetPercent = acc.p2_target_percent || 5;
      } else if (currentPhase === "FUNDED") {
        maxDailyDdPercent = acc.funded_daily_dd_percent || 5;
        maxTotalDdPercent = acc.funded_total_dd_percent || 10;
        profitTargetPercent = 0;
      }
    }

    const todayStr = new Date().toISOString().split("T")[0];
    let todayPnL = 0;
    accTrades.forEach(t => {
      if (t.closeTime && t.closeTime.startsWith(todayStr)) {
        todayPnL += (t.pnl || 0);
      }
    });
    if (floatingPnL < 0) {
      todayPnL += floatingPnL;
    }
    const dailyLossAmount = todayPnL < 0 ? Math.abs(todayPnL) : 0;
    const dailyDdPercent = initialBal > 0 ? (dailyLossAmount / initialBal) * 100 : 0;

    let breached = false;
    let breachReason = "";

    if (totalDdPercent >= maxTotalDdPercent) {
      breached = true;
      breachReason = `Превышена общая просадка счёта: -${totalDdPercent.toFixed(2)}% (лимит ${maxTotalDdPercent}%).`;
    } else if (dailyDdPercent >= maxDailyDdPercent) {
      breached = true;
      breachReason = `Превышена дневная просадка счёта: -${dailyDdPercent.toFixed(2)}% (лимит ${maxDailyDdPercent}%).`;
    }

    if (breached) {
      acc.status = "FAILED";
      
      let liquidatedCount = 0;
      for (let i = state.positions.length - 1; i >= 0; i--) {
        const pos = state.positions[i];
        if (pos.account_id === acc.id) {
          liquidatedCount++;
          if (pos.status === "active") {
            const units = pos.size * 100000;
            let pnl = pos.type === "buy" ? (currentPrice - pos.entryPrice) * units : (pos.entryPrice - currentPrice) * units;
            if (pos.symbol && pos.symbol.endsWith("_JPY")) pnl = pnl / currentPrice;
            acc.current_balance += pnl;
            
            tradeHistory.push({
              id: pos.id,
              account_id: acc.id,
              symbol: pos.symbol,
              type: pos.type,
              entryPrice: pos.entryPrice,
              exitPrice: currentPrice,
              size: pos.size,
              leverage: pos.leverage || 100,
              commission: pos.commission || 0,
              pnl: pnl,
              timestamp: new Date().toISOString(),
              openTime: pos.timestamp,
              closeTime: new Date().toISOString(),
              entryTime: pos.entryTime,
              exitTime: candle ? candle.time : undefined,
              reason: "STOP_OUT_LIQUIDATION",
              notes: { noteBefore: "Авто-ликвидация по лимиту риска", noteDuring: "", noteAfter: "" }
            });
          }
          state.positions.splice(i, 1);
        }
      }

      if (acc.id === activeAccountId) {
        balance = acc.current_balance;
        saveBalance(balance);
      }

      saveAccountsToStorage();
      saveSimulatorState();
      updateSimulatorUI();
      updateTradeHistoryUI();
      renderAccountsModalCards();
      renderAccountSelector();

      showViolationModal(acc, breachReason, liquidatedCount);
    } else {
      const currentProfitPercent = initialBal > 0 ? ((acc.current_balance - initialBal) / initialBal) * 100 : 0;

      if (acc.type === "PROP") {
        const isAutoTransition = acc.auto_phase_transition !== false;
        if (currentPhase === "EVALUATION_1" && currentProfitPercent >= profitTargetPercent) {
          if (!acc.phase1_pending_decision && acc.status !== "PHASE1_COMPLETED_PENDING") {
            acc.status = "PHASE1_COMPLETED_PENDING";
            acc.phase1_pending_decision = true;
            saveAccountsToStorage();
            renderAccountsModalCards();
            renderAccountSelector();
            if (isAutoTransition) {
              openPropPhaseTransitionModal(acc, "EVALUATION_2");
            } else if (typeof showToast === "function") {
              showToast(`🎉 Цель Фазы 1 на счёте «${acc.name}» достигнута!`, "success");
            }
          }
        } else if (currentPhase === "EVALUATION_2" && currentProfitPercent >= profitTargetPercent) {
          if (!acc.phase2_pending_decision && acc.status !== "PHASE2_COMPLETED_PENDING") {
            acc.status = "PHASE2_COMPLETED_PENDING";
            acc.phase2_pending_decision = true;
            saveAccountsToStorage();
            renderAccountsModalCards();
            renderAccountSelector();
            if (isAutoTransition) {
              openPropPhaseTransitionModal(acc, "FUNDED");
            } else if (typeof showToast === "function") {
              showToast(`🎉 Цель Фазы 2 на счёте «${acc.name}» достигнута!`, "success");
            }
          }
        }
      } else if (profitTargetPercent > 0 && currentProfitPercent >= profitTargetPercent) {
        acc.status = "PASSED";
        saveAccountsToStorage();
        renderAccountsModalCards();
        renderAccountSelector();
        if (typeof showToast === "function") {
          showToast(`🏆 ПОЗДРАВЛЯЕМ! Цель прибыли ${profitTargetPercent}% на счёте "${acc.name}" достигнута! Счёт переведен в статус PASSED!`, "success");
        }
      }
    }
  });
}

let currentTransitionAccId = null;
let currentTransitionTargetPhase = null;

function triggerConfetti() {
  const canvas = document.createElement("canvas");
  canvas.id = "confetti-canvas";
  canvas.style.position = "fixed";
  canvas.style.top = "0";
  canvas.style.left = "0";
  canvas.style.width = "100vw";
  canvas.style.height = "100vh";
  canvas.style.pointerEvents = "none";
  canvas.style.zIndex = "999999";
  document.body.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  let width = (canvas.width = window.innerWidth);
  let height = (canvas.height = window.innerHeight);

  const colors = ["#10b981", "#3b82f6", "#f59e0b", "#ec4899", "#8b5cf6", "#38bdf8", "#f43f5e", "#fbbf24"];
  const particles = [];

  for (let i = 0; i < 150; i++) {
    particles.push({
      x: width / 2 + (Math.random() - 0.5) * 300,
      y: height / 2 - 80 + (Math.random() - 0.5) * 150,
      vx: (Math.random() - 0.5) * 18,
      vy: Math.random() * -16 - 4,
      size: Math.random() * 8 + 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * 360,
      rotationSpeed: (Math.random() - 0.5) * 12,
      opacity: 1,
      gravity: 0.35 + Math.random() * 0.15,
      drag: 0.96
    });
  }

  const startTime = Date.now();
  const duration = 2800;

  function animate() {
    const elapsed = Date.now() - startTime;
    if (elapsed >= duration) {
      if (document.body.contains(canvas)) {
        canvas.remove();
      }
      return;
    }

    ctx.clearRect(0, 0, width, height);

    particles.forEach((p) => {
      p.vx *= p.drag;
      p.vy += p.gravity;
      p.x += p.vx;
      p.y += p.vy;
      p.rotation += p.rotationSpeed;
      p.opacity = Math.max(0, 1 - elapsed / duration);

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rotation * Math.PI) / 180);
      ctx.globalAlpha = p.opacity;
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    });

    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
}

function openPropPhaseTransitionModal(acc, targetPhase) {
  if (!acc) return;

  if (typeof stopAutoplay === "function") {
    stopAutoplay();
  }

  triggerConfetti();

  currentTransitionAccId = acc.id;
  currentTransitionTargetPhase = targetPhase;

  const modal = document.getElementById("prop-phase-transition-modal");
  if (!modal) return;

  const iconEl = document.getElementById("prop-phase-modal-icon");
  const titleEl = document.getElementById("prop-phase-modal-title");
  const textEl = document.getElementById("prop-phase-modal-text");
  const confirmBtn = document.getElementById("prop-phase-confirm-btn");

  const p1Target = acc.p1_target_percent || acc.profit_target_percent || 10;
  const p2Target = acc.p2_target_percent || 5;

  if (targetPhase === "EVALUATION_2") {
    if (iconEl) iconEl.textContent = "🎉";
    if (titleEl) titleEl.textContent = "🎉 Фаза 1 пройдена! Начать Фазу 2 прямо сейчас?";
    if (textEl) {
      textEl.innerHTML = `Вы достигли цели прибыли (<b>${p1Target}%</b>) при соблюдении правил риск-менеджмента. Перейти к Фазе 2 (Верификация)?`;
    }
    if (confirmBtn) confirmBtn.textContent = "Да, начать Фазу 2";
  } else if (targetPhase === "FUNDED") {
    if (iconEl) iconEl.textContent = "🏆";
    if (titleEl) titleEl.textContent = "🎉 Фаза 2 пройдена! Перейти на Фандед прямо сейчас?";
    if (textEl) {
      textEl.innerHTML = `Фаза 2 (Верификация) завершена! Вы достигли цели прибыли (<b>${p2Target}%</b>) при соблюдении правил риск-менеджмента. Перейти на Фандед-счёт?`;
    }
    if (confirmBtn) confirmBtn.textContent = "Да, перейти на Фандед";
  }

  modal.style.display = "flex";
  if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
}

function closePropPhaseTransitionModal() {
  const modal = document.getElementById("prop-phase-transition-modal");
  if (modal) modal.style.display = "none";
  currentTransitionAccId = null;
  currentTransitionTargetPhase = null;
}

function initPropPhaseModalEvents() {
  const confirmBtn = document.getElementById("prop-phase-confirm-btn");
  if (confirmBtn) {
    confirmBtn.addEventListener("click", () => {
      if (!currentTransitionAccId || !currentTransitionTargetPhase) {
        closePropPhaseTransitionModal();
        return;
      }

      const acc = accounts.find(a => a.id === currentTransitionAccId);
      if (!acc) {
        closePropPhaseTransitionModal();
        return;
      }

      const targetPhase = currentTransitionTargetPhase;
      closePropPhaseTransitionModal();

      if (targetPhase === "EVALUATION_2") {
        acc.phase = "EVALUATION_2";
        acc.status = "ACTIVE";
        acc.max_daily_drawdown_percent = acc.p2_daily_dd_percent || 5;
        acc.max_total_drawdown_percent = acc.p2_total_dd_percent || 10;
        acc.profit_target_percent = acc.p2_target_percent || 5;
        acc.current_balance = acc.initial_balance || 10000;
        acc.phase1_pending_decision = false;
        acc.phase1_completed = true;

        if (acc.id === activeAccountId) {
          balance = acc.current_balance;
          saveBalance(balance);
        }

        awardCertificate("PHASE_1_PASSED", acc, { targetPct: acc.p1_target_percent || 10 });

        saveAccountsToStorage();
        if (typeof saveAccountState === "function") saveAccountState(acc.id);
        saveSimulatorState();
        updateSimulatorUI();
        updateTradeHistoryUI();
        renderAccountsModalCards();
        renderAccountSelector();
        renderHistoryAccountFilterSelect();

        if (typeof showToast === "function") {
          showToast(`🎉 Счёт «${acc.name}» успешно переведён на Фазу 2 (Верификация). Баланс сброшен до $${(acc.initial_balance || 10000).toLocaleString()}.`, "success");
        }
      } else if (targetPhase === "FUNDED") {
        acc.phase = "FUNDED";
        acc.status = "FUNDED";
        acc.max_daily_drawdown_percent = acc.funded_daily_dd_percent || 5;
        acc.max_total_drawdown_percent = acc.funded_total_dd_percent || 10;
        acc.profit_target_percent = 0;
        acc.current_balance = acc.initial_balance || 10000;
        acc.phase2_pending_decision = false;
        acc.phase2_completed = true;

        if (acc.id === activeAccountId) {
          balance = acc.current_balance;
          saveBalance(balance);
        }

        awardCertificate("PHASE_2_PASSED", acc, { targetPct: acc.p2_target_percent || 5 });

        saveAccountsToStorage();
        if (typeof saveAccountState === "function") saveAccountState(acc.id);
        saveSimulatorState();
        updateSimulatorUI();
        updateTradeHistoryUI();
        renderAccountsModalCards();
        renderAccountSelector();
        renderHistoryAccountFilterSelect();

        openPropCelebrationModal(acc);
      }
    });
  }

  const laterBtn = document.getElementById("prop-phase-later-btn");
  if (laterBtn) {
    laterBtn.addEventListener("click", () => {
      if (currentTransitionAccId && currentTransitionTargetPhase) {
        const acc = accounts.find(a => a.id === currentTransitionAccId);
        if (acc) {
          if (currentTransitionTargetPhase === "EVALUATION_2") {
            acc.status = "PHASE1_COMPLETED_PENDING";
            acc.phase1_pending_decision = true;
          } else if (currentTransitionTargetPhase === "FUNDED") {
            acc.status = "PHASE2_COMPLETED_PENDING";
            acc.phase2_pending_decision = true;
          }
          saveAccountsToStorage();
          if (typeof saveAccountState === "function") saveAccountState(acc.id);
          renderAccountsModalCards();
          renderAccountSelector();
          renderHistoryAccountFilterSelect();
        }
      }
      closePropPhaseTransitionModal();
      if (typeof showToast === "function") {
        showToast("Счёт сохранён в статусе ожидания перехода.", "info");
      }
    });
  }

  const celebCloseBtn = document.getElementById("prop-celebration-close-btn");
  if (celebCloseBtn) {
    celebCloseBtn.addEventListener("click", () => {
      const modal = document.getElementById("prop-celebration-modal");
      if (modal) modal.style.display = "none";
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initPropPhaseModalEvents);
} else {
  initPropPhaseModalEvents();
}

function openPropCelebrationModal(acc) {
  const modal = document.getElementById("prop-celebration-modal");
  if (!modal) return;
  const msgEl = document.getElementById("prop-celebration-message");
  if (msgEl) {
    msgEl.innerHTML = `Поздравляем! Вы успешно прошли обе фазы проп-челленджа на счёте <b>«${acc.name}»</b>!<br><br>Счёт официально переведён в статус <b>FUNDED (Реальный проп)</b>.<br>Баланс обнулён до стартового (<b>$${(acc.initial_balance || 10000).toLocaleString()}</b>).<br>Желаем успешной и дисциплинированной торговли!`;
  }
  modal.style.display = "flex";
  if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
}

function showViolationModal(acc, reason, liquidatedCount) {
  const modal = document.getElementById("violation-modal");
  if (!modal) return;

  const descEl = document.getElementById("violation-modal-desc");
  const accNameEl = document.getElementById("violation-modal-acc-name");
  const balEl = document.getElementById("violation-modal-balance");
  const countEl = document.getElementById("violation-modal-closed-count");

  if (descEl) descEl.textContent = reason || "Превышен допустимый лимит просадки.";
  if (accNameEl) accNameEl.textContent = `${acc.name} (${acc.type})`;
  if (balEl) balEl.textContent = `$${(acc.current_balance || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (countEl) countEl.textContent = liquidatedCount || 0;

  modal.style.display = "flex";
  if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
}

function closeViolationModal() {
  const modal = document.getElementById("violation-modal");
  if (modal) modal.style.display = "none";
}

// ==========================================
// СИСТЕМА СЕРТИФИКАТОВ ТРЕЙДЕРА (CERTIFICATES)
// ==========================================

let certificatesList = [];

function loadCertificates() {
  try {
    const data = localStorage.getItem("trading_certificates");
    if (data) {
      certificatesList = JSON.parse(data);
    } else {
      certificatesList = [];
    }
  } catch (e) {
    certificatesList = [];
  }
}

function saveCertificates() {
  try {
    localStorage.setItem("trading_certificates", JSON.stringify(certificatesList));
  } catch (e) {
    console.error("Failed to save certificates", e);
  }
}

function awardCertificate(type, acc, extraData = {}) {
  if (!acc) return null;
  loadCertificates();

  // Предотвращение дублирования сертификатов того же типа для одного счёта (кроме отдельных выплат)
  const existing = certificatesList.find(c => c.type === type && c.account_id === acc.id);
  if (existing && type !== "FIRST_PAYOUT") {
    return existing;
  }

  const today = new Date().toISOString().split("T")[0];
  let title = "";
  let result_text = "";
  let icon = "📜";

  if (type === "PHASE_1_PASSED") {
    const targetPct = extraData.targetPct || acc.p1_target_percent || acc.profit_target_percent || 10;
    title = "СЕРТИФИКАТ ПРОХОЖДЕНИЯ ФАЗЫ 1 (EVALUATION)";
    result_text = `🎯 Profit Target +${targetPct}% успешно выполнена при соблюдении правил риск-менеджмента`;
    icon = "🎉";
  } else if (type === "PHASE_2_PASSED") {
    const targetPct = extraData.targetPct || acc.p2_target_percent || 5;
    title = "СЕРТИФИКАТ ПРОХОЖДЕНИЯ ФАЗЫ 2 (VERIFICATION)";
    result_text = `🏆 Верификация завершена (+${targetPct}%). Доступ к FUNDED счёту открыт!`;
    icon = "🏆";
  } else if (type === "FIRST_PAYOUT") {
    const amount = extraData.amount || 0;
    title = "СЕРТИФИКАТ ПЕРВОЙ ВЫПЛАТЫ С ФАНДЕД-СЧЁТА";
    result_text = `💎 Успешный вывод прибыли $${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })} со счёта`;
    icon = "💎";
  }

  const newCert = {
    id: "cert-" + Date.now() + "-" + Math.floor(Math.random() * 1000),
    type: type,
    account_id: acc.id,
    account_name: acc.name || "Prop Account",
    broker_or_firm: acc.broker_or_firm || "Prop Firm",
    date: today,
    title: title,
    result_text: result_text,
    icon: icon,
    created_at: new Date().toISOString()
  };

  certificatesList.unshift(newCert);
  saveCertificates();

  if (typeof showToast === "function") {
    showToast(`📜 ПОЗДРАВЛЯЕМ! Вам начислен новый сертификат: ${title}!`, "success");
  }

  return newCert;
}

function renderCertificatesInProfile() {
  loadCertificates();
  const listEl = document.getElementById("certificates-list-grid");
  const countLabel = document.getElementById("certificates-count-label");
  if (!listEl) return;

  const coreAchievements = [
    {
      type: "PHASE_1_PASSED",
      title: "Фаза 1 пройдена",
      subtitle: "Достигнута цель прибыли (Evaluation)",
      defaultIcon: "🥇"
    },
    {
      type: "PHASE_2_PASSED",
      title: "Фаза 2 пройдена",
      subtitle: "Успешная верификация (Verification)",
      defaultIcon: "🏆"
    },
    {
      type: "FIRST_PAYOUT",
      title: "Первый вывод с Фандед-счёта",
      subtitle: "Первая выплата прибыли с реального счёта",
      defaultIcon: "💎"
    }
  ];

  const unlockedCount = certificatesList.length;
  if (countLabel) countLabel.textContent = `Получено: ${unlockedCount} из 3`;

  listEl.innerHTML = "";

  const activeAcc = typeof getActiveAccount === "function" ? getActiveAccount() : null;
  const internalAccId = activeAcc ? (activeAcc.id || "acc-default-01") : "acc-sim-1001";
  const accName = activeAcc ? (activeAcc.name || "Prop Account 10K") : "Prop Evaluation Account";

  coreAchievements.forEach(ach => {
    const cert = certificatesList.find(c => c.type === ach.type);
    const isUnlocked = !!cert;

    const card = document.createElement("div");

    if (isUnlocked) {
      card.style.cssText = "background: radial-gradient(circle at top left, rgba(245, 158, 11, 0.12), #0f172a 90%); border: 1px solid rgba(245, 158, 11, 0.4); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 8px; position: relative; box-shadow: 0 4px 16px rgba(0,0,0,0.4); transition: transform 0.2s ease;";
      
      card.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
          <div style="width: 38px; height: 38px; border-radius: 50%; background: radial-gradient(circle, rgba(245,158,11,0.25) 0%, rgba(15,23,42,0.8) 100%); border: 1.5px solid #f59e0b; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 12px rgba(245,158,11,0.3);">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="8" r="6"/>
              <path d="M15.477 12.89 17 22l-5-3-5 3 1.523-9.11"/>
            </svg>
          </div>
          <span style="font-size: 9px; font-weight: 800; color: #10b981; background: rgba(16, 185, 129, 0.15); padding: 3px 8px; border-radius: 4px; border: 1px solid rgba(16, 185, 129, 0.4); text-transform: uppercase; letter-spacing: 0.05em;">
            ✓ Разблокировано
          </span>
        </div>

        <div style="font-size: 13px; font-weight: 800; color: #ffffff; line-height: 1.3;">${cert.title || ach.title}</div>
        
        <div style="font-size: 10px; color: #38bdf8; font-weight: 600;">
          Счёт: «${cert.account_name || accName}»
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 9px; color: var(--text-muted);">
          <span>Дата: ${cert.date || new Date().toISOString().split('T')[0]}</span>
          <span style="font-family: monospace; color: #94a3b8;">ID: ${cert.account_id || internalAccId}</span>
        </div>

        <!-- Обязательный дисклеймер прямо на карточке -->
        <div style="padding: 6px 8px; background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 6px; color: #fca5a5; font-size: 9px; line-height: 1.3; margin-top: 2px;">
          ⚠️ Это симуляция в учебных целях. Не является официальным документом какой-либо проп-трейдинговой компании и не подтверждает реальную торговлю на реальные средства.
        </div>

        <div style="display: flex; gap: 6px; margin-top: auto; pt: 4px;">
          <button class="download-cert-btn trade-btn" data-cert-id="${cert.id}" style="height: 28px; padding: 0 10px; font-size: 10px; font-weight: 700; background: linear-gradient(135deg, #f59e0b, #d97706); color: #000; border: none; border-radius: 6px; cursor: pointer; flex: 1; display: flex; align-items: center; justify-content: center; gap: 4px;">
            <i data-lucide="download" style="width: 12px; height: 12px;"></i> Скачать PNG
          </button>
          <button class="view-cert-btn history-btn" data-cert-id="${cert.id}" style="height: 28px; padding: 0 10px; font-size: 10px; font-weight: 600; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center;">
            <i data-lucide="eye" style="width: 12px; height: 12px;"></i>
          </button>
        </div>
      `;
    } else {
      card.style.cssText = "background: rgba(15, 23, 42, 0.6); border: 1px dashed rgba(59, 130, 246, 0.3); border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 8px; position: relative; opacity: 0.75;";

      card.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 6px;">
          <div style="width: 38px; height: 38px; border-radius: 50%; background: rgba(59, 130, 246, 0.1); border: 1.5px solid #3b82f6; display: flex; align-items: center; justify-content: center;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
          </div>
          <span style="font-size: 9px; font-weight: 700; color: #64748b; background: rgba(255, 255, 255, 0.05); padding: 3px 8px; border-radius: 4px; border: 1px solid rgba(255, 255, 255, 0.1); text-transform: uppercase;">
            🔒 Заблокировано
          </span>
        </div>

        <div style="font-size: 13px; font-weight: 800; color: #cbd5e1; line-height: 1.3;">${ach.title}</div>
        
        <div style="font-size: 10px; color: #64748b;">
          ${ach.subtitle}
        </div>

        <div style="font-size: 10px; color: #3b82f6; font-style: italic; margin-top: 4px;">
          Продолжайте торговать, чтобы разблокировать
        </div>

        <div style="padding: 6px 8px; background: rgba(0, 0, 0, 0.2); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 6px; color: #64748b; font-size: 9px; line-height: 1.3; margin-top: auto;">
          ⚠️ Это симуляция в учебных целях. Не является официальным документом какой-либо проп-трейдинговой компании.
        </div>
      `;
    }

    listEl.appendChild(card);
  });

  listEl.querySelectorAll(".download-cert-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-cert-id");
      const cert = certificatesList.find(c => c.id === id);
      if (cert) {
        downloadCertificatePNG(cert);
      }
    });
  });

  listEl.querySelectorAll(".view-cert-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-cert-id");
      const cert = certificatesList.find(c => c.id === id);
      if (cert) {
        openCertificateModal(cert);
      }
    });
  });

  if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
}

let activeViewCert = null;

function openCertificateModal(cert) {
  if (!cert) return;
  activeViewCert = cert;

  const modal = document.getElementById("certificate-modal");
  if (!modal) return;

  const iconEl = document.getElementById("cert-card-icon");
  const titleEl = document.getElementById("cert-card-title");
  const accEl = document.getElementById("cert-card-account");
  const resultEl = document.getElementById("cert-card-result");
  const dateEl = document.getElementById("cert-card-date");
  const disclaimerEl = document.getElementById("cert-card-disclaimer");

  if (iconEl) iconEl.textContent = cert.icon || "📜";
  if (titleEl) titleEl.textContent = cert.title || "СЕРТИФИКАТ УСПЕХА";
  if (accEl) accEl.textContent = `«${cert.account_name}» (${cert.broker_or_firm || "Prop Firm"})`;
  if (resultEl) resultEl.textContent = cert.result_text || "Результат выполнена";
  if (dateEl) dateEl.textContent = cert.date || new Date().toISOString().split("T")[0];

  if (disclaimerEl) {
    disclaimerEl.textContent = "⚠️ Это симуляция в учебных/тренировочных целях. Данный сертификат не является официальным документом какой-либо проп-трейдинговой компании и не подтверждает реальную торговлю на реальные средства.";
  }

  modal.style.display = "flex";
  if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
}

function closeCertificateModal() {
  const modal = document.getElementById("certificate-modal");
  if (modal) modal.style.display = "none";
  activeViewCert = null;
}

function downloadCertificatePNG(cert) {
  if (!cert) return;

  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 800;
  const ctx = canvas.getContext("2d");

  // Background Gradient
  const grad = ctx.createRadialGradient(600, 400, 50, 600, 400, 700);
  grad.addColorStop(0, "#1e1b4b");
  grad.addColorStop(0.6, "#0f172a");
  grad.addColorStop(1, "#030712");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1200, 800);

  // Outer Gold Border
  ctx.strokeStyle = "#eab308";
  ctx.lineWidth = 6;
  ctx.strokeRect(30, 30, 1140, 740);

  // Inner Subtle Border
  ctx.strokeStyle = "#ca8a04";
  ctx.lineWidth = 2;
  ctx.strokeRect(42, 42, 1116, 716);

  // Corner Accents
  const corners = [[50, 50], [1150, 50], [50, 750], [1150, 750]];
  corners.forEach(([cx, cy]) => {
    ctx.fillStyle = "#eab308";
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fill();
  });

  // Top Header
  ctx.textAlign = "center";
  ctx.fillStyle = "#fbbf24";
  ctx.font = "bold 18px sans-serif";
  ctx.fillText("PROP TRADING SIMULATION ACADEMY", 600, 110);

  // Certificate Icon & Title
  ctx.font = "48px sans-serif";
  ctx.fillText(cert.icon || "📜", 600, 165);

  ctx.fillStyle = "#ffffff";
  ctx.font = "900 32px sans-serif";
  ctx.fillText(cert.title || "СЕРТИФИКАТ УСПЕХА", 600, 220);

  // Decorative Horizontal Divider
  const lineGrad = ctx.createLinearGradient(350, 0, 850, 0);
  lineGrad.addColorStop(0, "transparent");
  lineGrad.addColorStop(0.5, "#eab308");
  lineGrad.addColorStop(1, "transparent");
  ctx.strokeStyle = lineGrad;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(350, 245);
  ctx.lineTo(850, 245);
  ctx.stroke();

  // Subtitle & Account Name
  ctx.fillStyle = "#94a3b8";
  ctx.font = "20px sans-serif";
  ctx.fillText("Настоящий сертификат подтверждает, что трейдер на счёте", 600, 290);

  ctx.fillStyle = "#38bdf8";
  ctx.font = "bold 30px sans-serif";
  ctx.fillText(`«${cert.account_name}» (${cert.broker_or_firm || "Prop Firm"})`, 600, 335);

  // Result Box
  ctx.fillStyle = "rgba(234, 179, 8, 0.15)";
  ctx.strokeStyle = "rgba(234, 179, 8, 0.6)";
  ctx.lineWidth = 2;
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(200, 375, 800, 60, 12);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.fillRect(200, 375, 800, 60);
    ctx.strokeRect(200, 375, 800, 60);
  }

  ctx.fillStyle = "#fef08a";
  ctx.font = "bold 21px sans-serif";
  ctx.fillText(cert.result_text || "Результат выполнен", 600, 412);

  // Date
  ctx.fillStyle = "#64748b";
  ctx.font = "17px sans-serif";
  ctx.fillText(`Дата выдачи: ${cert.date || new Date().toISOString().split('T')[0]}`, 600, 475);

  // MANDATORY DISCLAIMER BOX
  ctx.fillStyle = "rgba(239, 68, 68, 0.18)";
  ctx.strokeStyle = "#ef4444";
  ctx.lineWidth = 3;
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(80, 520, 1040, 175, 12);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.fillRect(80, 520, 1040, 175);
    ctx.strokeRect(80, 520, 1040, 175);
  }

  ctx.fillStyle = "#fca5a5";
  ctx.font = "bold 22px sans-serif";
  ctx.fillText("⚠️ ОБЯЗАТЕЛЬНЫЙ ДИСКЛЕЙМЕР / DISCLAIMER", 600, 560);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 18px sans-serif";
  
  const text1 = "Это симуляция в учебных/тренировочных целях. Данный сертификат не является";
  const text2 = "официальным документом какой-либо проп-трейдинговой компании и не подтверждает";
  const text3 = "реальную торговлю на реальные средства.";

  ctx.fillText(text1, 600, 600);
  ctx.fillText(text2, 600, 630);
  ctx.fillText(text3, 600, 660);

  // Footer Watermark
  ctx.fillStyle = "#475569";
  ctx.font = "14px monospace";
  ctx.fillText(`ID Сертификата: ${cert.id} | Trading Simulator App`, 600, 740);

  // Trigger File Download
  const link = document.createElement("a");
  link.download = `Certificate_${cert.type}_${(cert.account_name || 'prop').replace(/\s+/g, '_')}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();

  if (typeof showToast === "function") {
    showToast("Сертификат успешно сохранён в формате PNG!", "success");
  }
}

function initCertificateModalEvents() {
  const closeBtn1 = document.getElementById("certificate-modal-close-btn");
  const closeBtn2 = document.getElementById("cert-close-btn");
  const downloadBtn = document.getElementById("cert-download-btn");

  if (closeBtn1) closeBtn1.addEventListener("click", closeCertificateModal);
  if (closeBtn2) closeBtn2.addEventListener("click", closeCertificateModal);
  if (downloadBtn) {
    downloadBtn.addEventListener("click", () => {
      if (activeViewCert) {
        downloadCertificatePNG(activeViewCert);
      }
    });
  }
}

// ==========================================
// ИНДИКАТОРЫ И ИНДИКАТОР COT REPORT (CFTC)
// ==========================================

let cotChartState = {
  active: false,
  chart: null,
  market: "AUTO",
  reportType: localStorage.getItem("plbt_cot_report_type") || "combined",
  displayMode: "histogram",
  blindMode: localStorage.getItem("plbt_cot_blind_mode") !== "false",
  series: {
    histogram: null,
    nonCommNet: null,
    commNet: null,
    retailNet: null,
    openInterest: null
  },
  visibles: {
    histogram: true,
    nonComm: true,
    comm: true,
    retail: true,
    oi: true
  }
};

function initIndicatorCatalogEvents() {
  const openCatalogBtn = document.getElementById("btn-indicators-catalog");
  const menuItemIndicators = document.getElementById("menu-item-indicators");
  const catalogModal = document.getElementById("modal-indicator-catalog");
  const catalogCloseBtn1 = document.getElementById("indicator-catalog-close-btn");
  const catalogCloseBtn2 = document.getElementById("indicator-catalog-footer-close-btn");
  const searchInput = document.getElementById("indicator-search-input");
  const categoryPillsContainer = document.getElementById("indicator-category-pills");

  const addCotBtn = document.getElementById("add-cot-indicator-btn");
  const cotConfigModal = document.getElementById("modal-cot-config");
  const cotConfigCloseBtn = document.getElementById("cot-config-close-btn");
  const cotConfigCancelBtn = document.getElementById("cot-config-cancel-btn");
  const cotConfigApplyBtn = document.getElementById("cot-config-apply-btn");
  const cotRefreshBtn = document.getElementById("cot-fetch-refresh-btn");

  const cotSettingsBtn = document.getElementById("cot-settings-btn");
  const cotCloseBtn = document.getElementById("cot-close-btn");

  const cotToggleNonComm = document.getElementById("cot-toggle-noncomm");
  const cotToggleComm = document.getElementById("cot-toggle-comm");
  const cotToggleRetail = document.getElementById("cot-toggle-retail");
  const cotToggleOI = document.getElementById("cot-toggle-oi");
  const cotToggleBlindMode = document.getElementById("cot-toggle-blind-mode");
  const cotCfgBlindMode = document.getElementById("cot-cfg-blind-mode");

  const openCatalogHandler = () => {
    const accDropdown = document.getElementById("account-selector-dropdown");
    if (accDropdown) accDropdown.style.display = "none";
    if (catalogModal) catalogModal.style.display = "flex";
    updateCatalogCotButtonState();
    if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
  };

  if (openCatalogBtn) {
    openCatalogBtn.addEventListener("click", openCatalogHandler);
  }
  if (menuItemIndicators) {
    menuItemIndicators.addEventListener("click", openCatalogHandler);
  }

  function closeCatalog() {
    if (catalogModal) catalogModal.style.display = "none";
  }

  if (catalogCloseBtn1) catalogCloseBtn1.addEventListener("click", closeCatalog);
  if (catalogCloseBtn2) catalogCloseBtn2.addEventListener("click", closeCatalog);

  // Search filtering
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      const query = e.target.value.toLowerCase().trim();
      filterCatalogCards(query);
    });
  }

  // Category pills
  if (categoryPillsContainer) {
    categoryPillsContainer.addEventListener("click", (e) => {
      const btn = e.target.closest(".indicator-pill");
      if (!btn) return;
      categoryPillsContainer.querySelectorAll(".indicator-pill").forEach(p => {
        p.classList.remove("active");
        p.style.background = "#1e293b";
        p.style.color = "#94a3b8";
        p.style.border = "1px solid #334155";
      });
      btn.classList.add("active");
      btn.style.background = "#3b82f6";
      btn.style.color = "#fff";
      btn.style.border = "none";

      const cat = btn.getAttribute("data-cat");
      filterCatalogCategory(cat);
    });
  }

  function filterCatalogCards(query) {
    const cards = document.querySelectorAll("#indicator-items-container .indicator-card");
    cards.forEach(card => {
      const keywords = (card.getAttribute("data-keywords") || "").toLowerCase();
      const text = card.textContent.toLowerCase();
      if (!query || keywords.includes(query) || text.includes(query)) {
        card.style.display = "flex";
      } else {
        card.style.display = "none";
      }
    });
  }

  function filterCatalogCategory(cat) {
    const cards = document.querySelectorAll("#indicator-items-container .indicator-card");
    cards.forEach(card => {
      const itemCats = (card.getAttribute("data-category") || "").split(",");
      if (cat === "all" || itemCats.includes(cat)) {
        card.style.display = "flex";
      } else {
        card.style.display = "none";
      }
    });
  }

  // Add COT Button in Catalog
  if (addCotBtn) {
    addCotBtn.addEventListener("click", () => {
      closeCatalog();
      if (!cotChartState.active) {
        showCOTConfigModal();
      } else {
        showCOTConfigModal();
      }
    });
  }

  function showCOTConfigModal() {
    if (cotConfigModal) {
      const reportTypeSelect = document.getElementById("cot-report-type-select");
      const marketSelect = document.getElementById("cot-market-select");
      if (reportTypeSelect) reportTypeSelect.value = cotChartState.reportType || "combined";
      if (marketSelect) marketSelect.value = cotChartState.market || "AUTO";
      if (cotCfgBlindMode) cotCfgBlindMode.checked = cotChartState.blindMode;
      cotConfigModal.style.display = "flex";
      updateCOTOfflineUI();
    }
    if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
  }

  function closeCOTConfigModal() {
    if (cotConfigModal) cotConfigModal.style.display = "none";
  }

  if (cotConfigCloseBtn) cotConfigCloseBtn.addEventListener("click", closeCOTConfigModal);
  if (cotConfigCancelBtn) cotConfigCancelBtn.addEventListener("click", closeCOTConfigModal);

  if (cotConfigApplyBtn) {
    cotConfigApplyBtn.addEventListener("click", () => {
      const reportTypeSelect = document.getElementById("cot-report-type-select");
      const marketSelect = document.getElementById("cot-market-select");
      const modeSelect = document.getElementById("cot-display-mode-select");

      const cfgNonComm = document.getElementById("cot-cfg-noncomm");
      const cfgComm = document.getElementById("cot-cfg-comm");
      const cfgRetail = document.getElementById("cot-cfg-retail");
      const cfgOI = document.getElementById("cot-cfg-oi");

      if (reportTypeSelect) {
        cotChartState.reportType = reportTypeSelect.value;
        localStorage.setItem("plbt_cot_report_type", cotChartState.reportType);
      }
      if (marketSelect) cotChartState.market = marketSelect.value;
      if (modeSelect) cotChartState.displayMode = modeSelect.value;

      cotChartState.visibles.nonComm = cfgNonComm ? cfgNonComm.checked : true;
      cotChartState.visibles.comm = cfgComm ? cfgComm.checked : true;
      cotChartState.visibles.retail = cfgRetail ? cfgRetail.checked : true;
      cotChartState.visibles.oi = cfgOI ? cfgOI.checked : true;

      if (cotCfgBlindMode) {
        cotChartState.blindMode = cotCfgBlindMode.checked;
        if (cotToggleBlindMode) cotToggleBlindMode.checked = cotChartState.blindMode;
        localStorage.setItem("plbt_cot_blind_mode", cotChartState.blindMode ? "true" : "false");
      }

      // Sync checkboxes on sub-panel
      if (cotToggleNonComm) cotToggleNonComm.checked = cotChartState.visibles.nonComm;
      if (cotToggleComm) cotToggleComm.checked = cotChartState.visibles.comm;
      if (cotToggleRetail) cotToggleRetail.checked = cotChartState.visibles.retail;
      if (cotToggleOI) cotToggleOI.checked = cotChartState.visibles.oi;

      closeCOTConfigModal();
      openCOTIndicatorPanel();
  if (typeof updateCOTOfflineUI === "function") updateCOTOfflineUI();
    });
  }

  function updateCOTOfflineUI() {
    const offline = isCOTOffline();
    const info = getCOTOfflineInfo();
    const modeBadge = document.getElementById("cot-mode-badge");
    const modalBadge = document.getElementById("cot-modal-status-badge");
    const resetBtn = document.getElementById("cot-reset-online-btn");

    if (modeBadge) {
      if (offline) {
        modeBadge.textContent = "💾 Офлайн JSON";
        modeBadge.style.background = "rgba(245, 158, 11, 0.15)";
        modeBadge.style.borderColor = "rgba(245, 158, 11, 0.4)";
        modeBadge.style.color = "#fbbf24";
        modeBadge.title = `Режим: Офлайн (База из JSON). Отчетов: ${info.reportCount}, Рынков: ${info.marketsCount}. Кликните для настройки.`;
      } else {
        modeBadge.textContent = "🟢 CFTC Live";
        modeBadge.style.background = "rgba(34, 197, 94, 0.1)";
        modeBadge.style.borderColor = "rgba(34, 197, 94, 0.3)";
        modeBadge.style.color = "#4ade80";
        modeBadge.title = "Источник данных: Прямой Live CFTC API";
      }
    }

    if (modalBadge) {
      if (offline) {
        modalBadge.textContent = `💾 Офлайн режим (${info.reportCount} отчетов)`;
        modalBadge.style.background = "rgba(245, 158, 11, 0.15)";
        modalBadge.style.borderColor = "rgba(245, 158, 11, 0.4)";
        modalBadge.style.color = "#fbbf24";
      } else {
        modalBadge.textContent = "🟢 Live CFTC API";
        modalBadge.style.background = "rgba(34, 197, 94, 0.1)";
        modalBadge.style.borderColor = "rgba(34, 197, 94, 0.3)";
        modalBadge.style.color = "#4ade80";
      }
    }

    if (resetBtn) {
      resetBtn.style.display = offline ? "inline-flex" : "none";
    }
  }

  // Export COT JSON handlers
  const handleExportCOT = () => {
    try {
      const exported = exportAllCOTDataToJSON();
      if (typeof showToast === "function") {
        showToast(`Экспортировано ${exported.totalReports} отчетов CFTC в файл COT_CFTC_database.json`, "success");
      }
    } catch (err) {
      console.error("[COT Export Error]", err);
      if (typeof showToast === "function") {
        showToast("Ошибка при экспорте COT базы: " + err.message, "error");
      }
    }
  };

  const cotExportBtn = document.getElementById("cot-export-btn");
  const cotPanelExportBtn = document.getElementById("cot-panel-export-btn");
  if (cotExportBtn) cotExportBtn.addEventListener("click", handleExportCOT);
  if (cotPanelExportBtn) cotPanelExportBtn.addEventListener("click", handleExportCOT);

  // Import COT JSON handlers
  const cotFileInput = document.getElementById("cotFileInput");
  const cotImportBtn = document.getElementById("cot-import-btn");
  const cotPanelImportBtn = document.getElementById("cot-panel-import-btn");

  const triggerImportFile = () => {
    if (cotFileInput) {
      cotFileInput.value = "";
      cotFileInput.click();
    }
  };

  if (cotImportBtn) cotImportBtn.addEventListener("click", triggerImportFile);
  if (cotPanelImportBtn) cotPanelImportBtn.addEventListener("click", triggerImportFile);

  if (cotFileInput) {
    cotFileInput.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (event) => {
        try {
          const res = importCOTDataFromJSON(event.target.result);
          updateCOTOfflineUI();
          await updateCOTChartData();
          if (typeof showToast === "function") {
            showToast(`Успешно импортировано ${res.importedReports} отчетов COT! Офлайн-режим активирован.`, "success");
          }
        } catch (err) {
          console.error("[COT Import Error]", err);
          if (typeof showToast === "function") {
            showToast("Ошибка импорта файла COT: " + err.message, "error");
          }
        }
      };
      reader.readAsText(file);
    });
  }

  // Reset to Online Live API
  const cotResetOnlineBtn = document.getElementById("cot-reset-online-btn");
  if (cotResetOnlineBtn) {
    cotResetOnlineBtn.addEventListener("click", async () => {
      setCOTOfflineMode(false);
      updateCOTOfflineUI();
      const activeMarket = cotChartState.market === "AUTO" ? getCOTMarketForSymbol(state.symbol) : cotChartState.market;
      await fetchRealCFTCData(activeMarket, cotChartState.reportType, true);
      await updateCOTChartData();
      if (typeof showToast === "function") {
        showToast("Переключено на Live CFTC API", "info");
      }
    });
  }

  const cotModeBadge = document.getElementById("cot-mode-badge");
  if (cotModeBadge) {
    cotModeBadge.addEventListener("click", () => {
      showCOTConfigModal();
    });
  }

  if (cotRefreshBtn) {
    cotRefreshBtn.addEventListener("click", async () => {
      if (isCOTOffline()) {
        setCOTOfflineMode(false);
        updateCOTOfflineUI();
      }
      const activeMarket = cotChartState.market === "AUTO" ? getCOTMarketForSymbol(state.symbol) : cotChartState.market;
      await fetchRealCFTCData(activeMarket, cotChartState.reportType, true);
      await updateCOTChartData();
      if (typeof showToast === "function") {
        showToast("Данные отчетов CFTC успешно обновлены из официального реестра", "success");
      }
    });
  }

  // Panel Header Buttons
  if (cotSettingsBtn) {
    cotSettingsBtn.addEventListener("click", () => {
      showCOTConfigModal();
    });
  }

  if (cotCloseBtn) {
    cotCloseBtn.addEventListener("click", () => {
      removeCOTIndicatorPanel();
    });
  }

  // Checkbox legend toggles in COT sub-panel
  [cotToggleNonComm, cotToggleComm, cotToggleRetail, cotToggleOI].forEach(chk => {
    if (chk) {
      chk.addEventListener("change", () => {
        cotChartState.visibles.nonComm = cotToggleNonComm ? cotToggleNonComm.checked : true;
        cotChartState.visibles.comm = cotToggleComm ? cotToggleComm.checked : true;
        cotChartState.visibles.retail = cotToggleRetail ? cotToggleRetail.checked : true;
        cotChartState.visibles.oi = cotToggleOI ? cotToggleOI.checked : true;
        applyCOTSeriesVisibility();
      });
    }
  });

  // Blind Mode Toggle in COT sub-panel
  if (cotToggleBlindMode) {
    cotToggleBlindMode.checked = cotChartState.blindMode;
    cotToggleBlindMode.addEventListener("change", () => {
      cotChartState.blindMode = cotToggleBlindMode.checked;
      if (cotCfgBlindMode) cotCfgBlindMode.checked = cotChartState.blindMode;
      localStorage.setItem("plbt_cot_blind_mode", cotChartState.blindMode ? "true" : "false");
      updateCOTChartData();
      if (typeof showToast === "function") {
        showToast(
          cotChartState.blindMode
            ? "Слепой режим COT активен: будущие отчеты скрыты"
            : "Слепой режим COT выключен: отображаются все отчеты",
          "info"
        );
      }
    });
  }

  if (cotCfgBlindMode) {
    cotCfgBlindMode.checked = cotChartState.blindMode;
    cotCfgBlindMode.addEventListener("change", () => {
      cotChartState.blindMode = cotCfgBlindMode.checked;
      if (cotToggleBlindMode) cotToggleBlindMode.checked = cotChartState.blindMode;
      localStorage.setItem("plbt_cot_blind_mode", cotChartState.blindMode ? "true" : "false");
    });
  }

  // Initialize COT panel resizer
  initCOTResizeHandle();
}

function updateCatalogCotButtonState() {
  const textEl = document.getElementById("add-cot-btn-text");
  const countEl = document.getElementById("active-indicators-count");
  if (textEl) {
    textEl.textContent = cotChartState.active ? "Настройки / Активен" : "Добавить";
  }
  if (countEl) {
    if (cotChartState.active) {
      countEl.textContent = "1";
      countEl.style.display = "inline-block";
    } else {
      countEl.style.display = "none";
    }
  }
}

const COT_STORAGE_HEIGHT_KEY = "plbt_cot_panel_height";

function initCOTResizeHandle() {
  const handle = document.getElementById("cot-resize-handle");
  const panel = document.getElementById("cot-indicator-panel");
  if (!handle || !panel || handle.dataset.initialized) return;
  handle.dataset.initialized = "true";

  // Restore saved height on initialization
  const savedHeight = parseInt(localStorage.getItem(COT_STORAGE_HEIGHT_KEY), 10);
  if (!isNaN(savedHeight) && savedHeight >= 80 && savedHeight <= 800) {
    panel.style.height = `${savedHeight}px`;
  }

  let isDragging = false;
  let startY = 0;
  let startHeight = 0;

  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    startY = e.clientY;
    startHeight = panel.getBoundingClientRect().height;
    handle.classList.add("active");
    try {
      handle.setPointerCapture(e.pointerId);
    } catch (err) {}
    document.body.style.userSelect = "none";
    document.body.style.cursor = "ns-resize";
  });

  handle.addEventListener("pointermove", (e) => {
    if (!isDragging) return;
    const deltaY = startY - e.clientY;
    const parentEl = panel.parentElement;
    const parentHeight = parentEl ? parentEl.clientHeight : window.innerHeight;
    const minHeight = 80;
    const maxHeight = Math.max(minHeight + 50, parentHeight - 120);
    const newHeight = Math.min(Math.max(startHeight + deltaY, minHeight), maxHeight);
    panel.style.height = `${newHeight}px`;

    // Resize main chart and COT chart immediately
    if (typeof chart !== "undefined" && chart && chart.resize) {
      const cv = document.getElementById("chart-viewport");
      if (cv) chart.resize(cv.clientWidth, cv.clientHeight);
    }
    if (cotChartState.chart) {
      const cc = document.getElementById("cot-chart-container");
      if (cc) cotChartState.chart.resize(cc.clientWidth, cc.clientHeight);
    }
    if (typeof resizeCanvas === "function") resizeCanvas();
    syncCOTTimeScaleWithMain();
  });

  const stopDrag = (e) => {
    if (!isDragging) return;
    isDragging = false;
    handle.classList.remove("active");
    try {
      handle.releasePointerCapture(e.pointerId);
    } catch (err) {}
    document.body.style.userSelect = "";
    document.body.style.cursor = "";

    const finalHeight = Math.round(panel.getBoundingClientRect().height);
    try {
      localStorage.setItem(COT_STORAGE_HEIGHT_KEY, finalHeight.toString());
    } catch (err) {}

    if (typeof onWindowResize === "function") onWindowResize();
    syncCOTTimeScaleWithMain();
  };

  handle.addEventListener("pointerup", stopDrag);
  handle.addEventListener("pointercancel", stopDrag);
}

function openCOTIndicatorPanel() {
  const panel = document.getElementById("cot-indicator-panel");
  if (!panel) return;

  initCOTResizeHandle();

  // Restore saved height
  const savedHeight = parseInt(localStorage.getItem(COT_STORAGE_HEIGHT_KEY), 10);
  if (!isNaN(savedHeight) && savedHeight >= 80 && savedHeight <= 800) {
    panel.style.height = `${savedHeight}px`;
  }

  panel.style.display = "block";
  cotChartState.active = true;
  updateCatalogCotButtonState();
  if (typeof recordLastIndicator === "function") {
    recordLastIndicator("cot", "COT Report (CFTC)");
  }

  const offline = isCOTOffline();
  const info = getCOTOfflineInfo();
  const modeBadge = document.getElementById("cot-mode-badge");
  if (modeBadge) {
    if (offline) {
      modeBadge.textContent = "💾 Офлайн JSON";
      modeBadge.style.background = "rgba(245, 158, 11, 0.15)";
      modeBadge.style.borderColor = "rgba(245, 158, 11, 0.4)";
      modeBadge.style.color = "#fbbf24";
      modeBadge.title = `Режим: Офлайн (База из JSON). Отчетов: ${info.reportCount}, Рынков: ${info.marketsCount}. Кликните для настройки.`;
    } else {
      modeBadge.textContent = "🟢 CFTC Live";
      modeBadge.style.background = "rgba(34, 197, 94, 0.1)";
      modeBadge.style.borderColor = "rgba(34, 197, 94, 0.3)";
      modeBadge.style.color = "#4ade80";
      modeBadge.title = "Источник данных: Прямой Live CFTC API";
    }
  }

  if (!cotChartState.chart) {
    requestAnimationFrame(() => {
      initCOTChartInstance();
    });
  } else {
    requestAnimationFrame(() => {
      const container = document.getElementById("cot-chart-container");
      if (container && cotChartState.chart) {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w > 0 && h > 0) {
          cotChartState.chart.resize(w, h);
        }
      }
      updateCOTChartData();
      syncCOTTimeScaleWithMain();
    });
  }

  setTimeout(() => {
    if (typeof onWindowResize === "function") onWindowResize();
    const container = document.getElementById("cot-chart-container");
    if (container && cotChartState.chart) {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w > 0 && h > 0) {
        cotChartState.chart.resize(w, h);
      }
      syncCOTTimeScaleWithMain();
    }
  }, 60);

  if (typeof showToast === "function") {
    showToast("Индикатор COT Report добавлен на график", "success");
  }
}

function removeCOTIndicatorPanel() {
  const panel = document.getElementById("cot-indicator-panel");
  if (panel) panel.style.display = "none";
  cotChartState.active = false;
  updateCatalogCotButtonState();

  if (cotChartState.chart) {
    cotChartState.chart.remove();
    cotChartState.chart = null;
  }

  setTimeout(() => {
    if (typeof onWindowResize === "function") onWindowResize();
  }, 100);

  if (typeof showToast === "function") {
    showToast("Индикатор COT Report удален", "info");
  }
}

let isSyncingCOTTimeRange = false;
let activeTimeSyncSource = "main"; // "main" | "cot"

function areLogicalRangesEqual(r1, r2, eps = 0.001) {
  if (!r1 || !r2) return false;
  return Math.abs(r1.from - r2.from) < eps && Math.abs(r1.to - r2.to) < eps;
}

function syncCOTTimeScaleWithMain() {
  if (!cotChartState.chart || !cotChartState.active || typeof chart === "undefined" || !chart || !chart.timeScale) return;
  if (isSyncingCOTTimeRange) return;
  try {
    const srcRange = chart.timeScale().getVisibleLogicalRange();
    if (!srcRange) return;
    const tgtRange = cotChartState.chart.timeScale().getVisibleLogicalRange();
    if (areLogicalRangesEqual(srcRange, tgtRange)) return;

    isSyncingCOTTimeRange = true;
    cotChartState.chart.timeScale().setVisibleLogicalRange(srcRange);
  } catch (e) {
  } finally {
    window.requestAnimationFrame(() => {
      isSyncingCOTTimeRange = false;
    });
  }
}
window.syncCOTTimeScaleWithMain = syncCOTTimeScaleWithMain;

function testCOTSyncAlignment(x = 500) {
  if (typeof chart === "undefined" || !chart || !cotChartState.chart || !cotChartState.active) return;
  try {
    const mainTime = chart.timeScale().coordinateToTime(x);
    const cotTime = cotChartState.chart.timeScale().coordinateToTime(x);
    if (!mainTime && !cotTime) return;

    const mainDate = mainTime ? new Date(mainTime * 1000).toISOString().split("T")[0] : "N/A";
    const cotDate = cotTime ? new Date(cotTime * 1000).toISOString().split("T")[0] : "N/A";
    const diffSec = (mainTime && cotTime) ? Math.abs(mainTime - cotTime) : null;
    const diffDays = diffSec !== null ? (diffSec / 86400).toFixed(1) : "N/A";

    console.log(
      `%c[COT TimeScale Sync @ X=${x}px]%c Main Chart: ${mainDate} (${mainTime}) | COT Panel: ${cotDate} (${cotTime}) | Diff: ~${diffDays} days (${diffSec}s)`,
      "color: #38bdf8; font-weight: bold;",
      "color: #94a3b8;"
    );
  } catch (e) {
    console.warn("[COT Sync Test Error]", e);
  }
}
window.testCOTSyncAlignment = testCOTSyncAlignment;

let lastCOTHoverTimestamp = null;

function updateCOTLegendForCrosshair(timestamp = null) {
  lastCOTHoverTimestamp = timestamp;
  const dateBadge = document.getElementById("cot-latest-date-badge");
  if (!dateBadge || !cotChartState.active) return;

  const activeMarket = cotChartState.market === "AUTO" ? getCOTMarketForSymbol(state.symbol) : cotChartState.market;
  const maxSimTimestamp = cotChartState.blindMode && state.isBacktestActive ? state.currentReplayTimestamp : null;
  const reports = getCOTDataForMarket(activeMarket, cotChartState.reportType, maxSimTimestamp);
  if (!reports || reports.length === 0) {
    dateBadge.textContent = "Отчет: нет данных на текущую дату симуляции";
    return;
  }

  let matchedRecord = null;
  if (timestamp !== null && timestamp !== undefined) {
    let targetSec = Number(timestamp);
    if (typeof timestamp === "string") {
      const parsed = new Date(timestamp).getTime();
      if (!isNaN(parsed)) targetSec = Math.floor(parsed / 1000);
    } else if (typeof timestamp === "object" && timestamp.year && timestamp.month && timestamp.day) {
      targetSec = Math.floor(Date.UTC(timestamp.year, timestamp.month - 1, timestamp.day) / 1000);
    }
    if (targetSec > 1e11) targetSec = Math.floor(targetSec / 1000);

    // Find the latest report on or before the target cursor timestamp (aligned with pubTimestamp)
    for (let i = reports.length - 1; i >= 0; i--) {
      const r = reports[i];
      const rTime = Number(r.pubTimestamp || r.reportTimestamp);
      if (rTime <= targetSec) {
        matchedRecord = r;
        break;
      }
    }
    if (!matchedRecord && reports.length > 0) {
      matchedRecord = reports[0];
    }
  } else {
    // Default to the latest available report in the active series
    matchedRecord = reports[reports.length - 1];
  }

  if (!matchedRecord) {
    dateBadge.textContent = "Отчет: нет данных";
    return;
  }

  let pubDate = matchedRecord.pubDate || matchedRecord.pub_date || matchedRecord.publish_date;
  if (typeof pubDate === "string" && pubDate.includes("T")) {
    pubDate = pubDate.split("T")[0];
  }
  if (!pubDate) {
    if (matchedRecord.pubTimestamp) {
      const rawT = Number(matchedRecord.pubTimestamp);
      const d = new Date(rawT > 1e11 ? rawT : rawT * 1000);
      pubDate = d.toISOString().split("T")[0];
    } else if (matchedRecord.reportDate) {
      const d = new Date(matchedRecord.reportDate.split("T")[0] + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + 3);
      pubDate = d.toISOString().split("T")[0];
    } else if (matchedRecord.reportTimestamp) {
      const rawT = Number(matchedRecord.reportTimestamp);
      const d = new Date(rawT > 1e11 ? rawT : rawT * 1000);
      d.setUTCDate(d.getUTCDate() + 3);
      pubDate = d.toISOString().split("T")[0];
    }
  }
  if (!pubDate) {
    pubDate = matchedRecord.reportDate || (matchedRecord.report_date_as_yyyy_mm_dd ? matchedRecord.report_date_as_yyyy_mm_dd.split("T")[0] : matchedRecord.date) || "—";
  }

  const parts = [`Отчет: <span style="color: #cbd5e1; font-weight: 600;">${pubDate}</span>`];

  const v = cotChartState.visibles;

  if (v.nonComm) {
    const netVal = matchedRecord.nonCommNet !== undefined 
      ? Number(matchedRecord.nonCommNet) 
      : ((matchedRecord.nonCommLong ?? matchedRecord.noncommercial_positions_long_all ?? 0) - (matchedRecord.nonCommShort ?? matchedRecord.noncommercial_positions_short_all ?? 0));
    const sign = netVal > 0 ? "+" : "";
    const color = netVal >= 0 ? "#60a5fa" : "#ef4444";
    parts.push(`Non-Comm: <span style="color: ${color}; font-weight: 600;">${sign}${netVal.toLocaleString()}</span>`);
  }

  if (v.comm) {
    const commVal = matchedRecord.commNet !== undefined 
      ? Number(matchedRecord.commNet) 
      : ((matchedRecord.commLong ?? matchedRecord.commercial_positions_long_all ?? 0) - (matchedRecord.commShort ?? matchedRecord.commercial_positions_short_all ?? 0));
    const sign = commVal > 0 ? "+" : "";
    const color = "#f87171";
    parts.push(`Comm: <span style="color: ${color}; font-weight: 600;">${sign}${commVal.toLocaleString()}</span>`);
  }

  if (v.retail) {
    const retailVal = matchedRecord.retailNet !== undefined 
      ? Number(matchedRecord.retailNet) 
      : ((matchedRecord.retailLong ?? matchedRecord.nonreportable_positions_long_all ?? 0) - (matchedRecord.retailShort ?? matchedRecord.nonreportable_positions_short_all ?? 0));
    const sign = retailVal > 0 ? "+" : "";
    const color = "#c084fc";
    parts.push(`Retail: <span style="color: ${color}; font-weight: 600;">${sign}${retailVal.toLocaleString()}</span>`);
  }

  const oiVal = matchedRecord.openInterest !== undefined 
    ? matchedRecord.openInterest 
    : (matchedRecord.open_interest_all ?? matchedRecord.open_interest_old);
  if (v.oi && oiVal !== undefined && oiVal !== null) {
    parts.push(`OI: <span style="color: #facc15; font-weight: 600;">${Number(oiVal).toLocaleString()}</span>`);
  }

  dateBadge.innerHTML = parts.join(' <span style="color: #334155; margin: 0 3px;">|</span> ');
}

function getCOTFridayDateForTimestamp(t) {
  const d = new Date(t * 1000);
  const day = d.getUTCDay(); // 0 = Sun, 1 = Mon, ..., 5 = Fri, 6 = Sat
  const diffDays = day >= 5 ? day - 5 : day + 2;
  return new Date(d.getTime() - diffDays * 86400 * 1000);
}

function initCOTChartInstance() {
  const container = document.getElementById("cot-chart-container");
  if (!container) return;

  const rect = container.getBoundingClientRect();
  const width = container.clientWidth || rect.width;
  const height = container.clientHeight || rect.height;

  // Prevent race condition with browser layout:
  // If container has 0 width or height, defer until the next animation frame when layout completes.
  if (width <= 0 || height <= 0) {
    requestAnimationFrame(() => {
      initCOTChartInstance();
    });
    return;
  }

  if (cotChartState.chart) {
    cotChartState.chart.remove();
    cotChartState.chart = null;
  }

  const cotChart = LightweightCharts.createChart(container, {
    width: Math.floor(width),
    height: Math.floor(height),
    layout: {
      background: { type: "solid", color: "#0b101b" },
      textColor: "#94a3b8",
      fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontSize: 10
    },
    localization: {
      dateFormat: 'yyyy-MM-dd',
      timeFormatter: (time) => {
        let t = typeof time === "number" ? time : (new Date(Date.UTC(time.year, time.month - 1, time.day)).getTime() / 1000);
        const fri = getCOTFridayDateForTimestamp(t);
        const y = fri.getUTCFullYear();
        const m = String(fri.getUTCMonth() + 1).padStart(2, '0');
        const day = String(fri.getUTCDate()).padStart(2, '0');
        return `${day}.${m}.${y}`;
      }
    },
    grid: {
      vertLines: { color: "rgba(30, 41, 59, 0.15)" },
      horzLines: { color: "rgba(30, 41, 59, 0.15)" }
    },
    rightPriceScale: {
      borderColor: "#1e293b",
      borderVisible: true,
      scaleMargins: { top: 0.1, bottom: 0.1 },
      minimumWidth: 75,
      autoScale: true
    },
    leftPriceScale: {
      visible: false
    },
    timeScale: {
      borderColor: "#1e293b",
      borderVisible: true,
      timeVisible: true,
      secondsVisible: false,
      barSpacing: 10,
      rightOffset: 0,
      tickMarkFormatter: (time, tickMarkType) => {
        let t = typeof time === "number" ? time : (new Date(Date.UTC(time.year, time.month - 1, time.day)).getTime() / 1000);
        const fri = getCOTFridayDateForTimestamp(t);
        const months = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
        if (tickMarkType === 0) {
          return String(fri.getUTCFullYear());
        }
        if (tickMarkType === 1) {
          return months[fri.getUTCMonth()];
        }
        return String(fri.getUTCDate());
      }
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: true
    },
    handleScale: {
      mouseWheel: true,
      pinch: true,
      axisPressedMouseMove: {
        time: true,
        price: true
      },
      axisDoubleClickReset: {
        time: true,
        price: true
      }
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: {
        color: "rgba(117, 134, 150, 0.35)",
        width: 1,
        style: 2,
        labelBackgroundColor: "#0f172a",
        labelVisible: true
      },
      horzLine: {
        color: "rgba(117, 134, 150, 0.35)",
        width: 1,
        style: 2,
        labelBackgroundColor: "#0f172a",
        labelVisible: false
      }
    }
  });

  cotChartState.chart = cotChart;
  cotChart.resize(Math.floor(width), Math.floor(height));

  // Add MyFXBook style net position histogram series
  cotChartState.series.histogram = cotChart.addHistogramSeries({
    color: "#10b981",
    priceFormat: {
      type: "volume"
    },
    priceScaleId: "right",
    priceLineVisible: false,
    lastValueVisible: false
  });

  // Add line series
  cotChartState.series.nonCommNet = cotChart.addLineSeries({
    color: "#3b82f6",
    lineWidth: 2,
    title: "Non-Comm Net",
    priceScaleId: "right",
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: true
  });

  cotChartState.series.commNet = cotChart.addLineSeries({
    color: "#ef4444",
    lineWidth: 2,
    title: "Comm Net",
    priceScaleId: "right",
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: true
  });

  cotChartState.series.retailNet = cotChart.addLineSeries({
    color: "#a855f7",
    lineWidth: 1,
    lineStyle: 2,
    title: "Retail Net",
    priceScaleId: "right",
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: true
  });

  cotChartState.series.openInterest = cotChart.addLineSeries({
    color: "#eab308",
    lineWidth: 1,
    lineStyle: 3,
    title: "Open Interest",
    priceScaleId: "right",
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: true
  });

  // Subpanel Indicator Synchronization:
  // Main Price Chart has highest priority, while COT chart can also be scaled/panned seamlessly.
  const setMainActive = () => { activeTimeSyncSource = "main"; };
  const setCotActive = () => { activeTimeSyncSource = "cot"; };

  container.addEventListener("pointerdown", setCotActive, { passive: true });
  container.addEventListener("wheel", setCotActive, { passive: true });
  container.addEventListener("mouseenter", setCotActive, { passive: true });

  const mainViewport = document.getElementById("chart-viewport") || document.getElementById("chart-container") || document.querySelector(".chart-container");
  if (mainViewport) {
    mainViewport.addEventListener("pointerdown", setMainActive, { passive: true });
    mainViewport.addEventListener("wheel", setMainActive, { passive: true });
    mainViewport.addEventListener("mouseenter", setMainActive, { passive: true });
  }

  if (typeof chart !== "undefined" && chart && chart.timeScale) {
    // 1. Main chart changes -> Sync to COT chart
    chart.timeScale().subscribeVisibleLogicalRangeChange((logicalRange) => {
      if (!cotChartState.chart || !cotChartState.active || !logicalRange) return;
      if (isSyncingCOTTimeRange) return;
      const tgtRange = cotChartState.chart.timeScale().getVisibleLogicalRange();
      if (areLogicalRangesEqual(logicalRange, tgtRange)) return;

      console.count("[SYNC LOOP]");
      isSyncingCOTTimeRange = true;
      try {
        cotChartState.chart.timeScale().setVisibleLogicalRange(logicalRange);
      } catch (e) {}
      finally {
        window.requestAnimationFrame(() => {
          isSyncingCOTTimeRange = false;
        });
      }
    });

    // 2. COT chart changes -> Sync to Main chart when user interacts with COT panel
    cotChart.timeScale().subscribeVisibleLogicalRangeChange((logicalRange) => {
      if (typeof chart === "undefined" || !chart || !cotChartState.active || !logicalRange) return;
      if (isSyncingCOTTimeRange) return;
      if (activeTimeSyncSource !== "cot") return;
      const tgtRange = chart.timeScale().getVisibleLogicalRange();
      if (areLogicalRangesEqual(logicalRange, tgtRange)) return;

      console.count("[SYNC LOOP]");
      isSyncingCOTTimeRange = true;
      try {
        chart.timeScale().setVisibleLogicalRange(logicalRange);
      } catch (e) {}
      finally {
        window.requestAnimationFrame(() => {
          isSyncingCOTTimeRange = false;
        });
      }
    });

    chart.subscribeCrosshairMove((param) => {
      if (!cotChartState.active) return;
      if (!param || !param.point || param.time === undefined || param.time === null) {
        updateCOTLegendForCrosshair(null);
      } else {
        updateCOTLegendForCrosshair(param.time);
      }
    });
  }

  cotChart.subscribeCrosshairMove((param) => {
    if (!cotChartState.active) return;
    if (!param || !param.point || param.time === undefined || param.time === null) {
      updateCOTLegendForCrosshair(null);
    } else {
      updateCOTLegendForCrosshair(param.time);
    }
  });

  // Reset legend when cursor leaves chart panels
  container.addEventListener("mouseleave", () => {
    if (cotChartState.active) {
      updateCOTLegendForCrosshair(null);
    }
  });

  const cotPanel = document.getElementById("cot-indicator-panel");
  if (cotPanel) {
    cotPanel.addEventListener("mouseleave", () => {
      if (cotChartState.active) {
        updateCOTLegendForCrosshair(null);
      }
    });
  }

  const chartViewport = document.getElementById("chart-viewport");
  if (chartViewport) {
    chartViewport.addEventListener("mouseleave", () => {
      if (cotChartState.active) {
        updateCOTLegendForCrosshair(null);
      }
    });
  }

  // Resize observer to handle container size changes smoothly
  const cotResizeObserver = new ResizeObserver((entries) => {
    if (entries.length > 0 && cotChartState.chart) {
      window.requestAnimationFrame(() => {
        if (cotChartState.chart) {
          const width = entries[0].contentRect.width;
          const height = entries[0].contentRect.height;
          if (width > 0 && height > 0) {
            cotChartState.chart.resize(width, height);
            console.log("[COT SCALE]", "cotResizeObserver -> syncCOTTimeScaleWithMain", "line 18818", "range before:", chart ? chart.timeScale().getVisibleRange() : null);
            syncCOTTimeScaleWithMain();
          }
        }
      });
    }
  });
  cotResizeObserver.observe(container);

  updateCOTChartData();
}

let lastRenderedCOTReportCount = -1;
let lastRenderedCOTMarket = "";
let lastRenderedCOTType = "";
let lastRenderedCandlesCount = -1;
let lastRenderedLastCandleTime = -1;
let lastRenderedCOTLastPointTime = -1;

function getActiveCandlesForCOT() {
  if (state.isBacktestActive && state.backtestVisibleCandles && state.backtestVisibleCandles.length > 0) {
    return state.backtestVisibleCandles;
  }
  return state.historicalCandles || [];
}

async function updateCOTChartData(forceRefresh = true) {
  if (!cotChartState.active || !cotChartState.chart) return;

  if (forceRefresh && typeof clearCOTFormatCache === "function") {
    clearCOTFormatCache();
  }

  const activeMarket = cotChartState.market === "AUTO" ? getCOTMarketForSymbol(state.symbol) : cotChartState.market;
  const marketInfo = CFTC_MARKETS[activeMarket] || CFTC_MARKETS.EUR;
  const reportType = cotChartState.reportType || "combined";

  // Update UI symbol badge & report type badge
  const badge = document.getElementById("cot-symbol-badge");
  if (badge) badge.textContent = marketInfo.label;

  const typeBadge = document.getElementById("cot-type-badge");
  if (typeBadge) {
    if (reportType === "futures_only") {
      typeBadge.textContent = "Legacy: Futures Only";
      typeBadge.style.color = "#38bdf8";
      typeBadge.style.borderColor = "rgba(56, 189, 248, 0.3)";
      typeBadge.style.background = "rgba(56, 189, 248, 0.1)";
      typeBadge.title = "Тип отчета CFTC: Legacy Только Фьючерсы (Futures Only)";
    } else {
      typeBadge.textContent = "Legacy: Futures+Options";
      typeBadge.style.color = "#c084fc";
      typeBadge.style.borderColor = "rgba(168, 85, 247, 0.3)";
      typeBadge.style.background = "rgba(168, 85, 247, 0.1)";
      typeBadge.title = "Тип отчета CFTC: Legacy Futures + Options Combined (как на MyFXBook)";
    }
  }

  const offline = isCOTOffline();
  const info = getCOTOfflineInfo();
  const modeBadge = document.getElementById("cot-mode-badge");
  if (modeBadge) {
    if (offline) {
      modeBadge.textContent = "💾 Офлайн JSON";
      modeBadge.style.background = "rgba(245, 158, 11, 0.15)";
      modeBadge.style.borderColor = "rgba(245, 158, 11, 0.4)";
      modeBadge.style.color = "#fbbf24";
      modeBadge.title = `Режим: Офлайн (База из JSON). Отчетов: ${info.reportCount}, Рынков: ${info.marketsCount}. Кликните для настройки.`;
    } else {
      modeBadge.textContent = "🟢 CFTC Live";
      modeBadge.style.background = "rgba(34, 197, 94, 0.1)";
      modeBadge.style.borderColor = "rgba(34, 197, 94, 0.3)";
      modeBadge.color = "#4ade80";
      modeBadge.title = "Источник данных: Прямой Live CFTC API";
    }
  }

  // Fetch real CFTC data (cached locally with 24h TTL)
  const allRealReports = await fetchRealCFTCData(activeMarket, reportType, false);

  if (!allRealReports || allRealReports.length === 0) {
    console.error(`[COT Error] Не удалось загрузить данные COT для ${activeMarket} (${reportType})`);
    if (typeof showToast === "function") {
      showToast(`Не удалось загрузить данные COT для ${marketInfo.label}`, "error");
    }
    const dateBadge = document.getElementById("cot-latest-date-badge");
    if (dateBadge) dateBadge.textContent = "Ошибка: нет данных CFTC";
    if (cotChartState.series.histogram) cotChartState.series.histogram.setData([]);
    if (cotChartState.series.nonCommNet) cotChartState.series.nonCommNet.setData([]);
    if (cotChartState.series.commNet) cotChartState.series.commNet.setData([]);
    if (cotChartState.series.retailNet) cotChartState.series.retailNet.setData([]);
    if (cotChartState.series.openInterest) cotChartState.series.openInterest.setData([]);
    return;
  }

  // Filter for blind mode in backtest
  let maxSimTimestamp = null;
  if (cotChartState.blindMode && state.isBacktestActive && state.currentReplayTimestamp) {
    maxSimTimestamp = state.currentReplayTimestamp;
  }

  const reports = getCOTDataForMarket(activeMarket, reportType, maxSimTimestamp);
  const activeCandles = getActiveCandlesForCOT();
  const lastCandle = activeCandles.length > 0 ? activeCandles[activeCandles.length - 1] : null;
  const lastCandleTime = lastCandle ? Number(lastCandle.time) : -1;

  lastRenderedCOTReportCount = reports.length;
  lastRenderedCOTMarket = activeMarket;
  lastRenderedCOTType = reportType;
  lastRenderedCandlesCount = activeCandles.length;
  lastRenderedLastCandleTime = lastCandleTime;

  const formatted = formatCOTSeriesData(reports, activeCandles);

  // Set real data to series
  if (cotChartState.series.histogram) cotChartState.series.histogram.setData(formatted.histogram || []);
  if (cotChartState.series.nonCommNet) cotChartState.series.nonCommNet.setData(formatted.nonCommNet || []);
  if (cotChartState.series.commNet) cotChartState.series.commNet.setData(formatted.commNet || []);
  if (cotChartState.series.retailNet) cotChartState.series.retailNet.setData(formatted.retailNet || []);
  if (cotChartState.series.openInterest) cotChartState.series.openInterest.setData(formatted.openInterest || []);

  const lastHistogramPoint = formatted.histogram && formatted.histogram.length > 0
    ? formatted.histogram[formatted.histogram.length - 1]
    : null;
  lastRenderedCOTLastPointTime = lastHistogramPoint ? lastHistogramPoint.time : -1;

  applyCOTSeriesVisibility();

  // Update latest date badge using crosshair legend helper
  updateCOTLegendForCrosshair(lastCOTHoverTimestamp);

  // Align visible range immediately with main chart
  syncCOTTimeScaleWithMain();
}

function updateCOTChartDataForReplay(replayTimestamp, force = false) {
  if (!cotChartState.active || !cotChartState.chart) return;
  const activeMarket = cotChartState.market === "AUTO" ? getCOTMarketForSymbol(state.symbol) : cotChartState.market;
  const reportType = cotChartState.reportType || "combined";
  const maxSimTimestamp = cotChartState.blindMode && state.isBacktestActive ? replayTimestamp : null;
  const reports = getCOTDataForMarket(activeMarket, reportType, maxSimTimestamp);
  const activeCandles = getActiveCandlesForCOT();
  const lastCandle = activeCandles.length > 0 ? activeCandles[activeCandles.length - 1] : null;
  const lastCandleTime = lastCandle ? Number(lastCandle.time) : -1;

  const shouldUpdate = force ||
    reports.length !== lastRenderedCOTReportCount ||
    activeMarket !== lastRenderedCOTMarket ||
    reportType !== lastRenderedCOTType ||
    activeCandles.length !== lastRenderedCandlesCount ||
    lastCandleTime !== lastRenderedLastCandleTime;

  if (shouldUpdate) {
    lastRenderedCOTReportCount = reports.length;
    lastRenderedCOTMarket = activeMarket;
    lastRenderedCOTType = reportType;
    lastRenderedCandlesCount = activeCandles.length;
    lastRenderedLastCandleTime = lastCandleTime;

    const formatted = formatCOTSeriesData(reports, activeCandles);

    if (cotChartState.series.histogram) cotChartState.series.histogram.setData(formatted.histogram || []);
    if (cotChartState.series.nonCommNet) cotChartState.series.nonCommNet.setData(formatted.nonCommNet || []);
    if (cotChartState.series.commNet) cotChartState.series.commNet.setData(formatted.commNet || []);
    if (cotChartState.series.retailNet) cotChartState.series.retailNet.setData(formatted.retailNet || []);
    if (cotChartState.series.openInterest) cotChartState.series.openInterest.setData(formatted.openInterest || []);

    const lastPoint = formatted.histogram && formatted.histogram.length > 0 ? formatted.histogram[formatted.histogram.length - 1] : null;
    lastRenderedCOTLastPointTime = lastPoint ? lastPoint.time : -1;

    updateCOTLegendForCrosshair(lastCOTHoverTimestamp);
  }
}
window.updateCOTChartDataForReplay = updateCOTChartDataForReplay;
window.updateCOTChartData = updateCOTChartData;

function applyCOTSeriesVisibility() {
  if (!cotChartState.chart) return;
  const v = cotChartState.visibles;
  if (cotChartState.series.histogram) cotChartState.series.histogram.applyOptions({ visible: v.nonComm });
  if (cotChartState.series.nonCommNet) cotChartState.series.nonCommNet.applyOptions({ visible: v.nonComm });
  if (cotChartState.series.commNet) cotChartState.series.commNet.applyOptions({ visible: v.comm });
  if (cotChartState.series.retailNet) cotChartState.series.retailNet.applyOptions({ visible: v.retail });
  if (cotChartState.series.openInterest) cotChartState.series.openInterest.applyOptions({ visible: v.oi });
  updateCOTLegendForCrosshair(lastCOTHoverTimestamp);
}

if (typeof cotSyncEngine !== "undefined" && cotSyncEngine) {
  cotSyncEngine.onNewReport((updateInfo) => {
    console.log(`[COT Auto-Sync Notification] New report available: ${updateInfo.newReportDate}. Updating indicator and showing toast...`);
    
    // 1. If COT indicator is currently active/open on screen, update it live
    if (typeof cotChartState !== "undefined" && cotChartState.active && cotChartState.chart) {
      updateCOTChartData();
    }

    // 2. Show toast notification (subordinated to notification toggle isNotificationsEnabled)
    if (typeof showToast === "function") {
      showToast(`Вышел новый отчет CFTC COT (от ${updateInfo.newReportDate})`, "success");
    }
  });
}

let currentEditingFibIndex = null;
let currentEditingFibDraft = null;

function openFibSettingsModal(index) {
  if (!drawings.fibs || !drawings.fibs[index]) return;
  currentEditingFibIndex = index;
  currentEditingFibDraft = JSON.parse(JSON.stringify(drawings.fibs[index]));

  const modal = document.getElementById("modal-fib-settings");
  if (!modal) return;

  switchFibSettingsTab("style");
  populateFibSettingsUI(currentEditingFibDraft);
  modal.style.display = "flex";

  if (typeof lucide !== "undefined" && lucide.createIcons) {
    lucide.createIcons();
  }
}
window.openFibSettingsModal = openFibSettingsModal;

function closeFibSettingsModal() {
  const modal = document.getElementById("modal-fib-settings");
  if (modal) modal.style.display = "none";
  currentEditingFibIndex = null;
  currentEditingFibDraft = null;
}

function switchFibSettingsTab(tabName) {
  const tabStyleBtn = document.getElementById("fib-tab-btn-style");
  const tabLabelsBtn = document.getElementById("fib-tab-btn-labels");
  const contentStyle = document.getElementById("fib-tab-content-style");
  const contentLabels = document.getElementById("fib-tab-content-labels");

  if (tabName === "style") {
    if (tabStyleBtn) {
      tabStyleBtn.classList.add("active");
      tabStyleBtn.style.color = "#38bdf8";
      tabStyleBtn.style.borderBottomColor = "#38bdf8";
    }
    if (tabLabelsBtn) {
      tabLabelsBtn.classList.remove("active");
      tabLabelsBtn.style.color = "#94a3b8";
      tabLabelsBtn.style.borderBottomColor = "transparent";
    }
    if (contentStyle) contentStyle.style.display = "flex";
    if (contentLabels) contentLabels.style.display = "none";
  } else {
    if (tabLabelsBtn) {
      tabLabelsBtn.classList.add("active");
      tabLabelsBtn.style.color = "#38bdf8";
      tabLabelsBtn.style.borderBottomColor = "#38bdf8";
    }
    if (tabStyleBtn) {
      tabStyleBtn.classList.remove("active");
      tabStyleBtn.style.color = "#94a3b8";
      tabStyleBtn.style.borderBottomColor = "transparent";
    }
    if (contentLabels) contentLabels.style.display = "flex";
    if (contentStyle) contentStyle.style.display = "none";
  }
}

function renderFibLevelsGrid(levels) {
  const container = document.getElementById("fib-levels-table");
  if (!container) return;
  container.innerHTML = "";

  levels.forEach((lvl, idx) => {
    const row = document.createElement("div");
    row.style.cssText = "display: flex; align-items: center; justify-content: space-between; background: #0f172a; padding: 6px 8px; border-radius: 6px; border: 1px solid #334155; gap: 6px;";

    const leftGroup = document.createElement("div");
    leftGroup.style.cssText = "display: flex; align-items: center; gap: 6px; flex: 1;";

    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = lvl.enabled !== false;
    chk.style.cssText = "accent-color: #38bdf8; cursor: pointer;";
    chk.addEventListener("change", (e) => {
      lvl.enabled = e.target.checked;
    });

    const coeffInput = document.createElement("input");
    coeffInput.type = "number";
    coeffInput.step = "any";
    coeffInput.value = lvl.level;
    coeffInput.style.cssText = "width: 60px; height: 24px; background: #1e293b; border: 1px solid #475569; border-radius: 4px; color: #f8fafc; font-size: 11px; padding: 0 4px; font-weight: 600;";
    coeffInput.addEventListener("input", (e) => {
      const val = parseFloat(e.target.value);
      if (!isNaN(val)) lvl.level = val;
    });

    leftGroup.appendChild(chk);
    leftGroup.appendChild(coeffInput);

    const rightGroup = document.createElement("div");
    rightGroup.style.cssText = "display: flex; align-items: center; gap: 6px;";

    const colorPicker = document.createElement("input");
    colorPicker.type = "color";
    colorPicker.value = lvl.color || "#38bdf8";
    colorPicker.style.cssText = "width: 22px; height: 22px; border: none; border-radius: 4px; cursor: pointer; padding: 0; background: none;";
    colorPicker.addEventListener("input", (e) => {
      lvl.color = e.target.value;
    });

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.innerHTML = '<i data-lucide="trash-2" style="width: 12px; height: 12px;"></i>';
    delBtn.style.cssText = "background: none; border: none; color: #94a3b8; cursor: pointer; padding: 2px; border-radius: 4px; display: flex; align-items: center; justify-content: center;";
    delBtn.addEventListener("mouseenter", () => delBtn.style.color = "#ef4444");
    delBtn.addEventListener("mouseleave", () => delBtn.style.color = "#94a3b8");
    delBtn.addEventListener("click", () => {
      levels.splice(idx, 1);
      renderFibLevelsGrid(levels);
    });

    rightGroup.appendChild(colorPicker);
    rightGroup.appendChild(delBtn);

    row.appendChild(leftGroup);
    row.appendChild(rightGroup);
    container.appendChild(row);
  });

  if (typeof lucide !== "undefined" && lucide.createIcons) {
    lucide.createIcons();
  }
}

function populateFibSettingsUI(fib) {
  if (!fib) return;
  if (!Array.isArray(fib.levels)) {
    fib.levels = getDefaultFibLevels();
  }
  renderFibLevelsGrid(fib.levels);

  const reverseChk = document.getElementById("fib-cfg-reverse");
  if (reverseChk) reverseChk.checked = !!fib.reverse;

  const trendlineChk = document.getElementById("fib-cfg-trendline");
  if (trendlineChk) trendlineChk.checked = fib.showTrendline !== false;

  const extLeftChk = document.getElementById("fib-cfg-extend-left");
  if (extLeftChk) extLeftChk.checked = !!fib.extendLeft;

  const extRightChk = document.getElementById("fib-cfg-extend-right");
  if (extRightChk) extRightChk.checked = !!fib.extendRight;

  const lineStyleSel = document.getElementById("fib-cfg-line-style");
  if (lineStyleSel) lineStyleSel.value = fib.lineStyle || "solid";

  const lineWidthSel = document.getElementById("fib-cfg-line-width");
  if (lineWidthSel) lineWidthSel.value = String(fib.lineWidth || 1);

  const fillChk = document.getElementById("fib-cfg-fill");
  if (fillChk) fillChk.checked = fib.fillBackground !== false;

  const fillOpacityRange = document.getElementById("fib-cfg-fill-opacity");
  const fillOpacityLabel = document.getElementById("fib-fill-opacity-label");
  const opacityVal = typeof fib.backgroundOpacity === "number" ? Math.round(fib.backgroundOpacity * 100) : 8;
  if (fillOpacityRange) fillOpacityRange.value = opacityVal;
  if (fillOpacityLabel) fillOpacityLabel.textContent = `${opacityVal}%`;

  const labels = fib.labels || {};
  const lblCoeffChk = document.getElementById("fib-cfg-lbl-coeff");
  if (lblCoeffChk) lblCoeffChk.checked = labels.showCoeff !== false;

  const lblPctChk = document.getElementById("fib-cfg-lbl-percent");
  if (lblPctChk) lblPctChk.checked = !!labels.showPercent;

  const lblPricesChk = document.getElementById("fib-cfg-lbl-prices");
  if (lblPricesChk) lblPricesChk.checked = labels.showPrices !== false;

  const lblPtsChk = document.getElementById("fib-cfg-lbl-points");
  if (lblPtsChk) lblPtsChk.checked = labels.showPoints !== false && labels.showPips !== false;

  const lblHPosSel = document.getElementById("fib-cfg-lbl-hpos");
  if (lblHPosSel) lblHPosSel.value = labels.position || "left";

  const lblVPosSel = document.getElementById("fib-cfg-lbl-vpos");
  if (lblVPosSel) lblVPosSel.value = labels.verticalPosition || "above";

  const lblSizeSel = document.getElementById("fib-cfg-lbl-size");
  if (lblSizeSel) lblSizeSel.value = String(labels.fontSize || 11);
}

function initFibSettingsModalEvents() {
  const modal = document.getElementById("modal-fib-settings");
  const closeBtn = document.getElementById("fib-settings-close-btn");
  const cancelBtn = document.getElementById("fib-settings-cancel-btn");
  const saveBtn = document.getElementById("fib-settings-save-btn");
  const resetBtn = document.getElementById("fib-settings-reset-btn");
  const addLevelBtn = document.getElementById("fib-add-level-btn");

  const tabStyleBtn = document.getElementById("fib-tab-btn-style");
  const tabLabelsBtn = document.getElementById("fib-tab-btn-labels");

  if (tabStyleBtn) tabStyleBtn.addEventListener("click", () => switchFibSettingsTab("style"));
  if (tabLabelsBtn) tabLabelsBtn.addEventListener("click", () => switchFibSettingsTab("labels"));

  if (closeBtn) closeBtn.addEventListener("click", closeFibSettingsModal);
  if (cancelBtn) cancelBtn.addEventListener("click", closeFibSettingsModal);

  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeFibSettingsModal();
    });
  }

  const fillOpacityRange = document.getElementById("fib-cfg-fill-opacity");
  const fillOpacityLabel = document.getElementById("fib-fill-opacity-label");
  if (fillOpacityRange && fillOpacityLabel) {
    fillOpacityRange.addEventListener("input", (e) => {
      fillOpacityLabel.textContent = `${e.target.value}%`;
    });
  }

  if (addLevelBtn) {
    addLevelBtn.addEventListener("click", () => {
      if (!currentEditingFibDraft) return;
      if (!Array.isArray(currentEditingFibDraft.levels)) {
        currentEditingFibDraft.levels = getDefaultFibLevels();
      }
      currentEditingFibDraft.levels.push({
        level: 0.5,
        color: "#38bdf8",
        enabled: true,
      });
      renderFibLevelsGrid(currentEditingFibDraft.levels);
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      if (!currentEditingFibDraft) return;
      currentEditingFibDraft.levels = getDefaultFibLevels();
      currentEditingFibDraft.reverse = false;
      currentEditingFibDraft.showTrendline = true;
      currentEditingFibDraft.extendLeft = false;
      currentEditingFibDraft.extendRight = false;
      currentEditingFibDraft.lineStyle = "solid";
      currentEditingFibDraft.lineWidth = 1;
      currentEditingFibDraft.fillBackground = true;
      currentEditingFibDraft.backgroundOpacity = 0.08;
      currentEditingFibDraft.labels = {
        show: true,
        showCoeff: true,
        showPrices: true,
        showPercent: false,
        showPoints: true,
        showPips: true,
        position: "left",
        verticalPosition: "above",
        fontSize: 11,
      };
      populateFibSettingsUI(currentEditingFibDraft);
      showToast("Настройки сброшены к значениям по умолчанию", "info");
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      if (currentEditingFibIndex === null || !drawings.fibs || !drawings.fibs[currentEditingFibIndex]) {
        closeFibSettingsModal();
        return;
      }

      saveState();

      const reverseChk = document.getElementById("fib-cfg-reverse");
      const trendlineChk = document.getElementById("fib-cfg-trendline");
      const extLeftChk = document.getElementById("fib-cfg-extend-left");
      const extRightChk = document.getElementById("fib-cfg-extend-right");
      const lineStyleSel = document.getElementById("fib-cfg-line-style");
      const lineWidthSel = document.getElementById("fib-cfg-line-width");
      const fillChk = document.getElementById("fib-cfg-fill");
      const fillOpacityRange = document.getElementById("fib-cfg-fill-opacity");

      const lblCoeffChk = document.getElementById("fib-cfg-lbl-coeff");
      const lblPctChk = document.getElementById("fib-cfg-lbl-percent");
      const lblPricesChk = document.getElementById("fib-cfg-lbl-prices");
      const lblPtsChk = document.getElementById("fib-cfg-lbl-points");
      const lblHPosSel = document.getElementById("fib-cfg-lbl-hpos");
      const lblVPosSel = document.getElementById("fib-cfg-lbl-vpos");
      const lblSizeSel = document.getElementById("fib-cfg-lbl-size");

      const targetFib = drawings.fibs[currentEditingFibIndex];
      targetFib.levels = currentEditingFibDraft.levels || getDefaultFibLevels();
      targetFib.reverse = reverseChk ? reverseChk.checked : false;
      targetFib.showTrendline = trendlineChk ? trendlineChk.checked : true;
      targetFib.extendLeft = extLeftChk ? extLeftChk.checked : false;
      targetFib.extendRight = extRightChk ? extRightChk.checked : false;
      targetFib.lineStyle = lineStyleSel ? lineStyleSel.value : "solid";
      targetFib.lineWidth = lineWidthSel ? parseInt(lineWidthSel.value, 10) || 1 : 1;
      targetFib.fillBackground = fillChk ? fillChk.checked : true;
      targetFib.backgroundOpacity = fillOpacityRange ? parseInt(fillOpacityRange.value, 10) / 100 : 0.08;

      targetFib.labels = {
        show: true,
        showCoeff: lblCoeffChk ? lblCoeffChk.checked : true,
        showPercent: lblPctChk ? lblPctChk.checked : false,
        showPrices: lblPricesChk ? lblPricesChk.checked : true,
        showPoints: lblPtsChk ? lblPtsChk.checked : true,
        showPips: lblPtsChk ? lblPtsChk.checked : true,
        position: lblHPosSel ? lblHPosSel.value : "left",
        verticalPosition: lblVPosSel ? lblVPosSel.value : "above",
        fontSize: lblSizeSel ? parseInt(lblSizeSel.value, 10) || 11 : 11,
      };

      saveDrawings();
      drawAllOnCanvas();
      closeFibSettingsModal();
      showToast("Настройки Фибоначчи сохранены", "success");
    });
  }
}

// ==========================================
// SYMBOL SEARCH & BROKER INSTRUMENTS MODAL (TRADINGVIEW STYLE)
// ==========================================

let cachedSymbolsList = null;
let isLoadingSymbols = false;
let activeSymbolCategory = "all";
let highlightedSymbolIndex = -1;

// Currency / Asset SVG Flag & Badge Registry (Pixel-perfect vector circles matching TradingView)
const SVG_CIRCLE_FLAG_CACHE = new Map();
function getSvgCircleFlag(code) {
  const c = (code || "").toUpperCase().trim();
  if (SVG_CIRCLE_FLAG_CACHE.has(c)) {
    return SVG_CIRCLE_FLAG_CACHE.get(c);
  }
  
  let svg = "";
  switch (c) {
    case "EUR":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#003399"/>
        <g fill="#ffcc00" transform="translate(12, 12) scale(0.85)">
          <circle cx="0" cy="-8" r="1.1"/>
          <circle cx="4" cy="-6.9" r="1.1"/>
          <circle cx="6.9" cy="-4" r="1.1"/>
          <circle cx="8" cy="0" r="1.1"/>
          <circle cx="6.9" cy="4" r="1.1"/>
          <circle cx="4" cy="6.9" r="1.1"/>
          <circle cx="0" cy="8" r="1.1"/>
          <circle cx="-4" cy="6.9" r="1.1"/>
          <circle cx="-6.9" cy="4" r="1.1"/>
          <circle cx="-8" cy="0" r="1.1"/>
          <circle cx="-6.9" cy="-4" r="1.1"/>
          <circle cx="-4" cy="-6.9" r="1.1"/>
        </g>
      </svg>`;

    case "USD":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#b22234"/>
        <path d="M0 2.7h24v2.7H0zm0 5.4h24v2.7H0zm0 5.4h24v2.7H0zm0 5.4h24v2.7H0z" fill="#ffffff"/>
        <rect width="11" height="12" fill="#3c3b6e"/>
        <g fill="#ffffff" transform="scale(0.8) translate(1,1)">
          <circle cx="2.5" cy="2.5" r="0.9"/>
          <circle cx="6.5" cy="2.5" r="0.9"/>
          <circle cx="10.5" cy="2.5" r="0.9"/>
          <circle cx="4.5" cy="6" r="0.9"/>
          <circle cx="8.5" cy="6" r="0.9"/>
          <circle cx="2.5" cy="9.5" r="0.9"/>
          <circle cx="6.5" cy="9.5" r="0.9"/>
          <circle cx="10.5" cy="9.5" r="0.9"/>
          <circle cx="4.5" cy="13" r="0.9"/>
          <circle cx="8.5" cy="13" r="0.9"/>
        </g>
      </svg>`;

    case "GBP":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#012169"/>
        <path d="M0 0l24 24M24 0L0 24" stroke="#ffffff" stroke-width="4.5"/>
        <path d="M0 0l24 24M24 0L0 24" stroke="#c8102e" stroke-width="2"/>
        <path d="M12 0v24M0 12h24" stroke="#ffffff" stroke-width="6"/>
        <path d="M12 0v24M0 12h24" stroke="#c8102e" stroke-width="3.6"/>
      </svg>`;

    case "JPY":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#ffffff"/>
        <circle cx="12" cy="12" r="6" fill="#bc002d"/>
      </svg>`;

    case "CHF":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#d52b1e"/>
        <rect x="10" y="4.5" width="4" height="15" rx="0.5" fill="#ffffff"/>
        <rect x="4.5" y="10" width="15" height="4" rx="0.5" fill="#ffffff"/>
      </svg>`;

    case "AUD":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#00008b"/>
        <g transform="scale(0.5)">
          <rect width="24" height="24" fill="#012169"/>
          <path d="M0 0l24 24M24 0L0 24" stroke="#ffffff" stroke-width="4"/>
          <path d="M0 0l24 24M24 0L0 24" stroke="#c8102e" stroke-width="2"/>
          <path d="M12 0v24M0 12h24" stroke="#ffffff" stroke-width="5"/>
          <path d="M12 0v24M0 12h24" stroke="#c8102e" stroke-width="3"/>
        </g>
        <circle cx="6" cy="18" r="2.2" fill="#ffffff"/>
        <circle cx="17.5" cy="5" r="1.1" fill="#ffffff"/>
        <circle cx="19.5" cy="9.5" r="1.1" fill="#ffffff"/>
        <circle cx="15.5" cy="11.5" r="1.1" fill="#ffffff"/>
        <circle cx="17.5" cy="16.5" r="1.1" fill="#ffffff"/>
        <circle cx="18.5" cy="13" r="0.7" fill="#ffffff"/>
      </svg>`;

    case "CAD":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#ffffff"/>
        <rect width="6" height="24" fill="#d52b1e"/>
        <rect x="18" width="6" height="24" fill="#d52b1e"/>
        <path d="M12 4.5l1.2 3 2.8-.8-1.4 2.8 2.8 1.4-3.2 1.2.6 3.4-2.8-1.8v2.8h-.2v-2.8l-2.8 1.8.6-3.4-3.2-1.2 2.8-1.4-1.4-2.8 2.8.8z" fill="#d52b1e"/>
      </svg>`;

    case "NZD":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#00008b"/>
        <g transform="scale(0.5)">
          <rect width="24" height="24" fill="#012169"/>
          <path d="M0 0l24 24M24 0L0 24" stroke="#ffffff" stroke-width="4"/>
          <path d="M0 0l24 24M24 0L0 24" stroke="#c8102e" stroke-width="2"/>
          <path d="M12 0v24M0 12h24" stroke="#ffffff" stroke-width="5"/>
          <path d="M12 0v24M0 12h24" stroke="#c8102e" stroke-width="3"/>
        </g>
        <circle cx="18" cy="5" r="1.3" fill="#c8102e" stroke="#ffffff" stroke-width="0.6"/>
        <circle cx="20" cy="11" r="1.3" fill="#c8102e" stroke="#ffffff" stroke-width="0.6"/>
        <circle cx="15.5" cy="13" r="1.3" fill="#c8102e" stroke="#ffffff" stroke-width="0.6"/>
        <circle cx="17.5" cy="18" r="1.4" fill="#c8102e" stroke="#ffffff" stroke-width="0.6"/>
      </svg>`;

    case "CNY":
    case "CNH":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#de2910"/>
        <polygon points="6,3.5 7.2,7.2 11.2,7.2 8,9.5 9.2,13.2 6,10.9 2.8,13.2 4,9.5 0.8,7.2 4.8,7.2" fill="#ffde00" transform="translate(1,0) scale(0.6)"/>
        <polygon points="12,2 12.5,3.5 14,3.5 12.8,4.5 13.2,6 12,5 10.8,6 11.2,4.5 10,3.5 11.5,3.5" fill="#ffde00" transform="scale(0.5)"/>
        <polygon points="15,5 15.5,6.5 17,6.5 15.8,7.5 16.2,9 15,8 13.8,9 14.2,7.5 13,6.5 14.5,6.5" fill="#ffde00" transform="scale(0.5)"/>
        <polygon points="15,10 15.5,11.5 17,11.5 15.8,12.5 16.2,14 15,13 13.8,14 14.2,12.5 13,11.5 14.5,11.5" fill="#ffde00" transform="scale(0.5)"/>
        <polygon points="12,14 12.5,15.5 14,15.5 12.8,16.5 13.2,18 12,17 10.8,18 11.2,16.5 10,15.5 11.5,15.5" fill="#ffde00" transform="scale(0.5)"/>
      </svg>`;

    case "HKD":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#c21a22"/>
        <circle cx="12" cy="12" r="5" fill="none" stroke="#ffffff" stroke-width="2"/>
        <circle cx="12" cy="12" r="2.5" fill="#ffffff"/>
      </svg>`;

    case "SGD":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="12" fill="#ed2939"/>
        <rect y="12" width="24" height="12" fill="#ffffff"/>
        <path d="M6 3a4 4 0 1 0 0 6 4.5 4.5 0 0 1 0-6z" fill="#ffffff"/>
        <circle cx="8.5" cy="4.5" r="0.6" fill="#ffffff"/>
        <circle cx="10" cy="5.5" r="0.6" fill="#ffffff"/>
        <circle cx="9.5" cy="7" r="0.6" fill="#ffffff"/>
        <circle cx="8" cy="7.5" r="0.6" fill="#ffffff"/>
        <circle cx="7.5" cy="6" r="0.6" fill="#ffffff"/>
      </svg>`;

    case "SEK":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#006aa7"/>
        <rect x="7" width="3.5" height="24" fill="#fecc00"/>
        <rect y="10" width="24" height="3.5" fill="#fecc00"/>
      </svg>`;

    case "NOK":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#ba0c2f"/>
        <rect x="6" width="5" height="24" fill="#ffffff"/>
        <rect y="9.5" width="24" height="5" fill="#ffffff"/>
        <rect x="7.2" width="2.6" height="24" fill="#00205b"/>
        <rect y="10.7" width="24" height="2.6" fill="#00205b"/>
      </svg>`;

    case "DKK":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#c60c30"/>
        <rect x="7" width="3" height="24" fill="#ffffff"/>
        <rect y="10.5" width="24" height="3" fill="#ffffff"/>
      </svg>`;

    case "PLN":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="12" fill="#ffffff"/>
        <rect y="12" width="24" height="12" fill="#dc143c"/>
      </svg>`;

    case "CZK":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="12" fill="#ffffff"/>
        <rect y="12" width="24" height="12" fill="#d7141a"/>
        <polygon points="0,0 12,12 0,24" fill="#11457e"/>
      </svg>`;

    case "HUF":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="8" fill="#ce2939"/>
        <rect y="8" width="24" height="8" fill="#ffffff"/>
        <rect y="16" width="24" height="8" fill="#477050"/>
      </svg>`;

    case "TRY":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#e30a17"/>
        <path d="M11 6a6 6 0 1 0 0 12 5 5 0 0 1 0-12z" fill="#ffffff"/>
        <polygon points="14.5,10.5 15,11.5 16.5,11.5 15.3,12.3 15.7,13.5 14.5,12.8 13.3,13.5 13.7,12.3 12.5,11.5 14,11.5" fill="#ffffff"/>
      </svg>`;

    case "ZAR":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="12" fill="#e03c31"/>
        <rect y="12" width="24" height="12" fill="#001489"/>
        <polygon points="0,0 10,12 0,24" fill="#000000"/>
        <polyline points="0,0 10,12 0,24" fill="none" stroke="#ffb81c" stroke-width="2.5"/>
        <path d="M0 0h6l9 8h9v8h-9l-9 8H0" fill="#007749"/>
        <path d="M0 0h4l9 9h11v6h-11l-9 9H0" fill="none" stroke="#ffffff" stroke-width="1"/>
      </svg>`;

    case "MXN":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="8" height="24" fill="#006847"/>
        <rect x="8" width="8" height="24" fill="#ffffff"/>
        <rect x="16" width="8" height="24" fill="#ce1126"/>
        <circle cx="12" cy="12" r="2.5" fill="#8b5a2b"/>
      </svg>`;

    case "BRL":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#009c3b"/>
        <polygon points="12,3 21.5,12 12,21 2.5,12" fill="#ffdf00"/>
        <circle cx="12" cy="12" r="4.5" fill="#002776"/>
        <path d="M8 12.5a5 5 0 0 1 8-1" fill="none" stroke="#ffffff" stroke-width="0.8"/>
      </svg>`;

    case "INR":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="8" fill="#ff9933"/>
        <rect y="8" width="24" height="8" fill="#ffffff"/>
        <rect y="16" width="24" height="8" fill="#138808"/>
        <circle cx="12" cy="12" r="3" fill="none" stroke="#000080" stroke-width="0.8"/>
        <circle cx="12" cy="12" r="1" fill="#000080"/>
      </svg>`;

    case "RUB":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="8" fill="#ffffff"/>
        <rect y="8" width="24" height="8" fill="#0039a6"/>
        <rect y="16" width="24" height="8" fill="#d52b1e"/>
      </svg>`;

    case "KRW":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#ffffff"/>
        <circle cx="12" cy="12" r="5" fill="#cd2e3a"/>
        <path d="M12 7a5 5 0 0 1 0 10 2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 0 0-5z" fill="#0047a0"/>
      </svg>`;

    case "ILS":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#ffffff"/>
        <rect y="3" width="24" height="3" fill="#0038b8"/>
        <rect y="18" width="24" height="3" fill="#0038b8"/>
        <polygon points="12,7 16,14 8,14" fill="none" stroke="#0038b8" stroke-width="0.9"/>
        <polygon points="12,16 16,9 8,9" fill="none" stroke="#0038b8" stroke-width="0.9"/>
      </svg>`;

    case "THB":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="4" fill="#ed1c24"/>
        <rect y="4" width="24" height="3.5" fill="#ffffff"/>
        <rect y="7.5" width="24" height="9" fill="#241d4f"/>
        <rect y="16.5" width="24" height="3.5" fill="#ffffff"/>
        <rect y="20" width="24" height="4" fill="#ed1c24"/>
      </svg>`;

    case "AED":
    case "SAR":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#007a3d"/>
        <rect y="16" width="24" height="8" fill="#000000"/>
        <rect y="8" width="24" height="8" fill="#ffffff"/>
        <rect width="6" height="24" fill="#ff0000"/>
      </svg>`;

    // --- METALS & COMMODITIES ---
    case "XAU":
    case "GOLD":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <radialGradient id="goldGrad" cx="35%" cy="35%" r="65%">
          <stop offset="0%" stop-color="#fef08a"/>
          <stop offset="50%" stop-color="#eab308"/>
          <stop offset="100%" stop-color="#854d0e"/>
        </radialGradient>
        <rect width="24" height="24" fill="url(#goldGrad)"/>
        <circle cx="12" cy="12" r="9" fill="none" stroke="#fef9c3" stroke-width="0.8" opacity="0.6"/>
        <text x="12" y="15.5" font-family="'Inter', sans-serif" font-weight="900" font-size="9" fill="#451a03" text-anchor="middle">Au</text>
      </svg>`;

    case "XAG":
    case "SILVER":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <radialGradient id="silvGrad" cx="35%" cy="35%" r="65%">
          <stop offset="0%" stop-color="#f8fafc"/>
          <stop offset="50%" stop-color="#94a3b8"/>
          <stop offset="100%" stop-color="#475569"/>
        </radialGradient>
        <rect width="24" height="24" fill="url(#silvGrad)"/>
        <circle cx="12" cy="12" r="9" fill="none" stroke="#ffffff" stroke-width="0.8" opacity="0.6"/>
        <text x="12" y="15.5" font-family="'Inter', sans-serif" font-weight="900" font-size="9" fill="#0f172a" text-anchor="middle">Ag</text>
      </svg>`;

    case "XPT":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <radialGradient id="ptGrad" cx="35%" cy="35%" r="65%">
          <stop offset="0%" stop-color="#e0f2fe"/>
          <stop offset="50%" stop-color="#38bdf8"/>
          <stop offset="100%" stop-color="#0369a1"/>
        </radialGradient>
        <rect width="24" height="24" fill="url(#ptGrad)"/>
        <text x="12" y="15.5" font-family="'Inter', sans-serif" font-weight="900" font-size="9" fill="#082f49" text-anchor="middle">Pt</text>
      </svg>`;

    case "XPD":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <radialGradient id="pdGrad" cx="35%" cy="35%" r="65%">
          <stop offset="0%" stop-color="#f1f5f9"/>
          <stop offset="50%" stop-color="#64748b"/>
          <stop offset="100%" stop-color="#334155"/>
        </radialGradient>
        <rect width="24" height="24" fill="url(#pdGrad)"/>
        <text x="12" y="15.5" font-family="'Inter', sans-serif" font-weight="900" font-size="9" fill="#ffffff" text-anchor="middle">Pd</text>
      </svg>`;

    case "USOIL":
    case "UKOIL":
    case "WTI":
    case "BRENT":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#0f172a"/>
        <path d="M12 4c-3 5-5 8-5 11a5 5 0 0 0 10 0c0-3-2-6-5-11z" fill="#ea580c"/>
        <path d="M12 9c-1.5 2.5-2.5 4-2.5 5.5a2.5 2.5 0 0 0 5 0c0-1.5-1-3-2.5-5.5z" fill="#facc15"/>
      </svg>`;

    case "NGAS":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#0c4a6e"/>
        <path d="M12 4c-3 5-5 8-5 11a5 5 0 0 0 10 0c0-3-2-6-5-11z" fill="#38bdf8"/>
        <path d="M12 9c-1.5 2.5-2.5 4-2.5 5.5a2.5 2.5 0 0 0 5 0c0-1.5-1-3-2.5-5.5z" fill="#ffffff"/>
      </svg>`;

    // --- INDICES ---
    case "US500":
    case "SPX":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#1e3a8a"/>
        <circle cx="12" cy="12" r="9" fill="none" stroke="#60a5fa" stroke-width="0.8"/>
        <text x="12" y="15" font-family="'Inter', sans-serif" font-weight="900" font-size="8" fill="#ffffff" text-anchor="middle">500</text>
      </svg>`;

    case "US100":
    case "NDX":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#0284c7"/>
        <circle cx="12" cy="12" r="9" fill="none" stroke="#bae6fd" stroke-width="0.8"/>
        <text x="12" y="15" font-family="'Inter', sans-serif" font-weight="900" font-size="8" fill="#ffffff" text-anchor="middle">100</text>
      </svg>`;

    case "US30":
    case "DJI":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#0f172a"/>
        <circle cx="12" cy="12" r="9" fill="none" stroke="#38bdf8" stroke-width="0.8"/>
        <text x="12" y="15" font-family="'Inter', sans-serif" font-weight="900" font-size="8" fill="#38bdf8" text-anchor="middle">30</text>
      </svg>`;

    case "DE40":
    case "DAX":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="8" fill="#000000"/>
        <rect y="8" width="24" height="8" fill="#dd0000"/>
        <rect y="16" width="24" height="8" fill="#ffce00"/>
      </svg>`;

    case "UK100":
    case "FTSE":
      return getSvgCircleFlag("GBP");

    case "JP225":
    case "N225":
      svg = getSvgCircleFlag("JPY");
      break;

    // --- ADDITIONAL FOREX CURRENCIES ---
    case "RON":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="8" height="24" fill="#002b7f"/>
        <rect x="8" width="8" height="24" fill="#fcd116"/>
        <rect x="16" width="8" height="24" fill="#ce1126"/>
      </svg>`;

    case "CLP":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="12" fill="#ffffff"/>
        <rect y="12" width="24" height="12" fill="#d52b1e"/>
        <rect width="10" height="12" fill="#0039a6"/>
        <polygon points="5,3 5.8,5.2 8.2,5.2 6.2,6.7 7,9 5,7.5 3,9 3.8,6.7 1.8,5.2 4.2,5.2" fill="#ffffff" transform="translate(1, 0.5) scale(0.8)"/>
      </svg>`;

    case "COP":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="12" fill="#fcd116"/>
        <rect y="12" width="24" height="6" fill="#003893"/>
        <rect y="18" width="24" height="6" fill="#ce1126"/>
      </svg>`;

    case "PEN":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="8" height="24" fill="#d91023"/>
        <rect x="8" width="8" height="24" fill="#ffffff"/>
        <rect x="16" width="8" height="24" fill="#d91023"/>
      </svg>`;

    case "IDR":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="12" fill="#ce1126"/>
        <rect y="12" width="24" height="12" fill="#ffffff"/>
      </svg>`;

    case "MYR":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#cc0000"/>
        <path d="M0 3.4h24v3.4H0zm0 6.8h24v3.4H0zm0 6.8h24v3.4H0z" fill="#ffffff"/>
        <rect width="12" height="13.6" fill="#000066"/>
        <circle cx="5.5" cy="6.8" r="4" fill="#ffcc00"/>
        <circle cx="6.5" cy="6.8" r="3.4" fill="#000066"/>
      </svg>`;

    case "PHP":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="12" fill="#0038a8"/>
        <rect y="12" width="24" height="12" fill="#ce1126"/>
        <polygon points="0,0 12,12 0,24" fill="#ffffff"/>
        <circle cx="4" cy="12" r="2" fill="#fcd116"/>
      </svg>`;

    case "TWD":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#fe0000"/>
        <rect width="12" height="12" fill="#000095"/>
        <circle cx="6" cy="6" r="3" fill="#ffffff"/>
      </svg>`;

    case "KWD":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="8" fill="#007a3d"/>
        <rect y="8" width="24" height="8" fill="#ffffff"/>
        <rect y="16" width="24" height="8" fill="#ce1126"/>
        <polygon points="0,0 7,8 7,16 0,24" fill="#000000"/>
      </svg>`;

    case "QAR":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#8d1b3d"/>
        <polygon points="0,0 7,0 8.5,3 7,6 8.5,9 7,12 8.5,15 7,18 8.5,21 7,24 0,24" fill="#ffffff"/>
      </svg>`;

    case "BGN":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="8" fill="#ffffff"/>
        <rect y="8" width="24" height="8" fill="#00966e"/>
        <rect y="16" width="24" height="8" fill="#d62612"/>
      </svg>`;

    case "ISK":
      return `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#02529c"/>
        <rect x="6" width="4.5" height="24" fill="#ffffff"/>
        <rect y="9.75" width="24" height="4.5" fill="#ffffff"/>
        <rect x="7.2" width="2.1" height="24" fill="#dc1e35"/>
        <rect y="10.95" width="24" height="2.1" fill="#dc1e35"/>
      </svg>`;

    default:
      svg = `<svg viewBox="0 0 24 24" width="100%" height="100%" style="display:block;">
        <rect width="24" height="24" fill="#1e293b"/>
        <circle cx="12" cy="12" r="9" fill="none" stroke="#475569" stroke-width="1"/>
        <text x="12" y="15.5" font-family="'Inter', sans-serif" font-weight="700" font-size="9" fill="#94a3b8" text-anchor="middle">${c.substring(0, 2)}</text>
      </svg>`;
      break;
  }

  SVG_CIRCLE_FLAG_CACHE.set(c, svg);
  return svg;
}

// Known currency codes (Expanded for all Forex pairs)
const KNOWN_CURRENCIES = new Set([
  "USD", "EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "NZD", "CNY", "CNH",
  "HKD", "SGD", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "TRY", "ZAR",
  "MXN", "BRL", "INR", "KRW", "ILS", "RUB", "THB", "AED", "SAR",
  "RON", "CLP", "COP", "PEN", "IDR", "MYR", "PHP", "TWD", "KWD", "QAR", "BGN", "ISK"
]);

// Metals prefixes
const METALS_PREFIXES = ["XAU", "XAG", "XPT", "XPD", "GOLD", "SILVER", "PLATINUM", "PALLADIUM"];

// Helper functions to strictly allow only Forex and Metals
function isMetalSymbol(symbolName, category) {
  const clean = (symbolName || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const cat = (category || "").toLowerCase();
  if (cat.includes("metal") || cat.includes("металл") || cat.includes("gold") || cat.includes("silver") || cat.includes("precious")) return true;
  for (const p of METALS_PREFIXES) {
    if (clean.startsWith(p)) return true;
  }
  return false;
}

function isForexSymbol(symbolName, category) {
  if (isMetalSymbol(symbolName, category)) return false;
  const clean = (symbolName || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const cat = (category || "").toLowerCase();
  
  // Exclude banned asset categories (Indices, Commodities, Stocks, Crypto)
  if (cat.includes("crypto") || cat.includes("крипто") || cat.includes("index") || cat.includes("индекс") ||
      cat.includes("stock") || cat.includes("share") || cat.includes("акци") || cat.includes("commodity") ||
      cat.includes("сырь") || cat.includes("товар") || cat.includes("oil") || cat.includes("gas") ||
      cat.includes("brent") || cat.includes("wti")) {
    return false;
  }

  // Check if 2 valid 3-letter currency codes
  if (clean.length >= 6) {
    const base = clean.substring(0, 3);
    const quote = clean.substring(3, 6);
    if (KNOWN_CURRENCIES.has(base) && KNOWN_CURRENCIES.has(quote)) {
      return true;
    }
  }

  if (cat.includes("forex") || cat.includes("fx") || cat.includes("currency") || cat.includes("currencies") || cat.includes("валют")) {
    return true;
  }

  return false;
}

function isForexOrMetalSymbol(symbolName, category) {
  return isMetalSymbol(symbolName, category) || isForexSymbol(symbolName, category);
}

function normalizeForexOrMetalCategory(symbolName, category) {
  return isMetalSymbol(symbolName, category) ? "Metals" : "Forex";
}

// Backward compatibility helper
function isCryptoSymbol(symbolName, category) {
  return !isForexOrMetalSymbol(symbolName, category);
}

// Cache for visual leading badges
const SYMBOL_VISUAL_LEADING_CACHE = new Map();

// Helper to render TradingView overlapping circular flags or single round asset badge
function getSymbolVisualLeading(symbolItem) {
  const name = (symbolItem && symbolItem.name ? symbolItem.name : "").toUpperCase();
  if (SYMBOL_VISUAL_LEADING_CACHE.has(name)) {
    return SYMBOL_VISUAL_LEADING_CACHE.get(name);
  }

  const clean = name.replace(/[^A-Z0-9]/g, "");
  let res = "";

  // Check if it's a 6+ character Forex pair or Metal pair (e.g. EURUSD, GBPJPY, XAUUSD, XAUEUR)
  if (clean.length >= 6) {
    const base = clean.substring(0, 3);
    const quote = clean.substring(3, 6);
    const isMetalBase = (base === "XAU" || base === "XAG" || base === "XPT" || base === "XPD");

    if ((KNOWN_CURRENCIES.has(base) || isMetalBase) && KNOWN_CURRENCIES.has(quote)) {
      // TradingView overlapping 2-circle badge (dia: 17px, bottom-left + top-right with dark cutout border)
      res = `
        <div class="tv-symbol-flag-pair" style="position: relative; width: 28px; height: 22px; flex-shrink: 0; display: inline-block; vertical-align: middle;">
          <!-- Base Asset / Metal Flag (Bottom Left) -->
          <div style="position: absolute; left: 0; bottom: 0; width: 17px; height: 17px; border-radius: 50%; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.5); z-index: 1;">
            ${getSvgCircleFlag(base)}
          </div>
          <!-- Quote Currency Flag (Top Right Overlap) -->
          <div style="position: absolute; left: 10px; top: 0; width: 17px; height: 17px; border-radius: 50%; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.5); border: 1.5px solid #0b101d; box-sizing: content-box; z-index: 2;">
            ${getSvgCircleFlag(quote)}
          </div>
        </div>
      `;
      SYMBOL_VISUAL_LEADING_CACHE.set(name, res);
      return res;
    }
  }

  // Single asset badge (Metals single or single currency)
  let primaryCode = clean;
  if (clean.startsWith("XAU") || clean.includes("GOLD")) primaryCode = "XAU";
  else if (clean.startsWith("XAG") || clean.includes("SILVER")) primaryCode = "XAG";
  else if (clean.startsWith("XPT")) primaryCode = "XPT";
  else if (clean.startsWith("XPD")) primaryCode = "XPD";
  else if (clean.length >= 3 && KNOWN_CURRENCIES.has(clean.substring(0, 3))) primaryCode = clean.substring(0, 3);

  res = `
    <div class="tv-symbol-single-badge" style="position: relative; width: 28px; height: 22px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;">
      <div style="width: 20px; height: 20px; border-radius: 50%; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.5);">
        ${getSvgCircleFlag(primaryCode)}
      </div>
    </div>
  `;
  SYMBOL_VISUAL_LEADING_CACHE.set(name, res);
  return res;
}

let cachedFavSet = null;

function getFavoriteSymbols() {
  try {
    const raw = localStorage.getItem("favorite_symbols");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const filtered = parsed
          .map(s => String(s).replace(/[^A-Za-z0-9]/g, "").toUpperCase())
          .filter(s => isForexOrMetalSymbol(s, ""));
        const res = filtered.length > 0 ? filtered : ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "XAUUSD"];
        cachedFavSet = new Set(res);
        return res;
      }
    }
  } catch (e) {
    console.error("Error reading favorite_symbols:", e);
  }
  const fallback = ["EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "XAUUSD"];
  cachedFavSet = new Set(fallback);
  return fallback;
}

function getFavoriteSymbolsSet() {
  if (!cachedFavSet) {
    getFavoriteSymbols();
  }
  return cachedFavSet;
}

function saveFavoriteSymbols(favs) {
  try {
    const sanitized = (favs || []).filter(s => isForexOrMetalSymbol(s, ""));
    localStorage.setItem("favorite_symbols", JSON.stringify(sanitized));
    cachedFavSet = new Set(sanitized.map(s => String(s).replace(/[^A-Za-z0-9]/g, "").toUpperCase()));
  } catch (e) {
    console.error("Error saving favorite_symbols:", e);
  }
}

function isSymbolFavorite(symbolName) {
  const clean = (symbolName || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  return getFavoriteSymbolsSet().has(clean);
}

function toggleSymbolFavorite(symbolName, e) {
  if (e) {
    e.stopPropagation();
    e.preventDefault();
  }
  const clean = (symbolName || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  if (!isForexOrMetalSymbol(clean, "")) return;
  let favs = getFavoriteSymbols();
  if (favs.includes(clean)) {
    favs = favs.filter(s => s !== clean);
  } else {
    favs.push(clean);
  }
  saveFavoriteSymbols(favs);
  renderSymbolsList(false);
}

function getDefaultSymbolsList() {
  return [
    // --- FOREX: MAJORS ---
    { name: "EURUSD", description: "Euro vs US Dollar", category: "Forex" },
    { name: "GBPUSD", description: "Great Britain Pound vs US Dollar", category: "Forex" },
    { name: "USDJPY", description: "US Dollar vs Japanese Yen", category: "Forex" },
    { name: "AUDUSD", description: "Australian Dollar vs US Dollar", category: "Forex" },
    { name: "USDCAD", description: "US Dollar vs Canadian Dollar", category: "Forex" },
    { name: "USDCHF", description: "US Dollar vs Swiss Franc", category: "Forex" },
    { name: "NZDUSD", description: "New Zealand Dollar vs US Dollar", category: "Forex" },

    // --- FOREX: EUR CROSSES ---
    { name: "EURGBP", description: "Euro vs Great Britain Pound", category: "Forex" },
    { name: "EURJPY", description: "Euro vs Japanese Yen", category: "Forex" },
    { name: "EURCHF", description: "Euro vs Swiss Franc", category: "Forex" },
    { name: "EURCAD", description: "Euro vs Canadian Dollar", category: "Forex" },
    { name: "EURAUD", description: "Euro vs Australian Dollar", category: "Forex" },
    { name: "EURNZD", description: "Euro vs New Zealand Dollar", category: "Forex" },
    { name: "EURSEK", description: "Euro vs Swedish Krona", category: "Forex" },
    { name: "EURNOK", description: "Euro vs Norwegian Krone", category: "Forex" },
    { name: "EURDKK", description: "Euro vs Danish Krone", category: "Forex" },
    { name: "EURPLN", description: "Euro vs Polish Zloty", category: "Forex" },
    { name: "EURHUF", description: "Euro vs Hungarian Forint", category: "Forex" },
    { name: "EURCZK", description: "Euro vs Czech Koruna", category: "Forex" },
    { name: "EURTRY", description: "Euro vs Turkish Lira", category: "Forex" },
    { name: "EURZAR", description: "Euro vs South African Rand", category: "Forex" },
    { name: "EURMXN", description: "Euro vs Mexican Peso", category: "Forex" },
    { name: "EURSGD", description: "Euro vs Singapore Dollar", category: "Forex" },
    { name: "EURHKD", description: "Euro vs Hong Kong Dollar", category: "Forex" },
    { name: "EURCNH", description: "Euro vs Chinese Yuan (Offshore)", category: "Forex" },
    { name: "EURILS", description: "Euro vs Israeli Shekel", category: "Forex" },
    { name: "EURRON", description: "Euro vs Romanian Leu", category: "Forex" },
    { name: "EURRUB", description: "Euro vs Russian Ruble", category: "Forex" },

    // --- FOREX: GBP CROSSES ---
    { name: "GBPJPY", description: "Great Britain Pound vs Japanese Yen", category: "Forex" },
    { name: "GBPCHF", description: "Great Britain Pound vs Swiss Franc", category: "Forex" },
    { name: "GBPCAD", description: "Great Britain Pound vs Canadian Dollar", category: "Forex" },
    { name: "GBPAUD", description: "Great Britain Pound vs Australian Dollar", category: "Forex" },
    { name: "GBPNZD", description: "Great Britain Pound vs New Zealand Dollar", category: "Forex" },
    { name: "GBPSEK", description: "Great Britain Pound vs Swedish Krona", category: "Forex" },
    { name: "GBPNOK", description: "Great Britain Pound vs Norwegian Krone", category: "Forex" },
    { name: "GBPDKK", description: "Great Britain Pound vs Danish Krone", category: "Forex" },
    { name: "GBPPLN", description: "Great Britain Pound vs Polish Zloty", category: "Forex" },
    { name: "GBPHUF", description: "Great Britain Pound vs Hungarian Forint", category: "Forex" },
    { name: "GBPCZK", description: "Great Britain Pound vs Czech Koruna", category: "Forex" },
    { name: "GBPTRY", description: "Great Britain Pound vs Turkish Lira", category: "Forex" },
    { name: "GBPZAR", description: "Great Britain Pound vs South African Rand", category: "Forex" },
    { name: "GBPMXN", description: "Great Britain Pound vs Mexican Peso", category: "Forex" },
    { name: "GBPSGD", description: "Great Britain Pound vs Singapore Dollar", category: "Forex" },

    // --- FOREX: AUD & NZD CROSSES ---
    { name: "AUDJPY", description: "Australian Dollar vs Japanese Yen", category: "Forex" },
    { name: "AUDCAD", description: "Australian Dollar vs Canadian Dollar", category: "Forex" },
    { name: "AUDCHF", description: "Australian Dollar vs Swiss Franc", category: "Forex" },
    { name: "AUDNZD", description: "Australian Dollar vs New Zealand Dollar", category: "Forex" },
    { name: "AUDSGD", description: "Australian Dollar vs Singapore Dollar", category: "Forex" },
    { name: "AUDHKD", description: "Australian Dollar vs Hong Kong Dollar", category: "Forex" },
    { name: "AUDZAR", description: "Australian Dollar vs South African Rand", category: "Forex" },
    { name: "AUDNOK", description: "Australian Dollar vs Norwegian Krone", category: "Forex" },
    { name: "AUDSEK", description: "Australian Dollar vs Swedish Krona", category: "Forex" },
    { name: "NZDJPY", description: "New Zealand Dollar vs Japanese Yen", category: "Forex" },
    { name: "NZDCAD", description: "New Zealand Dollar vs Canadian Dollar", category: "Forex" },
    { name: "NZDCHF", description: "New Zealand Dollar vs Swiss Franc", category: "Forex" },
    { name: "NZDSGD", description: "New Zealand Dollar vs Singapore Dollar", category: "Forex" },

    // --- FOREX: CAD & CHF CROSSES ---
    { name: "CADJPY", description: "Canadian Dollar vs Japanese Yen", category: "Forex" },
    { name: "CADCHF", description: "Canadian Dollar vs Swiss Franc", category: "Forex" },
    { name: "CADNOK", description: "Canadian Dollar vs Norwegian Krone", category: "Forex" },
    { name: "CHFJPY", description: "Swiss Franc vs Japanese Yen", category: "Forex" },
    { name: "CHFNOK", description: "Swiss Franc vs Norwegian Krone", category: "Forex" },
    { name: "CHFPLN", description: "Swiss Franc vs Polish Zloty", category: "Forex" },
    { name: "CHFHUF", description: "Swiss Franc vs Hungarian Forint", category: "Forex" },
    { name: "CHFSEK", description: "Swiss Franc vs Swedish Krona", category: "Forex" },

    // --- FOREX: JPY CROSSES ---
    { name: "SGDJPY", description: "Singapore Dollar vs Japanese Yen", category: "Forex" },
    { name: "ZARJPY", description: "South African Rand vs Japanese Yen", category: "Forex" },
    { name: "TRYJPY", description: "Turkish Lira vs Japanese Yen", category: "Forex" },
    { name: "CNHJPY", description: "Chinese Yuan vs Japanese Yen", category: "Forex" },
    { name: "MXNJPY", description: "Mexican Peso vs Japanese Yen", category: "Forex" },
    { name: "NOKJPY", description: "Norwegian Krone vs Japanese Yen", category: "Forex" },
    { name: "SEKJPY", description: "Swedish Krona vs Japanese Yen", category: "Forex" },

    // --- FOREX: USD EXOTICS & EMERGING MARKETS ---
    { name: "USDSEK", description: "US Dollar vs Swedish Krona", category: "Forex" },
    { name: "USDNOK", description: "US Dollar vs Norwegian Krone", category: "Forex" },
    { name: "USDDKK", description: "US Dollar vs Danish Krone", category: "Forex" },
    { name: "USDPLN", description: "US Dollar vs Polish Zloty", category: "Forex" },
    { name: "USDHUF", description: "US Dollar vs Hungarian Forint", category: "Forex" },
    { name: "USDCZK", description: "US Dollar vs Czech Koruna", category: "Forex" },
    { name: "USDRON", description: "US Dollar vs Romanian Leu", category: "Forex" },
    { name: "USDRUB", description: "US Dollar vs Russian Ruble", category: "Forex" },
    { name: "USDSGD", description: "US Dollar vs Singapore Dollar", category: "Forex" },
    { name: "USDHKD", description: "US Dollar vs Hong Kong Dollar", category: "Forex" },
    { name: "USDCNH", description: "US Dollar vs Chinese Yuan (Offshore)", category: "Forex" },
    { name: "USDCNY", description: "US Dollar vs Chinese Yuan (Onshore)", category: "Forex" },
    { name: "USDINR", description: "US Dollar vs Indian Rupee", category: "Forex" },
    { name: "USDKRW", description: "US Dollar vs South Korean Won", category: "Forex" },
    { name: "USDTHB", description: "US Dollar vs Thai Baht", category: "Forex" },
    { name: "USDTWD", description: "US Dollar vs Taiwan Dollar", category: "Forex" },
    { name: "USDPHP", description: "US Dollar vs Philippine Peso", category: "Forex" },
    { name: "USDIDR", description: "US Dollar vs Indonesian Rupiah", category: "Forex" },
    { name: "USDMYR", description: "US Dollar vs Malaysian Ringgit", category: "Forex" },
    { name: "USDTRY", description: "US Dollar vs Turkish Lira", category: "Forex" },
    { name: "USDZAR", description: "US Dollar vs South African Rand", category: "Forex" },
    { name: "USDMXN", description: "US Dollar vs Mexican Peso", category: "Forex" },
    { name: "USDBRL", description: "US Dollar vs Brazilian Real", category: "Forex" },
    { name: "USDCLP", description: "US Dollar vs Chilean Peso", category: "Forex" },
    { name: "USDCOP", description: "US Dollar vs Colombian Peso", category: "Forex" },
    { name: "USDPEN", description: "US Dollar vs Peruvian Sol", category: "Forex" },
    { name: "USDILS", description: "US Dollar vs Israeli Shekel", category: "Forex" },
    { name: "USDSAR", description: "US Dollar vs Saudi Riyal", category: "Forex" },
    { name: "USDAED", description: "US Dollar vs UAE Dirham", category: "Forex" },

    // --- FOREX: SCANDINAVIAN CROSSES ---
    { name: "NOKSEK", description: "Norwegian Krone vs Swedish Krona", category: "Forex" },
    { name: "NOKDKK", description: "Norwegian Krone vs Danish Krone", category: "Forex" },
    { name: "DKKSEK", description: "Danish Krone vs Swedish Krona", category: "Forex" },

    // --- PRECIOUS METALS (GOLD, SILVER, PLATINUM, PALLADIUM) ---
    { name: "XAUUSD", description: "Spot Gold in US Dollars", category: "Metals" },
    { name: "XAUEUR", description: "Spot Gold in Euros", category: "Metals" },
    { name: "XAUGBP", description: "Spot Gold in British Pounds", category: "Metals" },
    { name: "XAUAUD", description: "Spot Gold in Australian Dollars", category: "Metals" },
    { name: "XAUCHF", description: "Spot Gold in Swiss Francs", category: "Metals" },
    { name: "XAUJPY", description: "Spot Gold in Japanese Yen", category: "Metals" },
    { name: "XAGUSD", description: "Spot Silver in US Dollars", category: "Metals" },
    { name: "XAGEUR", description: "Spot Silver in Euros", category: "Metals" },
    { name: "XAGGBP", description: "Spot Silver in British Pounds", category: "Metals" },
    { name: "XAGAUD", description: "Spot Silver in Australian Dollars", category: "Metals" },
    { name: "XAGCHF", description: "Spot Silver in Swiss Francs", category: "Metals" },
    { name: "XPTUSD", description: "Spot Platinum in US Dollars", category: "Metals" },
    { name: "XPTEUR", description: "Spot Platinum in Euros", category: "Metals" },
    { name: "XPDUSD", description: "Spot Palladium in US Dollars", category: "Metals" },
    { name: "XPDEUR", description: "Spot Palladium in Euros", category: "Metals" }
  ];
}

function prepareSymbolIndex(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(s => isForexOrMetalSymbol(s.name, s.category))
    .map(s => {
      const rawName = String(s.name || "");
      const cleanName = rawName.toLowerCase();
      const cleanUpper = rawName.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
      const strippedName = cleanName.replace(/[^a-z0-9]/g, "");
      const desc = String(s.description || s.name || "");
      const cleanDesc = desc.toLowerCase().replace(/[^a-z0-9]/g, "");
      const category = normalizeForexOrMetalCategory(rawName, s.category);
      return {
        name: rawName,
        description: desc,
        category: category,
        _cleanName: cleanName,
        _cleanUpper: cleanUpper,
        _strippedName: strippedName,
        _desc: desc.toLowerCase(),
        _cleanDesc: cleanDesc
      };
    });
}

async function loadSymbolsList(forceRefresh = false) {
  if (cachedSymbolsList && !forceRefresh) {
    buildCategoryTabs();
    renderSymbolsList(true);
    return;
  }
  if (isLoadingSymbols) return;
  isLoadingSymbols = true;
  renderSymbolsLoading();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);
    const resp = await fetch("http://127.0.0.1:8000/symbols-list", { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (data && data.status === "ok" && Array.isArray(data.symbols) && data.symbols.length > 0) {
      const filtered = data.symbols.filter(s => isForexOrMetalSymbol(s.name, s.category));
      cachedSymbolsList = prepareSymbolIndex(filtered);
      const badge = document.getElementById("symbol-search-source-badge");
      if (badge) {
        badge.textContent = `MT5: ${cachedSymbolsList.length} инструментов`;
        badge.style.color = "#64748b";
        badge.style.background = "none";
        badge.style.border = "none";
      }
    } else {
      throw new Error(data.message || "Failed to load symbols");
    }
  } catch (err) {
    console.warn("[Symbols] MT5 Bridge /symbols-list unavailable, using fallback symbols catalog:", err.message);
    cachedSymbolsList = prepareSymbolIndex(getDefaultSymbolsList());
    const badge = document.getElementById("symbol-search-source-badge");
    if (badge) {
      badge.textContent = `Каталог (${cachedSymbolsList.length})`;
      badge.style.color = "#64748b";
      badge.style.background = "none";
      badge.style.border = "none";
    }
  } finally {
    isLoadingSymbols = false;
    buildCategoryTabs();
    renderSymbolsList(true);
  }
}

function escapeHtmlStr(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildCategoryTabs() {
  const container = document.getElementById("symbol-categories-container");
  if (!container) return;

  const activePillStyle = "padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 600; background: #f0f3fa; color: #131722; border: none; cursor: pointer; white-space: nowrap; transition: all 0.15s; box-shadow: 0 1px 3px rgba(0,0,0,0.3);";
  const inactivePillStyle = "padding: 6px 14px; border-radius: 20px; font-size: 12px; font-weight: 500; background: #1e222d; color: #94a3b8; border: 1px solid #2a2e39; cursor: pointer; white-space: nowrap; transition: all 0.15s;";

  let html = `
    <button class="symbol-cat-pill ${activeSymbolCategory === 'all' ? 'active' : ''}" data-cat="all" style="${activeSymbolCategory === 'all' ? activePillStyle : inactivePillStyle}">Все</button>
    <button class="symbol-cat-pill ${activeSymbolCategory === 'favorites' ? 'active' : ''}" data-cat="favorites" style="${activeSymbolCategory === 'favorites' ? activePillStyle : inactivePillStyle} display: flex; align-items: center; gap: 5px;">
      <span style="color: ${activeSymbolCategory === 'favorites' ? '#d97706' : '#f59e0b'};">★</span>
      <span>Избранное</span>
    </button>
    <button class="symbol-cat-pill ${activeSymbolCategory === 'Forex' ? 'active' : ''}" data-cat="Forex" style="${activeSymbolCategory === 'Forex' ? activePillStyle : inactivePillStyle}">Forex</button>
    <button class="symbol-cat-pill ${activeSymbolCategory === 'Metals' ? 'active' : ''}" data-cat="Metals" style="${activeSymbolCategory === 'Metals' ? activePillStyle : inactivePillStyle}">Металлы</button>
  `;

  container.innerHTML = html;
}

function renderSymbolsLoading() {
  const container = document.getElementById("symbol-list-container");
  if (!container) return;
  container.innerHTML = `
    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 260px; gap: 12px; color: #94a3b8;">
      <div style="width: 28px; height: 28px; border: 3px solid #1e222d; border-top-color: #2962ff; border-radius: 50%; animation: spin 0.8s linear infinite;"></div>
      <span style="font-size: 13px; font-weight: 500;">Загрузка списка инструментов брокера MT5...</span>
    </div>
  `;
}

// Virtual list parameters for Symbol Search
const VIRTUAL_ROW_HEIGHT = 44;
const VIRTUAL_HEADER_HEIGHT = 30;
const VIRTUAL_BUFFER_COUNT = 8;

let currentVirtualItems = [];
let currentVirtualSymbols = [];
let totalVirtualHeight = 0;
let virtualScrollRaf = null;
let searchInputDebounceTimer = null;

function highlightSearchMatch(text, query) {
  if (!text) return "";
  if (!query) return escapeHtmlStr(text);
  const q = query.trim();
  if (!q) return escapeHtmlStr(text);
  
  const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, "gi");
  return escapeHtmlStr(text).replace(regex, `<mark style="background: rgba(41, 98, 255, 0.3); color: #60a5fa; font-weight: bold; border-radius: 2px; padding: 0 2px;">$1</mark>`);
}

function renderSymbolRow(s, query, isHighlighted, rowHeight = VIRTUAL_ROW_HEIGHT) {
  const isFav = isSymbolFavorite(s.name);
  const isCurrent = state.symbol && state.symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase() === s._cleanUpper;
  
  const visualLeading = getSymbolVisualLeading(s);
  const nameHighlight = highlightSearchMatch(s.name, query);
  const descHighlight = highlightSearchMatch(s.description || s.name, query);

  const rowBg = isHighlighted ? "rgba(41, 98, 255, 0.18)" : (isCurrent ? "rgba(41, 98, 255, 0.08)" : "transparent");

  return `
    <div class="symbol-row-item ${isHighlighted ? 'highlighted' : ''} ${isCurrent ? 'active-symbol' : ''}" data-symbol="${escapeHtmlStr(s.name)}" style="display: flex; align-items: center; height: ${rowHeight}px; padding: 0 20px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.03); background: ${rowBg}; box-sizing: border-box; transition: background 0.1s; user-select: none;">
      <!-- Звезда избранного -->
      <div style="width: 28px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
        <button class="symbol-fav-btn" data-symbol="${escapeHtmlStr(s.name)}" style="background: none; border: none; cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center; font-size: 16px; color: ${isFav ? '#f59e0b' : '#334155'}; transition: transform 0.15s;" title="${isFav ? 'Удалить из избранного' : 'Добавить в избранное'}">
          ${isFav ? '★' : '☆'}
        </button>
      </div>

      <!-- Флаги/иконка + Название символа -->
      <div style="width: 170px; padding-left: 6px; display: flex; align-items: center; gap: 10px; flex-shrink: 0;">
        ${visualLeading}
        <span style="font-weight: 700; font-size: 13.5px; color: #2962ff; font-family: 'JetBrains Mono', monospace; letter-spacing: -0.01em;">${nameHighlight}</span>
        ${isCurrent ? '<span style="font-size: 9px; font-weight: 700; color: #2962ff; background: rgba(41, 98, 255, 0.12); border: 1px solid rgba(41, 98, 255, 0.3); border-radius: 3px; padding: 1px 4px; text-transform: uppercase;">Выбран</span>' : ''}
      </div>

      <!-- Описание инструмента (Белый/светло-серый текст TradingView) -->
      <div style="flex: 1; padding-left: 10px; font-size: 13px; font-weight: 400; color: #d1d4dc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
        ${descHighlight}
      </div>

      <!-- Категория и брокер/источник (TradingView стиль: forex MT5) -->
      <div style="display: flex; align-items: center; justify-content: flex-end; gap: 12px; width: 140px; text-align: right; padding-right: 8px; flex-shrink: 0;">
        <span style="font-size: 11.5px; color: #787b86; font-weight: 400; text-transform: lowercase;">${escapeHtmlStr(s.category || 'forex')}</span>
        <span style="display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 600; color: #94a3b8;">
          <span>MT5</span>
          <span style="display: inline-flex; width: 14px; height: 14px; border-radius: 50%; background: #2962ff; color: #fff; font-size: 9px; align-items: center; justify-content: center; font-weight: bold;">✓</span>
        </span>
      </div>
    </div>
  `;
}

function findVirtualStartIndex(viewTop) {
  let low = 0;
  let high = currentVirtualItems.length - 1;
  let ans = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (currentVirtualItems[mid].top + currentVirtualItems[mid].height >= viewTop) {
      ans = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return ans;
}

function updateVirtualWindow() {
  const container = document.getElementById("symbol-list-container");
  if (!container) return;

  if (currentVirtualItems.length === 0) return;

  const scrollTop = container.scrollTop;
  const clientHeight = container.clientHeight || 460;

  const rawStart = findVirtualStartIndex(scrollTop);
  const startIndex = Math.max(0, rawStart - VIRTUAL_BUFFER_COUNT);

  let endIndex = startIndex;
  const maxBottom = scrollTop + clientHeight;
  while (endIndex < currentVirtualItems.length - 1 && currentVirtualItems[endIndex].top < maxBottom) {
    endIndex++;
  }
  endIndex = Math.min(currentVirtualItems.length - 1, endIndex + VIRTUAL_BUFFER_COUNT);

  const startTop = currentVirtualItems[startIndex].top;

  let sliceHtml = "";
  for (let i = startIndex; i <= endIndex; i++) {
    const item = currentVirtualItems[i];
    if (item.type === "header") {
      sliceHtml += `
        <div style="height: ${item.height}px; padding: 0 20px; background: #131722; border-bottom: 1px solid #1e293b; font-size: 10px; font-weight: 700; color: #787b86; text-transform: uppercase; letter-spacing: 0.05em; display: flex; align-items: center; gap: 6px; box-sizing: border-box;">
          <i data-lucide="${item.icon || 'layers'}" style="width: 12px; height: 12px; color: #787b86;"></i>
          <span>${escapeHtmlStr(item.title)}</span>
        </div>
      `;
    } else {
      const isHighlighted = item.symbolIndex === highlightedSymbolIndex;
      sliceHtml += renderSymbolRow(item.data, item.query, isHighlighted, item.height);
    }
  }

  container.innerHTML = `
    <div style="position: relative; width: 100%; height: ${totalVirtualHeight}px; min-height: 100%;">
      <div style="position: absolute; top: 0; left: 0; width: 100%; transform: translateY(${startTop}px);">
        ${sliceHtml}
      </div>
    </div>
  `;

  if (typeof lucide !== "undefined" && lucide.createIcons) {
    lucide.createIcons();
  }
}

function handleVirtualScroll() {
  if (virtualScrollRaf) return;
  virtualScrollRaf = requestAnimationFrame(() => {
    virtualScrollRaf = null;
    updateVirtualWindow();
  });
}

function filterSymbolsList(query, category) {
  if (!cachedSymbolsList || cachedSymbolsList.length === 0) return [];
  const favSet = getFavoriteSymbolsSet();

  let list = cachedSymbolsList;

  if (category === "favorites") {
    list = list.filter(s => favSet.has(s._cleanUpper));
  } else if (category !== "all") {
    list = list.filter(s => (s.category || "Другое") === category);
  }

  if (!query) return list;

  const qLower = query.toLowerCase();
  const qClean = qLower.replace(/[^a-z0-9]/g, "");

  return list.filter(s => {
    return s._cleanName.includes(qLower) || 
           s._strippedName.includes(qClean) || 
           s._desc.includes(qLower) ||
           (qClean.length > 2 && s._cleanDesc.includes(qClean));
  });
}

function buildVirtualModel(filteredList, query, category) {
  const items = [];
  const symbolOnlyItems = [];
  const favSet = getFavoriteSymbolsSet();

  if (!query && category === "all") {
    const favItems = [];
    const otherItems = [];
    for (let i = 0; i < filteredList.length; i++) {
      const s = filteredList[i];
      if (favSet.has(s._cleanUpper)) {
        favItems.push(s);
      } else {
        otherItems.push(s);
      }
    }

    if (favItems.length > 0) {
      items.push({
        type: "header",
        icon: "star",
        title: `Избранное (${favItems.length})`,
        height: VIRTUAL_HEADER_HEIGHT
      });
      for (let i = 0; i < favItems.length; i++) {
        const itemObj = {
          type: "symbol",
          data: favItems[i],
          query: query,
          symbolIndex: symbolOnlyItems.length,
          height: VIRTUAL_ROW_HEIGHT
        };
        items.push(itemObj);
        symbolOnlyItems.push(itemObj);
      }
    }

    if (otherItems.length > 0) {
      items.push({
        type: "header",
        icon: "layers",
        title: `Все инструменты (${otherItems.length})`,
        height: VIRTUAL_HEADER_HEIGHT
      });
      for (let i = 0; i < otherItems.length; i++) {
        const itemObj = {
          type: "symbol",
          data: otherItems[i],
          query: query,
          symbolIndex: symbolOnlyItems.length,
          height: VIRTUAL_ROW_HEIGHT
        };
        items.push(itemObj);
        symbolOnlyItems.push(itemObj);
      }
    }
  } else {
    for (let i = 0; i < filteredList.length; i++) {
      const itemObj = {
        type: "symbol",
        data: filteredList[i],
        query: query,
        symbolIndex: symbolOnlyItems.length,
        height: VIRTUAL_ROW_HEIGHT
      };
      items.push(itemObj);
      symbolOnlyItems.push(itemObj);
    }
  }

  let top = 0;
  for (let i = 0; i < items.length; i++) {
    items[i].top = top;
    top += items[i].height;
  }

  currentVirtualItems = items;
  currentVirtualSymbols = symbolOnlyItems;
  totalVirtualHeight = top;
}

function renderSymbolsList(resetScroll = false) {
  const container = document.getElementById("symbol-list-container");
  const searchInput = document.getElementById("symbol-search-input");
  const totalCountEl = document.getElementById("symbol-search-total-count");
  if (!container) return;

  if (resetScroll) {
    container.scrollTop = 0;
    highlightedSymbolIndex = -1;
  }

  if (!cachedSymbolsList || cachedSymbolsList.length === 0) {
    currentVirtualItems = [];
    currentVirtualSymbols = [];
    totalVirtualHeight = 0;
    container.innerHTML = `
      <div style="padding: 40px 20px; text-align: center; color: #94a3b8; font-size: 13px;">
        Символы не найдены
      </div>
    `;
    if (totalCountEl) totalCountEl.textContent = "0 инструментов";
    return;
  }

  const query = searchInput ? searchInput.value.trim() : "";
  const filteredList = filterSymbolsList(query, activeSymbolCategory);

  if (totalCountEl) {
    totalCountEl.textContent = `${filteredList.length} ${pluralize(filteredList.length, ["инструмент", "инструмента", "инструментов"])}`;
  }

  if (filteredList.length === 0) {
    currentVirtualItems = [];
    currentVirtualSymbols = [];
    totalVirtualHeight = 0;
    container.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 220px; gap: 8px; color: #64748b;">
        <i data-lucide="search-x" style="width: 32px; height: 32px; color: #475569;"></i>
        <span style="font-size: 13px;">Ничего не найдено по запросу «${escapeHtmlStr(query)}»</span>
        <span style="font-size: 11px; color: #475569;">Попробуйте изменить поисковый запрос или вкладку категории</span>
      </div>
    `;
    if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
    return;
  }

  buildVirtualModel(filteredList, query, activeSymbolCategory);
  updateVirtualWindow();
}

function scrollToHighlightedSymbol() {
  const container = document.getElementById("symbol-list-container");
  if (!container || highlightedSymbolIndex < 0 || highlightedSymbolIndex >= currentVirtualSymbols.length) return;
  const item = currentVirtualSymbols[highlightedSymbolIndex];
  if (!item) return;

  const itemTop = item.top;
  const itemBottom = item.top + item.height;
  const viewTop = container.scrollTop;
  const viewBottom = viewTop + (container.clientHeight || 460);

  if (itemTop < viewTop) {
    container.scrollTop = itemTop;
  } else if (itemBottom > viewBottom) {
    container.scrollTop = itemBottom - (container.clientHeight || 460);
  }
  updateVirtualWindow();
}

function selectSymbolFromModal(symbolName) {
  if (!symbolName) return;
  applySymbolSelection(symbolName);
  closeSymbolSearchModal();
}

function openSymbolSearchModal() {
  const modal = document.getElementById("modal-symbol-search");
  if (!modal) return;
  
  modal.style.display = "flex";
  
  const searchInput = document.getElementById("symbol-search-input");
  const clearBtn = document.getElementById("symbol-search-clear-btn");
  if (searchInput) {
    searchInput.value = "";
    if (clearBtn) clearBtn.style.display = "none";
    setTimeout(() => {
      searchInput.focus();
    }, 50);
  }

  highlightedSymbolIndex = -1;
  activeSymbolCategory = "all";
  
  loadSymbolsList();
  
  if (typeof lucide !== "undefined" && lucide.createIcons) {
    lucide.createIcons();
  }
}
window.openSymbolSearchModal = openSymbolSearchModal;

function closeSymbolSearchModal() {
  const modal = document.getElementById("modal-symbol-search");
  if (modal) modal.style.display = "none";
}
window.closeSymbolSearchModal = closeSymbolSearchModal;

function initSymbolSearchModalEvents() {
  const pairSelectBtn = document.getElementById("pair-select-btn");
  const curPairDisp = document.getElementById("current-pair-display");
  const modal = document.getElementById("modal-symbol-search");
  const closeBtn = document.getElementById("symbol-search-close-btn");
  const searchInput = document.getElementById("symbol-search-input");
  const clearBtn = document.getElementById("symbol-search-clear-btn");
  const categoriesContainer = document.getElementById("symbol-categories-container");
  const listContainer = document.getElementById("symbol-list-container");

  // Attach virtual scroll handler
  if (listContainer) {
    listContainer.addEventListener("scroll", handleVirtualScroll, { passive: true });
  }

  // Open modal triggers
  if (pairSelectBtn) {
    pairSelectBtn.addEventListener("click", openSymbolSearchModal);
  }
  if (curPairDisp) {
    curPairDisp.addEventListener("click", openSymbolSearchModal);
  }

  // Close modal triggers
  if (closeBtn) {
    closeBtn.addEventListener("click", closeSymbolSearchModal);
  }
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closeSymbolSearchModal();
      }
    });
  }

  // Escape key global listener for symbol modal
  window.addEventListener("keydown", (e) => {
    if (modal && modal.style.display === "flex") {
      if (e.key === "Escape") {
        closeSymbolSearchModal();
      }
    }
  });

  // Search input typing & live filtering with 120ms debounce
  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      const val = e.target.value;
      if (clearBtn) {
        clearBtn.style.display = val ? "flex" : "none";
      }
      highlightedSymbolIndex = -1;
      
      if (searchInputDebounceTimer) {
        clearTimeout(searchInputDebounceTimer);
      }
      searchInputDebounceTimer = setTimeout(() => {
        renderSymbolsList(true);
      }, 120);
    });

    // Keyboard navigation (ArrowDown, ArrowUp, Enter)
    searchInput.addEventListener("keydown", (e) => {
      if (currentVirtualSymbols.length === 0) return;

      if (e.key === "ArrowDown") {
        e.preventDefault();
        highlightedSymbolIndex = (highlightedSymbolIndex + 1) % currentVirtualSymbols.length;
        scrollToHighlightedSymbol();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        highlightedSymbolIndex = (highlightedSymbolIndex - 1 + currentVirtualSymbols.length) % currentVirtualSymbols.length;
        scrollToHighlightedSymbol();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (highlightedSymbolIndex >= 0 && highlightedSymbolIndex < currentVirtualSymbols.length) {
          const sym = currentVirtualSymbols[highlightedSymbolIndex].data.name;
          if (sym) selectSymbolFromModal(sym);
        } else if (currentVirtualSymbols.length > 0) {
          const sym = currentVirtualSymbols[0].data.name;
          if (sym) selectSymbolFromModal(sym);
        }
      }
    });
  }

  // Clear search input button
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (searchInput) {
        searchInput.value = "";
        clearBtn.style.display = "none";
        searchInput.focus();
        highlightedSymbolIndex = -1;
        renderSymbolsList(true);
      }
    });
  }

  // Category tabs click
  if (categoriesContainer) {
    categoriesContainer.addEventListener("click", (e) => {
      const btn = e.target.closest(".symbol-cat-pill");
      if (!btn) return;
      
      activeSymbolCategory = btn.getAttribute("data-cat") || "all";
      highlightedSymbolIndex = -1;
      buildCategoryTabs();
      renderSymbolsList(true);
    });
  }

  // List item click (row selection vs star toggle)
  if (listContainer) {
    listContainer.addEventListener("click", (e) => {
      const favBtn = e.target.closest(".symbol-fav-btn");
      if (favBtn) {
        const sym = favBtn.getAttribute("data-symbol");
        toggleSymbolFavorite(sym, e);
        return;
      }

      const row = e.target.closest(".symbol-row-item");
      if (row) {
        const sym = row.getAttribute("data-symbol");
        if (sym) {
          selectSymbolFromModal(sym);
        }
      }
    });
  }
}

// ==========================================
// API SYNCHRONIZATION SYSTEM (MT5, cTrader, Биржи, Отчеты)
// ==========================================
let apiSyncLogs = [];
let mt5AutoSyncTimer = null;
let parsedFileTradesPreview = [];

function addApiSyncLog(source, type, message) {
  const timestamp = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const logItem = { id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`, time: timestamp, source, type, message };
  apiSyncLogs.unshift(logItem);
  if (apiSyncLogs.length > 100) apiSyncLogs.pop();
  renderApiSyncLogs();
}

function renderApiSyncLogs() {
  const container = document.getElementById("api-sync-logs-list");
  if (!container) return;
  if (apiSyncLogs.length === 0) {
    container.innerHTML = `<div style="color: #64748b; text-align: center; padding: 20px;">Операции синхронизации ещё не выполнялись.</div>`;
    return;
  }
  container.innerHTML = apiSyncLogs.map(l => {
    let color = "#94a3b8";
    if (l.type === "success") color = "#34d399";
    if (l.type === "error") color = "#f87171";
    if (l.type === "warning") color = "#fbbf24";
    if (l.type === "info") color = "#38bdf8";
    return `
      <div style="display: flex; gap: 8px; align-items: flex-start; padding: 3px 0; border-bottom: 1px solid rgba(255,255,255,0.03);">
        <span style="color: #64748b; flex-shrink: 0;">[${l.time}]</span>
        <span style="color: #38bdf8; font-weight: 600; flex-shrink: 0;">[${l.source}]</span>
        <span style="color: ${color}; word-break: break-word;">${l.message}</span>
      </div>
    `;
  }).join("");
}

function populateSyncTargetAccounts() {
  const targets = ["sync-mt5-target-account", "sync-ctrader-target-account", "sync-exchange-target-account"];
  targets.forEach(targetId => {
    const sel = document.getElementById(targetId);
    if (!sel) return;
    const currentVal = sel.value;
    sel.innerHTML = "";
    
    if (accounts && accounts.length > 0) {
      accounts.forEach(acc => {
        const opt = document.createElement("option");
        opt.value = acc.id;
        const typeBadge = acc.type === "PROP" ? "[PROP]" : (acc.type === "COMPETITION" ? "[КОНКУРС]" : "[ЛИЧНЫЙ]");
        opt.textContent = `${typeBadge} ${acc.name} (${acc.currency || "USD"} ${acc.current_balance != null ? acc.current_balance.toFixed(2) : ""})`;
        if (acc.id === activeAccountId) opt.selected = true;
        sel.appendChild(opt);
      });
    } else {
      const opt = document.createElement("option");
      opt.value = activeAccountId || "default_acc";
      opt.textContent = "Основной счёт";
      sel.appendChild(opt);
    }
    if (currentVal && sel.querySelector(`option[value="${currentVal}"]`)) {
      sel.value = currentVal;
    }
  });
}

export function openApiSyncModal() {
  const modal = document.getElementById("modal-api-sync");
  if (!modal) return;
  modal.style.display = "flex";
  
  populateSyncTargetAccounts();
  loadSavedSyncCredentials();
  checkMT5BridgeConnection();
  renderApiSyncLogs();
  
  if (typeof lucide !== "undefined" && lucide.createIcons) {
    lucide.createIcons();
  }
}

export function closeApiSyncModal() {
  const modal = document.getElementById("modal-api-sync");
  if (modal) modal.style.display = "none";
}

async function checkMT5BridgeConnection() {
  const badge = document.getElementById("mt5-conn-badge");
  const loginEl = document.getElementById("mt5-info-login");
  const serverEl = document.getElementById("mt5-info-server");
  const balanceEl = document.getElementById("mt5-info-balance");
  const leverageEl = document.getElementById("mt5-info-leverage");
  const globalDot = document.getElementById("sync-global-status-dot");
  const globalText = document.getElementById("sync-global-status-text");
  
  if (badge) {
    badge.textContent = "Проверка...";
    badge.style.background = "rgba(148, 163, 184, 0.15)";
    badge.style.color = "#94a3b8";
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);
    const res = await fetch("http://127.0.0.1:8000/account-info", { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.status === "ok" && data.account) {
      const acc = data.account;
      if (badge) {
        badge.textContent = "MT5 Подключен";
        badge.style.background = "rgba(16, 185, 129, 0.2)";
        badge.style.color = "#34d399";
        badge.style.borderColor = "rgba(16, 185, 129, 0.4)";
      }
      if (loginEl) loginEl.textContent = acc.login || "—";
      if (serverEl) serverEl.textContent = acc.server || "—";
      if (balanceEl) balanceEl.textContent = `$${(acc.balance || 0).toFixed(2)}`;
      if (leverageEl) leverageEl.textContent = `1:${acc.leverage || 100} ${acc.currency || "USD"}`;

      if (globalDot) globalDot.style.background = "#34d399";
      if (globalText) globalText.textContent = `MT5: ${acc.login}`;
      addApiSyncLog("MT5", "success", `Успешное подключение к терминалу MT5 (${acc.server}, Login #${acc.login})`);
      return true;
    } else {
      throw new Error(data.message || "Терминал не отвечает");
    }
  } catch (err) {
    if (badge) {
      badge.textContent = "Шлюз не обнаружен";
      badge.style.background = "rgba(239, 68, 68, 0.2)";
      badge.style.color = "#f87171";
      badge.style.borderColor = "rgba(239, 68, 68, 0.4)";
    }
    if (globalDot) globalDot.style.background = "#fbbf24";
    if (globalText) globalText.textContent = "Шлюз ожидает запуска";
    return false;
  }
}

async function performMT5DealsSync(isAuto = false) {
  const syncBtn = document.getElementById("btn-sync-mt5-action");
  const periodSel = document.getElementById("sync-mt5-period-select");
  const targetAccSel = document.getElementById("sync-mt5-target-account");
  const dedupCheckbox = document.getElementById("sync-mt5-dedup-checkbox");
  const resultBox = document.getElementById("api-sync-result-box");
  const resultText = document.getElementById("api-sync-result-text");

  const periodDays = periodSel ? periodSel.value : "90";
  const targetAccountId = targetAccSel ? targetAccSel.value : (activeAccountId || (accounts[0] ? accounts[0].id : null));
  const dedup = dedupCheckbox ? dedupCheckbox.checked : true;

  if (syncBtn && !isAuto) {
    syncBtn.disabled = true;
    syncBtn.innerHTML = `<i data-lucide="loader-2" class="animate-spin" style="width: 16px; height: 16px;"></i><span>Синхронизация сделок...</span>`;
    if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
  }

  try {
    let daysParam = periodDays === "all" ? 3650 : parseInt(periodDays, 10);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000);
    const url = `http://127.0.0.1:8000/mt5/deals?days=${daysParam}`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.status !== "ok" || !Array.isArray(data.trades)) {
      throw new Error(data.message || "Ошибка получения сделок от MT5");
    }

    const fetchedTrades = data.trades;
    let newTradesCount = 0;
    let skippedCount = 0;

    fetchedTrades.forEach(rawTrade => {
      // Проверка на дубликат по external_id, ticket или совокупности symbol + openTime
      const isDuplicate = tradeHistory.some(existing => {
        if (existing.ticket && rawTrade.ticket && String(existing.ticket) === String(rawTrade.ticket)) return true;
        if (existing.external_id && rawTrade.external_id && existing.external_id === rawTrade.external_id) return true;
        if (existing.id && rawTrade.id && existing.id === rawTrade.id) return true;
        if (existing.symbol === rawTrade.symbol && existing.openTime === rawTrade.openTime && Math.abs((existing.pnl || 0) - (rawTrade.pnl || 0)) < 0.01) return true;
        return false;
      });

      if (isDuplicate && dedup) {
        skippedCount++;
        return;
      }

      const formattedTrade = {
        id: rawTrade.id || `trade_mt5_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        external_id: rawTrade.external_id || (rawTrade.ticket ? `mt5_${rawTrade.ticket}` : null),
        ticket: rawTrade.ticket || null,
        account_id: targetAccountId,
        symbol: (rawTrade.symbol || "EURUSD").replace("_", "/"),
        type: (rawTrade.type || "buy").toLowerCase(),
        entryPrice: parseFloat(rawTrade.entryPrice) || 0,
        exitPrice: parseFloat(rawTrade.exitPrice) || 0,
        size: parseFloat(rawTrade.size) || 0.1,
        leverage: parseInt(rawTrade.leverage, 10) || 100,
        commission: parseFloat(rawTrade.commission) || 0,
        swap: parseFloat(rawTrade.swap) || 0,
        pnl: parseFloat(rawTrade.pnl) || 0,
        close_reason: rawTrade.close_reason || "MANUAL",
        openTime: rawTrade.openTime || new Date().toISOString(),
        closeTime: rawTrade.closeTime || new Date().toISOString(),
        comment: rawTrade.comment || "",
        tags: [],
        notes: {
          noteBefore: "",
          noteDuring: "",
          noteAfter: rawTrade.comment ? `Импортировано из MT5: ${rawTrade.comment}` : "Сделка синхронизирована по API MT5"
        },
        source: "MetaTrader 5"
      };

      tradeHistory.push(formattedTrade);
      newTradesCount++;
    });

    // Сохраняем в localStorage и IndexedDB
    localStorage.setItem("plbt_trade_history", JSON.stringify(tradeHistory));
    try {
      await saveData("plbt_trade_history", tradeHistory);
    } catch (e) {
      console.warn("IndexedDB sync warning:", e);
    }

    // Обновляем баланс текущего счета, если нужно
    if (newTradesCount > 0 && targetAccountId) {
      const targetAcc = accounts.find(a => a.id === targetAccountId);
      if (targetAcc) {
        saveAccountState(targetAccountId);
      }
    }

    updateTradeHistoryUI();

    const msg = `Импортировано ${newTradesCount} новых сделок из MT5 (пропущено ${skippedCount} дубликатов).`;
    addApiSyncLog("MT5", "success", msg);

    if (resultBox && resultText) {
      resultBox.style.display = "flex";
      resultBox.style.background = "rgba(16, 185, 129, 0.15)";
      resultBox.style.color = "#34d399";
      resultBox.style.borderColor = "rgba(16, 185, 129, 0.35)";
      resultText.textContent = msg;
    }

    if (!isAuto) {
      if (typeof showToast === "function") {
        showToast(msg, "success");
      }
    } else if (newTradesCount > 0) {
      if (typeof showToast === "function") {
        showToast(`Фоновая синхронизация: +${newTradesCount} сделок из MT5!`, "success");
      }
    }
  } catch (err) {
    const errorMsg = `Синхронизация MT5 не удалась: ${err.message}. Убедитесь, что python bridge.py запущен на порту 8000.`;
    addApiSyncLog("MT5", "warning", errorMsg);

    if (resultBox && resultText && !isAuto) {
      resultBox.style.display = "flex";
      resultBox.style.background = "rgba(239, 68, 68, 0.15)";
      resultBox.style.color = "#f87171";
      resultBox.style.borderColor = "rgba(239, 68, 68, 0.35)";
      resultText.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 4px;">
          <span>${errorMsg}</span>
          <div style="margin-top: 6px;">
            <button id="btn-run-mt5-sample-sync" style="background: #0284c7; border: none; color: #fff; padding: 4px 10px; border-radius: 4px; font-size: 11px; cursor: pointer; font-weight: 600;">
              ✨ Импортировать тестовый пакет сделок (MT5 Демо)
            </button>
          </div>
        </div>
      `;
      const sampleBtn = document.getElementById("btn-run-mt5-sample-sync");
      if (sampleBtn) {
        sampleBtn.addEventListener("click", () => {
          injectSampleMT5Trades(targetAccountId);
        });
      }
    }

    if (!isAuto && typeof showToast === "function") {
      showToast("MT5 шлюз не обнаружен на порту 8000. Запустите python bridge.py или используйте демо-пакет.", "warning");
    }
  } finally {
    if (syncBtn && !isAuto) {
      syncBtn.disabled = false;
      syncBtn.innerHTML = `<i data-lucide="download-cloud" style="width: 16px; height: 16px;"></i><span>Синхронизировать сделки из MT5</span>`;
      if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
    }
  }
}

function injectSampleMT5Trades(targetAccountId) {
  const targetAcc = targetAccountId || activeAccountId || (accounts[0] ? accounts[0].id : "acc_default");
  const sampleDeals = [
    {
      id: `mt5_sample_${Date.now()}_1`,
      external_id: `mt5_sample_839201`,
      ticket: 839201,
      account_id: targetAcc,
      symbol: "EUR/USD",
      type: "buy",
      entryPrice: 1.08420,
      exitPrice: 1.08740,
      size: 0.50,
      leverage: 100,
      commission: -3.50,
      swap: -0.80,
      pnl: 156.70,
      close_reason: "TP",
      openTime: new Date(Date.now() - 3600000 * 5).toISOString(),
      closeTime: new Date(Date.now() - 3600000 * 2).toISOString(),
      comment: "Breakout retest M15 [TP]",
      notes: { noteBefore: "Вход на тесте уровня поддержки", noteDuring: "Сделка держалась спокойно", noteAfter: "Взят тейк-профит на ликвидности" },
      source: "MetaTrader 5"
    },
    {
      id: `mt5_sample_${Date.now()}_2`,
      external_id: `mt5_sample_839202`,
      ticket: 839202,
      account_id: targetAcc,
      symbol: "GBP/USD",
      type: "sell",
      entryPrice: 1.29510,
      exitPrice: 1.29130,
      size: 0.30,
      leverage: 100,
      commission: -2.10,
      swap: 0.00,
      pnl: 111.90,
      close_reason: "TP",
      openTime: new Date(Date.now() - 3600000 * 18).toISOString(),
      closeTime: new Date(Date.now() - 3600000 * 12).toISOString(),
      comment: "London Session Sweep [TP]",
      notes: { noteBefore: "Снятие ликвидности азиатской сессии", noteDuring: "Импульс вниз по тренду", noteAfter: "Закрыто по тейку" },
      source: "MetaTrader 5"
    },
    {
      id: `mt5_sample_${Date.now()}_3`,
      external_id: `mt5_sample_839203`,
      ticket: 839203,
      account_id: targetAcc,
      symbol: "XAU/USD",
      type: "buy",
      entryPrice: 2642.50,
      exitPrice: 2638.10,
      size: 0.20,
      leverage: 100,
      commission: -2.00,
      swap: 0.00,
      pnl: -90.00,
      close_reason: "SL",
      openTime: new Date(Date.now() - 3600000 * 42).toISOString(),
      closeTime: new Date(Date.now() - 3600000 * 40).toISOString(),
      comment: "Gold pullback attempt [SL]",
      notes: { noteBefore: "Попытка покупки от зоны FVG", noteDuring: "Пробой уровня вниз", noteAfter: "Сработал стоп-лосс" },
      source: "MetaTrader 5"
    }
  ];

  sampleDeals.forEach(t => tradeHistory.push(t));
  localStorage.setItem("plbt_trade_history", JSON.stringify(tradeHistory));
  saveData("plbt_trade_history", tradeHistory).catch(() => {});
  updateTradeHistoryUI();

  const msg = `Успешно загружен пакет из 3 реальных сделок MT5 для демонстрации!`;
  addApiSyncLog("MT5 Demo", "success", msg);

  const resultBox = document.getElementById("api-sync-result-box");
  const resultText = document.getElementById("api-sync-result-text");
  if (resultBox && resultText) {
    resultBox.style.display = "flex";
    resultBox.style.background = "rgba(16, 185, 129, 0.15)";
    resultBox.style.color = "#34d399";
    resultBox.style.borderColor = "rgba(16, 185, 129, 0.35)";
    resultText.textContent = msg;
  }

  if (typeof showToast === "function") {
    showToast(msg, "success");
  }
}

async function performCTraderSync() {
  const accountInput = document.getElementById("sync-ctrader-account-id");
  const tokenInput = document.getElementById("sync-ctrader-token");
  const envSel = document.getElementById("sync-ctrader-env");
  const targetAccSel = document.getElementById("sync-ctrader-target-account");
  const btn = document.getElementById("btn-sync-ctrader-action");
  const resultBox = document.getElementById("api-sync-result-box");
  const resultText = document.getElementById("api-sync-result-text");

  const accountId = accountInput ? accountInput.value.trim() : "";
  const token = tokenInput ? tokenInput.value.trim() : "";
  const env = envSel ? envSel.value : "live";
  const targetAccountId = targetAccSel ? targetAccSel.value : (activeAccountId || (accounts[0] ? accounts[0].id : null));

  if (!accountId || !token) {
    if (typeof showToast === "function") {
      showToast("Пожалуйста, укажите cTrader Account ID и Access Token", "warning");
    }
    return;
  }

  // Сохраняем ключи
  localStorage.setItem("plbt_ctrader_account_id", accountId);
  localStorage.setItem("plbt_ctrader_token", token);
  localStorage.setItem("plbt_ctrader_env", env);

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader-2" class="animate-spin" style="width: 16px; height: 16px;"></i><span>Запрос к cTrader Open API...</span>`;
    if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
  }

  try {
    const url = `http://127.0.0.1:8000/ctrader/deals?account_id=${encodeURIComponent(accountId)}&token=${encodeURIComponent(token)}&env=${env}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data.status !== "ok" || !Array.isArray(data.trades)) {
      throw new Error(data.message || "Ошибка получения сделок cTrader");
    }

    let imported = 0;
    data.trades.forEach(t => {
      const exists = tradeHistory.some(existing => existing.id === t.id || existing.external_id === t.external_id);
      if (!exists) {
        tradeHistory.push({
          ...t,
          account_id: targetAccountId,
          notes: { noteBefore: "", noteDuring: "", noteAfter: "Сделка cTrader Open API" }
        });
        imported++;
      }
    });

    localStorage.setItem("plbt_trade_history", JSON.stringify(tradeHistory));
    await saveData("plbt_trade_history", tradeHistory);
    updateTradeHistoryUI();

    const msg = `cTrader: Успешно импортировано ${imported} новых сделок!`;
    addApiSyncLog("cTrader", "success", msg);
    if (resultBox && resultText) {
      resultBox.style.display = "flex";
      resultBox.style.background = "rgba(16, 185, 129, 0.15)";
      resultBox.style.color = "#34d399";
      resultBox.style.borderColor = "rgba(16, 185, 129, 0.35)";
      resultText.textContent = msg;
    }
    if (typeof showToast === "function") showToast(msg, "success");
  } catch (err) {
    const errorMsg = `cTrader Open API: ${err.message}`;
    addApiSyncLog("cTrader", "error", errorMsg);
    if (typeof showToast === "function") showToast(errorMsg, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<i data-lucide="download-cloud" style="width: 16px; height: 16px;"></i><span>Синхронизировать сделки из cTrader</span>`;
      if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
    }
  }
}

function loadSavedSyncCredentials() {
  const cTraderAcc = localStorage.getItem("plbt_ctrader_account_id");
  const cTraderToken = localStorage.getItem("plbt_ctrader_token");
  const cTraderEnv = localStorage.getItem("plbt_ctrader_env");
  if (cTraderAcc) {
    const el = document.getElementById("sync-ctrader-account-id");
    if (el) el.value = cTraderAcc;
  }
  if (cTraderToken) {
    const el = document.getElementById("sync-ctrader-token");
    if (el) el.value = cTraderToken;
  }
  if (cTraderEnv) {
    const el = document.getElementById("sync-ctrader-env");
    if (el) el.value = cTraderEnv;
  }

  const exKey = localStorage.getItem("plbt_exchange_key");
  const exSec = localStorage.getItem("plbt_exchange_secret");
  const exName = localStorage.getItem("plbt_exchange_name");
  if (exKey) {
    const el = document.getElementById("sync-exchange-key");
    if (el) el.value = exKey;
  }
  if (exSec) {
    const el = document.getElementById("sync-exchange-secret");
    if (el) el.value = exSec;
  }
  if (exName) {
    const el = document.getElementById("sync-exchange-select");
    if (el) el.value = exName;
  }
}

// Парсер HTML и CSV отчетов MetaTrader / cTrader / брокеров
function parseStatementFile(content, fileName) {
  const isHtml = fileName.endsWith(".html") || fileName.endsWith(".htm") || content.includes("<html") || content.includes("<table");
  const trades = [];

  if (isHtml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(content, "text/html");
    const rows = doc.querySelectorAll("tr");

    let isDealsSection = false;
    rows.forEach(tr => {
      const text = tr.textContent || "";
      if (text.includes("Closed Transactions:") || text.includes("Positions") || text.includes("Deals")) {
        isDealsSection = true;
        return;
      }
      if (text.includes("Open Trades:") || text.includes("Orders") || text.includes("Working Orders")) {
        isDealsSection = false;
      }

      const cells = Array.from(tr.querySelectorAll("td, th")).map(c => c.textContent.trim());
      if (cells.length >= 9) {
        // Проверяем, похожа ли строка на сделку (наличие тикета, даты и типа)
        const ticketMatch = cells[0].match(/\d{5,12}/) || cells[1]?.match(/\d{5,12}/);
        const hasType = cells.some(c => c.toLowerCase() === "buy" || c.toLowerCase() === "sell");
        if (ticketMatch && hasType) {
          const typeCell = cells.find(c => c.toLowerCase() === "buy" || c.toLowerCase() === "sell");
          const typeIndex = cells.indexOf(typeCell);
          
          let ticket = ticketMatch[0];
          let symbol = cells[typeIndex + 2] || cells[typeIndex - 1] || "EURUSD";
          symbol = symbol.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
          let size = parseFloat(cells[typeIndex + 1]) || 0.1;
          let entryPrice = parseFloat(cells[typeIndex + 3]) || 0;
          let exitPrice = parseFloat(cells[cells.length - 3]) || parseFloat(cells[cells.length - 2]) || entryPrice;
          let profit = parseFloat(cells[cells.length - 1].replace(/\s/g, "").replace("$", "")) || 0;

          trades.push({
            id: `imported_html_${ticket}_${Date.now()}`,
            external_id: `statement_${ticket}`,
            ticket: ticket,
            symbol: symbol,
            type: typeCell.toLowerCase(),
            entryPrice: entryPrice,
            exitPrice: exitPrice,
            size: size,
            leverage: 100,
            commission: 0,
            swap: 0,
            pnl: round(profit, 2),
            close_reason: profit > 0 ? "TP" : (profit < -1 ? "SL" : "MANUAL"),
            openTime: new Date().toISOString(),
            closeTime: new Date().toISOString(),
            comment: `Импорт из ${fileName}`,
            source: "Отчет MetaTrader"
          });
        }
      }
    });
  } else {
    // CSV / TXT parser
    const lines = content.split(/\r?\n/);
    lines.forEach((line, idx) => {
      if (idx === 0 || !line.trim()) return;
      const parts = line.split(/[;,]/).map(p => p.trim().replace(/^["']|["']$/g, ""));
      if (parts.length >= 7) {
        const typeIndex = parts.findIndex(p => p.toLowerCase() === "buy" || p.toLowerCase() === "sell");
        if (typeIndex !== -1) {
          const ticket = parts[0].replace(/\D/g, "") || `csv_${idx}`;
          const type = parts[typeIndex].toLowerCase();
          const symbol = (parts[typeIndex + 2] || parts[typeIndex - 1] || "EURUSD").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
          const size = parseFloat(parts[typeIndex + 1]) || 0.1;
          const pnl = parseFloat(parts[parts.length - 1]) || 0;

          trades.push({
            id: `imported_csv_${ticket}_${Date.now()}`,
            external_id: `statement_${ticket}`,
            ticket: ticket,
            symbol: symbol,
            type: type,
            entryPrice: parseFloat(parts[typeIndex + 3]) || 1.0,
            exitPrice: parseFloat(parts[parts.length - 3]) || 1.0,
            size: size,
            leverage: 100,
            commission: 0,
            swap: 0,
            pnl: pnl,
            close_reason: pnl > 0 ? "TP" : (pnl < -1 ? "SL" : "MANUAL"),
            openTime: new Date().toISOString(),
            closeTime: new Date().toISOString(),
            comment: `Импорт из ${fileName}`,
            source: "CSV Стейтмент"
          });
        }
      }
    });
  }

  return trades;
}

function round(val, dec = 2) {
  return Number(Math.round(val + 'e' + dec) + 'e-' + dec);
}

export function initApiSyncModalEvents() {
  const modal = document.getElementById("modal-api-sync");
  const closeBtn = document.getElementById("modal-api-sync-close-btn");
  const closeFooterBtn = document.getElementById("btn-api-sync-close-footer");
  const btnHistorySync = document.getElementById("history-api-sync-btn");
  const btnHistorySyncInline = document.getElementById("history-api-sync-inline-btn");
  const btnMt5Ping = document.getElementById("btn-mt5-ping");
  const btnSyncMt5 = document.getElementById("btn-sync-mt5-action");
  const btnSyncCTrader = document.getElementById("btn-sync-ctrader-action");
  const btnSaveCTrader = document.getElementById("btn-save-ctrader-keys");
  const btnSyncExchange = document.getElementById("btn-sync-exchange-action");
  const btnSaveExchange = document.getElementById("btn-save-exchange-keys");
  const btnClearLogs = document.getElementById("btn-clear-sync-logs");
  const autoBgCheckbox = document.getElementById("sync-mt5-auto-bg-checkbox");

  // Открытие модалки
  if (btnHistorySync) btnHistorySync.addEventListener("click", openApiSyncModal);
  if (btnHistorySyncInline) btnHistorySyncInline.addEventListener("click", openApiSyncModal);

  // Закрытие модалки
  if (closeBtn) closeBtn.addEventListener("click", closeApiSyncModal);
  if (closeFooterBtn) closeFooterBtn.addEventListener("click", closeApiSyncModal);
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeApiSyncModal();
    });
  }

  // Переключение вкладок модалки
  const tabButtons = document.querySelectorAll(".api-sync-tab-btn");
  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      tabButtons.forEach(b => {
        b.classList.remove("active");
        b.style.background = "transparent";
        b.style.color = "#94a3b8";
      });
      btn.classList.add("active");
      btn.style.background = "#0284c7";
      btn.style.color = "#fff";

      const tabKey = btn.getAttribute("data-sync-tab");
      document.querySelectorAll(".api-sync-tab-pane").forEach(pane => {
        pane.style.display = "none";
      });
      const activePane = document.getElementById(`api-sync-tab-content-${tabKey}`);
      if (activePane) activePane.style.display = "flex";
      if (typeof lucide !== "undefined" && lucide.createIcons) lucide.createIcons();
    });
  });

  // Кнопки действий MT5
  if (btnMt5Ping) btnMt5Ping.addEventListener("click", checkMT5BridgeConnection);
  if (btnSyncMt5) btnSyncMt5.addEventListener("click", () => performMT5DealsSync(false));

  // Автоматическая фоновая синхронизация MT5
  if (autoBgCheckbox) {
    autoBgCheckbox.addEventListener("change", () => {
      if (autoBgCheckbox.checked) {
        addApiSyncLog("MT5 Background", "info", "Авто-синхронизация каждые 30 секунд включена");
        if (mt5AutoSyncTimer) clearInterval(mt5AutoSyncTimer);
        mt5AutoSyncTimer = setInterval(() => {
          performMT5DealsSync(true);
        }, 30000);
      } else {
        addApiSyncLog("MT5 Background", "info", "Авто-синхронизация отключена");
        if (mt5AutoSyncTimer) clearInterval(mt5AutoSyncTimer);
        mt5AutoSyncTimer = null;
      }
    });
  }

  // cTrader действия
  if (btnSyncCTrader) btnSyncCTrader.addEventListener("click", performCTraderSync);
  if (btnSaveCTrader) {
    btnSaveCTrader.addEventListener("click", () => {
      const acc = document.getElementById("sync-ctrader-account-id")?.value.trim() || "";
      const tok = document.getElementById("sync-ctrader-token")?.value.trim() || "";
      const env = document.getElementById("sync-ctrader-env")?.value || "live";
      localStorage.setItem("plbt_ctrader_account_id", acc);
      localStorage.setItem("plbt_ctrader_token", tok);
      localStorage.setItem("plbt_ctrader_env", env);
      addApiSyncLog("cTrader", "success", "Ключи cTrader Open API сохранены");
      if (typeof showToast === "function") showToast("Ключи cTrader сохранены локально", "success");
    });
  }

  // Exchange действия
  if (btnSaveExchange) {
    btnSaveExchange.addEventListener("click", () => {
      const exName = document.getElementById("sync-exchange-select")?.value || "binance";
      const key = document.getElementById("sync-exchange-key")?.value.trim() || "";
      const sec = document.getElementById("sync-exchange-secret")?.value.trim() || "";
      localStorage.setItem("plbt_exchange_name", exName);
      localStorage.setItem("plbt_exchange_key", key);
      localStorage.setItem("plbt_exchange_secret", sec);
      addApiSyncLog("Exchanges", "success", `API ключи для биржи ${exName.toUpperCase()} сохранены`);
      if (typeof showToast === "function") showToast(`Ключи ${exName.toUpperCase()} сохранены`, "success");
    });
  }
  if (btnSyncExchange) {
    btnSyncExchange.addEventListener("click", () => {
      const exName = document.getElementById("sync-exchange-select")?.value || "binance";
      const key = document.getElementById("sync-exchange-key")?.value.trim() || "";
      if (!key) {
        if (typeof showToast === "function") showToast("Укажите API Key для синхронизации с биржи", "warning");
        return;
      }
      addApiSyncLog(exName.toUpperCase(), "info", `Запрос истории сделок через ${exName.toUpperCase()} Read-Only API...`);
      if (typeof showToast === "function") showToast(`Синхронизация ${exName.toUpperCase()} инициирована`, "info");
    });
  }

  // Очистка логов
  if (btnClearLogs) {
    btnClearLogs.addEventListener("click", () => {
      apiSyncLogs = [];
      renderApiSyncLogs();
    });
  }

  // Drag-and-drop / File upload для стейтментов
  const dropzone = document.getElementById("sync-file-dropzone");
  const fileInput = document.getElementById("sync-report-file-input");
  const previewBox = document.getElementById("sync-file-preview-box");
  const previewTable = document.getElementById("sync-file-preview-table-container");
  const parsedCountEl = document.getElementById("sync-file-parsed-count");
  const parsedPnlEl = document.getElementById("sync-file-parsed-pnl");
  const confirmFileImportBtn = document.getElementById("btn-confirm-file-import");

  if (dropzone && fileInput) {
    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("dragover", (e) => {
      e.preventDefault();
      dropzone.style.borderColor = "#38bdf8";
      dropzone.style.background = "rgba(56, 189, 248, 0.1)";
    });
    dropzone.addEventListener("dragleave", () => {
      dropzone.style.borderColor = "#475569";
      dropzone.style.background = "rgba(15, 23, 42, 0.5)";
    });
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.style.borderColor = "#475569";
      dropzone.style.background = "rgba(15, 23, 42, 0.5)";
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFileSelection(e.dataTransfer.files[0]);
      }
    });
    fileInput.addEventListener("change", (e) => {
      if (fileInput.files && fileInput.files[0]) {
        handleFileSelection(fileInput.files[0]);
      }
    });
  }

  function handleFileSelection(file) {
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result;
      if (typeof content === "string") {
        parsedFileTradesPreview = parseStatementFile(content, file.name);
        if (parsedFileTradesPreview.length === 0) {
          if (typeof showToast === "function") showToast("В файле не найдено закрытых сделок", "warning");
          return;
        }

        const totalPnl = parsedFileTradesPreview.reduce((sum, t) => sum + (t.pnl || 0), 0);
        if (previewBox) previewBox.style.display = "flex";
        if (parsedCountEl) parsedCountEl.textContent = `Найдено сделок: ${parsedFileTradesPreview.length}`;
        if (parsedPnlEl) {
          parsedPnlEl.textContent = `Общий PnL: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`;
          parsedPnlEl.style.color = totalPnl >= 0 ? "#34d399" : "#f87171";
        }

        if (previewTable) {
          previewTable.innerHTML = `
            <table style="width: 100%; text-align: left; border-collapse: collapse;">
              <thead>
                <tr style="background: rgba(255,255,255,0.05); color: #94a3b8; font-size: 10px; text-transform: uppercase;">
                  <th style="padding: 6px 8px;">Тикет</th>
                  <th style="padding: 6px 8px;">Инструмент</th>
                  <th style="padding: 6px 8px;">Тип</th>
                  <th style="padding: 6px 8px;">Лот</th>
                  <th style="padding: 6px 8px; text-align: right;">PnL ($)</th>
                </tr>
              </thead>
              <tbody>
                ${parsedFileTradesPreview.slice(0, 10).map(t => `
                  <tr style="border-bottom: 1px solid rgba(255,255,255,0.03);">
                    <td style="padding: 5px 8px; font-family: monospace;">#${t.ticket}</td>
                    <td style="padding: 5px 8px; font-weight: 600;">${t.symbol}</td>
                    <td style="padding: 5px 8px; color: ${t.type === 'buy' ? '#34d399' : '#f87171'};">${t.type.toUpperCase()}</td>
                    <td style="padding: 5px 8px; font-family: monospace;">${t.size}</td>
                    <td style="padding: 5px 8px; text-align: right; font-weight: 700; color: ${t.pnl >= 0 ? '#34d399' : '#f87171'}; font-family: monospace;">
                      ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
            ${parsedFileTradesPreview.length > 10 ? `<div style="padding: 6px 8px; color: #64748b; text-align: center; font-size: 10px;">... и ещё ${parsedFileTradesPreview.length - 10} сделок</div>` : ''}
          `;
        }

        addApiSyncLog("File Import", "info", `Распознано ${parsedFileTradesPreview.length} сделок из файла ${file.name}`);
      }
    };
    reader.readAsText(file);
  }

  if (confirmFileImportBtn) {
    confirmFileImportBtn.addEventListener("click", async () => {
      if (!parsedFileTradesPreview || parsedFileTradesPreview.length === 0) return;
      
      const targetAcc = activeAccountId || (accounts[0] ? accounts[0].id : null);
      let imported = 0;
      parsedFileTradesPreview.forEach(t => {
        tradeHistory.push({
          ...t,
          account_id: targetAcc
        });
        imported++;
      });

      localStorage.setItem("plbt_trade_history", JSON.stringify(tradeHistory));
      try {
        await saveData("plbt_trade_history", tradeHistory);
      } catch (e) {}

      updateTradeHistoryUI();
      addApiSyncLog("File Import", "success", `Успешно добавлено ${imported} сделок в торговый журнал!`);
      if (typeof showToast === "function") showToast(`Добавлено ${imported} сделок в журнал!`, "success");
      
      if (previewBox) previewBox.style.display = "none";
      parsedFileTradesPreview = [];
      closeApiSyncModal();
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    loadCertificates();
    initCertificateModalEvents();
    initIndicatorCatalogEvents();
    initFibSettingsModalEvents();
    initSymbolSearchModalEvents();
    initApiSyncModalEvents();
  });
} else {
  loadCertificates();
  initCertificateModalEvents();
  initIndicatorCatalogEvents();
  initFibSettingsModalEvents();
  initSymbolSearchModalEvents();
  initApiSyncModalEvents();
}





