@echo off
echo Installing WppBot Local Worker to run at startup...

set STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
set VBS_FILE=%STARTUP_DIR%\WppBotWorker.vbs
set WORKER_DIR=%~dp0

:: Create a VBScript that runs the worker invisibly (no command prompt window).
:: run-worker.cmd restarts it if it crashes and logs to worker.log
echo Set WshShell = CreateObject("WScript.Shell") > "%VBS_FILE%"
echo WshShell.CurrentDirectory = "%WORKER_DIR%" >> "%VBS_FILE%"
echo WshShell.Run "cmd.exe /c ""%WORKER_DIR%run-worker.cmd""", 0, False >> "%VBS_FILE%"

echo.
echo Done! The local worker will now start invisibly in the background every time you log in.
echo.
echo To start it right now without restarting your PC, double-click:
echo "%VBS_FILE%"
echo.
pause
