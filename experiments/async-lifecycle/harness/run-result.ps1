# run-result.ps1 - Child Orchestration Semantics Spike, Phase 2 (result).
# ALL ASCII (PS 5.1 encoding discipline, docs/bugs/004).
#
# Question: is a child's "result" an execution outcome (settlement) or a
# collaboration message (report)? The child emits BOTH: a send_message report
# before its final answer, and then its final assistant text. Four contexts:
#
#   R1  parent idle
#   R2  parent busy (foreground sleep when the child reports)
#   R3  two children reporting independently
#   R4  nested (grandchild reports to the child, child reports to the parent)

param([string]$Only = 'r1,r2,r3,r4')

$ErrorActionPreference = 'Continue'
$env:Path = "$env:APPDATA\npm;$env:Path"

$ws        = '<HOME>\Documents\async-spike'
$spikeHome = Join-Path $ws 'home'
$results   = Join-Path $ws 'results-result'
$profile   = 'al-a'
$log       = Join-Path $results 'driver.log'

New-Item -ItemType Directory -Force $results | Out-Null

function Log($m) {
  Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
}

Log '=== result phase-2 start ==='

function Run-Result($id, $taskFile, $holdMs) {
  $events = Join-Path $results "$id.jsonl"
  Remove-Item $events -Force -ErrorAction SilentlyContinue
  $env:DSH_HOME            = $spikeHome
  $env:SPIKE_TASK          = (Get-Content -Raw (Join-Path $ws $taskFile)).Trim()
  $env:SPIKE_EVENTS        = $events
  $env:SPIKE_HOLD_MS       = "$holdMs"
  $env:SPIKE_EXIT_ON       = 'none'
  Remove-Item Env:SPIKE_ORCHESTRATE -ErrorAction SilentlyContinue
  $env:DSH_PERMISSION_MODE = 'danger-full-access'
  Remove-Item Env:DSH_TOOLS_MODE -ErrorAction SilentlyContinue
  $out = Join-Path $results "$id.stdout.txt"
  $err = Join-Path $results "$id.stderr.txt"
  Log "START $id hold=${holdMs}ms"
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "dsh --profile $profile" `
       -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
  if (-not $p.WaitForExit(300000)) {
    try { $p.Kill() } catch { }
    Log "TIMEOUT $id (5 min limit)"
  } else {
    Log ("END   {0} exit={1} elapsed={2}s" -f $id, $p.ExitCode, [int]$sw.Elapsed.TotalSeconds)
  }
}

if ($Only -like '*r1*') { Run-Result 'r1' 'task-r1.txt' 70000 }
if ($Only -like '*r2*') { Run-Result 'r2' 'task-r2.txt' 90000 }
if ($Only -like '*r3*') { Run-Result 'r3' 'task-r3.txt' 90000 }
if ($Only -like '*r4*') { Run-Result 'r4' 'task-r4.txt' 90000 }

Log '=== result phase-2 end ==='
