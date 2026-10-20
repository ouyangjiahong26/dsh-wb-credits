# 卸载 dsh-wb-credits
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1
#   powershell ... -File uninstall.ps1 -PurgeData     # 连配置和图标一起删
#
# 做的事：
#   1. 从 cordis.patch.yml 里删掉本插件的 insert 条目（删除前先备份）
#   2. 删掉 <profile>\node_modules\dsh-wb-credits
#   3. -PurgeData 时再删 $DSH_HOME\.dshw-credits*.json 与 wb-credits\

param(
  [string]$ProfileDir = '',
  [switch]$PurgeData
)

$ErrorActionPreference = 'Stop'

function Step($m) { Write-Host "→ $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  $m" -ForegroundColor Yellow }

$pkgName = 'dsh-wb-credits'

$candidates = @()
if ($ProfileDir)          { $candidates += $ProfileDir }
if ($env:DSH_PROFILE_DIR) { $candidates += $env:DSH_PROFILE_DIR }
if ($env:APPDATA)         { $candidates += (Join-Path $env:APPDATA 'dsh-desktop\harness\profiles\web') }
if ($HOME)                { $candidates += (Join-Path $HOME '.dsh\profiles\web') }

$profile = $null
foreach ($c in $candidates) {
  if ($c -and (Test-Path (Join-Path $c 'cordis.patch.yml'))) { $profile = $c; break }
}
if (-not $profile) { Warn '找不到 DSH profile，请用 -ProfileDir 指定'; exit 1 }

Step "profile: $profile"

# ── 1. 清理 patch ────────────────────────────────────────────────
$patch = Join-Path $profile 'cordis.patch.yml'
$text = [System.IO.File]::ReadAllText($patch, [System.Text.Encoding]::UTF8)
$before = $text

$text = [regex]::Replace($text, '(?m)^#[^\r\n]*dsh-wb-credits[^\r\n]*\r?\n[ \t]*- insert:\r?\n[ \t]+- id: dsh-wb-credits\r?\n[ \t]+name: [^\r\n]*(?:\r?\n|$)', '')
$text = [regex]::Replace($text, '(?m)^[ \t]*- insert:\r?\n[ \t]+- id: dsh-wb-credits\r?\n[ \t]+name: [^\r\n]*(?:\r?\n|$)', '')
$text = [regex]::Replace($text, '(?m)^[ \t]*- id: dsh-wb-credits\r?\n[ \t]+disabled: (?:true|false)(?:\r?\n|$)', '')

if ($text -ne $before) {
  $backup = "$patch.bak-uninstall-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Copy-Item $patch $backup -Force
  [System.IO.File]::WriteAllText($patch, $text, (New-Object System.Text.UTF8Encoding($false)))
  Ok "已从 patch 移除条目（备份：$(Split-Path $backup -Leaf)）"
} else {
  Warn 'patch 里没有找到本插件条目，跳过'
}

# ── 2. 删包 ──────────────────────────────────────────────────────
$dest = Join-Path $profile "node_modules\$pkgName"
if (Test-Path $dest) {
  Remove-Item $dest -Recurse -Force
  Ok '已删除 node_modules\dsh-wb-credits'
} else {
  Warn 'node_modules 里没有这个包'
}

# ── 3. 可选：清数据 ──────────────────────────────────────────────
if ($PurgeData) {
  $home_ = $env:DSH_HOME
  if (-not $home_) { $home_ = Join-Path $HOME '.dsh' }
  foreach ($f in @('.dshw-credits.json', '.dshw-credits-state.json')) {
    $p = Join-Path $home_ $f
    if (Test-Path $p) { Remove-Item $p -Force; Ok "已删除 $f" }
  }
  $iconDir = Join-Path $home_ 'wb-credits'
  if (Test-Path $iconDir) { Remove-Item $iconDir -Recurse -Force; Ok '已删除 wb-credits\（图标）' }
}

Write-Host ''
Write-Host '卸完了，重启 DSH Desktop 生效。' -ForegroundColor Cyan
