# Child Lifecycle / Ownership Spike（2026-09-04）

- 状态：**已闭环**（5 个 case，全部真实模型轮，父侧从不 wait/check/poll）
- 承接：`docs/status/async-execution-lifecycle-spike-2026-09-04.md`（v1：subagent/job 的完成与唤醒）
- 证据：`experiments/async-lifecycle/results-v2/case1..5.jsonl`（脱敏，session 别名化）
- harness：`experiments/async-lifecycle/harness/run-lifecycle.ps1` + `analyze-lifecycle.mjs`

> 本 spike 只回答"子代生命周期到底是什么 primitive"，**不碰 Memory、不做工具开发**。

## 0. 先修正一处术语（源码级）

| 说法 | 实际 |
|---|---|
| child 有 `running → waiting → settled` 状态机 | 状态机存在，但**不是对外状态**。`AgentStatus = 'idle' \| 'running'`（`dsh-agent/lib/types/runtime-types.d.ts:48`），没有 `waiting` |
| — | `running \| waiting \| settled` 是 continuation manager **私有**的 residency 推导（`dsh-subagent/lib/types/continuation.d.ts:285-293` `stateOf`）：agent 静默 **且** 仍持有活 child → `waiting` |
| `list_agents` 把 waiting 压成 idle | **成立，且是设计如此**：`statusOf()` 只返回 `running`（agent 正在跑）/ `idle`（resident 但不在轮次中，"it may be waiting on agents it started"）/ `ready`（无 live agent）。工具描述里明写了这句 |
| settlement notification ≠ wait | **成立**：`subagent-settled` 是一条 inbox user 消息（`SubagentSettledMessageSource`），不是可 await 的 primitive；可用的子代工具只有 `send_message` / `interrupt_agent` / `list_agents`，**没有 wait**（job 有 `job_output(wait:true)`，子代没有对应物） |

所以：**waiting 是真实的，但它在对外面上被压缩掉了。**

## 1. 五个 case 的因果时序（全部实测）

| # | case | 关键时序（ms，相对进程启动） | 结论 |
|---|---|---|---|
| 1 | P→C→settled | P 轮次 1 结束 2992 → C relay 7699（唤醒 P turn2）→ C 终局 8439 → **notice 8456 → `subagent/end` 8458** | notice 先于 lifecycle 边；父被唤醒两次，且第二次 notice 的内容与 relay 重复 |
| 2 | P→C→waiting | C 生 G 10714 → C 静默 11592 → **P `list_agents` @24.6s 看到 `[idle]`**，而 G 直到 58351 才把活干完 | `waiting` 对父**完全不可见**；无 waiting 通知 |
| 3 | P→C→G→settled | C1 终局 8292 → C1 边 8315 → **C 仍不能 settle**，直到 C 自己静默 11982 → C 边 11994 | ownership 释放沿树向上冒泡：**父在持有活 child 时不能 settle** |
| 4 | P→C→disposed | `list_agents` @16.8s `[running]` → `interrupt_agent` 17950 → C `turn/end reason=aborted` 18187 → 边 `stop=aborted` 18207 | 终局是 `aborted`；notice **被注入正在运行的父 turn**（不新开轮次） |
| 5 | P→C→settled + 迟到报告 | C 的完整报告 relay 17969 → P turn2 答 **FINAL** 18573 → C 终局 18622 → **notice 18640 又开 turn3** → P 再答 FINAL 20266 | 父已经给出最终答复后，结算通知**仍然开了一个回合** |

### case 2 的关键一行（父侧工具结果原文）

```text
837daaf1-...-fc8d2cd0a663 [idle] - case2 child
```

此刻（24.6s）该 child **正持有**一个活着的 grandchild（它在跑一个后台 pwsh job，到 58.4s 才结束）。
父看到的是 `idle`，与"孩子只是轮次之间"无法区分——这正是社区指出的语义缺口。

### case 3 的 ownership 冒泡

```text
8292  C1 终局            （grandchild 干完）
8315  subagent/end C1    （C1 ownership 释放）
       ↓ C 仍不 settle：C 自己还要醒一次、答一次
11982 C  turn/end
11994 subagent/end C     （C ownership 释放）
11993 inbox/inserted → P （P 收到 C 的结算通知）
```

**父不能在自己的 child 还活着时结算**——这条实测成立，且释放顺序严格 child-first。

### case 4 的"处置"语义

- `interrupt_agent` 只停当前轮：C 的 `turn/end reason=aborted`，`subagent/end stopReason=aborted`，`lastAssistantMessage` 为空。
- 结算通知文本：`Background subagent <id> was stopped before it finished.`
- 父当时正在跑自己的轮次 → 通知被 **`steer` 注入当前轮**（`inbox/claimed turn=1`），**没有开新回合**（`parentTurnStarts` 全程 = 1）。

## 2. 对三个问题的最终回答

```text
Q1 Child 怎么活着？
   durable Session + process-local Activation。
   父在持有活 child 时无法结算（ownership 先于 child 运行登记，释放 child-first）。
   -> 已成立的官方 primitive。

Q2 Parent 怎么知道 Child 到哪了？
   能：subagent/start|end（按父作用域过滤，只有自己的委派）；
       list_agents 的 running|idle|ready。
   不能：waiting。没有 waiting 通知，list_agents 把它压成 idle。
   -> 语义缺口成立，与社区一致。

Q3 Parent 什么时候、以什么形式拿到结果？
   结算通知只携带 child 的**最后一条 assistant 文本**（"Its closing message:"）。
   完整报告必须由 child 自己 send_message relay（`agent-message`，另一种 source.kind）。
   两条路会**重复**，且顺序不定：case1 先 relay 后 notice；case5 relay 之后 notice 还额外开了回合。
   -> "settled" 与 "result available" 确实不是同一件事。
```

## 3. 这对 Runtime 线意味着什么

可以做的（合法形态，无需 synthetic assistant）：

1. **把终局当事实 fold**：`ctx.on('subagent/end')` 给出 `provider / childId / runId / stopReason / lastAssistantMessage`——足够维护一棵 ownership 树；
2. **在 waiting 窗口内保持沉默**：没有 waiting 信号，Runtime 不该自己造一个"还在等"的注入；
3. **不重复投递平台已经投递的东西**：结算通知是平台的决策（`followup` / `steer` 二选一），Runtime 再投一次就是放大 case 5 的噪音。

做不了的（记录为平台缺口，不是 Runtime 的活）：

- 不用等到 `subagent/end` 就区分 `waiting` 与 `settled`；
- 阻止"父已给出最终答复后，结算通知又开一个回合"（case 5）；
- 从结算通知里拿到完整报告（它只带最后一条 assistant 文本）。

## 4. 附带发现（两个小缺陷，记录备查）

1. **aborted 的通知文案空尾**：`... was stopped before it finished.Its closing message:` 后面是空的
   （`terminal.output` 为 `[]` 而非 `undefined`，所以没走 "It left no closing message." 分支）。
2. **同一内容重复到达父**：case 1 中 relay 与结算通知携带同一句 `C-PONG`；case 5 中完整报告走 relay、
   结算通知只带 `C-DONE`——父要自己判断这两条是不是同一件事。

## 5. 复跑

```powershell
pwsh -File experiments/async-lifecycle/harness/run-lifecycle.ps1 -Only '1,2,3,4,5'
node experiments/async-lifecycle/harness/analyze-lifecycle.mjs <HOME>\Documents\async-spike\results-v2
```

case 任务文本：`experiments/async-lifecycle/tasks-v2/task-1..5.txt`。
