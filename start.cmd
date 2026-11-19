@echo off
setlocal DisableDelayedExpansion
set "TBANK_UI_DIST=%~dp0dist"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command - < "%~dp0server.commands"
set "serverExit=%ERRORLEVEL%"
if not "%serverExit%"=="0" pause
exit /b %serverExit%
