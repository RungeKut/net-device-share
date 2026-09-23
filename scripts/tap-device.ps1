#Requires -Version 5.1
<#
.SYNOPSIS
    Создание и удаление TAP-адаптера — ровно одного, не трогая остальные.

.DESCRIPTION
    Зачем не devcon. «devcon install» создаёт устройство и затем вызывает
    UpdateDriverForPlugAndPlayDevices — а та переустанавливает драйвер на
    ВСЕХ устройствах с тем же идентификатором. Каждый уже открытый TAP-адаптер
    при этом перезапускается: у работающего проброса рвётся чтение, у OpenVPN
    на той же машине — туннель. Пока адаптер создавался раз в жизни, это
    терпелось; с виртуальными адаптерами, которые заводят кнопкой, — нет.

    Здесь драйвер ставится только на новое устройство, теми же вызовами
    SetupAPI, которыми пользуется tapctl из OpenVPN:

      SetupDiCreateDeviceInfo → SPDRP_HARDWAREID → SetupDiBuildDriverInfoList
      → SetupDiSetSelectedDriver → DIF_REGISTERDEVICE → DIF_INSTALLDEVICE

    Драйвер берётся из хранилища драйверов. Если его там ещё нет (первый
    адаптер на машине), пакет кладётся туда из -Inf вызовом SetupCopyOEMInf.

    Удаление — DIF_REMOVE по идентификатору экземпляра устройства.

    Нужны права администратора. Результат — одна строка «NDS-RESULT {json}»
    в потоке вывода.

.PARAMETER Action
    create — новый адаптер; remove — удалить адаптер -InstanceId.

.PARAMETER Inf
    Путь к OemVista.inf драйвера (для create).

.PARAMETER InstanceId
    Идентификатор экземпляра устройства, например ROOT\NET\0002 (для remove).

.EXAMPLE
    powershell -NoProfile -File tap-device.ps1 -Action create -Inf C:\nds\installers\windows\tap-windows6-9.27.0\OemVista.inf
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet('create', 'remove')][string]$Action,
  [string]$Inf,
  [string]$InstanceId,
  [string]$HardwareId = 'tap0901'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace NdsTap {
  public static class Device {
    static Guid NetClass = new Guid("4d36e972-e325-11ce-bfc1-08002be10318");

    const int DICD_GENERATE_ID = 1;
    const int SPDIT_COMPATDRIVER = 2;
    const int SPDRP_HARDWAREID = 1;
    const int DIF_INSTALLDEVICE = 0x02;
    const int DIF_REMOVE = 0x05;
    const int DIF_REGISTERDEVICE = 0x19;
    const int DIF_INSTALLINTERFACES = 0x20;
    const int DIF_REGISTER_COINSTALLERS = 0x22;
    const int DICS_FLAG_GLOBAL = 1;
    const int DIREG_DRV = 2;
    const int KEY_READ = 0x20019;
    const int DI_NEEDRESTART = 0x80;
    const int DI_NEEDREBOOT = 0x100;
    const int SPOST_PATH = 1;
    const int ERROR_FILE_EXISTS = 80;

    [StructLayout(LayoutKind.Sequential)]
    struct SP_DEVINFO_DATA {
      public int cbSize;
      public Guid ClassGuid;
      public int DevInst;
      public IntPtr Reserved;
    }

    // SP_DRVINFO_DATA_V2_W. Дата — FILETIME, здесь восемью байтами: смещение
    // у неё и так кратно восьми, раскладка совпадает.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SP_DRVINFO_DATA {
      public int cbSize;
      public int DriverType;
      public IntPtr Reserved;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string Description;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string MfgName;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string ProviderName;
      public long DriverDate;
      public long DriverVersion;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct SP_DEVINSTALL_PARAMS {
      public int cbSize;
      public int Flags;
      public int FlagsEx;
      public IntPtr hwndParent;
      public IntPtr InstallMsgHandler;
      public IntPtr InstallMsgHandlerContext;
      public IntPtr FileQueue;
      public IntPtr ClassInstallReserved;
      public int Reserved;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string DriverPath;
    }

    [DllImport("setupapi.dll", SetLastError = true)]
    static extern IntPtr SetupDiCreateDeviceInfoList(ref Guid classGuid, IntPtr hwnd);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool SetupDiCreateDeviceInfoW(IntPtr set, string name, ref Guid classGuid,
      string description, IntPtr hwnd, int flags, ref SP_DEVINFO_DATA dev);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool SetupDiSetDeviceRegistryPropertyW(IntPtr set, ref SP_DEVINFO_DATA dev,
      int property, byte[] buffer, int size);
    [DllImport("setupapi.dll", SetLastError = true)]
    static extern bool SetupDiBuildDriverInfoList(IntPtr set, ref SP_DEVINFO_DATA dev, int type);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool SetupDiEnumDriverInfoW(IntPtr set, ref SP_DEVINFO_DATA dev, int type,
      int index, ref SP_DRVINFO_DATA drv);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool SetupDiSetSelectedDriverW(IntPtr set, ref SP_DEVINFO_DATA dev, ref SP_DRVINFO_DATA drv);
    [DllImport("setupapi.dll", SetLastError = true)]
    static extern bool SetupDiCallClassInstaller(int function, IntPtr set, ref SP_DEVINFO_DATA dev);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool SetupDiGetDeviceInstallParamsW(IntPtr set, ref SP_DEVINFO_DATA dev, ref SP_DEVINSTALL_PARAMS p);
    [DllImport("setupapi.dll", SetLastError = true)]
    static extern IntPtr SetupDiOpenDevRegKey(IntPtr set, ref SP_DEVINFO_DATA dev, int scope,
      int profile, int keyType, int access);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool SetupDiGetDeviceInstanceIdW(IntPtr set, ref SP_DEVINFO_DATA dev,
      StringBuilder id, int size, out int required);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool SetupDiOpenDeviceInfoW(IntPtr set, string instanceId, IntPtr hwnd,
      int flags, ref SP_DEVINFO_DATA dev);
    [DllImport("setupapi.dll", SetLastError = true)]
    static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
    [DllImport("setupapi.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool SetupCopyOEMInfW(string source, string mediaRoot, int mediaType, int style,
      StringBuilder dest, int destSize, out int required, IntPtr destComponent);

    static Exception Fail(string step) {
      int code = Marshal.GetLastWin32Error();
      return new Exception(step + ": " + new Win32Exception(code).Message + " (0x" + code.ToString("X8") + ")");
    }

    static IntPtr NewSet() {
      Guid cls = NetClass;
      IntPtr set = SetupDiCreateDeviceInfoList(ref cls, IntPtr.Zero);
      if (set == new IntPtr(-1)) throw Fail("SetupDiCreateDeviceInfoList");
      return set;
    }

    static SP_DEVINFO_DATA NewDev() {
      SP_DEVINFO_DATA d = new SP_DEVINFO_DATA();
      d.cbSize = Marshal.SizeOf(typeof(SP_DEVINFO_DATA));
      return d;
    }

    /// Положить пакет драйвера в хранилище. Уже лежащий — не ошибка.
    public static string Stage(string inf) {
      StringBuilder dest = new StringBuilder(260);
      int required;
      if (SetupCopyOEMInfW(inf, null, SPOST_PATH, 0, dest, dest.Capacity, out required, IntPtr.Zero)) {
        return dest.ToString();
      }
      int code = Marshal.GetLastWin32Error();
      if (code == ERROR_FILE_EXISTS) return dest.ToString();
      throw new Exception("SetupCopyOEMInf: " + new Win32Exception(code).Message + " (0x" + code.ToString("X8") + ")");
    }

    static bool FindDriver(IntPtr set, ref SP_DEVINFO_DATA dev, out SP_DRVINFO_DATA best) {
      best = new SP_DRVINFO_DATA();
      bool found = false;
      if (!SetupDiBuildDriverInfoList(set, ref dev, SPDIT_COMPATDRIVER)) return false;
      for (int i = 0; ; i++) {
        SP_DRVINFO_DATA d = new SP_DRVINFO_DATA();
        d.cbSize = Marshal.SizeOf(typeof(SP_DRVINFO_DATA));
        if (!SetupDiEnumDriverInfoW(set, ref dev, SPDIT_COMPATDRIVER, i, ref d)) break;
        if (!found || d.DriverVersion > best.DriverVersion) { best = d; found = true; }
      }
      return found;
    }

    /// Создать адаптер. Возвращает «GUID интерфейса|идентификатор экземпляра|нужна перезагрузка».
    public static string Create(string hwid, string inf) {
      IntPtr set = NewSet();
      SP_DEVINFO_DATA dev = NewDev();
      bool registered = false;
      try {
        Guid cls = NetClass;
        if (!SetupDiCreateDeviceInfoW(set, "Net", ref cls, null, IntPtr.Zero, DICD_GENERATE_ID, ref dev))
          throw Fail("SetupDiCreateDeviceInfo");
        byte[] ids = Encoding.Unicode.GetBytes(hwid + "\0\0");
        if (!SetupDiSetDeviceRegistryPropertyW(set, ref dev, SPDRP_HARDWAREID, ids, ids.Length))
          throw Fail("SPDRP_HARDWAREID");

        SP_DRVINFO_DATA drv;
        if (!FindDriver(set, ref dev, out drv)) {
          // Первый адаптер на машине: драйвера в хранилище ещё нет.
          if (string.IsNullOrEmpty(inf)) throw new Exception("драйвера " + hwid + " нет в хранилище, а путь к INF не задан");
          Stage(inf);
          if (!FindDriver(set, ref dev, out drv)) throw new Exception("драйвер " + hwid + " не найден и после установки пакета");
        }
        if (!SetupDiSetSelectedDriverW(set, ref dev, ref drv)) throw Fail("SetupDiSetSelectedDriver");
        if (!SetupDiCallClassInstaller(DIF_REGISTERDEVICE, set, ref dev)) throw Fail("DIF_REGISTERDEVICE");
        registered = true;
        // Эти два шага у драйвера TAP пустые; отказ в них — не повод бросать.
        SetupDiCallClassInstaller(DIF_REGISTER_COINSTALLERS, set, ref dev);
        SetupDiCallClassInstaller(DIF_INSTALLINTERFACES, set, ref dev);
        if (!SetupDiCallClassInstaller(DIF_INSTALLDEVICE, set, ref dev)) throw Fail("DIF_INSTALLDEVICE");

        SP_DEVINSTALL_PARAMS p = new SP_DEVINSTALL_PARAMS();
        p.cbSize = Marshal.SizeOf(typeof(SP_DEVINSTALL_PARAMS));
        bool reboot = SetupDiGetDeviceInstallParamsW(set, ref dev, ref p)
          && (p.Flags & (DI_NEEDREBOOT | DI_NEEDRESTART)) != 0;

        StringBuilder id = new StringBuilder(260);
        int required;
        SetupDiGetDeviceInstanceIdW(set, ref dev, id, id.Capacity, out required);

        // GUID интерфейса класс сетевых устройств пишет в ключ драйвера не
        // мгновенно — ждём.
        string guid = null;
        for (int i = 0; i < 50 && guid == null; i++) {
          IntPtr h = SetupDiOpenDevRegKey(set, ref dev, DICS_FLAG_GLOBAL, 0, DIREG_DRV, KEY_READ);
          if (h != new IntPtr(-1)) {
            using (RegistryKey key = RegistryKey.FromHandle(new SafeRegistryHandle(h, true))) {
              object v = key.GetValue("NetCfgInstanceId");
              if (v != null) guid = v.ToString();
            }
          }
          if (guid == null) Thread.Sleep(200);
        }
        if (guid == null) throw new Exception("адаптер создан, но GUID интерфейса так и не появился");
        return guid + "|" + id.ToString() + "|" + (reboot ? "1" : "0");
      } catch {
        if (registered) SetupDiCallClassInstaller(DIF_REMOVE, set, ref dev);
        throw;
      } finally {
        SetupDiDestroyDeviceInfoList(set);
      }
    }

    /// Удалить устройство по идентификатору экземпляра.
    public static void Remove(string instanceId) {
      IntPtr set = NewSet();
      try {
        SP_DEVINFO_DATA dev = NewDev();
        if (!SetupDiOpenDeviceInfoW(set, instanceId, IntPtr.Zero, 0, ref dev)) throw Fail("SetupDiOpenDeviceInfo");
        if (!SetupDiCallClassInstaller(DIF_REMOVE, set, ref dev)) throw Fail("DIF_REMOVE");
      } finally {
        SetupDiDestroyDeviceInfoList(set);
      }
    }
  }
}
'@

function Write-Result($obj) {
  Write-Output ('NDS-RESULT ' + ($obj | ConvertTo-Json -Compress))
}

try {
  Add-Type -TypeDefinition $source -Language CSharp
  if ($Action -eq 'create') {
    $parts = [NdsTap.Device]::Create($HardwareId, $Inf).Split('|')
    Write-Result ([pscustomobject]@{ ok = $true; guid = $parts[0]; instanceId = $parts[1]; reboot = ($parts[2] -eq '1') })
  } else {
    if (-not $InstanceId) { throw 'не задан -InstanceId' }
    [NdsTap.Device]::Remove($InstanceId)
    Write-Result ([pscustomobject]@{ ok = $true; instanceId = $InstanceId })
  }
} catch {
  Write-Result ([pscustomobject]@{ ok = $false; message = $_.Exception.Message })
  exit 1
}
