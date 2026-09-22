import sys
from datetime import datetime

try:
    import MetaTrader5 as mt5
    HAS_MT5 = True
except ImportError:
    HAS_MT5 = False

print("=" * 70)
print("  MT5 W1 DIAGNOSTIC SCRIPT (Checking 3 Causes)")
print("=" * 70)

if not HAS_MT5:
    print("MetaTrader5 Python library is not installed in this Linux environment.")
    print("Note: In production on Windows host where MT5 terminal runs, bridge.py executes this.")
    sys.exit(0)

# ПРОВЕРКА 2: Инициализация и проверка параметров сессии/терминала
print("\n[ПРОВЕРКА 2] Инициализация и проверка активной сессии MT5...")
init_res = mt5.initialize()
if not init_res:
    print("❌ mt5.initialize() FAILED! Error:", mt5.last_error())
    sys.exit(1)

term_info = mt5.terminal_info()
acc_info = mt5.account_info()

if term_info:
    print("  ✓ Terminal Name:", getattr(term_info, "name", "N/A"))
    print("  ✓ Terminal Path:", getattr(term_info, "path", "N/A"))
    print("  ✓ Terminal Connected:", getattr(term_info, "connected", False))
if acc_info:
    print("  ✓ Account Login:", getattr(acc_info, "login", "N/A"))
    print("  ✓ Account Server:", getattr(acc_info, "server", "N/A"))
    print("  ✓ Account Currency:", getattr(acc_info, "currency", "N/A"))

# ПРОВЕРКА 3: Поиск точного имени символа через mt5.symbols_get()
print("\n[ПРОВЕРКА 3] Поиск точного имени символа в брокерском списке...")
target_raw = "EURUSD"
exact_symbol = None

symbols = mt5.symbols_get()
if symbols:
    print(f"  ✓ Total symbols retrieved from MT5: {len(symbols)}")
    matching = [s.name for s in symbols if target_raw.lower() in s.name.lower()]
    print(f"  ✓ Matching symbols for '{target_raw}':", matching)
    if matching:
        exact_symbol = matching[0]
else:
    print("  ⚠️ symbols_get() returned None, falling back to raw 'EURUSD'")
    exact_symbol = target_raw

print(f"  --> Selected exact symbol for request: '{exact_symbol}'")

# ПРОВЕРКА 1: Выбор символа в Market Watch перед запросом
print(f"\n[ПРОВЕРКА 1] Активация символа '{exact_symbol}' в Market Watch...")
select_res = mt5.symbol_select(exact_symbol, True)
if not select_res:
    print(f"  ❌ symbol_select('{exact_symbol}', True) returned False! Error:", mt5.last_error())
else:
    print(f"  ✓ Symbol '{exact_symbol}' successfully selected in Market Watch.")

# Выполнение запроса copy_rates_from_pos
print(f"\n[ЗАПРОС W1] Вызов mt5.copy_rates_from_pos('{exact_symbol}', mt5.TIMEFRAME_W1, 0, 20)...")
rates = mt5.copy_rates_from_pos(exact_symbol, mt5.TIMEFRAME_W1, 0, 20)

if rates is None or len(rates) == 0:
    err = mt5.last_error()
    print(f"❌ copy_rates_from_pos FAILED! mt5.last_error = {err}")
else:
    print(f"✅ УСПЕХ! Получено {len(rates)} нативных W1-баров из MT5:\n")
    print(f"{'INDEX':<6} {'DATE (UTC)':<20} {'OPEN':<10} {'HIGH':<10} {'LOW':<10} {'CLOSE':<10} {'RANGE (pips)':<12}")
    print("-" * 80)
    for i, r in enumerate(rates):
        dt_str = datetime.utcfromtimestamp(r['time']).strftime('%Y-%m-%d %H:%M:%S')
        high_diff = r['high'] - r['low']
        print(f"{i:<6} {dt_str:<20} {r['open']:<10.5f} {r['high']:<10.5f} {r['low']:<10.5f} {r['close']:<10.5f} {high_diff:<12.5f}")

mt5.shutdown()
