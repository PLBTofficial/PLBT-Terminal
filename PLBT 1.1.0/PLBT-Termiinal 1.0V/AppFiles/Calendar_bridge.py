import json
import os
import re
import time
import urllib.request
import urllib.error
from datetime import datetime, timedelta
from typing import List, Optional
import calendar

try:
    from fastapi import FastAPI, Query
    from fastapi.middleware.cors import CORSMiddleware
    import uvicorn
    FASTAPI_AVAILABLE = True
except ImportError:
    FASTAPI_AVAILABLE = False
    print("[Calendar Bridge] Note: fastapi or uvicorn not installed. Running in standalone mode.")

# --- СИСТЕМА КЭШИРОВАНИЯ ДЛЯ БЕКТЕСТЕРА ---
# Сохраняем данные на диск, чтобы не ждать парсинга при каждом перезапуске
CACHE_DIR = "cache"
CALENDAR_CACHE_FILE = os.path.join(CACHE_DIR, "calendar_cache.json")
COT_CACHE_FILE = os.path.join(CACHE_DIR, "cot_cache.json")

if not os.path.exists(CACHE_DIR):
    os.makedirs(CACHE_DIR)

def load_cache(filepath: str) -> dict:
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        except:
            return {}
    return {}

def save_cache(filepath: str, data: dict):
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

# Загружаем кэш в память при старте
calendar_cache = load_cache(CALENDAR_CACHE_FILE)
cot_cache = load_cache(COT_CACHE_FILE)

# --- ОЧИСТКА СТАРОГО ИСПОРЧЕННОГО КЭША ---
# В старой версии моковые (фейковые) события кэшировались навсегда наравне с реальными.
# При старте вычищаем такие записи, чтобы для них запустился повторный скрейпинг реальных данных.
def _purge_stale_mock_entries(cache_dict: dict) -> bool:
    changed = False
    for key in list(cache_dict.keys()):
        entry = cache_dict[key]
        events = entry.get("events", entry) if isinstance(entry, dict) else entry
        if events and any(e.get("is_mock") for e in events):
            del cache_dict[key]
            changed = True
    return changed

if _purge_stale_mock_entries(calendar_cache):
    save_cache(CALENDAR_CACHE_FILE, calendar_cache)
    print("[Calendar Bridge] Очищены устаревшие мок-записи из кэша календаря — будет выполнен повторный скрейпинг.")

# --- MOCK DATA ---
MOCK_EVENT_TEMPLATES = [
    {"currency": "USD", "impact": "high", "event": "Fed Interest Rate Decision", "time": "14:00", "actual": "5.25%", "forecast": "5.25%", "previous": "5.50%"},
    {"currency": "USD", "impact": "high", "event": "CPI y/y", "time": "08:30", "actual": "3.1%", "forecast": "3.2%", "previous": "3.4%"},
    {"currency": "USD", "impact": "high", "event": "Non-Farm Payrolls", "time": "08:30", "actual": "216K", "forecast": "170K", "previous": "173K"},
    {"currency": "EUR", "impact": "high", "event": "ECB Interest Rate Decision", "time": "08:15", "actual": "4.50%", "forecast": "4.50%", "previous": "4.50%"},
]

# --- УТИЛИТА ДЛЯ ВРЕМЕНИ ---
def parse_ff_time_to_unix(date_str: str, time_str: str) -> int:
    """
    Конвертирует дату (YYYY-MM-DD) и время FF (например "8:30am" или "15:30") 
    в точный UNIX timestamp. По умолчанию FF отдает время в Eastern Time (EST/EDT).
    """
    try:
        if not time_str or time_str.lower() in ["all day", "tentative", "—"]:
            time_str = "00:00"
            
        # Парсинг 12-часового (am/pm) или 24-часового формата
        time_str = time_str.strip().lower()
        if "am" in time_str or "pm" in time_str:
            dt_obj = datetime.strptime(f"{date_str} {time_str}", "%Y-%m-%d %I:%M%p")
        else:
            # Очистка от лишних символов
            time_str = re.sub(r'[^0-9:]', '', time_str)
            dt_obj = datetime.strptime(f"{date_str} {time_str}", "%Y-%m-%d %H:%M")
            
        # Грубый сдвиг на UTC (EST = UTC-5, EDT = UTC-4). Для надежности берем базово +5 часов к FF времени
        utc_dt = dt_obj + timedelta(hours=5) 
        return int(calendar.timegm(utc_dt.timetuple()))
    except Exception:
        return 0

def get_deterministic_mock_events(date_str: str) -> List[dict]:
    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
    except Exception:
        dt = datetime.now()

    if dt.weekday() in (5, 6): return []

    # Событие считается "прошедшим" только если оно раньше текущего момента —
    # у ещё не наступивших событий не может быть "Факта" (это выдавало подделку).
    is_past_event = dt.date() < datetime.now().date()

    events = []
    day_hash = (dt.day * 7 + dt.month * 13 + dt.year) % len(MOCK_EVENT_TEMPLATES)
    num_events = 2 + (dt.day % 3)

    for i in range(num_events):
        idx = (day_hash + i * 3) % len(MOCK_EVENT_TEMPLATES)
        template = MOCK_EVENT_TEMPLATES[idx]
        event_obj = {
            "date": date_str,
            "time": template["time"],
            "timestamp": parse_ff_time_to_unix(date_str, template["time"]), # Добавлен точный timestamp!
            "currency": template["currency"],
            "impact": template["impact"],
            "event": template["event"],
            "actual": template["actual"] if is_past_event else "—",
            "forecast": template["forecast"],
            "previous": template["previous"],
            "is_mock": True,
        }
        events.append(event_obj)
    return events


def scrape_ff_date(date_str: str) -> List[dict]:
    # 1. ПРОВЕРЯЕМ КЭШ - но только если это НЕ мок-данные, либо мок ещё "свежий" (< 15 минут).
    #    Реальные скрейпленные данные (или легитимно пустые выходные) кэшируются навсегда.
    #    Мок-фолбэк кэшируется лишь ненадолго, чтобы не долбить сайт при каждом запросе,
    #    но и не застревать с выдуманными новостями навсегда, если скрейп один раз не удался.
    cached_entry = calendar_cache.get(date_str)
    if cached_entry is not None:
        # Поддержка старого формата кэша (просто список) и нового (словарь с cached_at)
        if isinstance(cached_entry, dict):
            cached_events = cached_entry.get("events", [])
            cached_at = cached_entry.get("cached_at", 0)
        else:
            cached_events = cached_entry
            cached_at = 0

        is_mock_cached = any(e.get("is_mock") for e in cached_events) if cached_events else False

        if not is_mock_cached:
            return cached_events
        if (time.time() - cached_at) < 900:  # 15 минут
            return cached_events
        # иначе кэш мока устарел — пробуем скрейпить заново ниже

    try:
        dt = datetime.strptime(date_str, "%Y-%m-%d")
    except Exception as e:
        return get_deterministic_mock_events(date_str)

    if dt.weekday() in (5, 6):
        calendar_cache[date_str] = {"events": [], "cached_at": time.time()} # Кэшируем пустые выходные навсегда
        save_cache(CALENDAR_CACHE_FILE, calendar_cache)
        return []

    month_abbr = dt.strftime("%b").lower()
    ff_day = f"{month_abbr}{dt.day}.{dt.year}"
    url = f"https://www.forexfactory.com/calendar?day={ff_day}"

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html",
        "Referer": "https://www.forexfactory.com/"
    }

    # 2. АНТИ-БАН ЗАДЕРЖКА (только если данных нет в кэше)
    time.sleep(0.5) 

    events = []
    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=10) as response:
            if response.status != 200:
                events = get_deterministic_mock_events(date_str)
            else:
                html_text = response.read().decode("utf-8", errors="ignore")
                row_regex = re.compile(r'<tr[^>]*class="[^"]*calendar__row[^"]*"[^>]*>(.*?)</tr>', re.DOTALL | re.IGNORECASE)
                rows = row_regex.findall(html_text)

                last_time = "All Day"
                for row in rows:
                    time_match = re.search(r'calendar__cell calendar__time[^>]*>(?:<[^>]+>)*\s*([^<]+)', row, re.IGNORECASE)
                    if time_match and time_match.group(1).strip():
                        last_time = time_match.group(1).strip()

                    curr_match = re.search(r'calendar__cell calendar__currency[^>]*>(?:<[^>]+>)*\s*([A-Z]{3})', row, re.IGNORECASE)
                    if not curr_match: continue
                    currency = curr_match.group(1).strip().upper()

                    impact = "low"
                    if "impact-red" in row or "impact-high" in row: impact = "high"
                    elif "impact-ora" in row or "impact-medium" in row: impact = "medium"
                    elif "impact-gra" in row or "impact-non" in row: impact = "none"

                    title_m = re.search(r'calendar__cell calendar__event[^>]*>(?:<[^>]+>)*\s*([^<]+)', row, re.IGNORECASE)
                    actual_m = re.search(r'calendar__cell calendar__actual[^>]*>(?:<[^>]+>)*\s*([^<]+)', row, re.IGNORECASE)
                    fore_m = re.search(r'calendar__cell calendar__forecast[^>]*>(?:<[^>]+>)*\s*([^<]+)', row, re.IGNORECASE)
                    prev_m = re.search(r'calendar__cell calendar__previous[^>]*>(?:<[^>]+>)*\s*([^<]+)', row, re.IGNORECASE)

                    events.append({
                        "date": date_str,
                        "time": last_time,
                        "timestamp": parse_ff_time_to_unix(date_str, last_time), # Точное время публикации для бектеста!
                        "currency": currency,
                        "impact": impact,
                        "event": title_m.group(1).strip() if title_m else "Event",
                        "actual": actual_m.group(1).strip() if actual_m else "—",
                        "forecast": fore_m.group(1).strip() if fore_m else "—",
                        "previous": prev_m.group(1).strip() if prev_m else "—",
                        "is_mock": False,
                    })
                
                if not events: events = get_deterministic_mock_events(date_str)

    except Exception as e:
        print(f"[Calendar Bridge] FF Scrape Error for {date_str}: {e}")
        events = get_deterministic_mock_events(date_str)

    # 3. СОХРАНЯЕМ В КЭШ
    #    Мок-данные помечаются временем кэширования, чтобы попытка скрейпа повторилась
    #    автоматически через 15 минут — реальные данные кэшируются бессрочно.
    calendar_cache[date_str] = {"events": events, "cached_at": time.time()}
    save_cache(CALENDAR_CACHE_FILE, calendar_cache)
    return events


if FASTAPI_AVAILABLE:
    app = FastAPI(title="Calendar & COT Bridge", version="1.1.0")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

    @app.get("/economic-calendar")
    def get_economic_calendar(from_date: str = Query(..., alias="from"), to_date: str = Query(..., alias="to")):
        try:
            start_dt = datetime.strptime(from_date, "%Y-%m-%d")
            end_dt = datetime.strptime(to_date, "%Y-%m-%d")
        except:
            return {"status": "error", "message": "Invalid date format (use YYYY-MM-DD)"}

        all_events = []
        curr = start_dt
        while curr <= end_dt:
            date_str = curr.strftime("%Y-%m-%d")
            all_events.extend(scrape_ff_date(date_str))
            curr += timedelta(days=1)

        # Сортировка по точному времени публикации
        all_events.sort(key=lambda x: x.get("timestamp", 0))
        return all_events

    @app.get("/cot")
    def get_cot_data(symbol: str = Query(...), type: str = Query("combined")):
        cache_key = f"{symbol.upper()}_{type}"
        
        # Моментальная отдача COT из кэша (эти данные редко обновляются)
        if cache_key in cot_cache:
            return cot_cache[cache_key]

        CFTC_MAP = {
            "EUR": "099741", "EURUSD": "099741",
            "GBP": "096742", "GBPUSD": "096742",
            "JPY": "097741", "USDJPY": "097741",
            "GOLD": "088691", "XAUUSD": "088691",
            "BTC": "133741", "BTCUSD": "133741",
        }
        code = CFTC_MAP.get(symbol.upper(), "099741")
        dataset_id = "6dca-aqww" if type == "futures_only" else "jun7-fc8e"
        url = f"https://publicreporting.cftc.gov/resource/{dataset_id}.json?$where=cftc_contract_market_code='{code}' AND report_date_as_yyyy_mm_dd >= '2020-01-01'&$limit=5000&$order=report_date_as_yyyy_mm_dd ASC"

        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                
                # Кэшируем результат
                cot_cache[cache_key] = data
                save_cache(COT_CACHE_FILE, cot_cache)
                return data
        except Exception as err:
            return {"status": "error", "message": f"COT fetch failed: {err}"}

if __name__ == "__main__":
    if FASTAPI_AVAILABLE:
        print("[Calendar Bridge] Starting FastAPI server on http://127.0.0.1:8001 ...")
        uvicorn.run(app, host="127.0.0.1", port=8001)