# Async Execution lifecycle ownership — spike

Evidence harness for the question: **can the Runtime own async Subagent / background-Job
lifecycle and react when work actually settles, instead of the Agent waiting, checking, or polling?**

Full findings: [`docs/status/async-execution-lifecycle-spike-2026-09-04.md`](../../docs/status/async-execution-lifecycle-spike-2026-09-04.md).
This directory is the re-runnable harness plus the desensitized raw artifacts.

```text
pkg/       the spike bundle (one package, two loader rows)
  lib/fixture.js   observer: unscoped root scope + the delegating agent's own scope
  lib/fixture.js   also folds ctx.jobs.onJobDone / onJobsChanged (public service listeners)
  lib/app.js       direct driver: runs ONE task turn, then holds the process open
  lib/state.js     shared leaf-field-only evidence recorder
tasks/     the three probe prompts (ASCII)
harness/   run-spike.ps1 (driver) · analyze.mjs (fold) · sync-to-repo.mjs (desensitize)
results/   a|b|c .jsonl + driver log + home file snapshots (session ids aliased)
```

## Why the driver is not `dsh --profile headless`

`@deepseek-ai/dsh-headless` exits right after the task turn reaches idle
(`lib/index.js:158-166`), so a post-idle platform resume cannot be observed at all.
`pkg/lib/app.js` is the same direct driver minus that exit: it creates one agent, sends one
task, waits for the first idle, then holds the process open until the platform delivers a
settlement signal (or the hold window expires). It never waits on, checks, or polls a child
or a job.

## Run

```powershell
# 1. drive the cells (isolated home is created from scratch; live ~/.dsh is untouched)
pwsh -File harness/run-spike.ps1 -Only 'a,b,c'

# 2. fold the artifacts
node harness/analyze.mjs "$env:USERPROFILE\Documents\async-spike\results"

# 3. desensitize + copy artifacts back here (one-shot ingestion, like scripts/sanitize-evidence.mjs)
node harness/sync-to-repo.mjs
```

Environment notes that matter for reproducing this:

- The isolated home inherits the launching harness environment. Under a confined file sandbox
  (`workspace-write`) every nested process spawn fails with `EPERM` and the cells are worthless;
  run the driver with full file access.
- The driver sets `DSH_PERMISSION_MODE=danger-full-access` for the isolated sessions
  (dsh-base reads it for `sandbox-policy.mode`).
- `SPIKE_TASK` / `SPIKE_EVENTS` / `SPIKE_HOLD_MS` / `SPIKE_EXIT_ON` are the driver's knobs.

## Cells

| cell | prompt | what it proves |
|---|---|---|
| a | one `subagent` call (`backgroundMode: continuable`), then end the turn | parent-scope + root-scope `subagent/start|end` fold; platform auto-resume |
| b | one `pwsh` call with `run_in_background: true`, then end the turn | user-role wakeup notice; `jobs.onJobDone`/`onJobsChanged` observability |
| c | fresh process: `job_list` | job state does not survive a host restart |

Artifacts are leaf-field JSONL: no Service, Agent, Session, or message object is ever serialized.
