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
#>
param(
  [ValidateSet('state', 'verbs', 'bridge', 'unbridge')]
  [string]$Action = 'verbs',
  [string[]]$Adapter = @(),
  [switch]$Elevated
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

    const int CSIDL_CONNECTIONS = 0x31;
    const uint MF_BYPOSITION = 0x400, MF_GRAYED = 0x1, MF_DISABLED = 0x2, MF_SEPARATOR = 0x800;
    const uint GCS_VERBW = 0x4;
    const uint ID_FIRST = 1;

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

    public static string Invoke(string[] adapters, string verb) {
      var f = Folder();
      var cm = MenuFor(f, Pick(f, adapters));
      IntPtr hmenu = CreatePopupMenu();
      try {
        var cmds = Read(cm, hmenu);
        Command target = null;
        foreach (var c in cmds)
          if (string.Equals(c.Name, verb, StringComparison.OrdinalIgnoreCase)) { target = c; break; }
        if (target == null) return "команды <" + verb + "> в меню нет";
        if (!target.Enabled) return "команда <" + verb + "> (" + target.Text + ") недоступна";

        var ici = new CMINVOKECOMMANDINFO();
        ici.cbSize = Marshal.SizeOf(typeof(CMINVOKECOMMANDINFO));
        ici.fMask = 0x400;   // CMIC_MASK_FLAG_NO_UI — работаем без вопросов на экране
        ici.lpVerb = (IntPtr)(target.Id - ID_FIRST);   // MAKEINTRESOURCE(смещение)
        ici.nShow = 1;
        int hr = cm.InvokeCommand(ref ici);
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

switch ($Action) {

  'state' { Show-State }

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
  # пропускаются. Мост создаётся командой createbridge, но она включает в
  # него не всех, поэтому остальных досылаем поштучно.
  'bridge' {
    if ($Adapter.Count -lt 2) { Write-Output 'нужно не меньше двух адаптеров'; break }
    $members = Get-BridgeMembers
    $missing = @($Adapter | Where-Object { $members -notcontains $_ })
    if ($missing.Count -eq 0) { Write-Output 'все указанные адаптеры уже в мосту'; Show-State; break }

    if ($members.Count -eq 0) {
      Write-Output ([NdsBridge.Connections]::Invoke($Adapter, 'createbridge'))
      Start-Sleep -Seconds 6
      $members = Get-BridgeMembers
    }
    foreach ($a in $Adapter) {
      if ($members -contains $a) { continue }
      Write-Output ('  ' + $a + ': ' + [NdsBridge.Connections]::Invoke(@($a), 'addtobridge'))
      Start-Sleep -Seconds 4
      $members = Get-BridgeMembers
    }
    Show-State
    $left = @($Adapter | Where-Object { (Get-BridgeMembers) -notcontains $_ })
    if ($left.Count -gt 0) { Write-Output ('не вошли в мост: ' + ($left -join ', ')) }
  }

  # Развязать. Мост исчезает сам, когда из него выходит последний участник,
  # поэтому отдельного удаления не требуется: команда delete на самом мосту
  # без вопроса на экране возвращает успех, но ничего не делает.
  'unbridge' {
    $members = Get-BridgeMembers
    if ($members.Count -eq 0) { Write-Output 'моста нет'; break }
    $only = $members
    if ($Adapter.Count -gt 0) { $only = @($members | Where-Object { $Adapter -contains $_ }) }
    foreach ($a in $only) {
      Write-Output ('  ' + $a + ': ' + [NdsBridge.Connections]::Invoke(@($a), 'removefrombridge'))
      Start-Sleep -Seconds 4
    }
    Show-State
  }
}
