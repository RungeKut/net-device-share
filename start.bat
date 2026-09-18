@echo off
rem ===================================================================
rem  Net Device Share - штатный запуск.
rem
rem  Запускается двойным кликом. Любые параметры приложения можно
rem  передать и сюда, например:
rem      start.bat --name "БУХГАЛТЕРИЯ-1" --network 192.168.1.0/24
rem      start.bat --backend mock
rem      start.bat --doctor
rem
rem  Собственный параметр этого файла:
rem      -noadmin    не запрашивать повышение прав
rem
rem  О КОДИРОВКАХ (две разные проблемы, не путать):
rem
rem  1. Сам файл сохранён в CP866 - кодировке консоли Windows. Команда
rem     "chcp 65001" в начале файла здесь НЕ годится: cmd читает пакетный
rem     файл по байтовым смещениям, и смена кодировки по ходу выполнения
rem     разъезжается на строках с кириллицей.
rem
rem  2. Node печатает в UTF-8. Поэтому кодовая страница переключается
rem     ровно на время работы приложения и возвращается обратно. Между
rem     переключениями нет ни одной строки с кириллицей - только ASCII,
rem     байты которого одинаковы в обеих кодировках, поэтому разбор
rem     файла не ломается.
rem ===================================================================

setlocal EnableDelayedExpansion
title Net Device Share

rem Работаем из каталога проекта, а не из того, откуда файл вызвали:
rem при запуске от администратора рабочим каталогом становится system32.
cd /d "%~dp0"

set "APP_ARGS=%*"
set "SKIP_ADMIN="

rem -noadmin - наш собственный ключ, приложению его передавать не нужно.
if not "%APP_ARGS%"=="" (
  set "APP_ARGS=!APP_ARGS:-noadmin=!"
  if not "!APP_ARGS!"=="%*" set "SKIP_ADMIN=1"
)

rem ------------------------------------------------------------ Node.js

where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo   Не найден Node.js.
  echo.
  echo   Установите версию 20.6 или новее: https://nodejs.org/
  echo   После установки закройте это окно и запустите файл заново.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -e "console.log(process.versions.node)" 2^>nul') do set "NODE_VER=%%v"
if not defined NODE_VER (
  echo.
  echo   Node.js найден, но не запускается. Проверьте установку.
  echo.
  pause
  exit /b 1
)

for /f "tokens=1,2 delims=." %%a in ("%NODE_VER%") do (
  set "NODE_MAJOR=%%a"
  set "NODE_MINOR=%%b"
)
if !NODE_MAJOR! LSS 20 goto :old_node
if !NODE_MAJOR! EQU 20 if !NODE_MINOR! LSS 6 goto :old_node
goto :node_ok

:old_node
echo.
echo   Установлен Node.js %NODE_VER%, а нужна версия 20.6 или новее.
echo   Обновите: https://nodejs.org/
echo.
pause
exit /b 1

:node_ok

rem -------------------------------------------------------------- права

rem fltmc выполняется только с повышенными правами - этим и проверяем.
fltmc >nul 2>&1
if not errorlevel 1 goto :run
if defined SKIP_ADMIN goto :run_limited

rem NDS_ELEVATED страхует от бесконечного круга перезапусков,
rem если повышение прав в этой системе невозможно в принципе.
if defined NDS_ELEVATED goto :run_limited

echo.
echo   Для публикации USB-устройств нужны права администратора.
echo   Запрашиваю повышение - подтвердите запрос Windows.
echo.

rem Путь и параметры передаются через переменные окружения: так в команде
rem PowerShell не остаётся кавычек, которые ломались бы на путях с пробелами.
set "NDS_SELF=%~f0"
set "NDS_SELF_ARGS=%APP_ARGS%"
set "NDS_ELEVATED=1"
powershell -NoProfile -Command "try { if ($env:NDS_SELF_ARGS) { Start-Process -FilePath $env:NDS_SELF -ArgumentList $env:NDS_SELF_ARGS -Verb RunAs -ErrorAction Stop } else { Start-Process -FilePath $env:NDS_SELF -Verb RunAs -ErrorAction Stop }; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo   Повышение прав отклонено - продолжаю с обычными правами.
  goto :run_limited
)
exit /b 0

:run_limited
echo.
echo   ВНИМАНИЕ: приложение работает без прав администратора.
echo   Просмотр каталога и настройки доступны, но публикация
echo   собственных устройств будет завершаться ошибкой.
echo.

:run
echo.
echo   Net Device Share - запуск
echo   Имя узла, сеть и адрес интерфейса показаны ниже.
echo   Остановка - Ctrl+C или закрытие этого окна.
echo.

rem --- дальше и до восстановления кодовой страницы только ASCII ---
set "OLD_CP=866"
for /f "tokens=2 delims=:" %%c in ('chcp') do call :trim_cp %%c
chcp 65001 >nul

node "%~dp0src\main.js" %APP_ARGS%
set "EXIT_CODE=%ERRORLEVEL%"

chcp %OLD_CP% >nul
rem --- ASCII-участок закончен ---

echo.
if not "%EXIT_CODE%"=="0" (
  echo   Приложение завершилось с ошибкой, код %EXIT_CODE%.
  echo   Подробности выше. Диагностика окружения: start.bat --doctor
) else (
  echo   Приложение остановлено.
)
echo.
pause
exit /b %EXIT_CODE%

:trim_cp
rem Аргумент приходит уже без окружающих пробелов - cmd их съедает сам.
set "OLD_CP=%~1"
goto :eof
