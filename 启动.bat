@echo off
setlocal
set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
if not exist "%APP_DIR%\node_modules\electron\dist\electron.exe" (
  echo Electron not found. Run "npm install" in this folder first.
  pause
  exit /b 1
)
start "" "%APP_DIR%\node_modules\electron\dist\electron.exe" "%APP_DIR%"
endlocal
