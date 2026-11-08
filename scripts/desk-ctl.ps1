# dsh-session-clean — 桌面浮窗的外部开关（不依赖 GUI，任何状态都能用）
#
#   desk-ctl.ps1 status      输出 JSON：{running, pids, window, title, port}
#   desk-ctl.ps1 start       没有就启动一个
#   desk-ctl.ps1 stop        杀掉所有浮窗进程
#   desk-ctl.ps1 restart     重启
#   desk-ctl.ps1 toggle      有则停，无则起
#
# 设计要点：
#  - 只按 CommandLine 匹配 desk-window.ps1，绝不按进程名误杀别的 PowerShell
#  - stop 同时清理 recall 信号，避免下次启动被旧信号触发
#  - status 永远是只读的，可以随便轮询
#
# Encoding: UTF-8 with BOM (Windows PowerShell 5.1 需要它来正确读中文)

param(
    [Parameter(Position = 0)]
    [ValidateSet('status', 'start', 'stop', 'restart', 'toggle')]
    [string]$Action = 'status',
    [string]$DsHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' })
)

$ErrorActionPreference = 'Stop'

# stdout 必须是 UTF-8，否则宿主读到的是 GBK，中文名会乱码
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$script:here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $script:here 'desk-window.vbs'
$main = Join-Path $script:here 'desk-window.ps1'
$infoFile = Join-Path $DsHome 'session-clean\desk.json'
$posFile = Join-Path $DsHome 'session-clean\desk-window.json'
$recallFile = Join-Path $DsHome 'session-clean\desk-recall.txt'
$desiredFile = Join-Path $DsHome 'session-clean\desk-desired.json'
$heartbeatFile = Join-Path $DsHome 'session-clean\desk-heartbeat.txt'

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DeskCtlNative {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    public static string VisibleTitles() {
        var sb = new StringBuilder();
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h)) return true;
            var t = new StringBuilder(256);
            GetWindowTextW(h, t, 256);
            var s = t.ToString();
            if (s.Length > 0) sb.Append(s).Append('\n');
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }
}
"@

function Set-Desired([string]$value) {
    try {
        $dir = Split-Path -Parent $desiredFile
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        # 原子写：宿主随时在读这个文件，写半截会被误判成「要运行」
        $tmp = $desiredFile + '.tmp'
        @{ desired = $value; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } |
            ConvertTo-Json -Compress | Set-Content -Path $tmp -Encoding UTF8
        Move-Item -Path $tmp -Destination $desiredFile -Force
    } catch { }
}
function Get-DeskProcesses {
    try {
        return @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like '*desk-window.ps1*' })
    } catch {
        return @()
    }
}

function Get-DeskTitle {
    $t = 'DSH 当前对话'
    try {
        if (Test-Path $posFile) {
            $p = Get-Content -Raw -Path $posFile | ConvertFrom-Json
            if ($p.title -is [string] -and $p.title.Trim().Length -gt 0) { $t = $p.title.Trim() }
        }
    } catch { }
    return $t
}

function Get-DeskPort {
    try {
        if (Test-Path $infoFile) {
            $i = Get-Content -Raw -Path $infoFile | ConvertFrom-Json
            if ($i.port) { return [int]$i.port }
        }
    } catch { }
    return 0
}

function Stop-Desk {
    $procs = Get-DeskProcesses
    foreach ($p in $procs) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
    }
    try { if (Test-Path $recallFile) { Remove-Item $recallFile -Force -ErrorAction SilentlyContinue } } catch { }
    # 心跳也要删：否则宿主会以为它还活着，导致「关掉后再添加」不会自动重开
    try { if (Test-Path $heartbeatFile) { Remove-Item $heartbeatFile -Force -ErrorAction SilentlyContinue } } catch { }
    return @($procs).Count
}

function Start-Desk {
    Set-Desired 'running'
    if (-not (Test-Path $vbs)) { return $false }
    try {
        Start-Process -FilePath 'wscript.exe' -ArgumentList ('"{0}"' -f $vbs) -WindowStyle Hidden
        return $true
    } catch {
        return $false
    }
}

function Get-Status {
    $procs = Get-DeskProcesses
    $title = Get-DeskTitle
    $titles = ''
    try { $titles = [DeskCtlNative]::VisibleTitles() } catch { }
    $visible = $false
    if ($title -and $titles) {
        foreach ($line in ($titles -split "`n")) {
            if ($line.Trim() -eq $title) { $visible = $true; break }
        }
    }
    return [ordered]@{
        ok = $true
        action = 'status'
        running = (@($procs).Count -gt 0)
        pids = @($procs | ForEach-Object { $_.ProcessId })
        window = $visible
        title = $title
        port = Get-DeskPort
        script = $main
    }
}

switch ($Action) {
    'status' {
        $s = Get-Status
        $s | ConvertTo-Json -Compress -Depth 4
    }
    'stop' {
        Set-Desired 'stopped'
        $n = Stop-Desk
        [ordered]@{ ok = $true; action = 'stop'; killed = $n; running = $false } | ConvertTo-Json -Compress
    }
    'start' {
        Set-Desired 'running'
        if (@(Get-DeskProcesses).Count -gt 0) {
            [ordered]@{ ok = $true; action = 'start'; started = $false; reason = 'already-running' } | ConvertTo-Json -Compress
        } else {
            $ok = Start-Desk
            Start-Sleep -Milliseconds 1200
            $s = Get-Status
            [ordered]@{ ok = $ok; action = 'start'; started = $ok; running = $s.running; window = $s.window; pids = $s.pids } | ConvertTo-Json -Compress -Depth 4
        }
    }
    'restart' {
        [void](Stop-Desk)
        Start-Sleep -Milliseconds 800
        $ok = Start-Desk
        Start-Sleep -Milliseconds 1500
        $s = Get-Status
        [ordered]@{ ok = $ok; action = 'restart'; running = $s.running; window = $s.window; pids = $s.pids } | ConvertTo-Json -Compress -Depth 4
    }
    'toggle' {
        if (@(Get-DeskProcesses).Count -gt 0) {
            Set-Desired 'stopped'
            $n = Stop-Desk
            [ordered]@{ ok = $true; action = 'toggle'; running = $false; killed = $n } | ConvertTo-Json -Compress
        } else {
            $ok = Start-Desk
            Start-Sleep -Milliseconds 1200
            $s = Get-Status
            [ordered]@{ ok = $ok; action = 'toggle'; running = $s.running; window = $s.window; pids = $s.pids } | ConvertTo-Json -Compress -Depth 4
        }
    }
}
