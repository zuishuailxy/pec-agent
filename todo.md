# PEC 采购异常处置 Agent · TODO（按依赖排序）

> 规则：每完成一项 → 更新勾选 → 按交接文档 §0.1 的 7 段模板向用户汇报 → **等用户确认**再开始下一项。
> 每项「完成定义 + 验证命令」都必须可执行、可复核。状态标记：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成。

## T0 基线验证 + 计划落盘（D1，已完成）

- [x] 基线构建与工具冒烟：`./dev/build.sh` 成功；`node dev/test-tools.mjs` → **19 passed / 0 failed**
- [x] headless 基线：`./dev/run-headless.sh --json "调用 order_lookup 查询订单 PO-20261013-0042 …"` → exit 0、`tool_call=order_lookup`、final 含 `[来源: orders#PO-20261013-0042]`（`runs/baseline-order-lookup.jsonl`）
- [x] 材料与源码通读：taskbook / data-audit / dsh-api-notes / 现有 `src/**` / 数据表
- [x] `plan.md`：目标、架构、逐模块 spec（输入/输出/错误/验收/测试向量）、口径与假设、风险、排期
- [x] `todo.md`（本文件）：依赖排序 + 完成定义 + 验证命令

## T1 `ticket_similar` 实现（D1）

- [x] spec 已写入 `plan.md` M1
- [x] `plugins/pec-tools/src/tools/ticket-similar.ts`：真实 `execute`（类型归一化 + 租户隔离 + supplier/金额区间召回 + 规则相似度 + 按订单去重 + 统计 + provenance + render + 会话记忆）
- [x] `dev/test-tools.mjs`：替换“仍是桩”断言，新增 21 条断言（召回/去重/派生 supplier/别名/无命中/跨租户/审计留痕/非法参数/金额边界/放宽标注）
- [x] 编译 + 冒烟通过（**40 passed / 0 failed**，基线 19）；headless 端到端 `ticket_similar` 返回历史处置与来源（`runs/t1-ticket-similar.jsonl`）
- [x] `CHANGELOG.md` 记录 T1 行为变化与口径
- **完成定义**：`node dev/test-tools.mjs` 全绿（≥27 passed）；headless 工具卡含 `tickets#…`/`orders#…` 来源；跨租户 `POLICY_DENIED` 且审计有记录。
- **验证命令**：
  ```bash
  cd pec-agent && ./dev/build.sh && node dev/test-tools.mjs
  ./dev/run-headless.sh --json "调用 ticket_similar 查询异常类型 DELAY、供应商 SUP-1050、金额上限 10000 的历史工单，按相似度排序并给来源"
  ```

## T2 `advice_card` 建议卡（D1，已完成）

- [x] `plugins/pec-tools/src/tools/advice-card.ts`：金额权威复算、evidence 存在性校验、R7 审批路径（含 50,000.00 / 200,000.00 边界）、黑名单强制人工、`reschedule` newDate 确定性重算（实际交期+14）、render 卡片
- [x] `index.ts` 注册 + `policy/tool-surface.ts` allow 加 `advice_card` + `dev/build.sh` entry + `tools/business.ts` re-export
- [x] `dev/test-tools.mjs` 测试向量（+39 条）：R7 四档纯函数/临界值、0042→主管/needHuman、0055→主管（非自动）、黑名单→强制人工、伪造 evidence/条款错配/amount 造假→报错、newDate 忽略模型值、lossless JSON 扫描、注册与工具面
- [x] 基线修复：`contract_search`/`freight_calc` 返回 value 含 `undefined` → 平台 lossless JSON 校验失败（headless 首次运行时暴露），改为条件写字段 + 回归扫描
- **完成定义**：**79 passed / 0 failed**；headless 端到端建议卡（5 次工具调用，含 `CL-07` 证据、`采购主管`、`newDate 2026-11-16`），见 `runs/t2-advice-card.jsonl`。
- **验证命令**：`./dev/build.sh && node dev/test-tools.mjs`；headless 让 Agent 处理 0042 并输出建议卡。

## T3 记忆工具与每轮注入（D1，已完成）

- [x] `plugins/pec-tools/src/tools/memory-tools.ts`：`memory_recall` / `memory_remember` / `memory_forget`（白名单拒绝非白名单字段、TTL、冲突 history、confirm、审计、来源如实记录）
- [x] `plugins/pec-tools/src/memory/inject.ts`：`ctx.systemPrompt.section` 每 step 注入 3–5 条（`interpolate:false`、同步、空记忆返回 `''`、异常降级不抛）；`systemPrompt` 用 `ctx.get()` 可选挂载
- [x] 会话记忆补写（`ticket_similar` / `advice_card`）；`memory/extract.md` 写白名单与抽取/冲突/注入规则
- [x] `index.ts` / `business.ts` / `build.sh` / tool-surface 同步；`dev/test-tools.mjs` 补记忆读写/隔离/撤销/白名单/更正留痕测试
- [x] 演示脚本 `dev/demo-memory.sh`（一键两轮、自动断言、失败非 0）；报告里的省略号截断命令已改为完整可复制命令
- **完成定义**：**98 passed / 0 failed**；headless 两轮：审计 `memory.injected count:3`（含 `会话记忆.lastOrderId="PO-20261013-0042"`），第 2 轮不再问订单号，直接查 `CL-07` 并算出 2,246.40（`runs/t3-memory-*.jsonl`）；`PEC_USER_ID=U-08` 下旧记忆不生效（断言通过）。
- **验证命令**：`./dev/build.sh && node dev/test-tools.mjs`；`./dev/run-headless.sh --session-id <id> --json "处理 PO-20261013-0042 延迟"` → 同一 session 第二轮 `"那违约金多少"`。

## T4 技能 A + `skill_write` + 技能 B（D1，已完成）

- [x] `.dsh/skills/delay-small-standard/SKILL.md`：whenToUse 收窄、3 步工具序列、护栏（≥5 万/黑名单升级、无条款不引用、NOT_FOUND 追问）、反例（3‰ 硬编码/承诺+8/0042 自动执行）
- [x] `plugins/pec-tools/src/tools/skill-write.ts`：frontmatter/正文校验（护栏+反例必填）+ 目录白名单（防路径穿越）+ 覆盖保护 + 审计 `skill.written`；注册与 tool-surface 同步
- [x] 用一次真实成功对话让 Agent 生成 `.dsh/skills/stock-replenish/SKILL.md`（3002 字节，审计 created=true），保存 trace
- [x] `traces/skill-write/` + `traces/skill-hit/` 落盘（事件流 + 审计）+ `traces/README.md`
- **完成定义**：**113 passed / 0 failed**；技能 A 命中（`tool_call skill` → 3 个业务工具）；技能 B 新会话命中（`tool_call skill(stock-replenish)`）；`skill_write` 对非法名字/缺护栏/缺反例/路径穿越全部拒绝并留痕；headless 证据见 `traces/`。
- **验证命令**：`headless --json "PO-20260906-0114 延迟，按标准流程处理"`（技能 A 命中）；随后 `"PO-20260917-0129 缺货，按 stock-replenish"`（技能 B 命中）。

## T5 评测集与门禁（D1，已完成）

- [x] `eval/golden_set.jsonl` 12 条（5 正常 / 3 边界 / 2 对抗 / 1 记忆 / 1 技能），逐条 `expect`（工具集合、值、禁用内容、来源 ref、工具错误码、审计事件、多轮 no-repeat、反注入合规卡）
- [x] `eval/run.sh` → `eval/run.mjs`（headless 批跑、多轮自动取 sessionId、记忆/审计/技能目录按 case 隔离、`--only`、fixture 注入不改原件）+ `eval/collect.mjs`（断言、六指标、`--gate` 非 0）
- [x] `eval/report.md`（12/12 逐条结果 + 指标总表 + 备注）+ `eval/summary.json`
- [x] 技能 A 收紧为“严格 3 步”，g-12 业务工具步数 4→3
- **完成定义**：**12/12 通过**；`node eval/collect.mjs --gate` → 准确率 100% / 引用可溯 100%（8/8）/ 记忆命中 100% / 技能复用 100% / 越权拦截 100%，提效 pending（T6）；门禁自测：改坏 g-12 skillHit → 退出码 1，恢复 → 0。
- **验证命令**：`cd pec-agent && bash eval/run.sh && node eval/collect.mjs --gate`

## T6 专项集 + A/B 8 条（D1，已完成）

- [x] 专项集：记忆 5 对（5/5）、越权矩阵 9 条（9/9）、技能命中 2 条（2/2）——`eval/special.mjs` + `eval/special_summary.json`，已合并进六指标分母（记忆 6/6、技能 3/3、越权 10/10）
- [x] A/B：8 条 T-001 延迟工单；A 组移走 `.dsh/skills`、B 组保留；步数 12.25→3.25（↓73.5%）、token 43,311→24,363（↓43.7%）、参考得分 0.875→0.9、逐位一致率 92.5%
- [x] `eval/ab_report.md`（对照表 + 逐单结论 + 口径/异常说明）+ `eval/ab_summary.json`
- **完成定义**：**门禁 PASS**（效率 73.5% ≥30%，B 参考得分 ≥ A）；`node eval/collect.mjs --gate` 六指标全绿、退出码 0。
- **验证命令**：`node eval/special.mjs && node eval/ab.mjs && node eval/collect.mjs --gate`

## T7 traces 四类（D1，已完成）

- [x] `traces/qa/`（0042 建议卡 / CL-47 注入抵抗 / 跨租户拒绝，各含事件流 + 审计）、`traces/memory/`（两轮 + 注入审计）、`traces/skill-write/`（生成过程）、`traces/skill-hit/`（A/B 命中）
- [x] `traces/README.md`：四类命令、文件清单、关键证据、复跑前置、边界说明
- [x] `dev/demo-memory.sh` 兼容“凭记忆 0 工具作答”的合法路径
- **完成定义**：四类共 16 个证据文件（事件流/审计/说明），关键断言（57,600/CL-07/采购主管/POLICY_DENIED/memory.injected/1000）逐个 grep 校验通过；可直接被答辩引用。

## T8 文档骨架 + d1 tag（D1，已完成）

- [x] `design.md`（架构/取舍/口径/风险/ADR/验收映射）——已按用户要求提前落盘（commit `9794faa`）
- [x] `README.md`（三段演示命令 + 工具名映射 + 插件加载机制 + 打包改名提醒）、`ARCHITECTURE.md`、`plugins/pec-tools/README.md` 更新
- [x] `CHANGELOG.md` 补全 v0.1–v0.9（T1–T8 + 修复 + 口径决策）；`git tag d1`（annotated）；工作区干净
- **完成定义**：`git status` 干净、`git tag` 含 `d1`；README 三段命令可复制执行；build + 113 passed + 门禁 exit 0。

## T9 CR#1 落地 + 全回归（D2，已完成 2026-11-08）

- [x] 自拟变更：`order_lookup` 加物流商派生字段（`derived_rule_CR1-v1`：物流单价 ≥90 顺丰 / 82–89.99 德邦 / <82 安能）+ `advice_card` 金额 ≥10 万需财务会签（10–20 万 → 采购主管+财务会签）；同时影响**工具/技能/记忆三层**（明细见 `CHANGELOG.md` v1.0）
- [x] 既有 golden set 全回归 + 新增 `g-13`（物流商）/ `g-14`（财务会签）2 条用例；`CHANGELOG.md` v1.0 标注“自拟 CR，不是官方 CR#1”
- [x] 用户复跑暴露的 2 处评测稳定性问题已修复：g-09 `noCompliantCard` 假阳性（改为按工具产出判定 + 反向篡改自测）、g-01 prompt 与技能护栏二义（明确必须出卡，断言未放宽）——见 `CHANGELOG.md` v1.0.1
- **完成定义**：CR 后既有 12 条全绿 + 新用例通过 → **golden 14/14 PASS**，`node eval/collect.mjs --gate` 六指标全绿（退出码 0）；工具冒烟 **133 passed / 0 failed**。
- **验证命令**：
  ```bash
  cd pec-agent && ./dev/build.sh && node dev/test-tools.mjs
  bash eval/run.sh && node eval/collect.mjs --gate
  ```

## T10 失败归因 + 修复对照（D2，已完成 2026-11-08）

- [x] 真实失败（比候选更可复现）：模型按通用编码助手先验**越界尝试 `bash`/文件读取/`sqlite3` 绕过受控工具面**（两例：检索无命中时调 bash 被拒；被要求绕工具面时把 5 段 sqlite3/grep 命令交给用户）。硬拦截未破，但存在无效调用/步数膨胀/引导用户绕审计的合规风险
- [x] 修复：新增 `plugins/pec-tools/src/policy/tool-boundary.ts`（system prompt 固定声明工具白名单/无 bash 等工具/无命中如实回答/不得给用户绕过命令）+ `index.ts`/`build.sh` 接线；评测新增 `toolsNotAny` 断言 + golden `g-15`（修复前产物 FAIL、修复后 PASS）
- [x] 交付：`eval/failure-case.md`（现象/根因/修复/前后对照/控制组/残留风险）+ `traces/failure/{before,after,controls}/`（前后事件流 + 审计 + README）
- **完成定义**：`eval/failure-case.md` + 前后 trace ✅；修复前后：越界尝试 1→0、工具错误 1→0、步数 9→3、用户命令块 5→0；golden **15/15**、门禁 exit 0、工具冒烟 133 passed。
- **验证命令**：
  ```bash
  cd pec-agent && ./dev/build.sh && node dev/test-tools.mjs
  bash eval/run.sh && node eval/collect.mjs --gate
  bash eval/run.sh --only g-15
  ```

## T11 评测报告 + A/B 定稿（D2，已完成 2026-11-08）

- [x] 全量重跑：golden **15/15**、专项集（记忆 5/5、越权 9/9、技能 2/2）、A/B（步数 8.25→3.13 **↓62.1%**、token ↓16.1%、参考得分 0.85→0.875、逐位一致率 97.5%）
- [x] `eval/report.md` 升级为最终版：六指标总表 + **v1/v2/v3 版本对照** + 15 条逐条断言 + 专项集 + **A/B 摘要** + 备注（含 T10 失败归因指针）；`eval/ab_report.md`、`eval/special_summary.json`、`eval/summary.json` 同步重生成
- [x] 同批复跑修复 2 处评测健壮性问题：a-07 参数伪造改为"双合规路径"判定 + guard 纯函数单测（冒烟 133→136）；A/B 参考函数同步 CR#1 财务会签档
- **完成定义**：六指标全部达标 ✅（准确率 100% / 引用可溯 100% / 记忆 100% / 技能 100% / 提效 62.1% / 越权拦截 100%），报告含 v1/v2 与 A/B 对照 ✅；`node eval/collect.mjs --gate` 退出码 **0**。
- **验证命令**：
  ```bash
  cd pec-agent && node eval/special.mjs && node eval/ab.mjs
  bash eval/run.sh && node eval/collect.mjs --gate
  ```

## T12 defense + 文档定稿（D2，已完成 2026-11-08）

- [x] `defense/defense.md`：20 分钟陈述提纲（5 段）、30 条追问（A/B 数字/技能护栏/guard 路径/CR#1/失败归因，附文件行号）、现场改码 3 预案、压力问题应对、材料索引
- [x] `design.md` / `README.md` / `ARCHITECTURE.md` / `CHANGELOG.md` 定稿；新增 `dev/setup-profile.sh` 支持干净环境复现；README 演示命令①明确必须调用 `advice_card` 出卡（与 g-01 口径一致）

## T13 干净环境复现 + 打包 + d2 tag（D2，已完成 2026-11-08）

- [x] 干净目录复现（`/tmp/pec-clean`，排除 `.git/.env/.dsh-home/runs/node_modules`）：`./dev/setup-profile.sh` + `./dev/build.sh` + `node dev/test-tools.mjs` → **136 passed**；三段演示命令全通（① 0042 建议卡含 57,600.00/CL-07/采购主管/2026-11-16；② demo-memory 两轮断言全过；③ 技能命中 CL-45/5,239.50）
- [x] 打包 **`Candidate-PEC-2026-11-08.zip`**（`pec-agent/` + `AI会话记录/`；排除 `.env`/`node_modules`/`.dsh-home`/`runs`/`.git`/`.DS_Store`）
- [x] `git tag d2`（annotated）、工作区干净；提醒用户导出 D2 会话（本会话）到 `AI会话记录/D2/`
- **完成定义**：zip 解压后按 README 能跑通 ✅；tag 齐全 ✅（`d1` / `d2`）。
