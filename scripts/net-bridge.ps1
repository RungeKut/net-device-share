#Requires -Version 5.1
<#
  Управление MAC-мостом Windows без участия человека.

  Мост нельзя создать ни через netsh, ни через INetCfg: в netbrdg.inf он
  объявлен как NDIS-фильтр (Characteristics=0x40000), а не как устройство.
  Зато папка «Сетевые подключения» — обычная папка оболочки, и её команды
  вызываются через IContextMenu. Команды ищем по внутренним именам
  (addtobridge, removefrombridge, delete), поэтому язык Windows не важен.

  Действия:
    state    — что сейчас с мостом (только чтение)
    verbs    — какие команды доступны для указанных адаптеров (только чтение)
    bridge   — связать указанные адаптеры мостом
    unbridge — вывести адаптеры из моста (мост исчезнет сам)

  -Json — для приложения: последней строкой идёт «NDS-RESULT {…}» с итогом.
  Остальной вывод остаётся для человека и приложением не разбирается.

  Приложение вызывает сценарий через -Command, а не -File: при -File
  PowerShell не разбирает список через запятую, и «-Adapter a,b» приходит
  одной строкой «a,b».
#>
param(
  [ValidateSet('state', 'verbs', 'bridge', 'unbridge')]
  [string]$Action = 'verbs',
  [string[]]$Adapter = @(),
  [switch]$Elevated,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace NdsBridge {
  [ComImport, Guid("000214F2-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IEnumIDList {
    [PreserveSig] int Next(uint celt, out IntPtr rgelt, out uint fetched);
    [PreserveSig] int Skip(uint celt);
    [PreserveSig] int Reset();
    [PreserveSig] int Clone(out IEnumIDList e);
  }

  [ComImport, Guid("000214E6-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellFolder {
    [PreserveSig] int ParseDisplayName(IntPtr hwnd, IntPtr pbc,
      [MarshalAs(UnmanagedType.LPWStr)] string name, ref uint eaten, out IntPtr pidl, ref uint attrs);
    [PreserveSig] int EnumObjects(IntPtr hwnd, int flags, out IEnumIDList e);
    [PreserveSig] int BindToObject(IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int BindToStorage(IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int CompareIDs(IntPtr lParam, IntPtr p1, IntPtr p2);
    [PreserveSig] int CreateViewObject(IntPtr hwnd, ref Guid riid, out IntPtr ppv);
    [PreserveSig] int GetAttributesOf(uint cidl,
      [In, MarshalAs(UnmanagedType.LPArray)] IntPtr[] apidl, ref uint attrs);
    // Массив здесь обязан быть LPArray: в COM-интерфейсе по умолчанию
    // массивы передаются как SAFEARRAY, и вызов рушит процесс.
    [PreserveSig] int GetUIObjectOf(IntPtr hwnd, uint cidl,
      [In, MarshalAs(UnmanagedType.LPArray)] IntPtr[] apidl,
      ref Guid riid, IntPtr reserved, out IntPtr ppv);
    [PreserveSig] int GetDisplayNameOf(IntPtr pidl, uint flags, IntPtr strret);
    [PreserveSig] int SetNameOf(IntPtr hwnd, IntPtr pidl,
      [MarshalAs(UnmanagedType.LPWStr)] string name, uint flags, out IntPtr pidlOut);
  }

  [ComImport, Guid("000214E4-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IContextMenu {
    [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint index, uint idFirst, uint idLast, uint flags);
    [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFO ici);
    [PreserveSig] int GetCommandString(UIntPtr idCmd, uint type, IntPtr res, IntPtr name, uint cch);
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct CMINVOKECOMMANDINFO {
    public int cbSize; public int fMask; public IntPtr hwnd; public IntPtr lpVerb;
    public IntPtr lpParameters; public IntPtr lpDirectory; public int nShow;
    public int dwHotKey; public IntPtr hIcon;
  }

  public class Command {
    public uint Id;
    public string Name;     // внутреннее имя, не зависит от языка
    public string Text;     // то, что видит человек
    public bool Enabled;
  }

  public static class Connections {
    [DllImport("shell32.dll")] static extern int SHGetDesktopFolder(out IShellFolder f);
    [DllImport("shell32.dll")] static extern int SHGetSpecialFolderLocation(IntPtr hwnd, int csidl, out IntPtr pidl);
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode, EntryPoint = "StrRetToBufW")]
    static extern int StrRetToBuf(IntPtr strret, IntPtr pidl, StringBuilder buf, uint cch);
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] static extern IntPtr CreatePopupMenu();
    [DllImport("user32.dll")] static extern bool DestroyMenu(IntPtr h);
    [DllImport("user32.dll")] static extern int GetMenuItemCount(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetMenuItemID(IntPtr h, int pos);
    [DllImport("user32.dll")] static extern uint GetMenuState(IntPtr h, uint item, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetMenuStringW")]
    static extern int GetMenuString(IntPtr h, uint item, StringBuilder buf, int cch, uint flags);

    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

    const int CSIDL_CONNECTIONS = 0x31;
    const uint MF_BYPOSITION = 0x400, MF_GRAYED = 0x1, MF_DISABLED = 0x2, MF_SEPARATOR = 0x800;
    const uint GCS_VERBW = 0x4;
    const uint ID_FIRST = 1;
    const uint WM_COMMAND = 0x111, WM_CLOSE = 0x10;

    /// <summary>Что Windows сказала окнами сообщений за время работы.</summary>
    public static List<string> Complaints = new List<string>();
    static HashSet<IntPtr> handled = new HashSet<IntPtr>();
    static volatile bool watching;

    /// <summary>
    /// Окна сообщений, которые оболочка показывает посреди команды.
    ///
    /// Сборка моста при сбое выводит модальное «Возникла непредвиденная
    /// ошибка при настройке сетевого моста» — и команда ждёт, пока его
    /// закроют. На компьютере, который отдаёт карту по сети, закрывать его
    /// некому: занятие висело бы до таймаута, а окно — до прихода человека.
    /// CMIC_MASK_FLAG_NO_UI оболочка здесь не соблюдает.
    ///
    /// Смотрим только окна СВОЕГО процесса. Стандартное окно сообщения
    /// узнаётся по устройству, а не по тексту (он зависит от языка):
    /// #32770 со статическим текстом id 0xFFFF и кнопками. Окно с одной
    /// кнопкой — сообщение: закрываем, текст идёт в журнал как причина.
    /// Окно с несколькими — вопрос: не угадываем ответ, закрываем как отказ.
    /// Окно без кнопок («Подождите…») — ход работы, его не трогаем.
    /// </summary>
    static void DismissMessageBoxes() {
      uint me = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
      EnumWindows((h, l) => {
        uint pid; GetWindowThreadProcessId(h, out pid);
        if (pid != me || !IsWindowVisible(h) || handled.Contains(h)) return true;
        var cls = new StringBuilder(64); GetClassName(h, cls, 64);
        if (cls.ToString() != "#32770") return true;
        string text = null;
        var buttons = new List<IntPtr>();
        EnumChildWindows(h, (k, l2) => {
          var kc = new StringBuilder(64); GetClassName(k, kc, 64);
          int id = GetDlgCtrlID(k);
          if (kc.ToString() == "Static" && id == 0xFFFF) {
            var t = new StringBuilder(1024); GetWindowText(k, t, 1024); text = t.ToString();
          }
          if (kc.ToString() == "Button" && IsWindowVisible(k)) buttons.Add(k);
          return true;
        }, IntPtr.Zero);
        if (text == null || buttons.Count == 0) return true;
        handled.Add(h);
        if (buttons.Count == 1) {
          Complaints.Add(text);
          Trace("окно Windows закрыто: " + text);
          PostMessage(h, WM_COMMAND, (IntPtr)GetDlgCtrlID(buttons[0]), buttons[0]);
        } else {
          Complaints.Add(text + " (вопрос — ответили отказом)");
          Trace("окно-вопрос Windows закрыто отказом: " + text);
          PostMessage(h, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        }
        return true;
      }, IntPtr.Zero);
    }

    static System.Threading.Thread guard;

    /// <summary>
    /// Наблюдение на всё время операции, а не только на вызов команды:
    /// оболочка может показать окно и с рабочего потока, уже вернув управление.
    /// </summary>
    public static void StartGuard() {
      if (guard != null) return;
      watching = true;
      guard = new System.Threading.Thread(() => {
        while (watching) {
          try { DismissMessageBoxes(); } catch { }
          System.Threading.Thread.Sleep(300);
        }
      });
      guard.IsBackground = true;
      guard.Start();
    }

    public static void StopGuard() {
      if (guard == null) return;
      watching = false;
      guard.Join(2000);
      guard = null;
      try { DismissMessageBoxes(); } catch { }
    }

    static Guid IID_ShellFolder = new Guid("000214E6-0000-0000-C000-000000000046");
    static Guid IID_ContextMenu = new Guid("000214E4-0000-0000-C000-000000000046");

    static IShellFolder Folder() {
      IShellFolder desktop;
      SHGetDesktopFolder(out desktop);
      IntPtr pidl;
      SHGetSpecialFolderLocation(IntPtr.Zero, CSIDL_CONNECTIONS, out pidl);
      Guid iid = IID_ShellFolder;
      IntPtr p;
      int hr = desktop.BindToObject(pidl, IntPtr.Zero, ref iid, out p);
      if (hr != 0) throw new Exception("папка сетевых подключений не открылась: 0x" + hr.ToString("X"));
      return (IShellFolder)Marshal.GetObjectForIUnknown(p);
    }

    static string NameOf(IShellFolder f, IntPtr pidl) {
      IntPtr sr = Marshal.AllocCoTaskMem(520);
      try {
        if (f.GetDisplayNameOf(pidl, 0, sr) != 0) return "";
        var sb = new StringBuilder(260);
        StrRetToBuf(sr, pidl, sb, 260);
        return sb.ToString();
      } finally { Marshal.FreeCoTaskMem(sr); }
    }

    public static List<string> List() {
      var f = Folder();
      IEnumIDList en;
      f.EnumObjects(IntPtr.Zero, 0x60, out en);
      var names = new List<string>();
      IntPtr one; uint got;
      while (en.Next(1, out one, out got) == 0 && got == 1) names.Add(NameOf(f, one));
      return names;
    }

    static IntPtr[] Pick(IShellFolder f, string[] wanted) {
      var found = new IntPtr[wanted.Length];
      IEnumIDList en;
      f.EnumObjects(IntPtr.Zero, 0x60, out en);
      IntPtr one; uint got;
      while (en.Next(1, out one, out got) == 0 && got == 1) {
        string n = NameOf(f, one);
        for (int i = 0; i < wanted.Length; i++)
          if (found[i] == IntPtr.Zero && n == wanted[i]) found[i] = one;
      }
      for (int i = 0; i < wanted.Length; i++)
        if (found[i] == IntPtr.Zero) throw new Exception("адаптер не найден в папке: " + wanted[i]);
      return found;
    }

    static IContextMenu MenuFor(IShellFolder f, IntPtr[] pidls) {
      IntPtr reserved = Marshal.AllocCoTaskMem(8);
      Marshal.WriteInt64(reserved, 0);
      Guid iid = IID_ContextMenu;
      IntPtr pcm;
      int hr = f.GetUIObjectOf(GetConsoleWindow(), (uint)pidls.Length, pidls, ref iid, reserved, out pcm);
      if (hr != 0) throw new Exception("меню не получено: 0x" + hr.ToString("X"));
      return (IContextMenu)Marshal.GetObjectForIUnknown(pcm);
    }

    static List<Command> Read(IContextMenu cm, IntPtr hmenu) {
      int hr = cm.QueryContextMenu(hmenu, 0, ID_FIRST, 0x7FFF, 0);
      if (hr < 0) throw new Exception("QueryContextMenu: 0x" + hr.ToString("X"));
      var list = new List<Command>();
      int count = GetMenuItemCount(hmenu);
      for (int i = 0; i < count; i++) {
        uint st = GetMenuState(hmenu, (uint)i, MF_BYPOSITION);
        if ((st & MF_SEPARATOR) != 0) continue;
        uint id = GetMenuItemID(hmenu, i);
        var sb = new StringBuilder(260);
        GetMenuString(hmenu, (uint)i, sb, 260, MF_BYPOSITION);
        IntPtr vb = Marshal.AllocCoTaskMem(1024);
        string canon = "";
        try {
          Marshal.WriteInt64(vb, 0);
          if (cm.GetCommandString((UIntPtr)(id - ID_FIRST), GCS_VERBW, IntPtr.Zero, vb, 512) == 0)
            canon = Marshal.PtrToStringUni(vb);
        } finally { Marshal.FreeCoTaskMem(vb); }
        list.Add(new Command {
          Id = id, Name = canon, Text = sb.ToString().Replace("&", ""),
          Enabled = (st & (MF_GRAYED | MF_DISABLED)) == 0
        });
      }
      return list;
    }

    public static List<Command> Commands(string[] adapters) {
      var f = Folder();
      var cm = MenuFor(f, Pick(f, adapters));
      IntPtr hmenu = CreatePopupMenu();
      try { return Read(cm, hmenu); } finally { DestroyMenu(hmenu); }
    }

    // Ход работы — в поток ошибок: поток вывода читает приложение.
    public static void Trace(string s) {
      Console.Error.WriteLine(DateTime.Now.ToString("HH:mm:ss.fff") + " " + s);
      Console.Error.Flush();
    }

    public static string Invoke(string[] adapters, string verb) {
      Trace(verb + ": открываю папку");
      var f = Folder();
      var cm = MenuFor(f, Pick(f, adapters));
      IntPtr hmenu = CreatePopupMenu();
      try {
        var cmds = Read(cm, hmenu);
        Trace(verb + ": меню прочитано, пунктов " + cmds.Count);
        Command target = null;
        foreach (var c in cmds)
          if (string.Equals(c.Name, verb, StringComparison.OrdinalIgnoreCase)) { target = c; break; }
        if (target == null) { Trace(verb + ": команды в меню нет"); return "команды <" + verb + "> в меню нет"; }
        if (!target.Enabled) { Trace(verb + ": команда недоступна"); return "команда <" + verb + "> (" + target.Text + ") недоступна"; }

        var ici = new CMINVOKECOMMANDINFO();
        ici.cbSize = Marshal.SizeOf(typeof(CMINVOKECOMMANDINFO));
        ici.fMask = 0x400;   // CMIC_MASK_FLAG_NO_UI — работаем без вопросов на экране
        ici.lpVerb = (IntPtr)(target.Id - ID_FIRST);   // MAKEINTRESOURCE(смещение)
        ici.nShow = 1;
        Trace(verb + ": вызываю");
        int hr = cm.InvokeCommand(ref ici);
        Trace(verb + ": вернулась 0x" + hr.ToString("X"));
        return "<" + target.Text + "> (" + verb + "): 0x" + hr.ToString("X");
      } finally { DestroyMenu(hmenu); }
    }
  }
}
'@

Add-Type -TypeDefinition $source -ErrorAction Stop

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Кто сейчас в мосту. Признак — включённый ms_implat на адаптере.
function Get-BridgeMembers {
  @(Get-NetAdapterBinding -AllBindings -ErrorAction SilentlyContinue |
      Where-Object { $_.ComponentID -eq 'ms_implat' -and $_.Enabled } |
      ForEach-Object { $_.Name })
}

function Show-State {
  Write-Output '--- состояние ---'
  $m = Get-BridgeMembers
  if ($m.Count -eq 0) { Write-Output '  моста нет' }
  else { $m | ForEach-Object { Write-Output ('  в мосту: ' + $_) } }
  Get-NetAdapter -ErrorAction SilentlyContinue |
    ForEach-Object { Write-Output ('  ' + $_.Name + ' | ' + $_.InterfaceDescription + ' | ' + $_.Status) }
}

# Мосту нужны права администратора. Повышаем обычным способом — запросом
# согласия у человека, без скрытых окон и без обхода политик.
if ($Action -ne 'verbs' -and $Action -ne 'state' -and -not (Test-Admin) -and -not $Elevated) {
  $self = $MyInvocation.MyCommand.Path
  $log = Join-Path $env:TEMP 'nds-bridge.log'
  if (Test-Path $log) { Remove-Item $log -Force }
  $names = ''
  if ($Adapter.Count -gt 0) {
    $names = ' -Adapter ' + (($Adapter | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ',')
  }
  $inner = "& '$self' -Action $Action$names -Elevated *>&1 | Out-File -LiteralPath '$log' -Encoding utf8"
  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru `
    -ArgumentList '-NoProfile', '-Command', $inner
  if (Test-Path $log) { Get-Content -LiteralPath $log -Encoding UTF8 }
  if ($p.ExitCode -ne 0) { Write-Output ('повышение прав завершилось кодом ' + $p.ExitCode) }
  return
}

# Итог для приложения. Состав моста перечитывается здесь же: судить об
# успехе по ответу команды нельзя — меню отвечает S_OK и тогда, когда
# ничего не сделало.
function Write-Result([bool]$Ok, [string]$Message) {
  if (-not $Json) { return }
  # Неудача без объяснения бесполезна: к ней — то, что Windows сказала окнами.
  $said = @([NdsBridge.Connections]::Complaints)
  if (-not $Ok -and $said.Count -gt 0) { $Message = $Message + '; Windows: ' + ($said -join '; ') }
  $r = [ordered]@{ ok = $Ok; message = $Message; members = @(Get-BridgeMembers); windows = $said }
  Write-Output ('NDS-RESULT ' + (ConvertTo-Json -Compress -Depth 3 -InputObject $r))
}

# Ждать нужного состава моста. Мост собирается секундами, и фиксированная
# пауза либо тратит время зря, либо оказывается мала.
function Wait-Members([scriptblock]$Done, [int]$Seconds = 30) {
  $until = (Get-Date).AddSeconds($Seconds)
  do {
    $m = @(Get-BridgeMembers)
    if (& $Done $m) {
      [NdsBridge.Connections]::Trace('в мосту: ' + ($m -join ', '))
      return $m
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $until)
  $m = @(Get-BridgeMembers)
  [NdsBridge.Connections]::Trace('ожидание вышло, в мосту: ' + ($m -join ', '))
  return $m
}

if ($Action -eq 'bridge' -or $Action -eq 'unbridge') { [NdsBridge.Connections]::StartGuard() }
try {
switch ($Action) {

  'state' { Show-State; Write-Result $true '' }

  'verbs' {
    if (-not $Adapter -or $Adapter.Count -eq 0) {
      Write-Output 'адаптеры в папке «Сетевые подключения»:'
      [NdsBridge.Connections]::List() | ForEach-Object { Write-Output ('  ' + $_) }
      return
    }
    Write-Output ('команды для: ' + ($Adapter -join ' + '))
    foreach ($c in [NdsBridge.Connections]::Commands($Adapter)) {
      $mark = '  '
      if (-not $c.Enabled) { $mark = 'x ' }
      $n = $c.Name
      if (-not $n) { $n = '(без имени)' }
      Write-Output ('  ' + $mark + $n.PadRight(18) + $c.Text)
    }
  }

  # Связать указанные адаптеры. Действие можно повторять: уже связанные
  # пропускаются.
  #
  # createbridge на паре адаптеров включает в мост только первый, а на
  # втором выводит «Возникла непредвиденная ошибка при настройке сетевого
  # моста» (проверено 23 сентября, повторяется от раза к разу). Окно
  # закрывает наблюдатель, а второй адаптер досылается командой
  # addtobridge — поштучно она срабатывает. Бывает, что и она не с первого
  # раза, поэтому с повтором.
  'bridge' {
    # Новый мост собирается минимум из двух адаптеров; в готовый можно
    # добавить и один — так к мосту коммутатора подключается проброс.
    $members = @(Get-BridgeMembers)
    if ($Adapter.Count -lt 2 -and $members.Count -eq 0) {
      Write-Output 'нужно не меньше двух адаптеров'
      Write-Result $false 'нужно не меньше двух адаптеров'
      break
    }
    $missing = @($Adapter | Where-Object { $members -notcontains $_ })
    if ($missing.Count -eq 0) { Write-Output 'все указанные адаптеры уже в мосту'; Show-State; Write-Result $true ''; break }

    if ($members.Count -eq 0) {
      Write-Output ([NdsBridge.Connections]::Invoke($Adapter, 'createbridge'))
      $members = @(Wait-Members { param($m) $m.Count -gt 0 })
    }
    # Сразу после createbridge команды addtobridge в меню ещё нет: мост
    # достраивается, и сколько — зависит от машины (видели и 18 секунд).
    # Поэтому пробуем раз в секунду, а долго ждём вхождения в мост только
    # после настоящего вызова.
    foreach ($a in $Adapter) {
      $deadline = (Get-Date).AddSeconds(45)
      while ($members -notcontains $a -and (Get-Date) -lt $deadline) {
        $r = [NdsBridge.Connections]::Invoke(@($a), 'addtobridge')
        Write-Output ('  ' + $a + ': ' + $r)
        if ($r.StartsWith('<')) {
          $members = @(Wait-Members { param($m) $m -contains $a } 15)
        } else {
          Start-Sleep -Seconds 1
          $members = @(Get-BridgeMembers)
        }
      }
    }
    Show-State
    $left = @($Adapter | Where-Object { (Get-BridgeMembers) -notcontains $_ })
    if ($left.Count -gt 0) {
      Write-Output ('не вошли в мост: ' + ($left -join ', '))
      Write-Result $false ('не вошли в мост: ' + ($left -join ', '))
    } else {
      Write-Result $true ''
    }
  }

  # Развязать. Мост исчезает сам, когда из него выходит последний участник,
  # поэтому отдельного удаления не требуется: команда delete на самом мосту
  # без вопроса на экране возвращает успех, но ничего не делает.
  'unbridge' {
    $members = @(Get-BridgeMembers)
    if ($members.Count -eq 0) { Write-Output 'моста нет'; Write-Result $true ''; break }
    $only = $members
    if ($Adapter.Count -gt 0) { $only = @($members | Where-Object { $Adapter -contains $_ }) }
    foreach ($a in $only) {
      Write-Output ('  ' + $a + ': ' + [NdsBridge.Connections]::Invoke(@($a), 'removefrombridge'))
      $null = Wait-Members { param($m) $m -notcontains $a } 20
    }
    Show-State
    $left = @($only | Where-Object { (Get-BridgeMembers) -contains $_ })
    if ($left.Count -gt 0) { Write-Result $false ('остались в мосту: ' + ($left -join ', ')) }
    else { Write-Result $true '' }
  }
}
} catch {
  Write-Output ('ошибка: ' + $_.Exception.Message)
  Write-Result $false $_.Exception.Message
  exit 1
} finally {
  [NdsBridge.Connections]::StopGuard()
}
