# Restart dsh web via npx: kill the running dsh process, wait 5 seconds,
# then relaunch `npx --yes @deepseek-ai/dsh web` automatically.
# Detached from the harness: the relaunch is spawned as its own hidden
# process, so this script keeps working even when the current GUI dies.
# All paths derive from the repo root (this script's parent); optional
# overrides come from the repo .env (FSCHANNEL_REPO / FSCHANNEL_ENV_FILE),
# which are exported into the launched dsh process environment.
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

$log = Join-Path $repo 'restart-dsh.log'
$stdoutLog = Join-Path $repo 'dsh.stdout.log'
$stderrLog = Join-Path $repo 'dsh.stderr.log'
function Log($line) { ($(Get-Date -Format o) + ' ' + $line) | Out-File -Encoding utf8 $log -Append }

Log 'restart-dsh: starting'

# 1. Kill the dsh process: the 3080 listener plus any launcher still alive.
$killed = @()
try {
  $listener = Get-NetTCPConnection -State Listen -LocalPort 3080 -ErrorAction Stop | Select-Object -First 1
  if ($listener) {
    $killed += $listener.OwningProcess
    Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
  }
} catch { }
$dshProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -match 'dsh' -and $_.ProcessId -ne $PID -and $_.CommandLine -notmatch 'restart-dsh'
}
foreach ($p in $dshProcs) {
  $killed += $p.ProcessId
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Log ('restart-dsh: killed ' + ($killed -join ','))

# 2. Wait 5 seconds for the ports/processes to fully release.
Log 'restart-dsh: waiting 5s'
Start-Sleep -Seconds 5

# Drop credential env vars inherited from the old dsh process tree, so the
# fresh process resolves credentials only from the DSH credential store.
Remove-Item Env:FEISHU_APP_ID, Env:FEISHU_APP_SECRET, Env:LARK_APP_ID, Env:LARK_APP_SECRET, Env:APP_ID, Env:APP_SECRET -ErrorAction SilentlyContinue

# 3. Relaunch via npx (detached, hidden). The package is scoped:
$npx = Get-Command npx -ErrorAction SilentlyContinue
if (-not $npx) { Log 'restart-dsh: FAILED - npx not on PATH'; exit 1 }
$npxShim = $npx.Source
Log ('restart-dsh: launching via ' + $npxShim)
$proc = Start-Process -FilePath 'pwsh' -ArgumentList @('-NoProfile', '-File', $npxShim, '--yes', '@deepseek-ai/dsh', 'web') -WorkingDirectory $repo -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog -PassThru
Log ('restart-dsh: spawned pid ' + $proc.Id)

# 4. Poll the feishu status endpoint until the full stack is up.
$up = $false
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Milliseconds 1000
  try {
    $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:3080/feishu/status' -TimeoutSec 3
    if ($resp.ok -eq $true) {
      Log ('restart-dsh: UP connected=' + $resp.connected + ' bindings=' + $resp.bindings.Count + ' version=' + $resp.appId)
      $up = $true
      break
    }
  } catch { }
}
if (-not $up) {
  Log 'restart-dsh: server did not come up within 120s (see dsh.stderr.log)'
  Get-Content $stderrLog -Tail 40 -ErrorAction SilentlyContinue | ForEach-Object { Log ('  stderr: ' + $_) }
}
Log 'restart-dsh: done'