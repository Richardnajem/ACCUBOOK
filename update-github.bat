@echo off
setlocal EnableDelayedExpansion

REM ============================================
REM  ACCUBOOK - One-click GitHub backup & push
REM  Always backs up before pushing.
REM  Double-click this file to update GitHub.
REM ============================================

cd /d "%~dp0"

echo.
echo ============================================
echo   ACCUBOOK - GitHub Update (Admin Push)
echo ============================================
echo.

REM ---------- 1. Check gh CLI is installed ----------
where gh >nul 2>nul
if errorlevel 1 (
    echo [ERROR] GitHub CLI not found. Install it: https://cli.github.com/
    pause
    exit /b 1
)

REM ---------- 2. Check logged in ----------
gh auth status >nul 2>nul
if errorlevel 1 (
    echo [INFO] Not logged into GitHub. Starting login...
    gh auth login --hostname github.com --git-protocol https --web
    if errorlevel 1 (
        echo [ERROR] GitHub login failed.
        pause
        exit /b 1
    )
    echo.
)

REM ---------- 3. ALWAYS backup database BEFORE pushing ----------
echo [1/5] Backing up database...
if not exist backups mkdir backups
if exist portfolio.db (
    for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HH-mm-ss"') do set TS=%%i
    copy /y portfolio.db "backups\portfolio_!TS!.db" >nul
    copy /y portfolio.db "backups\latest.db" >nul
    echo     OK - backups\portfolio_!TS!.db
) else (
    echo     No portfolio.db found, skipping backup.
)
echo.

REM ---------- 4. Stage everything ----------
echo [2/5] Staging changes...
git add -A
echo.

REM ---------- 5. Check there is something to commit ----------
echo [3/5] Checking for changes...
git diff --cached --quiet
if errorlevel 1 (
    set /p COMMIT_MSG=Commit message [default: Update project]: 
    if "!COMMIT_MSG!"=="" set COMMIT_MSG=Update project
    git commit -m "!COMMIT_MSG!"
    if errorlevel 1 (
        echo [ERROR] Commit failed.
        pause
        exit /b 1
    )
) else (
    echo     Nothing new to commit - pushing anyway in case remote moved ahead.
)
echo.

REM ---------- 6. Push ----------
echo [4/5] Pushing to GitHub...
git push origin master
if errorlevel 1 (
    echo.
    echo [WARN] Push failed - remote may be ahead. Pulling and retrying...
    git pull --rebase origin master
    git push origin master
    if errorlevel 1 (
        echo [ERROR] Push failed after retry. Fix conflicts manually.
        pause
        exit /b 1
    )
)
echo.

REM ---------- 7. Cleanup old backups keep last 30 ----------
echo [5/5] Cleaning old backups keeping last 30...
powershell -NoProfile -Command "Get-ChildItem backups -Filter 'portfolio_*.db' | Sort-Object Name -Descending | Select-Object -Skip 30 | Remove-Item -Force -ErrorAction SilentlyContinue"

echo.
echo ============================================
echo   DONE - All changes pushed to GitHub.
echo   Backup saved in backups\ folder.
echo ============================================
echo.
pause
