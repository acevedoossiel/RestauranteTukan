@echo off
title Servidor El Tukan POS
color 0A
cls

echo =========================================================
echo       INICIANDO SISTEMA COMERCIAL EL TUKAN
echo =========================================================
echo.

:: 1. Levantamos el servidor de Node.js en segundo plano de fondo
echo [*] Encendiendo el backend y actualizando IP local...
start /b node server.js

:: 2. Esperamos 3 segundos a que el servidor cree el config.js y monte la base de datos
timeout /t 3 /nobreak > null

:: 3. Abrimos las pantallas obligatorias del negocio en ventanas limpias independientes (--app)
echo [*] Desplegando monitores de produccion en hardware...

:: Panel de Administración
start chrome --app=http://localhost:3000/admin_panel.html

:: Monitor de Barra (En su ventana dedicada para que no se congele el timer)
start chrome --app=http://localhost:3000/barra.html

:: Monitor de Cocina
start chrome --app=http://localhost:3000/cocina.html

echo.
echo [OK] Todo el sistema se encuentra activo y listo para operar.
echo.
pause