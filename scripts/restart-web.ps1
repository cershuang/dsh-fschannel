# Restart dsh web with the feishu plugin active.
# Detached from the harness: safe to run even if the current GUI process dies.
# All paths derive from the repo root (this script's parent) — no machine
# paths are hardcoded. Optional overrides come from the repo's .env:
#   FSCHANNEL_REPO       repo root (default: parent of scripts/)
#   FSCHANNEL_ENV_FILE   .env path (default: <repo>/.env)
# Those keys are exported into the launched dsh web process environment so
# cordis.patch.yml's !!js expressions can read them.
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

$log = Join-Path $repo 'web-restart.log'
$stdoutLog = Join-Path $repo 'web.stdout.log'
$stderrLog = Join-Path $repo 'web.stderr.log'
function Log($line) { ($(Get-Date -Format o) + ' ' + $line) | Out-File -Encoding utf8 $log -Append }

Log ("restart-web: starting (10s grace) repo=" + $repo)
Start-Sleep -Seconds 10

# 1. Kill whatever listens on 3080.
$oldPid = $null
try {
  $conn = Get-NetTCPConnection -State Listen -LocalPort 3080 -ErrorAction Stop | Select-Object -First 1
  $oldPid = $conn.OwningProcess
} catch { $oldPid = $null }
if ($oldPid) {
  Log ("restart-web: killing pid " + $oldPid)
  Stop-Process -Id $oldPid -Force
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    $still = Get-NetTCPConnection -State Listen -LocalPort 3080 -ErrorAction SilentlyContinue
    if (-not $still) { break }
  }
} else {
  Log 'restart-web: nothing on 3080'
}

# 2. Start dsh web fresh (via the dsh shim through pwsh, detached).
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if (-not $dsh) { Log 'restart-web: FAILED - dsh not on PATH'; exit 1 }
$shim = $dsh.Source
Log ("restart-web: launching dsh via " + $shim)
$proc = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile', '-File', $shim, 'web') -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
Log ("restart-web: spawned pid " + $proc.Id)

# 3. Poll the feishu status endpoint until the full stack is up.
$up = $false
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 1000
  try {
    $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:3080/feishu/status' -TimeoutSec 3
    if ($resp.ok -eq $true) {
      Log ('restart-web: UP connected=' + $resp.connected + ' bindings=' + $resp.bindings.Count)
      $up = $true
      break
    }
  } catch { }
}
if (-not $up) {
  Log 'restart-web: server did not come up within 120s (see web.stderr.log)'
  Get-Content $stderrLog -Tail 40 -ErrorAction SilentlyContinue | ForEach-Object { Log ('  stderr: ' + $_) }
}
Log 'restart-web: done'
