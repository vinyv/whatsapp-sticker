@echo off
echo Restarting WppBot Local Worker...

:: Stop the run-worker.cmd loop (with its node child) and any worker still holding the port.
:: Only the worker is touched; other node.exe processes keep running.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object CommandLine -match 'run-worker' | ForEach-Object { taskkill /F /T /PID $_.ProcessId | Out-Null }; Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"

:: Wait a brief moment
ping -n 3 127.0.0.1 >nul

:: Start it again using the startup VBScript
set STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set VBS_FILE=%STARTUP_DIR%\WppBotWorker.vbs

if exist "%VBS_FILE%" (
    echo Starting worker in background...
    wscript "%VBS_FILE%"
    echo.
    echo Worker has been restarted!
) else (
    echo Error: Startup script not found. Please run install-startup.bat first.
)

echo.
pause
