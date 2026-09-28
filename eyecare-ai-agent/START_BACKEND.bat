@echo off
cd /d "%~dp0backend"
echo Pokrecem backend + agent (runner) - sve u jednom.
echo Kad se sve ucita, otvori u browseru: http://localhost:4000/
echo.
node server.js
pause
