@echo off
rem ===================================================================
rem  Net Device Share - запуск при входе в систему.
rem
rem  Этот файл запускает планировщик заданий; вручную его трогать не нужно.
rem  Галочка "Запускать при входе в систему" в настройках приложения
rem  создаёт и удаляет задание, которое вызывает именно его.
rem
rem  Отличия от start.bat:
rem    - не запрашивает повышение прав: задание уже выполняется с ними;
rem    - не открывает браузер: при каждом входе в систему это лишнее;
rem    - не делает pause: некому нажимать клавишу.
rem
rem  Кодировка CP866 и переводы строк CRLF - как и у start.bat, иначе cmd
rem  разъедется на кириллице и на goto. Проверяется командой npm run check.
rem ===================================================================

setlocal
title Net Device Share

rem База установки: рядом с этим файлом (комплект и установленная версия)
rem либо на уровень выше (запуск из каталога scripts исходников).
set "BASE=%~dp0"
if not exist "%BASE%launcher\supervisor.mjs" if not exist "%BASE%src\main.js" set "BASE=%~dp0..\"
cd /d "%BASE%"

rem В переносимом комплекте node.exe лежит рядом с приложением, и он имеет
rem приоритет: комплект должен работать одинаково независимо от того, что
rem установлено на машине.
set "NODE_EXE=node"
if exist "%BASE%node.exe" set "NODE_EXE=%BASE%node.exe"

if "%NODE_EXE%"=="node" (
  where node >nul 2>&1
  if errorlevel 1 (
    echo Не найден Node.js - автозапуск невозможен.
    exit /b 1
  )
)

rem NDS_HOME for the service (SYSTEM has its own profile): autostart.home is written
rem next to this file when autostart is enabled from a non-installed copy.
if not defined NDS_HOME if exist "%BASE%autostart.home" set /p NDS_HOME=<"%BASE%autostart.home"

set "ENTRY=%BASE%src\main.js"
if exist "%BASE%launcher\supervisor.mjs" set "ENTRY=%BASE%launcher\supervisor.mjs"
"%NODE_EXE%" "%ENTRY%" --no-open %*
exit /b %ERRORLEVEL%
