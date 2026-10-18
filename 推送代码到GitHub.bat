@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ==========================================
echo   Wordbook MiniApp - Push to GitHub
echo ==========================================
echo.

git rev-parse --git-dir >nul 2>&1
if errorlevel 1 (
  echo [!] Not a git repository.
  pause
  exit /b 1
)

set "REMOTE="
for /f "tokens=*" %%i in ('git remote get-url origin 2^>nul') do set "REMOTE=%%i"

if "!REMOTE!"=="" (
  echo No remote configured yet.
  echo Open https://github.com/new to create an EMPTY private repo first
  echo   - do NOT add README / .gitignore / license
  echo   - repo name suggestion: wordbook-miniapp
  echo.
  set /p "URL=Repo URL (e.g. https://github.com/yourname/wordbook-miniapp.git): "
  if "!URL!"=="" (
    echo [!] URL is empty, abort.
    pause
    exit /b 1
  )
  git remote add origin !URL!
  echo [+] remote origin set to !URL!
) else (
  echo [i] remote origin = !REMOTE!
)

echo.
echo --- Staging changes ---
git add -A

set "MSG="
for /f "tokens=1-3 delims=/-. " %%a in ("%date%") do set "D=%%a-%%b-%%c"
git diff --cached --quiet
if errorlevel 1 (
  git commit -q -m "update: %D% %time:~0,5%"
  echo [+] committed
) else (
  echo [i] nothing new to commit
)

echo.
echo --- Pushing (a browser window may pop up for GitHub login) ---
git push -u origin main
if errorlevel 1 (
  echo.
  echo [!] Push failed. Check the message above.
  echo     - if repo already has commits, run:  git pull --rebase origin main
  pause
  exit /b 1
)

echo.
echo [OK] Done. Open your repo page to confirm.
pause
