@echo off
:: Keeps the worker running: restarts it a few seconds after it exits or crashes.
:: Output goes to worker.log; the previous run's log (with the crash reason) is kept as worker.prev.log.
cd /d "%~dp0"
:loop
if exist worker.log move /y worker.log worker.prev.log >nul
echo [%date% %time%] Starting worker > worker.log
node index.js >> worker.log 2>&1
echo [%date% %time%] Worker exited with code %errorlevel%, restarting in 5s >> worker.log
ping -n 6 127.0.0.1 >nul
goto loop
