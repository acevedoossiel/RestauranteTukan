@echo off

:: 1. Auto-elevar permisos a Administrador
net session >nul 2>&1
if %errorLevel% neq 0 (
    powershell -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

cd /d "%~dp0"

title Servidor El Tukan
color 0A
cls

echo =========================================================
echo       INICIALIZANDO SISTEMA TUKAN
echo =========================================================
echo.

:: 2. Reiniciar el servicio de impresion para despertar puertos USB
echo [*] Reiniciando servicio de impresion (Spooler)...
net stop spooler > nul 2>&1
net start spooler > nul 2>&1

:: 3. Levantamos el servidor de Node.js en segundo plano de fondo
echo [*] Encendiendo el backend y actualizando IP local...
start /b node server.js

:: 4. Esperamos 8 segundos a que el sistema y servicios se estabilicen
echo [*] Esperando inicio de servicios...
timeout /t 8 /nobreak > nul


echo.
echo [OK] Todo el sistema se encuentra listo
echo.
pause