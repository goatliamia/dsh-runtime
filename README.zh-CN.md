# DSH Runtime
[English](README.md) | 中文

**让模型负责思考，让 Harness 处理那些可以确定的事情。**

`dsh-runtime` 是一组面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的小型 Runtime 能力。

它不试图做一个新的 Agent，也不试图用更多 Prompt、Skill 或规则去“教会”模型所有事情。

它只接住一类问题：

> **那些模型不应该反复猜，Harness 本来就可以确定的问题。**

例如：

* 这件事现在能不能做？
* 刚才这一步到底有没有产生变化？
* 工具虽然报错了，实际操作有没有已经发生？
* 工具说成功了，目标状态有没有真的生效？
* 一个动作已经重复很多次，但事情有没有继续往前走？

---

## 安装

一条命令装完（所有能力都在一个包里；装完去设置页选模式 / 场景 / 自定义即可）：

```powershell
# 从 GitHub 页面直接下载 release/dsh-runtime-0.1.0.tgz，或先 clone 仓库
dsh plugin --profile <你的profile> add dsh-runtime-0.1.0.tgz
```

装完 `dsh --profile <你的profile> --dump-config` 能看到 runtime-progress / circuit / reconcile / investigate / seam 五行，即成功。

- **用户不需要选包**：模式（Off / Minimal / Balanced / Strict）、场景预设（Creative / Coding / External / Safe）和自定义勾选都在 Runtime 设置页里完成；
- **开发者按需**：`release/` 里另有五个单独包（progress + circuit + reconcile + investigate + seam），只想装某几个能力时才用；
- **开发者重建**：改完代码跑 `node scripts/pack-release.mjs` 重新生成 `release/`。

---

## 它是怎么工作的？

一次工具调用会发生四件事，Runtime 只做后面两件：

```text
模型调用工具            <- 这一层不是 Runtime
会话把这些记成 event     <- DSH Session
Runtime 把 event 折成事实
策略决定要不要说话
```

真正需要区分的是这两句：

```text
tool error   ≠   effect 没发生
tool success ≠   effect 发生了
```

举个具体例子。`pwsh` 返回 exit 0，命令也确实跑了，但那份改动没有生效（写到了别处，或者被后面的步骤覆盖）。从事件看：

```js
execution = "success"     // 命令本身跑成功了
effect    = "unknown"     // 世界有没有变，事件里看不出来
```

简单任务里这两个差别无所谓；异步任务、部署、插件、外部服务里，它决定下一步该不该重试。

---

## Event 是事实来源

DSH 的 Session Event 是这次运行的一本账：**什么发生了，以及顺序**。Runtime 需要的事实全部从它折出来，不再维护第二套"世界状态"。

折出来就是一个普通对象（`foldProjection(events)`，来自 `dsh-runtime-progress`）：

```js
{
  axes: {
    execution: { turns: 1, steps: 4, toolCalls: 2, toolErrors: 1, turnOutcome: "completed" },
    effect: { exp_flaky: { callResult: "failed", worldEffect: "unknown" } },
  },
  verdict: { turn: "completed", execution: "failed", effect: { exp_flaky: "unknown" } },
  unknownFields: ["effects.exp_flaky.worldEffect"],
}
```

`verdict` 是这一轮的结论：执行失败，效果未知。看不出来的字段进 `unknownFields`，不猜一个答案。

Progress 不是另一份状态，它只回答"这一步有没有真的往前走"。

---

## 几个很小的能力

每个能力都很小，形态也都很像：**一个注册入口，一条明确的输出**。下面每个都给最小例子。

### Guard

执行之前拦下确定不该做的事。

```js
seam.registerGuard({
  action: "pwsh",
  factPath: "runtime-progress.shell-lock",
  predicate: (value) => value !== "locked",
  predicateText: "pwsh requires runtime-progress.shell-lock != locked",
})
```

事实是 `locked` 时，模型调用 `pwsh` 会拿到一条 `[action-rejected]` 加那句 `predicateText`，调用不会进入执行。

### Progress

执行之后看有没有真的往前走。

```js
const p = foldProjection(events)
p.verdict.execution   // "success" | "failed" | "none"
p.verdict.effect      // { 工具名: "success" | "failed" | "unknown" }
```

"命令跑成了"和"事情往前走了"是两条轴，分开报。它不停止、不重试、不修，只提供判断。

### Circuit

同一件事反复失败，而且一直没有进展时，说一次。

```js
registerCircuitContract({ id: "exp_flaky", match: { tool: "exp_flaky" }, threshold: 2 })
```

判定的单位是工具加失败形态加目标，不是"工具"。到阈值时模型收到一条观测：

```text
[runtime-observation circuit-open]
observed: "read" failed 2 times with the same failure on c:\repo\gone.mjs (threshold 2).
failure: Error: cannot read "<str>": not found
fact: capabilities.read.state = "stalled" (authority: runtime, revision: 1, fingerprint: ...)
```

它只报观测，不下命令。也**不做拒绝**：文件工具里读、写、改互为解法，拒绝会把会话锁死。

### Reconcile

非原子动作已经跑过一次时，不许重放。

```js
registerNonAtomicContract({ id: "deploy", match: { tool: "pwsh", pattern: /deploy\.ps1/ } })
```

第二次调用被拦下，理由是："was already invoked once and its confirmation was lost; the effect may already be applied, so a retry can duplicate the side effect."

### Delta

只有值得关注的变化才告诉模型。

```js
{ role: "user",
  source: { kind: "plugin", plugin: "dsh-runtime-seam" },
  content: [{ type: "text", text: "[runtime-observation ...]" }] }
```

变化以一条 user-role 消息进入下一步。Runtime 不播报"现在还是这样"。

### 子代编排（Child orchestration）

父 agent 把活派给后台子代，编排层等的是**终局事实**，不是状态。

```js
const fact = await ctx.childOrchestration.wait(childId, 30000)
// { outcome: "settled", stopReason: "completed", lastAssistantMessage: "..." }
```

`idle` 不等于结束：子代静默但还持有活孙代时是 waiting，不是完成。实测里这个等待在"看起来已经不跑了"的 30.5 秒内一次都没有提前返回。语义冻结在 [`docs/20-child-orchestration-semantic-contract.md`](docs/20-child-orchestration-semantic-contract.md)，实测见 [`experiments/async-lifecycle/`](experiments/async-lifecycle/)。

### Continuation（事前）

当事实与契约把下一步压缩到唯一确定的动作时，Runtime 直接执行，模型只消化结果。

首发合同是 `post-write-syntax-check`：模型写完或改完工作区 JS 模块后，Runtime 自己跑 `node --check`，然后交给模型一条 digest：

```text
[runtime-continuation] deterministic step already executed by the runtime: post-write-syntax-check.
Do not re-run it; digest the outcome and continue from the current world state.
```

它走正常的工具管线（权限、守卫、取消照旧），所以模型看到的是一个**已经发生的结果**，不是一句要求。没有把握时一律不接管。由 settings 里的 `continuation` 位驱动，详见 [`docs/status/pre-productized-2026-09-03.md`](docs/status/pre-productized-2026-09-03.md)。

---

## 一个简单的例子

Agent 执行：

> “把插件切到 fast 模式。”

它修改了配置，构建也成功了。

但运行中的插件实际上还在旧模式。

普通流程很容易得到：

```text
修改成功
→ build 成功
→ 完成
```

Runtime-aware 的流程可以继续观察实际状态：

```text
执行成功
→ 没有看到预期变化
→ investigate
→ 发现仍是旧状态
→ reload
→ 再确认
→ ready
```

这里 Runtime 没有替模型做创造。

它只是避免把：

> **“工具完成了”**

误认为：

> **“事情完成了”。**

---

## Runtime 应该尽量安静

Runtime 不是一个新的“大管家”。

一个重要原则是：

> **模型自己看得清的地方，不需要 Runtime 出手。**

正常 Coding 任务中，Runtime 应该可以完全不介入。

只有当 Harness 能明确看到一些模型不容易可靠判断的事情时，才值得介入。

因此 Runtime 更像是一层很薄的保护，而不是一套新的 Agent。

---

## 模式

设置页分为两根独立的轴：

| 轴 | 是什么 | 选择 |
| -- | ----- | ---- |
| **事前 Pre** | 一个开关——Continuation：事实 + 契约把下一步压缩到唯一时，替模型走这一步 | 开 / 关 |
| **事后 Post** | 执行后纠偏与止损：guard、circuit、reconcile、verify & repair | **Off / Minimal / Balanced / Strict / Custom** |

两根轴不必落在同一个模式里：Post 模式选择事后职责组合，Pre 开关独立翻转。

也可以直接从场景开始（一个同时设定两轴的快捷键）：

**Creative · Coding · External Actions · Safe**

模式只是选择不同的 Runtime 能力组合，不会改变模型本身。

---

## 为什么不是更多 Skill？

有些东西确实适合写进 Skill。

比如：

> 一种工作习惯、一种偏好、一种场景下更好的做法。

但有些东西不属于这个层面：

> 文件到底有没有写进去？
> 插件到底有没有加载？
> 一个操作到底有没有发生？
> 用户到底有没有真正批准？

这些事情，如果 Harness 能够确定，就不应该只靠模型记住一段文字。

一个简单的原则：

> **需要理解的事情交给模型。**
>
> **可以确定的事情交给 Harness。**
>
> **无法确认的事情，就承认不知道。**

---

## Evidence

这个项目不是只停留在设计上，目前已经完成了一组 DSH 实际实验。

在确定性的场景中：

* 重复无进展：真实执行次数下降 **67%**
* 非原子失败：重复副作用下降 **75%**
* 成功但未生效：世界正确率从 **0/2 提升到 2/2**
* 正常 Coding：**0 次误介入**
* 异步 polling：在当前场景和模型下没有明显优势
* 确定性 continuation（第 1-4 轮）：Runtime 接管唯一确定的下一步（**B 模型调用 15 vs A 19，−21%**），stale/cancel/guard/多选一律零误执行，事实缺失或误导时克制，instruction continuity 保持——模型消化已发生的事实并把动作诚实归给 runtime

这些结果说明 Runtime 的价值不是“任何地方都更强”。

更接近：

> **模型自己看得清的地方，它不打扰；模型看不清现实的地方，它补上一点确定性。**

完整实验过程、原始数据和限制条件见 [`docs/`](docs/)——尤其是 Runtime Continuation 线：[`docs/status/runtime-continuation-2026-09-02.md`](docs/status/runtime-continuation-2026-09-02.md)（命题）、[`runtime-continuation-boundaries-2026-09-02.md`](docs/status/runtime-continuation-boundaries-2026-09-02.md)（边界）、[`runtime-continuation-instruction-2026-09-02.md`](docs/status/runtime-continuation-instruction-2026-09-02.md)（instruction continuity）、[`runtime-continuation-ownership-2026-09-03.md`](docs/status/runtime-continuation-ownership-2026-09-03.md)（所有权边界），以及四轮汇总 [`runtime-continuation-summary-2026-09-03.md`](docs/status/runtime-continuation-summary-2026-09-03.md)。

后面三条线各有独立报告：

* 子代编排 —— [`docs/20-child-orchestration-semantic-contract.md`](docs/20-child-orchestration-semantic-contract.md)（冻结的语义，含那个把 `idle` 从终局判定里排除掉的 30.5 秒负例）
* turn-stopping —— [`docs/status/turn-stopping-continuation-and-cost-2026-09-11.md`](docs/status/turn-stopping-continuation-and-cost-2026-09-11.md)（收尾点算不算合法的续跑点，在那里注入的代价是多少），机制写在 [`docs/21-turn-continuation-and-injection.md`](docs/21-turn-continuation-and-injection.md)
* 熔断在文件工具上的误报 —— [`docs/status/circuit-fingerprint-vs-fs-errors-2026-09-11.md`](docs/status/circuit-fingerprint-vs-fs-errors-2026-09-11.md)（两个不同文件塌成一条指纹，以及修法）

---

## Project Status

当前项目仍然是一个实验驱动的小型 Runtime capability 集合。

它不会试图成为新的 Agent Framework，也不会自己重新实现 DSH 的底层 Runtime。

能力应该从真实问题中长出来：

```text
真实问题
  ↓
找到可以确定的事实
  ↓
最小 Runtime 能力
  ↓
实际验证
  ↓
重复出现
  ↓
再考虑抽象
```

**先解决一个具体的问题，而不是先设计一个完整系统。**

---

## Repository

这个仓库目前主要面向：

* DSH Runtime capability 实验
* Runtime / Event / Progress 研究
* 真实 Agent trajectory 验证
* DSH 插件组合与场景实验

安装和启用方式以各 capability 的文档为准；这个仓库本身不是一个需要单独启动的 Agent 应用。

---

## License

见 [LICENSE](LICENSE)。


# 最后：为什么是 Plugin？

因为我们并不认为已经知道 Agent 的最终结构应该是什么。

这个项目只是观察到了一个很具体的事实：

> **真实 Agent 运行中，有些工作已经足够确定，不值得继续占用模型的推理空间。**

如果这些工作可以被独立出来，那么最自然的方式不是把它们全部塞回 Core。

而是：

```text
Real friction
      ↓
Deterministic part
      ↓
Capability
      ↓
Plugin
      ↓
Harness
```

今天可能是 Runtime。

明天可能是别的东西。

不需要预先知道。

---

# 一个暂时足够简单的原则

```text
如果模型仍然需要判断，
让模型判断。

如果程序已经知道答案，
不要让模型重复发现。

如果现实已经确定不允许，
不要让模型决定能不能执行。

如果现实没有变化，
不要告诉模型。

如果一条路径已经没有进展，
不要让它无限继续。

如果状态已经存在，
不意味着必须重新注入。

如果用户的意图可能错，
保护现实，但不要替用户重新定义意图。
```

> **Agent = Model + Harness**

这个仓库只是在探索：

> **Harness 究竟应该接住哪一部分。**
