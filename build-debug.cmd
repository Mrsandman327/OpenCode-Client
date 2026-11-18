@echo off
rem Run the PowerShell build script from cmd.exe.
rem cmd cannot execute .ps1 directly; typing .\build-debug.ps1 opens it via file association.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-debug.ps1" %*
exit /b %ERRORLEVEL%
