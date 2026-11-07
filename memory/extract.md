# 记忆抽取与注入说明（memory/extract.md）

> 对应题面任务二（§5.1–5.3）与 R13。实现：[`store.ts`](../plugins/pec-tools/src/memory/store.ts)、[`inject.ts`](../plugins/pec-tools/src/memory/inject.ts)、[`memory-tools.ts`](../plugins/pec-tools/src/tools/memory-tools.ts)。
> 存储文件：`memory/store.json`（可被 `PEC_MEMORY_PATH` 覆盖，评测/演示按场景隔离；已 gitignore 运行产物）。

## 1. 两层记忆与白名单

| 维度 | 会话记忆 Session | 用户记忆 User |
|---|---|---|
| 归属 | 一次会话（一个工单） | 一个用户，跨会话 |
| 键 | `${tenantId}:${userId}:${sessionId}` | `${tenantId}:${userId}` |
| 字段上限 | 8 | 5 |
| 生命周期 | 7 天 | 90 天（可撤销） |
| 白名单字段 | `lastOrderId` / `lastSupplierId` / `lastSkuId` / `lastExceptionType` / `lastTicketId` / `lastClauseNo` / `currentAction` / `note` | `focusCategories` / `commonSuppliers` / `preferAction` / `lastOpenTicket` / `note` |
| 更新语义 | 覆盖/合并写入 | 列表合并、动作计数累加；用户显式更正优先并留 history |

**白名单外字段一律拒绝**（`INVALID_ARGUMENT`，列出允许字段），不静默丢弃——避免模型写入金额/数量等易过期事实被当成当前值。

## 2. 抽取时机与来源

| 来源 | 触发 | 写入 | 审计 `source` |
|---|---|---|---|
| 工具自动抽取 | `order_lookup` 命中单个订单 | `lastOrderId/lastSupplierId/lastSkuId/lastExceptionType` | `tool_inference` |
| 工具自动抽取 | `ticket_similar` 召回成功 | `lastTicketId/lastExceptionType/lastSupplierId`（+ `lastOrderId` 若带 orderId） | `tool_inference` |
| 工具自动抽取 | `advice_card` 生成建议卡 | `lastOrderId/lastSupplierId/currentAction`（`note=newDate=…`） | `tool_inference` |
| 用户显式更正 | 模型/用户调用 `memory_remember({source:'user_correction'})` | 指定白名单字段 | `user_correction` |
| 用户撤销 | `memory_forget({confirm:true})` | 删除整层键 | 写 `memory.forgotten` 审计 |

**冲突规则（R13：用户显式更正优先，冲突取较新并留痕）**：

- `commonSuppliers` / `focusCategories`：数组合并去重，最多 5 项；
- `preferAction`：按动作累加计数（如 `{reschedule:2}`）；
- `note` / `lastOpenTicket` 等标量：`user_correction` 直接覆盖；`tool_inference` 不覆盖已有值；
- 每次实际变化写 `memory.user.updated` 审计，并在 `history` 保留 `previous → next`（最近 10 条），`memory_recall` 返回最近 5 条留痕。

## 3. 注入规则（每轮 3–5 条）

- 平台机制：`ctx.systemPrompt.section({ name:'pec:memory', order:10050, interpolate:false, text:(context)=>… })`；0.2.1-rc.2 的 `assemble()` 每个 proposed step 前调用一次，因此 `text(context)` 就是“每轮求值”的钩子（已核实 `dsh-system-prompt/lib/index.js`）。
- 挑选顺序（不整包塞回上下文）：
  1. 会话记忆字段（最多 4 条，按白名单顺序）；
  2. 用户常用供应商 / 关注品类（与 taskHint 匹配优先，最多 5 条总量）；
  3. 用户历史处置动作偏好、上次工单。
- 文本格式：`<pec_memory>…</pec_memory>`，逐条 `1. 会话记忆.lastOrderId="PO-…"`，最多 5 条；空记忆返回 `''`（该段不出现）。
- 安全与降级：`text()` 同步、全 `try/catch`、永不抛错；`interpolate:false` 防止记忆里的 `{{…}}` 被当变量解析；`systemPrompt` 服务用 `ctx.get('systemPrompt')` **可选获取**，缺失时写 `memory.inject.unavailable` 审计并降级，不阻断 agent 创建。
- 可观测：每个会话首次注入写一条 `memory.injected` 审计（含 `items` 列表），答辩/评测可直接指到行；`memory_recall` 也写 `memory.recalled`。

## 4. 隔离与过期

- 跨租户：键含 `tenantId`，T-001 的会话/用户记忆在 `PEC_USER_ID=U-08`（T-002）下不命中（专项测试断言 `injectedCount=0`）。
- 会话隔离：不同 `sessionId` 读不到彼此会话记忆。
- 过期：读时惰性判断 `expiresAt`，过期即不注入并写 `memory.expired` 审计；用户记忆默认 90 天，可由用户显式撤销。
- 存储原子写：`saveStore` 全量 JSON 落盘；损坏时写 `memory.corrupt` 审计并降级为空 store（不崩溃）。

## 5. 工具接口

| 工具 | 参数 | 行为 |
|---|---|---|
| `memory_recall` | `scope?`(session/user/both)、`taskHint?` | 返回两层字段、TTL、用户更正 history、3–5 条 `injected` |
| `memory_remember` | `scope`(必填)、`fields`(白名单对象，必填)、`source?` | 写入并返回最新字段/过期时间/来源；非白名单拒绝 |
| `memory_forget` | `scope`(必填)、`confirm`(必须 true) | 删除整层键并审计；不存在返回 `deleted:false` |

## 6. 验证命令与证据（D1）

```bash
cd pec-agent
./dev/build.sh && node dev/test-tools.mjs      # 98 passed（含 14 条记忆断言）

# 两轮记忆演示（第 1 轮写记忆；第 2 轮不应重复询问订单号）
PEC_AUDIT_PATH=runs/t3-memory-audit.jsonl ./dev/run-headless.sh --json "记录一下：当前处理订单 PO-20261013-0042（供应商 SUP-1042，异常类型交期延迟）。请调用 memory_remember 写入会话记忆……"
PEC_AUDIT_PATH=runs/t3-memory-audit.jsonl ./dev/run-headless.sh --session-id <第 1 轮返回的 sessionId> --json "那违约金多少？"
```

实际证据（`runs/t3-memory-turn1.jsonl` / `turn2.jsonl` / `t3-memory-audit.jsonl`）：

- 第 1 轮 `tool_call memory_remember` 写入 `lastOrderId/lastSupplierId/lastExceptionType`；
- 审计 `memory.injected`：`count:3`，`items:["会话记忆.lastOrderId=\"PO-20261013-0042\"", …]`，证明注入文本真的进了上下文；
- 第 2 轮模型**没有再问订单号**，直接 `order_lookup({orderId:"PO-20261013-0042"})` → `contract_search({supplierId:"SUP-1042", keyword:"违约金"})` → 命中 `CL-07`，并算出 2,246.40。
