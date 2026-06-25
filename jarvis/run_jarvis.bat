@echo off
REM Launch Jarvis on Windows. Double-click this file or run it from a terminal.
REM Pass --text to type instead of speak, e.g.  run_jarvis.bat --text

cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
    echo Python was not found on your PATH. Install Python 3.10+ first.
    pause
    exit /b 1
)

python jarvis.py %*
pause
