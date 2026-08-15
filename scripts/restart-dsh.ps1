# Rebuild, reinstall into the dsh profile, then restart `dsh web`.
#
# The reinstall is not optional busywork: dsh COPIES the plugin into
# ~/.dsh/profiles/<name>/node_modules/dsh-fschannel, so editing lib/*.js in the
# repo has zero effect until the copy is replaced. Worse, pnpm keys its `file:`
# store entry on (path, version), so a single `plugin add` reuses the stale
# entry and silently changes nothing — the remove/add pair is required.
# Without this the script used to poll /feishu/status, get ok:true from the OLD
# copy, and log UP for a restart that shipped none of your changes.
#
# The relaunch is detached (its own hidden process), so this script keeps
# working even when the current GUI dies. All paths derive from the repo root
# (this script's parent); optional overrides come from the repo .env
# (FSCHANNEL_REPO / FSCHANNEL_ENV_FILE), which are exported into the launched
# dsh process environment.
param(
  [string]$ProfileName = 'web',
  [int]$Port = 3080,
  # Restart only, leaving the installed copy untouched. Use when you have not
  # edited the plugin and just want a clean process.
  [switch]$SkipReinstall
)
$ErrorActionPreference = 'Stop'

$repo = $PSScriptRoot | Split-Path -Parent
$envFile = Join-Path $repo '.env'

# Read optional overrides from the repo .env (KEY=VALUE or KEY VALUE forms).
function Read-EnvKey($file, $key) {
  if (-not (Test-Path $file)) { return $null }
  foreach ($line in Get-Content $file) {
    $line = $line.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { continue }
    if ($line -match '^([A-Za-z][A-Za-z0-9_.-]*)\s*(?:=|\s)\s*(.*)$') {
      if ($matches[1].ToLower() -eq $key.ToLower()) { return $matches[2].Trim().Trim('"') }
    }
  }
  return $null
}

$repoOverride = Read-EnvKey $envFile 'FSCHANNEL_REPO'
if ($repoOverride) { $repo = $repoOverride }
$envFile = Read-EnvKey $envFile 'FSCHANNEL_ENV_FILE'
if (-not $envFile) { $envFile = Join-Path $repo '.env' }
# Export the path config so the loader's !!js expressions see it.
$env:FSCHANNEL_REPO = $repo
$env:FSCHANNEL_ENV_FILE = $envFile

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profileDir = Join-Path $dshHome ('profiles/' + $ProfileName)
$installed = Join-Path $profileDir 'node_modules/dsh-fschannel'

$log = Join-Path $repo 'restart-dsh.log'
$stdoutLog = Join-Path $repo 'dsh.stdout.log'
$stderrLog = Join-Path $repo 'dsh.stderr.log'
# Rotate before appending: this log only ever grew, and it lives in the repo.
# stdout/stderr are truncated by the redirect on every launch, so only this one
# needs it.
if (Test-Path $log) {
  $logItem = Get-Item $log
  if ($logItem.Length -gt 1MB) {
    Move-Item -LiteralPath $log -Destination "$log.1" -Force -ErrorAction SilentlyContinue
  }
}

# One writer for the whole run: Out-File -Append reopened the file per line.
$logLines = [System.Collections.Generic.List[string]]::new()
function Log($line) {
  $stamped = (Get-Date -Format o) + ' ' + $line
  $logLines.Add($stamped)
  Write-Host $stamped
}
function Flush-Log { if ($logLines.Count -gt 0) { $logLines | Out-File -Encoding utf8 $log -Append; $logLines.Clear() } }

Log 'restart-dsh: starting'

# ---------------------------------------------------------------------------
# 1. Stop the running server.
#
# Identify it by the port listener ONLY. The previous version also swept
# Get-CimInstance Win32_Process for `CommandLine -match 'dsh'`, which is an
# unanchored regex over the whole command line: the repo path (E:\Code\dsh),
# every path under ~/.dsh, any editor or language server opened on the repo,
# and the sibling restart-web.ps1 all matched, and all got Stop-Process -Force.
# It was also unreliable in the other direction — CommandLine is null for
# processes owned by other users unless elevated.
# ---------------------------------------------------------------------------
$killed = @()
try {
  $listeners = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop
  foreach ($listener in $listeners) {
    if ($killed -contains $listener.OwningProcess) { continue }
    $killed += $listener.OwningProcess
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
  }
} catch {
  # No listener on the port: nothing to stop.
}
if ($killed.Count -gt 0) { Log ('restart-dsh: killed ' + ($killed -join ',')) } else { Log ('restart-dsh: no listener on port ' + $Port) }

# 2. Wait for the port/process to fully release.
Log 'restart-dsh: waiting 5s'
Start-Sleep -Seconds 5

# Drop credential env vars inherited from the old dsh process tree, so the
# fresh process resolves credentials only from the DSH credential store.
Remove-Item Env:FEISHU_APP_ID, Env:FEISHU_APP_SECRET, Env:LARK_APP_ID, Env:LARK_APP_SECRET, Env:APP_ID, Env:APP_SECRET -ErrorAction SilentlyContinue

$npx = Get-Command npx -ErrorAction SilentlyContinue
if (-not $npx) { Log 'restart-dsh: FAILED - npx not on PATH'; Flush-Log; exit 1 }
$npxShim = $npx.Source

# Run a native command without letting a single stderr line kill the script.
# Windows PowerShell promotes native stderr to a terminating NativeCommandError
# whenever $ErrorActionPreference is 'Stop' and stderr is merged with 2>&1 —
# pnpm's peer-dependency warnings alone would abort the reinstall.
function Invoke-Logged {
  param([string]$Exe, [string[]]$ExeArgs, [string]$Tag)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Exe @ExeArgs 2>&1 | ForEach-Object { Log ('  ' + $Tag + ': ' + $_.ToString()) }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
}

# ---------------------------------------------------------------------------
# 3. Rebuild the client bundle and replace the installed copy.
# ---------------------------------------------------------------------------
if (-not $SkipReinstall) {
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if (-not $npm) { Log 'restart-dsh: FAILED - npm not on PATH'; Flush-Log; exit 1 }

  Log 'restart-dsh: building client bundle'
  Push-Location $repo
  try {
    $code = Invoke-Logged -Exe $npm.Source -ExeArgs @('run', 'build') -Tag 'build'
  } finally {
    Pop-Location
  }
  if ($code -ne 0) { Log ('restart-dsh: FAILED - npm run build exited ' + $code); Flush-Log; exit 1 }

  Log 'restart-dsh: removing installed copy'
  $null = Invoke-Logged -Exe 'pwsh' -ExeArgs @('-NoProfile', '-File', $npxShim, '--yes', '@deepseek-ai/dsh', 'plugin', '--profile', $ProfileName, 'remove', 'dsh-fschannel') -Tag 'dsh'

  # pnpm keys the file: store entry on (path, version); with the version
  # unchanged an `add` alone reuses the stale entry. `remove` above usually
  # clears it, but purge any virtual-store leftovers for good measure.
  $pnpmDir = Join-Path $profileDir 'node_modules/.pnpm'
  if (Test-Path $pnpmDir) {
    Get-ChildItem $pnpmDir -Filter 'dsh-fschannel@file+*' -ErrorAction SilentlyContinue | ForEach-Object {
      Log ('restart-dsh: purging store entry ' + $_.Name)
      Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
  }

  Log ('restart-dsh: installing from ' + $repo)
  $code = Invoke-Logged -Exe 'pwsh' -ExeArgs @('-NoProfile', '-File', $npxShim, '--yes', '@deepseek-ai/dsh', 'plugin', '--profile', $ProfileName, 'add', ('file:' + $repo)) -Tag 'dsh'
  if ($code -ne 0) { Log ('restart-dsh: FAILED - plugin add exited ' + $code); Flush-Log; exit 1 }
}

# ---------------------------------------------------------------------------
# 4. Prove the installed copy really is this working tree.
#
# This is the check that turns a false green into a hard failure: if the hashes
# differ, the process we are about to start would run old code and still answer
# ok:true on /feishu/status.
# ---------------------------------------------------------------------------
function Get-LibManifest([string]$root) {
  $dir = Join-Path $root 'lib'
  if (-not (Test-Path $dir)) { return $null }
  $parts = Get-ChildItem $dir -Filter *.js -File | Sort-Object Name | ForEach-Object {
    $_.Name + ':' + (Get-FileHash $_.FullName -Algorithm SHA256).Hash
  }
  return ($parts -join "`n")
}

$repoManifest = Get-LibManifest $repo
$installedManifest = Get-LibManifest $installed
if ($null -eq $installedManifest) {
  Log ('restart-dsh: FAILED - no installed copy at ' + $installed)
  Flush-Log
  exit 1
}
if ($repoManifest -ne $installedManifest) {
  Log 'restart-dsh: FAILED - installed copy does not match the repo (lib/ hashes differ)'
  Log ('restart-dsh:   repo      ' + (Join-Path $repo 'lib'))
  Log ('restart-dsh:   installed ' + (Join-Path $installed 'lib'))
  Log 'restart-dsh:   re-run without -SkipReinstall, or check that plugin add succeeded'
  Flush-Log
  exit 1
}
Log 'restart-dsh: installed copy matches the repo'

# 5. Relaunch (detached, hidden).
Log ('restart-dsh: launching via ' + $npxShim)
$proc = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile', '-File', $npxShim, '--yes', '@deepseek-ai/dsh', 'web') -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
Log ('restart-dsh: spawned pid ' + $proc.Id)

# 6. Poll the feishu status endpoint until the full stack is up.
$up = $false
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 1000
  if ($proc.HasExited) {
    Log ('restart-dsh: process exited early with code ' + $proc.ExitCode)
    break
  }
  try {
    $resp = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/feishu/status') -TimeoutSec 3
    if ($resp.ok -eq $true) {
      # `connected` is polled the moment the endpoint answers; the bot attaches
      # asynchronously just after, so False here is usually a race, not a fault.
      Log ('restart-dsh: UP connected=' + $resp.connected + ' bindings=' + $resp.bindings.Count + ' appId=' + $resp.appId)
      $up = $true
      break
    }
  } catch { }
}
if (-not $up) {
  Log 'restart-dsh: server did not come up within 120s (see dsh.stderr.log)'
  Get-Content $stderrLog -Tail 40 -ErrorAction SilentlyContinue | ForEach-Object { Log ('  stderr: ' + $_) }
  Log 'restart-dsh: done'
  Flush-Log
  exit 1
}
Log 'restart-dsh: done'
Flush-Log
