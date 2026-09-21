param([string]$Guid, [string]$LogPath)

# Пишем по шагам, а не в конце: если что-то упадёт, надо знать, где именно.
function Say($s) { Add-Content -Path $LogPath -Value $s -Encoding UTF8 }

Set-Content -Path $LogPath -Value 'начало' -Encoding UTF8

try {
  $code = @'
using System;
using System.Runtime.InteropServices;
public static class TapProbe {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share,
    IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool DeviceIoControl(IntPtr h, uint code, byte[] inb, uint inl,
    byte[] outb, uint outl, out uint ret, IntPtr ov);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool WriteFile(IntPtr h, byte[] buf, uint len, out uint written, IntPtr ov);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr h);

  public const uint GENERIC_READ  = 0x80000000;
  public const uint GENERIC_WRITE = 0x40000000;
  public const uint OPEN_EXISTING = 3;
  public const uint FILE_ATTRIBUTE_SYSTEM = 0x4;
  public const uint GET_MAC          = 0x220004;
  public const uint GET_VERSION      = 0x220008;
  public const uint SET_MEDIA_STATUS = 0x220018;

  public static int LastError() { return Marshal.GetLastWin32Error(); }
  public static IntPtr Invalid() { return new IntPtr(-1); }
}
'@
  Add-Type -TypeDefinition $code -ErrorAction Stop
  Say 'P/Invoke: скомпилировано'

  $clean = $Guid.Replace('{','').Replace('}','')
  $path = '\\.\Global\{' + $clean + '}.tap'
  Say ('устройство: ' + $path)

  $access = [uint32]([TapProbe]::GENERIC_READ -bor [TapProbe]::GENERIC_WRITE)
  $h = [TapProbe]::CreateFileW($path, $access, [uint32]0, [IntPtr]::Zero,
    [TapProbe]::OPEN_EXISTING, [TapProbe]::FILE_ATTRIBUTE_SYSTEM, [IntPtr]::Zero)

  if ($h -eq [TapProbe]::Invalid()) {
    Say ('ОТКРЫТЬ НЕ УДАЛОСЬ, код Win32: ' + [TapProbe]::LastError())
  } else {
    Say 'открыто'
    $ret = [uint32]0

    $ver = New-Object byte[] 12
    if ([TapProbe]::DeviceIoControl($h, [TapProbe]::GET_VERSION, $null, [uint32]0, $ver, [uint32]12, [ref]$ret, [IntPtr]::Zero)) {
      Say ('версия драйвера: ' + [BitConverter]::ToUInt32($ver,0) + '.' + [BitConverter]::ToUInt32($ver,4))
    } else { Say ('GET_VERSION не удался, код ' + [TapProbe]::LastError()) }

    $mac = New-Object byte[] 6
    if ([TapProbe]::DeviceIoControl($h, [TapProbe]::GET_MAC, $null, [uint32]0, $mac, [uint32]6, [ref]$ret, [IntPtr]::Zero)) {
      Say ('MAC адаптера: ' + (($mac | ForEach-Object { $_.ToString('X2') }) -join '-'))
    } else { Say ('GET_MAC не удался, код ' + [TapProbe]::LastError()) }

    $on = [BitConverter]::GetBytes([uint32]1)
    if ([TapProbe]::DeviceIoControl($h, [TapProbe]::SET_MEDIA_STATUS, $on, [uint32]4, $on, [uint32]4, [ref]$ret, [IntPtr]::Zero)) {
      Say 'SET_MEDIA_STATUS(1): успех'
    } else { Say ('SET_MEDIA_STATUS не удался, код ' + [TapProbe]::LastError()) }

    Start-Sleep -Seconds 2
    $a = Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceGuid -match $clean }
    if ($a) { Say ('статус адаптера теперь: ' + $a.Status + ', скорость ' + $a.LinkSpeed) }
    else { Say 'адаптер по GUID не найден' }

    # Кадр наружу: широковещательный ARP. Принимать его сейчас некому —
    # моста ещё нет, — но записать в устройство драйвер обязан.
    $frame = New-Object byte[] 42
    for ($i = 0; $i -lt 6; $i++) { $frame[$i] = [byte]0xFF }
    [Array]::Copy($mac, 0, $frame, 6, 6)
    $frame[12] = [byte]0x08; $frame[13] = [byte]0x06
    $frame[15] = [byte]0x01
    $frame[16] = [byte]0x08
    $frame[18] = [byte]6; $frame[19] = [byte]4; $frame[21] = [byte]1
    [Array]::Copy($mac, 0, $frame, 22, 6)

    $written = [uint32]0
    if ([TapProbe]::WriteFile($h, $frame, [uint32]42, [ref]$written, [IntPtr]::Zero)) {
      Say ('запись кадра: успех, байт ' + $written)
    } else { Say ('запись кадра не удалась, код ' + [TapProbe]::LastError()) }

    $off = [BitConverter]::GetBytes([uint32]0)
    [void][TapProbe]::DeviceIoControl($h, [TapProbe]::SET_MEDIA_STATUS, $off, [uint32]4, $off, [uint32]4, [ref]$ret, [IntPtr]::Zero)
    [void][TapProbe]::CloseHandle($h)
    Say 'адаптер опущен обратно, устройство закрыто'
  }
} catch {
  Say ('ИСКЛЮЧЕНИЕ: ' + $_.Exception.GetType().Name + ' — ' + $_.Exception.Message)
  Say ($_.ScriptStackTrace)
}

Say 'конец'
