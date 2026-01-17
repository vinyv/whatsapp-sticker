@echo off
echo Starting WhatsApp Sticker Bot...
cd /d %~dp0
pm2 start index.js --name wppbot
pm2 save
echo Bot started in background! Use 'pm2 logs wppbot' to view logs.
pause
