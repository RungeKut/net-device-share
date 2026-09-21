#Requires -Version 5.1
<#
.SYNOPSIS
    Посредник между TAP-адаптером и каналами процесса.

.DESCRIPTION
    Зачем он существует. Кадры из TAP-адаптера читаются блокирующим вызовом:
    пока кадра нет, поток стоит. В Node это смертельно — чтение уходит в пул
    потоков libuv, а он на четыре потока, и пара адаптеров подвесила бы всё
    приложение вместе с файловыми операциями и DNS. Поэтому блокируется
    отдельный процесс, а приложение говорит с ним по каналам.

    Вторая причина: адаптер нужно «включить» вызовом DeviceIoControl, иначе
    он так и останется «сетевой кабель не подключён». Из Node такой вызов
    недоступен вовсе.

    Формат обмена по каналам — длина кадра двумя байтами (старший первый),
    затем сам кадр. Одинаково в обе стороны.

    Весь горячий цикл написан на C# и компилируется один раз при запуске:
    PowerShell здесь только запускающая обёртка. Так быстрее и, что важнее,
    меньше похоже на то, чем пользуются вредоносные программы: код лежит
    открыто рядом с приложением, ничего не скачивается и не прячется.

.PARAMETER Guid
    GUID сетевого интерфейса TAP-адаптера, с фигурными скобками или без.

.EXAMPLE
    powershell -NoProfile -File tap-relay.ps1 -Guid 4FA3CA55-C375-4FF2-A81A-907D38192770

.NOTES
    Диагностика идёт в поток ошибок: поток вывода занят кадрами и должен
    оставаться двоично чистым.
#>
param(
  [Parameter(Mandatory = $true)][string]$Guid
)

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

public static class TapRelay {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share,
    IntPtr sec, uint disp, uint flags, IntPtr tmpl);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DeviceIoControl(IntPtr h, uint code, byte[] inb, uint inl,
    byte[] outb, uint outl, out uint ret, IntPtr ov);

  const uint GENERIC_READ = 0x80000000;
  const uint GENERIC_WRITE = 0x40000000;
  const uint OPEN_EXISTING = 3;
  const uint FILE_ATTRIBUTE_SYSTEM = 0x4;
  const uint FILE_FLAG_OVERLAPPED = 0x40000000;
  const uint TAP_IOCTL_SET_MEDIA_STATUS = 0x220018;

  // Кадр Ethernet с запасом на теги VLAN. Больше TAP не отдаёт.
  const int MAX_FRAME = 2048;

  static IntPtr handle = IntPtr.Zero;

  static void Log(string s) { Console.Error.WriteLine(s); Console.Error.Flush(); }

  /// <summary>
  /// Поток ошибок — в UTF-8.
  ///
  /// По умолчанию .NET пишет туда в кодировке консоли (на русской Windows
  /// это CP866), и читающая сторона получает мусор вместо слов. Поток
  /// вывода при этом трогать нельзя ни в коем случае: там кадры, и любая
  /// перекодировка их испортит.
  /// </summary>
  static void UseUtf8OnStderr() {
    var w = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false));
    w.AutoFlush = true;
    Console.SetError(w);
  }

  /// <summary>Поднять или опустить адаптер: без этого он «кабель не подключён».</summary>
  static bool SetMedia(IntPtr h, bool up) {
    byte[] v = BitConverter.GetBytes(up ? 1u : 0u);
    uint ret;
    return DeviceIoControl(h, TAP_IOCTL_SET_MEDIA_STATUS, v, 4, v, 4, out ret, IntPtr.Zero);
  }

  /// <summary>Читает ровно нужное число байт или возвращает false при конце потока.</summary>
  static bool ReadExact(Stream s, byte[] buf, int count) {
    int done = 0;
    while (done < count) {
      int n = s.Read(buf, done, count - done);
      if (n <= 0) return false;
      done += n;
    }
    return true;
  }

  /// <summary>Из адаптера в поток вывода: длина двумя байтами, затем кадр.</summary>
  static void DeviceToPipe(FileStream dev, Stream output) {
    byte[] frame = new byte[MAX_FRAME];
    byte[] header = new byte[2];
    while (true) {
      int n;
      try { n = dev.Read(frame, 0, MAX_FRAME); }
      catch (Exception e) { Log("чтение из адаптера прервано: " + e.Message); return; }
      if (n <= 0) return;

      header[0] = (byte)(n >> 8);
      header[1] = (byte)(n & 0xFF);
      lock (output) {
        output.Write(header, 0, 2);
        output.Write(frame, 0, n);
        output.Flush();
      }
    }
  }

  /// <summary>Из потока ввода в адаптер. Кадр не по размеру — обрываем связь.</summary>
  static void PipeToDevice(Stream input, FileStream dev) {
    byte[] header = new byte[2];
    byte[] frame = new byte[MAX_FRAME];
    while (true) {
      if (!ReadExact(input, header, 2)) return;
      int len = (header[0] << 8) | header[1];
      if (len <= 0 || len > MAX_FRAME) {
        Log("кадр недопустимой длины " + len + " — обмен прекращён");
        return;
      }
      if (!ReadExact(input, frame, len)) return;
      try { dev.Write(frame, 0, len); dev.Flush(); }
      catch (Exception e) { Log("запись в адаптер не удалась: " + e.Message); return; }
    }
  }

  public static int Run(string guid) {
    UseUtf8OnStderr();
    string clean = guid.Replace("{", "").Replace("}", "");
    string path = "\\\\.\\Global\\{" + clean + "}.tap";

    handle = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, IntPtr.Zero,
      OPEN_EXISTING, FILE_ATTRIBUTE_SYSTEM | FILE_FLAG_OVERLAPPED, IntPtr.Zero);

    if (handle == new IntPtr(-1)) {
      Log("не удалось открыть " + path + ", код Win32: " + Marshal.GetLastWin32Error());
      return 2;
    }
    if (!SetMedia(handle, true)) {
      Log("адаптер не поднялся, код Win32: " + Marshal.GetLastWin32Error());
      return 3;
    }
    // Признак готовности — латиницей: по нему приложение понимает, что
    // посредник запустился, и он не должен зависеть от кодировки.
    Log("RELAY-READY адаптер поднят, посредник готов");

    // Устройство открыто с FILE_FLAG_OVERLAPPED, поэтому FileStream создаётся
    // асинхронным: иначе .NET считает handle синхронным и чтение с записью
    // начинают мешать друг другу.
    var safe = new SafeFileHandle(handle, false);
    using (var dev = new FileStream(safe, FileAccess.ReadWrite, MAX_FRAME, true)) {
      var output = Console.OpenStandardOutput();
      var input = Console.OpenStandardInput();

      // Направления независимы, и каждое блокируется само по себе —
      // отсюда два потока, а не один цикл с опросом.
      var up = new Thread(() => DeviceToPipe(dev, output)); up.IsBackground = true;
      var down = new Thread(() => PipeToDevice(input, dev)); down.IsBackground = true;
      up.Start(); down.Start();

      // Достаточно, чтобы отвалилось одно направление: связь всё равно
      // наполовину мертва, а приложение поднимет посредника заново.
      while (up.IsAlive && down.IsAlive) Thread.Sleep(50);
    }

    SetMedia(handle, false);
    Log("посредник завершён, адаптер опущен");
    return 0;
  }
}
'@

Add-Type -TypeDefinition $source -ErrorAction Stop
exit [TapRelay]::Run($Guid)
