# Child Orchestration Semantics Spike — Phase 3（waiting 归属）（2026-09-09）

- 状态：**已闭环**（3 个 case，含一个负例；并行跑，DSH 0.1.3-alpha.2）
- 承接：Phase 1 `docs/status/child-orchestration-semantics-phase1-2026-09-04.md`（wait 只吃 terminal fact）
- 证据：`experiments/async-lifecycle/results-residency/w1..w3.jsonl`
- harness：`experiments/async-lifecycle/harness/run-residency-par.ps1` + `analyze-residency.mjs`

> 问题：**`waiting` 是 model-facing fact，还是 orchestration-facing fact？**
> 约束：不 patch core、不加 waiting notice、不改任何官方代码。

## 1. 方法：第三方自己推导 residency

只用**官方事实**推导一个状态机（`pkg/lib/facts.js` 的 `stateOf`）：

```text
settled  —— 观察到了 subagent/end
running  —— agent/status = running
waiting  —— agent 静默，但自己仍持有活着的 child（由 subagent/start|end + 委派边推得）
idle     —— agent 静默且没有活 child（轮次之间停着）
```

输入只有三样：`subagent/start`（含委派边）、`subagent/end`、`agent/status`。**不读 manager 私有状态、不调 list_agents、不轮询。**

三个 case：

| case | 场景 | 期望 |
|---|---|---|
| W1 | 子代停着，但持有活孙代（25s） | 推导出 `waiting` |
| W2 | 子代停着，**没有**活 child（负例） | 只能 `idle`，**不得** `waiting` |
| W3 | 孙代很快（4s） | 同一转移路径，只是窗口窄 |

## 2. 结果：8/8

```
PASS  w1  child derived 'waiting' exists                    (@5754ms)
PASS  w1  'waiting' 在子代终局边之前                        (5754 < 45130)
PASS  w1  子代 'settled' 只在终局边处/之后                  (45131 >= 45130)
PASS  w2  子代从未被推导为 'waiting'（无活 child 的停泊）    (负例)
PASS  w2  子代至少出现过 'idle'
PASS  w3  child derived 'waiting' exists                    (@5409ms)
PASS  w3  'waiting' 在子代终局边之前                        (5409 < 11305)
PASS  w3  子代 'settled' 只在终局边处/之后                  (11306 >= 11305)
```

W1 的完整轨迹（这是关键证据）：

```text
 2742ms  P  -> waiting      （P 静默，但持有活着的 C）
 5754ms  C  -> waiting      （C 静默，但持有活着的 C1）   ← 社区说的那个"看不见"的状态
43457ms  C1 -> settled      （孙代终局边）
43002ms  C  -> running      （C 被唤醒）
45131ms  C  -> settled      （C 终局边，child-first 释放）
45526ms  P  -> idle         （P 无活 child）
```

**W2 是这次最有价值的一行**：同一个 `Agent.status === 'idle'`，在"持有活 child"时推导为 `waiting`，在"没有活 child"时推导为 `idle`。也就是说——**`list_agents` 丢失的那个区分，第三方用官方事实就能补回来。**

## 3. 结论

```text
waiting 是 orchestration-facing fact，而且它不需要新 primitive：
  官方已有 subagent/start|end + agent/status + 委派边，
  编排层自己就能把 waiting 推出来，并区分它和"轮次之间停着"。
```

三点推论：

1. **对模型**：没有证据表明模型需要 `waiting`。模型要的是"下一步做什么"，而平台在终局时已经用合法 user-role 通知把它唤醒（v1/Phase 2 已证）。再加一条 waiting notice，只会增加噪音——Phase 2 的 case 5 已经展示了 notice 噪音的代价。
2. **对社区那个 `subagent-waiting` patch**：它服务的是**编排层**，不是模型。而编排层既然能自己推，这个 patch 的边际价值主要在"省得每个编排层自己写一遍"，而不是"提供模型看不见的事实"。
3. **对我们自己的设计**：编排层需要 `wait`（吃 terminal fact）+ 可选的自推导 residency；**不需要** waiting 通知。这也和 Phase 1 的 A3 一致——编排层在 idle 窗口里根本不需要知道"它在 waiting"，照样能正确等待。

## 4. 至此这条线的分层（定稿）

```text
Runtime 发布的事实（官方 primitive，已实证）
  subagent/start | subagent/end（带 stopReason）
  subagent-settled notice（合法 user-role）
  ownership：父持有活 child 时不能结算，释放 child-first

编排层自己做的（无需 core 改动）
  推导 residency：running / waiting / idle / settled
  wait(child) = 等 terminal fact
  query(child trajectory) = 结算后按需读子代历史

模型自己做的
  决定"下一步做什么"；由父根据子代历史判断"什么算这次工作的产出"

官方仍然没有的（记录在案，非本线能补）
  Result primitive（业务结果）
  job 公开事件对 / job 跨 restart 持久化 / runtime-owned state 通道
```

## 5. 复跑

```powershell
pwsh -File experiments/async-lifecycle/harness/run-residency-par.ps1 -Only 'w1,w2,w3'
node experiments/async-lifecycle/harness/analyze-residency.mjs <HOME>\Documents\async-spike\results-residency
```

任务文本：`experiments/async-lifecycle/tasks-residency/task-w1..3.txt`。
