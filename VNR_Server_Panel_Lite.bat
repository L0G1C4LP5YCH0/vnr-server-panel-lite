@echo off
setlocal
rem VNR_Server_Panel_Lite.bat -- starts the VNR CyberPunk Server Panel Lite. The launcher restarts itself in this window after an update (exit code 75).
cd /d "%~dp0"
title VNR CyberPunk Server Panel Lite
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 18 or newer from https://nodejs.org ^(LTS^) and run this again.
  pause
  exit /b 1
)
node -e "process.exit(+process.versions.node.split('.')[0]>=18?0:1)" >nul 2>&1
if errorlevel 1 (
  echo Node.js is too old for the launcher. Install Node.js 18 or newer from https://nodejs.org and run this again.
  pause
  exit /b 1
)
set "VNR_BAT=1"
:run
node server.js %*
if errorlevel 75 (
  echo.
  echo Restarting the launcher ...
  timeout /t 1 /nobreak >nul
  goto run
)
echo.
echo The launcher stopped. The game server keeps running if it was started.
pause
