@echo off
echo Iniciando Ferragem Marlene Bot...
cd /d "%~dp0"
if not exist node_modules (
    echo Instalando dependencias...
    npm install
)
echo Inciando servidor...
node index.js
pause
