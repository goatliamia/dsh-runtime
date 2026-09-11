# 事前引擎产品化（Pre Continuation Engine v1）· 2026-09-03

## 做了什么

把实验验证过的 continuation 机制（docs/19 路线 A rounds 1-4 + rn A/B）从实验插件
`experiments/native-pp/rc/continuation` 产品化，并入 `core/runtime-seam`（lib/pre-continuation.mjs），
由 settings 的 `runtime-seam.continuation` 开关直接驱动。设置页「事前·开」从此有引擎可亮。

保留的通用机制（与实验同构，已验证）：
- agent/pre-step 内：投影会话事件流 → 合同分类（唯一/多义/无）→ CAS 再投影防陈旧 →
  走公共工具管道 `ctx.tools.execute` 派发（正常权限/守卫/取消边界，signal.aborted → aborted）→
  追加 assistant/tool-call + tool/call + tool/result + runtime/continuation 记录（surfaceOp append）→
  一条 digest 注入模型消息。
- llm/stream 过滤器：`cont_` 协议占位对**持久但不进模型请求**（防 DeepSeek orphan-tool 400）。

剥掉的实验脚手架：场景/env（EXP_*）、结果目录与指标 JSON、fixture 事实（reload.ps1/artifact）、
4 秒取消注入握手窗（生产无测试钩子，纯延迟）、按场景写死的合同表。

## 首发日常合同 v1：post-write-syntax-check

模型对工作区内**任何 .js/.mjs/.cjs 文件的 write / str_replace_editor / edit 之后**，
若自上次 `node --check` 以来仍有未检查文件，Runtime 在下一次 pre-step 直接执行
`node --check '文件'`（多个文件拼一条 pwsh，burst 全查），并把结果 digest 给模型。
write 计入——rn A/B 证明「一次 write 后不再 edit」会绕过只看 str_replace 的旧合同。
排除 node_modules 与非 JS。用两趟投影：先定最后一个检查的 seq，再收比它新的写入。

## Headless 真实任务验证（profile pre-a, deepseek-v4-flash, 任务=写双模块+run.mjs）

修过两个移植期 bug，均与新运行时 0.1.2-rc.1 相关：
1. `session.events` 被移除 → `eventsOf()` 双 API 兼容（snapshotEvents() 回退）——已沉淀 PITFALLS；
2. 分类顺序依赖 → 两趟投影。

最终验证 run（session-598389d3）：3 文件同一步 burst 写入 → step 4 pre-step 分类 required
（pending 3 文件）→ 派发 `cont_` pwsh `node --check` ×3（seq736）→ runtime/continuation 记录
（seq738, outcome=dispatched）→ 模型最终总结明确引用「三个文件均通过 node --check 语法校验」
（digest 送达的行为证据）→ 任务 exit 0、无 API 400、模型未重复自查。
metrics: dispatches=1, blocked/aborted/discards/ambiguous=0。

## 边界与后续

- 合同表是 registry 形态，后续合同按 DAILY_CONTRACTS 加（宁缺毋滥：只在实证翻车点签）。
- digest 走请求消息（不单独落会话日志）——实验同款；行为证据 = 模型下游不重复劳动。
- 诊断文件 pre-diag.json（agent/disposed 写一次）保留，headless/故障排查用，体积极小。
- 生产生效：装进 web profile node_modules + bundles 已含（重启后生效，当前运行实例仍是旧模块）。

## 状态

- core/runtime-seam：lib/pre-continuation.mjs（新）、index.js（mount + import）、client.js（UI 文案+Pre 活动分类）
- 单测 core/runtime-seam/pre-continuation.test.mjs：7 项全过（多文件语义）
- release/*.tgz 重打；Documents/plugins/dsh-runtime-seam + web profile node_modules 已换新
- web profile dump-config exit 0
