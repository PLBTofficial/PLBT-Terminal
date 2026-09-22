@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   PLBT Trader Terminal - Launcher
echo ============================================

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found. Install it from https://nodejs.org
    pause
    exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
    echo [WARNING] Python not found. Calendar/COT bridge will not start.
)

if not exist "node_modules" (
    echo Installing dependencies, this may take a few minutes...
    call npm install
)

if not exist "dist" (
    echo Building application...
    call npm run build
)

echo Starting Python bridge services...
where python >nul 2>nul
if not errorlevel 1 (
    if exist "Calendar_bridge.py" start "Calendar Bridge" cmd /c "python Calendar_bridge.py"
    if exist "bridge.py" start "MT5 Bridge" cmd /c "python bridge.py"
)

echo Starting server...
start "PLBT Server" cmd /c "npx tsx server.ts"

timeout /t 3 /nobreak >nul
start "" "http://localhost:3000"

endlocal
