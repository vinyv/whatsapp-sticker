@echo off
echo Stopping WppBot Local Worker...

:: Stop the run-worker.cmd loop (with its node child) and any worker still holding the port.
:: Only the worker is touched; other node.exe processes keep running.
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object CommandLine -match 'run-worker' | ForEach-Object { taskkill /F /T /PID $_.ProcessId | Out-Null }; Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"

echo.
echo Local worker has been stopped!
echo.
pause
