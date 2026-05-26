@echo off
cd /d C:\Teknisi\bot-teknisi
pm2 start index.js --name "bot-teknisi"
pm2 save