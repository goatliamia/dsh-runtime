# run-lifecycle.ps1 - Child Lifecycle / Ownership Spike (5 cases).
# ALL ASCII (PS 5.1 encoding discipline, docs/bugs/004).
#
# Same isolated home / profile / bundle as run-spike.ps1; the bundle is unchanged
# (fixture observes, app holds the process open past the first idle). Only the
# task text and the case set differ.
#
# Cases:
#   1  P -> C -> settled
#   2  P -> C -> waiting (C owns a live grandchild, C itself quiescent)
#   3  P -> C -> G -> settled (ownership release bubbling up)
#   4  P -> C -> disposed (parent interrupts the child)
#   5  P -> C -> settled + full report (ordering / duplication)

param([string]$Only = '1,2,3,4,5')

$ErrorActionPreference = 'Continue'
$env:Path = "$env:APPDATA\npm;$env:Path"

$ws        = '<HOME>\Documents\async-spike'
$spikeHome = Join-Path $ws 'home'
$results   = Join-Path $ws 'results-v2'
$pkg       = Join-Path $ws 'pkg'
$profile   = 'al-a'
$profDir   = Join-Path $spikeHome "profiles\$profile"
$log       = Join-Path $results 'driver.log'

New-Item -ItemType Directory -Force $results | Out-Null

function Log($m) {
  Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
}

Log '=== lifecycle spike start ==='

# The isolated home and profile are already materialized by run-spike.ps1; this
# driver only needs the junction to exist.
$link = Join-Path $profDir "node_modules\dsh-async-spike"
if (-not (Test-Path $link)) {
  New-Item -ItemType Directory -Force (Split-Path $link) | Out-Null
  New-Item -ItemType Junction -Path $link -Target $pkg | Out-Null
  Log "junction created: $link"
}

function Run-Case($id, $taskFile, $holdMs, $exitOn) {
  $events = Join-Path $results "case$id.jsonl"
  Remove-Item $events -Force -ErrorAction SilentlyContinue
  $env:DSH_HOME           = $spikeHome
  $env:SPIKE_TASK         = (Get-Content -Raw (Join-Path $ws $taskFile)).Trim()
  $env:SPIKE_EVENTS       = $events
  $env:SPIKE_HOLD_MS      = "$holdMs"
  $env:SPIKE_EXIT_ON      = "$exitOn"
  $env:DSH_PERMISSION_MODE = 'danger-full-access'
  Remove-Item Env:DSH_TOOLS_MODE -ErrorAction SilentlyContinue
  $out = Join-Path $results "case$id.stdout.txt"
  $err = Join-Path $results "case$id.stderr.txt"
  Log "START case$id hold=${holdMs}ms exitOn=$exitOn"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "dsh --profile $profile" `
       -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
  if (-not $p.WaitForExit(300000)) {
    try { $p.Kill() } catch { }
    Log "TIMEOUT case$id (5 min limit)"
  } else {
    Log ("END   case{0} exit={1} elapsed={2}s" -f $id, $p.ExitCode, [int]$sw.Elapsed.TotalSeconds)
  }
}

if ($Only -like '*1*') { Run-Case '1' 'task-1.txt' 60000 'subagent-end:1' }
if ($Only -like '*2*') { Run-Case '2' 'task-2.txt' 120000 'none' }
if ($Only -like '*3*') { Run-Case '3' 'task-3.txt' 120000 'subagent-end:2' }
if ($Only -like '*4*') { Run-Case '4' 'task-4.txt' 90000 'none' }
if ($Only -like '*5*') { Run-Case '5' 'task-5.txt' 120000 'none' }

Log '=== lifecycle spike end ==='
