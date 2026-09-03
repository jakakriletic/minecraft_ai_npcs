@echo off
setlocal
REM AI NPC 1.20.1 - starts an optional local server and then the RP citizens.
cd /d "%~dp0"

set "EXPECTED_VERSION=1.20.1"
set "SERVER_PORT=25565"
set "SERVER_DIR=C:\Users\jakak\Desktop\Servers\ai_npc_1.20.1"

REM Ne dovoli druge kopije RP procesa iz TE mape.
powershell -NoProfile -Command "$f='src\rp\state\rp-runtime.json'; if (Test-Path -LiteralPath $f) { try { $j=Get-Content -Raw -LiteralPath $f | ConvertFrom-Json; $p=Get-Process -Id $j.pid -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'node' -and $j.settingsFile -like '*ai_npc_1.20.1*') { exit 0 } } catch {} }; exit 1"
if not errorlevel 1 (
    echo RP NPC-ji iz ai_npc_1.20.1 ze tecejo. Drugi zagon je preklican.
    pause
    exit /b 0
)

REM Ce port ni odprt, poskusi zagnati locen 1.20.1 server.
powershell -NoProfile -Command "$c=[Net.Sockets.TcpClient]::new(); try { $c.Connect('127.0.0.1',%SERVER_PORT%); exit 0 } catch { exit 1 } finally { $c.Dispose() }"
if errorlevel 1 goto start_server
goto verify_server

:start_server
if exist "%SERVER_DIR%\run.bat" (
    start "Minecraft 1.20.1" /D "%SERVER_DIR%" "%SERVER_DIR%\run.bat"
    goto wait_server
)
if exist "%SERVER_DIR%\Launch.bat" (
    start "Minecraft 1.20.1" /D "%SERVER_DIR%" "%SERVER_DIR%\Launch.bat"
    goto wait_server
)
if exist "%SERVER_DIR%\server.jar" (
    start "Minecraft 1.20.1" /D "%SERVER_DIR%" java -Xms2G -Xmx6G -jar server.jar nogui
    goto wait_server
)

echo NAPAKA: na vratih %SERVER_PORT% ni streznika in v "%SERVER_DIR%" ni run.bat, Launch.bat ali server.jar.
echo Namesti oziroma zazeni Minecraft Java 1.20.1 vanilla/Paper server in nato ponovi zagon.
echo Starega podedovanega Forge serverja ta projekt namenoma ne zaganja.
pause
exit /b 1

:wait_server
echo Cakam, da Minecraft 1.20.1 server odpre port %SERVER_PORT%...
powershell -NoProfile -Command "$d=(Get-Date).AddMinutes(5); do { $c=[Net.Sockets.TcpClient]::new(); try { $c.Connect('127.0.0.1',%SERVER_PORT%); exit 0 } catch {} finally { $c.Dispose() }; Start-Sleep -Seconds 2 } while ((Get-Date) -lt $d); exit 1"
if errorlevel 1 (
    echo NAPAKA: server po petih minutah se vedno ni dosegljiv.
    pause
    exit /b 1
)
timeout /t 5 /nobreak >nul

:verify_server
node tools\check-minecraft-server-version.js 127.0.0.1 %SERVER_PORT% %EXPECTED_VERSION%
if errorlevel 1 (
    echo Zagon NPC-jev je preklican, da se ne povezejo na napacno verzijo sveta.
    pause
    exit /b 1
)

echo Server 1.20.1 je dosegljiv. Zaganjam 10 RP NPC-jev...
node rp.js --settings settings.start_boti.json
pause
