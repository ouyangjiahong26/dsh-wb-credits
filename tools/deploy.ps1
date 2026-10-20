# 把工作区里的插件源码同步到 DSH profile 的 node_modules。
#
#   pwsh -File tools\deploy.ps1
#
# 只拷运行期需要的文件（不含 tools/、README 之外的开发件）。

$ErrorActionPreference = 'Stop'

$src = Split-Path -Parent $PSScriptRoot
$profileDir = $env:DSH_PROFILE_DIR
if (-not $profileDir) { throw 'DSH_PROFILE_DIR 未设置' }

$dst = Join-Path $profileDir 'node_modules\dsh-wb-credits'
if (-not (Test-Path $dst)) { New-Item -ItemType Directory -Force -Path $dst | Out-Null }

foreach ($item in @('package.json', 'cordis.patch.yml', 'README.md')) {
  Copy-Item (Join-Path $src $item) (Join-Path $dst $item) -Force
}
foreach ($dir in @('lib', 'assets')) {
  $target = Join-Path $dst $dir
  if (Test-Path $target) { Remove-Item $target -Recurse -Force }
  Copy-Item (Join-Path $src $dir) $target -Recurse -Force
}

Write-Host "已同步到 $dst"
Get-ChildItem $dst -Recurse -File | Select-Object Length, @{n = 'File'; e = { $_.FullName.Substring($dst.Length + 1) } } | Format-Table -AutoSize
