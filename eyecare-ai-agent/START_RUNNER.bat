@echo off
cd /d "%~dp0"
echo Pokrecem EyeCare Runner (agent)
echo Ostavi ovaj prozor otvoren - strain i vrijeme ce se slati na dashboard.
echo.
node agent/SimulationRunner.js
pause
