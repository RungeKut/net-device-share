@echo off
rem ===================================================================
rem  Net Device Share - публикация релиза на GitHub.
rem
rem  Что делает по порядку:
rem    1. Проверяет Node.js и GitHub CLI (gh); если gh нет - ставит через winget.
rem    2. Если gh не вошёл в аккаунт - запускает вход (откроется браузер).
rem    3. Запускает scripts\publish-release.mjs: проверки, тесты, сборка
rem       установщика, запрос подтверждения, отправка коммитов и публикация
rem       релиза с ОДНИМ файлом - установщиком net-device-share-setup-X.exe.
rem
rem  Параметры передаются скрипту как есть:
rem      --yes            не спрашивать подтверждение
rem      --dry-run        всё, кроме публикации
rem      --notes файл.md  свои заметки к релизу
rem      --draft          черновик
rem      --prerelease     предварительный релиз
rem      --skip-tests     не гонять тесты
rem      --skip-build     взять готовый установщик из dist\installer
rem
rem  Версия берётся из package.json, тег - v<версия>. Опубликованную
rem  версию повторно выложить нельзя: поднимите версию и закоммитьте.
rem
rem  Файл в CP866 с переводами строк CRLF - как и остальные пакетные файлы
rem  (подробности - в начале scripts\start.bat). Проверяется npm run check.
rem  Переменная NDS_NOPAUSE=1 убирает паузу в конце.
rem ===================================================================

setlocal EnableDelayedExpansion
title Net Device Share - публикация релиза

set "ROOT=%~dp0"
cd /d "%ROOT%"

set "ORIG_CP=866"
for /f "tokens=2 delims=:" %%c in ('chcp') do call :save_cp %%c
if not "%ORIG_CP%"=="866" chcp 866 >nul

echo.
echo   Net Device Share - публикация релиза
echo.

rem ------------------------------------------------------------ Node.js

set "NODE_EXE="
where node >nul 2>&1
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE (
  echo   Не найден Node.js. Запустите build^&install.bat - он поставит его,
  echo   либо установите вручную: https://nodejs.org/
  goto :fail
)

rem -------------------------------------------------------- GitHub CLI

call :find_gh
if defined GH_PATH goto :gh_ok

where winget >nul 2>&1
if errorlevel 1 (
  echo   Не найден GitHub CLI, а winget недоступен.
  echo   Установите вручную: https://cli.github.com/
  goto :fail
)
echo   GitHub CLI не найден - ставлю через winget (для текущего пользователя)...
winget install --id GitHub.cli -e --silent --scope user --accept-package-agreements --accept-source-agreements
call :find_gh
if not defined GH_PATH (
  echo   Установка GitHub CLI не удалась. Установите вручную: https://cli.github.com/
  goto :fail
)

:gh_ok
echo   GitHub CLI: !GH_PATH!

rem ------------------------------------------------ вход в аккаунт GitHub

"!GH_PATH!" auth status >nul 2>&1
if errorlevel 1 (
  echo.
  echo   GitHub CLI ещё не вошёл в ваш аккаунт.
  echo   Сейчас откроется вход: скопируйте одноразовый код, подтвердите его
  echo   в браузере. Пароли здесь не вводятся.
  echo.
  "!GH_PATH!" auth login --hostname github.com --git-protocol https --web
  if errorlevel 1 (
    echo.
    echo   Вход не выполнен.
    goto :fail
  )
)

rem ----------------------------------------------------------- публикация

echo.
"%NODE_EXE%" scripts\publish-release.mjs %*
if errorlevel 1 goto :fail

:done
echo.
if not defined NDS_NOPAUSE pause
chcp %ORIG_CP% >nul
exit /b 0

:fail
echo.
echo   Остановлено: см. сообщение выше.
echo.
if not defined NDS_NOPAUSE pause
chcp %ORIG_CP% >nul
exit /b 1

rem ------------------------------------------------------------- подпрограммы

:find_gh
set "GH_PATH="
where gh >nul 2>&1
if not errorlevel 1 (
  for /f "delims=" %%g in ('where gh') do if not defined GH_PATH set "GH_PATH=%%g"
)
if not defined GH_PATH if exist "%LOCALAPPDATA%\Programs\GitHub CLI\gh.exe" set "GH_PATH=%LOCALAPPDATA%\Programs\GitHub CLI\gh.exe"
if not defined GH_PATH if exist "%ProgramFiles%\GitHub CLI\gh.exe" set "GH_PATH=%ProgramFiles%\GitHub CLI\gh.exe"
rem winget (для пользователя) кладёт gh в каталог пакетов и ссылку в Links; PATH в этом окне ещё не обновлён.
if not defined GH_PATH if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\gh.exe" set "GH_PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links\gh.exe"
if not defined GH_PATH for /d %%d in ("%LOCALAPPDATA%\Microsoft\WinGet\Packages\GitHub.cli_*") do if exist "%%d\bin\gh.exe" set "GH_PATH=%%d\bin\gh.exe"
goto :eof

:save_cp
rem Номер страницы - последнее слово вывода chcp, без точки и пробелов.
set "ORIG_CP=%~1"
set "ORIG_CP=%ORIG_CP:.=%"
goto :eof
