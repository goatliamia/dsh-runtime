# 熔断指纹在文件工具上是坏的（2026-09-11）

- 状态：**已实测**（3 个 live 会话 + 1 个单元级复现），**未修**
- 触发：live 会话里出现 `[runtime-observation circuit-open] ... do not retry read/edit/write`
- 环境：DSH `0.1.5-rc.1` + `dsh-runtime-seam`（web profile 实装版）
- 证据：`~/.dsh/sessions/...`（trajectory 查询，见下）、`async-spike/circuit-fingerprint.mjs`

---

## Problem

DSH 的原生规则是**写文件前先读**。违反它时工具返回的是一句**带解法的教学错误**：

```text
Error: edit requires reading "<path>" first — read the file, then retry
FsError
FS_NOT_OBSERVED
```

而 live 的熔断把这类错误当成"重复且无进展的失败"，并以 `authority: runtime` 断言一个**假事实**：

```text
[runtime-observation circuit-open]
capabilities.edit.state = "failed" (authority: runtime, revision: 1, fingerprint: 6ee78e566fcef37a)
repeated identical failure detected; do not retry edit.
```

同一步里，模型同时收到两句话——**工具说"读了再重试"，runtime 说"不要重试"**。

---

## Observed facts

### live 观测（三个会话，三个工具）

| 会话 | seq | 被熔断的工具 | 注入原文 |
|---|---|---|---|
| `…13b11ba4` | 1137 | `edit` | `capabilities.edit.state = "failed"` … `do not retry edit` |
| `…13b11ba4` | 2634 | `edit` | 同上（插件重挂载后重新计数） |
| `…a8b91920` | 2741 / 3369 | `edit` | 同上 |
| `…2896258a` | 1774 | **`write`** | `capabilities.write.state = "failed"` … `do not retry write` |
| `…2896258a` | 4268 | **`read`** | `capabilities.read.state = "failed"` … **`do not retry read`** |
| `…2896258a` | 2025 / 4460 | `edit` | 同第一条 |

三个工具、三个指纹，**跨会话完全一致**（`edit` 恒为 `6ee78e566fcef37a`）——指纹里没有路径、没有错误文本。

`read` 被熔断是最刺眼的一幕：**read 正是这条错误的解法**。真按通告执行，会话当场死锁（不能读 → 不能改）。

### 源码事实

| # | 事实 | 证据 |
|---|---|---|
| F1 | 指纹 = `digest({ tool, code })`，`code = /E\d+/.exec(errorText)?.[0] ?? "generic-error"` | `core.mjs:121-123`（repo 与实装版逐字节一致） |
| F2 | DSH 的文件错误码形如 `FS_NOT_OBSERVED` / `FS_STALE_VERSION`，**不含 `E<digits>`** → 一律落到 `generic-error` | `dsh-tool-fs/lib/index.js:547-548` |
| F3 | 于是**同一工具的任何文件错误共用一条计数**：不同文件、不同原因、跨整个会话累加 | F1 + F2 |
| F4 | 阈值默认 2（`circuitThreshold` schema default）；`counts` 只增不减，`open` 是永不清空的 Set | `index.js:38`、`core.mjs:114-131` |
| F5 | `[action-rejected]` 有豁免（"教学式拒绝不得开熔断"），但**文件协议错误没有**——尽管它同样是教学式的 | `index.js:290-292` |
| F6 | guard dispatcher 只查 `guardRules`，而 `guardRules` 仅由显式注册填充；**没有任何代码把熔断开的工具变成拒绝** | `index.js:245-274`、`:229` |
| F7 | `:314-316` 的注释声称"handled inside the dispatcher below"——**dispatcher 里没有这段**（注释与实现不符） | 同上 |

### 单元级复现（`async-spike/circuit-fingerprint.mjs`，直接 import 实装版 tracker）

```text
case              tool        signature          count  opened
edit/unread-A     edit        858da252b4d23756  1      false      code=generic-error
edit/unread-B     edit        858da252b4d23756  2      true       code=generic-error   ← 不同文件
edit/other-reason edit        858da252b4d23756  3      false      code=generic-error   ← 完全不同的错误
read/missing-A    read        2b13b0dbf2a5b87c  1      false
read/missing-B    read        2b13b0dbf2a5b87c  2      true                            ← 熔断 read
write/unread      write       1e3020e43844fd9a  1      false
control/coded-A   exp_flaky   19feba9a876b797c  1      false      code=E32001
control/coded-B   exp_flaky   dfd4b139551a0d79  1      false      code=E32002          ← 有码就分得开

COLLAPSED: 858da252b4d23756 <- unread-A + unread-B + other-reason
```

对照组证明这不是 `CircuitTracker` 本身不可用：**只要有 `E<digits>` 码，指纹就正确区分**。坏掉的是回退分支把"没有码"变成了"所有错误同一个码"。

（live 记录的 `6ee78e566fcef37a` 与今日实装版算出的 `858da252b4d23756` 不同值：记录那次会话跑的是更早的 seam 构建，`digest` 输入变过；两版 `observeFailure` 的逻辑逐字节相同，所以塌缩行为一致。）

---

## 后果（实测行为，不是推测）

```text
seq 1133  tool/call   edit  sync-to-repo.mjs
seq 1134  tool/result Error: edit requires reading "…sync-to-repo.mjs" first — read the file, then retry
seq 1137  user/message [runtime-observation circuit-open] … do not retry edit.
seq 1139  tool/call   read  sync-to-repo.mjs          ← 模型照工具说的做
seq 1144  tool/call   write sync-to-repo.mjs          ← 但换掉了被"判失败"的工具
seq 1145  tool/result Updated file                    ← 成功
```

1. **它教的是绕开工具，不是修复错误。** 模型读了文件，然后从 `edit` 换成 `write`。带 `authority: runtime` 的假事实足以改变工具选择——这是事实登记表的信任面被自己花掉。
2. **它没有阻止任何循环。** 同一会话在 seq 1137 / 2634 之后仍有 **99 次**成功的 `edit`/`write` 结果，全程 **零** 条 `[action-rejected]`——通告与执行不一致（F6）。
3. **一旦补上执行，就是死锁。** 因为 `read`/`write`/`edit` 互为解法，"do not retry read" 真执行起来会把会话锁死。所以正确修法不是"把 guard 补上"。

---

## 建议的修法（未实现）

1. **指纹要包含错误身份，而不只是工具。**
   把回退分支从 `"generic-error"` 改为**归一化后的错误形态**：剥掉引号内的路径、压缩空白，再取指纹。
   这样"同一个错误在两个文件上"仍算重复（对的），"读前写"和"锚点不存在"不再混为一谈（也是对的）。
2. **文件协议错误整类豁免**，与 `[action-rejected]` 同一理由（F5）：
   `FS_NOT_OBSERVED` / `FS_STALE_VERSION` 是**带解法的教学结果**，不是"无进展失败"。
   判据可以机械地写在错误文本上（它自己就带 `FsError` + 大写码这两行）。
3. **让通告与执行一致**：要么实现 F7 注释所声称的拒绝，要么把注释改成"announce-only，暂无执行"，不要让注释许诺一个不存在的行为。

第 1、2 条合起来意味着：**文件工具永远不该开熔断**——它们的失败要么可自解，要么（权限/磁盘）会被模型自己报告。熔断留给真正会打转的能力（`exp_flaky` 那类）。

---

## 证据路径

- 单元复现：`async-spike/circuit-fingerprint.mjs`（`node circuit-fingerprint.mjs`）
- 源码：`core/runtime-seam/lib/core.mjs:108-132`、`core/runtime-seam/lib/index.js:276-316`、`@deepseek-ai/dsh-tool-fs/lib/index.js:545-550`
- live 观测：`trajectory_find` 查 `[runtime-observation circuit-open]`、`has not been read`、`action-rejected`
