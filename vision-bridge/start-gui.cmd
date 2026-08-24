@echo off
setlocal
cd /d "%~dp0"
node gui\server.mjs --with-lms-dev
if errorlevel 1 pause
