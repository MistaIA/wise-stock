@echo off
rem Fetches n8n templates with defuddle: templates\fetch-templates.cmd [--ids 3202,10460 ^| --match telegram ^| --all]
rem Uses the Node that windows\install-n8n.cmd installed, or the node on PATH.
setlocal
set "NODE_EXE=%LOCALAPPDATA%\n8n-sm\node\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
if "%NODE_EXE%"=="node" where node >nul 2>nul || (echo Node.js was not found. Run windows\install-n8n.cmd first. & pause & exit /b 2)
"%NODE_EXE%" "%~dp0fetch-templates.mjs" %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" pause
exit /b %CODE%
