# Child Orchestration End-to-End Demo（2026-09-09）

- 状态：**通过**（1 次运行，60s；DSH 0.1.3-alpha.2）
- 目的：把 Phase 1-3 的结论压成一次完整任务，证明"编排层 + 模型"这条链能跑通
- 证据：`experiments/async-lifecycle/results-e2e/e2e.jsonl`
- harness：`experiments/async-lifecycle/harness/run-e2e.ps1`

## 1. 设计

一次任务、四个形状各异的子代，**编排层（driver，不是模型）**负责 wait-all + 查轨迹：

```text
Parent（模型）
  ├─ spawn A  普通完成
  ├─ spawn B  waiting 后完成（自己还持有孙代）
  ├─ spawn C  先发 collaboration message 再完成
  └─ spawn D  长跑（被编排层 interrupt）
        ↓
  编排层：等全部 terminal fact（D 超时→interrupt→再等）
        ↓
  编排层：对每个已结算子代调官方 sessionQuery.readSession(childId) 查轨迹
        ↓
  编排层：把一行行 digest 用合法 user-role 注入父
        ↓
  Parent：合成
```

模型侧的要求只有两句：**spawn 四次、别轮询、收工**；以及**收到 digest 后合成**。

## 2. 结果

```text
00:00  P turn1: 4× subagent → "SPAWNED" → idle        （父的工具调用全程只有这 4 次）
 +4s   A completed (A-OK)
 +4s   C completed (C-OK)
 +5s   B 的孙代 completed (G-OK)
 +6s   B completed (B-OK)                              （B 先 waiting，孙代结算后才收尾）
+34s   D 被编排层 interrupt → subagent/end stop=aborted
+35s   编排层为 4 个子代各查一次 sessionQuery.readSession
+36s   digest 注入父（合法 user-role）
+42s   父按 digest 合成：四个子代的状态 + A-OK / B-OK / C-OK / REPORT-C(42) / D 未完成
```

digest（实测输出，每条来自子代自己的轨迹）：

```text
- child c8b820c7: stop=completed turns=1 toolCalls=4 errors=0 final="B-OK"  collaboration="send_message {... CHILD-B final: grandchild ... G-OK ...}"
- child dd9011fe: stop=completed turns=1 toolCalls=1 errors=0 final="A-OK"  collaboration="send_message {... A-OK ...}"
- child b70f62a8: stop=completed turns=1 toolCalls=1 errors=0 final="C-OK"  collaboration="send_message {... REPORT-C: the C investigation concluded the answer is 42 ...}"
- child cfa08401: stop=aborted   turns=1 toolCalls=1 errors=1 final="I'll run the command and wait for it to complete." collaboration=""
```

父的合成（原文节选）：

```text
**Synthesis (from the child digest):**
- child c8b820c7 (demo B) — finished, stop=completed … final "B-OK" (spawned and relayed its grandchild's "G-OK").
- child dd9011fe (demo A) — finished … final "A-OK".
- child b70f62a8 (demo C) — finished … final "C-OK", and reported to parent "REPORT-C: … 42".
- child cfa08401 (demo D) — did not finish, stop=aborted …
```

**验收点全部成立**：父全程只有 4 次 `subagent` 调用，没有 `list_agents`、没有 `job_output`、没有任何轮询；父从未看到 `waiting`；父从未读 `subagent/end`。

## 3. 两个诚实的发现

### 3.1 `wait` 清干净的是编排层，不是模型的收件箱

平台仍然为每个子代各投递一次 notice/relay，父被**多唤醒了几轮**（本轮 turn 数 3；上一轮 5）。
父的表现是对的——它每次都判断"这不是 digest，继续等"——但这是**真实成本**：模型要为它没要的消息付出回合。

> 编排层拿到干净的 `wait`，不等于模型不再被逐条结算通知打扰。要"只在最后醒一次"，得由编排层承担投递，而不是靠平台不加通知。

### 3.2 collaboration 正文在 **tool-call 参数**里，不在 text block 里

第一版 digest 里 C 的 `collaboration` 是空的：因为 `send_message` 的内容位于 assistant message 的 **tool-call block**，只抓 `type === 'text'` 会漏掉。修正后（读 tool-call 的 `name` + `arguments`）四个子代的 collaboration 全部正确取出。

这条与 `dsh-trajectory-query` 的 `textOf` 实现**完全一致**——它一开始就同时处理 `text` / `tool-call` / `tool-result` 三种 block。**这是对"轨迹提取必须按 block 类型覆盖"的一次交叉验证。**

## 4. 轨迹插件可用性（不耦合，只验证）

| | `dsh-trajectory-query`（`D:\projects\sql event`） | `dsh-analysis-view` |
|---|---|---|
| 定位 | 四个 host 查询工具（`find/window/trace/sessions`）+ 分析标签 | 常驻「分析」标签 + incident digest 路由 |
| 数据源 | `ctx.sessionQuery` | live `sessions.get` → 兜底 `sessionPersistence.inspect()` |
| **已结算会话** | **可用**：对 `live:false, persisted:true` 的子代实测 `trajectory_window` 取回 verbatim seq 8–15，`trajectory_find "DURABLE-OK"` 命中 4 处（含 relay 正文与最终答复） | **500**：`no session source available`（`inspect()` 在 v2 已被 `SessionHandle` 取代） |
| live 会话 | 可用 | 可用 |

结论：**两者互补**。`trajectory-query` 覆盖的正是 `analysis-view` 现在挂掉的那段（已结算会话），也正是 `query(child trajectory)` 需要的路径。本轮**未把任何一方装进 runtime 线**，仅做只读验证。

顺带（只读观察，未处理）：两个历史坏会话 `9d9b289a` / `8f5c713d` 在 v2 迁移后已经出现在 `trajectory_sessions` 的 `persisted` 列表里。

## 5. 这条线的最终形态

```text
spawn  →  wait  →  query(child trajectory)  →  model decides

Runtime    : 发布事实（start/end + ownership + 合法 notice/wake）
Orchestration : wait（terminal fact）、推导 residency、按需 query
Model      : 决定"下一步"与"什么算这次工作的产出"
```

**最小 primitive 集就是这三个**；不需要 Result primitive，不需要 waiting 事件，不需要把编排关注点塞回 runtime。
