@echo off
title Stockfolio - Portfolio Manager
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  Stockfolio / ACCUBOOK launcher
rem    start.bat              -> Desktop app (Electron) - DEFAULT
rem    start.bat browser      -> Browser mode on http://localhost:3000
rem    start.bat update       -> Check GitHub for updates + download
rem    start.bat test-updates -> Verify the update flow (self-test)
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
if /i "%~1"=="update" goto update
if /i "%~1"=="test-updates" goto testupdates

rem ============================================================
rem  DEFAULT: go straight to the Electron desktop app
rem ============================================================
echo.
echo  Starting Desktop App (Electron)...
echo  Close the app window to stop.
echo  Tip: "start.bat browser" launches in the browser instead.
echo.

rem --- First run on a fresh clone: install dependencies ---
if not exist "node_modules" (
    echo  First run detected - installing dependencies ^(one time, a few minutes^)...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo  [ERROR] npm install failed. Check your internet connection and retry.
        echo.
        pause
        exit /b 1
    )
    echo.
)

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

rem --- First run on a fresh clone: install dependencies ---
if not exist "node_modules" (
    echo  First run detected - installing dependencies ^(one time, a few minutes^)...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo  [ERROR] npm install failed. Check your internet connection and retry.
        echo.
        pause
        exit /b 1
    )
    echo.
)

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

rem ---------------- Manual update check (GitHub Releases) ----------------
:update
echo.
echo  Checking GitHub for updates (manual - the app never does this on its own)...
echo.
node scripts\update-app.js
echo.
echo  Update check finished.
pause
exit /b 0

rem ---------------- Self-test of the whole update flow ----------------
:testupdates
echo.
echo  Verifying the update flow (build + simulated release checks)...
echo  This takes a few minutes on first run.
echo.
call npm run test:updates
echo.
pause
exit /b 0
