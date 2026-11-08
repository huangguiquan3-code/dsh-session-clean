# Toggle DeepSeek Harness autostart for the current user (HKCU Run).
# ASCII-only on purpose: Windows PowerShell 5.1 misreads BOM-less UTF-8.
#
#   powershell -ExecutionPolicy Bypass -File autostart.ps1 status
#   powershell -ExecutionPolicy Bypass -File autostart.ps1 on
#   powershell -ExecutionPolicy Bypass -File autostart.ps1 off
#
# Writes one per-user registry value only; no app files are touched.

param([ValidateSet('on', 'off', 'status')][string]$Action = 'status')

$ErrorActionPreference = 'Stop'

$exe = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$name = 'DeepSeek Harness'

function Get-Current {
    $item = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $null }
    $prop = $item.PSObject.Properties[$name]
    if ($null -eq $prop) { return $null }
    return [string]$prop.Value
}

if ($Action -eq 'on') {
    if (-not (Test-Path $exe)) { throw "App not found: $exe" }
    Set-ItemProperty -Path $key -Name $name -Value ('"' + $exe + '"') -Type String
    Write-Output ("autostart: ON -> {0}" -f $exe)
}
elseif ($Action -eq 'off') {
    Remove-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue
    Write-Output 'autostart: OFF'
}
else {
    $value = Get-Current
    if ($value) { Write-Output ("autostart: ON -> {0}" -f $value) }
    else { Write-Output 'autostart: OFF' }
}
