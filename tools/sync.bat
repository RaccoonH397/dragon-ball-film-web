@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo Syncing filmdata.js from Bilibili / YouTube ...
node tools\sync-filmdata.mjs %*
pause
