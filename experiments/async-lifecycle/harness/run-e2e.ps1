# run-e2e.ps1 - Child Orchestration End-to-End Demo.
# ALL ASCII (PS 5.1 encoding discipline, docs/bugs/004).
#
# One run, one task: the parent spawns four children with four different shapes
# (plain completion / waiting-then-done / collaboration-then-done / long-running
# then interrupted). The ORCHESTRATOR (the app driver, not the model) waits for
# every child, queries each settled child's own trajectory through the official
# sessionQuery service, and hands the model one digest. The model never sees
# `waiting`, never polls, and never reads a lifecycle event.

$ErrorActionPreference = 'Continue'
$env:Path = "$env:APPDATA\npm;$env:Path"

$ws        = '<HOME>\Documents\async-spike'
$spikeHome = Join-Path $ws 'home'
$results   = Join-Path $ws 'results-e2e'
$pkg       = Join-Path $ws 'pkg'
$profile   = 'al-demo'
$profDir   = Join-Path $spikeHome "profiles\$profile"
$log       = Join-Path $results 'driver.log'

New-Item -ItemType Directory -Force $results | Out-Null

function Log($m) {
  Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
}

Log '=== e2e demo start ==='

if (-not (Test-Path (Join-Path $profDir 'package.json'))) {
  New-Item -ItemType Directory -Force (Join-Path $profDir 'node_modules') | Out-Null
  $manifest = "{`n  `"name`": `"dsh-profile-$profile`",`n  `"private`": true,`n  `"dependencies`": {},`n  `"dsh`": {`n    `"profile`": {`n      `"bundles`": [`n        `"@deepseek-ai/dsh-base`",`n        `"dsh-async-spike`"`n      ],`n      `"patchReload`": `"startup`"`n    }`n  }`n}`n"
  Set-Content -Path (Join-Path $profDir 'package.json') -Value $manifest -Encoding ASCII
}
$link = Join-Path $profDir 'node_modules\dsh-async-spike'
if (-not (Test-Path $link)) { New-Item -ItemType Junction -Path $link -Target $pkg | Out-Null }

$events = Join-Path $results 'e2e.jsonl'
Remove-Item $events -Force -ErrorAction SilentlyContinue
$env:DSH_HOME            = $spikeHome
$env:SPIKE_TASK          = (Get-Content -Raw (Join-Path $ws 'task-e2e.txt')).Trim()
$env:SPIKE_EVENTS        = $events
$env:SPIKE_HOLD_MS       = '4000'
$env:SPIKE_EXIT_ON       = 'none'
$env:SPIKE_DEMO          = 'e2e'
Remove-Item Env:SPIKE_ORCHESTRATE -ErrorAction SilentlyContinue
$env:DSH_PERMISSION_MODE = 'danger-full-access'
Remove-Item Env:DSH_TOOLS_MODE -ErrorAction SilentlyContinue

$out = Join-Path $results 'e2e.stdout.txt'
$err = Join-Path $results 'e2e.stderr.txt'
Log 'LAUNCH e2e'
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "dsh --profile $profile" `
     -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
if (-not $p.WaitForExit(420000)) {
  try { $p.Kill() } catch { }
  Log 'TIMEOUT e2e (7 min limit)'
} else {
  Log ("END   e2e exit={0} elapsed={1}s" -f $p.ExitCode, [int]$sw.Elapsed.TotalSeconds)
}

Log '=== e2e demo end ==='
