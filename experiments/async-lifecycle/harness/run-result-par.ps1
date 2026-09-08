# run-result-par.ps1 - Phase 2 (result) run in PARALLEL.
# ALL ASCII (PS 5.1 encoding discipline, docs/bugs/004).
#
# Each case gets its OWN profile (al-r1..al-r4) so parallel boots never race on
# the same profile's composed root file. They share one isolated home, which is
# safe: sessions and projection caches are per-session, and the module fallback
# heal takes a cross-process lock.
#
# Model note: the isolated home's settings.yaml was switched to the same model
# this session runs (deepseek-v4.1-flash-expires-on-0910), so parent and child
# agents match the operator's model.

param([string]$Only = 'r1,r2,r3,r4')

$ErrorActionPreference = 'Continue'
$env:Path = "$env:APPDATA\npm;$env:Path"

$ws        = '<HOME>\Documents\async-spike'
$spikeHome = Join-Path $ws 'home'
$results   = Join-Path $ws 'results-result'
$log       = Join-Path $results 'driver.log'

New-Item -ItemType Directory -Force $results | Out-Null

function Log($m) {
  Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
}

Log '=== result phase-2 (parallel) start ==='

$cases = @(
  @{ id = 'r1'; file = 'task-r1.txt'; hold = 70000 },
  @{ id = 'r2'; file = 'task-r2.txt'; hold = 90000 },
  @{ id = 'r3'; file = 'task-r3.txt'; hold = 90000 },
  @{ id = 'r4'; file = 'task-r4.txt'; hold = 90000 }
)

$running = @()
foreach ($case in $cases) {
  if ($Only -notlike "*$($case.id)*") { continue }
  $events = Join-Path $results "$($case.id).jsonl"
  Remove-Item $events -Force -ErrorAction SilentlyContinue
  $env:DSH_HOME            = $spikeHome
  $env:SPIKE_TASK          = (Get-Content -Raw (Join-Path $ws $case.file)).Trim()
  $env:SPIKE_EVENTS        = $events
  $env:SPIKE_HOLD_MS       = "$($case.hold)"
  $env:SPIKE_EXIT_ON       = 'none'
  Remove-Item Env:SPIKE_ORCHESTRATE -ErrorAction SilentlyContinue
  $env:DSH_PERMISSION_MODE = 'danger-full-access'
  Remove-Item Env:DSH_TOOLS_MODE -ErrorAction SilentlyContinue
  $out = Join-Path $results "$($case.id).stdout.txt"
  $err = Join-Path $results "$($case.id).stderr.txt"
  Log "LAUNCH $($case.id) profile=al-$($case.id) hold=$($case.hold)ms"
  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "dsh --profile al-$($case.id)" `
       -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
  $running += [pscustomobject]@{ id = $case.id; proc = $p; sw = [Diagnostics.Stopwatch]::StartNew() }
}

foreach ($item in $running) {
  if (-not $item.proc.WaitForExit(300000)) {
    try { $item.proc.Kill() } catch { }
    Log "TIMEOUT $($item.id) (5 min limit)"
  } else {
    Log ("END   {0} exit={1} elapsed={2}s" -f $item.id, $item.proc.ExitCode, [int]$item.sw.Elapsed.TotalSeconds)
  }
}

Log '=== result phase-2 (parallel) end ==='
