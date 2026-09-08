# run-residency-par.ps1 - Phase 3 (residency) run in PARALLEL.
# ALL ASCII (PS 5.1 encoding discipline, docs/bugs/004).
#
# Question: is `waiting` a model-facing fact or an orchestration-facing one?
# The fixture derives a third-party residency state from OFFICIAL facts only
# (subagent/start|end + agent/status + ownership edges) and records every
# transition. Cases:
#
#   W1  child parks while it owns a live grandchild  -> waiting expected
#   W2  child parks with no live child (control)     -> idle, never waiting
#   W3  fast grandchild                              -> full transition path

param([string]$Only = 'w1,w2,w3')

$ErrorActionPreference = 'Continue'
$env:Path = "$env:APPDATA\npm;$env:Path"

$ws        = '<HOME>\Documents\async-spike'
$spikeHome = Join-Path $ws 'home'
$results   = Join-Path $ws 'results-residency'
$pkg       = Join-Path $ws 'pkg'
$log       = Join-Path $results 'driver.log'

New-Item -ItemType Directory -Force $results | Out-Null

function Log($m) {
  Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
}

Log '=== residency phase-3 (parallel) start ==='

$cases = @(
  @{ id = 'w1'; file = 'task-w1.txt'; hold = 60000 },
  @{ id = 'w2'; file = 'task-w2.txt'; hold = 25000 },
  @{ id = 'w3'; file = 'task-w3.txt'; hold = 45000 }
)

# One profile per case so parallel boots never race on a shared composed root.
foreach ($case in $cases) {
  $pd = Join-Path $spikeHome "profiles\al-$($case.id)"
  if (-not (Test-Path (Join-Path $pd 'package.json'))) {
    New-Item -ItemType Directory -Force (Join-Path $pd 'node_modules') | Out-Null
    $manifest = "{`n  `"name`": `"dsh-profile-al-$($case.id)`",`n  `"private`": true,`n  `"dependencies`": {},`n  `"dsh`": {`n    `"profile`": {`n      `"bundles`": [`n        `"@deepseek-ai/dsh-base`",`n        `"dsh-async-spike`"`n      ],`n      `"patchReload`": `"startup`"`n    }`n  }`n}`n"
    Set-Content -Path (Join-Path $pd 'package.json') -Value $manifest -Encoding ASCII
  }
  $link = Join-Path $pd 'node_modules\dsh-async-spike'
  if (-not (Test-Path $link)) { New-Item -ItemType Junction -Path $link -Target $pkg | Out-Null }
}

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

Log '=== residency phase-3 (parallel) end ==='
