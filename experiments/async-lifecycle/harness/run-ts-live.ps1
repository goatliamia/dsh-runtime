# run-ts-live.ps1 - same turn-stopping probe, but in the LIVE home so the
# trajectory-query plugin (ctx.sessionQuery of the live host) can read the
# resulting session logs as ground truth.
# ALL ASCII (PS 5.1 encoding discipline, docs/bugs/004).

param([string]$Only = 't1,t2,t3')

$ErrorActionPreference = 'Continue'
$env:Path = "$env:APPDATA\npm;$env:Path"

$ws      = '<HOME>\Documents\async-spike'
$liveHome = Join-Path $env:USERPROFILE '.dsh'
$results = Join-Path $ws 'results-ts-live'
$pkg     = Join-Path $ws 'pkg'
$log     = Join-Path $results 'driver.log'

New-Item -ItemType Directory -Force $results | Out-Null

function Log($m) {
  Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
}

Log '=== turn-stopping probe in LIVE home (trace-queryable) ==='

$cases = @(
  @{ id = 't1'; ts = '';       hold = 8000 },
  @{ id = 't2'; ts = 'inject'; hold = 8000 },
  @{ id = 't3'; ts = 'throw';  hold = 8000 }
)

foreach ($case in $cases) {
  $pd = Join-Path $liveHome "profiles\tsprobe-$($case.id)"
  if (-not (Test-Path (Join-Path $pd 'package.json'))) {
    New-Item -ItemType Directory -Force (Join-Path $pd 'node_modules') | Out-Null
    $manifest = "{`n  `"name`": `"dsh-profile-tsprobe-$($case.id)`",`n  `"private`": true,`n  `"dependencies`": {},`n  `"dsh`": {`n    `"profile`": {`n      `"bundles`": [`n        `"@deepseek-ai/dsh-base`",`n        `"dsh-async-spike`"`n      ],`n      `"patchReload`": `"startup`"`n    }`n  }`n}`n"
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
  $env:DSH_HOME            = $liveHome
  $env:SPIKE_TASK          = (Get-Content -Raw (Join-Path $ws 'task-t1.txt')).Trim()
  $env:SPIKE_EVENTS        = $events
  $env:SPIKE_HOLD_MS       = "$($case.hold)"
  $env:SPIKE_EXIT_ON       = 'none'
  Remove-Item Env:SPIKE_ORCHESTRATE -ErrorAction SilentlyContinue
  Remove-Item Env:SPIKE_DEMO -ErrorAction SilentlyContinue
  if ($case.ts -eq '') { Remove-Item Env:SPIKE_TS -ErrorAction SilentlyContinue } else { $env:SPIKE_TS = $case.ts }
  $env:SPIKE_TS_TEXT       = 'Runtime observation: a required check has not run yet. Reply with exactly CONTINUED-A and then end your turn.'
  $env:DSH_PERMISSION_MODE = 'danger-full-access'
  Remove-Item Env:DSH_TOOLS_MODE -ErrorAction SilentlyContinue
  $out = Join-Path $results "$($case.id).stdout.txt"
  $err = Join-Path $results "$($case.id).stderr.txt"
  Log "LAUNCH $($case.id) ts='$($case.ts)'"
  $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "dsh --profile tsprobe-$($case.id)" `
       -PassThru -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
  $running += [pscustomobject]@{ id = $case.id; proc = $p; sw = [Diagnostics.Stopwatch]::StartNew() }
}

foreach ($item in $running) {
  if (-not $item.proc.WaitForExit(240000)) {
    try { $item.proc.Kill() } catch { }
    Log "TIMEOUT $($item.id)"
  } else {
    Log ("END   {0} exit={1} elapsed={2}s" -f $item.id, $item.proc.ExitCode, [int]$item.sw.Elapsed.TotalSeconds)
  }
}

Log '=== done ==='
