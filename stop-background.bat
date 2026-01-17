@echo off
echo Stopping WhatsApp Sticker Bot...
pm2 stop wppbot
pm2 delete wppbot
echo Bot stopped!
pause
