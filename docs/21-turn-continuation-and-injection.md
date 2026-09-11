# Turn Continuation & Injection Mechanism

- 状态：**reference**（2026-09-11）——机制参考，不是实验报告
- 适用：DSH `0.1.5-rc.1` 实测；`0.1.5-rc.2` 复核，**本文引用的行号全部未变**（`:783`/`:792`/`:885`/`:899`/`:934`/`:966`/`:973`、README `:200`、`dsh-tool-fs` `:547-548`）
- 原始实验与逐条结论：`docs/status/turn-stopping-continuation-and-cost-2026-09-11.md`
- 证据：`experiments/async-lifecycle/results-ts`（t1–t3）、`results-conflict`（c1–c6）
- 本文件只描述**平台既有机制**与**我们量出来的使用判据**，不引入任何 DSH core 改动

---

## Problem

一个回合什么时候结束？平台的答案是：

> **模型停下时，`nextStep` 队列为空。** 除此之外没有别的条件。

这意味着"回合要不要继续"这件事，**模型说了不算，平台也不设上限**——决定权在**往 `nextStep` 里放东西的那个插件**手里。
（上游把这一点写在明面上，见 F6。）

于是同一件事有两种危险的做法：

```text
替模型说话（伪造 assistant）        → 会话损坏
无条件续跑（每次都注入）           → 账单失控 + 通道信誉被消耗
```

本文件定义第三种做法：**只在"runtime 手里有一条模型拿不到、且改变下一步的事实"时，用合法原语续跑一步。**

---

## Observed DSH facts

全部来自 `dsh-agent-loop` 与随包发布的插件源码，行号对 `0.1.5-rc.1`：

| # | 事实 | 证据 |
|---|---|---|
| F1 | 回合循环是 `while (true)`，**只有两个出口**（`:945` / `:973`），都与步数无关 | `lib/index.js:934-975` |
| F2 | 收尾判定处派发 `agent/turn-stopping`，签名 `Promise<void> \| void`，**无 veto**；随后 `signal.throwIfAborted()` 复查 | `:966-972` |
| F3 | 派发**之后** loop 复查 `inbox.nextStep.length === 0`（`:973`）→ 派发期间入队的东西会让回合继续 | `:966-975` |
| F4 | 三种入队原语：`followup`→`next-turn`+wake（`:789`）、**`steer`→`next-step`+wake（`:792`）**、`inject`→`next-step`（不 wake，`:795`） | `:783-796` |
| F5 | `agent/pre-step` 是 **waterfall**，默认决策 `{kind:"enter", messages:claimed}`，监听者可往 `messages` 追加消息 | `:885-908` |
| F6 | 上游明确声明**没有轮次预算**，并指定"限制失控回合"应从 `agent/turn-stopping` 一类挂点执行取消 | `dsh-agent-loop/README.md:200`（中文本 `README.zh.md:200`） |
| F7 | 上游自己就用这个机制：Claude Code / Codex 的 **Stop hook** 在 `turn-stopping` 里 `agent.steer(...)` 让回合继续 | `dsh-hooks-claude-code:292-307`、`dsh-hooks-codex:273-288` |
| F8 | 在 `turn-stopping` 里 **抛错** → `turn/end reason={kind:"error"}`；**中止 signal** → `reason={kind:"aborted", reason}` | `:976-1001` |

F6 原文（英）：

> **No built-in turn budget** — tool calls or steering continue the current turn; a policy that bounds runaway turns must cancel from an existing lifecycle extension point such as `agent/turn-stopping`.

F7 原文（两个 hook 包一致，默认文案都一样）：

```js
ctx.on("agent/turn-stopping", async ({ agent, turn, signal }) => {
  const merged = await runPoint("Stop", "", stopPayload(agent), { agent, turn, signal })
  if (merged.decision === "deny") {
    const text = merged.reason ?? "continue: blocked by Stop hook"
    agent.steer(createUserMessage({ content: [{ type: "text", text }], source: PLUGIN_SOURCE }))
  }
})
```

> ⇒ **"模型想停、runtime 说继续"是上游已经落地的形态。** 我们的增量不是机制，是**判据和成本**。

---

## 两个注入通道

| 通道 | 触发时机 | 何时该用 | 代价 |
|---|---|---|---|
| **`agent/pre-step`**（主通道） | 回合还在跑，每一步开始前 | 事实已经拿到——默认选择 | 正常一步 |
| **`agent/turn-stopping`**（残窗） | 模型已收尾、loop 正要离开 | 事实**出现在最后一步**，主通道再没有机会 | 晚一步：多一次往返 + 模型要改口 |

主通道之所以是主通道：`pre-step` 的默认决策就是"进入下一步"，把消息追加进 `messages` 即可，
**loop 会把它当作自己这一步的消息照常记录**——不需要伪造，也不需要第二个挂点。实测：同一句反事实，
回合内给只要 1.04×，收尾点给要 1.54×（并且模型要先说一遍再撤回）。

残窗是真的，但很窄：`:973` 一旦 break，`preStep` 就不会再被调用，
所以"最后一步才浮现的事实"在主通道里**没有机会被说出去**。

### 用哪个原语

```js
agent.steer(msg)    // → send(msg, "next-step", true)    ← 续跑请用这个
agent.inject(msg)   // → send(msg, "next-step", false)
```

两者都进 `next-step`（所以都能续跑，我们的 fixture 用 `inject` 也跑通了）。
差别在 `send` 的 `wakingAfterAbort`：**`steer` 在 phase 已 abort 时会把消息改投 `next-turn`，`inject` 不会**
（`lib/index.js:783-786`，源码推导，未单独实测）。
上游两个 Stop hook 都用 `steer`——续跑场景应当跟随。

---

## 注入的四条判据（机械的，不问模型）

```text
1. runtime 手里有一条模型没收到过的观测（能在事件流里举证）
2. 这条观测会改变"下一步该做什么"
3. 模型已经收尾（turnEnds 已置位），主通道不再有机会
4. 在此之前没有说过（去重集合）
⇒ 四条全成立才注入；任何一条不成立，沉默
```

第 1 条不能交给模型判断：c2/c4 里模型的回应是
*"the only thing asserting CHECK-FAIL is the follow-up runtime observa[tion]"*——
**它无法验证 runtime 的事实，因此也无法判断这条事实是否越过阈值。** 判据必须是 runtime 侧的机械谓词。

第 4 条同时是**上限**的位置：平台没有护栏（F6），去重集合 + 一个显式 cap 就是全部的刹车。
c5/c6 里让 `turn/end` 出现的唯一原因是 fixture 写了 `ALWAYS_CAP = 8`；删掉它，`turn/end` 永不到来。

---

## 成本模型（实测，同一任务/模型/配置）

| case | 注入物 | 请求 | fresh input | cacheRead | output | reasoning | 合计 | 相对对照 |
|---|---|---|---|---|---|---|---|---|
| c1 | 无 | 2 | 393 | 15,232 | 70 | 0 | 15,695 | 1.00× |
| c2 | 反事实 ×1（收尾点） | 3 | 607 | 22,912 | 679 | 375 | 24,198 | 1.54× |
| c3 | 一致确认 ×1（收尾点） | 3 | 973 | 22,528 | 159 | 85 | 23,660 | 1.51× |
| c4 | 同一条反事实 ×1（回合内） | 2 | 425 | 15,232 | 732 | 417 | 16,389 | 1.04× |
| c5 | "无需动作、无需回复" ×8 | 10 | 2,042 | 77,568 | 151 | 34 | 79,761 | 5.08× |
| c6 | 反事实 ×8 | 11 | 2,287 | 93,568 | 1,491 | 911 | 97,346 | 6.20× |

```text
单价   = 一次完整上下文重读（≈7.9k token/步，随会话增长），与注入字数无关
缓存   = cacheWrite 在六个 case 里全为 0 → 注入从不破坏前缀，代价全在步数
变量   = 步数，不是长度
```

**不用冲突也很贵**：c3（一致性注入）合计 23,660，与 c2（反事实）24,198 几乎相同——两者都买了一步。
差别只在末步的 output/reasoning。

---

## 行为代价：通道信誉是一次性的

c2 单次注入：模型顶回来，但为此付出 610 输出 / 375 推理。
c6 连续注入 8 次：模型从"认真对待"转为"防御 runtime"——

```text
第 1 次  "I can't confirm that correction: the tool result I received was CHECK-PASS."
第 2 次  "Repeating the claim doesn't change what I observed."
第 3 次  "My answer is unchanged, and I won't keep re-litigating it."
第 4 次  重新跑了一次工具取证（被注入逼出来的额外动作）
第 5 次  "I've now observed CHECK-PASS twice, and repeating the demand doesn't add evidence."
第 6-8 次 "VERDICT-PASS. Unchanged, and not up for renegotiation by repetition."
```

两条结论：

1. **注入通道顶不掉一个模型手里有证据的结论**（安全侧的强信号：模型敢对 runtime 说不）。
2. **重复同一个断言把它降级为噪音**，并让模型开始为"防御 runtime"花工作量；会话里留下 8 条被逐条标注为与观测不符的 runtime 消息——**这是污染，不是信息**。

---

## 不该做什么

| 能力 | 结论 | 原因 |
|---|---|---|
| `runtime-circuit` | **不需要注入** | guard 的 reason 已经写进工具结果，模型在正确的步上就拿到了判断；插件自报 `promptEdits: 0` 作为设计不变量 |
| `dsh-notify` | **不需要改动** | `turn/end` 在整轮真正结束时**只发一次**（c5：8 次注入之后只有一个 `turn/end`），下游信号本来就对；续跑只是把它推迟 |
| 任何"无信息注入" | **禁止** | c5：连"无需回复"这句话本身都被买了 8 次 |

---

## 本仓库的参考实现

`core/runtime-investigate/lib/index.js:87-130` —— 主通道上的注入，已带完整纪律：

```js
if (injected.has(contract.id)) continue;          // 判据 4：去重
const success = matchedResults(contract).find((r) => !r.isError)
if (!success) continue;                           // 判据 1+2：契约阈值命中
injected.add(contract.id)
interventions.push({ at, kind, evidence })         // 留证据
// → 往 decision.messages 追加 user-role 消息，source: {kind:'plugin', plugin:'dsh-runtime-investigate'}
```

**这套判据不需要新的抽象层**：它已经在唯一需要它的插件里。再抽一层框架是把能跑的判据重写成框架。

---

## 尚未使用的窗口（已知，暂不实现）

**最后一步才浮现的事实。** 事实在最后一步产生 → `turnEnds` 已置位、`nextStep` 为空 → `:973` break →
`preStep` 不再被调用 → 主通道没有机会；只有 `agent/turn-stopping` 能接住，且要付晚注入的价（1.54×）。

开这个窗口的成本大约是十几行（复用已有的 `injected` 去重 + `interventions` 证据 + contract 阈值），
但**是否值得开取决于这个窗口是否真的出现**——不是设计判断，是一次可测的事实。在测出它之前不写。
