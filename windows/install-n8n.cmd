@echo off
rem Installs n8n 2.46.6 with npm and retries every hour when the internet fails. Details: install-n8n.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-n8n.ps1" %*
set RC=%ERRORLEVEL%
echo.
if "%RC%"=="0" echo Done. Next: copy windows\n8n.env.example to windows\n8n.env, fill in your keys, then run windows\start-n8n.cmd
if "%RC%"=="1" echo The internet failed: the install retries every hour in the background. Log: %LOCALAPPDATA%\n8n-sm\install.log
if "%RC%"=="2" echo The install stopped on an error. Log: %LOCALAPPDATA%\n8n-sm\install.log
if "%RC%"=="3" echo Another install run is busy. Log: %LOCALAPPDATA%\n8n-sm\install.log
pause
exit /b %RC%
