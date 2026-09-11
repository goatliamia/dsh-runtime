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

The simplest way to understand it:

```text
Model
  ↓
Tool
  ↓
Runtime
  ↓
The real world
  ↓
Event
  ↓
Runtime / Policy
  ↓
Next step
```

Tools are responsible for **doing things**.

Events are responsible for recording **what happened**.

Runtime derives the judgments it needs from what already happened, and only then decides whether to intervene.

Hence:

```text
tool error   ≠   effect didn't happen
tool success ≠   effect happened
```

These two distinctions barely matter in simple tasks, but they matter more and more in async jobs, deployments, plugins, external services, and dynamic runtimes.

---

## Event is the source of facts

A DSH Session Event stream can be thought of as the ledger of a run.

It records:

> What happened, and in what order.

Need the current state? Derive the current facts from the events. Need to know what just changed? The events have that too.

So Runtime does not need to maintain a parallel "world state" next to DSH.

For example:

```text
Event
  ↓
Current facts
  ↓
Recent changes
  ↓
Progress
```

Progress itself is not another piece of state.

It only answers:

> **Did this step actually move things forward?**

When the facts are insufficient, the honest answer is `unknown` — not a guess.

---

## A few small capabilities

### Guard

Handles deterministic boundary questions before execution.

> **May this run right now?**

For example: an action that clearly should not execute gets blocked before execution.

### Progress

Observes what actually changed after execution.

> **Did anything actually progress?**

It never stops, retries, or repairs anything — it only provides the judgment.

### Circuit

When an action keeps failing and the world keeps showing no progress:

> **Do not keep repeating the same thing.**

### Reconcile

When the execution result and the real-world state may disagree:

> **Confirm reality first, then decide the next step.**

For example: the tool returned a failure, but the external state already changed — so do not simply re-execute.

### Delta

Tell the model only when a change worth noticing actually appears.

Runtime does not need to keep announcing "still the same as before".

### Child orchestration

Background children are how a parent agent delegates work. The runtime already knows *what
happened* — a child started, settled, and released its ownership — so the orchestrator never has
to ask.

```text
spawn  ->  wait  ->  query the child's own trajectory  ->  the model decides what it means
```

- **wait** consumes the terminal fact (`subagent/end`), never a status: `idle` is not "finished",
  and a child that is quiescent while it still owns a live child is *waiting*, not done.
- **query** re-reads what actually happened from the child's own durable session, after it settled.
- the model never polls, never sees the runtime's private residency state, and is never handed a
  made-up "result": what a child produced is a judgement, not a fact the harness can own.

Ships as `ctx.childOrchestration` (`wait` / `waitAll` / `residency`) in `dsh-runtime-orchestration`.
Semantics are frozen in
[`docs/20-child-orchestration-semantic-contract.md`](docs/20-child-orchestration-semantic-contract.md)
and measured in [`experiments/async-lifecycle/`](experiments/async-lifecycle/).

### Continuation (Pre)

When the facts and a declared contract compress the next step to exactly one deterministic action, the Runtime executes it directly — through the normal permission / guard / cancellation boundary — and the model only digests what already happened.

When it is not certain, it never takes over. The engine is productized inside `dsh-runtime-seam`
(driven by the `continuation` settings bit) with the first daily contract, `post-write-syntax-check`:
after the model writes/edits workspace JS modules, the runtime runs `node --check` on them and
hands the model one digest. See [`docs/status/pre-productized-2026-09-03.md`](docs/status/pre-productized-2026-09-03.md).

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
