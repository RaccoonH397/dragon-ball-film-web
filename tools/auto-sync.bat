@echo off
chcp 65001 >nul
cd /d "%~dp0.."
set LOG=tools\sync.log
echo. >> "%LOG%"
echo [%date% %time%] ===== 开始同步 ===== >> "%LOG%"

node tools\sync-filmdata.mjs >> "%LOG%" 2>&1
if errorlevel 1 (
    echo [%date% %time%] 同步失败，本次不做提交 >> "%LOG%"
    exit /b 1
)

git diff --quiet -- js\filmdata.js
if errorlevel 1 (
    git add js/filmdata.js imgs/cover
    git commit -m "chore: auto sync film data" >> "%LOG%" 2>&1
    git push >> "%LOG%" 2>&1
    if errorlevel 1 (
        echo [%date% %time%] 推送失败（检查 GitHub 凭据） >> "%LOG%"
        exit /b 1
    )
    echo [%date% %time%] 已提交并推送 >> "%LOG%"
) else (
    echo [%date% %time%] 无变化，跳过提交 >> "%LOG%"
)
exit /b 0
