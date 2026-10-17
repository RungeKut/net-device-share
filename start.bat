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
rem Текст этого файла - в CP866. Если консоль сейчас в другой кодовой
rem странице (437, 1251, 65001...), кириллица превращается в мусор:
rem запоминаем текущую и на время работы переключаем на 866.
rem Начальная кодовая страница запоминается и восстанавливается при выходе.
set "ORIG_CP=866"
for /f "tokens=2 delims=:" %%c in ('chcp') do call :save_cp %%c
if not "%ORIG_CP%"=="866" chcp 866 >nul


set "APP_ARGS=%*"
set "SKIP_ADMIN="

rem -noadmin - наш собственный ключ, приложению его передавать не нужно.
if not "%APP_ARGS%"=="" (
  set "APP_ARGS=!APP_ARGS:-noadmin=!"
  if not "!APP_ARGS!"=="%*" set "SKIP_ADMIN=1"
)

rem ------------------------------------------------------------ Node.js

rem В переносимом комплекте node.exe лежит рядом с этим файлом, и тогда
rem ставить Node в систему не нужно вовсе. Вложенный имеет приоритет:
rem комплект должен работать одинаково независимо от того, что установлено
rem на машине.
set "NODE_EXE=node"
if exist "%~dp0node.exe" set "NODE_EXE=%~dp0node.exe"

if "%NODE_EXE%"=="node" (
  if exist "%ProgramFiles%\nodejs\node.exe" (
    set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
  ) else (
    where node >nul 2>&1
    if errorlevel 1 goto :install_node
  )
)

:node_found

rem "call" здесь обязателен: если команда в for /f начинается с
rem кавычки, cmd принимает её за имя программы целиком и поиск файла
rem проваливается. С "call" строка начинается с буквы, и путь с
rem пробелами внутри кавычек разбирается правильно.
for /f "delims=" %%v in ('call "%NODE_EXE%" -e "console.log(process.versions.node)" 2^>nul') do set "NODE_VER=%%v"
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
chcp %ORIG_CP% >nul
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

rem Если рядом лежит лаунчер - запуск идёт через него: он выберет версию,
rem проверит её целостность и откатит неудачное обновление. Без лаунчера
rem (запуск из исходников) приложение стартует напрямую, как раньше.
set "ENTRY=%~dp0src\main.js"
if exist "%~dp0launcher\supervisor.mjs" set "ENTRY=%~dp0launcher\supervisor.mjs"

rem --- дальше и до восстановления кодовой страницы только ASCII ---
set "OLD_CP=866"
for /f "tokens=2 delims=:" %%c in ('chcp') do call :trim_cp %%c
chcp 65001 >nul

"%NODE_EXE%" "%ENTRY%" %APP_ARGS%
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
chcp %ORIG_CP% >nul
exit /b %EXIT_CODE%

:trim_cp
rem Аргумент приходит уже без окружающих пробелов - cmd их съедает сам.
set "OLD_CP=%~1"
goto :eof

:install_node
rem Node.js не найден - ставим его из installers\ (MSI, проверка SHA-256
rem по manifest.json). Установка требует прав администратора.
set "NODE_MSI="
for /f "delims=" %%m in ('powershell -NoProfile -Command "$m=Get-Content -Raw -Encoding UTF8 'installers\manifest.json' | ConvertFrom-Json; $c=$m.components | Where-Object { $_.id -eq 'nodejs' }; $f=Join-Path (Get-Location) ('installers\'+($c.file -replace '/','\')); if ((Test-Path $f) -and ((Get-FileHash $f -Algorithm SHA256).Hash -eq $c.sha256)) { $f }" 2^>nul') do set "NODE_MSI=%%m"
if not defined NODE_MSI goto :no_node

fltmc >nul 2>&1
if not errorlevel 1 goto :do_install_node
if defined SKIP_ADMIN goto :no_node
if defined NDS_ELEVATED goto :no_node

echo.
echo   Node.js не найден. Для его установки нужны права администратора.
echo   Подтвердите запрос Windows.
echo.
set "NDS_SELF=%~f0"
set "NDS_SELF_ARGS=%APP_ARGS%"
set "NDS_ELEVATED=1"
powershell -NoProfile -Command "try { if ($env:NDS_SELF_ARGS) { Start-Process -FilePath $env:NDS_SELF -ArgumentList $env:NDS_SELF_ARGS -Verb RunAs -ErrorAction Stop } else { Start-Process -FilePath $env:NDS_SELF -Verb RunAs -ErrorAction Stop }; exit 0 } catch { exit 1 }"
if errorlevel 1 goto :no_node
chcp %ORIG_CP% >nul
exit /b 0

:do_install_node
echo.
echo   Устанавливаю Node.js (тихо, это займёт около минуты)...
msiexec /i "%NODE_MSI%" /qn /norestart
rem Код 3010 - <нужна перезагрузка>: сам Node при этом установлен.
if errorlevel 1 if not errorlevel 3010 goto :no_node
if exist "%ProgramFiles%\nodejs\node.exe" (
  set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
  echo   Node.js установлен.
  goto :node_found
)
goto :no_node

:no_node
echo.
echo   Не найден Node.js.
echo.
echo   Установите версию 20.6 или новее: https://nodejs.org/
echo   После установки запустите этот файл заново.
echo.
echo   Либо возьмите переносимый комплект - в нём node.exe уже лежит рядом.
echo.
pause
exit /b 1

:save_cp
rem Номер страницы - последнее слово вывода chcp, без точки и пробелов.
set "ORIG_CP=%~1"
set "ORIG_CP=%ORIG_CP:.=%"
goto :eof
