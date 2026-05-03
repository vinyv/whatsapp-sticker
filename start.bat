@echo off
echo Starting WhatsApp Sticker Bot.
cd /d %~dp0
pm2 start index.js
pm2 save
echo Bot started!
pause
