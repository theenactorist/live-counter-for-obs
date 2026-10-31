@echo off
rem Double-click to install Live Counter for OBS (T4). %~dp0 is this file's own
rem folder, so install.ps1 finds the Live Counter files beside it and downloads
rem nothing. -ExecutionPolicy Bypass lets it run without admin rights.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\windows\install.ps1"
pause
