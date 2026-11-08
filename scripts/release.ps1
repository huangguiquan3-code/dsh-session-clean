# 从明确的文件清单生成发布包（不含任何个人运行数据）
# 用法： pwsh -File scripts/release.ps1 -Version 0.3.0
param(
    [string]$Version = '0.3.0',
    [string]$OutDir = 'release'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

# 只允许这些路径进包（相对仓库根的 glob）
$include = @(
    'package.json',
    'cordis.patch.yml',
    'README.md',
    'LICENSE',
    'client.js',
    '.gitignore',
    'lib/*.js',
    'bin/*.js',
    'scripts/*.ps1',
    'scripts/*.vbs',
    'test/*.mjs',
    'docs/ARCHITECTURE.md',
    'docs/screenshot-*.png',
    '.github/workflows/ci.yml'
)

# 明确排除（即使被 include 命中也不进包）
$exclude = @(
    'node_modules', '.git', 'release',
    'desk-*.log', 'desk-heartbeat.txt', 'desk-desired.json', 'desk-recall.txt',
    'desk.json', 'desk-window.json', 'theme.json', 'stash.json',
    'trash-sessions', 'exports'
)

if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutDir | Out-Null

$staging = Join-Path $env:TEMP ("dsh-release-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$pkgRoot = Join-Path $staging "dsh-session-clean-$Version"
New-Item -ItemType Directory -Path $pkgRoot -Force | Out-Null

$copied = @()
# 先处理精确路径（含 .gitignore、.github 这类隐藏项，Get-ChildItem 遍历不到）
foreach ($exact in $include) {
    if ($exact -match '[*?]') { continue }
    if (Test-Path -LiteralPath $exact) {
        $item = Get-Item -LiteralPath $exact -Force
        $rel = $item.FullName.Substring($root.Length).TrimStart('\', '/')
        $dest = Join-Path $pkgRoot $rel
        $destDir = Split-Path -Parent $dest
        if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
        Copy-Item -LiteralPath $item.FullName -Destination $dest -Force
        $copied += $rel
    }
}
foreach ($pattern in $include) {
    if ($pattern -notmatch '[*?]') { continue }
    $files = @(Get-ChildItem -Path $pattern -File -Force -ErrorAction SilentlyContinue)
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($root.Length).TrimStart('\', '/')
        $skip = $false
        foreach ($ex in $exclude) {
            if ($rel -like "$ex*" -or $rel -like "*/$ex*") { $skip = $true; break }
        }
        if ($skip) { continue }
        $dest = Join-Path $pkgRoot $rel
        $destDir = Split-Path -Parent $dest
        if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
        Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
        $copied += $rel
    }
}

# 版本一致性检查
$pkg = Get-Content (Join-Path $pkgRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($pkg.version -ne $Version) {
    Write-Warning "package.json 版本 $($pkg.version) 与参数 $Version 不一致"
}

# 打包
$zipPath = Join-Path (Resolve-Path $OutDir) "dsh-session-clean-$Version.zip"
Compress-Archive -Path $pkgRoot -DestinationPath $zipPath -CompressionLevel Optimal

# 校验：解压后结构 + 必需文件
$check = Join-Path $env:TEMP ("dsh-verify-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
Expand-Archive -Path $zipPath -DestinationPath $check -Force
$need = @(
    'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'client.js',
    'lib/index.js', 'lib/trash.js', 'lib/export.js',
    'bin/session-clean.js',
    'scripts/desk-window.ps1', 'scripts/desk-window.vbs', 'scripts/desk-ctl.ps1'
)
$missing = @()
foreach ($n in $need) {
    if (-not (Test-Path (Join-Path $pkgRoot.Replace($staging, $check) $n))) { $missing += $n }
}
# 隐私检查：包里不得出现运行期数据
$leak = @()
Get-ChildItem $check -Recurse -File | ForEach-Object {
    if ($_.Name -match '^(desk-.*\.log|desk-heartbeat\.txt|desk-desired\.json|theme\.json|stash\.json|desk\.json|desk-window\.json)$') { $leak += $_.Name }
}

Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $check -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "包： $zipPath"
Write-Host "文件数： $($copied.Count)"
Write-Host "大小： $([Math]::Round((Get-Item $zipPath).Length / 1KB, 1)) KB"
if ($missing.Count) { Write-Host "缺必需文件： $($missing -join ', ')" } else { Write-Host "必需文件： 齐全" }
if ($leak.Count) { Write-Host "发现运行期数据： $($leak -join ', ')" } else { Write-Host "运行期数据： 无" }
$copied | Sort-Object | ForEach-Object { Write-Host "  $_" }
