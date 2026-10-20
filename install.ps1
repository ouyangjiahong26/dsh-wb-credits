# 手动安装 dsh-wb-credits（不依赖 npm / dsh CLI）
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
#   或直接双击 install.cmd
#
# 做的事：
#   1. 找到 DSH 的 web profile 目录
#   2. 把本目录拷进 <profile>\node_modules\dsh-wb-credits
#   3. 在 <profile>\cordis.patch.yml 末尾追加一条 insert（已存在则跳过）
#   4. 提示下一步

param(
  [string]$ProfileDir = '',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Step($m) { Write-Host "→ $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  $m" -ForegroundColor Yellow }

$pkgName = 'dsh-wb-credits'
$src = $PSScriptRoot

# ── 1. 找 profile ────────────────────────────────────────────────
$candidates = @()
if ($ProfileDir)          { $candidates += $ProfileDir }
if ($env:DSH_PROFILE_DIR) { $candidates += $env:DSH_PROFILE_DIR }
if ($env:APPDATA)         { $candidates += (Join-Path $env:APPDATA 'dsh-desktop\harness\profiles\web') }
if ($HOME)                { $candidates += (Join-Path $HOME '.dsh\profiles\web') }

$profile = $null
foreach ($c in $candidates) {
  if ($c -and (Test-Path (Join-Path $c 'cordis.patch.yml'))) { $profile = $c; break }
}

if (-not $profile) {
  Warn '找不到 DSH profile（没找到 cordis.patch.yml）。'
  Write-Host ''
  Write-Host '请手动指定，例如：' -ForegroundColor Yellow
  Write-Host '  powershell -ExecutionPolicy Bypass -File install.ps1 -ProfileDir "C:\Users\你\AppData\Roaming\dsh-desktop\harness\profiles\web"'
  exit 1
}

Step "profile: $profile"
$nodeModules = Join-Path $profile 'node_modules'
$dest = Join-Path $nodeModules $pkgName
New-Item -ItemType Directory -Force -Path $nodeModules | Out-Null

# ── 2. 拷文件 ────────────────────────────────────────────────────
Step "安装到 $dest"
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null

$items = @('package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'icon.png')
foreach ($i in $items) {
  $p = Join-Path $src $i
  if (Test-Path $p) { Copy-Item $p (Join-Path $dest $i) -Force }
}
foreach ($d in @('lib', 'assets')) {
  $p = Join-Path $src $d
  if (-not (Test-Path $p)) { throw "缺少目录 $d，安装包不完整" }
  Copy-Item $p (Join-Path $dest $d) -Recurse -Force
}
Ok '文件已就位'

# ── 3. 打补丁 ────────────────────────────────────────────────────
$patch = Join-Path $profile 'cordis.patch.yml'
$text = [System.IO.File]::ReadAllText($patch, [System.Text.Encoding]::UTF8)

if ($text -match '(?m)^\s*-?\s*id:\s*dsh-wb-credits\s*$') {
  Warn 'cordis.patch.yml 里已经有 dsh-wb-credits 条目，跳过写入'
} else {
  $backup = "$patch.bak-dshwbcredits-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
  Copy-Item $patch $backup -Force
  Ok "原 patch 已备份：$(Split-Path $backup -Leaf)"

  $block = "`n# dsh-wb-credits (relay credit badge, added by install.ps1)`n- insert:`n    - id: dsh-wb-credits`n      name: dsh-wb-credits`n"
  [System.IO.File]::AppendAllText($patch, $block, (New-Object System.Text.UTF8Encoding($false)))
  Ok '已写入 patch 条目'
}

# ── 4. 收尾提示 ──────────────────────────────────────────────────
Write-Host ''
Write-Host '装好了。接下来：' -ForegroundColor Cyan
Write-Host '  1. 重启 DSH Desktop（客户端注入脚本只在宿主启动时收集一次）'
Write-Host '  2. 打开会话页，右下角会出现胶囊；点它可以展开明细 / 设置'
Write-Host ''
Write-Host '首次使用通常无需配置：插件会自动从 DSH 的模型 provider 里认出你的中转站网关。'
Write-Host '想看「全站积分余额」时，再在设置里补面板的只读账号。'
