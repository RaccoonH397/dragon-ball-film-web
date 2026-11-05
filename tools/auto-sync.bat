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
if "%RC%"=="0" goto nochanges
if not "%RC%"=="1" goto fail

"%GIT%" add js/filmdata.js imgs/cover>> "%LOG%" 2>&1
"%GIT%" commit -m "chore: auto sync film data">> "%LOG%" 2>&1
"%GIT%" push>> "%LOG%" 2>&1
if errorlevel 1 goto pushfail
echo [%date% %time%] committed and pushed>> "%LOG%"
exit /b 0

:nochanges
echo [%date% %time%] no changes>> "%LOG%"
exit /b 0

:fail
echo [%date% %time%] failed>> "%LOG%"
exit /b 1

:pushfail
echo [%date% %time%] push failed (check git credentials)>> "%LOG%"
exit /b 1
