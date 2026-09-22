import { chart, candlestickSeries } from "./chart.js";
import {
  state, drawings, activeColor, hoveredObject, activeSelectedObject,
  selectedHistoryTrades, hoveredHistTradeId, activeOrders, openPositions,
  isDrawingBrush, currentBrushPath, isDrawingLineOrRect, tempDrawing
} from "./state.js";

const container = document.getElementById("chart-viewport");
const canvas = document.getElementById("drawing-canvas");

let cachedPlotArea = null;
let cachedContainerRect = null;
let cachedContainerWidth = 0;
let cachedContainerHeight = 0;

export function invalidateCachedDimensions() {
  cachedPlotArea = null;
  cachedContainerRect = null;
  if (container) {
    cachedContainerWidth = container.clientWidth;
    cachedContainerHeight = container.clientHeight;
  }
}

export function updateCachedDimensions() {
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

export function getBarSpacing() {
  try {
    const opt = chart.timeScale().options();
    if (opt && typeof opt.barSpacing === "number") {
      return opt.barSpacing;
    }
  } catch (e) {}
  return 10;
}

export function getChartPlotArea() {
  if (!cachedPlotArea) {
    updateCachedDimensions();
  }
  return cachedPlotArea;
}

export const OHLC_BAR_HEIGHT = 40;

export function getOHLCBottomY() {
  const plotArea = getChartPlotArea();
  return plotArea ? plotArea.top + OHLC_BAR_HEIGHT : OHLC_BAR_HEIGHT;
}

export function getDrawingTopBoundary() {
  return getOHLCBottomY();
}

export function getCandleTimeVal(time) {
  if (time === null || time === undefined) return 0;
  if (typeof time === "number") return time;
  if (typeof time === "string") {
    const parsed = Date.parse(time);
    return isNaN(parsed) ? 0 : parsed;
  }
  if (typeof time === "object") {
    if (typeof time.year === "number" && typeof time.month === "number" && typeof time.day === "number") {
      return new Date(time.year, time.month - 1, time.day).getTime() / 1000;
    }
  }
  return 0;
}

export function findCandleByTime(arr, targetTime) {
  if (!arr || arr.length === 0) return null;
  const targetVal = getCandleTimeVal(targetTime);
  let left = 0;
  let right = arr.length - 1;
  while (left <= right) {
    const mid = (left + right) >> 1;
    const midVal = getCandleTimeVal(arr[mid].time);
    if (midVal === targetVal) {
      return arr[mid];
    } else if (midVal < targetVal) {
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  return null;
}

export function getPointFromCoords(mouseX, mouseY) {
  const arr = state.isBacktestActive ? state.backtestVisibleCandles : state.historicalCandles;
  if (!arr || arr.length === 0) return null;
  let time = chart.timeScale().coordinateToTime(mouseX);
  let price = candlestickSeries.coordinateToPrice(mouseY);
  if (price === null) {
    const cHeight = canvas ? canvas.height : 600;
    price = candlestickSeries.coordinateToPrice(Math.max(0, Math.min(cHeight, mouseY)));
    if (price === null) price = arr[arr.length - 1].close;
  }
  let baseCandle = null;
  if (time !== null) {
    baseCandle = findCandleByTime(arr, time);
  }
  if (!baseCandle) {
    let left = 0;
    let right = arr.length - 1;
    let nearestCandle = arr[arr.length - 1];
    let minDst = Infinity;

    const visibleRange = chart.timeScale().getVisibleRange();

    while (left <= right) {
      const mid = (left + right) >> 1;
      const t = arr[mid].time;
      const cx = chart.timeScale().timeToCoordinate(t);
      if (cx === null) {
        if (visibleRange) {
          const midVal = getCandleTimeVal(t);
          const fromVal = getCandleTimeVal(visibleRange.from);
          const toVal = getCandleTimeVal(visibleRange.to);
          if (midVal < fromVal) {
            left = mid + 1;
          } else if (midVal > toVal) {
            right = mid - 1;
          } else {
            left = mid + 1;
          }
        } else {
          left = mid + 1;
        }
      } else {
        const dst = Math.abs(cx - mouseX);
        if (dst < minDst) {
          minDst = dst;
          nearestCandle = arr[mid];
        }
        if (cx < mouseX) {
          left = mid + 1;
        } else {
          right = mid - 1;
        }
      }
    }
    baseCandle = nearestCandle;
    time = baseCandle.time;
  }
  const candleX = chart.timeScale().timeToCoordinate(baseCandle.time);
  const spacing = getBarSpacing();
  const offsetXFraction = candleX !== null ? (mouseX - candleX) / spacing : 0;
  return { time, price, offsetXFraction };
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

function drawHandle(ctx, x, y, shapeType, color) {
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = color || "#3b82f6";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (shapeType === "circle") {
    ctx.arc(x, y, 4.5, 0, 2 * Math.PI);
  } else {
    ctx.rect(x - 4, y - 4, 8, 8);
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

let rafPending = false;
export function requestDrawAllOnCanvas() {
  if (!rafPending) {
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      drawAllOnCanvas();
    });
  }
}

export function drawAllOnCanvas() {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

  renderDrawings(ctx);
  drawHistoricalTradesOnCanvas(ctx);
  drawOHLCChOnCanvas(ctx);
}

function drawOHLCChOnCanvas(ctx) {
  const plotArea = getChartPlotArea();
  if (!plotArea) return;

  let candle = window.canvasCurrentCandle;
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

  let chText = "—";
  let chColor = "#ffffff";
  if (typeof candle.open === "number" && typeof candle.close === "number") {
    const diff = candle.close - candle.open;
    const pct = (diff / candle.open) * 100;
    const sign = diff >= 0 ? "+" : "";
    chText = `${sign}${diff.toFixed(5)} (${sign}${pct.toFixed(2)}%)`;
    chColor = diff >= 0 ? "#10b981" : "#ef4444";
  }

  ctx.save();
  ctx.font = "bold 11px 'JetBrains Mono', 'Fira Code', monospace";
  ctx.textBaseline = "top";

  let x = plotArea.left + 12;
  const y = plotArea.top + 10;

  const drawField = (label, value, valueColor) => {
    // Draw Label
    ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
    ctx.fillText(label, x, y);
    x += ctx.measureText(label).width + 4;

    // Draw Value
    ctx.fillStyle = valueColor;
    ctx.fillText(value, x, y);
    x += ctx.measureText(value).width + 16;
  };

  drawField("O", o, "#ffffff");
  drawField("H", h, "#ffffff");
  drawField("L", l, "#ffffff");
  drawField("C", c, "#ffffff");
  drawField("Ch", chText, chColor);

  ctx.restore();
}

function renderDrawings(ctx) {
  const plotArea = getChartPlotArea();
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotArea.left, plotArea.top, plotArea.width, plotArea.height);
  ctx.clip();

  // Brush paths
  drawings.brushPaths.forEach((path) => {
    if (path.points.length < 1) return;
    ctx.beginPath();
    ctx.strokeStyle = path.color || "#3b82f6";
    ctx.lineWidth = path.width || 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const pts = [];
    path.points.forEach((pt) => {
      const candleX = chart.timeScale().timeToCoordinate(pt.time);
      const y = candlestickSeries.priceToCoordinate(pt.price);
      if (candleX !== null && y !== null) {
        const x = candleX + (pt.offsetXFraction || 0) * getBarSpacing();
        pts.push({ x, y });
      }
    });
    if (pts.length > 0) {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
    }
    ctx.stroke();
  });

  // Active drawings
  if (isDrawingBrush && currentBrushPath && currentBrushPath.points.length >= 1) {
    ctx.beginPath();
    ctx.strokeStyle = currentBrushPath.color;
    ctx.lineWidth = currentBrushPath.width;
    ctx.lineCap = "round";
    const pts = [];
    currentBrushPath.points.forEach((pt) => {
      const candleX = chart.timeScale().timeToCoordinate(pt.time);
      const y = candlestickSeries.priceToCoordinate(pt.price);
      if (candleX !== null && y !== null) {
        pts.push({ x: candleX + (pt.offsetXFraction || 0) * getBarSpacing(), y });
      }
    });
    if (pts.length > 0) {
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    }
    ctx.stroke();
  }

  // Horizontal Lines
  drawings.horizontalLines.forEach((line, idx) => {
    const y = candlestickSeries.priceToCoordinate(line.price);
    if (y !== null) {
      ctx.beginPath();
      ctx.strokeStyle = line.color || "#3b82f6";
      ctx.lineWidth = (activeSelectedObject && activeSelectedObject.type === "hline" && activeSelectedObject.index === idx) ? 2.5 : 1.5;
      ctx.moveTo(0, y);
      ctx.lineTo(plotArea.right, y);
      ctx.stroke();

      ctx.fillStyle = line.color || "#3b82f6";
      ctx.font = "10px Inter, sans-serif";
      ctx.fillText(`— ${line.price.toFixed(5)}`, plotArea.right + 4, y + 3);
    }
  });

  // Wait / Expectation Trigger Levels
  if (drawings.waitLevels) {
    drawings.waitLevels.forEach((level, idx) => {
      const y = candlestickSeries.priceToCoordinate(level.price);
      if (y !== null) {
        const isSelected = activeSelectedObject && activeSelectedObject.type === "wait_level" && activeSelectedObject.index === idx;
        const isHovered = typeof hoveredObject !== "undefined" && hoveredObject && hoveredObject.type === "wait_level" && hoveredObject.index === idx;
        ctx.save();
        ctx.beginPath();
        ctx.strokeStyle = level.color || "#f59e0b";
        ctx.lineWidth = isSelected || isHovered ? 2.5 : 1.75;
        ctx.setLineDash([8, 4]);
        ctx.moveTo(0, y);
        ctx.lineTo(plotArea.right, y);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = level.color || "#f59e0b";
        ctx.font = "bold 10px Inter, sans-serif";
        ctx.fillText(`⏩ ${level.price.toFixed(5)}`, plotArea.right - 85, y - 6);
        ctx.restore();
      }
    });
  }

  // Trend Lines
  drawings.lines.forEach((line, idx) => {
    const startX = chart.timeScale().timeToCoordinate(line.startPoint.time);
    const startY = candlestickSeries.priceToCoordinate(line.startPoint.price);
    const endX = chart.timeScale().timeToCoordinate(line.endPoint.time);
    const endY = candlestickSeries.priceToCoordinate(line.endPoint.price);
    if (startX !== null && startY !== null && endX !== null && endY !== null) {
      const isSelected = activeSelectedObject && activeSelectedObject.type === "line" && activeSelectedObject.index === idx;
      ctx.beginPath();
      ctx.strokeStyle = line.color || "#3b82f6";
      ctx.lineWidth = isSelected ? 3 : 1.5;
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.stroke();
      if (isSelected) {
        drawHandle(ctx, startX, startY, "circle", line.color);
        drawHandle(ctx, endX, endY, "circle", line.color);
      }
    }
  });

  // Rectangles
  drawings.rectangles.forEach((rect, idx) => {
    const startX = chart.timeScale().timeToCoordinate(rect.startPoint.time);
    const startY = candlestickSeries.priceToCoordinate(rect.startPoint.price);
    const endX = chart.timeScale().timeToCoordinate(rect.endPoint.time);
    const endY = candlestickSeries.priceToCoordinate(rect.endPoint.price);
    if (startX !== null && startY !== null && endX !== null && endY !== null) {
      const isSelected = activeSelectedObject && activeSelectedObject.type === "rect" && activeSelectedObject.index === idx;
      ctx.beginPath();
      ctx.strokeStyle = rect.color || "#3b82f6";
      ctx.lineWidth = isSelected ? 3 : 1.5;
      ctx.fillStyle = hexToRgba(rect.color || "#3b82f6", 0.15);
      ctx.rect(startX, startY, endX - startX, endY - startY);
      ctx.fill();
      ctx.stroke();
      if (isSelected) {
        drawHandle(ctx, startX, startY, "square", rect.color);
        drawHandle(ctx, endX, endY, "square", rect.color);
      }
    }
  });

  // Temp Drawing
  if (tempDrawing) {
    const startX = chart.timeScale().timeToCoordinate(tempDrawing.startPoint.time);
    const startY = candlestickSeries.priceToCoordinate(tempDrawing.startPoint.price);
    const endX = chart.timeScale().timeToCoordinate(tempDrawing.endPoint.time);
    const endY = candlestickSeries.priceToCoordinate(tempDrawing.endPoint.price);
    if (startX !== null && startY !== null && endX !== null && endY !== null) {
      ctx.beginPath();
      ctx.strokeStyle = tempDrawing.color;
      ctx.lineWidth = 2;
      if (tempDrawing.type === "line") {
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
      } else if (tempDrawing.type === "rect") {
        ctx.fillStyle = hexToRgba(tempDrawing.color, 0.15);
        ctx.rect(startX, startY, endX - startX, endY - startY);
        ctx.fill();
      }
      ctx.stroke();
    }
  }

  // Active position Levels (entry, sl, tp)
  state.positions.forEach((pos) => {
    const y = candlestickSeries.priceToCoordinate(pos.entryPrice);
    if (y !== null && y >= plotArea.top && y <= plotArea.bottom) {
      ctx.beginPath();
      ctx.strokeStyle = pos.type === "buy" ? "#26a69a" : "#ef5350";
      ctx.lineWidth = (hoveredObject && hoveredObject.id === pos.id && hoveredObject.type === "pos_entry") ? 2.5 : 1.5;
      ctx.setLineDash([8, 4]);
      ctx.moveTo(plotArea.left, y);
      ctx.lineTo(plotArea.right, y);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw TP and SL labels
      if (pos.takeProfit && pos.takeProfit > 0) {
        const tpY = candlestickSeries.priceToCoordinate(pos.takeProfit);
        if (tpY !== null && tpY >= plotArea.top && tpY <= plotArea.bottom) {
          ctx.beginPath();
          ctx.strokeStyle = "#26a69a";
          ctx.setLineDash([3, 3]);
          ctx.moveTo(plotArea.left, tpY);
          ctx.lineTo(plotArea.right, tpY);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      if (pos.stopLoss && pos.stopLoss > 0) {
        const slY = candlestickSeries.priceToCoordinate(pos.stopLoss);
        if (slY !== null && slY >= plotArea.top && slY <= plotArea.bottom) {
          ctx.beginPath();
          ctx.strokeStyle = "#ef5350";
          ctx.setLineDash([3, 3]);
          ctx.moveTo(plotArea.left, slY);
          ctx.lineTo(plotArea.right, slY);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
  });

  ctx.restore();
}

function drawHistoricalTradesOnCanvas(ctx) {
  if (!selectedHistoryTrades || selectedHistoryTrades.length === 0) return;
  const plotArea = getChartPlotArea();

  selectedHistoryTrades.forEach((t) => {
    if (!t.entryTime || !t.exitTime) return;

    const entryX = chart.timeScale().timeToCoordinate(t.entryTime);
    const entryY = candlestickSeries.priceToCoordinate(t.entryPrice);
    const exitX = chart.timeScale().timeToCoordinate(t.exitTime);
    const exitY = candlestickSeries.priceToCoordinate(t.exitPrice);

    if (entryX === null || entryY === null || exitX === null || exitY === null) return;

    ctx.save();
    ctx.beginPath();
    ctx.rect(plotArea.left, plotArea.top, plotArea.width, plotArea.height);
    ctx.clip();

    ctx.beginPath();
    const isWin = (t.pnl || 0) >= 0;
    ctx.strokeStyle = isWin ? "rgba(16, 185, 129, 0.55)" : "rgba(239, 68, 68, 0.55)";
    ctx.lineWidth = hoveredHistTradeId === t.id ? 3 : 1.5;
    ctx.setLineDash([3, 3]);
    ctx.moveTo(entryX, entryY);
    ctx.lineTo(exitX, exitY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.restore();
  });
}

export function drawLongPosition(ctx, pos, idx) {
  if (!pos) return;
  const startX = chart.timeScale().timeToCoordinate(pos.time || pos.startPoint?.time);
  if (startX === null) return;
  const entryY = candlestickSeries.priceToCoordinate(pos.entryPrice);
  const targetY = candlestickSeries.priceToCoordinate(pos.targetPrice);
  const stopY = candlestickSeries.priceToCoordinate(pos.stopPrice);
  if (entryY === null || targetY === null || stopY === null) return;

  const plotArea = getChartPlotArea();
  const barSpacing = getBarSpacing();
  const widthInCandles = pos.widthInCandles || 70;
  const width = Math.max(30, Math.round(widthInCandles * barSpacing));
  const endX = startX + width;
  const isLong = pos.type === "long" || pos.type === "Long" || pos.type === "buy";

  ctx.save();

  // (a) Ограничение зоны по ширине от startX до endX
  // (б) Разделение на зеленую (прибыль) и красную (риск) зоны по линии входа (entryY)
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

  // Линия входа
  ctx.beginPath();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.moveTo(startX, entryY);
  ctx.lineTo(endX, entryY);
  ctx.stroke();
  ctx.setLineDash([]);

  // (в) Позиционирование текстовой подписи ниже верхней строки OHLC
  const profitPct = Math.abs(((pos.targetPrice - pos.entryPrice) / pos.entryPrice) * 100);
  const lossPct = Math.abs(((pos.stopPrice - pos.entryPrice) / pos.entryPrice) * 100);
  const rr = lossPct > 0 ? (profitPct / lossPct).toFixed(2) : "0.00";

  const currentSymbol = (typeof state !== "undefined" && state?.symbol) || (window.state && window.state.symbol) || "EUR_USD";
  const decimals = typeof window.getSymbolDecimals === "function" ? window.getSymbolDecimals(currentSymbol) : 5;
  const pointSize = typeof window.getSymbolMinMove === "function" ? window.getSymbolMinMove(currentSymbol) : (decimals === 2 ? 0.01 : decimals === 3 ? 0.001 : 0.00001);
  const pipSize = typeof window.getSymbolPipSize === "function" ? window.getSymbolPipSize(currentSymbol) : pointSize * 10;
  const formatPips = typeof window.formatPips === "function" ? window.formatPips : (v) => {
    const s = Number(v).toFixed(1);
    return s.endsWith(".0") ? s.slice(0, -2) : s;
  };
  const targetPips = formatPips(Math.abs(pos.entryPrice - pos.targetPrice) / pipSize);
  const stopPips = formatPips(Math.abs(pos.entryPrice - pos.stopPrice) / pipSize);

  const tpText = `Цель: ${pos.targetPrice.toFixed(decimals)} (${profitPct.toFixed(2)}%) | ${targetPips} pips`;
  const slText = `Стоп: ${pos.stopPrice.toFixed(decimals)} (${lossPct.toFixed(2)}%) | ${stopPips} pips`;
  const rrText = `R/R: ${rr}`;

  const minSafeY = getOHLCBottomY();

  ctx.font = "bold 12px Inter, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Target Badge
  const tpW = ctx.measureText(tpText).width + 14;
  const tpH = 22;
  const tpX = startX + width / 2 - tpW / 2;
  const rawTpY = isLong ? targetY - tpH / 2 - 4 : targetY + tpH / 2 + 4;
  const tpYPos = Math.max(minSafeY, rawTpY);

  ctx.fillStyle = "#26a69a";
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(tpX, tpYPos - tpH / 2, tpW, tpH, 4);
  else ctx.rect(tpX, tpYPos - tpH / 2, tpW, tpH);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(tpText, startX + width / 2, tpYPos);

  // Stop Badge
  const slW = ctx.measureText(slText).width + 14;
  const slH = 22;
  const slX = startX + width / 2 - slW / 2;
  const rawSlY = isLong ? stopY + slH / 2 + 4 : stopY - slH / 2 - 4;
  const slYPos = Math.max(minSafeY, rawSlY);

  ctx.fillStyle = "#ef5350";
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(slX, slYPos - slH / 2, slW, slH, 4);
  else ctx.rect(slX, slYPos - slH / 2, slW, slH);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(slText, startX + width / 2, slYPos);

  // R/R Badge
  const rrW = ctx.measureText(rrText).width + 16;
  const rrH = 24;
  const rrX = startX + width / 2 - rrW / 2;
  const rrYPos = Math.max(minSafeY, entryY);

  ctx.fillStyle = "rgba(19, 23, 34, 0.9)";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(rrX, rrYPos - rrH / 2, rrW, rrH, 4);
  else ctx.rect(rrX, rrYPos - rrH / 2, rrW, rrH);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(rrText, startX + width / 2, rrYPos);

  ctx.restore();
}

export function getDefaultFibLevels() {
  return [
    { level: 0, enabled: true, color: "#787b86" },
    { level: 0.236, enabled: true, color: "#f23645" },
    { level: 0.382, enabled: true, color: "#ff9800" },
    { level: 0.5, enabled: true, color: "#4caf50" },
    { level: 0.618, enabled: true, color: "#089981" },
    { level: 0.65, enabled: true, color: "#00bcd4" },
    { level: 0.705, enabled: true, color: "#2962ff" },
    { level: 0.786, enabled: true, color: "#ab47bc" },
    { level: 1.0, enabled: true, color: "#787b86" },
    { level: 1.272, enabled: true, color: "#e91e63" },
    { level: 1.414, enabled: true, color: "#9c27b0" },
    { level: 1.618, enabled: true, color: "#2962ff" },
    { level: 2.618, enabled: true, color: "#00897b" },
    { level: 3.618, enabled: true, color: "#7cb342" },
    { level: 4.236, enabled: true, color: "#e53935" },
  ];
}

export function createDefaultFib(startPt, endPt, color) {
  return {
    id: Math.random().toString(36).substr(2, 9),
    type: "fib",
    startPoint: startPt,
    endPoint: endPt,
    color: color || "#3b82f6",
    trendLine: {
      visible: true,
      color: "#787b86",
      width: 1,
      style: "dashed",
    },
    levels: getDefaultFibLevels(),
    reverse: false,
    extendLeft: false,
    extendRight: false,
    fillBackground: true,
    fillOpacity: 0.08,
    lineWidth: 1,
    lineStyle: "solid",
    labels: {
      showCoeff: true,
      showPercent: false,
      showPrices: true,
      showPoints: true,
      showPips: true,
      position: "left",
      vPosition: "above",
      fontSize: 11,
    },
  };
}

export function calculateFibLevelPrice(fib, lvl) {
  if (!fib || !fib.startPoint || !fib.endPoint) return 0;
  const priceA = fib.startPoint.price;
  const priceB = fib.endPoint.price;
  if (fib.reverse) {
    return priceA + (priceB - priceA) * lvl;
  } else {
    return priceB + (priceA - priceB) * lvl;
  }
}

function applyLineDashStyle(ctx, style) {
  if (style === "dashed") {
    ctx.setLineDash([6, 4]);
  } else if (style === "dotted") {
    ctx.setLineDash([2, 3]);
  } else {
    ctx.setLineDash([]);
  }
}

function getFibLabelText(fib, lvlObj, levelPrice, decimals, pipSize, baseZeroPrice) {
  const parts = [];
  const labelsCfg = fib.labels || {};

  if (labelsCfg.showCoeff !== false) {
    if (labelsCfg.showPercent) {
      parts.push(`${(lvlObj.level * 100).toFixed(1)}%`);
    } else {
      parts.push(`${lvlObj.level}`);
    }
  }

  const subParts = [];
  if (labelsCfg.showPrices !== false) {
    subParts.push(levelPrice.toFixed(decimals));
  }
  if (labelsCfg.showPoints !== false && labelsCfg.showPips !== false) {
    const formatPips = typeof window.formatPips === "function" ? window.formatPips : (v) => {
      const s = Number(v).toFixed(1);
      return s.endsWith(".0") ? s.slice(0, -2) : s;
    };
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

export function drawFibonacciRetracement(ctx, fib, idx) {
  if (!fib || !fib.startPoint || !fib.endPoint) return;
  const startX = chart.timeScale().timeToCoordinate(fib.startPoint.time);
  const startY = candlestickSeries.priceToCoordinate(fib.startPoint.price);
  const endX = chart.timeScale().timeToCoordinate(fib.endPoint.time);
  const endY = candlestickSeries.priceToCoordinate(fib.endPoint.price);
  if (startX === null || startY === null || endX === null || endY === null) return;

  const plotArea = getChartPlotArea();
  if (!plotArea) return;
  const minSafeY = getOHLCBottomY();

  const isHovered = typeof hoveredObject !== "undefined" && hoveredObject && hoveredObject.type === "fib" && hoveredObject.index === idx;
  const isSelected = typeof activeSelectedObject !== "undefined" && activeSelectedObject && (activeSelectedObject.type === "fib" || activeSelectedObject.type === "fib_handle") && activeSelectedObject.index === idx;

  const currentSymbol = (typeof state !== "undefined" && state?.symbol) || (window.state && window.state.symbol) || "EUR_USD";
  const decimals = typeof window.getSymbolDecimals === "function" ? window.getSymbolDecimals(currentSymbol) : 5;
  const pointSize = typeof window.getSymbolMinMove === "function" ? window.getSymbolMinMove(currentSymbol) : (decimals === 2 ? 0.01 : decimals === 3 ? 0.001 : 0.00001);
  const pipSize = typeof window.getSymbolPipSize === "function" ? window.getSymbolPipSize(currentSymbol) : pointSize * 10;
  const baseZeroPrice = fib.reverse ? fib.startPoint.price : fib.endPoint.price;

  const leftX = Math.min(startX, endX);
  const rightX = Math.max(startX, endX);

  const lineStartX = fib.extendLeft ? plotArea.left : leftX;
  const lineEndX = fib.extendRight ? plotArea.right : rightX;

  const rawLevels = fib.levels || getDefaultFibLevels();
  const enabledLevels = rawLevels
    .filter((lvl) => lvl.enabled)
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

  // Draw Background Fills between adjacent levels
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

  // Draw Trend Line between Point A and Point B
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

  // Draw Horizontal Level Lines & Labels
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

  // Handles at Point A and Point B
  if (isHovered || isSelected) {
    if (typeof drawHandle === "function") {
      drawHandle(ctx, startX, startY, "circle", fib.color || "#3b82f6");
      drawHandle(ctx, endX, endY, "circle", fib.color || "#3b82f6");
    }
  }

  ctx.restore();
}

