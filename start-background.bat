@echo off
echo Starting WhatsApp Sticker Bot in background with tray icon...
cd /d %~dp0
pm2 start index.js --name wppbot -- --tray
pm2 save
echo Bot started in background! Use 'pm2 logs wppbot' to view logs.
echo Look for the green circle icon in your system tray.
pause
