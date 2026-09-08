# Child Orchestration Semantics Spike — Phase 2（result）（2026-09-08）

- 状态：**已闭环**（4 个 case，并行跑，DSH 0.1.3-alpha.2）
- 承接：Phase 1 `docs/status/child-orchestration-semantics-phase1-2026-09-04.md`（wait 落编排层）
- 证据：`experiments/async-lifecycle/results-result/r1..r4.jsonl` + `verification.txt`
- harness：`experiments/async-lifecycle/harness/run-result-par.ps1` + `analyze-result.mjs`

> 问题：**子代的"结果"是 execution outcome（settlement），还是 collaboration message（report）？**
> 本轮不 patch、不改 core，只测语义。

## 1. 设计

子代被要求产出**两条**东西：

```text
C: (a) 睡一会儿
   (b) send_message 给父：REPORT-A…     <- child-authored collaboration message
   (c) 结束回合，final assistant = REPORT-B…  <- execution outcome 的载荷
```

在四种父侧语境下测到达顺序：

| case | 语境 |
|---|---|
| R1 | 父 idle |
| R2 | 父 busy（正在跑一个 30s 前台命令） |
| R3 | 两个子代各自独立汇报 |
| R4 | 嵌套（孙代 → 子代 → 父） |

子代模型 = 本会话模型（`deepseek-v4.1-flash-expires-on-0910`），四个 case **并行**跑（各自独立 profile）。

## 2. 结果

| case | 到达顺序（父侧） | 父被唤醒 |
|---|---|---|
| R1 | `report@12260` → `notice@12782` → `end@12783` | turn2 由 report 开；notice 落在同一轮（steer），父同轮产出两次 ACK |
| R2 | `report@12306` → `notice@12989` → `end@12991`（父还在 30s 前台命令里） | 两条都等到 34129 的步骤边界才被 claim，**同一个 turn1** 里消化 |
| R3 | child-two：`report@10859` → `notice@11339`；child-one：`report@18796` → `notice@19833` | 每个子代**各唤醒两次**（共 4 个新 turn） |
| R4 | `report@4260`（子代主动发的）→ 子代终局前的 notice；`C1 end@13908` → `C end@14713` | 子代必须先等孙代结算；父收到的是子代的 notice |

四条 case 的顺序**完全一致**：**child-authored report 总是先到，settlement notice 紧随其后**。

### 关键点

1. **两条通道 provenance 不同、平台不做合并或排序**：
   - report = `source.kind="agent-message"`（子代自己选择说的话）；
   - notice = `source.kind="subagent-settled"`（runtime 对子代结局的陈述）。
2. **settlement notice 只带最后一条 assistant 文本**（`Its closing message: REPORT-B`），**不带** REPORT-A 的内容。
   也就是说：**只消费 settlement 通道的编排层拿不到业务结果，只拿到一个 stub。**
3. **父最多被同一子代唤醒两次**（report 一次、settlement 一次）；R3 里两个子代 = 4 个新回合。
   平台没有"report 与 settlement 合并成一次投递"的机制。
4. R2 证明：父忙的时候两条都**不丢**，而是被 steer 到下一个步骤边界一起消化——`inbox/claimed` 在同一 turn。

## 3. 结论

```text
"result" 目前不是一个东西，而是两个：
  - execution outcome  -> settlement notice（runtime fact，载荷 = 最后一条 assistant 文本）
  - collaboration report -> agent-message relay（child-authored，载荷 = 子代真正想说的内容）

二者不排序、不合并；平台只保证各自送达。
```

对编排层的直接含义：

- **wait 用 settlement fact 是对的**（Phase 1）；
- **collect 不能只读 settlement**——必须读 child-authored 通道（relay）或子代 session，否则拿到的只是 stub；
- 想要"一个结果"的语义，得由编排层自己按 childId 把两条通道**归并**（这是 Phase 2 暴露出来的、官方目前没有的 primitive）。

## 4. 复跑

```powershell
pwsh -File experiments/async-lifecycle/harness/run-result-par.ps1 -Only 'r1,r2,r3,r4'
node experiments/async-lifecycle/harness/analyze-result.mjs <HOME>\Documents\async-spike\results-result
```

任务文本：`experiments/async-lifecycle/tasks-result/task-r1..4.txt`。
