# 往 Agent 循环里插东西：一份插点清单

- 状态：**inventory**（2026-09-13，行号已按 2026-09-16 的 `0.1.6-alpha.2` 复核）
- 对象：DSH 的 **ReAct 循环层**（`dsh-agent-loop`）+ 工具管线（`dsh-tools`）+ agent/session/subagent 事件
- 目的：把"我们在哪些点插过东西、插完之后循环变成什么样、拿到了什么"一次说清
- 证据：本仓各 `docs/status/*` 与 `experiments/async-lifecycle/*`
- 行号版本：下列为 **`0.1.6-alpha.2`** 实测。相对 `0.1.5-rc.2`：循环层整体 **−2 行**（逻辑未变），工具管线整体下移约 2000 行（文件变长），工具集与事件集**无变化**

---

## 1. 循环本身留给外部的插点（全部，含未用的）

### 1.1 循环层（`dsh-agent-loop/lib/index.js`）

| 行 | 事件 | 派发模式 | 能改变什么 |
|---|---|---|---|
| 106 | `agent/inbox/claimed` | emit | 只观察：这一步认领了哪些消息 |
| 205/206 | `agent/inbox/discarded` / `inserted` | emit | 只观察：队列进出 |
| 779 | `agent/status` | emit | 只观察：`idle` / `running` 切换 |
| 861 | `agent/error` | emit | 只观察 |
| **892** | **`agent/pre-step`** | **waterfall** | **能改这一步的消息**（`{kind:'enter', messages}`），也能 `reject` |
| **965** | **`agent/turn-stopping`** | **serial** | **收尾前的唯一检查点**；无 veto，只能"加东西让它继续"或抛错 |
| 1030 | `agent/assistant-stream` | emit | 只观察：流式帧 |
| 1086 | `agent/request-error` | waterfall | 能改请求失败的处置（**我们没用**） |
| 1141 | `agent/request` | waterfall | 能改发给模型的请求（**我们没用**） |

循环出口只有两个（`:943` / `:971`），都与步数无关；**平台没有轮次预算**，上游 README `:200` 明写。

### 1.2 工具管线（`dsh-tools/lib/index.js`）

顺序：**guard → pre-execute → execute → post-execute → result**

| 行 | 挂点 | 模式 | 能改变什么 |
|---|---|---|---|
| 2919、2926、2646 | `tools.guard()` | 注册式（非事件） | 执行前拒绝，返回一句 reason |
| 2910 | `tools/pre-execute` | waterfall | 改/拦这次调用 |
| 3326 | `tools/execute` | waterfall | 换掉执行体 |
| 3480 | `tools/post-execute` | waterfall | 改结果（**我们没用**） |
| 3401 | `tools/result` | emit | 只观察：结算后的结果 |

### 1.3 外围事件（我们大量使用）

| 事件 | 来源 | 语义 |
|---|---|---|
| `session/event` | session | 全量事件流（fold 的原料） |
| `subagent/start` / `subagent/end` | subagent | 按**委派父作用域**投递 |
| `agent/created` / `agent/disposed` | agent | 生命周期 |
| `agent/status` | agent | 见上 |

---

## 2. 我们实际插了什么，效果如何

| 插点 | 谁插 | 插进去之后循环怎么变 | 实测效果 |
|---|---|---|---|
| **`agent/pre-step`** | `runtime-seam`（delta）、`runtime-investigate`（注入）、实验 fixture | 往**这一步**的消息里追加一条 user-role 事实；loop 当成自己的消息记录 | 回合内注入 **1.04×**（c4）vs 收尾点 **1.54×**（c2）——**能早不晚**；investigate 契约：静默失败 2/2 → 0/2 |
| **`agent/turn-stopping`** | 实验 fixture（t2/t3/c1–c6）；上游 Stop hook 同形 | 收尾点注入 → 同轮继续一步；抛错 → `turn/end reason=error` | t2：`DONE-A` → `CONTINUED-A` **同一轮**，只多 232 fresh token、`cacheWrite=0`；t3：显性 error；c5/c6：**平台无上限**（8 次注入 = 5.08× / 6.20×） |
| **`tools/guard`** | `runtime-seam`（教学拒绝）、`runtime-circuit`、`runtime-reconcile` | 执行前拒绝，reason 直接进工具结果 | E4b：**"拒绝＋通告"最好**；`[action-rejected]` 不计入熔断指纹 |
| **`tools/result`** | `runtime-seam`（熔断观测） | 不改循环，只喂事实 | E4：重复执行 **6→2（−67%）**，平均 cacheRead **−27%** |
| **`session/event`** | `runtime-progress`（还有 circuit/reconcile/investigate） | 不改循环：把事件流折成 execution × effect 两轴事实 | 四象限语义成立；live fold == 官方重放 == 独立实现 |
| **`subagent/end`**（父作用域） | `runtime-orchestration` | 不改循环：产出 **terminal fact** | A3：子代"看起来不跑了"的 **30.5 秒**里等待不提前返回；`idle` 作为终局判定被证伪 |
| **`agent/status`** | `runtime-orchestration`、实验 | 观察平台投递 | 静默父被唤醒：idle → `followup`（新回合），busy → `steer`（并入当前回合） |
| **`agent/created`** | `runtime-orchestration`、实验 | 建委派边 | 父作用域只收到自己的委派 |
| `agent/inbox/inserted` / `claimed` | 仅实验 | 只观察 | 解释"注入为什么会被 loop 认领" |
| `agent/disposed` | progress / circuit / reconcile / investigate | 落盘证据 | 每次运行的证据文件 |

---

## 3. 我们**没有**插的地方，以及为什么

| 没插 | 为什么 |
|---|---|
| **不伪造 assistant** | 下一步永远由 loop 自己生成并记录（issue #1）。注入一律 user-role + `source.kind='plugin'` |
| **不用 veto** | `turn-stopping` 没有 veto 语义（`@mode emit`，返回 `void`）。想中止只能抛错或中止 signal，那是"显性失败"，不是"否决" |
| **不改系统提示词** | 只通过声明的能力位（`systemPromptUpdate: in-history`）走 `systemPrompt.project()`，不做直接改写 |
| **不挂 `agent/request` / `agent/request-error` / `tools/post-execute`** | 三个 waterfall 都能改请求/结果。**没插是因为没有一条事实需要在那里说**——不是不能 |
| **不把熔断做成"执行"** | 通告可以做，拒绝没接。理由：read/write/edit 互为解法，强制拒绝会锁死会话（2026-09-11 实测） |

---

## 4. 从这张清单里读出来的三条纪律

1. **形态是结论**：同一个"想说话"的诉求，在 `pre-step`（加消息）、`turn-stopping`（续跑一步）、`tools/guard`（拒绝）、`tools/result`（只记录）四个点上，是四种完全不同的东西。先定"这份事实该由谁兑现"，再选点。
2. **能早不晚**：`pre-step` 是主通道（回合还在跑），`turn-stopping` 是残窗（模型已收尾）。同一句反事实，早给 1.04× 且模型不必改口，晚给 1.54× 且要改口。
3. **循环没有刹车**：`turn/end` 的充要条件是"停下时 `nextStep` 为空"，与步数无关；**上限只存在于插件里**。每一次"续跑"都要自己带 cap。
