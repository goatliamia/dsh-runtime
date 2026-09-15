# DSH 0.1.6-alpha.1 更新准备

- 状态：**静态面已核对，未升级**（2026-09-15）
- 方法：更新公告页取不到（`github.com/deepseek-ai/deepseek-harness/releases` 抓取失败），改用**包对账**：把 `0.1.6-alpha.1` 的包拉到本地，与本仓引用的每一个点逐条比对
- 已核对包：`dsh`、`dsh-base`、`dsh-agent-loop`、`dsh-tools`、`dsh-tool-fs`、`dsh-subagent`、`dsh-agent-presets`、`dsh-headless`、`dsh-web-app`、`dsh-agent-tool-presentation`、`dsh-app-boot`、`dsh-workflow-ptc`

## 一、这次更新的实质：两个新包，换掉一个

`dsh@0.1.6-alpha.1` 的直接依赖 72 变 73：

| 变化 | 包 | 它是什么 |
|---|---|---|
| 新增 | `dsh-mcp-resources` | Scoped MCP resource discovery and reading through shared model tools |
| 新增 | `dsh-workflow-ptc` | Workflow orchestration in the shared sandboxed Node PTC runtime |
| 移除 | `dsh-workflow-worker-thread` | 旧的独立 worker-thread 工作流引擎 |

方向很清楚：**workflow 从自己的 worker thread 搬进了共享的 PTC 运行时**。PTC preset 里那一行也跟着换了：

```text
旧：- id: workflow-worker-thread   name: '@deepseek-ai/dsh-workflow-worker-thread'
新：- id: workflow-ptc             name: '@deepseek-ai/dsh-workflow-ptc'
    # No consumer here: tool-workflow is off in PTC mode and tool-ralph
    # below is off by default. Restore this row together with tool-ralph.
```

`dsh-code-runtime` 与 `dsh-code-runtime-worker-thread` 两包本身**没动**（仍停在 `0.1.5-alpha.2`）。

对我们的意义：`workflow-ptc` 把"模型写的编排脚本"和 `run_code` 放进了同一个沙箱运行时。这正是 producer map 里 C 类（装配重叠）适用的新落点——脚本能拿到绑定值的零件，和 PTC 那次实测同形。

## 二、对我们没有影响的部分（逐条核过）

| 面 | 结论 |
|---|---|
| **ReAct 循环层** | 10 个探针**全部原行号命中**：`:783` send、`:792` steer、`:795` inject、`:894` `agent/pre-step`、`:934` `while(true)`、`:967` `agent/turn-stopping`、`:973` 唯一另一出口、`:1143` `agent/request`、`:1088` `agent/request-error`、README `:200` no turn budget。**循环层这一版一字未改** |
| **事件面** | `dsh-tools` 10 个事件、`dsh-subagent` 27 个、`dsh-agent-presets` 16 个，集合**完全相同**。唯一变化：循环层的 `agent/session-start` **被删除**（本仓没有任何地方用它） |
| **工具管线** | `tools/pre-execute` / `tools/execute` / `tools/post-execute` / `tools/result` / `guardReason` 全部仍在，只是整体下移约 110 行（文件变长） |
| **FS 错误码** | 5 个码一字未变；**带解法的仍只有两个**（`FS_NOT_OBSERVED`、`FS_STALE_VERSION`）。我们熔断的豁免名单**仍然正确且完整** |
| **子代理** | 27 个事件不变；`notifySettlement` 只下移 5 行 |

也就是说：**本仓的插件代码不需要为这次更新改任何一行。**

## 三、需要跟的三处

1. **`dsh-tool-fs` 行号下移 6**：`remediateFsError` 的两个码从 `:536-537` / `:547-548` 变为 `:530-531` / `:541-542`。
   受影响文档：`docs/status/circuit-fingerprint-vs-fs-errors-2026-09-11.md`（两处引用 `:545-550`）。
2. **`dsh-tools` 行号下移约 110**：没有文档引用它的具体行号，只有 `docs/16-native-pp/event-semantics.md`（钉在 0.1.2 那一版，属历史记录，不改）。
3. **PTC preset 行号**：`mode: ptc` 从 `:272` 到 `:280`。

## 四、升级前必须做的一次实跑（这条是空的）

**问题：0.1.6 里 PTC 运行时的挂载点找不到了。**

旧版里 `dsh-headless` 和 `dsh-web-app` 的补丁各插一行：

```yaml
- insert:
    # PTC mode is a core execution capability, not a Web component.
    - id: code-runtime
      name: '@deepseek-ai/dsh-code-runtime-worker-thread'
```

新版**两处都没有了**。而在我核对过的 12 个包里，`codeRuntime` / `code-runtime` 字样**一次都没出现**（`dsh-base` 没有，`dsh-tools` 没有，`dsh-agent-tool-presentation` 没有，`dsh-app-boot` 没有）。

两边的 PTC 开关还在（`mode: !!js process.env.DSH_TOOLS_MODE`，headless `:18`、web-app `:38`），但**如果没有任何地方组装 `ctx.codeRuntime`，PTC 模式会在挂载时直接失败**——旧版 ptc preset 的注释就是这么写的："a deployment that composes no TypeScript runtime fails this preset at mount"。

静态读不出来，只能实跑定音：

```bash
# 升级后，一条命令就能判
DSH_TOOLS_MODE=ptc dsh --profile ptcexp "报告你的工具名"
#   成功 → 运行时装在别处（可能在未核对的包里），PTC 结论可复现
#   失败并指名 codeRuntime → 挂载点真的没了，PTC 实验需要自带一行 insert
```

**在跑通之前，不要把 PTC 那组结论当作在新版本上可复现。**

## 五、升级检查清单

升级前（本仓，可先在旧版做完）：

- [x] 静态对账：循环层、事件面、工具管线、FS 码、子代理面（本文档）
- [ ] 跟行号：`circuit-fingerprint-*.md` 的两处 `:545-550` 改为 `:539-544`，并注明版本
- [ ] 在 `docs/21` 的适用版本里补一行 0.1.6-alpha.1 复核

升级后（按顺序）：

- [ ] **插件加载冒烟**：`runtime-seam` / `runtime-orchestration` / `dsh-notify` 是否仍挂得上（它们依赖 `tools.register(defineTool)`、`ctx.on` 事件名、`tools.guard`——事件面没变，预期能挂）
- [ ] **PTC 实跑**（§4 那条命令）
- [ ] **熔断豁免仍生效**：故意对未读文件写两次，确认不再出现 `circuit-open`
- [ ] **打包复核**：`node scripts/pack-release.mjs`（自带 verify-release）
- [ ] **live profile**：确认 `dsh-runtime-seam-*-r4.tgz` 等 `file:` 依赖不受 dsh 版本影响（它们是独立包，预期不受影响）

## 六、一句话

**这次更新对我们最要紧的不是"哪里会坏"，而是"PTC 运行时的挂载点变了、而且旧版那组 PTC 结论的可复现性暂时无法确认"。** 其余全是行号平移，代码一行不用改。
