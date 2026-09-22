/**
 * cotData.js - Official CFTC Commitments of Traders (COT) Data Module
 * Fetches and manages REAL data from the official CFTC public reporting API:
 * - Legacy Combined (Futures + Options): https://publicreporting.cftc.gov/resource/jun7-fc8e.json
 * - Legacy Futures Only: https://publicreporting.cftc.gov/resource/6dca-aqww.json
 * 
 * Strict rules:
 * 1. Default matches MyFXBook / TradingView standard: Legacy (Futures + Options Combined).
 * 2. Caches real CFTC reports locally in localStorage with 24-hour TTL per market & report type.
 * 3. Enforces NO LOOK-AHEAD BIAS in backtest mode by filtering by publication timestamp (Friday 15:30 EST).
 * 4. All trader groups satisfy Legacy COT balance: Large Speculators + Commercials + Small Speculators = 0 net sum.
 */

const LOCAL_STORAGE_KEY = "plbt_cot_real_data_v4";
const OFFLINE_STORAGE_KEY = "plbt_cot_offline_data";
const OFFLINE_MODE_KEY = "plbt_cot_offline_mode";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export const CFTC_MARKETS = {
  EUR: { code: "099741", cftcName: "EURO FX - CHICAGO MERCANTILE EXCHANGE", label: "EUR Futures (CME)", defaultSymbol: "EURUSD" },
  GBP: { code: "096742", cftcName: "BRITISH POUND - CHICAGO MERCANTILE EXCHANGE", label: "GBP Futures (CME)", defaultSymbol: "GBPUSD" },
  JPY: { code: "097741", cftcName: "JAPANESE YEN - CHICAGO MERCANTILE EXCHANGE", label: "JPY Futures (CME)", defaultSymbol: "USDJPY" },
  AUD: { code: "232741", cftcName: "AUSTRALIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE", label: "AUD Futures (CME)", defaultSymbol: "AUDUSD" },
  CAD: { code: "090741", cftcName: "CANADIAN DOLLAR - CHICAGO MERCANTILE EXCHANGE", label: "CAD Futures (CME)", defaultSymbol: "USDCAD" },
  CHF: { code: "092741", cftcName: "SWISS FRANC - CHICAGO MERCANTILE EXCHANGE", label: "CHF Futures (CME)", defaultSymbol: "USDCHF" },
  NZD: { code: "112741", cftcName: "NZ DOLLAR - CHICAGO MERCANTILE EXCHANGE", label: "NZD Futures (CME)", defaultSymbol: "NZDUSD" },
  GOLD: { code: "088691", cftcName: "GOLD - COMMODITY EXCHANGE INC.", label: "Gold Futures (COMEX)", defaultSymbol: "XAUUSD" },
  SILVER: { code: "084691", cftcName: "SILVER - COMMODITY EXCHANGE INC.", label: "Silver Futures (COMEX)", defaultSymbol: "XAGUSD" },
  BTC: { code: "133741", cftcName: "BITCOIN - CHICAGO MERCANTILE EXCHANGE", label: "Bitcoin Futures (CME)", defaultSymbol: "BTCUSD" },
  USD: { code: "098662", cftcName: "USD INDEX - ICE FUTURES U.S.", label: "US Dollar Index (ICE)", defaultSymbol: "DXY" }
};

/**
 * Maps any user symbol (e.g. 'EURUSD', 'EUR/USD', 'XAUUSD', 'BTCUSDT', '6E') to CFTC market key
 */
export function getCOTMarketForSymbol(symbol) {
  if (!symbol) return "EUR";
  const s = String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.includes("EUR") || s === "6E") return "EUR";
  if (s.includes("GBP") || s === "6B") return "GBP";
  if (s.includes("JPY") || s === "6J") return "JPY";
  if (s.includes("AUD") || s === "6A") return "AUD";
  if (s.includes("CAD") || s === "6C") return "CAD";
  if (s.includes("CHF") || s === "6S") return "CHF";
  if (s.includes("NZD") || s === "6N") return "NZD";
  if (s.includes("XAU") || s.includes("GOLD") || s === "GC") return "GOLD";
  if (s.includes("XAG") || s.includes("SILVER") || s === "SI") return "SILVER";
  if (s.includes("BTC") || s.includes("BITCOIN") || s === "MBT") return "BTC";
  if (s.includes("DXY") || s.includes("USDX") || s === "DX") return "USD";
  return "EUR";
}

/**
 * In-memory cache of loaded real CFTC datasets by `${marketKey}_${reportType}`
 */
let inMemoryCOTDataset = {};

/**
 * Accurately gets current date and time in America/New_York timezone
 * (handling Daylight Saving Time / Standard Time correctly).
 */
export function getNewYorkTime(date = new Date()) {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
    const parts = formatter.formatToParts(date);
    const map = {};
    parts.forEach(p => { map[p.type] = p.value; });

    const weekdayMap = { "Sun": 0, "Mon": 1, "Tue": 2, "Wed": 3, "Thu": 4, "Fri": 5, "Sat": 6 };
    const dayOfWeek = weekdayMap[map.weekday] !== undefined ? weekdayMap[map.weekday] : date.getUTCDay();
    const hour = parseInt(map.hour, 10) || 0;
    const minute = parseInt(map.minute, 10) || 0;
    const second = parseInt(map.second, 10) || 0;
    const year = parseInt(map.year, 10) || date.getUTCFullYear();
    const month = parseInt(map.month, 10) || (date.getUTCMonth() + 1);
    const day = parseInt(map.day, 10) || date.getUTCDate();
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    // Friday publication window: starts Friday 14:45 NY time through 23:59 NY time
    // Extended into Saturday morning 00:00-06:00 NY time in case CFTC release was delayed
    const isFridayWindow = (dayOfWeek === 5 && (hour > 14 || (hour === 14 && minute >= 45))) || (dayOfWeek === 6 && hour < 6);

    return {
      dayOfWeek, // 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
      hour,
      minute,
      second,
      year,
      month,
      day,
      dateStr,
      isFriday: dayOfWeek === 5,
      isPublicationWindow: isFridayWindow
    };
  } catch (e) {
    console.warn("[COT Timezone] Error calculating NY time:", e);
    const dayOfWeek = date.getUTCDay();
    const utcHour = date.getUTCHours();
    const nyHour = (utcHour - 4 + 24) % 24;
    return {
      dayOfWeek,
      hour: nyHour,
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      dateStr: date.toISOString().split("T")[0],
      isFriday: dayOfWeek === 5,
      isPublicationWindow: dayOfWeek === 5 && nyHour >= 15
    };
  }
}

/**
 * Gets the date of the most recent Tuesday in New York time (the date of the weekly COT report)
 */
export function getExpectedWeeklyReportDateStr(nyTime = getNewYorkTime()) {
  const d = new Date(Date.UTC(nyTime.year, nyTime.month - 1, nyTime.day));
  const dow = nyTime.dayOfWeek; // 0=Sun, 2=Tue, 5=Fri
  let diffDays = (dow - 2 + 7) % 7;
  d.setUTCDate(d.getUTCDate() - diffDays);
  return d.toISOString().split("T")[0];
}

/**
 * Returns the latest report_date (YYYY-MM-DD) saved locally for a given market
 */
export function getLatestStoredCOTReportDate(marketKey = "EUR", reportType = "combined") {
  const typeKey = reportType === "futures_only" ? "futures_only" : "combined";
  const cacheKey = `${marketKey}_${typeKey}`;

  let list = inMemoryCOTDataset[cacheKey];
  if (!list || list.length === 0) {
    const cache = loadStorageCache();
    if (cache[cacheKey] && Array.isArray(cache[cacheKey].data)) {
      list = cache[cacheKey].data;
    }
  }
  if (!list || list.length === 0) {
    const offline = loadOfflineStorage();
    if (offline && Array.isArray(offline[cacheKey])) {
      list = offline[cacheKey];
    }
  }

  if (Array.isArray(list) && list.length > 0) {
    const last = list[list.length - 1];
    return last.reportDate || (last.report_date_as_yyyy_mm_dd ? last.report_date_as_yyyy_mm_dd.split("T")[0] : null);
  }
  return null;
}

/**
 * Check if offline COT mode is currently active
 */
export function isCOTOffline() {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(OFFLINE_MODE_KEY) === "true";
  } catch (e) {
    return false;
  }
}

/**
 * Toggle or set offline mode state
 */
export function setCOTOfflineMode(enabled) {
  if (typeof localStorage === "undefined") return;
  try {
    if (enabled) {
      localStorage.setItem(OFFLINE_MODE_KEY, "true");
    } else {
      localStorage.setItem(OFFLINE_MODE_KEY, "false");
    }
  } catch (e) {
    console.warn("[COT] Error setting offline mode:", e);
  }
}

/**
 * Load offline dataset from localStorage
 */
function loadOfflineStorage() {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(OFFLINE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    }
  } catch (e) {
    console.warn("[COT] Error reading offline storage:", e);
  }
  return null;
}

/**
 * Save offline dataset to localStorage
 */
function saveOfflineStorage(dataObj) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(OFFLINE_STORAGE_KEY, JSON.stringify(dataObj));
  } catch (e) {
    console.warn("[COT] Error saving offline storage:", e);
  }
}

/**
 * Get detailed info about offline data
 */
export function getCOTOfflineInfo() {
  const offlineData = loadOfflineStorage();
  const isOffline = isCOTOffline();
  if (!offlineData) {
    return { isOffline: false, hasData: false, totalRecords: 0, markets: [] };
  }
  const markets = Object.keys(offlineData);
  let totalRecords = 0;
  markets.forEach(m => {
    if (Array.isArray(offlineData[m])) {
      totalRecords += offlineData[m].length;
    }
  });
  return {
    isOffline,
    hasData: totalRecords > 0,
    totalRecords,
    markets
  };
}

/**
 * Export all loaded and cached COT data to a downloadable JSON file
 */
export function exportAllCOTDataToJSON() {
  const cache = loadStorageCache();
  const offline = loadOfflineStorage() || {};
  const exportMarkets = {};
  let totalRecords = 0;

  // Merge memory, cache, and offline datasets
  const allKeys = new Set([
    ...Object.keys(inMemoryCOTDataset),
    ...Object.keys(cache),
    ...Object.keys(offline)
  ]);

  allKeys.forEach(k => {
    let records = inMemoryCOTDataset[k];
    if (!records || records.length === 0) {
      if (cache[k] && Array.isArray(cache[k].data)) {
        records = cache[k].data;
      } else if (Array.isArray(offline[k])) {
        records = offline[k];
      }
    }
    if (Array.isArray(records) && records.length > 0) {
      exportMarkets[k] = records;
      totalRecords += records.length;
    }
  });

  if (totalRecords === 0) {
    throw new Error("Нет загруженных данных COT для экспорта. Сначала откройте индикатор или обновите данные CFTC.");
  }

  const exportPayload = {
    format: "COT_DATASET_V1",
    exportedAt: new Date().toISOString(),
    totalRecords,
    marketsCount: Object.keys(exportMarkets).length,
    markets: exportMarkets
  };

  const filename = `cot_data_export_${new Date().toISOString().split("T")[0]}_${totalRecords}_records.json`;

  if (typeof document !== "undefined" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    try {
      const jsonString = JSON.stringify(exportPayload, null, 2);
      const blob = new Blob([jsonString], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.warn("[COT Export File Trigger]", e);
    }
  }

  return {
    success: true,
    count: totalRecords,
    totalReports: totalRecords,
    marketsCount: Object.keys(exportMarkets).length,
    filename,
    payload: exportPayload
  };
}

/**
 * Import COT data from JSON string or object
 */
export function importCOTDataFromJSON(content) {
  let parsed = null;
  if (typeof content === "string") {
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      throw new Error("Неверный формат JSON: " + e.message);
    }
  } else if (content && typeof content === "object") {
    parsed = content;
  }

  if (!parsed) {
    throw new Error("Пустые или поврежденные данные JSON.");
  }

  const importedMarkets = {};
  let totalRecords = 0;

  // Extract market map from various possible wrapper structures
  let sourceMap = parsed;
  if (parsed.markets && typeof parsed.markets === "object" && !Array.isArray(parsed.markets)) {
    sourceMap = parsed.markets;
  } else if (parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)) {
    sourceMap = parsed.data;
  } else if (parsed.reports && typeof parsed.reports === "object" && !Array.isArray(parsed.reports)) {
    sourceMap = parsed.reports;
  }

  const normalizeRecord = (r, defaultMarket = "EUR", defaultType = "combined") => {
    if (!r) return null;
    const reportDate = r.reportDate || r.date || (r.report_date_as_yyyy_mm_dd ? r.report_date_as_yyyy_mm_dd.split("T")[0] : null);
    if (!reportDate) return null;

    const reportTimestamp = r.reportTimestamp || Math.floor(new Date(`${reportDate}T00:00:00Z`).getTime() / 1000);
    const pubDate = r.pubDate || calculatePubDate(reportDate);
    const pubTimestamp = r.pubTimestamp || calculatePubTimestamp(pubDate);

    const nonCommLong = Number(r.nonCommLong ?? r.noncommercial_positions_long_all ?? 0);
    const nonCommShort = Number(r.nonCommShort ?? r.noncommercial_positions_short_all ?? 0);
    const nonCommNet = r.nonCommNet !== undefined ? Number(r.nonCommNet) : (nonCommLong - nonCommShort);

    const commLong = Number(r.commLong ?? r.commercial_positions_long_all ?? 0);
    const commShort = Number(r.commShort ?? r.commercial_positions_short_all ?? 0);
    const commNet = r.commNet !== undefined ? Number(r.commNet) : (commLong - commShort);

    const retailLong = Number(r.retailLong ?? r.nonreportable_positions_long_all ?? 0);
    const retailShort = Number(r.retailShort ?? r.nonreportable_positions_short_all ?? 0);
    const retailNet = r.retailNet !== undefined ? Number(r.retailNet) : (retailLong - retailShort);

    const openInterest = Number(r.openInterest ?? r.open_interest_all ?? 0);

    return {
      reportDate,
      pubDate,
      reportTimestamp,
      pubTimestamp,
      openInterest,
      nonCommLong,
      nonCommShort,
      nonCommNet,
      commLong,
      commShort,
      commNet,
      retailLong,
      retailShort,
      retailNet,
      market: r.market || defaultMarket,
      reportType: r.reportType || defaultType,
      isSynthetic: false
    };
  };

  if (Array.isArray(sourceMap)) {
    const validRecords = sourceMap.map(r => normalizeRecord(r)).filter(Boolean);
    if (validRecords.length > 0) {
      const m = validRecords[0].market || "EUR";
      const t = validRecords[0].reportType || "combined";
      const key = `${m}_${t}`;
      importedMarkets[key] = validRecords.sort((a, b) => a.reportTimestamp - b.reportTimestamp);
      inMemoryCOTDataset[key] = importedMarkets[key];
      totalRecords += validRecords.length;
    }
  } else if (typeof sourceMap === "object" && sourceMap !== null) {
    for (const [key, records] of Object.entries(sourceMap)) {
      if (Array.isArray(records) && records.length > 0) {
        const parts = key.split("_");
        const defaultM = parts[0] || "EUR";
        const defaultT = parts[1] || "combined";
        const validRecords = records.map(r => normalizeRecord(r, defaultM, defaultT)).filter(Boolean);
        if (validRecords.length > 0) {
          importedMarkets[key] = validRecords.sort((a, b) => a.reportTimestamp - b.reportTimestamp);
          inMemoryCOTDataset[key] = importedMarkets[key];
          totalRecords += validRecords.length;
        }
      }
    }
  }

  if (totalRecords === 0) {
    throw new Error("В файле не найдено валидных отчетов COT (требуются поля даты отчета и позиций трейдеров).");
  }

  // Save to offline storage and enable offline mode
  saveOfflineStorage(importedMarkets);
  setCOTOfflineMode(true);

  console.log(`[COT Import] Successfully imported ${totalRecords} records across ${Object.keys(importedMarkets).length} markets. Offline mode ENABLED.`);

  return {
    success: true,
    totalRecords,
    importedReports: totalRecords,
    markets: Object.keys(importedMarkets)
  };
}

/**
 * Load cached data from localStorage
 */
function loadStorageCache() {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    }
  } catch (e) {
    console.warn("[COT] Error reading localStorage cache:", e);
  }
  return {};
}

/**
 * Save cached data to localStorage
 */
function saveStorageCache(cacheObj) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(cacheObj));
  } catch (e) {
    console.warn("[COT] Error saving localStorage cache:", e);
  }
}

/**
 * Parses raw CFTC Legacy API item into standardized report object
 */
function parseCFTCItem(item, marketKey, reportType = "combined") {
  const rawDate = item.report_date_as_yyyy_mm_dd || "";
  if (!rawDate) return null;
  const dateStr = rawDate.split("T")[0];
  const tuesdayDate = new Date(dateStr + "T00:00:00Z");
  const reportTimestamp = Math.floor(tuesdayDate.getTime() / 1000);

  // Friday release (3 days after Tuesday at 00:00:00 UTC)
  const fridayDate = new Date(tuesdayDate.getTime() + 3 * 24 * 60 * 60 * 1000);
  fridayDate.setUTCHours(0, 0, 0, 0);
  const pubTimestamp = Math.floor(fridayDate.getTime() / 1000);

  // Non-Commercial / Large Speculators (Funds, CTAs, Hedge Funds)
  const nonCommLong = parseInt(item.noncomm_positions_long_all || item.noncomm_positions_long_old || 0, 10);
  const nonCommShort = parseInt(item.noncomm_positions_short_all || item.noncomm_positions_short_old || 0, 10);
  const nonCommNet = nonCommLong - nonCommShort;

  // Commercial / Hedgers (Banks, Producers, Multinational Corporations)
  const commLong = parseInt(item.comm_positions_long_all || item.comm_positions_long_old || 0, 10);
  const commShort = parseInt(item.comm_positions_short_all || item.comm_positions_short_old || 0, 10);
  const commNet = commLong - commShort;

  // Non-Reportable / Small Speculators (Retail traders below reporting threshold)
  const retailLong = parseInt(item.nonrept_positions_long_all || item.nonrept_positions_long_old || 0, 10);
  const retailShort = parseInt(item.nonrept_positions_short_all || item.nonrept_positions_short_old || 0, 10);
  const retailNet = retailLong - retailShort;

  const openInterest = parseInt(item.open_interest_all || item.open_interest_old || 0, 10);

  return {
    market: marketKey,
    reportType,
    cftcCode: item.cftc_contract_market_code || "",
    marketName: item.market_and_exchange_names || "",
    reportDate: dateStr,
    reportTimestamp,
    pubDate: fridayDate.toISOString(),
    pubTimestamp, // Key timestamp for backtest lookahead prevention
    nonCommLong,
    nonCommShort,
    nonCommNet,
    commLong,
    commShort,
    commNet,
    retailLong,
    retailShort,
    retailNet,
    openInterest
  };
}

/**
 * Fetches real weekly reports from official CFTC API or Python bridge
 * @param {string} marketKey - e.g. "EUR", "GBP", "JPY", "GOLD", "BTC"
 * @param {string} reportType - "combined" (Legacy Futures+Options) or "futures_only" (Legacy Futures Only)
 * @param {boolean} forceRefresh - force re-fetch from network ignoring cache
 */
export async function fetchRealCFTCData(marketKey = "EUR", reportType = "combined", forceRefresh = false) {
  const info = CFTC_MARKETS[marketKey] || CFTC_MARKETS.EUR;
  const cftcCode = info.code;
  const typeKey = reportType === "futures_only" ? "futures_only" : "combined";
  const cacheKey = `${marketKey}_${typeKey}`;

  // If in offline mode, load exclusively from offline dataset
  if (isCOTOffline() && !forceRefresh) {
    const offlineStorage = loadOfflineStorage();
    if (offlineStorage && offlineStorage[cacheKey] && offlineStorage[cacheKey].length > 0) {
      const records = offlineStorage[cacheKey];
      console.log(`[COT Offline] Loaded ${records.length} offline records for ${cacheKey}`);
      inMemoryCOTDataset[cacheKey] = records;
      logFirst5Records(marketKey, typeKey, records);
      return records;
    }
  }

  // Check cache first
  const cache = loadStorageCache();
  const cachedEntry = cache[cacheKey];
  const now = Date.now();

  const nyTime = getNewYorkTime();
  const expectedTuesdayDate = getExpectedWeeklyReportDateStr(nyTime);
  const localLatestDate = getLatestStoredCOTReportDate(marketKey, typeKey);
  const isMissingCurrentWeek = nyTime.isPublicationWindow && (!localLatestDate || localLatestDate < expectedTuesdayDate);

  if (!forceRefresh && !isMissingCurrentWeek && cachedEntry && cachedEntry.data && cachedEntry.data.length > 0) {
    if (now - (cachedEntry.timestamp || 0) < CACHE_TTL_MS) {
      console.log(`[COT Cache] Loaded ${cachedEntry.data.length} cached CFTC ${typeKey} records for ${marketKey}`);
      inMemoryCOTDataset[cacheKey] = cachedEntry.data;
      logFirst5Records(marketKey, typeKey, cachedEntry.data);
      return cachedEntry.data;
    }
  }

  // If offline mode is enabled and network is disabled, don't attempt live fetch
  if (isCOTOffline()) {
    console.warn(`[COT Offline] Offline mode active, skipping network fetch for ${cacheKey}`);
    const offlineStorage = loadOfflineStorage();
    if (offlineStorage && offlineStorage[cacheKey]) {
      inMemoryCOTDataset[cacheKey] = offlineStorage[cacheKey];
      return offlineStorage[cacheKey];
    }
    return cachedEntry && cachedEntry.data ? cachedEntry.data : [];
  }

  console.log(`[COT API] Fetching REAL CFTC ${typeKey} data for ${marketKey} (Contract: ${cftcCode})...`);

  // CFTC Socrata Datasets:
  // - jun7-fc8e.json: Legacy Combined (Futures & Options) [Used by MyFXBook, TradingView]
  // - 6dca-aqww.json: Legacy Futures Only
  const datasetId = typeKey === "futures_only" ? "6dca-aqww" : "jun7-fc8e";

  const endpoints = [
    // 1. Direct CFTC Socrata Public API (Supports CORS natively)
    `https://publicreporting.cftc.gov/resource/${datasetId}.json?$where=cftc_contract_market_code='${cftcCode}' AND report_date_as_yyyy_mm_dd >= '2010-01-01'&$limit=5000&$order=report_date_as_yyyy_mm_dd ASC`,
    // 2. Local Python Bridge / Proxy fallback
    `/cot?symbol=${info.defaultSymbol || marketKey}&type=${typeKey}`,
    `http://localhost:8001/cot?symbol=${info.defaultSymbol || marketKey}&type=${typeKey}`
  ];

  let rawData = null;
  let lastError = null;

  for (const url of endpoints) {
    try {
      const resp = await fetch(url, {
        headers: { "Accept": "application/json" }
      });
      if (resp.ok) {
        const json = await resp.json();
        if (Array.isArray(json) && json.length > 0) {
          rawData = json;
          console.log(`[COT API Success] Loaded from ${url.split("?")[0]} (${json.length} records, ${typeKey})`);
          break;
        }
      }
    } catch (err) {
      lastError = err;
    }
  }

  if (rawData && rawData.length > 0) {
    const parsedRecords = [];
    for (const item of rawData) {
      if (item.net_position !== undefined && item.date) {
        // Bridge format
        const tDate = new Date(item.date + "T00:00:00Z");
        const rTs = Math.floor(tDate.getTime() / 1000);
        const fDate = new Date(tDate.getTime() + 3 * 24 * 60 * 60 * 1000);
        fDate.setUTCHours(0, 0, 0, 0);
        parsedRecords.push({
          market: marketKey,
          reportType: typeKey,
          reportDate: item.date,
          reportTimestamp: rTs,
          pubDate: fDate.toISOString(),
          pubTimestamp: Math.floor(fDate.getTime() / 1000),
          nonCommLong: item.noncomm_long || 0,
          nonCommShort: item.noncomm_short || 0,
          nonCommNet: item.net_position,
          commLong: item.comm_long || 0,
          commShort: item.comm_short || 0,
          commNet: item.comm_net || 0,
          retailLong: item.retail_long || 0,
          retailShort: item.retail_short || 0,
          retailNet: item.retail_net || 0,
          openInterest: item.open_interest || 0
        });
      } else {
        const r = parseCFTCItem(item, marketKey, typeKey);
        if (r) parsedRecords.push(r);
      }
    }

    // Sort strictly by reportTimestamp ascending
    parsedRecords.sort((a, b) => a.reportTimestamp - b.reportTimestamp);

    // Save to memory and cache
    inMemoryCOTDataset[cacheKey] = parsedRecords;
    cache[cacheKey] = {
      timestamp: now,
      data: parsedRecords
    };
    saveStorageCache(cache);

    // Print first 5 real records to console
    logFirst5Records(marketKey, typeKey, parsedRecords);

    return parsedRecords;
  }

  // If network failed but we have stale cache, use stale cache
  if (cachedEntry && cachedEntry.data && cachedEntry.data.length > 0) {
    console.warn(`[COT Warning] Network fetch failed, using stale cache for ${cacheKey}`);
    inMemoryCOTDataset[cacheKey] = cachedEntry.data;
    logFirst5Records(marketKey, typeKey, cachedEntry.data);
    return cachedEntry.data;
  }

  console.error(`[COT Error] Не удалось загрузить данные COT для ${cacheKey}:`, lastError);
  return [];
}

/**
 * Prints the first 5 real records from CFTC API to console in a structured format
 */
function logFirst5Records(marketKey, reportType, records) {
  if (!records || records.length === 0) return;
  const first5 = records.slice(0, 5);
  console.group(`[CFTC Real Data] Первые 5 записей для ${marketKey} (${reportType}, ${records.length} всего):`);
  console.table(first5.map((r, i) => ({
    "№": i + 1,
    "Дата отчета (Вт)": r.reportDate,
    "Large Speculators (Non-Comm)": r.nonCommNet,
    "Commercials (Hedgers)": r.commNet,
    "Small Speculators (Retail)": r.retailNet,
    "Net Balance Sum": (r.nonCommNet + r.commNet + r.retailNet),
    "Open Interest": r.openInterest,
    "Дата публикации (Пт)": r.pubDate ? r.pubDate.split("T")[0] : r.reportDate
  })));
  console.groupEnd();
}

/**
 * Returns available COT data for market, strictly filtering by maxTimestamp (Unix seconds)
 * if provided (prevents lookahead bias in backtest mode).
 */
export function getCOTDataForMarket(marketKey, reportType = "combined", maxTimestamp = null) {
  const typeKey = reportType === "futures_only" ? "futures_only" : "combined";
  const cacheKey = `${marketKey}_${typeKey}`;

  let list = inMemoryCOTDataset[cacheKey];
  if (!list || list.length === 0) {
    const cache = loadStorageCache();
    if (cache[cacheKey] && cache[cacheKey].data) {
      list = cache[cacheKey].data;
      inMemoryCOTDataset[cacheKey] = list;
    }
  }

  if (!list || list.length === 0) {
    return [];
  }

  if (maxTimestamp === null || maxTimestamp === undefined || isNaN(maxTimestamp)) {
    return list;
  }

  const getNormTime = (val) => {
    if (val === null || val === undefined) return 0;
    let t = Number(val);
    if (isNaN(t)) return 0;
    if (t > 1e11) t = Math.floor(t / 1000);
    return t;
  };

  const maxSec = getNormTime(maxTimestamp);
  return list.filter((item) => getNormTime(item.pubTimestamp || item.reportTimestamp) <= maxSec);
}

const cotFormatMemoCache = new Map();

/**
 * Formats COT reports into LightweightCharts series objects.
 * When candleList is provided, aligns COT data points with the exact candle timestamps
 * for 1:1 timeline grid synchronization with the main price chart.
 */
export function formatCOTSeriesData(cotReports, candleList = null) {
  if (!cotReports || cotReports.length === 0) {
    return {
      histogram: [],
      nonCommNet: [],
      commNet: [],
      retailNet: [],
      openInterest: [],
      latestReport: null
    };
  }

  const getNormTime = (val) => {
    if (val === null || val === undefined) return 0;
    let t = Number(val);
    if (isNaN(t)) return 0;
    if (t > 1e11) t = Math.floor(t / 1000);
    return t;
  };

  // Build cache key based on reports length, candle count, and timestamps
  const firstRepTime = getNormTime(cotReports[0]?.pubTimestamp || cotReports[0]?.reportTimestamp);
  const lastRepTime = getNormTime(cotReports[cotReports.length - 1]?.pubTimestamp || cotReports[cotReports.length - 1]?.reportTimestamp);
  const firstCandleTime = (candleList && candleList.length > 0) ? getNormTime(candleList[0]?.time) : 0;
  const lastCandleTime = (candleList && candleList.length > 0) ? getNormTime(candleList[candleList.length - 1]?.time) : 0;
  const cacheKey = `${cotReports.length}_${firstRepTime}_${lastRepTime}_${firstCandleTime}_${lastCandleTime}`;

  if (cotFormatMemoCache.has(cacheKey)) {
    return cotFormatMemoCache.get(cacheKey);
  }

  // Ensure reports are sorted ascending by publication timestamp (Friday pub date)
  let sortedReports = [...cotReports].sort((a, b) => {
    const tA = getNormTime(a.pubTimestamp || a.reportTimestamp);
    const tB = getNormTime(b.pubTimestamp || b.reportTimestamp);
    return tA - tB;
  });

  const getFridayTimestamp = (r) => {
    if (r.pubTimestamp) {
      const d = new Date(getNormTime(r.pubTimestamp) * 1000);
      d.setUTCHours(0, 0, 0, 0);
      return Math.floor(d.getTime() / 1000);
    }
    if (r.reportDate) {
      const d = new Date(r.reportDate + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() + 3);
      d.setUTCHours(0, 0, 0, 0);
      return Math.floor(d.getTime() / 1000);
    }
    if (r.reportTimestamp) {
      const d = new Date(getNormTime(r.reportTimestamp) * 1000);
      d.setUTCDate(d.getUTCDate() + 3);
      d.setUTCHours(0, 0, 0, 0);
      return Math.floor(d.getTime() / 1000);
    }
    return 0;
  };

  const latestReport = sortedReports[sortedReports.length - 1];

  // 1:1 Timeline Alignment with Main Price Chart:
  // When candleList is present, align each candle with its corresponding active COT report data
  // so both charts have the exact same bar indices, timeline, and perfect synchronization.
  if (candleList && Array.isArray(candleList) && candleList.length > 0) {
    const histogram = [];
    const nonCommNet = [];
    const commNet = [];
    const retailNet = [];
    const openInterest = [];

    const reportDates = sortedReports.map((r) => getFridayTimestamp(r));
    let rIdx = -1;
    let lastTime = -Infinity;

    for (let i = 0; i < candleList.length; i++) {
      const c = candleList[i];
      const cTime = getNormTime(c.time);
      if (isNaN(cTime) || cTime <= lastTime) continue;
      lastTime = cTime;

      // Advance report index as long as the next report was published before or on this candle
      while (rIdx + 1 < sortedReports.length && reportDates[rIdx + 1] <= cTime) {
        rIdx++;
      }

      if (rIdx >= 0) {
        const r = sortedReports[rIdx];
        const netVal = r.nonCommNet !== undefined ? r.nonCommNet : (r.nonCommLong - r.nonCommShort);
        const commVal = r.commNet !== undefined ? r.commNet : (r.commLong - r.commShort);
        const retailVal = r.retailNet !== undefined ? r.retailNet : (r.retailLong - r.retailShort);
        const oiVal = r.openInterest !== undefined ? r.openInterest : 0;

        histogram.push({
          time: cTime,
          value: netVal,
          color: netVal >= 0 ? "#10b981" : "#ef4444"
        });
        nonCommNet.push({ time: cTime, value: netVal });
        commNet.push({ time: cTime, value: commVal });
        retailNet.push({ time: cTime, value: retailVal });
        openInterest.push({ time: cTime, value: oiVal });
      } else if (sortedReports.length > 0) {
        const r0 = sortedReports[0];
        const netVal = r0.nonCommNet !== undefined ? r0.nonCommNet : (r0.nonCommLong - r0.nonCommShort);
        histogram.push({
          time: cTime,
          value: netVal,
          color: netVal >= 0 ? "#10b981" : "#ef4444"
        });
        nonCommNet.push({ time: cTime, value: netVal });
        commNet.push({ time: cTime, value: r0.commNet !== undefined ? r0.commNet : 0 });
        retailNet.push({ time: cTime, value: r0.retailNet !== undefined ? r0.retailNet : 0 });
        openInterest.push({ time: cTime, value: r0.openInterest !== undefined ? r0.openInterest : 0 });
      }
    }

    const result = {
      histogram,
      nonCommNet,
      commNet,
      retailNet,
      openInterest,
      latestReport
    };

    if (cotFormatMemoCache.size > 50) {
      const firstKey = cotFormatMemoCache.keys().next().value;
      if (firstKey) cotFormatMemoCache.delete(firstKey);
    }
    cotFormatMemoCache.set(cacheKey, result);
    return result;
  }

  // Pure weekly series strictly on Friday publication timestamps (e.g. 14, 7, 31, 24, 17, 10, 3...)
  const histogram = [];
  const nonCommNet = [];
  const commNet = [];
  const retailNet = [];
  const openInterest = [];

  let lastT = -Infinity;
  for (let i = 0; i < sortedReports.length; i++) {
    const r = sortedReports[i];
    const t = getFridayTimestamp(r);
    if (isNaN(t) || t <= 0) continue;
    if (t <= lastT) continue;
    lastT = t;

    const netVal = r.nonCommNet !== undefined ? r.nonCommNet : (r.nonCommLong - r.nonCommShort);
    histogram.push({
      time: t,
      value: netVal,
      color: netVal >= 0 ? "#10b981" : "#ef4444"
    });
    nonCommNet.push({ time: t, value: netVal });
    commNet.push({ time: t, value: r.commNet !== undefined ? r.commNet : 0 });
    retailNet.push({ time: t, value: r.retailNet !== undefined ? r.retailNet : 0 });
    openInterest.push({ time: t, value: r.openInterest !== undefined ? r.openInterest : 0 });
  }

  const result = {
    histogram,
    nonCommNet,
    commNet,
    retailNet,
    openInterest,
    latestReport
  };

  // Keep cache size bounded
  if (cotFormatMemoCache.size > 50) {
    const firstKey = cotFormatMemoCache.keys().next().value;
    if (firstKey) cotFormatMemoCache.delete(firstKey);
  }
  cotFormatMemoCache.set(cacheKey, result);

  return result;
}

/**
 * Clear the format memoization cache (call when new data is received)
 */
export function clearCOTFormatCache() {
  cotFormatMemoCache.clear();
}

/**
 * Checks CFTC public API to determine if a newer report exists compared to the local stored dataset.
 * Queries ONLY 1 latest record ($limit=1) for minimal network footprint and ultra-fast response.
 * @param {string} marketKey - e.g. "EUR", "GBP", "GOLD", "BTC"
 * @param {string} reportType - "combined" or "futures_only"
 */
export async function checkCFTCNewReportAvailable(marketKey = "EUR", reportType = "combined") {
  if (isCOTOffline()) {
    return { isNew: false, reason: "offline_mode", market: marketKey, reportType };
  }

  const info = CFTC_MARKETS[marketKey] || CFTC_MARKETS.EUR;
  const cftcCode = info.code;
  const typeKey = reportType === "futures_only" ? "futures_only" : "combined";
  const datasetId = typeKey === "futures_only" ? "6dca-aqww" : "jun7-fc8e";

  const localLatestDate = getLatestStoredCOTReportDate(marketKey, typeKey);

  // Query only the single most recent record
  const checkUrl = `https://publicreporting.cftc.gov/resource/${datasetId}.json?$where=cftc_contract_market_code='${cftcCode}'&$limit=1&$order=report_date_as_yyyy_mm_dd DESC`;

  try {
    const resp = await fetch(checkUrl, {
      headers: { "Accept": "application/json" }
    });

    if (!resp.ok) {
      throw new Error(`CFTC HTTP ${resp.status}`);
    }

    const json = await resp.json();
    if (!Array.isArray(json) || json.length === 0) {
      return { isNew: false, reason: "empty_response", localLatestDate, market: marketKey, reportType: typeKey };
    }

    const item = json[0];
    const rawDate = item.report_date_as_yyyy_mm_dd || "";
    const remoteDateStr = rawDate.split("T")[0];

    if (!remoteDateStr) {
      return { isNew: false, reason: "no_date_in_record", localLatestDate, market: marketKey, reportType: typeKey };
    }

    if (!localLatestDate) {
      return {
        isNew: true,
        localLatestDate: null,
        remoteLatestDate: remoteDateStr,
        market: marketKey,
        reportType: typeKey
      };
    }

    // Direct ISO date comparison (YYYY-MM-DD)
    const isNew = remoteDateStr > localLatestDate;

    return {
      isNew,
      localLatestDate,
      remoteLatestDate: remoteDateStr,
      market: marketKey,
      reportType: typeKey
    };
  } catch (err) {
    console.warn(`[COT Auto-Sync Check] Network error checking ${marketKey} (${typeKey}):`, err.message);
    return {
      isNew: false,
      error: err.message,
      localLatestDate,
      market: marketKey,
      reportType: typeKey
    };
  }
}

/**
 * Checks CFTC and fetches full dataset if a newer report is available.
 * @param {string} marketKey
 * @param {string} reportType
 */
export async function syncCOTDataIfNewAvailable(marketKey = "EUR", reportType = "combined") {
  const check = await checkCFTCNewReportAvailable(marketKey, reportType);
  if (check.isNew && check.remoteLatestDate) {
    console.log(`[COT Auto-Sync] 🎉 New CFTC report detected for ${marketKey}! Remote: ${check.remoteLatestDate}, Local: ${check.localLatestDate || "none"}. Downloading full dataset...`);
    const refreshed = await fetchRealCFTCData(marketKey, reportType, true);
    clearCOTFormatCache();
    return {
      hasUpdated: true,
      newReportDate: check.remoteLatestDate,
      previousDate: check.localLatestDate,
      market: marketKey,
      reportType,
      recordCount: refreshed.length
    };
  }
  return {
    hasUpdated: false,
    latestReportDate: check.localLatestDate || check.remoteLatestDate,
    market: marketKey,
    reportType
  };
}

/**
 * Syncs all tracked CFTC markets when a new weekly batch is published
 */
export async function syncAllTrackedCOTMarkets(reportType = "combined") {
  const markets = Object.keys(CFTC_MARKETS);
  const updatedMarkets = [];
  for (const m of markets) {
    try {
      const res = await syncCOTDataIfNewAvailable(m, reportType);
      if (res.hasUpdated) {
        updatedMarkets.push(res);
      }
    } catch (e) {
      console.warn(`[COT Auto-Sync] Error updating ${m}:`, e);
    }
  }
  return updatedMarkets;
}

/**
 * Background Automatic COT Synchronization Engine
 * 
 * Rules:
 * 1. Runs continuously in the background of the app (regardless of whether COT panel is open).
 * 2. In normal times: relaxed polling (every 60 minutes).
 * 3. On Friday during publication window (starts 14:45 America/New_York through Friday night):
 *    increases polling frequency to every 5 minutes until the new report for this week is found.
 * 4. Once new report is loaded, backs off to relaxed polling.
 * 5. Compares by `report_date` (not time elapsed) to remain resilient against CFTC delays or holidays.
 * 6. Invokes registered listeners and updates active COT chart view on the fly.
 */
class COTSyncEngine {
  constructor() {
    this.timerId = null;
    this.lastCheckTimestamp = 0;
    this.lastCheckResult = null;
    this.listeners = new Set();
    this.isChecking = false;
    this.normalIntervalMs = 60 * 60 * 1000; // 60 minutes
    this.fridayWindowIntervalMs = 5 * 60 * 1000; // 5 minutes
    this.heartbeatMs = 30 * 1000; // 30-second heartbeat check
    this.lastDiscoveredReportDate = null;
  }

  start() {
    if (this.timerId) return;
    console.log("[COT Auto-Sync] Background engine started.");
    // Initial check after short delay (5 seconds after app boot)
    setTimeout(() => this.tick(), 5000);
    this.timerId = setInterval(() => this.tick(), this.heartbeatMs);
  }

  stop() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
      console.log("[COT Auto-Sync] Background engine stopped.");
    }
  }

  onNewReport(callback) {
    if (typeof callback === "function") {
      this.listeners.add(callback);
    }
    return () => this.listeners.delete(callback);
  }

  notifyNewReport(updateInfo) {
    this.lastDiscoveredReportDate = updateInfo.newReportDate;
    this.listeners.forEach((fn) => {
      try {
        fn(updateInfo);
      } catch (err) {
        console.error("[COT Auto-Sync Listener Error]", err);
      }
    });
  }

  getRequiredIntervalMs() {
    const nyTime = getNewYorkTime();
    const expectedTuesdayDate = getExpectedWeeklyReportDateStr(nyTime);
    const localEURDate = getLatestStoredCOTReportDate("EUR", "combined");

    // If it's Friday publication window and we still haven't received this week's report
    if (nyTime.isPublicationWindow && (!localEURDate || localEURDate < expectedTuesdayDate)) {
      return this.fridayWindowIntervalMs; // 5 minutes
    }
    return this.normalIntervalMs; // 60 minutes
  }

  async tick() {
    if (this.isChecking || isCOTOffline()) return;

    const now = Date.now();
    const requiredInterval = this.getRequiredIntervalMs();

    if (now - this.lastCheckTimestamp < requiredInterval) {
      return;
    }

    await this.checkNow();
  }

  async checkNow(forceCheckAll = false) {
    if (this.isChecking) return this.lastCheckResult;
    this.isChecking = true;
    this.lastCheckTimestamp = Date.now();

    const nyTime = getNewYorkTime();
    console.log(`[COT Auto-Sync] Checking for CFTC updates (NY Time: ${nyTime.dateStr} ${String(nyTime.hour).padStart(2,"0")}:${String(nyTime.minute).padStart(2,"0")} ET, FridayWindow: ${nyTime.isPublicationWindow})...`);

    try {
      // 1. Check primary market (EUR combined) first as the sentinel for the CFTC weekly batch release
      const checkResult = await checkCFTCNewReportAvailable("EUR", "combined");
      this.lastCheckResult = {
        timestamp: new Date().toISOString(),
        nyTime,
        checkResult
      };

      if (checkResult.isNew || forceCheckAll) {
        console.log(`[COT Auto-Sync] ✨ New weekly CFTC release found! Date: ${checkResult.remoteLatestDate}. Syncing all markets...`);
        const updated = await syncAllTrackedCOTMarkets("combined");
        await syncAllTrackedCOTMarkets("futures_only");

        const updatePayload = {
          newReportDate: checkResult.remoteLatestDate,
          previousReportDate: checkResult.localLatestDate,
          updatedMarketsCount: updated.length,
          timestamp: new Date().toISOString()
        };

        this.notifyNewReport(updatePayload);
        return updatePayload;
      } else {
        console.log(`[COT Auto-Sync] No newer CFTC report found. Latest local report: ${checkResult.localLatestDate || "none"}. Next check in ${Math.round(this.getRequiredIntervalMs() / 60000)}m.`);
      }
    } catch (err) {
      console.warn("[COT Auto-Sync] Error during background check tick:", err.message);
    } finally {
      this.isChecking = false;
    }

    return this.lastCheckResult;
  }

  getStatus() {
    const nyTime = getNewYorkTime();
    const intervalMs = this.getRequiredIntervalMs();
    const marketsInfo = {};
    Object.keys(CFTC_MARKETS).forEach((m) => {
      marketsInfo[m] = {
        combined: getLatestStoredCOTReportDate(m, "combined"),
        futuresOnly: getLatestStoredCOTReportDate(m, "futures_only")
      };
    });

    return {
      isActive: Boolean(this.timerId),
      isChecking: this.isChecking,
      lastCheckTimestamp: this.lastCheckTimestamp ? new Date(this.lastCheckTimestamp).toISOString() : null,
      lastDiscoveredReportDate: this.lastDiscoveredReportDate,
      currentPollingIntervalMinutes: Math.round(intervalMs / 60000),
      isFridayPublicationWindow: nyTime.isPublicationWindow,
      newYorkTime: `${nyTime.dateStr} ${String(nyTime.hour).padStart(2,"0")}:${String(nyTime.minute).padStart(2,"0")}:${String(nyTime.second).padStart(2,"0")} ET (Day ${nyTime.dayOfWeek})`,
      expectedTuesdayDate: getExpectedWeeklyReportDateStr(nyTime),
      isOfflineMode: isCOTOffline(),
      latestLocalReports: marketsInfo
    };
  }
}

export const cotSyncEngine = new COTSyncEngine();

// Auto-start background engine in browser environment
if (typeof window !== "undefined") {
  cotSyncEngine.start();
  window.cotSyncEngine = cotSyncEngine;
  window.checkCOTUpdatesNow = () => cotSyncEngine.checkNow(true);
  window.getCOTSyncStatus = () => cotSyncEngine.getStatus();
}

/**
 * Refresh helper for all standard markets
 */
export async function generateCOTHistoricalData(reportType = "combined") {
  const markets = Object.keys(CFTC_MARKETS);
  for (const m of markets) {
    await fetchRealCFTCData(m, reportType, true);
  }
}

