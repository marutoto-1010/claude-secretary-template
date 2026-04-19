@echo off
chcp 65001 >nul
title Claude Secretary - Polling Dispatcher

echo ============================================
echo   Claude Secretary - Polling Dispatcher
echo   Slack #claude-inbox を5分間隔で巡回
echo ============================================
echo.

:loop
node "%~dp0secretary-loop.js"
echo.
echo [%date% %time%] Process exited. Restarting in 10s...
timeout /t 10 /nobreak >nul 2>nul
goto loop
