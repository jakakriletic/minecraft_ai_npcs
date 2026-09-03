@echo off
title Summon Kingdom
setlocal
cd /d "%~dp0"

REM Uporaba:
REM   summon_kingdom.bat          zacne kraljestvo, ce se ne tece
REM   summon_kingdom.bat stop     odstrani NPC-je iz serverja
REM   summon_kingdom.bat restart  cist restart NPC-jev
REM   summon_kingdom.bat status   pokaze ali kraljestvo tece

if /I "%~1"=="stop" goto stop
if /I "%~1"=="restart" goto restart
if /I "%~1"=="status" goto status
if /I "%~1"=="" goto start

echo Neznan ukaz: %~1
echo Uporabi: summon_kingdom.bat [stop^|restart^|status]
pause
exit /b 2

:status
node scripts\kingdomctl.mjs status
pause
exit /b %ERRORLEVEL%

:stop
node scripts\kingdomctl.mjs stop
pause
exit /b %ERRORLEVEL%

:restart
node scripts\kingdomctl.mjs stop
if ERRORLEVEL 1 (
    echo Stop ni uspel. Ne bom zagnal dvojnih botov.
    pause
    exit /b 1
)
goto run

:start
node scripts\kingdomctl.mjs status >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo Kingdom ze tece.
    echo Za cist restart uporabi: summon_kingdom.bat restart
    echo Za odstranitev uporabi: summon_kingdom.bat stop
    pause
    exit /b 0
)

:run
REM Priklice kraljestvo. 8 GB heap je dovolj visoko za gladko delovanje, brez da Node poje ves RAM.
node --max-old-space-size=8192 --max-semi-space-size=128 main.js
pause
exit /b %ERRORLEVEL%
