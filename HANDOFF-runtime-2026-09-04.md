# HANDOFF — DSH Runtime 线交接（2026-09-04）

> 新对话接手前先读：本文件 → `README.md`（定位）→ `docs/bugs/005-session-zstd-frame-repair-boot-failure.md`（帧铁律）→ `docs/status/dsh-next-update-v2-2026-09-04.md`（官方更新验收，勿重调研）→ GitHub issue #1（Pre 通道禁条）。

- 仓库：`D:\projects\runtime\dsh-runtime`，master 基线 = `355acb5`（+bug005+更新验收清单）
- GitHub：名 `dsh-runtime`（2026-09-09 由 `dsh-runtime-react` 改名，旧名自动重定向），**PUBLIC**
- 工作区有另一对话遗留的 Pre 线文件（untracked：`core/runtime-seam/lib/pre-continuation.mjs` 等）——**禁止合并/推送**（issue #1）
- 另一条线 visual-html（vhtml）在 `goatliamia/visual-html-agent-editor`，勿在本线处理

## 一、平台钉死事实（源码级，勿重查）

- `assistant/message` = model 专属通道：source.kind 必须 `"model"` 且带 provider/model（dsh-session `lib/index.js:1182` + `lib/types/index.js:250`）；`user/message` 只要 kind 非空
- 模型可见注入唯一三条合法通道：system section / runtime-context snapshot / user-role（pre-step/收件箱）
- downstream 有 `foreignAssistant` 降级（dsh-llm-pi-ai `toPiAssistant`）：承认非 model assistant 时 assembler 零改动
- 宿主动作严禁伪装 assistant；合法形态 = 宿主执行 + 独立事件 + 纯投影 + 按需 user-role
- 事件源现状：subagent 有 `subagent/start`+`subagent/end`（父 scope 过滤）；job settle 走收件箱 `notice`+`wakeup`（user-role，合法）但**无第三方公开事件**；jobs-local 进程本地、跨整机 restart 持久化未证实

## 二、会话事故现状（勿动手）

- `9d9b289a`（坏事件 seq 643817/646714/653169/654711）+ `8f5c713d`（372908）：已恢复原始日志（.bak 在会话目录），打开仍被 validator 拒。标本 = v2 迁移回归夹具。唯一安全手术 = 帧边界保持法（bug 005）；严禁整体重压。

## 三、官方下一更新（**已发布在 alpha 通道，2026-09-08 已升级**）

`latest`/`next` 仍是 `0.1.2-rc.1`，但 **`alpha` = `0.1.3-alpha.2`（09-07 发布）**，用户已手动升级 live 安装。
- 变更摘要：Session format v2（`SESSION_FORMAT_VERSION 0 → 2`，v0/v1 经不可变 generation 迁移）、SessionHandle + 内核写锁/跨进程会话锁（破坏性）、`assistant/attempt` 事件、`assistant/message.stream`、`team/*` 事件族。
- **升级影响核对已完成**：`docs/status/dsh-0.1.3-alpha.2-update-impact-2026-09-08.md`（9 个 case 在新版重跑 **21/21** 稳定语义成立；runtime 插件静态 API + 隔离挂载运行均通过；唯一实质变化是日志格式）。
- 未做的验收项：② 坏会话 v2 迁移命运、③ validator 是否接受 `runtime-continuation`（**静态已知：仍拒绝，全包 0 命中**）、④ runtime-owned state（**静态已知：仍无**）、⑦ 帧不变量（**静态已知：不变**）。② 需要真跑，按指示本轮未动。

## 四、下一方向：异步 Execution lifecycle 所有权（2026-09-04 定题）

> 异步 Job / Subagent 生命周期能否由 Runtime 持有并在完成时反应，而不是 Agent 自己 wait/check/poll。

**判决（源码取证 + 2026-09-04 spike 实证，勿重查）**：

| 场景 | 判决 | 依据 |
|---|---|---|
| Subagent | **B + C（已实证）** | 平台原生事件源生命周期（start/end + durable run rows），父免轮询（平台自动 resume）；插件可 `ctx.on('subagent/end')` fold（unscoped 根作用域与父 agent 作用域均实测收到） |
| Background job | **C（已实证；观察面成立、持久化仍缺）** | wakeup notice = 合法 user-role 免轮询；且 `ctx.jobs.onJobDone` / `onJobsChanged` 是公开 effect-scoped 服务级监听器，第三方可 fold。缺口 = 无 Cordis 事件对（`job/start|end`）+ 实现进程本地 |
| 共有持久化 | **D（已实证）** | job 记录不落盘、跨 restart 消失；Runtime 自己的派生 fact 跨 restart 无受契约的 runtime-owned state 通道（= v2 验收④） |

> 实证详见 `docs/status/async-execution-lifecycle-spike-2026-09-04.md`，原始 artifact 在 `experiments/async-lifecycle/`（三格全部用合法形态跑通，无 synthetic assistant）。
>
> **子代线已单独展开**：`docs/status/child-lifecycle-ownership-spike-2026-09-04.md`（5 case 因果时序：ownership 冒泡 / waiting 不可见 / 结果传播重复与迟到）。

明确排除 A（不是隐藏 tool call）。核心缺失精确清单：① job 公开**事件**对（job/start|end；现状只有服务级回调）② job 跨 restart 持久化语义（已实证：无）③ runtime-owned state 通道。**不需要**任何 synthetic assistant 通道。

架构不变量：`真实执行 → Runtime Event → Runtime State → Runtime Reaction →（必要时）合法 continuation`；"事实已发生"与"是否值得唤醒模型"两个决定分离。

### 验证 spike（2026-09-04 已闭环，隔离 home，纯 C 路线）

```text
① 父作用域插件 ctx.on('subagent/end') → fold settlement → completion fact
   → 已验证：unscoped 根 + 父 agent 作用域均收到 start/end 成对事件；无父轮询、无伪造 assistant
② 一次 spawn 后父全程不 wait/check → 平台是否自动 resume（continuable 模式）
   → 已验证：父回合 idle 后平台自行 followup/steer 投递 settlement notice（user-role）
③ job：启动后不 wait，观察 wakeup notice 经 agent/inbox/claimed 到达
   → 已验证；host 重启后 job 状态不存（无落盘记录 + 新进程 job_list 为空）
输出：见 docs/status/async-execution-lifecycle-spike-2026-09-04.md（判决表已回填）
```

## 五、环境纪律（学费）

- 改正在跑的 dsh 安装 = 自杀；patch 实验放 fork/副本
- 插件消费服务用 `inject` 声明；apply 时 `ctx.get` 可能拿不到（静默降级坑）
- 实验：隔离 home + 纯 ASCII driver（PS5.1 中文吞行）+ zstd 解码（magic `28 B5 2F FD` 逐帧）+ 出机器内容走 sanitize
- 证据分级（机制级/场景级/未建立）；不外推小样本；先钉死后动手；Runtime 大部分时间沉默

## 六、待办

1. ~~**异步 lifecycle spike ①-③**~~ ✅ 2026-09-04 闭环（判决表已回填，证据 `docs/status/async-execution-lifecycle-spike-2026-09-04.md` + `experiments/async-lifecycle/`）
2. ~~**Child Lifecycle / Ownership spike（5 case）**~~ ✅ 2026-09-04 闭环（`docs/status/child-lifecycle-ownership-spike-2026-09-04.md`）
3. ~~**Child Orchestration Phase 1（wait，4 case）**~~ ✅ 2026-09-04 闭环（`docs/status/child-orchestration-semantics-phase1-2026-09-04.md`；结论：`subagent/end` 即唯一 terminal predicate，wait 落编排层）
4. ~~**Child Orchestration Phase 2（result，4 case）**~~ ✅ 2026-09-08 闭环（`docs/status/child-orchestration-semantics-phase2-2026-09-08.md`；结论：result = child-authored relay + settlement stub 两条独立通道，不排序不合并）
5. ~~**升级 0.1.3-alpha.2 + 影响核对**~~ ✅ 2026-09-08（`docs/status/dsh-0.1.3-alpha.2-update-impact-2026-09-08.md`；9 case 重跑 21/21，runtime 插件无影响）
6. ~~**Child Result provenance 分层 + 轨迹插件可用性**~~ ✅ 2026-09-08（`docs/status/child-result-provenance-and-trajectory-tooling-2026-09-08.md`；结论：**无 Result primitive**，collect 不该由 runtime 定义；`dsh-analysis-view` 对已结算会话在 v2 上失效，根因 `sessionPersistence.inspect` 被 SessionHandle 取代）
7. ~~**Child Orchestration Phase 3（waiting 归属，3 case）**~~ ✅ 2026-09-09 闭环（`docs/status/child-orchestration-semantics-phase3-2026-09-09.md`；结论：**waiting 是 orchestration-facing 且可由官方事实自行推导**，无需新 primitive、无需 waiting notice；8/8）
8. ~~**Child Orchestration End-to-End Demo**~~ ✅ 2026-09-09 通过（`docs/status/child-orchestration-e2e-2026-09-09.md`；spawn×4 → 编排层 wait-all + `sessionQuery.readSession` 查轨迹 → 一行 digest 注入父 → 父合成；父全程只有 4 次 `subagent` 调用、零轮询。两个发现：`wait` 清干净的是编排层而非模型收件箱；collaboration 正文在 tool-call 参数里）
9. ~~**`dsh-trajectory-query` 可用性验证**~~ ✅ 2026-09-09（原样加载其 host 插件，对**已结算**子代实测 `trajectory_window`/`find` 均可用；与 `dsh-analysis-view` 互补，后者对已结算会话在 v2 上仍 500）
10. v2 验收②（坏会话迁移命运）——需真跑，按指示暂不动；③④⑦静态已答（仍拒绝 / 仍无 / 不变）
11. 用户侧待修（不属本线）：`dsh-analysis-view` 兜底改用 `sessionPersistence.open()` + `SessionHandle.read()`
12. ~~**收档产物：Child Orchestration Semantic Contract**~~ ✅ 2026-09-09（`docs/20-child-orchestration-semantic-contract.md`；五段：Problem / Observed DSH facts / Layer boundary / Non-goals / Minimal reference flow）
13. ~~仓库名~~ ✅ 2026-09-09：`dsh-runtime-react` → **`dsh-runtime`**（PUBLIC，旧名重定向），并修正各 package.json 的 repository 字段
14. `core/runtime-orchestration`：契约的最小实现（wait/waitAll/residency），已装进 live web profile

> **子代线分层已定稿**（Phase 1-3 + provenance + e2e）：Runtime 发布事实（`subagent/start|end` + ownership + 合法 notice/wake）→ 编排层推导 residency / `wait` / `query(child trajectory)` → 模型决定"下一步"与"什么算产出"。最小 primitive 集 = `spawn / wait / query trajectory`，契约见 `docs/20-child-orchestration-semantic-contract.md`。官方仍缺：Result primitive、job 事件对/持久化、runtime-owned state。
