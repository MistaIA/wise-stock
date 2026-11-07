@echo off
rem Starts n8n (installed by install-n8n.cmd) after the stock-market setup. Ctrl+C stops n8n. Details: start-n8n.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-n8n.ps1" %*
set RC=%ERRORLEVEL%
if not "%RC%"=="0" pause
exit /b %RC%
