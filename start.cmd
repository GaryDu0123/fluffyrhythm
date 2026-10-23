@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo 请先安装 Node.js 18 或更新版本，再启动游戏。
  pause
  exit /b 1
)
node server.mjs --open
if errorlevel 1 pause
