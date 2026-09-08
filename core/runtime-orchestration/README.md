# dsh-runtime-orchestration

Thin **child orchestration layer** for DSH: `wait` on a child's terminal fact, derive its
residency, wait for many. It consumes official facts only and registers **no model tool**.

Implements the layer defined by
[`docs/20-child-orchestration-semantic-contract.md`](../../docs/20-child-orchestration-semantic-contract.md).

```text
Runtime  : publishes what happened      (subagent/start|end, ownership, agent/status)
THIS     : decides how to use the facts (wait / waitAll / residency)
Model    : decides what they mean       (no tool here on purpose)
```

## Install

```powershell
dsh plugin --profile <profile> add <dsh-runtime-orchestration-0.1.0.tgz>
# then add "dsh-runtime-orchestration" to the profile's dsh.profile.bundles
```

## API — `ctx.childOrchestration`

| call | returns | notes |
|---|---|---|
| `wait(childId, timeoutMs)` | `{ outcome: 'settled', stopReason, lastAssistantMessage, … }` or `{ outcome: 'timeout', childId }` | resolves from the recorded fact immediately when the child already settled; a timeout **never** resolves retroactively |
| `waitAll(childIds, timeoutMs)` | one result per id | per-child outcomes are kept |
| `residency(sessionId)` | `'settled' \| 'running' \| 'waiting' \| 'idle' \| 'unknown'` | derived from `subagent/start|end` + `agent/status`; `waiting` means *quiescent while still owning a live child* |
| `childrenOf(parentId)` | child ids in observation order | from the delegation edge |
| `terminalFact(childId)` | the recorded fact or `undefined` | the same fact `wait` consumes |

## What it deliberately does not do

Per the contract's **Non-goals**:

- no `subagent-waiting` event or notice;
- no `get_subagent_result()` / result primitive;
- no polling of `list_agents` or `Agent.status` as a completion check;
- no DSH core patch, no new persisted state;
- **no model-facing tool** — putting `wait` in the model's toolset would move orchestration
  back into the model, which is exactly what the evidence says not to do.

`idle` is never terminal. A child that is quiescent while it owns a live grandchild derives
`waiting`; `wait` stays pending through that window and resolves only on `subagent/end`
(measured: 30.5 s of idle before the real edge).

## Evidence

- `experiments/async-lifecycle/` — 21 pinned semantics on `0.1.2-rc.1` and `0.1.3-alpha.2`;
  phase 1 (wait), phase 2 (report vs settlement), phase 3 (residency derivation), e2e demo.
- `test/orchestration.test.mjs` — the semantics above, as plain-node assertions:
  `node test/orchestration.test.mjs` → `ALL PASS`.

## Scope note

This package is the *reusable* half of the spike: it removes the need for every orchestrator
to re-derive the same facts and re-learn the same traps. It is **not** included in the
`dsh-runtime` umbrella bundle — mount it only where an orchestration layer actually consumes it.
