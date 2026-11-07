# CHANGELOG

> 记录影响交付口径、工具行为、评测基线的变更。每条含「影响面 / 回归证据」。CR#1 见文末（自拟，非官方）。

## v0.2（D1）· 2026-11-07

### T1 `ticket_similar` 实现（替换 NOT_IMPLEMENTED 桩）

- **行为变化**：
  - 新增真实召回：`tickets join orders join suppliers`，强制 `tickets.tenant_id = 当前身份租户`，按异常类型过滤；供应商、金额区间作为召回维度参与相似度，不命中时按相似度放宽补位并在结果里标注 `relaxedOn`。
  - 相似度为**规则分**（数据无相似度字段）：异常类型 40 / 供应商 30 / 金额区间 30，按已提供维度归一化到 0–100；区间外按邻近度给部分分。排序：相似度降序 → 金额距离升序 → ticketId 升序（确定性）。
  - 单订单工单聚合：28 条工单中 16 条集中在 `PO-20260917-0129`，按 `order_id` 聚合成代表工单，保留 `sameOrderTickets` / 动作分布 / 同订单人工改判数；同时返回去重前 `totalTickets`，避免单订单淹没召回。
  - 支持 `orderId` 派生供应商（少一次工具调用，且供应商参数来自 DB 而不是模型）；`orderId` 与 `supplierId` 冲突 → `INVALID_ARGUMENT`。
  - 跨租户 `supplierId`/`orderId` → `POLICY_DENIED` 并写审计（不是 NOT_FOUND，R11）；候选查询只取当前租户。
  - 中文类型别名归一化（延迟/缺货/价格/运费/风险 → 枚举），未知类型明确报错。
  - 召回成功时写会话记忆 `lastTicketId/lastExceptionType/lastSupplierId`（供下一轮注入，R13）。
  - `render()` 输出历史处置动作/结论/耗时/改判/相似度/放宽维度/历史统计，并附 `[来源: tickets#…] [来源: orders#…] [来源: suppliers#…]`（模型唯一可见通道）。
- **影响面**：只改 `plugins/pec-tools/src/tools/ticket-similar.ts` + 冒烟测试；工具名/注册/工具面不变（`ticket_similar` 原已在 `policy/tool-surface.ts` allow 列表）；`package.json` 未动。
- **回归证据**：`node dev/test-tools.mjs` → **40 passed / 0 failed**（基线 19 passed，新增 21 条 ticket 断言）；headless 端到端见 `runs/t1-ticket-similar.jsonl`。
- **口径/假设**：
  - `tickets` 无 `supplier_id`、无金额 → 一律 join `orders` 派生，provenance 同时给 `tickets#` 与 `orders#`。
  - 相似度是启发式排序分，不是业务金额，不参与 R1 定点约束；金额输出仍走 `core/money.ts` 的 4 位定点 + 两位字符串。
  - 金额区间「含边界」：`amount == amountMin` 或 `amount == amountMax` 视为命中（与 R10「等于不触发」这类边界口径分开，按工具自身语义写死）。

## v0.1（D1）· 2026-11-06 基线（commit `e0855dd`，HEAD `9209145`）

- 环境/脚手架修复（0.2.1-rc.2）：`output.schema` 显式 `additionalProperties`；入口 `export const inject = ['tools']`；guard 真实签名 `(exec) => string | undefined`；profile patch 用 `- insert:`；工具名统一下划线（DeepSeek API 只接受 `^[a-zA-Z0-9_-]+$`）；catalog render 读 `v.data.tables`；`run-headless.sh` 强制 `DSH_HOME`；本机 `workspace-write` bash 沙箱不可用 → PEC agent 用工具面收紧规避。
- 已实现：`policy/{identity,audit,guard,masking,tool-surface}`、`core/{money,provenance}`、`memory/store`、`errors/db/index`、5/6 业务工具（catalog + order_lookup + supplier_profile + pricing_quote + freight_calc + contract_search），`ticket_similar` 保留桩。
- 证据：`node dev/test-tools.mjs` 19 passed；headless `order_lookup` 返回 13 天延迟 + provenance。
- 口径：R8 汇率不可实现（无字段，声明不支持）；R11 成本价无字段（不伪造，字段级越权落 contacts 掩码+跨租户）；R9 风险分自定公式；R5 以 `skus.moq` 为准；R7 临界 50,000.00 走主管。

## 待记录（后续 todo 逐项追加）

- T2 `advice_card`、T3 记忆工具与注入、T4 技能 A/B + `skill_write`、T5 评测/门禁、T6 专项集/A-B、T7 traces、T8 文档、T9 CR#1、T10 失败归因。
