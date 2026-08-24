@echo off
setlocal
cd /d "%~dp0vision-bridge"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found in PATH.
  echo Install Node.js or open this project from an environment where node is available.
  pause
  exit /b 1
)
node gui\server.mjs --with-lms-dev
if errorlevel 1 pause
