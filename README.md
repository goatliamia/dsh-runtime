# DSH Runtime

[English](README.md) | [中文](README.zh-CN.md)

**Let the model do the thinking; let the Harness handle what can be determined.**

`dsh-runtime` is a set of small Runtime capabilities for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

It does not try to build a new Agent, and it does not try to teach the model everything through more prompts, skills, or rules.

It handles one class of problems:

> **Problems the model should not keep guessing about, because the Harness can already determine them.**

For example:

* May this action run right now?
* Did the last step actually change anything?
* The tool reported an error — but did the operation actually happen?
* The tool reported success — did the target state actually take effect?
* An action has been repeated many times — but is anything actually moving forward?

---

## Install

One command installs everything (all capabilities ship in one package; then pick the mode / scene preset / custom toggles in the settings page):

```powershell
# download release/dsh-runtime-0.1.0.tgz from the GitHub page, or clone the repo first
dsh plugin --profile <your-profile> add dsh-runtime-0.1.0.tgz
```

`dsh --profile <your-profile> --dump-config` should list runtime-progress / circuit / reconcile / investigate / seam — that is success.

- **Users never pick packages**: modes (Off / Minimal / Balanced / Strict), scene presets (Creative / Coding / External / Safe) and custom toggles all live in the Runtime settings page;
- **Developers, per capability**: `release/` also carries the five individual tarballs (progress + circuit + reconcile + investigate + seam), for when only some capabilities are wanted;
- **Developers rebuild**: run `node scripts/pack-release.mjs` after code changes to regenerate `release/`.

---

## How does it work?

A tool call produces four things. Runtime owns the last two:

```text
the model calls a tool        <- not the Runtime's layer
the session records an event  <- DSH Session
Runtime folds events into facts
policy decides whether to speak
```

The distinction that matters:

```text
tool error   ≠   effect didn't happen
tool success ≠   effect happened
```

A concrete case: `pwsh` exits 0 and the command really did run, but the change did not take effect (it wrote somewhere else, or a later step overwrote it). From the events:

```js
execution = "success"     // the command itself succeeded
effect    = "unknown"     // whether the world changed is not in the stream
```

These barely differ in simple tasks. In async jobs, deployments, plugins and external services they decide whether the next step should retry.

---

## Event is the source of facts

A DSH Session Event stream is the ledger of a run: **what happened, and in what order**. Every fact the Runtime needs is folded out of it, so there is no second "world state" to keep in sync.

The fold returns an ordinary object (`foldProjection(events)`, from `dsh-runtime-progress`):

```js
{
  axes: {
    execution: { turns: 1, steps: 4, toolCalls: 2, toolErrors: 1, turnOutcome: "completed" },
    effect: { exp_flaky: { callResult: "failed", worldEffect: "unknown" } },
  },
  verdict: { turn: "completed", execution: "failed", effect: { exp_flaky: "unknown" } },
  unknownFields: ["effects.exp_flaky.worldEffect"],
}
```

`verdict` is this turn's conclusion: execution failed, effect unknown. Fields the stream cannot answer land in `unknownFields` instead of a guess.

Progress is not a second piece of state; it answers one question, whether this step actually moved things forward.

---

## A few small capabilities

### Guard

Blocks, before execution, the actions that clearly must not run.

```js
seam.registerGuard({
  action: "pwsh",
  factPath: "runtime-progress.shell-lock",
  predicate: (value) => value !== "locked",
  predicateText: "pwsh requires runtime-progress.shell-lock != locked",
})
```

While the fact is `locked`, a `pwsh` call comes back with `[action-rejected]` and that
`predicateText`; the call never reaches execution.

### Progress

After execution, asks whether anything actually moved.

```js
const p = foldProjection(events)
p.verdict.execution   // "success" | "failed" | "none"
p.verdict.effect      // { toolName: "success" | "failed" | "unknown" }
```

"The command succeeded" and "the world moved" are two axes, reported separately.
It never stops, retries, or repairs anything — it only provides the judgment.

### Circuit

When the same action keeps failing with no progress, it says so once.

```js
registerCircuitContract({ id: "exp_flaky", match: { tool: "exp_flaky" }, threshold: 2 })
```

The unit is tool plus failure shape plus target, never just "tool". At the threshold the model
receives one observation:

```text
[runtime-observation circuit-open]
observed: "read" failed 2 times with the same failure on c:\repo\gone.mjs (threshold 2).
failure: Error: cannot read "<str>": not found
fact: capabilities.read.state = "stalled" (authority: runtime, revision: 1, fingerprint: ...)
```

It reports an observation and gives no order. It also does **not** reject: for filesystem tools,
read, write and edit are each other's remedy, and a rejection would deadlock the session.

### Reconcile

A non-atomic action that already ran once must not be replayed.

```js
registerNonAtomicContract({ id: "deploy", match: { tool: "pwsh", pattern: /deploy\.ps1/ } })
```

The second call is blocked with: "was already invoked once and its confirmation was lost; the
effect may already be applied, so a retry can duplicate the side effect."

### Delta

Tell the model only when a change worth noticing actually appears.

```js
{ role: "user",
  source: { kind: "plugin", plugin: "dsh-runtime-seam" },
  content: [{ type: "text", text: "[runtime-observation ...]" }] }
```

The change enters the next step as one user-role message. Runtime does not keep announcing
"still the same as before".

### Child orchestration

A parent delegates to background children; the orchestrator waits on the **terminal fact**,
never on a status.

```js
const fact = await ctx.childOrchestration.wait(childId, 30000)
// { outcome: "settled", stopReason: "completed", lastAssistantMessage: "..." }
```

`idle` is not "finished": a child that is quiescent while it still owns a live child is waiting,
not done. In measurement that wait never returned early across the 30.5 seconds the child looked
stopped. Semantics are frozen in
[`docs/20-child-orchestration-semantic-contract.md`](docs/20-child-orchestration-semantic-contract.md)
and measured in [`experiments/async-lifecycle/`](experiments/async-lifecycle/).

### Continuation (Pre)

When the facts and a declared contract compress the next step to exactly one deterministic action,
the Runtime executes it and the model only digests the outcome.

The first daily contract is `post-write-syntax-check`: after the model writes or edits workspace JS
modules, the runtime runs `node --check` itself and hands the model one digest:

```text
[runtime-continuation] deterministic step already executed by the runtime: post-write-syntax-check.
Do not re-run it; digest the outcome and continue from the current world state.
```

It goes through the normal tool pipeline (permission, guard, cancellation), so what the model sees
is a result that already happened, not a request. When it is not certain, it never takes over.
Driven by the `continuation` settings bit; see
[`docs/status/pre-productized-2026-09-03.md`](docs/status/pre-productized-2026-09-03.md).

---

## A simple example

The Agent runs:

> "Switch the plugin to fast mode."

It edits the configuration, and the build succeeds.

But the running plugin is still on the old mode.

A normal flow easily concludes:

```text
edit succeeded
→ build succeeded
→ done
```

A Runtime-aware flow keeps observing the actual state:

```text
execution succeeded
→ expected change not observed
→ investigate
→ still the old state
→ reload
→ confirm again
→ ready
```

Runtime is not doing the model's creative work here.

It only prevents mistaking:

> **"the tool finished"**

for:

> **"the thing finished".**

---

## Runtime should stay quiet

Runtime is not a new "master controller".

One important principle:

> **Where the model can see clearly on its own, Runtime does not need to act.**

In a normal coding task, Runtime should be able to not intervene at all.

It is worth intervening only when the Harness can clearly see something the model cannot reliably judge.

So Runtime is a thin layer of protection, not another Agent.

---

## Modes

The settings page is split into two independent axes:

| Axis | What it is | Choices |
| ---- | ---------- | ------- |
| **Pre (事前)** | One switch — `Continuation`: take over a deterministic next step when facts + contract make it unique | On / Off |
| **Post (事后)** | Intervention after execution: guard, circuit, reconcile, verify & repair | **Off / Minimal / Balanced / Strict / Custom** |

The two axes do not have to live in the same mode: the Post mode selects which after-the-fact responsibilities the Runtime takes, and the Pre switch is flipped independently.

You can also start from a scene preset (a shortcut that sets both axes at once):

**Creative · Coding · External Actions · Safe**

A mode only selects a different combination of Runtime capabilities; it never changes the model itself.

---

## Why not more Skills?

Some things genuinely belong in Skills.

For example:

> A working habit, a preference, a better practice for a scenario.

But some things do not belong at that layer:

> Did the file actually get written?
> Did the plugin actually load?
> Did the operation actually happen?
> Did the user actually approve?

If the Harness can determine these, the model should not have to remember a piece of text.

A simple principle:

> **Things that need understanding go to the model.**
>
> **Things that can be determined go to the Harness.**
>
> **Things that cannot be confirmed are admitted as unknown.**

---

## Evidence

This project has moved beyond design: a set of real DSH experiments is complete.

In deterministic scenarios:

* Repeated no-progress loops: real executions down **67%**
* Non-atomic failures: duplicate side effects down **75%**
* Success-but-not-effective: world correctness from **0/2 to 2/2**
* Normal coding: **0 false interventions**
* Async polling: no clear advantage in the tested scenario and model
* Deterministic continuation (rounds 1-4): the runtime takes over the unique deterministic step (**B model calls 15 vs A 19, −21%**), never executes stale / cancelled / guarded / ambiguous actions, abstains when facts are missing or misleading, and keeps instruction continuity — the model digests the already-happened facts and attributes them to the runtime honestly

These results mean Runtime's value is not "stronger everywhere".

Closer to the truth:

> **Where the model can see clearly, it stays quiet; where the model cannot see reality, it adds a bit of certainty.**

Full experiment process, raw data, and limitations: see [`docs/`](docs/) — in particular the Runtime Continuation line: [`docs/status/runtime-continuation-2026-09-02.md`](docs/status/runtime-continuation-2026-09-02.md) (proposition), [`runtime-continuation-boundaries-2026-09-02.md`](docs/status/runtime-continuation-boundaries-2026-09-02.md) (boundaries), [`runtime-continuation-instruction-2026-09-02.md`](docs/status/runtime-continuation-instruction-2026-09-02.md) (instruction continuity), [`runtime-continuation-ownership-2026-09-03.md`](docs/status/runtime-continuation-ownership-2026-09-03.md) (ownership boundary), and the four-round summary [`runtime-continuation-summary-2026-09-03.md`](docs/status/runtime-continuation-summary-2026-09-03.md).

Three later lines have their own reports:

* child orchestration — [`docs/20-child-orchestration-semantic-contract.md`](docs/20-child-orchestration-semantic-contract.md) (frozen semantics, including the 30.5-second negative case that disqualified `idle` as a terminal predicate)
* turn stopping — [`docs/status/turn-stopping-continuation-and-cost-2026-09-11.md`](docs/status/turn-stopping-continuation-and-cost-2026-09-11.md) (is the checkpoint a legal continuation point, and what does injecting there cost), with the mechanism written up in [`docs/21-turn-continuation-and-injection.md`](docs/21-turn-continuation-and-injection.md)
* the circuit's filesystem false positives — [`docs/status/circuit-fingerprint-vs-fs-errors-2026-09-11.md`](docs/status/circuit-fingerprint-vs-fs-errors-2026-09-11.md) (two different files collapsed into one fingerprint, and the fix)

---

## Project Status

This is still an experiment-driven collection of small Runtime capabilities.

It does not aim to become a new Agent framework, nor to re-implement DSH's underlying runtime.

Capabilities should grow out of real problems:

```text
A real problem
  ↓
Find the determinable facts
  ↓
A minimal Runtime capability
  ↓
Validate it for real
  ↓
See it repeat
  ↓
Only then consider abstraction
```

**Solve one concrete problem first, rather than designing a complete system up front.**

---

## Repository

This repository currently focuses on:

* DSH Runtime capability experiments
* Runtime / Event / Progress research
* Real Agent trajectory validation
* DSH plugin combinations and scenario experiments

Installation and usage follow each capability's documentation; this repository itself is not an Agent application you start on its own.

---

## License

See [LICENSE](LICENSE).


# Finally: why a Plugin?

Because we do not claim to know what the final structure of an Agent should be.

This project only observed one very concrete fact:

> **In real Agent runs, some work is already deterministic enough that it should not keep occupying the model's reasoning space.**

If that work can be separated out, the most natural way is not to push it all back into Core.

Instead:

```text
Real friction
      ↓
Deterministic part
      ↓
Capability
      ↓
Plugin
      ↓
Harness
```

Today it may be Runtime.

Tomorrow it may be something else.

There is no need to know in advance.

---

# A simple enough principle, for now

```text
If the model still needs to judge,
let the model judge.

If the program already knows the answer,
don't make the model rediscover it.

If reality has already said no,
don't let the model decide whether it may run.

If reality has not changed,
don't tell the model.

If a path has stopped making progress,
don't let it continue forever.

If state already exists,
that does not mean it must be re-injected.

If the user's intent may be wrong,
protect reality, but don't redefine the user's intent for them.
```

> **Agent = Model + Harness**

This repository is only exploring one question:

> **Which part should the Harness actually take over?**
