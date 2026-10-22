@echo off
title Servidor El Tukan POS
color 6
cls

:: Nos posicionamos en la carpeta exacta del proyecto
cd /d "%~dp0"

echo =========================================================
echo       INICIANDO SISTEMA EL TUKAN
echo =========================================================
echo.

:: 1. Levantamos Node.js en segundo plano dentro de esta misma sesion
start /b node server.js

:: 2. Breve pausa para asegurar el montaje del servidor local
timeout /t 3 /nobreak > nul

:: 3. Abrimos directamente la interfaz de mesero
start chrome --new-window http://localhost:3000/index.html http://localhost:3000/admin_panel.html
