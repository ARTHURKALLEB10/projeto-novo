@echo off
title ABA Edu - Servidor WhatsApp
color 0A
cls
echo.
echo  ============================================
echo   ABA Edu - Servidor iniciando...
echo  ============================================
echo.
echo  O QR Code vai abrir automaticamente!
echo  Escaneie com o WhatsApp do celular.
echo.
echo  Nao feche esta janela.
echo  ============================================
echo.
cd /d "%~dp0"
start "" "http://localhost:3000"
node server.js
pause
