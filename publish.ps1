# 一键上架到 GitHub
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File publish.ps1
#   powershell ... -Owner 你的GitHub用户名 -Name "你的名字" -Email "you@example.com"
#
# 做四件事：
#   1. 把 README / LICENSE / package.json 里的占位符换成你的真实信息
#   2. 补 git 身份（没配过就设成本仓库局部配置）
#   3. 把这些改动并进当前唯一那次提交（保持历史干净）
#   4. 配好 origin 并 push
#
# 前提：先在 GitHub 上建一个**空仓库**（不要勾 README / .gitignore / license）。

param(
  [string]$Owner = '',
  [string]$Repo = 'dsh-wb-credits',
  [string]$Name = '',
  [string]$Email = '',
  [string]$RemoteUrl = '',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
function Step($m) { Write-Host "→ $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  $m" -ForegroundColor Yellow }

Set-Location -Path $PSScriptRoot

# ── 0. 检查是 git 仓库 ──────────────────────────────────────────
git rev-parse --git-dir *> $null
if ($LASTEXITCODE -ne 0) { throw "当前目录不是 git 仓库：$PSScriptRoot" }

# ── 1. 解析 owner ───────────────────────────────────────────────
if (-not $Owner) {
  $existing = ''
  try { $existing = (git remote get-url origin 2>$null) } catch {}
  if ($existing -match 'github\.com[:/]+([^/]+)/') { $Owner = $Matches[1] }
}
if (-not $Owner) { $Owner = (Read-Host '你的 GitHub 用户名').Trim() }
if (-not $Owner) { throw '需要 GitHub 用户名' }
Ok "owner: $Owner"

# ── 2. 身份 ─────────────────────────────────────────────────────
$curName = (git config user.name)
$curEmail = (git config user.email)
# 显式传了就以传入的为准（覆盖已有的占位身份）；没传且没配过才问
if ($Name) {
  if ($Name -ne $curName) { git config user.name $Name; Ok "user.name = $Name" }
} elseif (-not $curName) {
  $Name = (Read-Host 'git 提交用的名字（例如 Zhang Hongfei）').Trim()
  if ($Name) { git config user.name $Name; Ok "已设 user.name = $Name" }
}
if ($Email) {
  if ($Email -ne $curEmail) { git config user.email $Email; Ok "user.email = $Email" }
} elseif (-not $curEmail) {
  $Email = (Read-Host 'git 提交用的邮箱').Trim()
  if ($Email) { git config user.email $Email; Ok "已设 user.email = $Email" }
}

# ── 3. 替换占位符 ───────────────────────────────────────────────
$utf8 = New-Object System.Text.UTF8Encoding($false)

$readmePath = Join-Path $PSScriptRoot 'README.md'
$readme = [System.IO.File]::ReadAllText($readmePath, [System.Text.Encoding]::UTF8)
$before = $readme
$readme = $readme.Replace('<你的GitHub用户名>', $Owner).Replace('github:<you>/', "github:$Owner/").Replace('github:<用户名>/', "github:$Owner/")
if ($readme -ne $before) {
  [System.IO.File]::WriteAllText($readmePath, $readme, $utf8)
  Ok 'README 安装命令已写成你的仓库'
} else {
  Warn 'README 里没有占位符（可能已替换过）'
}

$licPath = Join-Path $PSScriptRoot 'LICENSE'
if (Test-Path $licPath) {
  $lic = [System.IO.File]::ReadAllText($licPath, [System.Text.Encoding]::UTF8)
  if ($lic.Contains('<YOUR NAME>')) {
    $who = if ($Name) { $Name } else { 'dsh-wb-credits contributors' }
    [System.IO.File]::WriteAllText($licPath, $lic.Replace('<YOUR NAME>', $who), $utf8)
    Ok "LICENSE 署名 = $who"
  }
}

$pkgPath = Join-Path $PSScriptRoot 'package.json'
$pkg = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8)
if (-not $pkg.Contains('"repository"')) {
  $repoBlock = @"
  "repository": {
    "type": "git",
    "url": "git+https://github.com/$Owner/$Repo.git"
  },
  "homepage": "https://github.com/$Owner/$Repo#readme",
"@
  $pkg = [regex]::Replace($pkg, '(?m)^(\s*)"engines":', ($repoBlock + "`n" + '$1"engines":'))
  [System.IO.File]::WriteAllText($pkgPath, $pkg, $utf8)
  Ok 'package.json 已补 repository / homepage'

  # 顺手校验一下 JSON 没写坏
  try { Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json | Out-Null; Ok 'package.json 合法' }
  catch { throw "package.json 被写坏了：$($_.Exception.Message)" }
}

# ── 4. 并进唯一那次提交 ─────────────────────────────────────────
git add -A
$staged = (git diff --cached --name-only)
if ($staged) {
  git commit --amend --no-edit --reset-author *> $null
  if ($LASTEXITCODE -ne 0) { git commit -q -m "Initial commit: dsh-wb-credits" }
  Ok "已更新提交（作者：$(git log -1 --format='%an <%ae>')）"
} else {
  Warn '没有需要提交的改动'
}

# ── 5. 远程 + 推送 ──────────────────────────────────────────────
if (-not $RemoteUrl) { $RemoteUrl = "https://github.com/$Owner/$Repo.git" }

$curRemote = ''
try { $curRemote = (git remote get-url origin 2>$null) } catch {}
if ($curRemote) {
  if ($curRemote -ne $RemoteUrl) { git remote set-url origin $RemoteUrl; Ok "origin 改为 $RemoteUrl" }
} else {
  git remote add origin $RemoteUrl
  Ok "origin = $RemoteUrl"
}

if ($DryRun) {
  Write-Host ''
  Write-Host '[DryRun] 到此为止，没有推送。实际执行时会运行：' -ForegroundColor Yellow
  Write-Host "  git push -u origin main"
  exit 0
}

Step 'push…'
git push -u origin main
if ($LASTEXITCODE -ne 0) {
  Warn '推送失败。常见原因：'
  Write-Host '   · 没登 GitHub：会弹浏览器/输入 token（用 Personal Access Token 当密码）'
  Write-Host '   · 网络到 github.com 不通：换代理，或用 GitHub Desktop 推送'
  Write-Host '   · 仓库不是空的：先删掉远端自动创建的 README/LICENSE，或 git push -f'
  exit 1
}

Write-Host ''
Write-Host '🎉 上线了：' -ForegroundColor Green
Write-Host "   https://github.com/$Owner/$Repo"
Write-Host ''
Write-Host '同学安装：'
Write-Host "   dsh plugin --profile web add github:$Owner/$Repo"
Write-Host ''
Write-Host '想进插件市场，去 awesome-dsh-plugin 提 PR 加一条（分类 usage），一天内自动收录。'
