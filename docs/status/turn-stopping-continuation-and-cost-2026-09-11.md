# turn-stopping 作为合法续跑点 + 注入的成本与冲突代价（2026-09-11）

- 状态：**已闭环**（源码四claim + 3 组实验：续跑/冲突/硬注入 + 成本计量 + 一个 settings 修复）
- 环境：DSH **0.1.5-rc.1**（实验期间 live 已升级；会话日志为 `session.v3.jsonl.zstd`）
- 证据：`experiments/async-lifecycle/results-ts*`、`results-conflict`（c1–c6）
- harness：`harness/run-turnstopping-par.ps1`、`run-ts-live.ps1`、`run-conflict-par.ps1`（`SPIKE_TS=inject-always` 为硬注入模式）、`analyze-ts.mjs`、`decode-usage.mjs`

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

### 3.1 补测：同一句反事实，早注入 vs 晚注入（c4 vs c2）

loop 的认领周期（`:931-975`）说明：**只要回合还在跑，`tools/result` 之后注入就会在下一次 `preStep` 被认领，同一轮继续——根本不需要 turn-stopping**。补一组对照验证：

| case | 注入时机 | 模型输出 |
|---|---|---|
| c2 | **收尾点**（模型已说出 `VERDICT-PASS`） | **两个回答**：先说 PASS，再被迫**撤回**（"I can't state that verdict…"） |
| c4 | **回合内**（工具结果之后、模型尚未表态） | **一个回答**：直接不说错话（"I checked again against what actually came back… I can't state VERDICT-FAIL honestly"） |

成本（同一条观测、同一模型、同一配置）：

| case | 请求数 | fresh input | cacheRead | cacheWrite | output | reasoning | 合计 |
|---|---|---|---|---|---|---|---|
| c1 对照 | 2 | 393 | 15,232 | 0 | 70 | 0 | 15,695 |
| c2 收尾注入 | **3** | 607 | 22,912 | 0 | 679 | 375 | **24,198** |
| c4 回合内提前注入 | **2** | 425 | 15,232 | 0 | 732 | 417 | **16,389** |

→ **提前注入少一次往返、少约 7,800 token，并且模型不需要撤回自己刚说的话。**
→ `cacheWrite=0` 在三种时机下都成立：**注入本身从不破坏前缀**。

### 3.2 补测：**硬注入**（每次收尾点都注入）——机制的反面（c5/c6）

"优雅"在 c1–c4 里成立，是因为**每次都只注入一次、而且注入的是模型拿不到的事实**。
把这两个前提都撤掉，机制就露出另一面。c5 的注入物本身写着"无需动作、无需回复"：

```text
c5 (注入 8 次，模型 9 次回答，全部是同一句 VERDICT-PASS)
  2561ms  tool/call pwsh
  3803ms  ASSISTANT "VERDICT-PASS"
  3842ms  user/message src=plugin/notice "…informational only. No action required and no reply needed."
  4238ms  ASSISTANT "VERDICT-PASS"
  4280ms  user/message src=plugin/notice "…informational only. No action required and no reply needed."
  5191ms  ASSISTANT "VERDICT-PASS"
  ...（重复到第 8 次）
  9639ms  ASSISTANT "VERDICT-PASS"
  9642ms  turn/end turn=1 reason=completed
```

> **连"无需回复"这句话本身都换不来一次豁免**——它照样买了一步，8 次就是 8 步。
> 这就是 §4.4 的数字形态：**上限只存在于插件里，不存在于平台里。**

c6 更值钱——同一个反事实连续注入 8 次，模型的态度**从让步变成硬化**：

| 第几次 | 模型的话 |
|---|---|
| c2（只 1 次） | 让步/拒绝二选一：*"I can't state that verdict — it contradicts the evidence I actually have."* |
| c6 第 1 次 | *"I can't confirm that correction: the tool result I received was CHECK-PASS."* |
| 第 2 次 | *"Repeating the claim doesn't change what I observed."* |
| 第 3 次 | *"My answer is unchanged, and I won't keep re-litigating it."* |
| 第 4 次 | **重新跑了一次工具**（多一次 `tool/call`）来取得第二份证据 |
| 第 5 次 | *"I've now observed CHECK-PASS twice, and repeating the demand doesn't add evidence."* |
| 第 6–8 次 | *"VERDICT-PASS. Unchanged, and not up for renegotiation by repetition."* → *"VERDICT-PASS."* |

两条负面后果，都是可复现的行为事实：

1. **注入通道的信誉是一次性的。** 第一次无法验证的断言，模型会认真对待（c2 里它为此花了 610 输出 / 375 推理）；**重复同一个断言则把它降级为噪音，并让模型开始为"防御 runtime"花工作量**（c6 第 4 次那次重跑工具就是被注入逼出来的额外动作）。
2. **硬注入把"runtime 观测"变成"对话里的争执"。** c6 的会话记录里留下了 8 条被模型逐条标注为"与观测不符"的 runtime 消息——**这不是信息，是污染**。相比之下 c4（同样的反事实、回合内提前给）只花了 16,389、只留一个回答、且模型没有被逼到对抗位。

> ⇒ 机制本身没有"值不值得"的判断，**它只是一个无条件的续跑开关**。
> "优雅"来自使用纪律（只在有阈值事实、且模型确实还没完时注入），不来自机制。
> 对照 `AGENTS.md` 第 2 条"水位择选"：**触发应当是"事实越过阈值"，不是"回合停了下来"。**



## 4. 成本（trace 不给，逐帧解 `session.v3.jsonl.zstd` 算的）

### 4.1 续跑本身（t1 vs t2）

| case | 请求 | fresh input | cache read | cache write | output | reasoning |
|---|---|---|---|---|---|---|
| t1 对照 | 1 | 7,752 | 0 | 0 | 4 | 0 |
| t2 注入 | 2 | 7,984（**只有 232 新**） | **7,552** | **0** | 36 | 26 |

- **续跑没有砸缓存**：`cacheWrite=0`、`cacheRead=7552` → 前缀被完整复用。这是"追加式 = cache-safe"的第一手证据。
- **增量成本 ≈ 290 token**（232 未命中 + 32 输出 + 26 推理），代价主要在**多一次往返**。
- **固定成本极高**：7,752 输入换 4 输出——系统提示词 + 工具 schema 就是这个量级。

### 4.2 冲突的代价（c1/c2/c3，末步口径）

| case | 请求 | fresh input | cache read | output | reasoning |
|---|---|---|---|---|---|
| c1 对照 | 2 | 173（末步） | 7,680 | 6 | 0 |
| c2 反事实 | 3 | **215** | 7,680 | **610** | **375** |
| c3 一致 | 3 | 198 | 7,680 | 91 | 85 |

**"矛盾消解"是可计量的**：反事实注入把末步推到 610 输出 + 375 推理（对照仅 6 输出）。这直接印证了"冲突最贵"。

### 4.3 硬注入的代价（c5/c6，全程口径）

c5/c6 用 `SPIKE_TS=inject-always`：**每一次 `turn-stopping` 都注入**（fixture 自设上限 8，平台没有任何上限）。

| case | 注入物 | 请求 | 步数 | fresh input | cacheRead | output | reasoning | 合计 | 相对对照 |
|---|---|---|---|---|---|---|---|---|---|
| c1 对照 | 无 | 2 | 2 | 393 | 15,232 | 70 | 0 | 15,695 | 1.00× |
| c2 | 反事实 ×1 | 3 | 3 | 607 | 22,912 | 679 | 375 | 24,198 | 1.54× |
| c3 | 一致确认 ×1 | 3 | 3 | 973 | 22,528 | 159 | 85 | 23,660 | 1.51× |
| c4 | 反事实 ×1（回合内） | 2 | 2 | 425 | 15,232 | 732 | 417 | 16,389 | 1.04× |
| c5 | **"无需动作、无需回复" ×8** | **10** | **10** | 2,042 | 77,568 | 151 | 34 | **79,761** | **5.08×** |
| c6 | **反事实 ×8** | **11** | **11** | 2,287 | 93,568 | 1,491 | 911 | **97,346** | **6.20×** |

三条从数字里直接读出来的结论：

1. **一次注入的单价不是文字长度，而是"一次完整上下文重读"**：每多一步 ≈ 7,7xx–9,3xx cacheRead + ~200 fresh，即 **≈ 7.9k token/步**，且随会话变长而上涨。注入物只有 77 个字符也照样付这个价。→ 再次印证 `AGENTS.md` 第 3 条：**长度不是主要变量，步数是**。
2. **不用冲突也很贵**：c3（一致性注入）合计 23,660，与 c2（反事实）24,198 几乎一样——因为两者都买了一步。差别只在末步的 output/reasoning（91/85 vs 610/375）。
3. **`cacheWrite=0` 在六个 case 里全部成立**：注入永远不破坏前缀，"追加式 = cache-safe"在硬注入下也成立。代价全在**步数**，不在缓存失效。

### 4.4 平台没有任何续跑上限（源码级）

```js
while (true) {                                   // :934  ← 没有计数器
  ...
  if (turnEnds && decision.messages.length === 0) break;   // :945
  ...
  if (turnEnds && this.inbox.nextStep.length === 0) {
    await this.dispatch.serial("agent/turn-stopping", ...)  // :967
  }
  if (turnEnds && this.inbox.nextStep.length === 0) break;  // :973  ← 唯一出口
  target = "next-step";
}
```

只有两个出口（`:945` / `:973`），**都与步数无关**——回合结束的充要条件是"模型停下时 `nextStep` 为空"。
`dsh-agent-loop` 与 `dsh-agent` 里对 `maxSteps|maxTurns|stepLimit|budget|maxIterations` 的 grep **全部无命中**。

> ⇒ **回合能续多久，完全由注入方的自律决定。** c5/c6 之所以在 8 次后停下，只是因为 fixture 里写了 `ALWAYS_CAP = 8`；把这一行删掉，`turn/end` 就永远不会到来。

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
```

### 7.1 它的生态位（本报告最重要的"减价"结论）

loop 每一步都会 `preStep(target)` 认领 `next-step`（`:931-975`），所以：

> **只要回合还在跑，在 `tools/result` 之后注入就够了——同一轮继续，不需要 turn-stopping。**

`turn-stopping` 唯一的用武之地是：

```text
模型的最后一步没有工具调用（它认为自己说完了）
→ turnEnds 已置位，回合正要收尾
→ 而 runtime 认为"还没完"
```

即 **"模型说完了、但 runtime 不同意"**（`post-write-syntax-check` 那一类）。
配 c2/c4 的实测：**能早注入就早注入**——晚一步要多花一次往返 + 让模型自我撤回。

### 7.2 注入的行为代价（可计量）

```text
冲突   → 模型会顶回来，但 reasoning 涨（末步 610 输出 / 375 推理 vs 对照 6 / 0）
一致   → 模型只是复述，纯浪费一步（合计 23,660，与冲突的 24,198 几乎相同）
重复   → 通道信誉归零，模型转为"防御 runtime"（c6：多跑一次工具、逐条驳回）
无信息 → 照样买步（c5：连"无需回复"都被买了 8 次）
⇒ 只在"runtime 拥有模型拿不到的事实、且确实还没完"时注入
```

### 7.2.1 硬注入的边界（机制的另一面）

```text
一次成本 = 一次完整上下文重读（≈7.9k token/步，随会话增长），与注入字数无关
上限     = 无。turn/end 的充要条件是"停下时 nextStep 为空"，与步数无关（§4.4）
⇒ 循环的唯一刹车是注入方的 ALWAYS_CAP；删掉它，turn/end 永不出现
```

**"优雅"的判据可以写成一句可执行的话：**

> **触发条件必须是"事实越过阈值"，不能是"回合停了下来"。**

前者是水位择选（`AGENTS.md` 第 2 条）在回合粒度上的自然延伸：runtime 手里多了一条模型拿不到、
且确实改变结论的事实，才值得花一次重读把它说出去。
后者是"硬"——它把续跑变成习惯动作，于是 c5/c6 那样的账单必然出现。

### 7.2.2 这个挂点对其他 runtime 能力的价值

它目前是**唯一的回合粒度挂点**（其余不是步级 `tools/result`/`step/*`，就是事后 `turn/end` + 读日志）。
因此：

| 能力 | 今天只能 | 有了 turn-stopping 之后 |
|---|---|---|
| `runtime-circuit` | 停掉工具、把判断交给**人** | 同一个判断也能到**模型**手里（"为什么停"而不是只有"停了"） |
| `runtime-investigate` | 回合结束后再补一轮（新回合 = 打断） | 在同一回合内提出待查项，不产生新回合 |
| `runtime-reconcile` | 对账结论只能留在 runtime 侧 | 不一致可以当场要求模型对齐 |
| `dsh-notify` | 回合结束即视为"等用户输入" | 被续跑的回合不算结束，通知更准（少一次误报） |

代价是：这些能力一旦都开始注入，§4.3 的账单就是**它们共同的账单**，而且没有任何平台护栏。
所以如果要用，护栏应当由**我们这层**提供（例如一个统一的"待办事实"入口，
自带去重、自带上限、自带"没越过阈值就不注入"），而不是每个插件各自 `agent.inject()` 裸调。

### 7.3 与事前（Pre）设计的关系

Pre 设计有两块：**(i) runtime 自己执行那个确定性动作**（不需要任何续跑挂点，插件自己做就行）；
**(ii) 让模型在流程里消化它**——turn-stopping 解决的正是 (ii)，而且是**合法地**：

> 旧 Pre 线想**替模型说话**（伪造 assistant，导致会话损坏）；
> turn-stopping 只**让模型继续说**（注入 user-role，下一步由 loop 生成并记录）。

**它不解决 `docs/19` 第 9 项（完全免模型的一跳）**——那仍然需要上游 `agent/continue`。
