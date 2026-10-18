@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 set "NODE=C:\Users\owen0\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"

"%NODE%" -v >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [ERROR] Node.js not found on this computer.
  echo  Ask the assistant in WorkBuddy to run the import for you.
  echo.
  pause
  exit /b 1
)

echo.
echo  ================================================
echo    STEP 1 / 3   xlsx  --^>  csv
echo  ================================================
echo.
"%NODE%" scripts\xlsx2csv.mjs
if errorlevel 1 goto fail

echo.
echo  ================================================
echo    STEP 2 / 3   clean + standard format
echo  ================================================
echo.
"%NODE%" scripts\import-wordlist.mjs
if errorlevel 1 goto fail

echo.
echo  ================================================
echo    STEP 3 / 3   build wordbook bundle
echo  ================================================
echo.
"%NODE%" scripts\build-dict.mjs
if errorlevel 1 goto fail

echo.
echo  ================================================
echo    DONE
echo    Open  preview\index.html  to check the result.
echo  ================================================
echo.
pause
exit /b 0

:fail
echo.
echo  [FAILED] Please copy the message above to the assistant.
echo.
pause
exit /b 1
