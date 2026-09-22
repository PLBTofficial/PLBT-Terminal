import {
  state, balance, setBalance, tradeHistory, setTradeHistory,
  heatmapCurrentDate, selectedHistoryDateStr, setSelectedHistoryDateStr,
  setSelectedHistoryTrades, showToast, isSoundEnabled, setIsSoundEnabled,
  currentNotesTradeId, setCurrentNotesTradeId, currentScreenshots, setCurrentScreenshots
} from "./state.js";
import { updateSimulatorUI, saveSimulatorState } from "./trading.js";
import { drawAllOnCanvas } from "./drawings.js";

// 1. VIEW SWITCHING (JOURNAL VS ANALYTICS TABS)
export function initViewTabs() {
  const journalBtn = document.getElementById("tab-btn-journal");
  const analyticsBtn = document.getElementById("tab-btn-analytics");
  const journalView = document.getElementById("view-journal-container");
  const analyticsView = document.getElementById("view-analytics-container");

  journalBtn?.addEventListener("click", () => {
    journalBtn.classList.add("active");
    analyticsBtn?.classList.remove("active");
    journalView?.classList.add("active");
    analyticsView?.classList.remove("active");
  });

  analyticsBtn?.addEventListener("click", () => {
    analyticsBtn.classList.add("active");
    journalBtn?.classList.remove("active");
    analyticsView?.classList.add("active");
    journalView?.classList.remove("active");
    
    setTimeout(() => {
      drawPnLEquityChart();
      renderHeatmapCalendar();
    }, 50);
  });
}

// 2. EQUITY CURVE (CANVAS PNL CHART)
export function drawPnLEquityChart() {
  const canvas = document.getElementById("pnl-equity-canvas");
  if (!canvas) return;

  const wrapper = canvas.parentElement;
  if (!wrapper) return;

  canvas.width = wrapper.clientWidth;
  canvas.height = wrapper.clientHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const points = [10000];
  let tempBalance = 10000;
  tradeHistory.forEach((trade) => {
    tempBalance += trade.pnl || 0;
    points.push(tempBalance);
  });

  const numPoints = points.length;
  if (numPoints < 2) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
    ctx.font = "11px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Недостаточно данных для графика. Совершите сделку.", canvas.width / 2, canvas.height / 2);
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

  for (let i = 0; i <= 5; i++) {
    const y = padding.top + (chartH / 5) * i;
    const val = maxVal - (valRange / 5) * i;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(canvas.width - padding.right, y);
    ctx.stroke();
    
    ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
    ctx.font = "9px monospace";
    ctx.textAlign = "right";
    ctx.fillText(`$${val.toFixed(0)}`, padding.left - 8, y + 3);
  }

  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((val, idx) => {
    const x = padding.left + (chartW / (numPoints - 1)) * idx;
    const y = padding.top + chartH * (1 - (val - minVal) / valRange);
    if (idx === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// 3. CALENDAR HEATMAP
export function renderHeatmapCalendar() {
  const container = document.getElementById("heatmap-grid-el");
  const monthYearLabel = document.getElementById("heatmap-month-label");
  if (!container || !monthYearLabel) return;

  container.innerHTML = "";

  const year = heatmapCurrentDate.getFullYear();
  const month = heatmapCurrentDate.getMonth();

  const monthsRu = [
    "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
    "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"
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
  tradeHistory.forEach((trade) => {
    const closeTimeStr = trade.closeTime || trade.timestamp;
    if (!closeTimeStr) return;
    const closeDate = new Date(closeTimeStr);
    if (closeDate.getFullYear() === year && closeDate.getMonth() === month) {
      const dayNum = closeDate.getDate();
      if (!tradesByDay[dayNum]) {
        tradesByDay[dayNum] = { pnl: 0, count: 0 };
      }
      tradesByDay[dayNum].pnl += trade.pnl || 0;
      tradesByDay[dayNum].count++;
    }
  });

  for (let day = 1; day <= numDays; day++) {
    const cell = document.createElement("div");
    cell.className = "heatmap-cell";
    cell.style.cursor = "pointer";

    const paddedMonth = String(month + 1).padStart(2, "0");
    const paddedDay = String(day).padStart(2, "0");
    const dateString = `${year}-${paddedMonth}-${paddedDay}`;

    if (selectedHistoryDateStr === dateString) {
      cell.classList.add("selected");
      cell.style.boxShadow = "0 0 0 2px #3b82f6 inset";
    }

    const dayLabel = document.createElement("span");
    dayLabel.className = "day-num";
    dayLabel.textContent = day;
    cell.appendChild(dayLabel);

    const dayData = tradesByDay[day];
    if (dayData) {
      const dailyPnl = dayData.pnl;
      const pnlSign = dailyPnl >= 0 ? "+" : "";
      const pnlStr = `${pnlSign}$${dailyPnl.toFixed(1)}`;

      if (dailyPnl > 0) cell.classList.add("profit");
      else if (dailyPnl < 0) cell.classList.add("loss");

      const valBadge = document.createElement("span");
      valBadge.className = "day-val";
      valBadge.textContent = pnlStr;
      cell.appendChild(valBadge);
    } else {
      cell.classList.add("no-activity");
    }

    cell.addEventListener("click", () => {
      setSelectedHistoryDateStr(dateString);
      setSelectedHistoryTrades(tradeHistory.filter(t => {
        const d = new Date(t.closeTime || t.timestamp);
        return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day;
      }));
      renderHeatmapCalendar();
      drawAllOnCanvas();
    });

    container.appendChild(cell);
  }
}

export function initHeatmapNavigation() {
  const prevBtn = document.getElementById("heatmap-prev-month");
  const nextBtn = document.getElementById("heatmap-next-month");

  prevBtn?.addEventListener("click", () => {
    heatmapCurrentDate.setMonth(heatmapCurrentDate.getMonth() - 1);
    renderHeatmapCalendar();
  });

  nextBtn?.addEventListener("click", () => {
    heatmapCurrentDate.setMonth(heatmapCurrentDate.getMonth() + 1);
    renderHeatmapCalendar();
  });
}

// 4. SETTINGS GEAR
export function initSettingsMenu() {
  const settingsToggleBtn = document.getElementById("settings-toggle-btn");
  const settingsDropdown = document.getElementById("settings-dropdown");
  const toggleSoundEffects = document.getElementById("toggle-sound-effects");

  if (settingsToggleBtn && settingsDropdown) {
    settingsToggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const isVisible = settingsDropdown.style.display === "block";
      settingsDropdown.style.display = isVisible ? "none" : "block";
    });

    document.addEventListener("click", (e) => {
      if (settingsDropdown.style.display === "block" && !settingsDropdown.contains(e.target) && e.target !== settingsToggleBtn) {
        settingsDropdown.style.display = "none";
      }
    });
  }

  if (toggleSoundEffects) {
    toggleSoundEffects.checked = isSoundEnabled;
    toggleSoundEffects.addEventListener("change", (e) => {
      setIsSoundEnabled(e.target.checked);
      showToast(`Звуковые эффекты ${e.target.checked ? "включены" : "выключены"}`, "info");
    });
  }
}
