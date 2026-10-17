@echo off
rem ===================================================================
rem  Net Device Share - сборка установщика и установка на этот компьютер.
rem
rem  Что делает по порядку:
rem    1. Проверяет Node.js (нужен только для сборки) и, если его нет,
rem       ставит из installers\ - с проверкой SHA-256 по манифесту.
rem    2. Проверяет Inno Setup 6 и, если его нет, ставит через winget.
rem    3. Проверяет ключ подписи релизов (без него комплект не сможет
rem       обновляться по сети).
rem    4. Собирает установщик: dist\installer\net-device-share-setup-X.exe
rem    5. Запускает установку (Windows спросит права администратора).
rem
rem  Параметры:
rem      --no-install   собрать установщик, но не запускать его
rem      --silent       тихая установка без окон мастера: автозапуск, правила
rem                     брандмауэра и ярлык на рабочем столе, затем запуск
rem                     программы (Windows всё равно спросит права администратора)
rem  Переменная NDS_NOPAUSE=1 убирает паузу в конце (для автоматического запуска).
rem
rem  Установленной программе Node.js не нужен: node.exe едет в комплекте.
rem  Драйверы USB/IP приложение доустанавливает само при первом запуске.
rem
rem  Файл сохранён в CP866 с переводами строк CRLF - как и остальные
rem  пакетные файлы проекта (подробности - в начале scripts\start.bat).
rem  Проверяется командой npm run check.
rem ===================================================================

setlocal EnableDelayedExpansion
title Net Device Share - сборка и установка

set "ROOT=%~dp0"
cd /d "%ROOT%"

rem Текст файла - в CP866: на время работы переключаем консоль на 866.
set "ORIG_CP=866"
for /f "tokens=2 delims=:" %%c in ('chcp') do call :save_cp %%c
if not "%ORIG_CP%"=="866" chcp 866 >nul

set "NO_INSTALL="
set "SILENT="
for %%a in (%*) do (
  if /i "%%~a"=="--no-install" set "NO_INSTALL=1"
  if /i "%%~a"=="--silent" set "SILENT=1"
)

echo.
echo   Net Device Share - сборка и установка
echo.

rem ------------------------------------------------------------ 1. Node.js

echo   [1/4] Node.js
set "NODE_EXE="
where node >nul 2>&1
if not errorlevel 1 set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE goto :install_node

:node_found
set "NODE_VER="
for /f "delims=" %%v in ('call "%NODE_EXE%" -e "console.log(process.versions.node)" 2^>nul') do set "NODE_VER=%%v"
if not defined NODE_VER (
  echo         Node.js найден, но не запускается. Проверьте установку.
  goto :fail
)
for /f "tokens=1,2 delims=." %%a in ("%NODE_VER%") do (
  set "NODE_MAJOR=%%a"
  set "NODE_MINOR=%%b"
)
if !NODE_MAJOR! LSS 20 goto :old_node
if !NODE_MAJOR! EQU 20 if !NODE_MINOR! LSS 6 goto :old_node
echo         Node.js %NODE_VER% - подходит.
goto :step_inno

:old_node
echo         Установлен Node.js %NODE_VER%, а нужна версия 20.6 или новее.
echo         Обновите: https://nodejs.org/
goto :fail

:install_node
echo         Node.js не найден - ставлю из installers\ (понадобится подтверждение Windows).
set "NODE_MSI="
for /f "delims=" %%m in ('powershell -NoProfile -Command "$m=Get-Content -Raw -Encoding UTF8 'installers\manifest.json' | ConvertFrom-Json; $c=$m.components | Where-Object { $_.id -eq 'nodejs' }; $f=Join-Path (Get-Location) ('installers\'+($c.file -replace '/','\')); if ((Test-Path $f) -and ((Get-FileHash $f -Algorithm SHA256).Hash -eq $c.sha256)) { $f }" 2^>nul') do set "NODE_MSI=%%m"
if not defined NODE_MSI (
  echo         Нет установщика Node.js в installers\ или не сходится SHA-256.
  echo         Поставьте Node.js 20.6 или новее вручную: https://nodejs.org/
  goto :fail
)
set "NDS_MSI=%NODE_MSI%"
powershell -NoProfile -Command "try { $q=[char]34; $a='/i',($q+$env:NDS_MSI+$q),'/qn','/norestart'; $p=Start-Process -FilePath msiexec.exe -ArgumentList $a -Verb RunAs -Wait -PassThru -ErrorAction Stop; exit $p.ExitCode } catch { exit 1603 }"
rem 3010 - нужна перезагрузка: сам Node при этом установлен.
if errorlevel 1 if not errorlevel 3010 (
  echo         Установка Node.js не удалась или отменена.
  goto :fail
)
if not exist "%ProgramFiles%\nodejs\node.exe" (
  echo         Node.js установлен, но node.exe не найден в Program Files.
  goto :fail
)
set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
set "PATH=%PATH%;%ProgramFiles%\nodejs"
echo         Node.js установлен.
goto :node_found

rem -------------------------------------------------------- 2. Inno Setup 6

:step_inno
echo   [2/4] Inno Setup 6
call :find_iscc
if defined ISCC goto :inno_ok

where winget >nul 2>&1
if errorlevel 1 (
  echo         Inno Setup 6 не найден, а winget недоступен.
  echo         Скачайте и поставьте вручную: https://jrsoftware.org/isdl.php
  echo         Либо задайте путь к ISCC.exe в переменной ISCC_PATH.
  goto :fail
)
echo         Не найден - ставлю через winget (для текущего пользователя)...
winget install --id JRSoftware.InnoSetup -e --silent --scope user --accept-package-agreements --accept-source-agreements
call :find_iscc
if not defined ISCC (
  echo         Установка Inno Setup не удалась. Поставьте вручную: https://jrsoftware.org/isdl.php
  goto :fail
)

:inno_ok
echo         Inno Setup найден.

rem ------------------------------------------------------- 3. Ключ подписи

echo   [3/4] Ключ подписи релизов
set "KEYDIR=%USERPROFILE%\.net-device-share-signing"
set "KEY_OK="
if defined NDS_SIGNING_KEY if exist "%NDS_SIGNING_KEY%" set "KEY_OK=1"
if not defined KEY_OK if exist "%KEYDIR%\k1.pem" set "KEY_OK=1"
if not defined KEY_OK if exist "%KEYDIR%\local1.pem" (
  set "NDS_SIGNING_KEY_ID=local1"
  set "KEY_OK=1"
  echo         Используется локальный ключ local1.
)
if defined KEY_OK goto :key_ok

echo         Закрытого ключа подписи на этом компьютере нет.
echo         Без него установщик не соберётся: релиз должен быть подписан.
echo.
echo         [1] Создать локальный ключ ТОЛЬКО ДЛЯ ПРОВЕРОК на этом компьютере.
echo             Он добавится в launcher\lib\keys.js: узлы, собранные с другим
echo             ключом, не смогут обновлять друг друга.
echo         [2] Выйти. Скопируйте k1.pem в %KEYDIR% и запустите файл снова.
choice /c 12 /n /m "        Ваш выбор (1 или 2): "
if errorlevel 2 goto :fail_quiet
"%NODE_EXE%" scripts\release-keygen.mjs --id local1
if errorlevel 1 (
  echo         Создать ключ не удалось.
  goto :fail
)
set "NDS_SIGNING_KEY_ID=local1"

:key_ok

rem ------------------------------------------------------- 4. Сборка

echo   [4/4] Сборка установщика (первый раз качает node.exe для комплекта - нужен интернет)
echo.
"%NODE_EXE%" scripts\build-installer.mjs
if errorlevel 1 (
  echo.
  echo         Сборка не удалась. Причина - в сообщениях выше.
  goto :fail
)

rem ------------------------------------------------------- Установка

set "SETUP="
for /f "delims=" %%f in ('dir /b /o-d "dist\installer\net-device-share-setup-*.exe" 2^>nul') do (
  if not defined SETUP set "SETUP=%ROOT%dist\installer\%%f"
)
if not defined SETUP (
  echo         Установщик не найден в dist\installer.
  goto :fail
)

echo.
echo   Готов установщик: !SETUP!
if defined NO_INSTALL (
  echo   Установка пропущена: указан параметр --no-install.
  goto :done
)
if defined SILENT goto :silent_install
echo   Запускаю установку - подтвердите запрос Windows.
echo.
start "" /wait "!SETUP!"
echo   Установщик завершил работу.
goto :done

:silent_install
echo   Тихая установка: автозапуск, правила брандмауэра, ярлык на рабочем столе.
echo   Подтвердите запрос Windows. Журнал установки: %TEMP%\nds-setup.log
echo.
start "" /wait "!SETUP!" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TASKS="autostart,firewall,desktopicon" /LOG="%TEMP%\nds-setup.log"
if errorlevel 1 (
  echo   Установка не удалась, код !ERRORLEVEL!. Подробности: %TEMP%\nds-setup.log
  goto :fail
)
echo   Установлено.
rem Тихая установка сама программу не запускает - запускаем, как это делает ярлык
rem (если приложение работает, откроется его интерфейс, второй экземпляр не стартует).
set "OPEN_VBS=%ProgramFiles%\NetDeviceShare\launcher\open.vbs"
if exist "!OPEN_VBS!" (
  echo   Запускаю программу - подтвердите запрос Windows.
  start "" wscript.exe "!OPEN_VBS!"
) else (
  echo   Программа установлена не в стандартный каталог - запустите её ярлыком.
)

:done
echo.
if not defined NDS_NOPAUSE pause
chcp %ORIG_CP% >nul
exit /b 0

:fail
echo.
echo   Остановлено: см. сообщение выше.
:fail_quiet
echo.
if not defined NDS_NOPAUSE pause
chcp %ORIG_CP% >nul
exit /b 1

rem ------------------------------------------------------------- подпрограммы

:find_iscc
set "ISCC="
if defined ISCC_PATH if exist "%ISCC_PATH%" set "ISCC=%ISCC_PATH%"
if not defined ISCC if exist "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe" set "ISCC=%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"
if not defined ISCC if exist "%ProgramFiles%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles%\Inno Setup 6\ISCC.exe"
if not defined ISCC if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" set "ISCC=%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"
goto :eof

:save_cp
rem Номер страницы - последнее слово вывода chcp, без точки и пробелов.
set "ORIG_CP=%~1"
set "ORIG_CP=%ORIG_CP:.=%"
goto :eof
