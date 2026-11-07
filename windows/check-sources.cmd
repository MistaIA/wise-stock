@echo off
rem Checks the live sources (NGX, BRVM, BVMAC, Google News headlines, X posts through a Nitter mirror) with the code of SM-02 and SM-03, no keys needed.
rem windows\check-sources.cmd   Details: tools\check-sources.mjs
rem What it prints and what each site returned are saved in live-check\latest (another folder: --save "<folder>").
rem Uses the Node that windows\install-n8n.cmd installed, or the node on PATH, and the libraries of your n8n.
setlocal
set "NODE_EXE=%LOCALAPPDATA%\n8n-sm\node\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
if "%NODE_EXE%"=="node" where node >nul 2>nul || (echo Node.js was not found. Run windows\install-n8n.cmd first. & pause & exit /b 2)
"%NODE_EXE%" "%~dp0..\tools\check-sources.mjs" --save "%~dp0..\live-check\latest" %*
set "CODE=%ERRORLEVEL%"
pause
exit /b %CODE%
