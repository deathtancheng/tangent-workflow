@echo off
rem ============================================================
rem  《拾物奇谭》—— 只想玩游戏，双击这个
rem
rem  它会做的事：
rem    1. 确保 Web 服务在跑（5178）
rem    2. 打开游戏页面
rem
rem  如果摄像头服务（5179）没在跑，游戏里的「手动举物」
rem  依然能完整玩完五层，不影响演示。
rem ============================================================

cd /d "%~dp0"

rem ---- Node：优先 current 软链，再扫版本目录，最后用 PATH ----
set "NODE="
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe" (
  set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\current\node.exe"
)
if not defined NODE (
  for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if exist "%%d\node.exe" set "NODE=%%d\node.exe"
  )
)
if not defined NODE set "NODE=node"

echo.
echo   《拾物奇谭》
echo   ============================================

rem ---- Web 服务已在跑就跳过 ----
netstat -ano | findstr "127.0.0.1:5178" | findstr LISTENING >nul 2>&1
if not errorlevel 1 (
  echo   Web 服务已经在跑了。
  goto open
)

echo   正在启动 Web 服务 ...
start "拾物奇谭-web" /min "%NODE%" server.js
timeout /t 4 >nul

curl -s -m 5 http://127.0.0.1:5178/api/game/state >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [错误] Web 服务没起来。
  echo   检查一下是不是 Node 路径不对，或者 5178 端口被占了。
  echo   当前用的 Node：%NODE%
  echo.
  pause
  exit /b 1
)
echo   Web 服务就绪。

:open
echo   打开游戏页面 ...
start "" http://127.0.0.1:5178/public/game.html

echo.
echo   ============================================
echo   浏览器应该已经开了。点「献祭此物」开始。
echo.
echo   没有摄像头？点页面上的「手动举物」，
echo   挑个东西献上去，一样能玩。
echo.
echo   关掉服务请运行 stop.bat
echo.
timeout /t 3 >nul
