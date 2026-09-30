@echo off
title Stockfolio - Portfolio Manager
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  Stockfolio launcher
rem    start.bat          -> Desktop app (Electron) - no questions asked
rem    start.bat browser  -> Browser mode on http://localhost:3000
rem ============================================================

rem --- Make sure Node.js is available ---
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo  [ERROR] Node.js is not installed or not in PATH.
    echo  Download from: https://nodejs.org
    echo.
    pause
    exit /b 1
)

if /i "%~1"=="browser" goto browser

rem ---------------- Default: Electron desktop app ----------------
echo.
echo  ======================================
echo      Stockfolio Portfolio Manager
echo  ======================================
echo.
echo  Starting Desktop App Mode (Electron)...
echo  Close the app window to stop.
echo  Tip: "start.bat browser" launches in the browser instead.
echo.

rem --- Kill leftover Electron instances (single-instance lock) ---
taskkill /IM electron.exe /F >nul 2>&1

rem --- Free both ports: Next 16 allows only ONE dev server per
rem     project dir, so a stray browser-mode server would make
rem     "next dev -p 3457" exit 1 immediately. ---
for /f "tokens=5" %%a in ('netstat -aon ^| findstr LISTENING ^| findstr ":3000 "') do (
    echo  Killing stale server on port 3000 (PID %%a)
    taskkill /PID %%a /F >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr LISTENING ^| findstr ":3457 "') do (
    echo  Killing stale server on port 3457 (PID %%a)
    taskkill /PID %%a /F >nul 2>&1
)

call npm run dev:electron
echo.
echo  App closed.
pause
exit /b 0

rem ---------------- Browser mode (opt-in) ----------------
:browser
echo.
echo  Starting Browser Mode...
echo  The dashboard will open automatically when the server is ready.
echo  Keep this window open. Press Ctrl+C to stop the server.
echo.

rem Free the browser-mode port
for /f "tokens=5" %%a in ('netstat -aon ^| findstr LISTENING ^| findstr ":3000 "') do (
    echo  Killing stale server on port 3000 (PID %%a)
    taskkill /PID %%a /F >nul 2>&1
)

rem Hidden watcher: opens the dashboard as soon as the server responds
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 240;$i++){ try{ $null=Invoke-WebRequest -Uri 'http://localhost:3000' -UseBasicParsing -TimeoutSec 2; Start-Process 'http://localhost:3000'; exit }catch{ Start-Sleep -Milliseconds 500 } }"

call npm run dev
echo.
echo  Server stopped.
pause
exit /b 0
