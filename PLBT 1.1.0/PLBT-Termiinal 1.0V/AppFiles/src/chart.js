import { state } from "./state.js";

const container = document.getElementById("chart-viewport");

export const chart = window.LightweightCharts.createChart(container, {
  layout: {
    background: { type: "solid", color: "#0b101b" },
    textColor: "#94a3b8",
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  grid: {
    vertLines: { color: "rgba(30, 41, 59, 0.15)" },
    horzLines: { color: "rgba(30, 41, 59, 0.15)" },
  },
  rightPriceScale: {
    borderColor: "#1e293b",
    borderVisible: true,
    scaleMargins: { top: 0.15, bottom: 0.15 },
  },
  timeScale: {
    borderColor: "#1e293b",
    borderVisible: true,
    timeVisible: true,
    secondsVisible: false,
    barSpacing: 10,
  },
  crosshair: {
    mode: window.LightweightCharts.CrosshairMode.Normal,
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

export const candlestickSeries = chart.addCandlestickSeries({
  upColor: "#10b981",
  downColor: "#ef4444",
  borderVisible: false,
  wickUpColor: "#10b981",
  wickDownColor: "#ef4444",
  priceFormat: { type: "price", precision: 5, minMove: 0.00001 },
});
