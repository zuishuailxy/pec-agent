# PEC 采购异常处置 Agent · 答辩材料（defense.md）

> 对应任务书 §8.4：**第二天结束后 60 分钟 —— 陈述 20 分钟 + 追问 30 分钟 + 现场改码 10 分钟**。
> 本文件是答辩脚本与题库：陈述提纲（含时间分配）、30 条追问问答要点（可直接指到文件行号）、现场改码预案、压力问题应对、材料索引。
> 所有数字均为 2026-11-08 T11 最终重跑实测，命令可复跑：`cd pec-agent && bash eval/run.sh && node eval/collect.mjs --gate`。

---

## 0. 30 秒开场（先给结论）

> 这是一个基于 DSH 0.2.1 的采购异常处置 Agent：**12 个工具 + 两层记忆 + 3 份技能 + 评测体系**。
> 六项指标全部达标：准确率 100%、引用可溯 100%、记忆命中 100%、技能复用 100%、**提效 62.1%**、越权拦截 100%。
> 关键设计一句话：**模型只能“看到”工具 render 的文本与来源，金额/审批/权限由工具侧写死，技能只放软流程、硬约束全部由工具兜底。**

---

## 1. 陈述提纲（20 分钟，5 段）

### 1.1 目标与整体设计（2 分钟）

- 题目：采购异常处置（延迟/缺货/价格/运费/风险），产出**建议卡**而非执行；六指标映射见 design.md §1。
- 分层：DSH 平台（不改内核）→ 插件 `plugins/pec-tools`（工具 + policy + 记忆）→ 会话层（skills / eval / traces）。
- 一句话架构：`defineTool（参数校验 + render + provenance）` + `guard/tool-surface（硬权限）` + `memory（两层+注入）` + `skills（软流程）` + `eval（量化）`。
- 现场打开：`design.md` §2.1 分层图 / `ARCHITECTURE.md` §2 模块边界表。

### 1.2 工具设计（5 分钟）

| 设计点 | 做法 | 证据 |
|---|---|---|
| 结构化输出只走 `render()` | `output.schema` 不上 wire；来源 `[来源: table#rowId]` 写进 render，模型唯一可见通道 | `core/provenance.ts`；任一 `runs/eval/g-*/turn1.jsonl` |
| 金额 R1 | `Fixed = bigint`（×10⁴）HALF_UP，中间值不二次 rescale；对外两位字符串 | [money.ts](../plugins/pec-tools/src/core/money.ts)；0042=57,600.00、0055=50,000.00 |
| 进位 R2/R3 | 计费体积 ceil（3.2→4、0.4→1）；qty=0 → `INVALID_ARGUMENT(reason:E_DIV_ZERO)` | `freight_calc`；g-06/g-07 |
| 审批 R7（含 CR#1） | 纯函数 `approvalFor()`：<5 万自动 / 5–10 万主管 / **10–20 万主管+财务会签** / ≥20 万总监+财务 / 黑名单一律人工；模型只能升级 `needHuman` | [advice-card.ts:26](../plugins/pec-tools/src/tools/advice-card.ts#L26)、[:52](../plugins/pec-tools/src/tools/advice-card.ts#L52) |
| 证据 R12 | `evidence` 每条 ref 必须在库中存在、条款必须属本单供应商；伪造 → `E_EVIDENCE_NOT_FOUND` / `E_EVIDENCE_MISMATCH` | `advice-card.ts` `validateEvidenceRef()`；测试用例 7 条 |
| 权限 R11 | 身份只信 `PEC_USER_ID→users`（进程可信）、参数 `tenantId` 伪造 → guard 纯函数拒绝；资源归属在工具体内校验；跨租户 `POLICY_DENIED`+审计（不是 404） | [guard.ts:23](../plugins/pec-tools/src/policy/guard.ts#L23)；`policy/{identity,audit,guard}.ts` |
| 工具面 | `restrict` 只放 12 个业务工具 + `skill`；bash/read/grep 对模型不可见；**T10 增加 system prompt 能力边界软声明** | [tool-surface.ts:15](../plugins/pec-tools/src/policy/tool-surface.ts#L15)、[tool-boundary.ts:20](../plugins/pec-tools/src/policy/tool-boundary.ts#L20) |

### 1.3 记忆设计（3 分钟）

- 两层：会话（7 天，≤8 白名单字段）/ 用户（90 天，≤5 字段）；键含 tenantId，跨租户不命中。
- 抽取：工具自动写（`order_lookup` 写订单/供应商/SKU/物流商；`ticket_similar` 写工单/类型；`advice_card` 写动作+`approval=…;financeCountersign=…`）。
- 注入：`ctx.systemPrompt.section({name:'pec:memory', order:10050, interpolate:false, text=(ctx)=>…})` —— 0.2.1 的 `text` 支持函数，**每个 proposed step 前求值一次**，只注入相关 3–5 条；空记忆返回 `''`；异常降级不抛。
- 证据：`traces/memory/` 两轮，第 2 轮不再问订单号；专项记忆 **5/5**；审计 `memory.injected count:N`。
- 现场打开：[store.ts:21](../plugins/pec-tools/src/memory/store.ts#L21) 白名单、[inject.ts:22](../plugins/pec-tools/src/memory/inject.ts#L22) 注入。

### 1.4 技能设计与自举（4 分钟）

- 技能 A `delay-small-standard`（手写）：whenToUse 收窄（<5 万且非黑名单）、3 步工具序列、护栏（≥5 万/≥10 万/黑名单升级、无条款不引用）、反例（3‰ 不得硬编码、不得用承诺+8 算改期）。
- 技能 B `stock-replenish`（**Agent 自举**）：真实成功对话里由 `skill_write` 落盘（frontmatter + 护栏 + 反例校验、目录白名单、审计 `skill.written`）；下次新会话命中。
- 护栏的真相：**技能文本只是软流程**；硬约束由工具兜底——金额/审批/证据/权限全部在 `advice_card`/guard 里写死，技能写错也不会越界（R14）。
- A/B 数字（8 条 T-001 延迟工单，A 组移走 `.dsh/skills`）：**业务工具步数 8.25 → 3.13（↓62.1%）**；token 32,387→27,179（↓16.1%）；参考得分 0.85→0.875；逐位一致率 97.5%；门禁 PASS。
- 现场打开：`.dsh/skills/*/SKILL.md`、`eval/ab_report.md`。

### 1.5 评测、CR#1 与失败归因（5 分钟）

- 评测体系：15 条 golden（正常 5 / 边界 3 / 对抗 3 / CR#1 2 / 记忆 1 / 技能 1）+ 专项集（记忆 5 对 / 越权 9 条 / 技能 2 条）+ A/B 8 条 + 门禁。
- 六指标（2026-11-08 最终重跑）：准确率 100%（15/15）、引用可溯 100%（11/11）、记忆 100%（6/6）、技能 100%（3/3）、**提效 62.1%**、越权 100%（10/10）；`node eval/collect.mjs --gate` 退出码 0；报告含 **v1/v2/v3 版本对照**。
- CR#1（**自拟，不是官方 CR**，已如实标注）：`order_lookup` 物流商派生字段 + 金额 ≥10 万财务会签；45 分钟落地、工具/技能/记忆三层、既有 12 条全回归 + 新增 g-13/g-14；CHANGELOG v1.0 记录假设（数据表无物流商字段 → 按物流单价三档派生，标 `derived_rule_CR1-v1`）。
- 失败归因（T10）：真实失败 = 模型按编码助手先验尝试 `bash` 读库/把 `sqlite3` 命令交给用户；根因 = 能力边界未声明 + 硬拦截只保安全；修复 = `tool-boundary` system prompt + `toolsNotAny`/g-15 回归断言；前后：越界尝试 1→0、步数 9→3、用户命令块 5→0。
- 现场打开：`eval/report.md` §1/§1.1/§5、`eval/failure-case.md`。

### 1.6 收尾：扩展点与弱点（1 分钟）

- 扩展点（CR#1 实战验证）：新增工具 = 一个文件 + `index.ts` 注册 + `tool-surface` allow + `build.sh` entry；策略/技能/记忆字段都在声明位置；**不改执行链路**。
- 主动承认的弱点：R8 汇率无字段（声明不支持）、R11 成本价无字段、R9 风险分自定公式、R7 ≥20 万/CR 财务会签档真实样本极少（纯函数断言）、headless 无审批（用 `needHuman`+审计表达）、A/B 每条 1 次有模型波动。

---

## 2. 追问清单（30 条，按优先级）

> 追问重点（题面明说）：**提效数字与技能护栏**；可能让你打开文件指到具体行。

### A/B 与提效（最常问，先背熟）

1. **A/B 怎么设计的？** 8 条 T-001 同类延迟工单（`data-audit §12.2`），A 组临时移走 `.dsh/skills`、B 组保留；同模型/数据/prompt；主指标=业务工具步数（剔除 `skill` 加载），辅助 token（`step_end.usage`）、墙钟、结论五元组逐位一致率。
2. **为什么步数能降 62.1%？** 技能把“通用 7–9 步取证”压缩成固定 3 步（`skill → order_lookup → contract_search → advice_card`），模型不用自己规划工具序列。
3. **token 只降 16.1% 说明什么？** 技能正文本身占 token；步数降幅是主指标（题面允许“步数或 token 任一 ≥30%”），且 B 参考得分 0.875 ≥ A 0.85，**快而且没变差**。
4. **模型抖动怎么办？** 固定模型/数据/prompt；结论用**参考五元组**（DB 金额 + R7 + 实际交期+14 + 该供应商 penalty 条款）逐位仲裁；D1 与 T11 两次独立重跑都 ≥30%（73.5% / 62.1%），方向一致，两版数字都写在报告里。
5. **A 组没有技能，为什么有时也走“skill”调用？** 模型凭名字猜过 `skill`，返回 unknown 后回退通用流程；`skill` 调用不计业务步数，A 组实际无技能可用，报告如实记录（本次 T11 A 组无此异常）。

### 技能与护栏

6. **技能护栏真的有用吗？技能被写坏会怎样？** 技能只是文本；金额/审批/证据/租户全部由 `advice_card`/guard 强制——例如 57,600 的 0042 不可能出“自动执行”卡（R7 写死，`needHuman` 只能升级）。
7. **技能怎么写、怎么保证不瞎写？** `skill_write` 校验 kebab-case、frontmatter、正文必须含「护栏/反例」、目录白名单防穿越、已存在需 overwrite、审计 `skill.written`。
8. **技能 B 真是 Agent 写的？** 是，真实成功对话触发 `skill_write` 落盘（3002 字节，审计 created=true），下一会话命中（`traces/skill-write/`、`traces/skill-hit/`）。
9. **技能命中怎么评测？** g-12 不点名技能，模型从 catalog 自主命中 `skill(name)` 即算命中；步数上限是提示项（提效由 A/B 严格考核）。
10. **技能和工具谁兜底？** 工具；题面 R14：技能执行同样过 guard，未命中回退通用流程。

### 工具与金额

11. **金额怎么保证不被模型改？** `advice_card` 以订单 `qty × unit_price` 权威复算（BigInt 4 位定点 HALF_UP），模型传 `amount` 不一致直接拒绝。
12. **二次 rescale 在哪发生的、怎么修？** D1 踩过 57,600→576（把已是 4 位定点的值再当“元”缩放）；修法：`Fixed = bigint ×10⁴`、中间值不 rescale、对外 `fixedToString`；设计记录在 design §4.3。
13. **R7 临界值怎么处理？** 50,000.00 走主管（不是自动）；100,000.00 起财务会签（CR#1，含临界）；200,000.00 总监+财务；纯函数单测覆盖 4 个边界。
14. **CR#1 改了什么？** `order_lookup` 物流商派生字段（数据无该字段，按物流单价 78/85/92 三档派生，标来源）+ R7 财务会签档 + 技能护栏 + 记忆白名单/note；扩展点内完成，回归 12 条不破 + 新增 2 条。
15. **你的 CR 不是官方 CR 吧？** 对——线下没有官方 CR#1，这是按 taskbook §3.4 自拟的等价变更，CHANGELOG v1.0 明确标注“自拟，不是官方 CR#1”，假设也写清楚了。
16. **物流商为什么是 85 档=德邦？** 数据表没有物流商字段且只读；派生规则写死可复算（`derived_rule_CR1-v1`），回答/卡片必须声明派生来源，不冒充库内事实。
17. **`ticket_similar` 相似度怎么算？** 规则分：异常类型 40 / 供应商 30 / 金额区间 30，按已提供维度归一化；金额区间外按邻近度给部分分；按订单去重（16/28 集中在 0129）。
18. **为什么工具名是下划线？** DeepSeek API 工具名只接受 `^[a-zA-Z0-9_-]+$`，点号会 400；README 有题面名→实现名映射表。

### 权限与安全

19. **跨租户为什么返回 POLICY_DENIED 而不是 404？** 数据存在但无权访问；R11 要求拒绝且留痕（审计 `deny/cross-tenant-*`），不是“查无此单”。
20. **身份从哪来？模型能伪造吗？** 平台没有 tenant/user 服务，用 `PEC_USER_ID`（进程可信）+ `users` 表解析；模型传的 `tenantId/role/userId` 一律不用于鉴权，参数伪造由 guard 拒绝。
21. **guard 是同步还是异步？签名？** DSH 0.2.1 guard 是同步单参 `(exec) => string | undefined`，返回字符串即拒绝；资源级归属在工具执行体内做。
22. **模型能绕过工具直接读表吗？** 不能：`restrict` allow 列表外工具不可见（bash/read/grep 调用返回 unknown tool）；T10 又加了 system prompt 能力边界声明，并加了 `toolsNotAny`/g-15 回归断言。
23. **审计都记了什么？** 拒绝（跨租户/参数伪造）、脱敏（联系人/合同原文）、记忆写入/注入、技能落盘、工具面收紧、能力边界安装——统一 JSONL，答辩可指到行。
24. **证据校验能防幻觉吗？** `evidence` 每条 ref 查库存在性；条款必须属本单供应商（CL-45 不能用到 SUP-1047）；不存在 → `E_EVIDENCE_NOT_FOUND`/`E_EVIDENCE_MISMATCH`。

### 记忆

25. **记忆注入为什么用 `systemPrompt.section`？** 0.2.1 的 `text` 支持函数、每个 proposed step 前求值一次，等于“每轮注入”；`interpolate:false` 防 `{{}}` 解析；异常 try/catch 永不抛。
26. **跨租户记忆怎么隔离？** 键 = `${tenantId}:${userId}:${sessionId}`，召回按键查，天生不跨租户；专项已断言（U-08 读不到 U-07 记忆）。
27. **用户更正和工具推断冲突怎么办？** 用户显式更正优先，`history` 保留 previous→next 与来源；工具推断不覆盖已有值（`store.ts` merge 规则）。
28. **为什么白名单只有 8 个字段？** 题面表 5-1 会话记忆 ≤8；CR#1 需要物流商记忆时，用 `lastLogisticsProvider` 换出从未写入的 `lastClauseNo`，不突破上限。

### 评测与弱点

29. **评测能自己作弊吗？** 门禁是脚本硬断言（工具集合/关键值/禁用内容/来源 ref/审计事件/多轮 no-repeat）；每条用例独立记忆/审计/技能目录；我们自己还做了反向篡改自测（改坏断言 → 退出码非 0）。
30. **这个系统最大的弱点是什么？** ①数据缺口类规则（R8/R11）只能声明不支持；②技能文本是软约束、依赖模型遵守，硬约束全靠工具；③headless 无人审批，人工确认只能用 `needHuman`+审计表达；④A/B 每条 1 次、模型有波动，方向稳定但绝对值会变。

---

## 3. 现场改码预案（10 分钟）

> 题面：「随机指定一处代码，加一个字段或改一处规则并跑通回归」。以下 3 个预案都已预演，改动小、回归路径清晰。

### 预案 A：给 `order_lookup` 加一个字段（最可能）

- 改：`plugins/pec-tools/src/tools/order-lookup.ts` 的 `mapOrder()` 返回对象加 `currency: 'CNY'`（或 `orderedWeekday`），render 里加一行。
- 验证：`./dev/build.sh && node dev/test-tools.mjs` → 136 passed；`./dev/run-headless.sh --json "调用 order_lookup 查询订单 PO-20261013-0042"` → 输出含新字段。
- 注意：lossless JSON 校验——不要出现 `undefined`（用条件写字段或常量）。

### 预案 B：改一处规则（审批阈值/运费进位）

- 例：把 `advice_card` 的 `R7_THRESHOLDS.manager` 从 50000 改成 40000（或给某档加财务会签）。
- 验证：`node dev/test-tools.mjs` 会重跑纯函数边界（`approvalFor` 测试向量）；若断言期望值需同步改，跑 `bash eval/run.sh` 全回归 + `node eval/collect.mjs --gate`。
- 关键：阈值是**纯函数** `approvalFor()`，改常量即可；技能文本同步一句护栏。

### 预案 C：加一个校验/错误码

- 例：`advice_card` 对 `action=switch_source` 要求 `params.supplierId` 必须与本单供应商不同，否则 `INVALID_ARGUMENT`。
- 验证：`node dev/test-tools.mjs` 加/改一条向量；headless 冒烟；回归 gate。
- 关键：错误码只用四类（`NOT_FOUND/INVALID_ARGUMENT/POLICY_DENIED/UPSTREAM_TIMEOUT`），细节放 `reason`。

### 改动流程（每步 ≤2 分钟，保证 10 分钟内跑通）

```bash
# 1) 改 TS 源码（plugins/pec-tools/src/...）
# 2) 编译 + 单测（约 5 秒，不需要模型）
./dev/build.sh && node dev/test-tools.mjs
# 3) headless 冒烟（约 20 秒，需要 .env）
./dev/run-headless.sh --json "<对应问题>"
# 4) 如影响评测口径，跑全量回归（约 6–8 分钟；时间不够则说明会跑并给出命令）
bash eval/run.sh && node eval/collect.mjs --gate
# 回滚
git checkout -- <改的文件> && ./dev/build.sh
```

> 原则：改**常量/纯函数/字段**优先，不动执行链路；每步先跑不需要模型的单测，再跑 headless。

---

## 4. 压力问题 / 陷阱应对

| 问题 | 回答要点 |
|---|---|
| “你的 CR 不是官方 CR#1” | 承认：线下没有官方 CR，这是按 taskbook §3.4 自拟的等价变更，CHANGELOG 标注“自拟、不是官方”，并列出 4 条假设 + 影响面 + 回归 |
| “A/B 是不是挑了好数字？” | 两次独立重跑（D1 73.5% / T11 62.1%）都 ≥30%，报告两版数字都保留；逐单数据 + 参考五元组仲裁可复核；A 组异常如实记录 |
| “技能不生效怎么办？” | 回退通用流程（题面允许）；命中率见 g-12 + 专项 2/2；技能文本只是软流程，硬约束在工具 |
| “模型乱编条款怎么办？” | `advice_card` evidence 校验 + `contract_search` 无命中 render 明确“不得引用”；g-09 注入抵抗留证据 |
| “记忆会不会泄露跨租户？” | 键含 tenantId；专项越权矩阵 + 记忆专项断言；审计可查 |
| “为什么不用向量检索？” | 数据是 46 条合同条款，FTS5 trigram + 同义词 + LIKE 回退足够；题目允许“关键词 + 向量召回”，我们选了可解释、可逐位断言的关键词方案，并在 design 里说明 |
| “30 分钟能改一处代码吗？” | 预演 3 个预案；改动优先常量/字段；回归分两层（单测 5 秒 / headless 20 秒 / 全量 6–8 分钟） |

---

## 5. 材料索引（可能被要求“打开某个文件指到行”）

| 主题 | 文件:行 |
|---|---|
| R7 阈值（含 CR#1） | `plugins/pec-tools/src/tools/advice-card.ts:26` / `:52` |
| 物流商派生 | `plugins/pec-tools/src/tools/order-lookup.ts:57` / `:66` |
| 记忆白名单 | `plugins/pec-tools/src/memory/store.ts:21` |
| 记忆注入 | `plugins/pec-tools/src/memory/inject.ts:22` |
| guard 参数伪造 | `plugins/pec-tools/src/policy/guard.ts:23` |
| 工具面 allow | `plugins/pec-tools/src/policy/tool-surface.ts:15` |
| 能力边界（T10） | `plugins/pec-tools/src/policy/tool-boundary.ts:20` |
| 定点金额 | `plugins/pec-tools/src/core/money.ts:38`（`toFixed`）/ `:82`（`fixedToString`） |
| 六指标 + 门禁 | `eval/collect.mjs:262`（metrics）；`eval/report.md` §1/§1.1 |
| 失败归因 | `eval/failure-case.md`；`traces/failure/README.md` |
| A/B 逐单 | `eval/ab_report.md` §2 |
| 技能 A / B | `.dsh/skills/delay-small-standard/SKILL.md` / `stock-replenish/SKILL.md` |

---

## 6. 三条演示命令（README 同步；提前跑一遍确认）

```bash
cd pec-agent
./dev/build.sh && node dev/test-tools.mjs                 # 136 passed

# ① 单轮问答（工具 + 来源 + 建议卡）
./dev/run-headless.sh --json "处理订单 PO-20261013-0042 的交期延迟：查订单与违约金条款，最后给出建议卡与审批路径"

# ② 多轮记忆（第 2 轮不再问订单号）
./dev/run-headless.sh --json "处理订单 PO-20261013-0042 的交期延迟，先查订单事实"
# 取输出里的 sessionId，然后：
./dev/run-headless.sh --session-id <sessionId> --json "那违约金多少？"

# ③ 技能命中（自主命中 delay-small-standard）
./dev/run-headless.sh --json "PO-20260906-0114 延迟，按标准流程（技能）处理，最后给出建议卡"
```

预期（关键片段）：① `delayDays 13` / `CL-07` / `57,600.00` / `采购主管` / `newDate 2026-11-16` + `[来源: orders#…]`；② 第 2 轮含 `CL-07` 与 `2,246.40`，不再问订单号；③ `tool_call skill(name=delay-small-standard)` + 业务工具 3 步。

---

## 7. 60 分钟流程备忘

| 时间 | 环节 | 你要做的 |
|---|---|---|
| 0–20 分钟 | 陈述 | 按 §1 五段讲；每段配一个现场文件/证据 |
| 20–50 分钟 | 追问 | 按 §2 优先级回答；被要求指文件用 §5 索引 |
| 50–60 分钟 | 现场改码 | 按 §3 预案；先单测后 headless，最后说明全量回归命令 |

> 现场只保证三件事：**数字对得上（可复跑）、文件指得到（§5 索引）、改码能跑通（§3 预案）**。
