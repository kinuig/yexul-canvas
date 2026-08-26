@echo off
setlocal
cd /d "%~dp0"

rem ---- prefer bundled node.exe, fall back to system Node ----
set "NODE_EXE=%~dp0node\node.exe"
set "NODE_CMD=%NODE_EXE%"
if not exist "%NODE_EXE%" set "NODE_CMD=node"

"%NODE_CMD%" -v >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    echo Please install Node.js 18+ from https://nodejs.org
    echo or put node.exe into the "node" folder of this app.
    echo.
    pause
    exit /b 1
)

echo Starting YexuL Canvas ...
echo The browser will open automatically. Keep this window open.
echo.

"%NODE_CMD%" server.js

echo.
echo Server stopped.
pause
