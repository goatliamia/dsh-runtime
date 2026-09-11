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

最简单的理解：

```text
Model
  ↓
Tool
  ↓
Runtime
  ↓
现实世界
  ↓
Event
  ↓
Runtime / Policy
  ↓
下一步
```

工具负责**做事**。

Event 负责记录**发生过什么**。

Runtime 从这些已经发生的事情里得到自己需要的判断，再决定是否需要介入。

因此：

```text
tool error   ≠   effect didn't happen
tool success ≠   effect happened
```

这两个区别在简单任务里很难察觉，但在异步任务、部署、插件、外部服务和动态 Runtime 中会越来越重要。

---

## Event 是事实来源

DSH 的 Session Event 可以看作运行过程的一本账。

它记录：

> 什么事情发生了，以及发生的顺序。

需要知道当前状态时，可以从事件得到当前事实；需要知道刚才发生了什么变化，也可以从事件中得到。

因此 Runtime 不需要再维护一套与 DSH 平行的“世界状态”。

例如：

```text
Event
  ↓
当前事实
  ↓
最近变化
  ↓
Progress
```

Progress 本身不是另一份状态。

它只是回答：

> **这一步有没有真正让事情往前走？**

如果事实不足，也可以明确得到 `unknown`，而不是猜一个答案。

---

## 几个很小的能力

### Guard

执行之前处理确定性的边界问题。

> **这件事现在能不能做？**

例如一个动作明确不应该进入执行阶段，就在执行之前拦住。

### Progress

执行之后观察实际变化。

> **刚才到底有没有进展？**

它不负责停止、重试或修复，只提供判断。

### Circuit

如果一个动作持续失败，而且世界一直没有新的进展：

> **不要一直重复做同一件事。**

### Reconcile

如果执行结果和现实状态可能不一致：

> **先确认现实，再决定下一步。**

例如工具返回失败，但外部状态已经变化，就不应该直接重新执行。

### Delta

只有真正值得关注的变化出现时，才告诉模型。

Runtime 不需要不断播报“现在还是这样”。

### 子代编排（Child orchestration）

父 agent 把活派给后台子代。runtime 已经知道**发生了什么**——子代开始、结束、释放 ownership——所以编排层不需要去问。

```text
spawn  ->  wait  ->  query（读子代自己的轨迹）  ->  模型判断这意味着什么
```

- **wait** 消费终局事实（`subagent/end`），而不是状态：`idle` 不等于“结束”；子代静默但仍持有活孙代时是 *waiting*，不是完成。
- **query** 在子代结算后，从它自己的持久会话里重新取回到底发生过什么。
- 模型不轮询、看不到 runtime 的私有 residency 状态，也不会被塞一个编造的“结果”——子代产出了什么是判断，不是 harness 能拥有的确定事实。

实现为 `ctx.childOrchestration`（`wait` / `waitAll` / `residency`），见 `dsh-runtime-orchestration`；语义冻结在 [`docs/20-child-orchestration-semantic-contract.md`](docs/20-child-orchestration-semantic-contract.md)，实测见 [`experiments/async-lifecycle/`](experiments/async-lifecycle/)。

### Continuation（事前）

当事实与契约把下一步压缩到唯一确定动作时，Runtime 直接执行——走正常的权限 / 守卫 / 取消边界——模型只消化已经发生的结果。

没有把握时一律不接管。该引擎已产品化并入 `dsh-runtime-seam`（由 settings 的 `continuation` 位驱动），
首发日常合同 `post-write-syntax-check`：模型写入/编辑工作区 JS 模块后，Runtime 对它们跑 `node --check`
并给模型一条 digest。详见 [`docs/status/pre-productized-2026-09-03.md`](docs/status/pre-productized-2026-09-03.md)。

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
