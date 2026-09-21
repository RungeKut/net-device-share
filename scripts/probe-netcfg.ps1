#Requires -Version 5.1
<#
.SYNOPSIS
    Осмотр сетевой конфигурации через INetCfg. Только чтение.

.DESCRIPTION
    INetCfg — тот самый COM-интерфейс, которым пользуется панель управления,
    когда выделяешь два подключения и жмёшь «Настройка моста». Штатных
    средств для этого нет: Get-NetAdapterBinding компонент моста не
    показывает, а netsh bridge умеет только show и set.

    Этот скрипт ничего не меняет. Он перечисляет сетевые компоненты и
    адаптеры и проверяет, можно ли в принципе привязать адаптер к мосту
    (IsBindableTo). По его выводу решается, годится ли INetCfg для
    автоматической настройки моста.

.EXAMPLE
    powershell -NoProfile -File probe-netcfg.ps1
#>

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Runtime.InteropServices;

namespace NetCfgProbe {

  [ComImport, Guid("C0E8AE93-306E-11D1-AACF-00805FC1270E"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface INetCfg {
    void Initialize(IntPtr reserved);
    void Uninitialize();
    void Apply();
    void Cancel();
    void EnumComponents(ref Guid classGuid, [MarshalAs(UnmanagedType.IUnknown)] out object e);
    void FindComponent([MarshalAs(UnmanagedType.LPWStr)] string infId, out INetCfgComponent c);
    void QueryNetCfgClass(ref Guid classGuid, ref Guid iid,
      [MarshalAs(UnmanagedType.IUnknown)] out object o);
  }

  [ComImport, Guid("C0E8AE9F-306E-11D1-AACF-00805FC1270E"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface INetCfgLock {
    [PreserveSig] int AcquireWriteLock(uint timeoutMs,
      [MarshalAs(UnmanagedType.LPWStr)] string client,
      [MarshalAs(UnmanagedType.LPWStr)] out string holder);
    [PreserveSig] int ReleaseWriteLock();
    [PreserveSig] int IsWriteLocked([MarshalAs(UnmanagedType.LPWStr)] out string holder);
  }

  // Идентификатор подобран опросом самого объекта (см. FindEnumIid):
  // в справочниках он встречается как C0E8AE9B, но система отвечает на 92.
  [ComImport, Guid("C0E8AE92-306E-11D1-AACF-00805FC1270E"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IEnumNetCfgComponent {
    // Запрашиваем строго по одному: массив интерфейсных указателей
    // маршалится ненадёжно, а один указатель совпадает с памятью точно.
    [PreserveSig] int Next(uint count,
      [MarshalAs(UnmanagedType.IUnknown)] out object item,
      out uint fetched);
    void Skip(uint count);
    void Reset();
    void Clone(out IEnumNetCfgComponent e);
  }

  [ComImport, Guid("C0E8AE99-306E-11D1-AACF-00805FC1270E"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface INetCfgComponent {
    void GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetHelpText([MarshalAs(UnmanagedType.LPWStr)] out string text);
    void GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    void GetCharacteristics(out uint flags);
    void GetInstanceGuid(out Guid guid);
    void GetPnpDevNodeId([MarshalAs(UnmanagedType.LPWStr)] out string devNode);
    void GetClassGuid(out Guid guid);
    void GetBindName([MarshalAs(UnmanagedType.LPWStr)] out string bindName);
    void GetDeviceStatus(out uint status);
    void OpenParamKey(out IntPtr key);
    void RaisePropertyUi(IntPtr parent, uint flags, [MarshalAs(UnmanagedType.IUnknown)] object context);
  }

  // Идентификатор подобран опросом самого компонента: справочники чаще
  // называют C0E8AE9D, но ms_bridge отвечает на 9E.
  [ComImport, Guid("C0E8AE9E-306E-11D1-AACF-00805FC1270E"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface INetCfgComponentBindings {
    [PreserveSig] int BindTo(INetCfgComponent item);
    [PreserveSig] int UnbindFrom(INetCfgComponent item);
    [PreserveSig] int SupportsBindingInterface(uint flags,
      [MarshalAs(UnmanagedType.LPWStr)] string iface);
    [PreserveSig] int IsBoundTo(INetCfgComponent item);
    [PreserveSig] int IsBindableTo(INetCfgComponent item);
    void EnumBindingPaths(uint flags, out IntPtr e);
  }

  public static class Probe {
    static Guid CLSID_CNetCfg = new Guid("5B035261-40F9-11D1-AAEC-00805FC1270E");
    static Guid CLASS_NET     = new Guid("4D36E972-E325-11CE-BFC1-08002BE10318");
    static Guid CLASS_SERVICE = new Guid("4D36E974-E325-11CE-BFC1-08002BE10318");

    static string Id(INetCfgComponent c) {
      string s; c.GetId(out s); return s;
    }
    static string Name(INetCfgComponent c) {
      try { string s; c.GetDisplayName(out s); return s; } catch { return "(без имени)"; }
    }

    static INetCfgComponent[] List(INetCfg cfg, Guid cls) {
      object e;
      cfg.EnumComponents(ref cls, out e);
      var result = new System.Collections.Generic.List<INetCfgComponent>();
      var en = (IEnumNetCfgComponent)e;
      object one;
      uint got;
      while (en.Next(1, out one, out got) == 0 && got == 1 && one != null) {
        result.Add((INetCfgComponent)one);
      }
      return result.ToArray();
    }

    /// <summary>
    /// Подбор идентификатора интерфейса перечислителя.
    ///
    /// В заголовках он есть, но под рукой их нет, а гадать дороже, чем
    /// спросить у самого объекта: QueryInterface честно отвечает, какой
    /// интерфейс поддерживается.
    /// </summary>
    public static void FindEnumIid() {
      Type t = Type.GetTypeFromCLSID(CLSID_CNetCfg);
      var cfg = (INetCfg)Activator.CreateInstance(t);
      cfg.Initialize(IntPtr.Zero);
      try {
        object e;
        Guid cls = CLASS_NET;
        cfg.EnumComponents(ref cls, out e);
        IntPtr unk = Marshal.GetIUnknownForObject(e);
        Console.WriteLine("перечислитель получен, подбираем идентификатор:");
        for (int i = 0x90; i <= 0xAF; i++) {
          Guid g = new Guid(string.Format("C0E8AE{0:X2}-306E-11D1-AACF-00805FC1270E", i));
          IntPtr p;
          if (Marshal.QueryInterface(unk, ref g, out p) == 0) {
            Console.WriteLine("  ПОДОШЁЛ: " + g.ToString().ToUpper());
            Marshal.Release(p);
          }
        }
        Marshal.Release(unk);
      } finally { cfg.Uninitialize(); }
    }

    public static void Run() {
      Type t = Type.GetTypeFromCLSID(CLSID_CNetCfg);
      var cfg = (INetCfg)Activator.CreateInstance(t);
      Console.WriteLine("INetCfg создан");

      // Блокировку берём ДО Initialize — так требует INetCfg. Без неё
      // конфигурация открывается только на чтение, и оценка привязок
      // отвечает «нельзя» для всего подряд, что ни о чём не говорит.
      var lockIface = (INetCfgLock)cfg;
      string holder;
      int lockHr = lockIface.AcquireWriteLock(5000, "net-device-share probe", out holder);
      bool locked = (lockHr == 0);
      Console.WriteLine("блокировка записи: " + (locked
        ? "взята" : ("НЕ взята (0x" + lockHr.ToString("X") + "), держит: " + holder)));

      cfg.Initialize(IntPtr.Zero);
      Console.WriteLine("Initialize: успех");

      try {

        Console.WriteLine("\n--- сетевые службы ---");
        INetCfgComponent bridge = null;
        var services = List(cfg, CLASS_SERVICE);
        Console.WriteLine("  всего служб: " + services.Length);
        foreach (var c in services) {
          string id = Id(c);
          if (id != null && id.ToLower().Contains("bridge")) {
            Console.WriteLine("  " + id + "  —  " + Name(c));
            if (id.ToLower() == "ms_bridge") bridge = c;
          }
        }
        if (bridge == null) { Console.WriteLine("  ms_bridge не найден"); return; }

        // Какие интерфейсы компонент вообще поддерживает — спрашиваем у него
        // самого, тем же способом, что и у перечислителя.
        Console.WriteLine();
        Console.WriteLine("--- интерфейсы ms_bridge ---");
        IntPtr unkB = Marshal.GetIUnknownForObject(bridge);
        for (int i = 0x90; i <= 0xAF; i++) {
          Guid g = new Guid(string.Format("C0E8AE{0:X2}-306E-11D1-AACF-00805FC1270E", i));
          IntPtr p;
          if (Marshal.QueryInterface(unkB, ref g, out p) == 0) {
            Console.WriteLine("  поддерживает C0E8AE" + i.ToString("X2"));
            Marshal.Release(p);
          }
        }
        Marshal.Release(unkB);

        var bind = bridge as INetCfgComponentBindings;
        Console.WriteLine("\nms_bridge поддерживает привязки: " + (bind != null));
        if (bind == null) return;

        Console.WriteLine("\n--- адаптеры и возможность привязки к мосту ---");
        foreach (var a in List(cfg, CLASS_NET)) {
          string bindName = "";
          try { a.GetBindName(out bindName); } catch { }
          int bound    = bind.IsBoundTo(a);
          int bindable = bind.IsBindableTo(a);
          Console.WriteLine(string.Format("  {0,-42} привязан: {1,-14} можно привязать: {2}",
            Name(a), (bound == 0 ? "да" : "нет (0x" + bound.ToString("X") + ")"),
            (bindable == 0 ? "ДА" : "нет (0x" + bindable.ToString("X") + ")")));
        }
      } finally {
        // Cancel, а не Apply: проверка ничего не меняет.
        try { cfg.Cancel(); } catch { }
        if (locked) lockIface.ReleaseWriteLock();
        cfg.Uninitialize();
        Console.WriteLine("\nUninitialize: конфигурация отпущена, ничего не изменено");
      }
    }
  }
}
'@

Add-Type -TypeDefinition $source -ErrorAction Stop
[NetCfgProbe.Probe]::Run()
