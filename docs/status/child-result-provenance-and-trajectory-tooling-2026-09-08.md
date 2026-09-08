# Child Result 的 provenance 分层 + 轨迹分析插件可用性（2026-09-08）

- 承接：`docs/status/child-orchestration-semantics-phase2-2026-09-08.md`（R1-R4 到达顺序）
- 本轮**只取证**：不 patch、不加 API、不做 `collect()`、不耦合任何插件
- 证据：`experiments/async-lifecycle/results-result/r1..r4.jsonl`

## 1. 把每条东西标上 provenance（用真实 artifact）

| provenance | 载体 | 来源 | 是否携带业务内容 |
|---|---|---|---|
| **COLLAB** | `user/message` `source.kind="agent-message"` `form="relay"` | 子代自己调 `send_message` | **是**（子代想说的话，可任意长） |
| **EXEC** | `subagent/end`（以及由它派生的 `subagent-settled` notice） | runtime | **否**，只带 `stopReason` + `lastAssistantMessage` |
| **PARENT** | `turn/start` / `inbox/claimed` / `assistant/message` | 父 agent | — |
| **RESULT?** | — | — | **不存在** |

实测对照（同一批 R case）：

```text
R1  COLLAB: "REPORT-A: this is the child's collaboration message..."   EXEC edge: lastAssistantMessage = "REPORT-B"
R2  COLLAB: "REPORT-A: this is the child's collaboration message..."   EXEC edge: lastAssistantMessage = "REPORT-B"
R3  COLLAB: "REPORT-A-TWO: child two collaboration message"            EXEC edge: lastAssistantMessage = "REPORT-B-TWO"
R4  COLLAB: "REPORT-B-CHILD: child completed..."                       EXEC edge: lastAssistantMessage = "REPORT-B-GRANDCHILD"
```

**结论：EXEC 的载荷是 terminal snapshot，不是业务结果。** 同一子代的真实报告在 COLLAB 里，而 EXEC 只复读它最后一句（我们故意让它最后只说 `REPORT-B`）。

## 2. 回答那个问题

> 有没有任何一个现有事件，能够严格证明"这是 Child 的最终业务结果"？

**没有。** 三条独立证据：

1. **API 面**：`ctx.subagents` 只有 `startContinuable / sendMessage / interrupt / listChildren / listDescendants` + `subagent/start|end`；没有任何 result 查询。
2. **事件面**：`subagent/end` 的载荷是 `{runId, provider, id, local, stopReason, lastAssistantMessage?}`——`lastAssistantMessage` 是"最后一条 assistant 文本"，不是"结果"；`lastAssistantMessage` 缺省时语义是"没留话"，也不是"无结果"。
3. **实测面**：R1-R4 里 `lastAssistantMessage` 全部是 stub（`REPORT-B*`），业务内容只在 COLLAB 通道。

所以三层结构成立，但第三层是**空的**：

```text
Child
 ├── Collaboration  (send_message → agent-message)      ✅ 有 primitive
 ├── Execution      (subagent/end → settlement)         ✅ 有 primitive
 └── Result         (??? 业务结果)                       ❌ 没有 primitive
```

社区那些补丁之所以错位，正是因为它们各自在补不同层：

| 社区方案 | 实际在补 |
|---|---|
| `wait_for_agent(id, timeout)` | **Execution**（何时结束）——和 Phase 1 的结论一致：等 terminal fact 即可 |
| `subagent-waiting` notice | **Residency visibility**（它还在等孙子）——不是 result |
| `get_subagent_result()` / final report | **Result**——但官方没有对应 fact，只能靠约定 |

## 3. 对"wait + collect"设计的影响

- `wait(child)`：**已冻结**。只保证"execution 结束"，消费 `subagent/end`。
- `collect(child)`：**不应该由 runtime 定义**。因为"哪个事件算业务结果"没有事实可依；把 `lastAssistantMessage` 当结果就是 R1-R4 里那个 stub 错误。
- 正确的第二层是 **query(child trajectory)**：execution 结束后，从子代自己的 Session 里按需取事实，由父决定"什么算这次工作的产出"。

## 4. 轨迹分析插件评估（`dsh-analysis-view`）

用户侧已有插件 `dsh-analysis-view`（host 半边：`GET /analysis-view/digest?session=<id>` 确定性 incident 分析；`/interpret` 模型解读）。**只做可用性验证，未耦合进本线**。

### 4.1 在 0.1.3-alpha.2 上：活着

对本会话查询成功：

```text
log b91be1f435a3 events=1613 seq 0–1612
turns=8 toolCalls=321 errors=6 emptyTurns=0 incidentCount=1
incident: 6 个工具调用返回错误(FsError:FS_STALE_VERSION, FsError:FS_NOT_OBSERVED, error)
          harness: guard 已拦截(FsError:FS_NOT_OBSERVED)
```

### 4.2 能不能分析**子代**：能，但只在子代还活着时

新造一个 continuable 子代（下称 probe child），子代运行期间查询：

```text
events=16 turns=1 toolCalls=1 errors=0 incidentCount=0     ← 成功
```

子代结算（Activation 释放）之后再查：

```text
HTTP 500 {"error":"no session source available (sessions/sessionPersistence)"}
```

对所有**非驻留**会话同样失败（抽查三个历史会话，全部同错）。

### 4.3 根因（已定位，属 v2 破坏性变更）

插件的兜底路径是 `ctx.get("sessionPersistence").inspect(sessionId)`：

| | `SessionPersistence` 面 |
|---|---|
| rc.1 | `create` / **`inspect(id)`** / … |
| 0.1.3-alpha.2 | `create` / `open`（→ `SessionHandle`）/ `flush` / `stat` / `list`；**`inspect` 已移除（全包 0 命中）** |

所以：**常驻会话走 `sessions.get(id)` 正常，已结算会话走 `inspect()` 必然失败**。这正是 handoff 预警的 "SessionHandle + 会话锁（破坏性）——任何碰 session 的插件代码要迁移" 的一个实例，只不过这次断的是**读路径**。

### 4.4 修复方向（不属本线，记录备查）

把兜底换成新 API：

```text
const handle = await ctx.sessionPersistence.open(sessionId, access)
const { events } = await handle.read(offset, length)
```

（具体 `SessionAccess` / 分片语义见更新后的 `dsh-session-persistence` types。）

### 4.5 对我们的用法判断

- **可用**：对"会话还在内存里"的实时分析（含 live 子代）直接可用，输出是确定性 incident + 证据 seq，符合我们"检测是确定性的"原则。
- **不可用**：对"已结算子代的轨迹"——恰好是 `query(child trajectory)` 最需要的场景。
- 它回答的是 **"这次执行里发生了什么异常"**，**不是** "这次工作的业务结果是什么"。与第 2 节的结论一致：第三层没人能替父决定。
