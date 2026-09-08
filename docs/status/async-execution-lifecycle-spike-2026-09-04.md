# 异步 Execution lifecycle 所有权 — 实证 spike（2026-09-04）

- 状态：**已闭环**，回填 `HANDOFF-runtime-2026-09-04.md` 第四节判决表
- 定题：异步 Job / Subagent 生命周期能否由 Runtime 持有并在完成时反应，而不是 Agent 自己 wait/check/poll
- 证据：`experiments/async-lifecycle/`（可复跑 harness + 脱敏原始 JSONL）
- 环境：隔离 home（仅复制 credentials/settings，未带入任何 live-home 状态），profile = `@deepseek-ai/dsh-base` + `dsh-async-spike`

## 方法（一句话）

隔离 home 里挂两个 row：`fixture`（**非子**观察者：unscoped 根作用域 + 父 agent 自身作用域）与 `app`（直接驱动：跑完一个任务轮后**不退出**，把进程留给平台投递），然后用三个 cell 各跑一次真实模型轮，父任务文本明确要求"只调一次工具、不许 wait/check/poll"。

| cell | 父任务 | 期望观察 |
|---|---|---|
| a | `subagent`（`backgroundMode: continuable`）一次，随即结束回合 | `subagent/start|end` + 平台自动 resume |
| b | `pwsh` 后台 job 一次，随即结束回合 | wakeup notice + 平台自动 resume |
| c | 全新进程里 `job_list` | 重启后 job 状态是否还在 |

## ① 父作用域 fold，无轮询、无伪造 assistant — **成立（B）**

cell a（父 = `session-A`）：

```text
t=2292ms  父 tool/call = subagent        （整个回合唯一的工具调用）
t=2315ms  subagent/start   child=session-B        <- unscoped 根观察者收到
t=3061ms  父 assistant "ALPHA"
t=3063ms  父 turn/end turn=1 reason=completed
t=3064ms  父 agent/status idle           （此后父什么都没做）
t=27836ms subagent/end provider=spawn stopReason=completed lastAssistantMessage=PONG
t=27837ms agent-scope/subagent-end scope=session-A  <- 父作用域观察者收到
```

- unscoped 根作用域与**父 agent 自身作用域**都收到了成对的 `subagent/start` / `subagent/end`；
  子 agent 自身作用域的监听器没有收到任何东西（scope 过滤与文档一致）。
- 观察者只 fold 标量事实（provider/childId/runId/stopReason/lastAssistantMessage），没有等待、没有轮询、没有合成 assistant。
- 整份 artifact 里**不存在** `source.kind` 非 `model` 的 `assistant/message`；模型可见的新增全部是平台自己的 user-role 通知。

## ② 平台自动 resume — **成立（C）**

父回合在 t=3064 就 `idle` 了，之后父没有发起任何调用；平台自己把父唤醒：

| 路径 | 触发 | 模型可见形态 | 观测 |
|---|---|---|---|
| 子 agent 自己 `send_message` | 子主动回报 | `user/message` `source.kind="agent-message"` `form="relay"` | t=26996 新开 turn 2 |
| 平台 settlement 通知 | 子 epoch 收尾 | `user/message` `source.kind="subagent-settled"` `form="notice"` | t=27835 inbox/inserted → t=29301 进入模型历史 |

- 父空闲时走 `followup`（新开 turn）；父正忙时走 `steer`（并入当前 turn）——两种都无需父侧轮询。
- 源码对应：`SubagentContinuationManager.notifySettlement()`（`dsh-subagent/lib/index.js:1761`）自己投递，注释明确说外部 `subagent/end` 监听器**不能**替代它（父身份/句柄时序）。
- 一个可记的时序细节：`notifySettlement()` 在 `observer.settle()` **之前**执行，所以父先收到 settlement notice，`subagent/end` 随后才发出（artifact 中 27835 < 27836）。

## ③ job wakeup + 第三方可观察 + 重启 — **成立，且判决需修正**

cell b（父 = `session-D`）：

```text
t=2632ms   父 tool/call = pwsh（run_in_background:true）
t=3486ms   父 assistant "BETA"
t=3488ms   父 turn/end turn=1 reason=completed
t=3489ms   父 agent/status idle        （此后父什么都没做）
t=23164ms  jobs/done job=pwsh-1/pwsh status=completed   <- unscoped 根观察者收到
t=23167ms  inbox/inserted source={kind:"plugin",form:"notice",plugin:"tool-jobs"}
t=23168ms  父 agent/status running
t=23169ms  父 turn/start turn=2
t=23170ms  agent/inbox/claimed  source={kind:"plugin",form:"notice"}
t=23190ms  session/user-message（模型可见，同一 source）
```

**修正**：原判"job 无第三方公开事件对"过严。`ctx.jobs` 上有**公开、effect-scoped** 的服务级监听器
`onJobDone(listener)` 与 `onJobsChanged(listener)`（`dsh-jobs/lib/types/index.d.ts:111/134`），
unscoped 根插件实测收到 1 次 `jobs/done` + 2 次 `jobs/changed`（注册 + 结算）。
缺的不是"能不能看见"，而是：它们**不是 Cordis 事件**（没有 `job/start|end` 事件对），且实现是**进程本地内存**
（`dsh-jobs-local`：*"keeps every record in memory"*）。

**重启实证**：cell b 跑完后，隔离 home 里只出现 `sessions/` 与 `storages/session_projcache/`，
**没有任何 job 记录文件**（`results/home-files-after-b.txt`，全仓 0 处 `job` 命中）；
cell c 用全新进程让模型调 `job_list`，得到 `(no background jobs)`。
→ job 状态不跨 host restart。

## 判决表回填（HANDOFF 第四节）

| 场景 | 原判 | 实证后 | 依据 |
|---|---|---|---|
| Subagent | B + C | **B + C 成立** | 父/根作用域均可 `ctx.on('subagent/start|end')` fold；父回合结束后平台自行 `followup`/`steer` 投递 settlement notice（user-role），全程无父侧轮询 |
| Background job | C-（差一格） | **C（观察面成立；持久化仍缺）** | wakeup notice = 合法 user-role 免轮询；且 `jobs.onJobDone` / `onJobsChanged` 为公开服务级监听器，第三方可 fold。缺口 = 无 Cordis 事件对 + 进程本地 |
| 共有持久化 | D | **D 成立** | job 记录不落盘、跨 restart 消失；Runtime 自己的派生 fact 仍无受契约的 runtime-owned state 通道（= v2 验收④） |

核心缺失清单（不变，仍属上游）：① job 公开**事件**对（现状是服务级回调）② job 跨 restart 持久化语义 ③ runtime-owned state 通道。
**不需要**任何 synthetic assistant 通道——三格全部用合法形态跑通。

## 架构不变量（实证支持）

```text
真实执行 → 平台 Event/Callback → Runtime State → Runtime Reaction →（必要时）合法 user-role continuation
```

"事实已发生"（`subagent/end`、`jobs/done`）与"是否值得唤醒模型"（平台的 notice 投递）在平台上**已经是两个分离的决定**；
Runtime 要做的是 fold 前者、不要替后者做决定。

## 附带发现（对后续实验有影响）

1. **headless 会过早退出**：`dsh-headless` 在第二个 `whenIdle()` 之后直接 `exit`（`dsh-headless/lib/index.js:158-166`）。
   父回合结束时即 idle，post-idle 的 resume 根本来不及发生。任何"异步完成后再观察"的实验都必须自持进程
   （本 spike 的 `app` row 就是干这个的）。
2. **隔离 home 会继承父 harness 的沙箱**：在 `workspace-write` 下，嵌套 dsh 的一切子进程 spawn 都以 `EPERM` 失败
   （子 agent 如实上报"pwsh 无法 spawn"），实验结论会被污染。必须在 `danger-full-access` 下跑 driver。
3. **作用域注册时机**：从 `agent/created` 里对 `agent.ctx.on(...)` 的**晚注册**在本轮未记录到事件
   （需要 preset/composition row 形态）；unscoped 根注册与父作用域注册（`agent.ctx`）均可正常工作。
   结论不依赖晚注册路径。

## 复跑

```powershell
# 隔离 home + profile 自动建立；driver 自持进程；产物落 <HOME>\Documents\async-spike\results
pwsh -File experiments/async-lifecycle/harness/run-spike.ps1 -Only 'a,b,c'
node experiments/async-lifecycle/harness/analyze.mjs <HOME>\Documents\async-spike\results
```

`harness/sync-to-repo.mjs` 负责把本机产物脱敏（`<HOME>` / `<REPO>` / `session-<A..>`）后落回本目录。
