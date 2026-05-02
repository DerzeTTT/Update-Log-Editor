@echo off
setlocal
cd /d "%~dp0"
echo Starting Update Log Editor...
echo.
npm start
if errorlevel 1 (
  echo.
  echo Update Log Editor failed to start.
  pause
)
