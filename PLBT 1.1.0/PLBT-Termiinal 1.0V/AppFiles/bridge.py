import json
import os
import re
import urllib.request
import time
import asyncio
from datetime import datetime
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

# Try importing MetaTrader5 (only available on Windows)
try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
except ImportError:
    MT5_AVAILABLE = False
    print("MetaTrader5 package is not installed. MT5 features will be disabled.")

# Load environment variables from .env file
try:
    from dotenv import load_dotenv
    load_dotenv()
    print("Environment variables loaded from .env")
except ImportError:
    print("python-dotenv is not installed. Using system environment variables.")

# Mapping JS timeframe to MT5 timeframe constants (using official MT5 constants or standard fallback integer codes)
if MT5_AVAILABLE:
    TIMEFRAME_M1 = mt5.TIMEFRAME_M1
    TIMEFRAME_M2 = getattr(mt5, "TIMEFRAME_M2", 2)
    TIMEFRAME_M3 = mt5.TIMEFRAME_M3
    TIMEFRAME_M5 = mt5.TIMEFRAME_M5
    TIMEFRAME_M10 = mt5.TIMEFRAME_M10
    TIMEFRAME_M15 = mt5.TIMEFRAME_M15
    TIMEFRAME_M30 = mt5.TIMEFRAME_M30
    TIMEFRAME_H1 = mt5.TIMEFRAME_H1
    TIMEFRAME_H2 = mt5.TIMEFRAME_H2
    TIMEFRAME_H4 = mt5.TIMEFRAME_H4
    TIMEFRAME_H8 = mt5.TIMEFRAME_H8
    TIMEFRAME_D1 = mt5.TIMEFRAME_D1
    TIMEFRAME_W1 = mt5.TIMEFRAME_W1
    TIMEFRAME_MN1 = mt5.TIMEFRAME_MN1
else:
    TIMEFRAME_M1 = 1
    TIMEFRAME_M2 = 2
    TIMEFRAME_M3 = 3
    TIMEFRAME_M5 = 5
    TIMEFRAME_M10 = 10
    TIMEFRAME_M15 = 15
    TIMEFRAME_M30 = 30
    TIMEFRAME_H1 = 16385
    TIMEFRAME_H2 = 16386
    TIMEFRAME_H4 = 16388
    TIMEFRAME_H8 = 16392
    TIMEFRAME_D1 = 16408
    TIMEFRAME_W1 = 32769  # mt5.TIMEFRAME_W1 is 32769 (0x8001), NOT 32777
    TIMEFRAME_MN1 = 49153 # mt5.TIMEFRAME_MN1 is 49153 (0xC001)

TIMEFRAME_SECONDS_MAP = {
    "1m": 60, "m1": 60, "1min": 60,
    "3m": 180, "m3": 180,
    "5m": 300, "m5": 300,
    "10m": 600, "m10": 600,
    "15m": 900, "m15": 900,
    "30m": 1800, "m30": 1800,
    "1h": 3600, "h1": 3600,
    "2h": 7200, "h2": 7200,
    "4h": 14400, "h4": 14400,
    "8h": 28800, "h8": 28800,
    "1d": 86400, "1D": 86400, "d1": 86400, "D1": 86400, "1day": 86400, "day": 86400, "daily": 86400,
    "1w": 604800, "1W": 604800, "w1": 604800, "W1": 604800, "1week": 604800, "week": 604800, "weekly": 604800,
    "1M": 2592000, "1mth": 2592000, "mn": 2592000, "MN": 2592000, "mn1": 2592000, "MN1": 2592000,
    "1month": 2592000, "month": 2592000, "monthly": 2592000,
}

def is_forex_market_closed(now_utc: datetime) -> bool:
    """
    Грубая проверка окна закрытия рынка Forex по UTC:
    закрыт с пятницы ~21:00 UTC до воскресенья ~21:00 UTC.
    """
    weekday = now_utc.weekday()  # 0=Mon ... 4=Fri, 5=Sat, 6=Sun
    if weekday == 5:
        return True
    if weekday == 4 and now_utc.hour >= 21:
        return True
    if weekday == 6 and now_utc.hour < 21:
        return True
    return False

def is_stale(rates, timeframe: str) -> bool:
    """
    Проверяет, не отстаёт ли последняя полученная свеча от текущего момента
    больше, чем это объяснимо длительностью таймфрейма или закрытием рынка на выходные.
    """
    if rates is None or len(rates) == 0:
        return True

    now_utc = datetime.utcnow()
    if is_forex_market_closed(now_utc):
        # Рынок закрыт — отставание ожидаемо, не считаем это проблемой
        return False

    last_bar_time = int(rates[-1]['time'])
    gap_seconds = int(now_utc.timestamp()) - last_bar_time

    bar_seconds = TIMEFRAME_SECONDS_MAP.get(timeframe) or TIMEFRAME_SECONDS_MAP.get(timeframe.lower()) or 900

    # Допускаем отставание в 3 полных бара, но не менее 30 минут и не более 6 часов
    allowed_gap = max(bar_seconds * 3, 1800)
    allowed_gap = min(allowed_gap, 6 * 3600)

    return gap_seconds > allowed_gap

TIMEFRAME_MAP = {
    "1m": TIMEFRAME_M1,
    "m1": TIMEFRAME_M1,
    "1min": TIMEFRAME_M1,
    "3m": TIMEFRAME_M3,
    "m3": TIMEFRAME_M3,
    "5m": TIMEFRAME_M5,
    "m5": TIMEFRAME_M5,
    "10m": TIMEFRAME_M10,
    "m10": TIMEFRAME_M10,
    "15m": TIMEFRAME_M15,
    "m15": TIMEFRAME_M15,
    "30m": TIMEFRAME_M30,
    "m30": TIMEFRAME_M30,
    "1h": TIMEFRAME_H1,
    "h1": TIMEFRAME_H1,
    "2h": TIMEFRAME_H2,
    "h2": TIMEFRAME_H2,
    "4h": TIMEFRAME_H4,
    "h4": TIMEFRAME_H4,
    "8h": TIMEFRAME_H8,
    "h8": TIMEFRAME_H8,
    "1d": TIMEFRAME_D1,
    "1D": TIMEFRAME_D1,
    "d1": TIMEFRAME_D1,
    "D1": TIMEFRAME_D1,
    "1day": TIMEFRAME_D1,
    "day": TIMEFRAME_D1,
    "daily": TIMEFRAME_D1,
    "1w": TIMEFRAME_W1,
    "1W": TIMEFRAME_W1,
    "w1": TIMEFRAME_W1,
    "W1": TIMEFRAME_W1,
    "1week": TIMEFRAME_W1,
    "week": TIMEFRAME_W1,
    "weekly": TIMEFRAME_W1,
    "1M": TIMEFRAME_MN1,
    "1mth": TIMEFRAME_MN1,
    "mn": TIMEFRAME_MN1,
    "MN": TIMEFRAME_MN1,
    "mn1": TIMEFRAME_MN1,
    "MN1": TIMEFRAME_MN1,
    "1month": TIMEFRAME_MN1,
    "month": TIMEFRAME_MN1,
    "monthly": TIMEFRAME_MN1,
}

app = FastAPI(title="PLBT MT5 Bridge")

# CORS Setup to allow requests from the browser client
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize MT5 on startup if available
if MT5_AVAILABLE:
    if not mt5.initialize():
        print("MetaTrader5 initialize() failed, error code =", mt5.last_error())
    else:
        print("MetaTrader5 initialized successfully")
else:
    print("MT5 initialization skipped (not on Windows or package missing)")

def get_price(symbol: str) -> dict:
    """
    Fetches current market price from Twelve Data API using the backend API Key
    to keep it fully hidden from the frontend client.
    """
    api_key = os.getenv("TWELVE_DATA_API_KEY")
    if not api_key:
        return {
            "status": "error",
            "message": "TWELVE_DATA_API_KEY is not set. Please configure it as an environment variable.",
        }

    # Normalize symbol for Twelve Data (e.g. EUR_USD -> EUR/USD, EURUSD -> EUR/USD)
    clean_symbol = symbol.replace("_", "/")
    if "/" not in clean_symbol and len(clean_symbol) == 6:
        clean_symbol = f"{clean_symbol[:3]}/{clean_symbol[3:]}"

    url = f"https://api.twelvedata.com/price?symbol={clean_symbol}&apikey={api_key}"
    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "PLBT Terminal Bridge/1.0"}
        )
        with urllib.request.urlopen(req, timeout=8) as response:
            res_data = json.loads(response.read().decode())
            if "price" in res_data:
                price_val = float(res_data["price"])
                return {
                    "status": "ok",
                    "symbol": symbol,
                    "bid": price_val - 0.0001,
                    "ask": price_val + 0.0001,
                    "last": price_val,
                    "time": int(time.time()),
                    "provider": "twelvedata"
                }
            elif "message" in res_data:
                return {"status": "error", "message": res_data["message"]}
            else:
                return {"status": "error", "message": "Invalid response format from Twelve Data", "raw": res_data}
    except Exception as e:
        return {"status": "error", "message": f"Twelve Data API request failed: {str(e)}"}

@app.get("/twelvedata")
async def get_twelvedata_price(
    symbol: str = Query("EURUSD", description="Symbol name, e.g. EURUSD")
):
    """Explicit Twelve Data proxy endpoint to safely fetch price using the backend API Key."""
    return get_price(symbol)

def resolve_symbol_and_timeframe(symbol: str, timeframe: str):
    """
    Validates and resolves MT5 symbol (with possible broker suffixes) and timeframe constant.
    Returns (actual_symbol, mt5_tf_int, error_message)
    """
    if timeframe.upper() == "12M":
        return None, None, "Timeframe 12M is not supported natively by MT5"

    if not MT5_AVAILABLE or not mt5.initialize():
        return None, None, "Failed to connect to MT5 Terminal"

    clean_symbol = symbol.replace("_", "")
    
    # 1. Resolve exact broker symbol name (handling suffixes like EURUSD.a, EURUSD_i, etc.)
    actual_symbol = clean_symbol
    symbol_info = mt5.symbol_info(clean_symbol)
    if symbol_info is None:
        # Search symbols list for exact match or suffix match
        symbols = mt5.symbols_get()
        if symbols:
            matching = [s.name for s in symbols if clean_symbol.lower() in s.name.lower()]
            if matching:
                actual_symbol = matching[0]
                symbol_info = mt5.symbol_info(actual_symbol)

    if symbol_info is None:
        # Try selecting directly in Market Watch
        if mt5.symbol_select(clean_symbol, True):
            actual_symbol = clean_symbol
            symbol_info = mt5.symbol_info(actual_symbol)

    if symbol_info is None:
        last_err = mt5.last_error()
        term_info = mt5.terminal_info()
        term_name = getattr(term_info, "name", "Unknown") if term_info else "No terminal"
        return None, None, f"Symbol '{clean_symbol}' not found in MT5 Terminal ({term_name}). Error: {last_err}"

    # 2. Ensure symbol is explicitly selected/activated in Market Watch before requesting rates
    if not mt5.symbol_select(actual_symbol, True):
        print(f"[MT5 Bridge Warning] mt5.symbol_select('{actual_symbol}', True) returned False. Error: {mt5.last_error()}")

    tf_clean = timeframe.strip()
    tf_lower = tf_clean.lower()
    
    # Explicit mapping logic using TIMEFRAME_MAP and defined constants
    mt5_tf = TIMEFRAME_MAP.get(tf_clean) or TIMEFRAME_MAP.get(tf_lower) or TIMEFRAME_MAP.get(tf_clean.upper())

    if mt5_tf is None:
        if tf_lower in ("1w", "w1", "1week", "week", "weekly") or tf_clean in ("1W", "W1"):
            mt5_tf = TIMEFRAME_W1
        elif tf_lower in ("1mth", "1month", "month", "monthly", "mn", "mn1") or tf_clean in ("1M", "MN", "MN1"):
            mt5_tf = TIMEFRAME_MN1
        elif tf_lower in ("1d", "d1", "1day", "day", "daily") or tf_clean in ("1D", "D1"):
            mt5_tf = TIMEFRAME_D1

    if mt5_tf is None:
        return None, None, f"Неизвестный таймфрейм: {timeframe}"

    return actual_symbol, int(mt5_tf), None

@app.get("/symbols-list")
async def get_symbols_list():
    """
    Returns full list of available broker symbols from MT5 with their description and root category.
    Format: {"status": "ok", "symbols": [{"name": "EURUSD", "description": "Euro vs US Dollar", "category": "Forex"}, ...]}
    """
    if not MT5_AVAILABLE:
        return {"status": "error", "message": "MetaTrader5 package is not available"}

    if not mt5.initialize():
        last_err = mt5.last_error()
        return {"status": "error", "message": f"Failed to connect to MT5 Terminal. Error: {last_err}"}

    try:
        symbols = mt5.symbols_get()
        if symbols is None:
            last_err = mt5.last_error()
            return {"status": "error", "message": f"Failed to retrieve symbols from MT5. Error: {last_err}"}

        result_symbols = []
        
        # Whitelisted currencies and metals prefixes for strict Forex and Metals filtering
        FOREX_CURRENCIES = {
            "USD", "EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "NZD", "CNY", "CNH",
            "HKD", "SGD", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "TRY", "ZAR",
            "MXN", "BRL", "INR", "KRW", "ILS", "RUB", "THB", "AED", "SAR", "RON",
            "CLP", "COP", "PEN", "IDR", "MYR", "PHP", "TWD", "KWD", "QAR", "BGN", "ISK"
        }
        METALS_PREFIXES = ("XAU", "XAG", "XPT", "XPD", "GOLD", "SILVER", "PLATINUM", "PALLADIUM")
        METALS_KEYWORDS = ("metal", "металл", "gold", "silver", "platinum", "palladium", "precious", "золото", "серебро", "платина")
        
        # Banned asset types (Indices, Commodities, Crypto, Equities)
        EXCLUDE_KEYWORDS = (
            "crypto", "крипто", "index", "indices", "индекс", "stock", "stocks",
            "share", "shares", "акци", "commodity", "commodities", "товар", "сырь",
            "energy", "oil", "gas", "brent", "wti", "etf", "bond", "futures"
        )

        for s in symbols:
            name = s.name
            
            # Extract description
            desc = getattr(s, "description", "") or ""
            if not desc:
                info = mt5.symbol_info(name)
                if info and getattr(info, "description", None):
                    desc = info.description

            # Extract category path
            raw_path = getattr(s, "path", "") or ""
            norm_path = raw_path.replace("/", "\\").lower() if raw_path else ""
            desc_lower = (desc or "").lower()
            name_upper = name.upper()
            clean_name = re.sub(r'[^A-Z0-9]', '', name_upper)

            # Check if clearly an excluded asset type
            if any(k in norm_path or k in desc_lower for k in EXCLUDE_KEYWORDS):
                continue

            # Determine category: Metals or Forex
            assigned_category = None

            # 1. Check for Metals
            if any(clean_name.startswith(p) for p in METALS_PREFIXES) or \
               any(k in norm_path or k in desc_lower for k in METALS_KEYWORDS):
                assigned_category = "Metals"

            # 2. Check for Forex (2 combined 3-letter currencies, or path containing forex/fx)
            if not assigned_category:
                if len(clean_name) >= 6:
                    base_cur = clean_name[:3]
                    quote_cur = clean_name[3:6]
                    if base_cur in FOREX_CURRENCIES and quote_cur in FOREX_CURRENCIES:
                        assigned_category = "Forex"
                
                if not assigned_category:
                    if any(k in norm_path for k in ["forex", "fx", "currency", "currencies", "валют"]):
                        assigned_category = "Forex"

            # User instruction: Only Forex and Metals are permitted ("Пускай он оставит только форекс и металлы остальное не работает")
            if not assigned_category:
                continue

            result_symbols.append({
                "name": name,
                "description": desc if desc else name,
                "category": assigned_category
            })

        print(f"[MT5 Bridge] Returned {len(result_symbols)} symbols for /symbols-list")
        return {
            "status": "ok",
            "symbols": result_symbols
        }
    except Exception as e:
        return {"status": "error", "message": f"Error fetching symbols list: {str(e)}"}

@app.post("/history-start-download")
@app.get("/history-start-download")
async def history_start_download(
    symbol: str = Query("EURUSD", description="Symbol name"),
    timeframe: str = Query("15m", description="Timeframe")
):
    """
    Triggers MT5 background download from broker using copy_rates_range with early date (2010-01-01).
    Returns immediately without blocking.
    """
    actual_symbol, mt5_tf_int, err = resolve_symbol_and_timeframe(symbol, timeframe)
    if err:
        return {"status": "error", "message": err}

    early_date = datetime(2010, 1, 1)
    now_date = datetime.now()
    print(f"[MT5 Bridge] Triggering background history download for '{actual_symbol}' ({timeframe})...")
    
    # Execute non-blocking call in background worker
    try:
        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, mt5.copy_rates_range, actual_symbol, mt5_tf_int, early_date, now_date)
    except Exception as e:
        print(f"[MT5 Bridge] Background download trigger exception: {e}")

    return {"status": "ok", "symbol": actual_symbol, "timeframe": timeframe}

@app.get("/history-progress")
async def get_history_progress(
    symbol: str = Query("EURUSD", description="Symbol name"),
    timeframe: str = Query("15m", description="Timeframe"),
    target: int = Query(150000, description="Target candles count"),
    count: int = Query(None, description="Alias for target count")
):
    """
    Instantly returns current cached bars in MT5 terminal without sleeps or retry loops.
    """
    target_count = count if count is not None else target
    actual_symbol, mt5_tf_int, err = resolve_symbol_and_timeframe(symbol, timeframe)
    if err:
        return {"status": "error", "message": err, "current": 0, "target": target_count}

    max_count = 500000
    if mt5_tf_int in (TIMEFRAME_W1, TIMEFRAME_MN1):
        max_count = 2500
    elif mt5_tf_int == TIMEFRAME_D1:
        max_count = 10000
    elif mt5_tf_int in (TIMEFRAME_H1, TIMEFRAME_H2, TIMEFRAME_H4, TIMEFRAME_H8):
        max_count = 50000

    effective_target = min(target_count, max_count)
    rates = mt5.copy_rates_from_pos(actual_symbol, mt5_tf_int, 0, effective_target)
    current_count = len(rates) if rates is not None else 0

    return {
        "status": "ok",
        "symbol": actual_symbol,
        "timeframe": timeframe,
        "current": current_count,
        "target": effective_target
    }

@app.get("/history")
async def get_history(
    symbol: str = Query("EURUSD", description="Symbol name"),
    timeframe: str = Query("15m", description="Timeframe"),
    from_date: int = Query(None, description="Start date timestamp"),
    to_date: int = Query(None, description="End date timestamp"),
    count: int = Query(100000, description="Number of candles to load")
):
    actual_symbol, mt5_tf_int, err = resolve_symbol_and_timeframe(symbol, timeframe)
    if err:
        print(f"[MT5 Bridge Error] {err}")
        return {"status": "error", "message": err}

    # Clamp requested count based on timeframe to prevent MT5 invalid params error
    max_count = 500000
    if mt5_tf_int in (TIMEFRAME_W1, TIMEFRAME_MN1): # W1, MN1
        max_count = 2500
    elif mt5_tf_int == TIMEFRAME_D1: # D1
        max_count = 10000
    elif mt5_tf_int in (TIMEFRAME_H1, TIMEFRAME_H2, TIMEFRAME_H4, TIMEFRAME_H8): # H1..H8
        max_count = 50000

    effective_count = min(count, max_count)

    # Если переданы даты, берем диапазон. Если нет - берем последние свечи.
    if from_date and to_date:
        rates = mt5.copy_rates_range(actual_symbol, mt5_tf_int, from_date, to_date)
    else:
        rates = mt5.copy_rates_from_pos(actual_symbol, mt5_tf_int, 0, effective_count)

        # Проверяем, достаточно ли данных или терминал MT5 еще не успел подгрузить историю с сервера брокера
        def is_insufficient(r, target_count):
            if r is None or len(r) == 0:
                return True
            if target_count > 1000 and len(r) < int(target_count * 0.8):
                return True
            return False

        needs_refresh = is_insufficient(rates, effective_count)
        stale = is_stale(rates, timeframe)
        if stale and not needs_refresh:
            last_bar_dt = datetime.utcfromtimestamp(int(rates[-1]['time'])) if rates else None
            print(f"[MT5 Bridge] Data for '{actual_symbol}' ({timeframe}) is COUNT-sufficient but STALE. "
                  f"Last bar: {last_bar_dt} UTC. Forcing broker resync...")

        if needs_refresh or stale:
            initial_count = len(rates) if rates is not None else 0
            print(f"[MT5 Bridge] Initial fetch for '{actual_symbol}' ({timeframe}): received {initial_count}/{effective_count} bars. Starting background history download from broker...")
            
            # Повторяем попытки фоновой докачки до 3 раз суммарно с увеличивающейся паузой (2с, 4с, 4с)
            retry_delays = [2, 4, 4]
            prev_len = initial_count

            for attempt, delay in enumerate(retry_delays, start=1):
                # Шаг 1: Запрос диапазона с ранней даты (2010-01-01) для триггера загрузки баров в кэш MT5
                early_date = datetime(2010, 1, 1)
                now_date = datetime.now()
                print(f"[MT5 Bridge] [Attempt {attempt}/3] Triggering copy_rates_range(2010-01-01 -> now) for '{actual_symbol}' (TF: {timeframe})...")
                _ = mt5.copy_rates_range(actual_symbol, mt5_tf_int, early_date, now_date)

                # Шаг 2: Асинхронная пауза для синхронизации MT5 с сервером брокера
                print(f"[MT5 Bridge] [Attempt {attempt}/3] Waiting {delay}s for broker data download...")
                await asyncio.sleep(delay)

                # Шаг 3: Повторный запрос copy_rates_from_pos
                rates = mt5.copy_rates_from_pos(actual_symbol, mt5_tf_int, 0, effective_count)
                cur_len = len(rates) if rates is not None else 0
                print(f"[MT5 Bridge] [Attempt {attempt}/3 result] Received {cur_len} bars for '{actual_symbol}' (target: {effective_count})")

                # Если получили достаточно данных И они свежие
                if not is_insufficient(rates, effective_count) and not is_stale(rates, timeframe):
                    print(f"[MT5 Bridge] Successfully loaded {cur_len} fresh bars after download attempt {attempt}.")
                    break

                # Если объем стабилизировался на максимуме брокера (размер не растет и уже >= 1000)
                if cur_len > 0 and cur_len == prev_len and cur_len >= 1000:
                    print(f"[MT5 Bridge] Broker history reached maximum available ({cur_len} bars).")
                    break

                prev_len = cur_len

            if is_stale(rates, timeframe):
                last_bar_dt = datetime.utcfromtimestamp(int(rates[-1]['time'])) if rates else None
                print(f"[MT5 Bridge Warning] Data for '{actual_symbol}' ({timeframe}) still appears STALE after all retries. "
                      f"Last bar: {last_bar_dt} UTC. This usually means the MT5 terminal itself has not synced "
                      f"recent history from the broker (terminal offline / chart never opened / broker feed delay). "
                      f"Try opening the '{actual_symbol}' chart manually in the MT5 terminal.")

        if rates is None or len(rates) == 0:
            # Fallback with smaller counts if requested count exceeds available broker history
            print(f"[MT5 Bridge] History still missing after download retries. Testing fallback count list [1000, 500, 250, 100]...")
            for fallback_count in [1000, 500, 250, 100]:
                if fallback_count < effective_count:
                    print(f"[MT5 Bridge] copy_rates_from_pos failed for {actual_symbol} TF={mt5_tf_int} count={effective_count}, retrying count={fallback_count}")
                    rates = mt5.copy_rates_from_pos(actual_symbol, mt5_tf_int, 0, fallback_count)
                    if rates is not None and len(rates) > 0:
                        print(f"[MT5 Bridge] Fallback count {fallback_count} succeeded with {len(rates)} bars")
                        break

    if rates is not None and len(rates) > 0:
        candles = []
        for rate in rates:
            candles.append({
                "time": int(rate['time']),
                "open": float(rate['open']),
                "high": float(rate['high']),
                "low": float(rate['low']),
                "close": float(rate['close'])
            })
        print(f"[MT5 Bridge] Successfully fetched {len(candles)} native candles for '{actual_symbol}' on timeframe '{timeframe}' (MT5 TF code: {mt5_tf_int})")
        return {
            "status": "ok",
            "symbol": symbol,
            "actual_symbol": actual_symbol,
            "timeframe": timeframe,
            "candles": candles
        }
    else:
        last_err = mt5.last_error() if MT5_AVAILABLE else "MT5 library not available"
        term_info = mt5.terminal_info() if MT5_AVAILABLE else None
        acc_info = mt5.account_info() if MT5_AVAILABLE else None
        
        term_path = getattr(term_info, "path", "N/A") if term_info else "N/A"
        acc_server = getattr(acc_info, "server", "N/A") if acc_info else "N/A"
        
        err_msg = f"Could not copy rates for '{actual_symbol}'. MT5 last_error: {last_err} (TF: '{timeframe}', code: {mt5_tf_int}, count: {effective_count}, server: {acc_server})"
        print(f"[MT5 Bridge Error] {err_msg} Terminal Path: {term_path}")
        return {
            "status": "error",
            "message": err_msg
        }

@app.get("/")
async def get_current_price(
    symbol: str = Query("EURUSD", description="Symbol name, e.g. EURUSD")
):
    # If MT5 is available, try getting the price from the terminal
    if MT5_AVAILABLE and mt5.initialize():
        clean_symbol = symbol.replace("_", "")  # Handle EUR_USD -> EURUSD
        tick = mt5.symbol_info_tick(clean_symbol)
        if tick is not None:
            return {
                "status": "ok",
                "symbol": symbol,
                "bid": tick.bid,
                "ask": tick.ask,
                "last": tick.last if tick.last > 0 else (tick.bid + tick.ask) / 2,
                "time": tick.time,
                "provider": "mt5"
            }
        else:
            # Try getting last info if tick info isn't streaming yet
            symbol_info = mt5.symbol_info(clean_symbol)
            if symbol_info is not None:
                last_price = symbol_info.ask if symbol_info.ask > 0 else symbol_info.bid
                return {
                    "status": "ok",
                    "symbol": symbol,
                    "bid": symbol_info.bid,
                    "ask": symbol_info.ask,
                    "last": last_price,
                    "time": int(symbol_info.time),
                    "provider": "mt5"
                }

    # If MT5 is not available or failed, fallback to Twelve Data proxy using env variable!
    return get_price(symbol)

@app.on_event("shutdown")
def shutdown_event():
    if MT5_AVAILABLE:
        mt5.shutdown()
        print("MetaTrader5 connection closed safely.")

if __name__ == '__main__':
    import uvicorn
    print("=" * 60)
    print("[MT5 Bridge] BUILD TAG: v2-live-candle-fix (bridge.py)")
    print("=" * 60)
    print("Starting MT5 Bridge FastAPI Server on port 8000...")
    uvicorn.run(app, host="127.0.0.1", port=8000)
