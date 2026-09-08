# Async Execution lifecycle ownership — spike

Evidence harness for the question: **can the Runtime own async Subagent / background-Job
lifecycle and react when work actually settles, instead of the Agent waiting, checking, or polling?**

Full findings:
[`docs/status/async-execution-lifecycle-spike-2026-09-04.md`](../../docs/status/async-execution-lifecycle-spike-2026-09-04.md) (v1: settlement + wakeup),
[`docs/status/child-lifecycle-ownership-spike-2026-09-04.md`](../../docs/status/child-lifecycle-ownership-spike-2026-09-04.md) (v2: ownership tree, waiting semantics, result propagation),
[`docs/status/child-orchestration-semantics-phase1-2026-09-04.md`](../../docs/status/child-orchestration-semantics-phase1-2026-09-04.md) (phase 1: wait as a terminal-fact predicate).
This directory is the re-runnable harness plus the desensitized raw artifacts.

```text
pkg/       the spike bundle (one package, two loader rows)
  lib/fixture.js   observer: unscoped root scope + the delegating agent's own scope
  lib/fixture.js   also folds ctx.jobs.onJobDone / onJobsChanged (public service listeners)
  lib/facts.js     Runtime-owned settlement facts + the event-driven waiter
  lib/app.js       direct driver: runs ONE task turn, then holds the process open
  lib/state.js     shared leaf-field-only evidence recorder
tasks/     the three v1 probe prompts (ASCII)
tasks-v2/  the five child-lifecycle case prompts (ASCII)
tasks-orch/ the four phase-1 wait case prompts (ASCII)
harness/   run-spike.ps1 · analyze.mjs · run-lifecycle.ps1 · analyze-lifecycle.mjs
           run-orchestration.ps1 · analyze-orchestration.mjs · sync-to-repo.mjs
results/   v1: a|b|c .jsonl + driver log + home file snapshots (session ids aliased)
results-v2/ v2: case1..5 .jsonl + analysis.txt (causal timeline, roles derived from observed edges)
results-orch/ phase 1: a1..a4 .jsonl (wait outcomes, child status transitions)
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

## Child-lifecycle cases (v2)

| case | prompt | what it proves |
|---|---|---|
| 1 | P spawns C, ends the turn | settlement notice vs `subagent/end` ordering; duplicate relay content |
| 2 | C spawns G, C ends its turn; P sleeps then calls `list_agents` once | `waiting` is invisible: `list_agents` reports `idle` while C owns a live grandchild |
| 3 | P spawns C, C spawns G, both end their turns | ownership release bubbles up child-first; a parent cannot settle while it owns a live child |
| 4 | P spawns C, lists, then `interrupt_agent`s it | disposed terminal (`stopReason=aborted`); notice steered into a busy parent turn |
| 5 | C sleeps, sends a full report relay, then ends | a settlement notice opens an extra turn **after** the parent already answered |

## Orchestration phase 1 (wait)

| case | scenario | what it proves |
|---|---|---|
| a1 | normal wait, child runs 20s | the waiter resolves on the recorded terminal fact, not on idle |
| a2 | wait starts 12s after a fast child settled | already-settled path resolves in 1ms |
| a3 | child is idle while it owns a live grandchild | the waiter stays blocked 30.5s through the idle window — `idle` is not a terminal predicate |
| a4 | wait bound 8s, child runs 30s | timeout is a distinct outcome and is never resolved retroactively |

The waiter (`pkg/lib/facts.js`) consumes only `subagent/end`; the model is given no wait tool.

Artifacts are leaf-field JSONL: no Service, Agent, Session, or message object is ever serialized.
