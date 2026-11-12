@echo off
chcp 65001 >nul
cd /d "%~dp0.."
set "LOG=tools\sync.log"
set "GIT_TERMINAL_PROMPT=0"

rem ---- locate git: PATH -> WorkBuddy portable git -> Program Files ----
set "GIT="
for %%G in (git.exe) do if not defined GIT if not "%%~$PATH:G"=="" set "GIT=%%~$PATH:G"
if not defined GIT for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\PortableGit\versions\*") do if exist "%%D\mingw64\bin\git.exe" set "GIT=%%D\mingw64\bin\git.exe"
if not defined GIT if exist "C:\Program Files\Git\cmd\git.exe" set "GIT=C:\Program Files\Git\cmd\git.exe"
if not defined GIT if exist "C:\Program Files (x86)\Git\cmd\git.exe" set "GIT=C:\Program Files (x86)\Git\cmd\git.exe"

echo.>> "%LOG%"
echo [%date% %time%] === start ===>> "%LOG%"

node tools\sync-filmdata.mjs>> "%LOG%" 2>&1
if errorlevel 1 goto fail

if not defined GIT (
  echo [%date% %time%] git not found, sync only>> "%LOG%"
  exit /b 0
)

"%GIT%" diff --quiet -- js/filmdata.js
set "RC=%errorlevel%"
if "%RC%"=="1" goto haschanges
if not "%RC%"=="0" goto fail
echo [%date% %time%] no data changes>> "%LOG%"
goto maybepush

:haschanges
"%GIT%" add js/filmdata.js imgs/cover>> "%LOG%" 2>&1
"%GIT%" commit -m "chore: auto sync film data">> "%LOG%" 2>&1
if errorlevel 1 goto fail
echo [%date% %time%] committed>> "%LOG%"

:maybepush
rem 只要有未推送的提交就补推（上次推送失败时，第二天也能自动补上）
"%GIT%" rev-list --count HEAD --not --remotes > "%TEMP%\dbf_ahead.txt" 2>> "%LOG%"
set "AHEAD="
set /p AHEAD=<"%TEMP%\dbf_ahead.txt"
if not defined AHEAD goto pushfail
if "%AHEAD%"=="0" (
  echo [%date% %time%] nothing to push>> "%LOG%"
  exit /b 0
)
"%GIT%" push>> "%LOG%" 2>&1
if errorlevel 1 goto pushfail
echo [%date% %time%] pushed %AHEAD% commit(s)>> "%LOG%"
exit /b 0

:fail
echo [%date% %time%] failed>> "%LOG%"
exit /b 1

:pushfail
echo [%date% %time%] push failed - will retry next run>> "%LOG%"
exit /b 1
