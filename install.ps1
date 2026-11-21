# install.ps1 — drop dsh-unslop into a DSH profile.
#
# Usage:
#   .\install.ps1                       # default profile: desktop
#   .\install.ps1 -ProfileName web
#   .\install.ps1 -DryRun               # print the plan, change nothing
#   .\install.ps1 -Uninstall            # remove it again (bundle entry + package folder)
#
# What it does, in order:
#   1. copies this package -> <profile>\node_modules\dsh-unslop (existing renamed .bak-<ts>)
#   2. adds "dsh-unslop" to <profile>\package.json  dsh.profile.bundles
#   3. reports the skill state; Playwright/ffmpeg are optional and installed by unslop_deps
#
# Nothing here touches the harness install directory or any other plugin.

[CmdletBinding()]
param(
  [string]$ProfileName = 'desktop',
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [switch]$DryRun,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = $here
$profileDir = Join-Path $DshHome "profiles\$ProfileName"
$pkgJson = Join-Path $profileDir 'package.json'
$target = Join-Path $profileDir 'node_modules\dsh-unslop'
$skillDir = Join-Path $DshHome 'skills\unslop'
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
function Say($m) { Write-Host $m }

Say "== dsh-unslop =="
Say "   profile : $profileDir"
Say "   source  : $src"

if (-not (Test-Path $pkgJson)) {
  throw "profile not found: $pkgJson — run the DSH app once so it creates the profile, or pass -ProfileName"
}

if ($Uninstall) {
  $pkg = Get-Content $pkgJson -Raw | ConvertFrom-Json
  $bundles = @(@($pkg.dsh.profile.bundles) | Where-Object { $_ -ne 'dsh-unslop' })
  if ($DryRun) { Say "   [dry] would drop 'dsh-unslop' from dsh.profile.bundles and remove $target"; return }
  Copy-Item $pkgJson "$pkgJson.bak-$stamp" -Force
  $pkg.dsh.profile.bundles = @($bundles)
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($pkgJson, ($pkg | ConvertTo-Json -Depth 32), $utf8NoBom)
  if (Test-Path $target) { Move-Item $target "$target.bak-$stamp" }
  if (Test-Path $skillDir) { Remove-Item -Recurse -Force $skillDir -ErrorAction SilentlyContinue }
  $dataDir = Join-Path $DshHome 'plugins-data\unslop'
  if (Test-Path $dataDir) { Remove-Item -Recurse -Force $dataDir -ErrorAction SilentlyContinue }
  Say "   removed the bundle entry, moved the package to $target.bak-$stamp; cleaned skills\unslop + plugins-data\unslop"
  return
}

if (-not (Test-Path (Join-Path $src 'host\index.js'))) {
  throw "package missing: $src\host\index.js not found — run this from inside the package folder"
}

# --- 1. copy the package -----------------------------------------------------
if ($DryRun) {
  Say "   [dry] would copy package -> $target (existing renamed .bak-$stamp)"
} else {
  New-Item -ItemType Directory -Force -Path (Join-Path $profileDir 'node_modules') | Out-Null
  if (Test-Path $target) { Move-Item $target "$target.bak-$stamp" }
  $exclude = @('node_modules', '.git', '.aoci', '_archive', 'aoci.txt', 'aoci.code.txt', 'aoci.meta.txt', 'AGENTS.md')
  Copy-Item -Recurse -Path $src -Destination $target -Force
  foreach ($drop in $exclude) { $p = Join-Path $target $drop; if (Test-Path $p) { Remove-Item -Recurse -Force $p } }
  # npm may have installed playwright here during a dry probe; never ship node_modules into the profile
  $nm = Join-Path $target 'node_modules'; if (Test-Path $nm) { Remove-Item -Recurse -Force $nm }
  Say "   copied package -> $target"
}

# --- 2. register the bundle --------------------------------------------------
$pkg = Get-Content $pkgJson -Raw | ConvertFrom-Json
if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
$bundles = @(@($pkg.dsh.profile.bundles) | Where-Object { $_ })
if ($bundles -notcontains 'dsh-unslop') { $bundles += 'dsh-unslop' }
if ($DryRun) {
  Say "   [dry] would set dsh.profile.bundles = $($bundles -join ', ')"
} else {
  Copy-Item $pkgJson "$pkgJson.bak-$stamp" -Force
  $pkg.dsh.profile.bundles = @($bundles)
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($pkgJson, ($pkg | ConvertTo-Json -Depth 32), $utf8NoBom)
  Say "   registered 'dsh-unslop' in dsh.profile.bundles"
}

# --- 3. report ---------------------------------------------------------------
Say ""
Say "Skill installs on boot to: $skillDir"
Say "Optional heavy tools (only for snapshot/story):"
Say "   unslop_deps {install:true}   -> playwright + chromium"
Say "   ffmpeg: winget install Gyan.FFmpeg"
Say ""
Say "Restart the Harness. Then tools appear as mcp__unslop__* plus unslop_status / unslop_deps."
