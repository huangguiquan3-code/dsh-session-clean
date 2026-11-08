# dsh-session-clean — desktop desk window (WinForms, DPI-aware).
#
# Mirrors the in-client dock: header / list / footer, one row per pinned chat,
# status dot + title + workspace line, hover highlight, fixed hit area for the
# remove button, collapsed capsule, theme tokens synced from the web client.
#
#   click row    -> POST /session-clean/desk-open + bring DSH to the front
#   click x      -> POST /session-clean/desk-remove
#   drag header  -> move (saved), double-click header or "–" -> fold
#   right-click  -> theme / density / motion / refresh / exit
#
# Flags: -Snapshot <png> renders once and exits (visual checks).
# Encoding: UTF-8 with BOM (Windows PowerShell 5.1 needs it for non-ASCII).

param(
    [string]$DsHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
    [string]$ProcessName = 'DeepSeek Harness',
    [string]$Snapshot = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Microsoft.VisualBasic
[System.Windows.Forms.Application]::EnableVisualStyles()

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class DeskNative {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)] public static extern int SetWindowTheme(IntPtr hWnd, string subApp, string subId);
    [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr hmon, int dpiType, out uint dpiX, out uint dpiY);
    [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@

# ---------------- DPI ----------------
# 必须在创建任何窗口之前声明，否则窗口先按 96dpi 画好再被系统拉伸 = 糊。
$global:dpiAware = 'none'
try { if ([DeskNative]::SetProcessDpiAwarenessContext([IntPtr](-4))) { $global:dpiAware = 'per-monitor-v2' } } catch { }
if ($global:dpiAware -eq 'none') {
    try { if ([DeskNative]::SetProcessDpiAwareness(2) -eq 0) { $global:dpiAware = 'per-monitor' } } catch { }
}
if ($global:dpiAware -eq 'none') {
    try { if ([DeskNative]::SetProcessDPIAware()) { $global:dpiAware = 'system' } } catch { }
}

$global:dpi = 96
$global:scale = 1.0
$global:dwmFrame = 'pending'

function L([double]$logical) { return [int][Math]::Round($logical * $global:scale) }
# （GetDpiForSystem / DeviceDpi 在 wscript 启动的进程里都不可信）
function Measure-Scale {
    $probe = $null
    try {
        $probe = New-Object System.Windows.Forms.Form
        $probe.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
        $probe.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
        $probe.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
        $b = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        $probe.Left = $b.Right - 200
        $probe.Top = $b.Bottom - 200
        $probe.Width = 100
        $probe.Height = 100
        $probe.ShowInTaskbar = $false
        $probe.Show()
        $null = $probe.Handle
        Start-Sleep -Milliseconds 120
        $r = New-Object DeskNative+RECT
        if ([DeskNative]::GetWindowRect($probe.Handle, [ref]$r)) {
            $w = $r.R - $r.L
            $h = $r.B - $r.T
            $s = [Math]::Round($w / 100.0, 3)
            if ($s -gt 0.5 -and $s -lt 4) { return $s }
        }
    } catch { } finally {
        try { if ($probe) { $probe.Close(); $probe.Dispose() } } catch { }
    }
    return $global:scale
}
# Win11 原生圆角 + 边框：由 DWM 绘制，任何 DPI 下都连续，也不会被子控件遮挡。
# 33 = DWMWA_WINDOW_CORNER_PREFERENCE(2=ROUND)，34 = DWMWA_BORDER_COLOR(COLORREF 0x00BBGGRR)
function Apply-DwmFrame {
    try {
        $v = 2
        $r1 = [DeskNative]::DwmSetWindowAttribute($form.Handle, 33, [ref]$v, 4)
        $c = (C 'text')
        # COLORREF: 0x00BBGGRR
        $rgb = [int]($c.R -bor ($c.G -shl 8) -bor ($c.B -shl 16))
        $r2 = [DeskNative]::DwmSetWindowAttribute($form.Handle, 34, [ref]$rgb, 4)
        if ($r1 -eq 0 -and $r2 -eq 0) { $global:dwmFrame = 'ok' } else { $global:dwmFrame = "partial($r1,$r2)" }
    } catch {
        $global:dwmFrame = 'unavailable'
    }
}
# 启动/同步日志：只记状态与计数，不记对话正文
function Write-DeskLog([string]$msg) {
    try {
        $f = Join-Path $DsHome 'session-clean\desk-run.log'
        $line = '{0} pid={1} {2}' -f (Get-Date -Format 'HH:mm:ss'), $PID, $msg
        Add-Content -Path $f -Value $line -Encoding UTF8
        if (Test-Path $f) {
            $all = @(Get-Content -Path $f -Encoding UTF8)
            if ($all.Count -gt 400) { $all[-200..-1] | Set-Content -Path $f -Encoding UTF8 }
        }
    } catch { }
}
function Write-BootInfo {
    try {
        $f = Join-Path $DsHome 'session-clean\desk-boot.txt'
        $line = 'aware=' + $global:dpiAware + ' dpi=' + $global:dpi + ' scale=' + [Math]::Round($global:scale, 3) + ' at=' + (Get-Date -Format 'HH:mm:ss')
        Add-Content -Path $f -Value $line -Encoding UTF8
    } catch { }
}

function New-Dot {
    $d = New-Object System.Windows.Forms.Label
    $d.Text = [char]0x25CF
    $d.AutoSize = $false
    $d.Width = L 10
    $d.Height = L 12
    $d.TextAlign = 'MiddleCenter'
    $d.Font = New-Object System.Drawing.Font('Segoe UI', 6)
    $d.BackColor = [System.Drawing.Color]::Transparent
    $d.ForeColor = (C 'dim')
    return $d
}


# single instance (snapshot mode is one-shot, so it skips the lock)
if (-not $Snapshot) {
    $global:createdNew = $false
    $global:mutex = [System.Threading.Mutex]::new($true, 'Local\DshSessionCleanDeskWindow', [ref]$global:createdNew)
    if (-not $global:createdNew) {
        # 已有实例：只写召回信号（旧实例会回屏内并前置），本进程立即退出。
        # 这里绝不杀旧进程——两个进程同时抢 mutex 时互杀，反而会留下多个窗口。
        try {
            $rc = Join-Path $DsHome 'session-clean\desk-recall.txt'
            $dd = Split-Path -Parent $rc
            if (-not (Test-Path $dd)) { New-Item -ItemType Directory -Path $dd -Force | Out-Null }
            [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() | Set-Content -Path $rc -Encoding UTF8
        } catch { }
        Start-Sleep -Milliseconds 250
        exit 0
    }
}

$global:infoFile = Join-Path $DsHome 'session-clean\desk.json'
$global:posFile = Join-Path $DsHome 'session-clean\desk-window.json'
$global:themeFile = Join-Path $DsHome 'session-clean\theme.json'
$global:errLog = Join-Path $DsHome 'session-clean\desk-window-error.log'

$global:items = @()
$global:signature = ''
$global:dragDiff = $null
$global:collapsed = $false
$global:rows = @{}
$global:themeStamp = 0
$global:lastRecall = 0L
$global:localCurrentId = ''
$global:prefs = @{ density = 'comfortable'; motion = 'soft'; topmost = $true }
$global:winTitle = 'DSH 当前对话'
# 状态机：boot / offline / sync-wait / empty / ready
$global:state = 'boot'

# ---------------- palette ----------------

$global:P = $null

function New-FallbackPalette {
    return @{
        bg      = '#171B24'
        surface = '#202633'
        surface2 = '#1B212B'
        hover   = '#293244'
        active  = '#2C3A52'
        text    = '#E7EBF3'
        dim     = '#AAB5C8'
        acc     = '#9BAEE8'
        acc2    = '#B5A6D8'
        border  = '#333D4E'
        ok      = '#7FC8A9'
        warn    = '#E3B778'
        err     = '#E08C8C'
    }
}

function Convert-HexColor([string]$value, [string]$fallback) {
    try {
        if ($value -match '^#([0-9a-fA-F]{6})$') { return [System.Drawing.ColorTranslator]::FromHtml($value) }
        if ($value -match '^#([0-9a-fA-F]{8})$') { return [System.Drawing.ColorTranslator]::FromHtml($value) }
        if ($value -match 'rgba?\(([^)]+)\)') {
            $parts = $Matches[1].Split(',')
            $r = [int][double]::Parse($parts[0].Trim(), [Globalization.CultureInfo]::InvariantCulture)
            $g = [int][double]::Parse($parts[1].Trim(), [Globalization.CultureInfo]::InvariantCulture)
            $b = [int][double]::Parse($parts[2].Trim(), [Globalization.CultureInfo]::InvariantCulture)
            $a = 255
            if ($parts.Count -ge 4) { $a = [int]([double]::Parse($parts[3].Trim(), [Globalization.CultureInfo]::InvariantCulture) * 255) }
            return [System.Drawing.Color]::FromArgb($a, $r, $g, $b)
        }
    } catch { }
    return [System.Drawing.ColorTranslator]::FromHtml($fallback)
}

function Set-Palette($theme) {
    if ($null -eq $global:P) {
        $safe = @{}
        $safe.bg = [System.Drawing.Color]::FromArgb(23, 27, 36)
        $safe.surface = [System.Drawing.Color]::FromArgb(32, 38, 51)
        $safe.surface2 = [System.Drawing.Color]::FromArgb(27, 33, 43)
        $safe.hover = [System.Drawing.Color]::FromArgb(41, 50, 68)
        $safe.active = [System.Drawing.Color]::FromArgb(44, 58, 82)
        $safe.text = [System.Drawing.Color]::FromArgb(231, 235, 243)
        $safe.dim = [System.Drawing.Color]::FromArgb(170, 181, 200)
        $safe.acc = [System.Drawing.Color]::FromArgb(155, 174, 232)
        $safe.acc2 = [System.Drawing.Color]::FromArgb(181, 166, 216)
        $safe.border = [System.Drawing.Color]::FromArgb(80, 90, 108)
        $safe.ok = [System.Drawing.Color]::FromArgb(127, 200, 169)
        $safe.warn = [System.Drawing.Color]::FromArgb(227, 183, 120)
        $safe.err = [System.Drawing.Color]::FromArgb(224, 140, 140)
        $safe.head = [System.Drawing.Color]::FromArgb(40, 46, 60)
        $safe.foot = [System.Drawing.Color]::FromArgb(23, 27, 36)
        $global:P = $safe
    }
    $raw = New-FallbackPalette
    if ($null -ne $theme -and $null -ne $theme.palette) {
        foreach ($k in @('bg', 'surface', 'surface2', 'hover', 'active', 'text', 'dim', 'acc', 'acc2', 'border', 'ok', 'warn', 'err')) {
            $v = $theme.palette.$k
            if ($null -ne $v) { $raw[$k] = [string]$v }
        }
    }
    $pal = @{}
    $pal.bg = Convert-HexColor $raw.bg '#171B24'
    $pal.surface = Convert-HexColor $raw.surface '#202633'
    $pal.surface2 = Convert-HexColor $raw.surface2 '#1B212B'
    $pal.hover = Convert-HexColor $raw.hover '#293244'
    $pal.active = Convert-HexColor $raw.active '#2C3A52'
    $pal.text = Convert-HexColor $raw.text '#E7EBF3'
    $pal.dim = Convert-HexColor $raw.dim '#AAB5C8'
    $pal.acc = Convert-HexColor $raw.acc '#9BAEE8'
    $pal.acc2 = Convert-HexColor $raw.acc2 '#B5A6D8'
    $pal.border = Convert-HexColor $raw.border '#333D4E'
    $pal.ok = Convert-HexColor $raw.ok '#7FC8A9'
    $pal.warn = Convert-HexColor $raw.warn '#E3B778'
    $pal.err = Convert-HexColor $raw.err '#E08C8C'
    # 边框：如果 palette 给的是高透明 rgba，UI 上会看不见，这里保底提亮
    if ($null -ne $pal.border -and $pal.border.A -lt 60) {
        $pal.border = [System.Drawing.Color]::FromArgb(110, $pal.text.R, $pal.text.G, $pal.text.B)
    }
    # head/foot 用内联混色，避免依赖函数调用顺序
    $pal.head = [System.Drawing.Color]::FromArgb(255,
        [Math]::Min(255, $pal.surface.R + 7), [Math]::Min(255, $pal.surface.G + 7), [Math]::Min(255, $pal.surface.B + 10))
    $pal.foot = [System.Drawing.Color]::FromArgb(255,
        [Math]::Max(0, $pal.surface2.R - 4), [Math]::Max(0, $pal.surface2.G - 4), [Math]::Max(0, $pal.surface2.B - 4))
    # 兜底：任何键为空都会在赋值时抛「空值转 Color」
    foreach ($k in @('bg', 'surface', 'surface2', 'hover', 'active', 'text', 'dim', 'acc', 'acc2', 'border', 'ok', 'warn', 'err', 'head', 'foot')) {
        if ($null -eq $pal[$k]) { $pal[$k] = [System.Drawing.Color]::FromArgb(200, 200, 200) }
    }
    $global:P = $pal
}

function Ensure-Palette {
    if ($null -eq $global:P) { Set-Palette $null }
}

# 关键：控件创建前必须先有调色板，否则第一处 BackColor 赋值就会抛「空值转 Color」
Set-Palette $null


function C([string]$name) {
    $v = $null
    try { if ($null -ne $global:P) { $v = $global:P[$name] } } catch { }
    if ($v -is [System.Drawing.Color]) { return $v }
    switch ($name) {
        'bg' { return [System.Drawing.Color]::FromArgb(23, 27, 36) }
        'surface' { return [System.Drawing.Color]::FromArgb(32, 38, 51) }
        'surface2' { return [System.Drawing.Color]::FromArgb(27, 33, 43) }
        'hover' { return [System.Drawing.Color]::FromArgb(41, 50, 68) }
        'active' { return [System.Drawing.Color]::FromArgb(44, 58, 82) }
        'text' { return [System.Drawing.Color]::FromArgb(231, 235, 243) }
        'dim' { return [System.Drawing.Color]::FromArgb(170, 181, 200) }
        'acc' { return [System.Drawing.Color]::FromArgb(155, 174, 232) }
        'acc2' { return [System.Drawing.Color]::FromArgb(181, 166, 216) }
        'border' { return [System.Drawing.Color]::FromArgb(80, 90, 108) }
        'ok' { return [System.Drawing.Color]::FromArgb(127, 200, 169) }
        'warn' { return [System.Drawing.Color]::FromArgb(227, 183, 120) }
        'err' { return [System.Drawing.Color]::FromArgb(224, 140, 140) }
        'head' { return [System.Drawing.Color]::FromArgb(40, 46, 60) }
        'foot' { return [System.Drawing.Color]::FromArgb(23, 27, 36) }
    }
    return [System.Drawing.Color]::FromArgb(32, 38, 51)
}
function Blend($c1, $c2, [double]$t) {
    $r = [int]($c1.R + ($c2.R - $c1.R) * $t)
    $g = [int]($c1.G + ($c2.G - $c1.G) * $t)
    $b = [int]($c1.B + ($c2.B - $c1.B) * $t)
    return [System.Drawing.Color]::FromArgb(255, $r, $g, $b)
}

# 关键：控件创建前必须先有调色板，否则第一处 BackColor 赋值就会抛「空值转 Color」
# (boot 诊断已关闭)
Set-Palette $null
# 再从 theme.json 补一次：DSH 重启后宿主内存里没有主题，浮窗自己也能读到，风格不会退回内置深色
try {
    if (Test-Path $global:themeFile) {
        $th = Get-Content -Raw -Path $global:themeFile | ConvertFrom-Json
        if ($th) { Set-Palette $th }
    }
} catch { }

# ---------------- data ----------------

function Get-Port {
    try {
        if (-not (Test-Path $global:infoFile)) { return 0 }
        $info = Get-Content -Raw -Path $global:infoFile | ConvertFrom-Json
        if ($info -and $info.port) { return [int]$info.port }
    } catch { }
    return 0
}

function Save-Prefs {
    try {
        $dir = Split-Path -Parent $global:posFile
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        @{
            left = $form.Left; top = $form.Top;
            collapsed = $global:collapsed;
            title = $global:winTitle;
            density = $global:prefs.density;
            motion = $global:prefs.motion;
            topmost = $global:prefs.topmost;
        } | ConvertTo-Json -Compress | Set-Content -Path $global:posFile -Encoding UTF8
    } catch { }
}

function Test-OnScreen([int]$x, [int]$y) {
    try {
        # 用矩形交集判断，而不是单点：多显示器之间有空隙，点判断会把「缝隙」当合法位置
        $w = [Math]::Max((L 120), $form.Width)
        $h = [Math]::Max((L 28), $form.Height)
        foreach ($s in [System.Windows.Forms.Screen]::AllScreens) {
            $wa = $s.WorkingArea
            $il = [Math]::Max($x, $wa.Left)
            $it = [Math]::Max($y, $wa.Top)
            $ir = [Math]::Min($x + $w, $wa.Right)
            $ib = [Math]::Min($y + $h, $wa.Bottom)
            if (($ir - $il) -ge (L 80) -and ($ib - $it) -ge (L 24)) { return $true }
        }
    } catch { }
    return $false
}

function Reset-Position {
    try {
        $b = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
        $form.Left = $b.Right - $form.Width - (L 24)
        $form.Top = $b.Bottom - $form.Height - (L 60)
        if ($form.Left -lt $b.Left) { $form.Left = $b.Left + (L 24) }
        if ($form.Top -lt $b.Top) { $form.Top = $b.Top + (L 24) }
        Save-Prefs
    } catch { }
}

function Restore-Prefs {
    try {
        if (Test-Path $global:posFile) {
            $p = Get-Content -Raw -Path $global:posFile | ConvertFrom-Json
            if ($p.title -is [string] -and $p.title.Trim().Length -gt 0) { $global:winTitle = $p.title.Trim() }
            if ($p.density -in @('compact', 'comfortable')) { $global:prefs.density = $p.density }
            if ($p.motion -in @('full', 'soft', 'off')) { $global:prefs.motion = $p.motion }
            if ($null -ne $p.topmost) { $global:prefs.topmost = [bool]$p.topmost }
            if ($null -ne $p.left -and $null -ne $p.top) {
                $lx = [int]$p.left
                $ty = [int]$p.top
                # 只有确实落在某块屏幕的可用区域内才恢复，否则复位（换显示器/改分辨率/拔屏后常见）
                if (Test-OnScreen $lx $ty) {
                    $form.Left = $lx
                    $form.Top = $ty
                } else {
                    Reset-Position
                }
                if ($p.collapsed) { $global:collapsed = [bool]$p.collapsed }
                return
            }
        }
    } catch { }
    Reset-Position
}

function Show-Dsh {
    try {
        $proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
        if ($null -eq $proc) { return }
        $h = $proc.MainWindowHandle
        if ([DeskNative]::IsIconic($h)) { [void][DeskNative]::ShowWindow($h, 9) }
        [void][DeskNative]::SetForegroundWindow($h)
    } catch { }
}

function Post-Json([string]$path, $payload) {
    $port = Get-Port
    if (-not $port) { return $false }
    try {
        $body = $payload | ConvertTo-Json -Compress
        Invoke-RestMethod -Method Post -Uri ("http://127.0.0.1:{0}{1}" -f $port, $path) `
            -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 3 | Out-Null
        return $true
    } catch { return $false }
}

# ---------------- window ----------------

$global:W = 300       # logical width, expanded
$global:ROW_H = 38    # logical row height, comfortable
$global:ROW_H_C = 28  # compact

$form = New-Object System.Windows.Forms.Form
$form.Text = $global:winTitle
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual

# 双缓冲：Paint 与子控件重绘不闪断（Form 的 DoubleBuffered 是 protected，用反射打开）
try {
    $dp = [System.Windows.Forms.Form].GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'NonPublic,Instance')
    if ($dp) { $dp.SetValue($form, $true, $null) }
} catch { }
$form.BackColor = (C 'surface')
# 关键：GetDpiForSystem 给的是「系统 DPI」，不等于窗口所在显示器的真实 DPI。
# AutoScaleMode 已关，这里用 GetDpiForSystem 的初值即可（不再叠加二次缩放）
$null = $form.Handle
# PerMonitor 进程里，GetDpiForMonitor(MDT_EFFECTIVE_DPI) 才是窗口所在显示器的真实 DPI；
# 拿不到才退回 GetDpiForWindow。这里必须是「按真实 DPI 排版 + 按像素绘制」，不能再让系统拉伸。
try {
    $mon = [DeskNative]::MonitorFromWindow($form.Handle, 2)
    $dx = 0
    $dy = 0
    if ([DeskNative]::GetDpiForMonitor($mon, 0, [ref]$dx, [ref]$dy) -eq 0 -and $dx -gt 0) {
        $global:dpi = [int]$dx
        $global:scale = [double]$dx / 96.0
    } else {
        $fd = [int][DeskNative]::GetDpiForWindow($form.Handle)
        if ($fd -gt 0) { $global:dpi = $fd; $global:scale = [double]$fd / 96.0 }
    }
} catch { }

$form.Width = L $global:W
$form.Height = L 160
$form.MinimumSize = New-Object System.Drawing.Size((L 88), (L 34))
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
# 关掉 WinForms 自动缩放：我们自己按实测比例排，否则会和 L() 叠成双重缩放
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None

function Set-Round($ctrl, [int]$radius) {
    try {
        if ($ctrl.Width -le 1 -or $ctrl.Height -le 1) { return }
        $d = $radius * 2
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $path.AddArc(0, 0, $d, $d, 180, 90)
        $path.AddArc($ctrl.Width - $d, 0, $d, $d, 270, 90)
        $path.AddArc($ctrl.Width - $d, $ctrl.Height - $d, $d, $d, 0, 90)
        $path.AddArc(0, $ctrl.Height - $d, $d, $d, 90, 90)
        $path.CloseFigure()
        $ctrl.Region = New-Object System.Drawing.Region($path)
    } catch { }
}

$form.Add_Paint({
    param($s, $e)
    try {
        $g = $e.Graphics
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $w = $form.Width
        $h = $form.Height
        if ($w -lt 8 -or $h -lt 8) { return }
        # （半径已在下面按 inset 计算，这行留空）
        # 描边与 Region 同心：Region 半径 = L14，描边内缩 2px 后半径取 L14-2，
        # 两者圆心重合，整条描边（含四角圆弧）才会稳稳落在裁剪区内、且与圆角平行。
        $inset = 2
        $rad = [Math]::Max(3, ([int](L 14)) - $inset)
        $d = $rad * 2
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $path.AddArc($inset, $inset, $d, $d, 180, 90)
        $path.AddArc(($w - $d - $inset), $inset, $d, $d, 270, 90)
        $path.AddArc(($w - $d - $inset), ($h - $d - $inset), $d, $d, 0, 90)
        $path.AddArc($inset, ($h - $d - $inset), $d, $d, 90, 90)
        $path.CloseFigure()
        # 边框改由 DWM 原生绘制（Apply-DwmFrame）：系统画的圆角与描边在任何 DPI 下都连续，
        # 不会被铺满的子控件盖住。DWM 不可用时才回退到这里的自绘描边。
        if ($global:dwmFrame -ne 'ok') {
            $bc = (C 'text')
            $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(210, $bc.R, $bc.G, $bc.B), 2)
            $g.DrawPath($pen, $path)
            $pen.Dispose()
        }
        $path.Dispose()
    } catch { }
})
# ---- header ----
$head = New-Object System.Windows.Forms.Panel
$head.Left = L 3; $head.Top = L 3; $head.Width = $form.Width - (L 3) - (L 5); $head.Height = L 40
$head.BackColor = (C 'head')
$head.Anchor = 'Top,Left,Right'
$form.Controls.Add($head)

$headDot = New-Dot
$headDot.Left = L 10; $headDot.Top = L 14
$headDot.ForeColor = (C 'dim')
$head.Controls.Add($headDot)

$title = New-Object System.Windows.Forms.Label
$title.Text = $global:winTitle
$title.AutoSize = $false
$title.Left = L 28; $title.Top = 0; $title.Height = L 40; $title.Width = L 120
$title.TextAlign = 'MiddleLeft'
$title.ForeColor = (C 'text')
$title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5, [System.Drawing.FontStyle]::Bold)
$title.BackColor = [System.Drawing.Color]::Transparent
$head.Controls.Add($title)

$countLbl = New-Object System.Windows.Forms.Label
$countLbl.Text = ''
$countLbl.AutoSize = $true
$countLbl.ForeColor = (C 'dim')
$countLbl.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 8.5)
$countLbl.BackColor = [System.Drawing.Color]::Transparent
$head.Controls.Add($countLbl)

function New-HeadButton([string]$glyph, [int]$rightOffset) {
    $b = New-Object System.Windows.Forms.Label
    $b.Text = $glyph
    $b.AutoSize = $false
    $b.Width = L 26; $b.Height = L 26
    $b.Top = L 7
    $b.Left = $head.Width - $rightOffset - (L 26)
    $b.TextAlign = 'MiddleCenter'
    $b.ForeColor = (C 'dim')
    $b.Font = New-Object System.Drawing.Font('Segoe UI', 10)
    $b.BackColor = [System.Drawing.Color]::Transparent
    $b.Cursor = [System.Windows.Forms.Cursors]::Hand
    $b.Anchor = 'Top,Right'
    $head.Controls.Add($b)
    return $b
}

$addBtn = New-HeadButton '+' 8
$foldBtn = New-HeadButton '-' 36
$closeBtn = New-HeadButton '×' 64

# ---- list ----
$list = New-Object System.Windows.Forms.Panel
$list.Left = L 6; $list.Top = L 44; $list.Width = $form.Width - (L 6) - (L 8); $list.Height = L 100
$list.BackColor = [System.Drawing.Color]::Transparent
        # 系统滚动条是浅色的，会破坏深色观感：改成「最多 7 行 + footer 提示剩余」
$list.Anchor = 'Top,Left,Right'
$form.Controls.Add($list)

# ---- footer ----

# 空状态：与列表共用同一块区域，靠 Visible 互斥切换（永远只有一份控件，不会残留）
$global:emptyLabel = New-Object System.Windows.Forms.Label
$global:emptyLabel.Text = ''
$global:emptyLabel.AutoSize = $false
$global:emptyLabel.Bounds = New-Object System.Drawing.Rectangle(0, 0, $list.Width, (L 50))
$global:emptyLabel.TextAlign = 'MiddleCenter'
$global:emptyLabel.ForeColor = (C 'dim')
$global:emptyLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 8.5)
$global:emptyLabel.BackColor = (C 'surface2')
$global:emptyLabel.Cursor = [System.Windows.Forms.Cursors]::Hand
$global:emptyLabel.Add_Click({ try { Show-Dsh } catch { } })
$list.Controls.Add($global:emptyLabel)
$foot = New-Object System.Windows.Forms.Panel
$foot.Left = L 3; $foot.Width = $form.Width - (L 3) - (L 5); $foot.Height = L 28
$foot.BackColor = (C 'foot')
$foot.Anchor = 'Bottom,Left,Right'
$form.Controls.Add($foot)

$footLeft = New-Object System.Windows.Forms.Label
$footLeft.Text = ''
$footLeft.AutoSize = $false
$footLeft.Left = L 12; $footLeft.Top = 0; $footLeft.Height = L 28; $footLeft.Width = L 180
$footLeft.TextAlign = 'MiddleLeft'
$footLeft.ForeColor = (C 'dim')
$footLeft.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 8)
$footLeft.BackColor = [System.Drawing.Color]::Transparent
$foot.Controls.Add($footLeft)

$footRight = New-Object System.Windows.Forms.Label
$footRight.Text = '打开面板'
$footRight.AutoSize = $false
$footRight.Height = L 28; $footRight.Width = L 64
$footRight.TextAlign = 'MiddleRight'
$footRight.ForeColor = (C 'acc')
$footRight.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 8)
$footRight.BackColor = [System.Drawing.Color]::Transparent
$footRight.Cursor = [System.Windows.Forms.Cursors]::Hand
$footRight.Anchor = 'Top,Right'
$foot.Controls.Add($footRight)

# ---- collapsed capsule ----
$mini = New-Object System.Windows.Forms.Panel
$mini.Bounds = New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)
$mini.BackColor = (C 'head')
$mini.Visible = $false
$form.Controls.Add($mini)

$miniDot = New-Dot
$miniDot.Left = L 10; $miniDot.Top = L 10
$miniDot.ForeColor = (C 'dim')
$mini.Controls.Add($miniDot)

$miniText = New-Object System.Windows.Forms.Label
$miniText.Text = $global:winTitle
$miniText.AutoSize = $false
$miniText.Left = L 26; $miniText.Top = 0; $miniText.Height = L 34; $miniText.Width = L 74
$miniText.TextAlign = 'MiddleLeft'
$miniText.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
# 关掉 WinForms 自动缩放：我们自己按实测比例排，否则会和 L() 叠成双重缩放

$miniText.BackColor = [System.Drawing.Color]::Transparent
$mini.Controls.Add($miniText)

$miniCount = New-Object System.Windows.Forms.Label
$miniCount.Text = '0'
$miniCount.AutoSize = $false
$miniCount.Height = L 34; $miniCount.Width = L 18
$miniCount.TextAlign = 'MiddleCenter'
$miniCount.ForeColor = (C 'acc')
$miniCount.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Bold)
$miniCount.BackColor = [System.Drawing.Color]::Transparent
$mini.Controls.Add($miniCount)

# ---------------- rows ----------------

function Get-RowHeight {
    if ($global:prefs.density -eq 'compact') { return L $global:ROW_H_C }
    return L $global:ROW_H
}

function New-Row($id, $titleText, $subText, $isCurrent) {
    $h = Get-RowHeight
    $panel = New-Object System.Windows.Forms.Panel
    $panel.Height = $h
    $panel.Width = $list.Width - (L 18)
    $panel.BackColor = if ($isCurrent) { (C 'active') } else { (C 'surface2') }
    $panel.Cursor = [System.Windows.Forms.Cursors]::Hand
    $panel.Tag = @{ id = $id; current = $isCurrent }

    $dot = New-Dot
    $dot.Left = L 8; $dot.Top = [int](($h - $dot.Height) / 2)
    $dot.ForeColor = (C 'dim')
    $panel.Controls.Add($dot)
    Set-Round $dot ([int]([Math]::Max(2, (($dot.Width) / 2))))
    # 当前会话的左侧细标记（不占标题空间）
    $bar = New-Object System.Windows.Forms.Panel
    $bar.Width = L 2
    $bar.Height = $h - (L 10)
    $bar.Left = 0
    $bar.Top = L 5
    $bar.BackColor = if ($isCurrent) { (C 'acc') } else { $panel.BackColor }
    $panel.Controls.Add($bar)

    $t = New-Object System.Windows.Forms.Label
    $t.Text = $titleText
    $t.AutoSize = $false
    $t.Left = L 24; $t.Top = if ($global:prefs.density -eq 'compact') { 0 } else { L 4 }
    $t.Height = if ($global:prefs.density -eq 'compact') { $h } else { L 18 }
    $t.Width = $panel.Width - (L 24) - (L 34)
    $t.TextAlign = if ($global:prefs.density -eq 'compact') { 'MiddleLeft' } else { 'TopLeft' }
    $t.ForeColor = (C 'text')
    $t.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
# 关掉 WinForms 自动缩放：我们自己按实测比例排，否则会和 L() 叠成双重缩放


    $t.AutoEllipsis = $true
    $t.Cursor = [System.Windows.Forms.Cursors]::Hand
    $panel.Controls.Add($t)

    $sub = $null
    if ($global:prefs.density -ne 'compact') {
        $sub = New-Object System.Windows.Forms.Label
        $sub.Text = $subText
        $sub.AutoSize = $false
        $sub.Left = L 24; $sub.Top = L 22; $sub.Height = L 14; $sub.Width = $t.Width
        $sub.TextAlign = 'TopLeft'
        $sub.ForeColor = (C 'dim')
        $sub.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 7.8)
        $sub.BackColor = [System.Drawing.Color]::Transparent
        $panel.Controls.Add($sub)
    }

    $del = New-Object System.Windows.Forms.Label
    $del.Text = '×'
    $del.AutoSize = $false
    $del.Width = L 22; $del.Height = L 22
    $del.Left = $panel.Width - (L 26); $del.Top = [int](($h - (L 22)) / 2)
    $del.TextAlign = 'MiddleCenter'
    $del.ForeColor = (C 'dim')
    $del.Font = New-Object System.Drawing.Font('Segoe UI', 9)
    $del.BackColor = [System.Drawing.Color]::Transparent
    $del.Cursor = [System.Windows.Forms.Cursors]::Hand
    $del.Visible = $false
    $del.Tag = $id
    $panel.Controls.Add($del)

    foreach ($c in @($panel, $t)) {
        $c.Add_MouseEnter({ param($s, $e) try {
            $row = if ($s -is [System.Windows.Forms.Panel]) { $s } else { $s.Parent }
            $row.BackColor = (Get-RowPalette).hover
            foreach ($cc in $row.Controls) { if ($cc -is [System.Windows.Forms.Label] -and $cc.Text -eq '×') { $cc.Visible = $true; $cc.ForeColor = (Get-RowPalette).err } }
        } catch { } })
        $c.Add_MouseLeave({ param($s, $e) try {
            $row = if ($s -is [System.Windows.Forms.Panel]) { $s } else { $s.Parent }
            if (-not $row.ClientRectangle.Contains($row.PointToClient([System.Windows.Forms.Cursor]::Position))) {
                $t = $row.Tag
                $row.BackColor = if ($t -is [hashtable] -and $t.current) { (Get-RowPalette).active } else { (Get-RowPalette).surface }
                foreach ($cc in $row.Controls) { if ($cc -is [System.Windows.Forms.Label] -and $cc.Text -eq '×') { $cc.Visible = $false } }
            }
        } catch { } })
        $c.Add_Click({ param($s, $e) try {
            $row = if ($s -is [System.Windows.Forms.Panel]) { $s } else { $s.Parent }
            $t = $row.Tag
            $id = if ($t -is [hashtable]) { [string]$t.id } else { [string]$t }
            if ($id) {
                Set-LocalCurrent $id
                [void](Post-Json '/session-clean/desk-open' @{ sessionId = $id })
                Show-Dsh
            }
        } catch { } })
    }

    $del.Add_Click({ param($s, $e) try {
        $id = [string]$s.Tag
        if ($id) { Post-Json '/session-clean/desk-remove' @{ sessionId = $id } }
    } catch { } })

    $list.Controls.Add($panel)
    return @{ panel = $panel; dot = $dot; title = $t; sub = $sub; del = $del }
}

# 点击后立刻本地高亮，不等宿主镜像回来（否则会「卡在原来位置」）
function Set-LocalCurrent([string]$id) {
    try {
        foreach ($it in $global:items) {
            if ($null -ne $it) { $it.current = ([string]$it.sessionId -eq $id) }
        }
        $global:localCurrentId = $id
        foreach ($k in @($global:rows.Keys)) {
            $r = $global:rows[$k]
            if ($null -eq $r) { continue }
            $isNow = ($k -eq $id)
            $t = $r.panel.Tag
            if ($t -is [hashtable]) { $t.current = $isNow; $r.panel.Tag = $t }
            $r.panel.BackColor = if ($isNow) { (C 'active') } else { (C 'surface2') }
        }
    } catch { }
}
function Get-RowPalette { return $global:P }

function Remove-AllRows {
    foreach ($k in @($global:rows.Keys)) {
        try { $global:rows[$k].panel.Dispose() } catch { }
    }
    $global:rows = @{}
    try { $list.Controls.Clear() } catch { }
}

# ---------------- layout ----------------

function Update-Layout {
    $rowH = Get-RowHeight
    $n = @($global:items).Count
    $maxRows = 7
    $visible = [Math]::Min([Math]::Max($n, 1), $maxRows)
    $listH = if ($n -eq 0) { L 54 } else { $visible * $rowH + (L 6) }
    $formW = L $global:W
    $formH = (L 44) + $listH + (L 28) + (L 6)

    if ($global:collapsed) {
        $form.Width = [Math]::Max((L 134), [Math]::Min((L 250), [int]($global:winTitle.Length * (L 15) + (L 56))))
        $form.Height = L 34
        Set-Round $form (L 12)
        Set-Round $mini (L 12)
        $head.Visible = $false; $list.Visible = $false; $foot.Visible = $false
        $mini.Visible = $true
        $mini.Bounds = New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)
        $miniCount.Left = $form.Width - (L 24)
        $miniText.Width = $form.Width - (L 56)
        return
    }

    $form.Width = $formW
    $form.Height = $formH
    $mini.Visible = $false
    $head.Visible = $true; $list.Visible = $true; $foot.Visible = $true

    $head.Width = $form.Width - (L 3) - (L 5)
    $list.Width = $form.Width - (L 6) - (L 8)
    $list.Height = $listH
    $list.Top = L 44
    $foot.Top = $form.Height - (L 28) - (L 3)
    $foot.Width = $form.Width - (L 3) - (L 5)
    $footLeft.Width = $form.Width - (L 92)
    $footRight.Left = $form.Width - (L 76) - (L 5) - (L 3)
    $countLbl.Left = $title.Left + $title.Width
    $countLbl.Top = L 12

    if ($global:dwmFrame -ne 'ok') { Set-Round $form (L 14) } else { $form.Region = $null }
    Set-Round $head (L 14)

    try {
        $f = Join-Path $DsHome 'session-clean\desk-boot.txt'
        Add-Content -Path $f -Value ('layout form=' + $form.Width + 'x' + $form.Height + ' list=' + $list.Height + ' n=' + @($global:items).Count + ' scale=' + [Math]::Round($global:scale, 2) + ' rowH=' + $rowH + ' dwm=' + $global:dwmFrame) -Encoding UTF8
    } catch { }
    # rows
    $shownCount = 0
    $y = 0
    foreach ($it in $global:items) {
        $r = $global:rows[[string]$it.sessionId]
        if ($null -eq $r) { continue }
        if ($shownCount -ge $maxRows) { $r.panel.Visible = $false; continue }
        $r.panel.Visible = $true
        $shownCount += 1
        $r.panel.Width = $list.Width - (L 18)
        $r.panel.Left = 0
        $r.panel.Top = $y
        $r.panel.Height = $rowH
        if ($null -ne $r.sub) {
            $r.title.Height = L 18
            $r.title.Top = L 4
            $r.title.TextAlign = 'TopLeft'
            $r.sub.Top = L 22
            $r.sub.Visible = $true
        } else {
            $r.title.Height = $rowH
            $r.title.Top = 0
            $r.title.TextAlign = 'MiddleLeft'
        }
        $r.title.Width = $r.panel.Width - (L 24) - (L 34)
        $r.del.Left = $r.panel.Width - (L 26)
        $r.del.Top = [int](($rowH - (L 22)) / 2)
        $r.dot.Top = [int](($rowH - (L 7)) / 2)
        $y += $rowH
    }
}

function Sync-Rows {
    $items = @($global:items)
    $want = @{}
    foreach ($it in $items) { $want[[string]$it.sessionId] = $it }

    # drop removed
    foreach ($id in @($global:rows.Keys)) {
        if (-not $want.ContainsKey($id)) {
            try { $global:rows[$id].panel.Dispose() } catch { }
            $global:rows.Remove($id)
        }
    }

    # ensure + update
    foreach ($it in $items) {
        $id = [string]$it.sessionId
        $titleText = [string]$it.title
        if ([string]::IsNullOrWhiteSpace($titleText)) { $titleText = $id }
        if ($titleText.Length -gt 26) { $titleText = $titleText.Substring(0, 25) + [char]0x2026 }
        $running = [bool]$it.running
        $stateText = if ($running) { '运行中' } else { '已完成' }
        $ws = [string]$it.workspaceTitle
        $subText = if ([string]::IsNullOrWhiteSpace($ws)) { $stateText } else { "$ws · $stateText" }

        if (-not $global:rows.ContainsKey($id)) {
            $global:rows[$id] = New-Row $id $titleText $subText ([bool]$it.current)
        } else {
            $r = $global:rows[$id]
            if ($r.title.Text -ne $titleText) { $r.title.Text = $titleText }
            if ($null -ne $r.sub -and $r.sub.Text -ne $subText) { $r.sub.Text = $subText }
            $r.panel.Tag = @{ id = $id; current = [bool]$it.current }
        }

        $r = $global:rows[$id]
        $isCurrent = [bool]$it.current
        $r.panel.BackColor = if ($isCurrent) { (C 'active') } else { (C 'surface2') }
        $r.dot.ForeColor = if ($running) { (C 'acc') } elseif ($isCurrent) { (C 'acc2') } else { (C 'dim') }
        $r.title.ForeColor = (C 'text')
        $r.del.Left = $r.panel.Width - (L 26)
    }

    # 列表与空状态互斥：只有一份控件，靠 Visible 切换，绝不残留
    $hasRows = ($global:rows.Count -gt 0)
    try { $global:emptyLabel.Visible = (-not $hasRows) } catch { }
    if (-not $hasRows) {
        try { $global:emptyLabel.Bounds = New-Object System.Drawing.Rectangle(0, 0, $list.Width, (L 50)) } catch { }
        switch ($global:state) {
            'offline' { $global:emptyLabel.Text = 'DSH 未运行，正在重试…' }
            'sync-wait' { $global:emptyLabel.Text = '等待会话同步…' }
            default { $global:emptyLabel.Text = '还没有对话 · 打开面板添加' }
        }
    }
}

function Update-Chrome {
  try {
    $n = @($global:items).Count
    Ensure-Palette
    $running = 0
    foreach ($it in $global:items) { if ($it.running) { $running += 1 } }

    $title.Text = $global:winTitle
    $countLbl.Text = if ($n -gt 0) { " $n" } else { '' }
    $countLbl.ForeColor = (C 'dim')

    $headDot.ForeColor = if ($running -gt 0) { (C 'acc') } else { (C 'dim') }
    $miniDot.ForeColor = $headDot.ForeColor
    $miniCount.Text = "$n"

    # 超出 7 行的部分在 footer 里带一句，避免以为丢了
    # footer 文案跟随同一份状态机（不与空状态控件各自判断）
    $overflow = [Math]::Max(0, $n - 7)
    $more = if ($overflow -gt 0) { " · 还有 $overflow 个" } else { '' }
    switch ($global:state) {
        'offline' {
            $footLeft.Text = "DSH 未运行，正在重试…$more"
            $footLeft.ForeColor = (C 'warn')
        }
        'sync-wait' {
            $footLeft.Text = '等待会话同步…'
            $footLeft.ForeColor = (C 'dim')
        }
        default {
            if ($running -gt 0) {
                $footLeft.Text = "$running 个运行中$more"
                $footLeft.ForeColor = (C 'acc')
            } elseif ($n -eq 0) {
                $footLeft.Text = '空'
                $footLeft.ForeColor = (C 'dim')
            } else {
                $footLeft.Text = "就绪$more"
                $footLeft.ForeColor = (C 'dim')
            }
        }
    }
    $footRight.ForeColor = (C 'acc')

    $miniText.Text = $global:winTitle
    $miniText.ForeColor = (C 'text')
    $title.ForeColor = (C 'text')
    $head.BackColor = (C 'head')
    $foot.BackColor = (C 'foot')
    $mini.BackColor = (C 'head')
    $form.BackColor = (C 'surface')
    $form.TopMost = $global:prefs.topmost
  } catch {
    try { Add-Content -Path $global:errLog -Value ('chrome: ' + $_.Exception.Message) -Encoding UTF8 } catch { }
  }
}

function Apply-Theme {
    $form.Invalidate()
    Update-Chrome
    foreach ($id in @($global:rows.Keys)) {
        $r = $global:rows[$id]
        $t = $r.panel.Tag
        $isCurrent = ($t -is [hashtable]) -and [bool]$t.current
        $r.panel.BackColor = if ($isCurrent) { (C 'active') } else { (C 'surface2') }
        $r.title.ForeColor = (C 'text')
        if ($null -ne $r.sub) { $r.sub.ForeColor = (C 'dim') }
    }
}

# ---------------- refresh ----------------

function Fetch-State {
    $port = Get-Port
    if (-not $port) { return $null }
    try {
        return Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/session-clean/desk-state" -f $port) -TimeoutSec 3
    } catch { return $null }
}

function Refresh-Desk {
    # 心跳：宿主看门狗靠文件 mtime 判断浮窗是否还活着
    try {
        [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() | Set-Content -Path (Join-Path $DsHome 'session-clean\desk-heartbeat.txt') -Encoding UTF8
    } catch { }
    $state = Fetch-State
    if ($null -eq $state) {
        # 连接失败 ≠ 没有会话。保留已有列表，只把状态切到 offline。
        if ($global:state -ne 'offline') {
            $global:state = 'offline'
            Write-DeskLog 'state=offline'
            Update-Chrome
            Sync-Rows
        }
        return
    }

    if ($null -ne $state.theme -and $null -ne $state.theme.updatedAt) {
        if ([double]$state.theme.updatedAt -ne $global:themeStamp) {
            $global:themeStamp = [double]$state.theme.updatedAt
            if ($state.theme.windowTitle -is [string] -and $state.theme.windowTitle.Trim().Length -gt 0) {
                $wt = $state.theme.windowTitle.Trim()
                if ($wt -ne $global:winTitle) {
                    $global:winTitle = $wt
                    $form.Text = $wt
                    Update-Chrome
                    Update-Layout
                }
            }
            Set-Palette $state.theme
            Apply-Theme
        }
    }

    $items = @()
    if ($state.items) { $items = @($state.items) }
    $mirrorStamp = 0.0
    try { $mirrorStamp = [double]$state.updatedAt } catch { $mirrorStamp = 0.0 }

    # 状态判定：只有「宿主镜像确实被客户端推过」且「列表为空」才算真空
    $prevState = $global:state
    if ($items.Count -gt 0) {
        $global:state = 'ready'
    } elseif ($mirrorStamp -le 0) {
        $global:state = 'sync-wait'   # 客户端还没推过：等待同步，不是空
    } else {
        $global:state = 'empty'       # 权威源明确为空
    }
    if ($global:state -ne $prevState) {
        Write-DeskLog ("state={0} items={1} mirrorAt={2}" -f $global:state, $items.Count, $mirrorStamp)
        Update-Chrome
        Sync-Rows
        Update-Layout
    }

    $items = @()
    if ($state.items) { $items = @($state.items) }
    # 本地乐观值优先：点完到宿主镜像更新之间，不让旧的 current 把高亮打回去
    if ($global:localCurrentId) {
        $hostMatched = $false
        foreach ($x in $items) {
            if ($x.current -and ([string]$x.sessionId -eq $global:localCurrentId)) { $hostMatched = $true }
        }
        foreach ($it in $items) { $it.current = ([string]$it.sessionId -eq $global:localCurrentId) }
        if ($hostMatched) { $global:localCurrentId = '' }
    }
    $sig = ($items | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.sessionId, $_.title, $_.running, $_.current }) -join ';'
    if ($sig -ne $global:signature) {
        $global:signature = $sig
        $global:items = $items
        Sync-Rows
        Update-Layout
    }
    Update-Chrome
}

# ---------------- interactions ----------------

$dragAnchor = $null
foreach ($c in @($form, $head, $title, $countLbl, $mini, $miniDot, $miniText, $miniCount)) {
    $c.Add_MouseDown({
        param($s, $e)
        if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
            $p = [System.Windows.Forms.Cursor]::Position
            $dragAnchor = New-Object System.Drawing.Point(($p.X - $form.Left), ($p.Y - $form.Top))
            $global:dragDiff = $dragAnchor
        }
    })
    $c.Add_MouseMove({
        param($s, $e)
        if ($null -ne $global:dragDiff) {
            $p = [System.Windows.Forms.Cursor]::Position
            $form.Left = $p.X - $global:dragDiff.X
            $form.Top = $p.Y - $global:dragDiff.Y
        }
    })
    $c.Add_MouseUp({ param($s, $e) $global:dragDiff = $null; Save-Prefs })
}

# 双击头部折叠/展开；折叠胶囊单击展开、双击退出（没有右键菜单后的退出入口）
foreach ($c in @($head, $title, $countLbl)) {
    $c.Add_DoubleClick({ $global:collapsed = -not $global:collapsed; Update-Layout; Save-Prefs })
}
$mini.Add_DoubleClick({ $form.Close() })
$miniText.Add_Click({ $global:collapsed = $false; Update-Layout; Save-Prefs })
$miniCount.Add_Click({ $global:collapsed = $false; Update-Layout; Save-Prefs })

$foldBtn.Add_Click({ $global:collapsed = $true; Update-Layout; Save-Prefs })
$closeBtn.Add_Click({
    try { Post-Json '/session-clean/desk-window' @{ action = 'stop' } } catch { }
    try { $form.Close() } catch { }
})
$mini.Add_Click({ if (-not $global:dragDiff) { $global:collapsed = $false; Update-Layout; Save-Prefs } })
$addBtn.Add_Click({ Show-Dsh })
$footRight.Add_Click({ Show-Dsh })


$global:currentMode = 'dark'

# ---------------- run ----------------

$form.Add_Shown({
    Apply-DwmFrame
    try { Restore-Prefs } catch { try { Add-Content -Path $global:errLog -Value ('restore: ' + $_.Exception.Message) -Encoding UTF8 } catch { } }
    try { Update-Layout } catch { try { Add-Content -Path $global:errLog -Value ('layout: ' + $_.Exception.Message) -Encoding UTF8 } catch { } }
    try { Refresh-Desk } catch { try { Add-Content -Path $global:errLog -Value ('refresh: ' + $_.Exception.Message) -Encoding UTF8 } catch { } }
    try {
        # 滚动条走深色主题（Win10 1903+ 有效），失败也不影响功能
        # （已改为行数上限，不再需要滚动条主题）
        $form.Visible = $true
        if (-not (Test-OnScreen $form.Left $form.Top)) { Reset-Position }
        $form.Activate()
        [DeskNative]::SetForegroundWindow($form.Handle) | Out-Null
    } catch { }
})

if ($Snapshot) {
    $snapTimer = New-Object System.Windows.Forms.Timer
    $snapTimer.Interval = 900
    $snapTimer.Add_Tick({
        try {
            $form.Refresh()
            $bmp = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
            $form.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
            $bmp.Save($Snapshot, [System.Drawing.Imaging.ImageFormat]::Png)
            $bmp.Dispose()
        } catch { }
        $snapTimer.Stop()
        $form.Close()
    })
    $snapTimer.Start()
}

# breathing dot for running rows (cheap: swaps two colours, no redraw storm)
$beat = 0
$pulse = New-Object System.Windows.Forms.Timer
$pulse.Interval = 700
$pulse.Add_Tick({
    try {
        if ($global:prefs.motion -eq 'off') { return }
        $beat = 1 - $beat
        foreach ($id in @($global:rows.Keys)) {
            $r = $global:rows[$id]
            $it = $null
            foreach ($x in $global:items) { if ([string]$x.sessionId -eq $id) { $it = $x; break } }
            if ($null -eq $it -or -not $it.running) { continue }
            $r.dot.ForeColor = if ($beat -eq 1) { (C 'acc') } else { Blend (C 'acc') (C 'surface') 0.45 }
        }
        foreach ($ctl in @($headDot, $miniDot)) {
            if ($global:items | Where-Object { $_.running }) {
                $ctl.ForeColor = if ($beat -eq 1) { (C 'acc') } else { Blend (C 'acc') (C 'surface') 0.45 }
            }
        }
    } catch { }
})
$pulse.Start()

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1200
$timer.Add_Tick({ try { Refresh-Desk } catch { } })
$timer.Start()

try {
    [System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)
    [System.Windows.Forms.Application]::add_ThreadException({
        param($s, $e)
        try {
            $dir = Split-Path -Parent $global:errLog
            if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            Add-Content -Path $global:errLog -Value ('{0} {1}' -f (Get-Date -Format 's'), $e.Exception.ToString()) -Encoding UTF8
        } catch { }
    })
} catch { }

Write-DeskLog ('boot start pid=' + $PID + ' dwm=' + $global:dwmFrame + ' scale=' + $global:scale + ' aware=' + $global:dpiAware)
[void][System.Windows.Forms.Application]::Run($form)
