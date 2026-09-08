# run-spike.ps1 - Runtime line, async Execution lifecycle ownership spike.
# ALL ASCII (PS 5.1 encoding discipline, docs/bugs/004).
#
# Isolated DSH home + a bundle that (a) observes the platform's async lifecycle
# from an unscoped root context and (b) holds the process open past the first
# idle, so a platform-native resume can be observed instead of racing exit.
# The live ~/.dsh home is never touched; only two config files are copied in.

param([string]$Only = 'a,b,c')

$ErrorActionPreference = 'Continue'
$env:Path = "$env:APPDATA\npm;$env:Path"

$ws        = '<HOME>\Documents\async-spike'
$spikeHome = Join-Path $ws 'home'
$results   = Join-Path $ws 'results'
$pkg       = Join-Path $ws 'pkg'
$srcHome   = '<HOME>\.dsh-native-pp-exp'
$profile   = 'al-a'
$profDir   = Join-Path $spikeHome "profiles\$profile"
$log       = Join-Path $results 'driver.log'

New-Item -ItemType Directory -Force $results | Out-Null
New-Item -ItemType Directory -Force $spikeHome | Out-Null
New-Item -ItemType Directory -Force $profDir | Out-Null
New-Item -ItemType Directory -Force (Join-Path $profDir 'node_modules') | Out-Null

function Log($m) {
  Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
}

Log '=== spike start ==='

# 1. Isolated home: copy only credentials/settings from the existing experiment
#    home. No session, storage, or plugin state is carried over.
foreach ($f in @('.credentials.yaml', 'settings.yaml', '.anonymous-user-id')) {
  $src = Join-Path $srcHome $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $spikeHome $f) -Force }
}
Log 'isolated home prepared'

# 2. Profile manifest: dsh-base plus the spike bundle only.
$manifest = @'
{
  "name": "dsh-profile-al-a",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-async-spike"
      ],
      "patchReload": "startup"
    }
  }
}
'@
Set-Content -Path (Join-Path $profDir 'package.json') -Value $manifest -Encoding ASCII

# 3. Link the spike package into the profile's own node_modules.
$link = Join-Path $profDir "node_modules\dsh-async-spike"
if (Test-Path $link) { Remove-Item $link -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Junction -Path $link -Target $pkg | Out-Null
Log "junction: $link -> $pkg"

# 3b. Node resolves a junctioned package to its REAL path, so the bundle's own
#     imports need a resolution anchor at that real location too.
$scopeDir = Join-Path $pkg 'node_modules\@deepseek-ai'
$scopeTarget = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai'
if (-not (Test-Path $scopeDir)) {
  New-Item -ItemType Directory -Force (Split-Path $scopeDir) | Out-Null
  New-Item -ItemType Junction -Path $scopeDir -Target $scopeTarget | Out-Null
  Log "scope junction: $scopeDir -> $scopeTarget"
}

# 4. Compose check: the dump must list both spike rows.
$env:DSH_HOME = $spikeHome
$dump = Join-Path $results 'dump-config.txt'
& dsh --profile $profile --dump-config *> $dump
Log "dump-config exit=$LASTEXITCODE"

function Snapshot-Home($tag) {
  $out = Join-Path $results "home-files-$tag.txt"
  Get-ChildItem $spikeHome -Recurse -File -Force -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName.Substring($spikeHome.Length + 1) } |
    Sort-Object | Out-File $out -Encoding ASCII
  Log "home snapshot $tag -> $out"
}

Snapshot-Home 'before'

function Run-Cell($id, $taskFile, $holdMs, $exitOn) {
  $events = Join-Path $results "$id.jsonl"
  Remove-Item $events -Force -ErrorAction SilentlyContinue
  $env:DSH_HOME           = $spikeHome
  $env:SPIKE_TASK         = (Get-Content -Raw (Join-Path $ws $taskFile)).Trim()
  $env:SPIKE_EVENTS       = $events
  $env:SPIKE_HOLD_MS      = "$holdMs"
  $env:SPIKE_EXIT_ON      = "$exitOn"
  $env:DSH_PERMISSION_MODE = 'danger-full-access'
  Remove-Item Env:DSH_TOOLS_MODE -ErrorAction SilentlyContinue
  $out = Join-Path $results "$id.stdout.txt"
  $err = Join-Path $results "$id.stderr.txt"
  Log "START $id hold=${holdMs}ms exitOn=$exitOn"
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

# Cell A: one continuable background spawn; the parent never waits or checks.
# Waits for the platform's own subagent settlement edge, not just the resume.
if ($Only -like '*a*') {
  Run-Cell 'a' 'task-a.txt' 180000 'subagent-end'
  Snapshot-Home 'after-a'
}

# Cell B: one background job; the parent never waits or checks.
if ($Only -like '*b*') {
  Run-Cell 'b' 'task-b.txt' 180000 'job-done'
  Snapshot-Home 'after-b'
}

# Cell C: a FRESH process in the same home asks the model to list its jobs.
if ($Only -like '*c*') {
  Run-Cell 'c' 'task-c.txt' 15000 'none'
  Snapshot-Home 'after-c'
}

# 5. Post-run: did the background job's OS process outlive the host?
$probe = Join-Path $results 'post-processes.txt'
Get-Process | Where-Object { $_.ProcessName -match 'pwsh|powershell' } |
  Select-Object Id, ProcessName, StartTime | Format-Table -AutoSize |
  Out-File $probe -Encoding ASCII
Log '=== spike end ==='

