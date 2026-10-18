@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
echo Checking Python...
where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Please install Python or add it to PATH.
  pause
  exit /b 1
)
echo Installing required packages...
python -m pip install -r requirements.txt
if errorlevel 1 (
  echo Package installation failed. Check your Python and pip setup.
  pause
  exit /b 1
)
echo Starting the vocabulary extractor...
python "%~dp0extractor.py"
if errorlevel 1 (
  echo.
  echo The program exited with an error.
  pause
  exit /b 1
)
pause
