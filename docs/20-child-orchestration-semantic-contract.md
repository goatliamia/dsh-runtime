# Child Orchestration Semantic Contract

- 状态：**frozen**（2026-09-09）
- 证据：`experiments/async-lifecycle/`（v1 3 case · lifecycle 5 case · phase1 4 case · phase2 4 case · phase3 3 case · e2e 1 run）
- 适用：DSH `0.1.2-rc.1` 实测，`0.1.3-alpha.2` 重跑复核（21/21 稳定语义一致）
- 本文件只定义**语义边界**，不定义实现，不引入任何 DSH core 改动

---

## Problem

今天，一个派了后台子代的父 agent 必须**自己管理 child lifecycle**：

- 它得轮询 `list_agents` 才知道孩子结束没有——而该状态把 `waiting` 压成了 `idle`；
- 它得自己解读 `subagent/end` 与结算通知；
- 它还得自己决定"孩子的结果是什么"，通常只能假定"最后一条 assistant 消息"。

这三件事里，第一件是 harness 已经知道的事实，第二件是平台已经投递的事实，第三件**本来就不该由系统替它猜**。

```text
spawn  →  wait  →  query
```

把"管理生命周期"换成"使用生命周期"：

- `wait` 问的是 runtime 的 **terminal fact**，不是某个状态；
- `query` 在需要时**从孩子自己的持久会话里**重新取回发生了什么；
- 模型只负责"下一步做什么"和"哪些产出值得采用"。

**为什么更干净**：模型不轮询、不接触内部 residency 状态、也不必猜"结果"的含义——因为契约从不声称 runtime 知道结果。

---

## Observed DSH facts

以下全部为实测确认（源码 + 真实模型轮），不引入推测：

| # | 事实 | 证据 |
|---|---|---|
| F1 | continuable child 有 durable Session；`running / waiting / settled` 是 manager **私有**的 residency 推导，不是 Agent 对外状态（`AgentStatus = 'idle' \| 'running'`） | `child-lifecycle-ownership` |
| F2 | `subagent/start` / `subagent/end` 按**委派父作用域**投递，非子插件即可 fold；`subagent/end` 携带 `{runId, provider, id, local, stopReason, lastAssistantMessage?}` | v1 / lifecycle |
| F3 | 父在持有活 child 时**不能**结算；释放严格 child-first | case 3 |
| F4 | 静默的父由平台唤醒：idle → `followup`（新回合），busy → `steer`（并入当前回合） | case 1 / R1 / R2 |
| F5 | `waiting` 在模型面上**不可见**：`list_agents` 对"仍持有活孙代"的 child 报 `idle`；不存在 waiting 通知 | case 2 |
| F6 | `idle` **不是** terminal predicate：只消费 `subagent/end` 的 waiter 在 30.5s 的 idle 窗口里保持阻塞，只在终局事实处返回 | A3 |
| F7 | 已结算（disposed）child 的轨迹**可读**：`sessionQuery.readSession(childId)` 在释放后仍返回完整事件日志 | e2e |
| F8 | child-authored 通道（`send_message` → `agent-message` relay）与 runtime 通道（`subagent-settled` notice）是**两条独立事件流**：relay 先到，notice 只带最后一条 assistant 文本；平台不排序、不合并 | R1-R4 |
| F9 | collaboration 正文位于 **tool-call 参数**，不在 text block 里 | e2e（首版 digest 漏掉 C 的 report） |
| F10 | **不存在 Result primitive**：没有事件、字段或服务 API 能标识"孩子的业务结果" | provenance |
| F11 | 平台仍为**每个 child 各投递一次**通知；编排层做 `wait` 不会消除这些对模型的唤醒 | e2e |

---

## Layer boundary

| Layer | 负责 | 不得 |
|---|---|---|
| **Runtime** | 发生了什么：lifecycle 边、ownership、terminal fact、合法 notice/wake | 定义 child 的"业务结果"；把私有 residency 当作模型可见状态暴露 |
| **Orchestration** | 如何使用事实：等 terminal fact、必要时推导 residency、查已结算 child 的轨迹、归并两条通道 | 轮询状态；发明事件；新增 core 状态 |
| **Model** | 这意味着什么：哪个 child 产出有用、如何综合、下一步做什么 | 被要求从状态推断"是否结束" |

> 已有实现参考（不属于本契约）：`dsh-trajectory-query` 的 `trajectory_find / window / trace / sessions` 提供第 3 层所需的按需回读能力。

---

## Non-goals

- **不引入** `subagent-waiting` 事件或通知；
- **不引入** `get_subagent_result()` 或任何 Result primitive；
- **不允许**把轮询 `list_agents` 当作完成判据；
- **不修改** DSH core；
- **不新增**持久化状态（本契约不要求 runtime-owned state 通道）。

---

## Minimal reference flow

一次完整的 Parent → A/B/C/D（实测：单次运行，父的工具调用**只有 4 次 `subagent`**，零轮询）：

```text
Parent (model)              Orchestration                     Runtime
   |                             |                               |
   spawn A (plain)              |                               |
   spawn B (nested)             |                               |
   spawn C (relay)              |                               |
   spawn D (long)               |                               |
   end turn  -----------------> wait(A,B,C)  ---------------->  subagent/end …
                                D 的时限到期                    |
                                interrupt(D) ---------------->  subagent/end stop=aborted
                                wait(D)                        |
                                query(A,B,C,D)  ----------->   sessionQuery.readSession
                                digest（合法 user-role） ---->  父被唤醒
   synthesize <---------------------------------------------- |
```

各 child 的语义：

| child | 形状 | 编排层看到的事实 | digest 结果 |
|---|---|---|---|
| A | 普通完成 | `stop=completed` | `final="A-OK"` |
| B | **nested waiting** | 自己静默但持有活孙代 → 不能结算；孙代终局后才 `stop=completed` | `turns=1 toolCalls=2 final="B-OK"` |
| C | **relay** | `stop=completed`；collaboration 在 `send_message` 的 tool-call 参数里 | `final="C-OK" collaboration="REPORT-C: … 42"` |
| D | **aborted** | 时限到期被编排层中断 → `stop=aborted`，`lastAssistantMessage` 是 stub | 不当作结果 |

契约在此结束：**Runtime 报"发生完了什么"，编排层负责"怎么利用事实"，模型负责"产出了什么"。**
