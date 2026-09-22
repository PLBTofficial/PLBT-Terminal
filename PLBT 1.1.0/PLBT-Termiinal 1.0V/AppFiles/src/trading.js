import { candlestickSeries } from "./chart.js";
import {
  state, balance, setBalance, tradeHistory, setTradeHistory,
  playSound, updateConnectionStatus, showToast, drawings, setDrawings
} from "./state.js";
import { drawAllOnCanvas, getBarSpacing } from "./drawings.js";

// Keep UI loaded overlay elements references handy
const loadingOverlay = document.getElementById("loading-overlay");
const loadingStatus = document.getElementById("loading-status");
const dbLatency = document.getElementById("db-latency");

export function updateSimulatorUI() {
  const footerBalance = document.getElementById("footer-balance");
  const capitalInput = document.getElementById("capital-input");
  const positionsList = document.getElementById("positions-list");

  if (footerBalance) {
    footerBalance.textContent = `$${balance.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
  }
  if (capitalInput) {
    capitalInput.value = balance.toFixed(2);
  }

  if (!positionsList) return;

  if (state.positions.length === 0) {
    positionsList.innerHTML = '<div class="no-positions">У вас нет открытых позиций</div>';
    return;
  }

  positionsList.innerHTML = "";
  state.positions.forEach((pos) => {
    const isJpy = state.symbol.endsWith("JPY") || state.symbol.includes("JPY");
    const decimals = isJpy ? 3 : 5;

    if (pos.status === "draft") {
      const posEl = document.createElement("div");
      posEl.className = "position-item draft-order";
      posEl.style.border = "1px dashed var(--color-warning)";
      posEl.style.background = "rgba(245, 158, 11, 0.05)";
      posEl.innerHTML = `
        <div class="position-header">
            <span class="position-symbol-badge">${pos.symbol.replace("_", "/")}</span>
            <span class="position-type ${pos.type}" style="background-color: var(--color-warning); color: #000000; padding: 2px 6px; border-radius: 3px; font-weight: bold; font-size: 10px;">DRAFT ${pos.orderType ? pos.orderType.toUpperCase() : "MARKET"} ${pos.type.toUpperCase()}</span>
            <button class="close-pos-btn" onclick="window.closePosition(${pos.id})">Отмена</button>
        </div>
        <div class="position-details">
            <div class="position-row"><span>Цена входа:</span><span>${pos.entryPrice.toFixed(decimals)}</span></div>
            <div class="position-row"><span>Объем:</span><span>${pos.size} L</span></div>
            <div class="position-row" style="margin-top: 6px;">
                <span>TP:</span>
                <input type="number" step="0.0001" id="pos-tp-input-${pos.id}" class="pos-tp-input" value="${pos.takeProfit ? pos.takeProfit.toFixed(decimals) : ""}" onchange="window.updatePositionTPSL(${pos.id}, 'tp', this.value)" style="width: 75px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 2px 4px; border-radius: 3px; font-size: 11px;">
            </div>
            <div class="position-row">
                <span>SL:</span>
                <input type="number" step="0.0001" id="pos-sl-input-${pos.id}" class="pos-sl-input" value="${pos.stopLoss ? pos.stopLoss.toFixed(decimals) : ""}" onchange="window.updatePositionTPSL(${pos.id}, 'sl', this.value)" style="width: 75px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 2px 4px; border-radius: 3px; font-size: 11px;">
            </div>
            <div style="margin-top: 8px; display: flex; gap: 6px; grid-column: span 2;">
                <button onclick="window.confirmDraftOrder(${pos.id})" style="flex: 1; height: 26px; border: none; background: #0f9d58; color: white; border-radius: 4px; font-weight: bold; font-size: 11px; cursor: pointer;">Подтвердить</button>
            </div>
        </div>
      `;
      positionsList.appendChild(posEl);
      return;
    }

    let currPrice = pos.entryPrice;
    const arr = state.isBacktestActive ? state.backtestVisibleCandles : state.historicalCandles;
    if (arr.length > 0) currPrice = arr[arr.length - 1].close;
    let pnl = 0;
    const units = pos.size * 100000;
    if (pos.type === "buy") {
      pnl = (currPrice - pos.entryPrice) * units;
    } else {
      pnl = (pos.entryPrice - currPrice) * units;
    }
    if (pos.symbol.endsWith("JPY") || pos.symbol.includes("JPY")) {
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
          <button class="close-pos-btn" onclick="window.closePosition(${pos.id})">Закрыть</button>
      </div>
      <div class="position-details">
          <div class="position-row"><span>Вход:</span><span>${pos.entryPrice.toFixed(decimals)}</span></div>
          <div class="position-row"><span>Объем:</span><span>${pos.size} L</span></div>
          <div class="position-row" style="margin-top: 6px;">
              <span>TP:</span>
              <input type="number" step="0.0001" id="pos-tp-input-${pos.id}" class="pos-tp-input" value="${pos.takeProfit ? pos.takeProfit.toFixed(decimals) : ""}" onchange="window.updatePositionTPSL(${pos.id}, 'tp', this.value)" style="width: 75px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 2px 4px; border-radius: 3px; font-size: 11px;">
          </div>
          <div class="position-row">
              <span>SL:</span>
              <input type="number" step="0.0001" id="pos-sl-input-${pos.id}" class="pos-sl-input" value="${pos.stopLoss ? pos.stopLoss.toFixed(decimals) : ""}" onchange="window.updatePositionTPSL(${pos.id}, 'sl', this.value)" style="width: 75px; background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); color: #fff; padding: 2px 4px; border-radius: 3px; font-size: 11px;">
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

export function saveSimulatorState() {
  localStorage.setItem("balance", balance.toString());
  localStorage.setItem("oanda_sim_positions", JSON.stringify(state.positions));
  localStorage.setItem("plbt_trade_history", JSON.stringify(tradeHistory));
}

// REALTIME MT5 LOADING AND POLLING
export async function loadDemoData() {
  state.isFileLoaded = false;
  updateConnectionStatus("Подключение к MT5...", "demo");
  const badge = document.getElementById("instrument-exchange");
  if (badge) badge.textContent = "MT5 Terminal";
  
  try {
    const cleanSymbol = state.symbol.replace("_", "");
    const tf = state.timeframe;
    
    // Вот правильный URL и запрос данных
    const url = `http://127.0.0.1:8000/history?symbol=${cleanSymbol}&timeframe=${tf}&count=20000`;
    const res = await fetch(url);
    const data = await res.json();
    
    if (data && data.status === "ok" && data.candles && data.candles.length > 0) {
      const candles = data.candles;
      state.historicalCandles = candles;
      candlestickSeries.setData(candles);
      
      const lastCandle = candles[candles.length - 1];
      const o = lastCandle.open.toFixed(5);
      const h = lastCandle.high.toFixed(5);
      const l = lastCandle.low.toFixed(5);
      const c = lastCandle.close.toFixed(5);
      
      const elO = document.getElementById("val-o");
      const elH = document.getElementById("val-h");
      const elL = document.getElementById("val-l");
      const elC = document.getElementById("val-c");
      if (elO) elO.textContent = o;
      if (elH) elH.textContent = h;
      if (elL) elL.textContent = l;
      if (elC) elC.textContent = c;

      const headerLastPrice = document.getElementById("price-display");
      if (headerLastPrice) {
        headerLastPrice.textContent = c;
      }
      
      updateConnectionStatus("ONLINE (MT5)", "active");
      if (dbLatency) dbLatency.textContent = "MT5 Bridge";
      
      if (loadingOverlay) loadingOverlay.classList.add("hidden");
      drawAllOnCanvas();
      
      // Auto-recenter
      chart.timeScale().resetTimeScale();
      chart.timeScale().fitContent();
      return;
    }
  } catch (err) {
    console.log("MT5 History fetch failed. Fallback to waiting state...", err);
  }
  
  updateConnectionStatus("Ожидание MT5...", "demo");
  if (dbLatency) dbLatency.textContent = "—";
  if (loadingOverlay) {
    loadingOverlay.classList.remove("hidden");
    loadingStatus.textContent = "Запустите МТ5 и скрипт mt5_bridge.py для получения реальных котировок...";
  }
}

let liveInterval = null;
console.log("%c[PLBT] build tag: v2-live-candle-fix (trading.js)", "color:#10b981;font-weight:bold;font-size:14px");

// Длительность таймфреймов в минутах — нужна, чтобы понимать, когда текущий бар
// закончился и должна начаться НОВАЯ свеча, а не бесконечная мутация последней.
const TIMEFRAME_MINUTES = {
  "1m": 1, "3m": 3, "5m": 5, "10m": 10, "15m": 15, "30m": 30,
  "1h": 60, "2h": 120, "4h": 240, "8h": 480, "10h": 600,
  "1d": 1440, "2d": 2880, "4d": 5760, "8d": 11520, "10d": 14400,
};

function getCurrentBucketTime(timeframe) {
  const minutes = TIMEFRAME_MINUTES[timeframe] || 15;
  const bucketSeconds = minutes * 60;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return Math.floor(nowSeconds / bucketSeconds) * bucketSeconds;
}

export function startRealtimePolling() {
  if (liveInterval) clearInterval(liveInterval);
  liveInterval = setInterval(async () => {
    if (state.isBacktestActive) return;
    
    if (state.historicalCandles.length === 0) {
      await loadDemoData();
      return;
    }
    
    const len = state.historicalCandles.length;
    const last = state.historicalCandles[len - 1];
    
    try {
      const cleanSymbol = state.symbol.replace("_", "");
      const res = await fetch(`http://localhost:8000/?symbol=${cleanSymbol}`);
      const data = await res.json();
      
      if (data && data.status === "ok") {
        const realPrice = data.last || (data.bid + data.ask) / 2;
        const roundedPrice = parseFloat(realPrice.toFixed(5));

        // Проверяем, не пора ли начинать НОВУЮ свечу (текущий бакет времени ушёл вперёд),
        // вместо того чтобы бесконечно переписывать закрытую свечу из истории.
        const currentBucketTime = getCurrentBucketTime(state.timeframe);

        let updated;
        if (currentBucketTime > last.time) {
          updated = {
            time: currentBucketTime,
            open: roundedPrice,
            high: roundedPrice,
            low: roundedPrice,
            close: roundedPrice,
          };
          state.historicalCandles.push(updated);
        } else {
          updated = {
            ...last,
            close: roundedPrice,
            high: parseFloat(Math.max(last.high, roundedPrice).toFixed(5)),
            low: parseFloat(Math.min(last.low, roundedPrice).toFixed(5)),
          };
          state.historicalCandles[len - 1] = updated;
        }
        candlestickSeries.update(updated);
        
        // Update price tickers
        const headerLastPrice = document.getElementById("price-display");
        if (headerLastPrice) {
          headerLastPrice.textContent = realPrice.toFixed(5);
          headerLastPrice.style.color = realPrice >= last.open ? "#10b981" : "#ef4444";
        }
        const buyBtnPrice = document.getElementById("buy-btn-price");
        const sellBtnPrice = document.getElementById("sell-btn-price");
        if (buyBtnPrice) buyBtnPrice.textContent = realPrice.toFixed(5);
        if (sellBtnPrice) sellBtnPrice.textContent = realPrice.toFixed(5);

        const fBuyPrice = document.getElementById("floating-buy-price");
        const fSellPrice = document.getElementById("floating-sell-price");
        if (fBuyPrice) fBuyPrice.textContent = realPrice.toFixed(5);
        if (fSellPrice) fSellPrice.textContent = realPrice.toFixed(5);
        
        checkPendingOrders(updated);
        updateSimulatorUI();
        updateConnectionStatus("ONLINE (MT5)", "active");
        if (loadingOverlay) loadingOverlay.classList.add("hidden");
      } else {
        updateConnectionStatus("Ожидание MT5...", "demo");
      }
    } catch (err) {
      updateConnectionStatus("Ожидание MT5...", "demo");
    }
  }, 1000);
}

function checkPendingOrders(candle) {
  if (!candle) return;
  checkTPSLHit(candle);
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
        if (pos.symbol.endsWith("JPY") || pos.symbol.includes("JPY")) {
          pnl = pnl / hitPrice;
        }

        setBalance(balance + pnl);

        tradeHistory.push({
          id: pos.id,
          symbol: pos.symbol,
          type: pos.type,
          entryPrice: pos.entryPrice,
          exitPrice: hitPrice,
          size: pos.size,
          leverage: pos.leverage || 100,
          commission: pos.commission || 0,
          pnl: pnl,
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
        
        localStorage.setItem("plbt_trade_history", JSON.stringify(tradeHistory));
        state.positions.splice(i, 1);
        changed = true;
        showToast(`Позиция закрыта по ${hitType} на цене ${hitPrice.toFixed(5)}! PnL: $${pnl.toFixed(2)}`, "success");
      }
    }
  }
  
  if (changed) {
    saveSimulatorState();
    updateSimulatorUI();
    drawAllOnCanvas();
  }
}

window.closePosition = (id) => {
  const idx = state.positions.findIndex((p) => p.id === id);
  if (idx === -1) return;
  const pos = state.positions[idx];
  playSound("close");
  
  if (pos.status === "pending" || pos.status === "draft") {
    if (pos.commission) {
      setBalance(balance + pos.commission);
    }
    state.positions.splice(idx, 1);
    saveSimulatorState();
    updateSimulatorUI();
    drawAllOnCanvas();
    showToast(pos.status === "draft" ? "Черновик ордера отменен!" : "Отложенный ордер отменен!", "info");
    return;
  }
  
  const arr = state.isBacktestActive ? state.backtestVisibleCandles : state.historicalCandles;
  const price = arr.length > 0 ? arr[arr.length - 1].close : pos.entryPrice;
  const closingCandleTime = arr.length > 0 ? arr[arr.length - 1].time : undefined;
  
  let pnl = 0;
  const units = pos.size * 100000;
  if (pos.type === "buy") {
    pnl = (price - pos.entryPrice) * units;
  } else {
    pnl = (pos.entryPrice - price) * units;
  }
  if (pos.symbol.endsWith("JPY") || pos.symbol.includes("JPY")) {
    pnl = pnl / price;
  }
  
  setBalance(balance + pnl);
  
  tradeHistory.push({
    id: pos.id,
    symbol: pos.symbol,
    type: pos.type,
    size: pos.size,
    leverage: pos.leverage,
    commission: pos.commission,
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
  });
  
  localStorage.setItem("plbt_trade_history", JSON.stringify(tradeHistory));
  state.positions.splice(idx, 1);
  saveSimulatorState();
  updateSimulatorUI();
  drawAllOnCanvas();
  showToast(`Позиция закрыта! Результат: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`, pnl >= 0 ? "success" : "error");
};

window.confirmDraftOrder = (id) => {
  const pos = state.positions.find((p) => p.id === id);
  if (!pos) return;

  const isJpy = state.symbol.endsWith("JPY") || state.symbol.includes("JPY");
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

export function placeOrder(type) {
  const arr = state.isBacktestActive ? state.backtestVisibleCandles : state.historicalCandles;
  if (!arr || arr.length === 0) {
    showToast("Пожалуйста, подождите загрузки котировок!", "error");
    return;
  }
  const candle = arr[arr.length - 1];
  const price = candle.close;
  const size = parseFloat(document.getElementById("volume-input").value) || 1.0;
  const leverage = parseInt(document.getElementById("leverage-input").value) || 100;
  const commission = size * state.commissionPerLot;
  const requiredMargin = (size * 100000 * price) / leverage;
  let marginUSD = state.symbol.endsWith("JPY") ? requiredMargin / price : requiredMargin;

  if (marginUSD + commission > balance) {
    showToast("Недостаточно средств для сделки!", "error");
    return;
  }

  setBalance(balance - commission);

  const isJpy = state.symbol.endsWith("JPY") || state.symbol.includes("JPY");
  const pipStep = isJpy ? 0.100 : 0.00100;
  const decimals = isJpy ? 3 : 5;

  const takeProfit = type === "buy" ? price + pipStep : price - pipStep;
  const stopLoss = type === "buy" ? price - pipStep : price + pipStep;

  state.positions.push({
    id: Date.now(),
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
    takeProfit: parseFloat(takeProfit.toFixed(decimals)),
    tp: parseFloat(takeProfit.toFixed(decimals)),
    stopLoss: parseFloat(stopLoss.toFixed(decimals)),
    sl: parseFloat(stopLoss.toFixed(decimals)),
    notes: { noteBefore: "", noteDuring: "", noteAfter: "" }
  });

  saveSimulatorState();
  updateSimulatorUI();
  drawAllOnCanvas();
  showToast(`Создан черновик ордера ${type.toUpperCase()}. Пожалуйста, подтвердите его.`, "success");
}

// BACKTEST REPLAY CONTROLLER LOGIC (Audio Gear style)
let backtestInterval = null;
let backtestSpeedMs = 1000;

function flashVUMeter() {
  const segments = document.querySelectorAll(".vu-segment");
  if (!segments || segments.length === 0) return;
  const litCount = Math.floor(Math.random() * 8) + 2; // randomly light up 2-9 segments
  segments.forEach((seg, idx) => {
    if (idx < litCount) {
      seg.classList.add("active");
    } else {
      seg.classList.remove("active");
    }
  });
  setTimeout(() => {
    segments.forEach(seg => seg.classList.remove("active"));
  }, 120);
}

export function updateBacktestUIDisplays() {
  const counterDisplay = document.getElementById("tape-counter");
  if (counterDisplay) {
    const total = state.historicalCandles.length;
    const current = state.currentReplayIndex || 0;
    const currentStr = current.toString().padStart(4, "0");
    const totalStr = total.toString().padStart(4, "0");
    counterDisplay.textContent = `${currentStr} / ${totalStr}`;
  }
}

export function stepBacktestForward() {
  if (!state.isBacktestActive) return;
  if (!state.backtestFutureCandles || state.backtestFutureCandles.length === 0) {
    showToast("Конец истории бэктеста!", "warning");
    pauseBacktest();
    return;
  }

  const nextCandle = state.backtestFutureCandles.shift();
  state.backtestVisibleCandles.push(nextCandle);
  state.currentReplayIndex++;

  candlestickSeries.update(nextCandle);

  const o = nextCandle.open.toFixed(5);
  const h = nextCandle.high.toFixed(5);
  const l = nextCandle.low.toFixed(5);
  const c = nextCandle.close.toFixed(5);

  const elO = document.getElementById("val-o");
  const elH = document.getElementById("val-h");
  const elL = document.getElementById("val-l");
  const elC = document.getElementById("val-c");
  if (elO) elO.textContent = o;
  if (elH) elH.textContent = h;
  if (elL) elL.textContent = l;
  if (elC) elC.textContent = c;

  const headerLastPrice = document.getElementById("price-display");
  if (headerLastPrice) {
    headerLastPrice.textContent = c;
    const prevC = state.backtestVisibleCandles.length > 1 ? state.backtestVisibleCandles[state.backtestVisibleCandles.length - 2].close : nextCandle.open;
    headerLastPrice.style.color = nextCandle.close >= prevC ? "#10b981" : "#ef4444";
  }

  const buyBtnPrice = document.getElementById("buy-btn-price");
  const sellBtnPrice = document.getElementById("sell-btn-price");
  if (buyBtnPrice) buyBtnPrice.textContent = c;
  if (sellBtnPrice) sellBtnPrice.textContent = c;

  checkPendingOrders(nextCandle);
  updateSimulatorUI();
  updateBacktestUIDisplays();
  drawAllOnCanvas();
  flashVUMeter();
}

export function playBacktest() {
  if (!state.isBacktestActive) return;
  if (backtestInterval) return;

  const statusText = document.getElementById("tape-status-text");
  if (statusText) statusText.textContent = "TAPE PLAYING";

  document.getElementById("led-play")?.classList.add("active");
  document.getElementById("led-ready")?.classList.remove("active");

  backtestInterval = setInterval(() => {
    stepBacktestForward();
  }, backtestSpeedMs);

  const playIcon = document.getElementById("play-icon");
  if (playIcon) {
    playIcon.setAttribute("data-lucide", "pause");
    playIcon.style.color = "#eab308";
    if (window.lucide) window.lucide.createIcons();
  }
}

export function pauseBacktest() {
  if (!state.isBacktestActive) return;
  if (!backtestInterval) return;

  clearInterval(backtestInterval);
  backtestInterval = null;

  const statusText = document.getElementById("tape-status-text");
  if (statusText) statusText.textContent = "TAPE PAUSED";

  document.getElementById("led-play")?.classList.remove("active");
  document.getElementById("led-ready")?.classList.add("active");

  const playIcon = document.getElementById("play-icon");
  if (playIcon) {
    playIcon.setAttribute("data-lucide", "play");
    playIcon.style.color = "#10b981";
    if (window.lucide) window.lucide.createIcons();
  }
}

export function resetBacktest() {
  if (!state.isBacktestActive) return;
  pauseBacktest();

  const splitIndex = Math.min(300, Math.floor(state.historicalCandles.length * 0.4));
  state.backtestVisibleCandles = state.historicalCandles.slice(0, splitIndex);
  state.backtestFutureCandles = state.historicalCandles.slice(splitIndex);
  state.currentReplayIndex = splitIndex;

  candlestickSeries.setData(state.backtestVisibleCandles);
  chart.timeScale().resetTimeScale();
  chart.timeScale().fitContent();

  showToast("История сброшена к начальной точке.", "info");

  updateBacktestUIDisplays();
  updateSimulatorUI();
  drawAllOnCanvas();
}

export function setBacktestSpeed(speedMs) {
  backtestSpeedMs = speedMs;
  if (backtestInterval) {
    pauseBacktest();
    playBacktest();
  }
}

export function toggleBacktestMode() {
  if (!state.historicalCandles || state.historicalCandles.length === 0) {
    showToast("Нет свечей для бэктеста! Сначала загрузите историю.", "error");
    return false;
  }

  const btnReset = document.getElementById("btn-backtest-reset");
  const btnPlay = document.getElementById("btn-backtest-play");
  const btnStep = document.getElementById("btn-backtest-step");
  const toggleBtn = document.getElementById("btn-backtest-toggle");

  if (state.isBacktestActive) {
    // Turn off
    state.isBacktestActive = false;
    pauseBacktest();

    // Disable buttons
    if (btnReset) btnReset.disabled = true;
    if (btnPlay) btnPlay.disabled = true;
    if (btnStep) btnStep.disabled = true;
    if (toggleBtn) {
      toggleBtn.classList.remove("active");
      toggleBtn.style.background = "";
      toggleBtn.style.borderColor = "";
      toggleBtn.style.color = "";
    }

    // Restore full historical candles
    candlestickSeries.setData(state.historicalCandles);
    showToast("Бэктест отключен. Возврат в реальное время.", "info");
    updateConnectionStatus("ONLINE (MT5)", "active");

    const statusText = document.getElementById("tape-status-text");
    const counterDisplay = document.getElementById("tape-counter");
    if (statusText) statusText.textContent = "TAPE STOPPED";
    if (counterDisplay) counterDisplay.textContent = "0000 / 0000";

    document.getElementById("led-play")?.classList.remove("active");
    document.getElementById("led-ready")?.classList.add("active");

    updateSimulatorUI();
    drawAllOnCanvas();
    return false;
  } else {
    // Turn on
    state.isBacktestActive = true;

    // Enable buttons
    if (btnReset) btnReset.disabled = false;
    if (btnPlay) btnPlay.disabled = false;
    if (btnStep) btnStep.disabled = false;
    if (toggleBtn) {
      toggleBtn.classList.add("active");
    }

    const splitIndex = Math.min(300, Math.floor(state.historicalCandles.length * 0.4));
    state.backtestVisibleCandles = state.historicalCandles.slice(0, splitIndex);
    state.backtestFutureCandles = state.historicalCandles.slice(splitIndex);
    state.currentReplayIndex = splitIndex;

    candlestickSeries.setData(state.backtestVisibleCandles);
    chart.timeScale().resetTimeScale();
    chart.timeScale().fitContent();

    showToast("Бэктест активирован! Управляйте магнитофоном.", "success");
    updateConnectionStatus("BACKTEST", "demo");

    const statusText = document.getElementById("tape-status-text");
    if (statusText) statusText.textContent = "TAPE PAUSED";

    document.getElementById("led-ready")?.classList.add("active");

    updateBacktestUIDisplays();
    updateSimulatorUI();
    drawAllOnCanvas();
    return true;
  }
}

// Bind to window for easy inline or external triggers
window.toggleBacktestMode = toggleBacktestMode;
window.stepBacktestForward = stepBacktestForward;
window.playBacktest = playBacktest;
window.pauseBacktest = pauseBacktest;
window.resetBacktest = resetBacktest;
window.setBacktestSpeed = setBacktestSpeed;

