# run-orchestration.ps1 - Child Orchestration Semantics Spike, Phase 1 (wait).
# ALL ASCII (PS 5.1 encoding discipline, docs/bugs/004).
#
# The waiter is Runtime-side (option 2): the model gets no wait tool. The
# terminal predicate is ONLY the recorded `subagent/end` fact -- never
# list_agents, never Agent.status.
#
#   A1  normal wait        child runs 20s, wait resolves on settlement
#   A2  already-settled    wait starts 12s after a fast child already settled
#   A3  waiting negative   child is idle while it owns a live grandchild
#   A4  timeout            wait bound 8s, child runs 30s

param([string]$Only = 'a1,a2,a3,a4')

$ErrorActionPreference = 'Continue'
$env:Path = "$env:APPDATA\npm;$env:Path"

$ws        = '<HOME>\Documents\async-spike'
$spikeHome = Join-Path $ws 'home'
$results   = Join-Path $ws 'results-orch'
$profile   = 'al-a'
$log       = Join-Path $results 'driver.log'

New-Item -ItemType Directory -Force $results | Out-Null

function Log($m) {
  Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
}

Log '=== orchestration phase-1 start ==='

function Run-Orch($id, $taskFile, $delayMs, $timeoutMs, $tailMs) {
  $events = Join-Path $results "$id.jsonl"
  Remove-Item $events -Force -ErrorAction SilentlyContinue
  $env:DSH_HOME            = $spikeHome
  $env:SPIKE_TASK          = (Get-Content -Raw (Join-Path $ws $taskFile)).Trim()
  $env:SPIKE_EVENTS        = $events
  $env:SPIKE_HOLD_MS       = '1500'
  $env:SPIKE_EXIT_ON       = 'none'
  $env:SPIKE_ORCHESTRATE   = 'wait'
  $env:SPIKE_WAIT_DELAY_MS = "$delayMs"
  $env:SPIKE_WAIT_TIMEOUT_MS = "$timeoutMs"
  $env:SPIKE_TAIL_MS       = "$tailMs"
  $env:DSH_PERMISSION_MODE = 'danger-full-access'
  Remove-Item Env:DSH_TOOLS_MODE -ErrorAction SilentlyContinue
  $out = Join-Path $results "$id.stdout.txt"
  $err = Join-Path $results "$id.stderr.txt"
  Log "START $id delay=${delayMs}ms timeout=${timeoutMs}ms tail=${tailMs}ms"
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

if ($Only -like '*a1*') { Run-Orch 'a1' 'task-a1.txt' 0 60000 2000 }
if ($Only -like '*a2*') { Run-Orch 'a2' 'task-a2.txt' 12000 5000 2000 }
if ($Only -like '*a3*') { Run-Orch 'a3' 'task-a3.txt' 0 90000 3000 }
if ($Only -like '*a4*') { Run-Orch 'a4' 'task-a4.txt' 0 8000 45000 }

Log '=== orchestration phase-1 end ==='
