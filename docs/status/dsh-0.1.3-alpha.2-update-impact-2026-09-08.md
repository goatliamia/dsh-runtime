# DSH 0.1.3-alpha.2 升级影响核对（2026-09-08）

- 触发：官方 `alpha` 通道发布 `0.1.3-alpha.2`（2026-09-07 13:11 UTC），用户手动升级 live 安装
- 结论：**对 runtime 线与已有实验结论无影响**；唯一实质变化是会话日志格式 v2
- 证据：`experiments/async-lifecycle/verification.txt`（rc.1 与 alpha 同一套 9 个 case 的稳定语义对照）

## 1. 版本现状（升级后复核）

```text
latest : 0.1.2-rc.1      next : 0.1.2-rc.1      alpha : 0.1.3-alpha.2
已装   : dsh 0.1.3-alpha.2 / dsh-session 0.1.3-alpha.2 / SESSION_FORMAT_VERSION = 2
```

`npm i -g @deepseek-ai/dsh` 只装 `latest`，所以 alpha 必须显式 `@alpha`。

## 2. 静态核对：结论依赖的钉死事实

| 事实 | rc.1 | 0.1.3-alpha.2 |
|---|---|---|
| `AgentStatus` | `'idle' \| 'running'` | **不变** |
| `list_agents` 的 `statusOf` | `running` / 否则 `idle` / 无 live agent 为 `ready` | **不变**（waiting 仍被压成 idle） |
| settlement 文案 | "finished and will do no further work…" / "was stopped before it finished." / "It left no closing message." | **不变** |
| `notifySettlement` 先于 `observer.settle` | 是 | **不变**（新行号 1238 < 1240） |
| `jobs-local` 内存态 | in-memory | **不变** |
| 帧不变量 `assertZstdHeaderFrame`/`scanZstdFrames` | 有 | **不变** |
| validator 接受 `runtime-continuation` | 拒绝 | **仍拒绝**（全包 0 命中）→ Line B 仍需，但本轮不碰 |
| `SESSION_FORMAT_VERSION` | **0** | **2** |

v2 带来的新东西（与我们的语义结论无关）：`assistant/attempt` 事件、`assistant/message` 携带 `stream`、`SessionHandle` + 内核写锁/跨进程写锁、`team/*` 事件族。

## 3. 经验对照：同一套 9 个 case 在新版重跑

把 rc.1 的 artifact 留档（`results-v2-rc1/`、`results-orch-rc1/`），用**完全相同的任务文本**在 alpha 上重跑：

```text
rc.1  基线： 21/21 pinned semantics hold
alpha 重跑： 21/21 pinned semantics hold
```

覆盖：settlement 边先于/后于 notice、relay 与 notice 的重复、`list_agents` 压 idle、ownership child-first 冒泡、aborted 终局与 steer 注入、wait 的四条判据（fact / already-settled / waiting 负例 / timeout）。

### 唯一一处表面差异（已定性为竞态，不是语义变化）

case 5「父已给出最终答复后，结算通知又带来一次回合」：

| 版本 | 时序 | 表现 |
|---|---|---|
| rc.1 | 父 turn2 结束 18574 → notice 18640 | **新开 turn3** |
| alpha | notice 18542 落在父 turn2 仍在跑时 | **steer 进 turn2**（同轮多两条 FINAL） |

这正是 `notifySettlement` 的 `parent.status === 'idle' ? followup : steer` 两条分支。把判据从"必然新开回合"改成稳定语义（"通知一定在父已答复后仍把它拉回来一次"）后，两边都成立。Phase 2 的 R1/R2 已把这两个分支做成受控实验。

## 4. runtime 插件现有功能

- **静态**：seam 插件用到的 API 面在 alpha 上齐全——`tools/result`、`agent/pre-step`、`ctx.settings.register/update`、`ctx.commands.register`、`ctx.get('webServer')`。
- **动态**：隔离 home + headless profile + `dsh-runtime-seam` 真实挂载并跑通一个任务
  （`--dump-config` exit 0 且列出该行；运行 exit 0，输出 `SEAM-OK`；stderr 仅 headless 的 reasoning 流）。
- live `web` profile 在 alpha 上的 `--dump-config` 同样 exit 0，runtime-seam 行在位。

## 5. v2 迁移

隔离 home 里 35 个旧会话在首次启动时被迁移，生成 `session.v2.jsonl.zstd`，stderr 为空。
本会话（live）也在升级后被 resume 到新版上，日志同为 v2。

## 6. 结论

- **对我们已有实验结论：无影响。** 平台机制、事件语义、文案、wait 判据全部一致。
- 唯一需要记住的变化是**日志格式 v2**（以及 SessionHandle + 跨进程会话锁），它影响的是碰 session append / 并发持有的插件代码，不影响本轮任何结论。
- `runtime-continuation` 仍被 validator 拒绝，Line B 的前提没有变（本轮按指示未动）。
