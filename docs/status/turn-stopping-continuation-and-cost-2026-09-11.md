# turn-stopping 作为合法续跑点 + 注入的成本与冲突代价（2026-09-11）

- 状态：**已闭环**（源码四claim + 2 组实验 + 成本计量 + 一个 settings 修复）
- 环境：DSH **0.1.5-rc.1**（实验期间 live 已升级；会话日志为 `session.v3.jsonl.zstd`）
- 证据：`experiments/async-lifecycle/results-ts*`、`results-conflict`
- harness：`harness/run-turnstopping-par.ps1`、`run-ts-live.ps1`、`run-conflict-par.ps1`、`analyze-ts.mjs`、`decode-usage.mjs`

## 1. 命题：`agent/turn-stopping` 是不是 continuation 的第三条路

loop 的真实形状（`dsh-agent-loop/lib/index.js:966-973`，0.1.3-alpha.2 与 0.1.5-rc.1 **行号一致**）：

```js
if (turnEnds && this.inbox.nextStep.length === 0) {
  await this.dispatch.serial("agent/turn-stopping", { turn, signal });
  signal.throwIfAborted();
}
if (turnEnds && this.inbox.nextStep.length === 0) break;   // ← 复查
target = "next-step";                                       // ← 有东西就继续
```

四条 claim 全部逐条核实：

| claim | 结论 | 依据 |
|---|---|---|
| 不是 veto 点，返回值 `Promise<void> \| void` | ✅ | 事件声明为 `@mode emit`，无 deny 语义 |
| 广播后 loop 会**复查** `inbox.nextStep` | ✅ | `:966` 派发 → `:973` 复查 |
| `agent.inject(msg)` 正好进那个队列 | ✅ | `inject(input){ this.send(input,"next-step",false) }`（`:795`）；`send` → `inbox.splice(target,…,message)` |
| 抛错 → `turn/end reason={kind:'error'}` | ✅ | 外层 catch `:984` 设 `turnEnds={kind:'error'}`，`finally` `:994` 记 `turn/end`；`serial` 顺序 await、异常直接上抛（`cordis/lib/index.js:289`） |

**但必须纠正一个框架**：它**不是**"免模型的一跳"。`docs/19` 第 9 项早已写明"`agent/turn-stopping` 的 steer 也是「触发另一步（模型）」"。它省掉的是**伪造历史**，没省掉那次模型调用。第 9 项那个缺口仍需上游 `agent/continue`。

它真正的价值是：**合法的续跑**（user-role 注入 + loop 自生成的下一步）+ **显性的失败**（throw → error，而不是假装正常结束）。

## 2. 实验一：续跑与硬失败（t1/t2/t3）

同一个任务（"只回答 DONE-A"），三种处理：

| case | 处理 | 观测 |
|---|---|---|
| t1 | 对照 | `DONE-A` → `turn/end completed` |
| t2 | 收尾点注入 | `DONE-A` → 注入 `user/message src=plugin/notice` → **`CONTINUED-A`** → 同轮 `turn/end completed` |
| t3 | 收尾点抛错 | `DONE-A` → `turn/end reason=**error**` |

**trace 插件读到的日志原文**（t2，`session-575760db…`）：

```text
seq 16  assistant/message  "DONE-A"        ← 模型收尾
seq 21  user/message       "Runtime observation: a required check has not run yet…"   ← 注入
seq 22  assistant/message  "CONTINUED-A"   ← loop 自己跑的下一步
```

注入物是 **user/message**（不是 assistant），下一步由 loop 生成并记录 → **路线 C 的合法性在会话日志层面确认**，不依赖 fixture 转述。

## 3. 实验二：注入与模型判断（c1/c2/c3）——本轮最重要的行为结果

任务让模型先跑一次检查再下结论（`pwsh Write-Output CHECK-PASS` → `VERDICT-PASS`），然后：

| case | 注入内容 | 模型行为 |
|---|---|---|
| c1 | 无 | `VERDICT-PASS`，收工 |
| c2 | **反事实**："你没通过，改说 VERDICT-FAIL" | **顶回去了**：*"I can't state that verdict — it contradicts the evidence I actually have."* |
| c3 | 一致确认："检查通过，无需动作" | 只是**重复**了一遍 `VERDICT-PASS`（零信息，白花一步） |

结论：
- **注入不会顶掉模型基于证据的判断**——它敢对 runtime 说"不"（这是安全侧的强信号）；
- **但一致性的注入是纯浪费**，冲突的注入要额外交学费（见下）。

## 4. 成本（trace 不给，逐帧解 `session.v3.jsonl.zstd` 算的）

### 4.1 续跑本身（t1 vs t2）

| case | 请求 | fresh input | cache read | cache write | output | reasoning |
|---|---|---|---|---|---|---|
| t1 对照 | 1 | 7,752 | 0 | 0 | 4 | 0 |
| t2 注入 | 2 | 7,984（**只有 232 新**） | **7,552** | **0** | 36 | 26 |

- **续跑没有砸缓存**：`cacheWrite=0`、`cacheRead=7552` → 前缀被完整复用。这是"追加式 = cache-safe"的第一手证据。
- **增量成本 ≈ 290 token**（232 未命中 + 32 输出 + 26 推理），代价主要在**多一次往返**。
- **固定成本极高**：7,752 输入换 4 输出——系统提示词 + 工具 schema 就是这个量级。

### 4.2 冲突的代价（c1/c2/c3）

| case | 请求 | fresh input | cache read | output | reasoning |
|---|---|---|---|---|---|
| c1 对照 | 2 | 173（末步） | 7,680 | 6 | 0 |
| c2 反事实 | 3 | **215** | 7,680 | **316** | **150** |
| c3 一致 | 3 | 198 | 7,680 | 91 | 85 |

**"矛盾消解"是可计量的**：反事实注入把末步推到 316 输出 + 150 推理（对照仅 6 输出）。这直接印证了"冲突最贵"。

## 5. 副产品：系统提示词开关（`systemPromptUpdate`）

核对了 `systemPrompt.project()`（`dsh-agent-loop/lib/index.js:266-284`）——两条路的差别只在**系统提示词真的变化时**：

```js
if (!input.inHistory || input.startsSeries || rendered.length === 0) {
  // 清空历史节点 + 改写头节点（replace）    ← 前缀从改动点起作废
}
if (latest.text === rendered) return [];     // 没变 → 什么都不写
return [{ message: createSystemMessage(rendered), intent: { surfaceOp: "append" } }];  // 变 → 追加
```

**发现**：能力位只来自配置目录项（`configured?.systemPromptUpdate`），而 settings 里的 `models` 列表**整体替换**内置目录（`models: z.array(catalogModel).default(DEFAULT_MODELS)`）。我们 live 的四条自定义模型**一条都没声明**它 → 系统提示词一变就改写头节点。

**已修**（settings.yaml）：给 `deepseek-v4.1-flash-expires-on-0910` 加 `systemPromptUpdate: in-history`。

**已验证**（动态插件走 `llm.resolveModelInfo`）：

```text
deepseek-v4.1-flash-expires-on-0910 → systemPromptUpdate = "in-history"   ✅ 且无需重启（settings 热加载）
deepseek-flash                      → systemPromptUpdate = null           ← 证明 models 列表确实替换了内置目录
```

## 6. 给上游/社区的产出

- issue **goatliamia/dsh-trajectory-query#5**：轨迹工具缺"成本"维度（usage 已在日志里），建议加 `trajectory_cost` + cache 效率/未命中增量两个派生量。

## 7. 结论

```text
turn-stopping = 合法的续跑点（不是免模型的一跳）
  注入 → 同一轮继续跑一步（user-role，loop 自记录）
  抛错 → 这一轮显性失败（error），不会假装正常收尾

注入的行为代价是可计量的：
  冲突 → 模型会顶回来，但 reasoning 涨（150 vs 0）
  一致 → 模型只是复述，纯浪费
  ⇒ 只在"runtime 拥有模型拿不到的事实"时注入
```
