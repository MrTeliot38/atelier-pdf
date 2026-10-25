@echo off
REM Lance Atelier PDF sur cet ordinateur (necessite Python)
cd /d "%~dp0"
start "" http://localhost:8080/
python -m http.server 8080
