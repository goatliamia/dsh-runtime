# Child Orchestration Semantics Spike — Phase 1（wait）（2026-09-04）

- 状态：**已闭环**（4 个 case）
- 承接：`docs/status/child-lifecycle-ownership-spike-2026-09-04.md`（5 case：ownership / waiting / result）
- 证据：`experiments/async-lifecycle/results-orch/a1..a4.jsonl`
- harness：`experiments/async-lifecycle/harness/run-orchestration.ps1` + `analyze-orchestration.mjs`

> 目标不是"把 wait 工具做出来"，而是验证：**settlement signal 是否足以成为唯一 terminal predicate。**

## 0. 先核对这一轮调查（对着已装版 0.1.2-rc.1）

| 你的说法 | 已装版实际 |
|---|---|
| settlement 由 Continuation Manager 投递，不是外部插件监听 | ✅ 成立（`notifySettlement`；源码注释明说外部 `subagent/end` 监听器**不能**替代它） |
| `running/waiting/settled` 是内部 residency 推导，不是 Agent 对外状态 | ✅ 成立（`AgentStatus = 'idle' \| 'running'`） |
| 社区已做 `subagent-waiting` notice patch | ⚠️ **不在已装版**：全包 grep `subagent-waiting` **0 命中** → 当前官方语义仍是"waiting 不可见" |
| 官方现在是两条通道：`subagent-report` relay + `subagent-settled` notice | ⚠️ **要修正**：已装版 grep `subagent-report` / `SubagentReportDelivery` / `reportDelivery` **全部 0 命中**。child→parent 的 relay 是 `send_message` 产生的 `agent-message`。所以 0.1.2-rc.1 是"**一条 child-authored 通道 + 一条 runtime 通道**"，而不是两种 report |
| `wait` 应该订阅 parent inbox 的 `subagent-settled` | ✅ 可行；但**更直接**的 predicate 是 `subagent/end` 事件（同样是官方事实，不必解析 inbox 消息）。Phase 1 用后者，notice 只做交叉验证 |
| `idle` 不算 terminal；只有 settlement / disposal 能完成 wait | ✅ 成立（见 A2/A3） |
| job 已有 "completion wakes an idle owner" 先例，subagent 无等价 wait | ✅ 成立（`tool-jobs` 的 `completionDelivery: wakeup` → `owner.followup`；`job_output(wait:true)`；子代无对应物） |

## 1. 设计（方案 2：Runtime-side waiter）

模型**没有** wait 工具。编排层是一个 Runtime 侧的 waiter，唯一输入是官方事实：

```text
subagent/start  -> recordStart(childId, parentId)     （观察委派边）
subagent/end    -> recordEnd(childId, stopReason)     （唯一 terminal predicate）
awaitSettlement(childId, timeoutMs)
   ├── 已有 fact -> 立即返回 already-settled
   ├── 否则挂起，被 recordEnd 唤醒
   └── 超时 -> 返回 timeout（不是静默成功）
```

**严禁**：`list_agents`、`Agent.status`、任何轮询。四个 case 里 waiter 只在开始时读一次委派边，之后全程阻塞。

## 2. 结果

| case | 场景 | child 状态 | 关键时序 | 结论 |
|---|---|---|---|---|
| A1 | 普通等待（child 跑 20s） | running@2537 → idle@26937 | wait 3390 → **返回 26960**（23.57s）；fact@26959 | 在 fact 上解析，不依赖 idle |
| A2 | **already-settled**（wait 在 child 结算 12s 后才调） | idle@5826，fact@5852 | wait 15837 → **返回 15838（1ms）**，`via=already-settled` | 迟到的 wait 不会卡住 |
| A3 | **waiting 负例**（child 持有活 grandchild） | running@2460 → **idle@5515** → running@33964 → idle@36020；grandchild idle@34827 | wait 2925 → **返回 36041**（33.12s）；fact@36040 | **idle 窗口跨了 30.5s，wait 一次都没提前返回** |
| A4 | **超时**（bound 8s，child 跑 30s） | idle@36765，fact@36777 | wait 3063 → **timeout@11075**（8.01s）；随后 45s 尾窗里 fact 到达，wait **没有**补解析 | 超时是独立结果，不会静默变成功 |

### A3 是这一轮最关键的一行

```text
  2925ms  orch/wait-begin        child=1bfb23e0
  5515ms  child 进入 idle        （其实是 waiting：它持有活着的 grandchild）
 34827ms  grandchild idle
 36040ms  child 的 terminal fact 到达
 36041ms  orch/wait-end         outcome=settled via=fact elapsed=33116ms
```

wait 在 child "看起来已经不跑了" 的 **30.5 秒**里一直阻塞，只在真正的终局事实上返回。
→ **`idle` 作为 terminal predicate 被证伪；settlement fact 作为唯一 predicate 成立。**

## 3. Phase 1 结论

```text
wait 不需要理解 AgentStatus。
wait 需要的是 runtime 的 terminal fact。

而该 fact 今天就存在：ctx.on('subagent/end')
  - 零 core 改动
  - 零轮询
  - 作用域正确（父作用域只收到自己的委派）
  - 携带 stopReason / lastAssistantMessage
```

因此 `wait` 的正确落点是**编排层**（方案 2），而不是：
- 方案 1（model-facing tool）：把确定性判断塞回模型；
- 方案 3（runtime 自动等）：替模型做编排决策，最危险。

## 4. 下一步（按你定的顺序）

**Phase 2（result）** —— 暂不 patch，只测语义：

```text
C: send_message("REPORT A")  -> 继续 -> final = "REPORT B"
父侧顺序：relay A / settlement B / final assistant
```
在 parent idle / busy / 多 child / 嵌套 child 四种情况下测顺序，回答：
**"result 是 execution outcome，还是 collaboration message？"**
（已装版证据：settlement 只带最后一条 assistant 文本；完整报告只能走 child 的 `agent-message` relay。）

**Phase 3（waiting）** —— 判断 waiting 是 model-facing 还是 orchestration-facing fact。
Phase 1 的 A3 已经给出一个有用的副产品：**编排层根本不需要 waiting 通知**也能正确等待——
它只需要终局事实。这支持"waiting 更偏 orchestration-facing"的判断。

## 5. 复跑

```powershell
pwsh -File experiments/async-lifecycle/harness/run-orchestration.ps1 -Only 'a1,a2,a3,a4'
node experiments/async-lifecycle/harness/analyze-orchestration.mjs <HOME>\Documents\async-spike\results-orch
```
