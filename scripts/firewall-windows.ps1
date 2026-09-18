<#
.SYNOPSIS
    Правила брандмауэра для Net Device Share.

.DESCRIPTION
    Открывает три порта, нужных для работы приложения:
      47811/UDP — обнаружение узлов;
      47812/TCP — каталог устройств и учёт занятости;
       3240/TCP — данные USB/IP.

    Правило для 3240 обычно создаёт установщик usbipd-win. Скрипт проверяет
    это и заводит своё правило, только если чужого нет.

    Правила создаются только для профилей Domain и Private. Профиль Public
    намеренно пропущен: раздавать USB в открытой сети — не то, что стоит
    включать по умолчанию.

.PARAMETER Remove
    Удалить ранее созданные правила.

.PARAMETER DiscoveryPort
    Порт обнаружения, если он изменён при запуске приложения.

.PARAMETER ApiPort
    Порт HTTP API, если он изменён при запуске приложения.

.PARAMETER UsbipPort
    Порт данных USB/IP. Задан протоколом, менять почти никогда не нужно.

.PARAMETER SkipUsbip
    Не трогать правило для порта 3240 — например, если оно уже создано
    другим средством и управляется отдельно.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\firewall-windows.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\firewall-windows.ps1 -Remove
#>

[CmdletBinding()]
param(
    [switch] $Remove,
    [int] $DiscoveryPort = 47811,
    [int] $ApiPort = 47812,
    [int] $UsbipPort = 3240,
    [switch] $SkipUsbip
)

$ErrorActionPreference = 'Stop'

$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin   = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host ''
    Write-Host '  Нужны права администратора. Запустите PowerShell от имени администратора.' -ForegroundColor Yellow
    Write-Host ''
    exit 1
}

$rules = @(
    @{ Name = 'Net Device Share - обнаружение (UDP)'; Protocol = 'UDP'; Port = $DiscoveryPort },
    @{ Name = 'Net Device Share - каталог и занятость (TCP)'; Protocol = 'TCP'; Port = $ApiPort }
)

# Порт данных USB/IP обычно открывает установщик usbipd-win. Своё правило
# заводим только если чужого нет: два правила на один порт работают, но
# сбивают с толку при разборе проблем с сетью.
if (-not $SkipUsbip -and -not $Remove) {
    $foreign = @()
    try {
        $foreign = Get-NetFirewallPortFilter |
            Where-Object { $_.Protocol -eq 'TCP' -and $_.LocalPort -eq $UsbipPort } |
            Get-NetFirewallRule |
            Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.DisplayName -notlike 'Net Device Share*' }
    } catch {
        Write-Host "  не удалось проверить правила для порта $($UsbipPort): $($_.Exception.Message)" -ForegroundColor Yellow
    }

    if ($foreign) {
        Write-Host "  порт TCP/$UsbipPort уже открыт правилом '$($foreign[0].DisplayName)' - своё не создаём" -ForegroundColor DarkGray
    } else {
        $rules += @{ Name = 'Net Device Share - данные USB/IP (TCP)'; Protocol = 'TCP'; Port = $UsbipPort }
    }
} elseif ($Remove) {
    # При удалении чистим и его - вдруг оно было создано прошлым запуском.
    $rules += @{ Name = 'Net Device Share - данные USB/IP (TCP)'; Protocol = 'TCP'; Port = $UsbipPort }
}

# Проект раньше назывался USB Net Share. Правила под старым именем остались бы
# в брандмауэре навсегда: имя правила — это его идентификатор, и новое имя
# старое не заменяет.
foreach ($stale in @('USB Net Share - обнаружение (UDP)',
                     'USB Net Share - каталог и занятость (TCP)',
                     'USB Net Share - данные USB/IP (TCP)')) {
    if (Get-NetFirewallRule -DisplayName $stale -ErrorAction SilentlyContinue) {
        Remove-NetFirewallRule -DisplayName $stale
        Write-Host "  удалено устаревшее правило: $stale" -ForegroundColor DarkGray
    }
}

foreach ($rule in $rules) {
    $existing = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue

    if ($Remove) {
        if ($existing) {
            Remove-NetFirewallRule -DisplayName $rule.Name
            Write-Host "  удалено:  $($rule.Name)" -ForegroundColor DarkGray
        } else {
            Write-Host "  нет такого правила: $($rule.Name)" -ForegroundColor DarkGray
        }
        continue
    }

    # Пересоздаём, а не правим: порт мог измениться с прошлого запуска.
    if ($existing) { Remove-NetFirewallRule -DisplayName $rule.Name }

    New-NetFirewallRule `
        -DisplayName $rule.Name `
        -Description 'Net Device Share: общий доступ к USB-устройствам по сети' `
        -Direction Inbound `
        -Action Allow `
        -Protocol $rule.Protocol `
        -LocalPort $rule.Port `
        -Profile Domain, Private `
        -Enabled True | Out-Null

    Write-Host "  открыт $($rule.Protocol)/$($rule.Port)  —  $($rule.Name)" -ForegroundColor Green
}

Write-Host ''
if ($Remove) {
    Write-Host '  Правила удалены.' -ForegroundColor Cyan
} else {
    Write-Host '  Готово. Те же правила нужны на КАЖДОМ компьютере сети.' -ForegroundColor Cyan
}
Write-Host ''
