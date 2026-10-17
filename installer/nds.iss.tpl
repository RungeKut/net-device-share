; Установщик Net Device Share для Windows (Inno Setup 6).
;
; Это ШАБЛОН: scripts/build-installer.mjs подставляет версию и пути вместо
; @@МЕТОК@@ и пишет готовый .iss в dist/installer/. Руками его не собирают.
;
; Что делает установщик:
;   - кладёт приложение в Program Files (запись только у администраторов:
;     код запускается с повышенными правами, и писать в него обычному
;     пользователю нельзя);
;   - данные (настройки, ключи, состояние обновления) — в ProgramData, с правами
;     только у SYSTEM и администраторов;
;   - по желанию — правила брандмауэра и автозапуск;
;   - кладёт копию самого установщика в <каталог>\download: узел раздаёт его
;     соседям по http://<адрес>:47812/download;
;   - драйверы USB/IP приложение доустановит само при первом запуске из
;     installers\ (с проверкой суммы и подписи).
;
; Тихая установка:  net-device-share-setup-X.exe /VERYSILENT /SUPPRESSMSGBOXES /TASKS="autostart,firewall"

#define AppName "Net Device Share"
#define AppVersion "@@VERSION@@"
#define DataDir "{commonappdata}\NetDeviceShare"

[Setup]
AppId={{3F2A9E1C-7B54-4C6D-8A12-5D9E0B7C4F31}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=Net Device Share
DefaultDirName={autopf}\NetDeviceShare
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=@@OUTDIR@@
OutputBaseFilename=net-device-share-setup-@@VERSION@@
Compression=lzma2/ultra
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\node.exe
UninstallDisplayName={#AppName}
SetupLogging=yes
CloseApplications=no
RestartApplications=no

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Tasks]
Name: "autostart"; Description: "Запускать при входе в систему (без окна)"; GroupDescription: "Автозапуск:"
Name: "firewall"; Description: "Открыть порты в брандмауэре Windows (для частных и доменных сетей)"; GroupDescription: "Сеть:"
Name: "desktopicon"; Description: "Ярлык на рабочем столе"; GroupDescription: "Ярлыки:"; Flags: unchecked

[Dirs]
Name: "{#DataDir}"
Name: "{app}\download"

[Files]
; Комплект целиком: node.exe, launcher\, installers\, app\<версия>\ и releases\<версия>\.
Source: "@@SOURCE@@\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
; Копия этого установщика — для раздачи соседям.
Source: "{srcexe}"; DestDir: "{app}\download"; DestName: "net-device-share-setup-@@VERSION@@.exe"; Flags: external ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\start.bat"; WorkingDir: "{app}"; IconFilename: "{app}\node.exe"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\start.bat"; WorkingDir: "{app}"; IconFilename: "{app}\node.exe"; Tasks: desktopicon

[Run]
; Данные доступны только SYSTEM и администраторам: там ключи сети и пароль интерфейса.
Filename: "{sys}\icacls.exe"; Parameters: """{#DataDir}"" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F"; Flags: runhidden; StatusMsg: "Настройка прав на каталог данных..."
; Версия новее текущей (установка поверх) станет текущей пробным запуском — с откатом.
Filename: "{app}\node.exe"; Parameters: """{app}\launcher\supervisor.mjs"" --adopt"; Flags: runhidden; StatusMsg: "Проверка версии..."
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Net Device Share (UDP)"" dir=in action=allow program=""{app}\node.exe"" protocol=UDP localport=47811 profile=domain,private"; Flags: runhidden; Tasks: firewall; StatusMsg: "Правила брандмауэра..."
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""Net Device Share (TCP)"" dir=in action=allow program=""{app}\node.exe"" protocol=TCP localport=47812-47814 profile=domain,private"; Flags: runhidden; Tasks: firewall
Filename: "{app}\node.exe"; Parameters: """{app}\app\@@VERSION@@\src\main.js"" --autostart enable"; Flags: runhidden; Tasks: autostart; StatusMsg: "Автозапуск..."
Filename: "{app}\start.bat"; Description: "Запустить {#AppName}"; Flags: postinstall nowait skipifsilent shellexec

[UninstallRun]
Filename: "{app}\node.exe"; Parameters: """{app}\launcher\supervisor.mjs"" --stop"; Flags: runhidden; RunOnceId: "NdsStop"
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /TN NetDeviceShare /F"; Flags: runhidden; RunOnceId: "NdsTask"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Net Device Share (UDP)"""; Flags: runhidden; RunOnceId: "NdsFwUdp"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Net Device Share (TCP)"""; Flags: runhidden; RunOnceId: "NdsFwTcp"

[UninstallDelete]
; Каталоги, созданные уже после установки (версии, архивы, раздача).
Type: filesandordirs; Name: "{app}\app"
Type: filesandordirs; Name: "{app}\releases"
Type: filesandordirs; Name: "{app}\download"
Type: files; Name: "{app}\installed.json"

[Code]
procedure StopRunning();
var
  Code: Integer;
begin
  // Работающий узел просим остановиться через лаунчер: на Windows мягкого
  // сигнала завершения нет, поэтому флаг-файлом (см. launcher\supervisor.mjs).
  if FileExists(ExpandConstant('{app}\launcher\supervisor.mjs')) and FileExists(ExpandConstant('{app}\node.exe')) then
  begin
    Exec(ExpandConstant('{app}\node.exe'), ExpandConstant('"{app}\launcher\supervisor.mjs" --stop'), '', SW_HIDE, ewWaitUntilTerminated, Code);
    Sleep(6000);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunning();
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Home: String;
begin
  if CurStep = ssPostInstall then
  begin
    // Признак «поставлено установщиком» и каталог данных для лаунчера.
    Home := ExpandConstant('{#DataDir}');
    StringChangeEx(Home, '\', '\\', True);
    SaveStringToFile(ExpandConstant('{app}\installed.json'),
      '{"kind":"installer","home":"' + Home + '"}', False);
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usPostUninstall) and (not UninstallSilent) then
  begin
    if MsgBox('Удалить также настройки, ключи сети и журналы?' + #13#10 +
              'Если собираетесь поставить приложение снова, лучше оставить: узел сохранит своё имя и ключи.',
              mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      DelTree(ExpandConstant('{#DataDir}'), True, True, True);
  end;
end;
