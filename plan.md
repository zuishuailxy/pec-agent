# PEC 采购异常处置 Agent · 实施计划（plan.md）

> 角色：SDD（spec-driven development）单一事实来源。先写 spec（本文 + `todo.md`），再按「模块 spec → 实现 → 验证」逐块推进；每完成 `todo.md` 一项，按交接文档 §0.1 向用户汇报并等确认。
>
> 截止：**2026-11-08 15:00（Asia/Shanghai）**；D1 = 2026-11-07，D2 = 2026-11-08。每日收工打 tag `d1` / `d2`。

## 1. 目标与验收映射

在预装 DSH 0.2.1-rc.2 + headless profile 上，把采购异常处置链路补成可评测的 Agent 能力：

| 交付项 | 内容 | 六项指标映射 |
|---|---|---|
| `plugins/pec-tools/` | 6 个业务工具（`defineTool` + guard + render + provenance）+ `advice_card` | 准确率、引用可溯、越权拦截 |
| `memory/` | 会话/用户两层记忆、白名单抽取、TTL、冲突留痕、每轮注入 3–5 条 | 记忆命中率 |
| `.dsh/skills/` | 手写技能 A `delay-small-standard` + Agent 沉淀技能 B `stock-replenish` | 技能复用率 |
| `eval/` | 12 条 golden set（5 正常 / 3 边界 / 2 对抗 / 2 记忆技能）+ 专项集 + A/B 8 条 + 门禁 | 六项指标全部 |
| `traces/` | qa / memory / skill-write / skill-hit 四类真实运行记录 | 证据 |
| 文档 | design / README / ARCHITECTURE / CHANGELOG（含 CR#1）/ defense | 可复现、可答辩 |

六项目标：回答准确率 ≥90%、引用可溯率 100%、记忆命中率 ≥80%、技能复用率 ≥60%、提效 ≥30%、越权拦截率 100%。

## 2. 现状基线（D1 已完成，勿重做）

- 仓库：`pec-agent/` 独立 git 仓库，HEAD `9209145`（基线 `e0855dd`）。
- 已验证：`./dev/build.sh` 成功；`node dev/test-tools.mjs` **19 passed / 0 failed**；headless 单轮 `order_lookup` 返回 13 天延迟与 `[来源: orders#PO-20261013-0042]`（`runs/baseline-order-lookup.jsonl`）。
- 已实现并验证：`policy/{identity,audit,guard,masking,tool-surface}.ts`、`core/{money,provenance}.ts`、`memory/store.ts`、`errors.ts`、`db.ts`、5/6 业务工具（`ticket_similar` 为桩）。
- 环境约束：不改 DSH 内核、`预装环境/`、`实例数据包/`、交付物 `package.json`；不新增运行时依赖；`.env` 不读/不打印/不提交；只改 `plugins/pec-tools/src/**`、`.dsh/skills/**`、`memory/`、`eval/`、`traces/`、文档。

## 3. 架构与模块边界

```
DSH 平台（不改）
  ├─ Session / Agent / headless --json / systemPrompt.section / skill catalog
  └─ tools runtime：defineTool 参数校验、guard（同步单调）、render（模型唯一可见通道）
        ▲
        │ 插件层 @pec/pec-tools（可改）
        ├─ policy/   identity（PEC_USER_ID→users 表）、audit（JSONL）、guard（伪造 tenantId 拒绝）、
        │            masking（角色矩阵）、tool-surface（restrict 到 8 工具 + skill）
        ├─ core/     money（BigInt 4 位定点 HALF_UP）、provenance（[来源: table#rowId]）
        ├─ tools/    catalog + order_lookup / supplier_profile / pricing_quote / freight_calc /
        │            contract_search / ticket_similar / advice_card
        └─ memory/   store（两层记忆、TTL、白名单、冲突 history）+ inject（每轮注入 3–5 条）
        ▲
        │ 会话/评测层
        ├─ .dsh/skills/  SKILL.md（platform 扫描；frontmatter 校验由 skill_write 工具做）
        ├─ eval/          golden_set.jsonl + run.sh（headless 批跑）+ collect.mjs（断言/统计/门禁）
        ├─ traces/        四类 trace 落盘
        └─ docs           design / README / ARCHITECTURE / CHANGELOG / defense
```

边界原则：

1. **只读数据 + 建议不执行**：所有业务工具只读 SQLite；只产出建议卡与待办，不写订单。
2. **provenance 只走 `render()`**：`output.schema`/canonical value 不上 wire，模型看不见；`render()` 必须把 `[来源: table#rowId]` 写进文本。
3. **身份只信进程/会话**：`PEC_USER_ID` → `users` 表；工具只读 `exec.agent.session.id` + identity，绝不读模型传的 `userId/role/tenantId` 做鉴权；跨租户 `POLICY_DENIED` + 审计（不是 NOT_FOUND）。
4. **金额固定 4 位定点**：`core/money.ts`；中间值不二次 rescale；对外两位小数字符串。
5. **硬约束进 guard/工具，软流程进技能**：技能正文只是文本，护栏必须由工具/guard 兜底（R14）。
6. **新增工具必须同步 `policy/tool-surface.ts` allow 列表并重编译**（否则 restrict 抛错）。

## 4. 数据口径与假设（写进 design.md / CHANGELOG）

| # | 口径/缺口 | 处理（已定，不再推翻） |
|---|---|---|
| 1 | R8 汇率：数据无币种/汇率/日期字段 | 声明不支持：`IMP-` 前缀金额按本币计，建议卡标“未锁汇，需财务复核”，不用硬编码汇率伪造 |
| 2 | R11 成本价：数据无 `cost_price` | 策略位保留但不伪造；字段级越权落 `contacts` 掩码 + 跨租户 |
| 3 | R9 风险分：无 `risk_score` | 自定公式（黑名单 100；delay>10 → 70+min(30,delay-10)；否则 20+4×delay+等级分），`supplier_profile` 已实现并声明“自定口径” |
| 4 | R10 等值边界 0 样本 | 纯函数/夹具断言，不改原库 |
| 5 | R7 ≥20 万 0 样本 | 纯函数断言 200,000.00 / 199,999.99；临界 50,000.00 走主管（`<` 自动、`≥20万` 总监+财务） |
| 6 | R5 MOQ 合同优先无法唯一落地 | 以 `skus.moq` 为准；合同 MOQ 仅提示，冲突取更严（大）值并提示人工 |
| 7 | `tickets` 无 supplier_id/金额 | `ticket_similar` join `orders` 派生；相似度=规则分，非模型分 |
| 8 | 28 条工单 16/28 集中在 `PO-20260917-0129` | 按 `order_id` 聚合去重展示，保留 `sameOrderTickets`/动作分布；统计按去重前计，避免单订单淹没 |
| 9 | `SUP-1047` 无合同；5/8 A/B 供应商无 penalty | `contract_search` 明确“未检索到”，技能护栏禁止编造条款号 |
| 10 | 建议卡 `newDate` 冲突：题面技能样例“实际交期+14 天”（0042→11-16），但 §5.3 示例与历史 `EX-2061` 都是 2026-10-28 | **用户拍板（2026-11-07）：以题面样例技能口径为准**，统一 **实际交期 + 14 天**（0042→2026-11-16）；`delivered_at` 为空时回退承诺交期+14 并标 `newDateSource`；历史 EX-2061 / §5.3 的 10-28 记为文档/数据不一致，写 CHANGELOG；`advice_card` 对 `reschedule` 做确定性重算，保证 A/B 结论一致 |
| 11 | README 说 T-001 80 单实际 79；`delivered_at` 为空仅 1 条（0099） | 以 79 为准；NULL 容忍只用 0099 做载体 |
| 12 | 状态 OPEN/SHIPPED 0 样本 | 文档声明状态分支仅覆盖 CLOSED/DELAYED/DRAFT |
| 13 | 工具名带点会被 DeepSeek API 400 | 全部下划线：`order_lookup` 等（映射见 README） |
| 14 | 税率数据无 | `PEC_VAT_RATE` 默认 0.13 并标 `assumption:` |
| 15 | headless 无人值守 `ask`=deny | 人工确认只做“建议卡 needHuman + 审计”，不依赖 ask |

## 5. 模块 spec

### M1 `ticket_similar`（本项实现）

- **目标**：按异常类型 + 供应商 + 金额区间召回历史工单，给历史处置动作/结论/耗时/是否人工改判/相似度，带 provenance。对应 T6、R12、§8.3-1，支撑技能沉淀与记忆。
- **输入**（`parameters`）：
  - `exceptionType: string`（必填）：`DELAY|STOCK|PRICE|FREIGHT|RISK`；接受中文别名（延迟/缺货/价格/运费/风险）→ 归一化；未知值 `INVALID_ARGUMENT`。
  - `orderId?: string`：可选。给定时先做租户校验（跨租户 `POLICY_DENIED`+审计、不存在 `NOT_FOUND`），并派生 `supplierId`（若同时显式传入且不一致 → `INVALID_ARGUMENT`）。
  - `supplierId?: string`：可选；跨租户 → `POLICY_DENIED`+审计。
  - `amountMin?: number`、`amountMax?: number`：可选金额区间（元，含边界；非负；min>max → `INVALID_ARGUMENT`）。
  - `limit?: integer`：1–20，默认 5。
- **召回与相似度**（规则分，写死可解释）：
  - 候选 = `tickets join orders join suppliers`，强制 `tickets.tenant_id = 当前身份 tenantId`，`exception_type = 归一化类型`。
  - 维度权重：异常类型 40（必选维度）、供应商 30（显式/派生提供时）、金额区间 30（提供任一边界时）。
  - `similarity = round(命中权重 / 已提供维度总权重 × 100)`；严格命中三维 = 100。金额维度按“邻近度”给部分分：区间内=满分；区间外 `max(0, 1 - 距离/参考跨度)`。
  - 排序：严格优先 → 相似度降序 → 金额距离升序 → ticketId 升序（确定性）。
  - 去重：同一 `order_id` 聚合为一条代表（排序后第一条），保留 `sameOrderTickets`、动作分布、改判数；`totalTickets`（去重前）与 `totalOrders`（去重后）都返回，避免单订单淹没。
- **输出**（`data`）：`query`、可选 `orderContext`、`found`、`totalTickets/totalOrders/strictCount/relaxedCount/returned`、`noHitReason`、`stats{avgMinutes, overriddenRate, overriddenTickets, actionCounts, supplierCount}`、`tickets[]`（`ticketId/orderId/exceptionType/action/outcome/minutes/overridden/supplierId/supplierName/amount/status/similarity/matchedOn/relaxedOn/sameOrder*`）；`provenance` 含 `tickets#…`、`orders#…`、`suppliers#…`。
- **render**：召回总数/严格/放宽、逐条历史处置（含`[来源:]`）、统计行；无命中明确“不得编造历史处置动作”。
- **错误**：`INVALID_ARGUMENT`（类型/区间/limit/orderId 与 supplier 冲突）、`NOT_FOUND`（orderId 不存在）、`POLICY_DENIED`（跨租户，先审计）。
- **副作用**：召回成功时写会话记忆 `lastTicketId` / `lastExceptionType`（供下一轮注入）。
- **验收/测试向量**（`dev/test-tools.mjs` 固化）：
  1. `DELAY`（U-07/T-001）→ `totalTickets=15`、`totalOrders=12`、含 `tickets#EX-2061` + `orders#PO-20261013-0042`；
  2. `DELAY + SUP-1050 + amountMax=10000` → 严格命中 2 条（0114 5,239.50 / 0121 6,732.00），`similarity=100`；
  3. `STOCK + SUP-1062` → 去重后 1 个订单、`sameOrderTickets=4`、`overriddenTickets=1`、动作分布 `split×3/reschedule×1`；
  4. `orderId=PO-20260917-0129 + STOCK` → 派生 `supplierId=SUP-1062`，同 3；
  5. `RISK` → `found=false`、`totalTickets=0`，render 含“未召回/不得编造”；
  6. 跨租户：`U-08` 查 `SUP-1042` → `POLICY_DENIED` + 审计；`U-08` 查 `DELAY` → 只见 T-002 的 `EX-2062`；
  7. 非法参数：`FOO`、`amountMin>amountMax`、`limit=0` → `INVALID_ARGUMENT`；
  8. 中文别名 `交期延迟` → 正常召回。
- **验证命令**：`./dev/build.sh && node dev/test-tools.mjs`；headless：`./dev/run-headless.sh --json "调用 ticket_similar …"` 检查 `tool_call` + render 中的来源标记。

### M2 `advice_card`

- **输入**：`action`（`reschedule|switch_source|split|replenish|audit_freight`）、`orderId`、`params`、`amount?`、`evidence[]`、`risks[]`、`confidence`、`needHuman`。
- **权威校验（模型不能绕过）**：
  - 订单必须存在且属当前租户（跨租户 `POLICY_DENIED`+审计）。
  - 金额以 `qty×unit_price`（Fixed，HALF_UP 2 位）为准；传入 `amount` 不一致 → `INVALID_ARGUMENT`；`amount > 0`。
  - `evidence` 每条 ref 必须真实存在（`orders/suppliers/skus/contracts/tickets`），否则 `INVALID_ARGUMENT(E_EVIDENCE_NOT_FOUND)`；条款 ref 建议属订单供应商。
  - R7：`amount < 50000` → `自动`；`50000 ≤ amount < 200000` → `采购主管`；`amount ≥ 200000` → `总监+财务`；黑名单供应商 → 一律人工（强制 `needHuman=true`）。输出 `ruleHits[]` 说明命中规则。
  - `reschedule` 的 `newDate` 统一重算：**实际交期 + 14 天**（题面样例技能口径，口径见 §4-10；交付 0042 → 2026-11-16），忽略模型传入值并记录 `newDateSource`；`delivered_at` 为空时回退 `promised_at + 14`。
- **输出**：`data.card{action, params, amount, evidence, risks, confidence, needHuman, approvalPath, ruleHits, newDate?, newDateSource?}` + provenance（orders/suppliers/contracts）。
- **render**：建议卡（动作/参数/金额/审批路径/风险/置信度/是否人工/依据来源）。
- **错误**：`INVALID_ARGUMENT`、`NOT_FOUND`、`POLICY_DENIED`。
- **测试向量**：0042（57,600.00→主管、needHuman=true）、0055（50,000.00→主管，不是自动）、构造 200,000.00→总监+财务、0129（黑名单 SUP-1062→强制人工）、伪造 evidence→`E_EVIDENCE_NOT_FOUND`、amount 造假→`INVALID_ARGUMENT`。

### M3 记忆工具与注入

- `memory_recall`：`scope?('session'|'user'|'both')`、`taskHint?` → 返回两层命中 + `injected[]`（3–5 条）+ TTL 状态；跨租户不命中（键含 tenantId）。
- `memory_remember`：`scope`、`fields`（白名单：会话 8 字段 / 用户 5 字段）、`source('tool_inference'|'user_correction')`；非白名单字段 → `INVALID_ARGUMENT`；用户更正覆盖并写 history + 审计。
- `memory_forget`：`scope` + `confirm=true`（防误删）→ 删除并审计。
- 注入：新模块 `memory/inject.ts`，`ctx.systemPrompt.section({name:'pec:memory', order:10050, interpolate:false, text:(ctx)=>…})`，每 step 读 store 注入 3–5 条；`inject` 用 optional 方式挂 `systemPrompt`，缺失时降级不报错。空记忆返回 `''`。
- 抽取：工具侧自动写会话记忆（`order_lookup` 已写；`ticket_similar`/`advice_card` 补写），用户显式更正走 `memory_remember`；`memory/extract.md` 写白名单与冲突规则。
- 验收：两轮对话第二轮不再问订单号；换租户旧记忆不生效；更正后 history 有记录；注入文本含 `会话记忆.lastOrderId` 之类。

### M4 技能 A/B + `skill_write`

- 技能 A `.dsh/skills/delay-small-standard/SKILL.md`：`whenToUse` 收窄到“交期延迟且金额 <5 万且非黑名单”的自动流程；护栏显式写“≥5 万或黑名单 → 只取证，不自动给建议，升级主管”；反例写“3‰ 不能硬编码（CL-45 是 1‰）”“不得引用未检索到的条款”。解决题面 `whenToUse`/示例冲突。
- `skill_write` 工具：校验 `name` kebab-case、frontmatter 必填（name/description/whenToUse）、正文必须含“护栏/反例”段落、路径限定 `.dsh/skills/<name>/SKILL.md`、写入后审计；校验失败 `INVALID_ARGUMENT`。只允许写技能目录（防越界写文件）。
- 技能 B `.dsh/skills/stock-replenish/SKILL.md`：由一次真实成功对话触发 `skill_write` 落盘，保存 trace。
- 验收：catalog 能列出两份技能；技能 B 下一次会话 `skill` 加载命中；护栏由 `advice_card` 强制兜底（技能文本失效也不越界）；未命中回退记录。

### M5 评测集与门禁

- `eval/golden_set.jsonl` 12 条：5 正常（0042/0129/0055/0066/0114）、3 边界（0099 qty=0、0.4/3.2 进位、0055 恰好 5 万）、2 对抗（合同文本夹带指令、跨租户取数）、2 记忆/技能（M-01 两轮、S-01 技能命中）。每条含 `expect.toolSequence/values/mustContain/mustNotContain/provenanceRefs/noRepeatQuestion/skillHit`。
- 专项集：记忆 5 对、越权矩阵（T-001↔T-002/T-003 × order/supplier/sku）、技能命中 2 条、A/B 8 条。
- `eval/run.sh`：headless 逐条跑（`--json`，多轮用 `--session-id`，记忆/审计路径按 case 隔离），输出 `runs/eval/<id>.jsonl`。
- `eval/collect.mjs`：解析 `tool_call/tool_result/status.step_end.usage/final`；逐条断言；算六指标；`--gate` 不达标退出码非 0；生成 `eval/report.md`。
- 验收：12/12 通过；引用可溯 100%；门禁 FAIL 时会非 0。

### M6 A/B 提效

- 8 条 T-001 同类延迟工单（data-audit §12.2：`0114/0121/0108/0118/0170/0153/0109/0116`）。
- A 组：临时移走 `.dsh/skills`（`/tmp`）；B 组放回。同模型、同数据、同 prompt、内存/审计隔离；正式跑前 1 条 warm-up 丢弃；每条 1 次，时间允许 3 次取中位。
- 主指标：`tool_call` 事件数（native executor，避免 PTC 塌缩）；辅助：`step_end.usage` token（缺省容错）、墙钟、结论五元组一致率（action/关键金额/条款号/approvalPath/newDate 逐位）。
- 门禁：`Δsteps ≥30%` 或 `Δtokens ≥30%`，且 B 一致率 ≥ A；输出 `eval/ab_report.md`。

### M7 traces

`traces/{qa,memory,skill-write,skill-hit}/`：代表性 headless `--json` 事件流 + `README.md` 说明“哪条命令、验证了什么、关键事件行”。按 §9 要求第二天可导出。

### M8 文档与打包

`design.md`（架构/取舍/口径/风险）、`README.md`（三段演示命令 + 工具名映射 + 改名提醒）、`ARCHITECTURE.md`、`CHANGELOG.md`（CR#1 影响面与回归 + 口径冲突决策）、`defense/defense.md`（陈述提纲/追问清单/现场改码预案）。最终打包 `Candidate-PEC-2026-11-08.zip`（排除 `.env`/`node_modules`/`.dsh-home`），README 提醒改名。

### M9 失败归因 + CR#1 + 干净环境

- 失败归因 1 例：候选为「模型引用未检索到的条款号」或「金额二次 rescale」；记录修复前后对照。**（2026-11-08 已落地：真实失败为「模型越界尝试 bash/引导用户绕过工具面」，修复 = `policy/tool-boundary.ts` 能力边界 + `toolsNotAny`/g-15；见 `eval/failure-case.md`。）**
- CR#1（自拟，非官方）：`order_lookup` 增加 `logisticsProvider` 字段 + 金额 ≥10 万需财务会签，同时影响工具/技能/记忆三层；45 分钟落地、既有评测全回归、补 ≥2 条用例、CHANGELOG 标注自拟。**（2026-11-08 已落地：物流商按物流单价三档派生 `derived_rule_CR1-v1`；R7 增 100,000.00 财务会签档；新增 g-13/g-14；实测见 CHANGELOG v1.0。）**
- 干净环境复现：`git clone`/`npm ci`/`./dev/build.sh`/`node dev/test-tools.mjs`/headless 三段命令全跑通。

## 6. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 用户逐项确认导致时间紧 | 截止风险 | 每项控制在小步（≤60–90 分钟），汇报简洁但含证据；D1 收工前至少完成工具+记忆+技能 A |
| 模型抖动导致 A/B/评测不一致 | 指标不达标 | 固定 prompt/数据/模型；结论五元组逐位；必要时 3 次中位；warm-up 丢弃 |
| `systemPrompt.section`/`inject` API 与笔记版本差异 | 记忆注入失败 | 先最小 headless 验证；失败降级为 `agent/pre-step` 注入（笔记 §3.4 备选） |
| 工具面 restrict 对未知工具名抛错 | agent 创建失败 | 新增工具一律同步 `PEC_TOOLS` 并重编译 + headless 冒烟 |
| 数据缺口（R7 ≥20 万/R10 等值/成本价） | 验收无法逐位 | 纯函数测试向量 + design/CHANGELOG 显式声明自定口径 |
| headless 无 approval（ask=deny） | 人工确认不可演示 | 建议卡 needHuman + 审计替代，答辩说明 |
| 技能 B 自动生成不可控 | 演示失败 | 限制 skill_write 校验 + 预先演练一次成功对话；保留可复现命令 |

## 7. 排期（与 todo.md 编号对应）

D1（2026-11-07）：

| 时间 | todo | 内容 |
|---|---|---|
| 09:50–10:10 | T0 | 基线验证 + plan/todo 落盘 ✅ |
| 10:10–11:00 | T1 | `ticket_similar` 实现 + 测试 + headless |
| 11:00–12:00 | T2 | `advice_card` + R7/证据校验 |
| 12:00–13:15 | T3 | 记忆工具 + 每轮注入 |
| 13:15–14:30 | T4 | 技能 A + `skill_write` + 技能 B |
| 14:30–15:30 | T5 | golden set + run/collect + report + 门禁 |
| 15:30–16:30 | T6 | 专项集 + A/B 8 条 |
| 16:30–17:15 | T7 | traces 四类 |
| 17:15–18:00 | T8 | 文档骨架 + `d1` tag |

D2（2026-11-08，截止 15:00）：

| 时间 | todo | 内容 |
|---|---|---|
| 09:00–09:45 | T9 | CR#1 落地 + 全回归 |
| 09:45–10:45 | T10 | 失败归因 + 修复对照 |
| 10:45–12:15 | T11 | 评测报告/A-B 定稿 + 门禁全绿 |
| 12:15–13:30 | T12 | defense + README/ARCHITECTURE/design 定稿 |
| 13:30–14:30 | T13 | 干净环境复现 + 打包 zip + `d2` tag |
| 14:30–15:00 | — | 最终自检、导出会话提醒 |

> 每个 todo 完成即停下按 §0.1 汇报并等用户确认；用户回复“继续”才做下一项。时间表按用户确认节奏顺延，但不改变依赖顺序。

## 8. 验证与工作约定

- 每块完成必跑：`./dev/build.sh && node dev/test-tools.mjs`；涉及 Agent 行为时再跑 headless 并保留 `runs/` 证据（`runs/` 已 gitignore）。
- 每次提交前：`memory/store.json` 复位为空 seed（运行会写会话记忆）；不提交 `.env`/`node_modules`/`.dsh-home`/`runs`。
- commit 粒度 = 一个 todo 一项，commit message 带 `todo T<n>`；D1/D2 收工打 tag。
- 关键节点保留可复制命令与关键输出（本会话是第一天记录，用户会导出）。
