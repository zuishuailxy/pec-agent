# 设计说明 · PEC 采购异常处置 Agent（design.md）

> 定位：交付物之一（任务书 §8.1）。记录**架构、模块设计、关键取舍、数据口径与假设、风险与扩展点**。
> 配套文档：`plan.md`（逐模块 spec 与排期）、`todo.md`（实施清单）、`CHANGELOG.md`（行为变化与回归证据）。
> 实现基线：DSH 0.2.1-rc.2 + headless profile + `deepseek-flash`（`provider: deepseek-official`）；数据 `db/pec.db`（120 订单 / 32 供应商 / 86 SKU / 46 条款 / 28 工单 / 8 用户）。

---

## 1. 目标、范围与约束

### 1.1 目标

把「查得慢、记不住、不复用、说不清、不敢放手」五个业务问题，落成 Agent 可用的四层能力：

1. **工具**：6 个业务工具走 `defineTool`，只读、参数可校验、结果带 provenance；
2. **记忆**：会话记忆 + 用户记忆两层，白名单抽取、隔离、TTL、冲突留痕、每轮注入 3–5 条；
3. **技能**：手写技能 A + Agent 从成功对话沉淀技能 B，可命中、有护栏、未命中可回退；
4. **评测**：12 条 golden set + 专项集 + A/B 8 条 + 门禁，量化六项指标。

### 1.2 明确不做

- 不改 DSH 内核、不改预装 profile 原件、不改 `实例数据包/`；不新增运行时依赖（无 decimal.js）；
- 不做真实写操作（只出建议卡/待办，不写订单）；不做 ERP/WMS；不写前端，展示交给工具的 `render()`；
- 不接模型/网关；不替换默认模型。

### 1.3 关键约束（来自实测，影响所有设计）

| 约束 | 事实 | 设计后果 |
|---|---|---|
| `output.schema` 必须显式 `additionalProperties` | 0.2.1 插件导入硬要求 | 所有工具 schema 写成 `{type:'object', additionalProperties:true}` |
| 插件入口 `inject` 必须声明 | 否则 cordis 4 报 `cannot get property tools without inject` | `index.ts` 里 `export const inject = ['tools']`（后续记忆注入用 optional 方式补 `systemPrompt`） |
| guard 真实签名 `(exec) => string \| undefined` | 题面示例 `(call, next)=>…` 在 0.2.1 会抛错 | `policy/guard.ts` 用单参同步 guard，返回字符串即拒绝 |
| 工具名只允许 `^[a-zA-Z0-9_-]+$` | 真实 DeepSeek Messages API 对带点工具名返回 400 | 全部下划线：`order_lookup` 等，技能/提示/断言全用实现名 |
| 模型只看得见 `render()` | `value`/`output.schema` 不上 wire | provenance、统计、口径说明必须写进 render 文本 |
| 无 tenantId/userId/role 服务 | 平台没有身份服务 | 用进程可信输入 `PEC_USER_ID` + `users` 表解析身份 |
| headless 无人值守 `ask` = deny | approval seam 降级 fail-closed | 人工确认落到建议卡 `needHuman` + 审计，不依赖 `ask` |
| 本机 `workspace-write` bash 沙箱不可用 | 平台限制 | PEC agent 工具面收紧到业务工具 + `skill`，不依赖 shell |

---

## 2. 总体架构

### 2.1 分层

```
DSH 平台（只读，不改）
  ├─ Session / Agent loop / headless --json / systemPrompt.section / 技能 catalog
  └─ tools runtime：defineTool 校验、guard（同步单调）、render（模型唯一可见）
        ▲
        │ 插件层 @pec/pec-tools（可改业务代码）
        ├─ policy/  identity · audit · guard · masking · tool-surface
        ├─ core/    money（BigInt 定点） · provenance（[来源: table#rowId]）
        ├─ tools/   catalog + 6 业务工具 + advice_card
        └─ memory/  store（两层记忆） + inject（每轮注入）
        ▲
        │ 会话/交付层
        ├─ .dsh/skills/   SKILL.md（A 手写 / B 沉淀）
        ├─ eval/          golden_set.jsonl · run.sh · collect.mjs · report.md · ab_report.md
        ├─ traces/        qa / memory / skill-write / skill-hit
        └─ docs           design.md · plan.md · README.md · ARCHITECTURE.md · CHANGELOG.md · defense/
```

### 2.2 一次典型处置的数据流（题面 §2.3 五步）

```
用户问题
 ① 理解：模型解析订单号/异常类型/诉求（信息不足追问，不猜）
 ② 取证：order_lookup → supplier_profile → ticket_similar（每个结论带来源）
 ③ 计算/检索：pricing_quote / freight_calc（定点纯函数）；contract_search（只引用命中条款号）
 ④ 建议：advice_card（工具侧统一校验 R7/黑名单/证据存在性，规则不过直接拒绝或强制人工）
 ⑤ 复核：人确认/修改 → 标注集 → 技能沉淀与 A/B 素材
```

### 2.3 目录与职责

```
pec-agent/
├── plugins/pec-tools/src/          # 唯一允许改的业务代码
│   ├── index.ts                    # 注册工具 + guard + tool-surface
│   ├── tools/                      # 每工具一文件；business.ts 汇总 re-export
│   ├── policy/                     # 身份/审计/guard/脱敏/工具面
│   ├── core/                       # 定点金额、provenance
│   └── memory/                     # 两层记忆 + 注入
├── plugins/pec-tools/lib/          # esbuild 产物（profile 的 main 指向这里，必须提交）
├── .dsh/skills/                    # 技能 A / B
├── memory/store.json · extract.md  # 用户/会话记忆落盘与抽取规则
├── eval/                           # 评测集、批跑、统计、报告、门禁
├── traces/                         # 四类真实 run
└── dev/                            # build.sh / run-headless.sh / test-tools.mjs
```

---

## 3. 平台适配设计（DSH 0.2.1-rc.2）

### 3.1 defineTool 契约与输出通道

```ts
ctx.tools.register(defineTool({
  name, description,
  parameters: { … DSL … },                    // execute 前平台校验，失败返回普通错误
  output: {
    schema: { type: 'object', additionalProperties: true },  // canonical value 校验
    render: (_args, v) => [{ type: 'text', text: … }],       // 模型唯一可见通道
  },
  async execute(args, exec) { … },
}))
```

**关键结论（来自 `analysis/dsh-api-notes.md` §1.3–1.4）**：`value` 与 `content` 分两条路，`value` 只给程序化调用方，`content = render(args, value)` 才是 Session 持久化、模型每步重发的内容。因此：

- 结构化 `data` + `provenance` 放在 `value`（供评测/审计）；
- **所有要给模型/人看的来源、统计、口径说明都必须由 `render()` 拼进文本**；
- `render()` 必须是纯函数、不 await、不抛错、返回值 lossless JSON（含 BigInt/undefined 会导致 `INVALID_TOOL_OUTPUT`）；
- **`value`（canonical 返回对象）同样被平台做 lossless JSON 校验**：值为 `undefined` 的属性会让整个工具调用失败（`value is not lossless JSON`）。因此所有可选字段一律**条件写字段**，禁止 `{ x: cond ? v : undefined }`（T2 headless 暴露并已修复 `contract_search`/`freight_calc`，新增回归扫描）。

### 3.2 provenance 规范

- 类型：`{ table: 'orders'|'suppliers'|'skus'|'contracts'|'tickets'|'users', rowId: string, fields?: string[] }`；
- 渲染：`[来源: table#rowId]`（`core/provenance.ts#renderSources` 去重后拼接）；
- 规则：**无出处不下结论**（R12）。条款只引用 `contract_search` 返回的条款号；无命中必须输出“未检索到”，不得引用不存在条款；金额/天数/耗时等数值都要能指回行。

### 3.3 guard 与工具面收紧

- **guard**（`policy/guard.ts`）：`ctx.tools.guard((exec) => string | undefined)`，同步单调；拦截模型伪造 `tenantId` 参数（与身份不符 → `POLICY_DENIED` + 审计）；身份只从 `exec.agent?.session?.id` + `resolveIdentity()` 取，绝不信任 `args.role/userId`。
- **工具面收紧**（`policy/tool-surface.ts`）：监听 `agent/created`，在 `agent.ctx.tools.restrict({ allow })` 里只放 PEC 业务工具 + `skill`；bash/read/write/grep 对 PEC agent 不可见 → 满足 R14“不得绕过工具直接读表”，同时规避本机 bash 沙箱不可用问题。**新增工具必须同步 allow 列表**，否则 `restrict` 抛错导致 agent 创建失败。
- **资源级租户校验**在工具体内做（先取行 → 判断 tenant → 跨租户 `POLICY_DENIED` 并审计），因为 guard 只有参数层，不知道资源归属。

### 3.4 身份适配（平台无 tenant/user 服务）

```ts
resolveIdentity(sessionId?): { userId, tenantId, role }
// 来源优先级：PEC_USER_ID 环境变量（进程可信） → users 表解析；缺省 U-07（T-001 采购员）
```

- 身份是**进程级可信输入**，不是模型参数；评测/演示用 `PEC_USER_ID=U-02/U-08` 切换租户与角色。
- 会话键含 `tenantId`：`${tenantId}:${userId}:${sessionId}`；记忆/审计/隔离都以此为准（R13）。
- 该适配层解释：题面假设平台注入身份，但开源 DSH 没有；我们用最小可信适配替代，并在答案/文档中说明边界。

### 3.5 headless 评测通道

- `dev/run-headless.sh` 强制 `DSH_HOME=$ROOT/.dsh-home`、`cd pec-agent`，避免继承开发会话环境；
- `--json` 事件流：`session / status(step_end.usage) / text / thinking / tool_call / tool_result / final`；
- 工具步数 = `tool_call` 行数（**native executor**，PTC 会把子调用塌缩成 1 次 `run_code`）；token = `step_end.usage` 求和（可能缺省，统计脚本容错）；
- 多轮用 `--session-id`；记忆/审计路径用 `PEC_MEMORY_PATH` / `PEC_AUDIT_PATH` / `PEC_DB_PATH` 按场景隔离。

---

## 4. 工具设计

### 4.1 工具清单

| # | 实现名（题面名） | 读/算 | 关键设计 | 状态 |
|---|---|---|---|---|
| 0 | `pec_data_catalog` | 读 | 列出 6 张表行数，用于“数据能查”自检 | ✅ 已实现 |
| 1 | `order_lookup`（order.lookup） | 读 | 订单/交期/状态/库存；租户校验；单订单写会话记忆 | ✅ |
| 2 | `supplier_profile`（supplier.profile） | 读 | 等级/黑名单/近 12 月延迟/自定风险分；联系人按角色脱敏 | ✅ |
| 3 | `pricing_quote`（pricing.quote） | 纯函数 | 阶梯价（按总量落唯一区间，不拆单）+ 金额/税额定点 | ✅ |
| 4 | `freight_calc`（freight.calc） | 纯函数 | 体积向上取整（3.2→4、0.4→1）、总运费、计件；qty=0→`E_DIV_ZERO` | ✅ |
| 5 | `contract_search`（contract.search） | 读 | FTS5 trigram + 同义词 + LIKE 回退；无命中明确“未检索到”；合同原文按角色 | ✅ |
| 6 | `ticket_similar`（ticket.similar） | 读 | 异常类型+供应商+金额区间召回；规则相似度；按订单去重；provenance | ✅ D1 |
| 7 | `advice_card` | 校验 | 建议卡：R7 审批、黑名单、evidence 存在性、newDate 确定性重算 | ✅ D1 |
| 8 | `memory_recall/remember/forget` | 读写 | 两层记忆白名单、TTL、冲突 history、撤销、来源留痕 | ✅ D1 |
| 9 | `skill_write` | 写 | 技能落盘：frontmatter/护栏/反例校验 + 目录白名单 + 审计 | ✅ D1 |

### 4.2 错误语义

题面要求四种码：`NOT_FOUND / INVALID_ARGUMENT / POLICY_DENIED / UPSTREAM_TIMEOUT`。实现额外把 R3/R6 的除零作为 **`INVALID_ARGUMENT` 的 `reason: 'E_DIV_ZERO'`**（message 里保留 `E_DIV_ZERO:` 前缀），既满足四码，又满足“数量为 0 返回 E_DIV_ZERO、不得返回 0”。

| 场景 | 码 | 说明 |
|---|---|---|
| 资源不存在（且属当前租户查不到） | `NOT_FOUND` | 订单号/SKU/供应商不存在 |
| 参数非法（区间倒挂、qty=0、未知枚举、金额造假、证据不存在） | `INVALID_ARGUMENT` | 除零带 `reason:E_DIV_ZERO` |
| 跨租户（参数伪造或资源归属不符） | `POLICY_DENIED` | **先审计再抛**；不是 NOT_FOUND（R11 与“数据不存在”可区分） |
| 上游超时 | `UPSTREAM_TIMEOUT` | 预留（本层无外部上游） |

### 4.3 金额与日期（R1–R4、R6）

- `core/money.ts`：`Fixed = bigint`（真实值 × 10^4），HALF_UP 舍入；`toFixed/mulFixed/divFixed/ceilInt/fixedToString/formatMoney/dayDiff`；
- **中间值不二次 rescale**：踩过 `57,600 → 576`（把已是 4 位定点的值再当“元”缩放）；对外输出统一 `fixedToString(v)` 两位字符串（`"57600.00"`），便于逐位断言；
- 禁止 JS number 累加金额；库值 `REAL` 先转 `String()` 再进 `toFixed`；
- 日期差按 UTC 零点（`dayDiff`），避免本地时区偏移；
- 锚点（真实数据逐位）：0042 金额 57,600.00 / 计费体积 4 / 运费 340.00 / 计件 0.57 / 延迟 13 天；0055 恰好 50,000.00；0066 0.40→1 / 85.00；0099 qty=0 → `E_DIV_ZERO`、`unit_freight=NULL`；CL-07 日 172.80、13 天 2,246.40（上限 2,880.00 未触顶）。

### 4.4 `ticket_similar` 设计（重点）

> 数据事实：`tickets` 没有 `supplier_id`、没有金额、没有相似度字段；28 条中 16 条集中在 `PO-20260917-0129`。

- **召回**：`tickets join orders join suppliers`，硬过滤 `tickets.tenant_id = 当前租户` + `exception_type`；`supplierId` / `amountMin` / `amountMax` 作为**召回维度**；`orderId` 可派生供应商（供应商来自 DB，模型少填一个易错参数）。
- **相似度（规则分，可解释、可复现）**：
  - 维度权重：异常类型 40（必选维度）/ 供应商 30 / 金额区间 30；
  - `similarity = round(命中权重 / 已提供维度总权重 × 100)`；
  - 供应商：命中 30，不命中 0；
  - 金额：区间内 30；区间外 `p = max(0, 1 − 距离/参考跨度)`，得分 `30p`（“金额邻近”，而非硬过滤，避免丢掉金额邻近但差一点的历史单）；
  - 严格命中（所有已提供维度都满分）= 100；否则标 `relaxedOn` 并降序排在其后；
  - 排序：相似度↓ → 金额距离↑ → `ticketId`↑（完全确定性，便于逐条断言）。
- **去重**：按 `order_id` 聚合出代表工单（排序后的第一条），保留 `sameOrderTickets` / 动作分布 / 同订单改判数；同时返回去重前 `totalTickets`，避免单订单淹没，又不隐藏事实。
- **统计**：`avgMinutes`、`overriddenTickets/Rate`、`actionCounts`、`supplierCount` 按去重前工单计算（更接近“历史上这类异常平均耗时”）。
- **安全**：跨租户 supplier/order → `POLICY_DENIED` + 审计；候选只取本租户。
- **记忆**：命中时写 `lastTicketId/lastExceptionType/lastSupplierId`，供下一轮注入。
- **render**：召回规模（去重前/后、严格/放宽）、逐条历史处置与相似度、放宽维度、历史统计，并明确“历史参考，不是当前结论，引用数值必须带来源”。

**示例（DELAY + SUP-1050 + amountMax=10000，真实输出）**：总权重 100；EX-2065（5,239.50，区间内，供应商命中）=100；EX-2070（6,732.00）=100；EX-2063（SUP-1049，8,400.00，供应商未命中、金额内）=70；EX-2071（SUP-1050，48,000.00，供应商命中、金额距离 38,000/10,000 → p=0）=70；其余按距离与 id 排序，见 `runs/t1-ticket-similar.jsonl`。

### 4.5 `advice_card` 设计（D1 已实现）

- 只产出建议卡，不执行写操作（题面 §1.4）；
- **工具侧统一校验**（模型不能绕过）：
  - `orderId` 必须存在且属当前租户（跨租户 `POLICY_DENIED`+审计）；
  - 金额以 `qty × unit_price`（Fixed，HALF_UP 2 位）为**权威值**；传入 `amount` 不一致 → `INVALID_ARGUMENT`；
  - `evidence[]` 每条 ref 必须真实存在（orders/suppliers/skus/contracts/tickets），否则 `INVALID_ARGUMENT(E_EVIDENCE_NOT_FOUND)`；条款 ref 必须来自 `contract_search` 可检索到的事实；
  - **R7**：`amount < 50000.00` → 自动；`50000 ≤ amount < 200000` → 采购主管；`amount ≥ 200000` → 总监+财务；黑名单供应商 → 一律人工并强制 `needHuman=true`。输出 `ruleHits[]`。
  - **`newDate` 确定性重算**：`reschedule` 时忽略模型传值，统一取 `delivered_at + 14 天`（题面 §6.1 样例技能口径；0042 → 2026-11-16）；`delivered_at` 为 NULL 时回退 `promised_at + 14` 并标 `newDateSource`。**口径冲突记录**：历史工单 `EX-2061` 与题面 §5.3 示例写 2026-10-28（=承诺交期+8），与本口径不一致；按用户决定以题面样例技能口径为准，CHANGELOG 记录偏差。
- `render()`：动作/参数/金额/审批路径/风险/置信度/是否人工/证据来源。

### 4.6 `supplier_profile` 风险分（R9 自定口径）

数据无 `risk_score` 字段（data-audit §8），实现自定公式并在工具 render 与文档中声明：

```
score = 100                                     if blacklisted
      = min(100, 70 + min(30, delay − 10))      if delay > 10
      = min(69, 20 + 4×delay + level_pts)       otherwise（A0/B5/C10/D15）
```

逐位算例：SUP-1042（delay 13, B）=73；SUP-1007（黑名单）=100；SUP-1045（delay 6, B）=49；SUP-1044（delay 22, A）=82。**不声称是题面给定公式**。

### 4.7 `contract_search` 检索设计（R5/R12 相关）

- 数据事实：FTS5 trigram 只支持 ≥3 字；业务词与合同用词经常对不上（「运费」vs「运输费用」）；
- 方案：显式同义词表（违约/赔付→违约金；运费/运输费→运输费用；质保→质保期；付款/账期→支付货款；延迟→延迟交货；MOQ→最小起订量）+ 短词 LIKE 回退；
- 公司无合同（如 `SUP-1047`）→ `found:false` + `noHitReason:'NO_CLAUSE_MATCH'`，render 明确“不得引用任何条款号”；
- 原文按角色：buyer/manager/auditor 不可见原文、risk 脱敏、finance/admin 可见；结构化摘要（费率/上限/期限）由原文确定性抽取，不属于原文。

---

## 5. 权限与脱敏设计

角色矩阵按题面表 2-2 实现（`policy/masking.ts`），并记录两处口径冲突的取舍：

| 资源 | admin | buyer | manager | finance | risk | auditor |
|---|---|---|---|---|---|---|
| 采购订单 | ● | ● | ● | ◐ | ◐ | ○ |
| 成本价 | ● | ◐ | ● | ● | ◐ | ○ |
| 供应商联系人 | ● | ◐ | ◐ | ● | ● | ○ |
| 合同原文 | ● | × | × | ● | ◐ | × |
| 审计记录 | ● | × | × | × | × | ● |

- **脱敏是返回掩码不是空值**：手机号 `138****6621`、姓名 `张*`；脱敏/拒绝都写 `runs/audit.jsonl`（`field-masked` / `field-denied`）。
- **成本价**：数据无 `cost_price` 字段 → 策略位保留但不伪造数据；字段级越权实际落在 contacts 掩码与跨租户两类，文档显式声明。
- **跨租户**：一律 `POLICY_DENIED` + `writeAudit`（`cross-tenant-order/supplier` 等），不返回 404；guard 拦参数层伪造、工具拦资源归属。
- 越权矩阵（T-001/T-002/T-003 × order/supplier/sku）作为专项评测集（计划 T6），目标拦截率 100%。

---

## 6. 记忆设计

### 6.1 分层

| 维度 | 会话记忆 | 用户记忆 |
|---|---|---|
| 归属 | 一次会话（一个工单） | 一个用户，跨会话 |
| 白名单字段 | ≤8：`lastOrderId/lastSupplierId/lastSkuId/lastExceptionType/lastTicketId/lastClauseNo/currentAction/note` | ≤5：`focusCategories/commonSuppliers/preferAction/lastOpenTicket/note` |
| 生命周期 | 7 天 | 默认 90 天，可撤销（`memory_forget`） |
| 隔离键 | `${tenantId}:${userId}:${sessionId}` | `${tenantId}:${userId}` |
| 冲突 | 用户显式更正优先 | 覆盖写 history（最近 10 条，含 previous/next/source/at） |

- 存储：`memory/store.json`（`PEC_MEMORY_PATH` 可替换，评测隔离）；写入即原子落盘 + 审计（`memory.*`）。
- 可变事实（金额/数量）不进入画像白名单，避免过期值被当当前值。
- 抽取：工具侧自动写会话记忆（`order_lookup` 写订单/供应商/SKU；`ticket_similar` 写工单/类型；`advice_card` 写动作），用户更正走 `memory_remember({source:'user_correction'})`；`memory/extract.md` 写规则与示例。

### 6.2 注入（D1 已实现并验证）

- 每 step 通过 `ctx.systemPrompt.section({ name:'pec:memory', order:10050, interpolate:false, text:(ctx)=>… })` 求值（0.2.1 的 `text` 支持函数，等于“每轮执行一次”钩子）；
- 只注入与当前任务相关的 3–5 条（优先当前订单/供应商/品类 + 用户偏好），不整包塞回上下文，避免 token 失控；
- 硬约束：`text()` 同步、不得抛错、不得返回 `undefined`（返回 `''` 表示本段不出现）、`interpolate:false`；
- `systemPrompt` 用可选依赖方式挂载（`ctx.get('systemPrompt')`），缺失时降级不阻断 agent 创建。
- 命中率口径（评测）：第 2 轮起不重复提问的对话比例 ≥80%，专项集 5 对固化。
- **已实现证据**：两轮 headless 中审计出现 `memory.injected count:3`（`items` 含 `会话记忆.lastOrderId="PO-20261013-0042"`），第 2 轮用户只问“那违约金多少？”时模型直接 `order_lookup(0042)` → `contract_search(SUP-1042,"违约金")`，未重复询问订单号（`runs/t3-memory-*.jsonl`）。

---

## 7. 技能设计

- **技能 A（手写）`delay-small-standard`**：覆盖最常见“交期延迟 + 金额 <5 万 + 非黑名单”的标准处置；`whenToUse` 收窄；正文只写“调哪个工具、传什么参数、什么情况停手”；独立“护栏”段（≥5 万或黑名单 → 只取证不自动给建议、升级主管；无条款 → 写未检索到、不引用）；“反例”段（3‰ 不得硬编码——CL-45 是 1‰；不得引用未检索到的条款）。
  - **题面冲突处理**：题面技能 A 的 `whenToUse` 写 <5 万，但示例用 57,600 的 0042 → 本实现把 0042 作为“取证示范”，护栏显式升级，避免口径矛盾。
- **技能 B（沉淀）`stock-replenish`（D1 已生成并验证）**：由一次真实成功对话经 `skill_write` 工具落盘（frontmatter 校验 + 护栏/反例必填 + 目录白名单 + 审计），生成 trace `traces/skill-write/`；下一会话 `tool_call skill(stock-replenish)` 命中，补货量 1000、黑名单强制人工，证据 `traces/skill-hit/`。
- **护栏强度**：技能正文只是文本，无强制力（dsh-api-notes §4.6）→ 硬约束一律落到 `advice_card`/guard：金额阈值、黑名单、证据存在性由工具统一校验，技能文本失效也不越界（R14）。
- **观测**：技能复用率 = trace 中出现 `tool_call.skill` / 任务数；未命中记 `fallback`；A/B 主指标为工具调用步数（技能文本会抬高 token，不选 token 作主指标）。

---

## 8. 评测与提效设计

### 8.1 golden set（12 条，四类；D1 已实现，12/12 通过）

| 类别 | 条数 | 样本 | 通过判据 |
|---|---|---|---|
| 正常 | 5 | 0042 延迟 / 0129 缺货 / 0055 报价审批 / 0066 运费 / 0114 赔付 | 结论正确、路径正确、有引用 |
| 边界 | 3 | 0099 qty=0 / 0.40 与 3.20 进位 / 0055 恰好 50,000.00 | 数值逐位对齐（E_DIV_ZERO/85.00/340.00/主管） |
| 对抗 | 2 | 合同文本夹带指令 / 跨租户取数 | 不执行注入、不越权（POLICY_DENIED+留痕） |
| 记忆技能 | 2 | 两轮追问 / 技能命中 | 不重复提问、命中或合理回退 |

每条用例：`{id, category, user, turns[], expect:{toolsAll/toolsAny/toolsMax, toolCalls, toolErrorContains, mustContain/mustContainAny/mustNotContain, provenanceRefs, auditEvents, noCompliantCard, skillHit, memoryNoRepeat}}`；`eval/run.sh` headless 批跑（多轮自动取 sessionId，记忆/审计/技能目录按 case 隔离），`eval/collect.mjs` 解析事件流断言 + 统计 + `--gate`（不达标非 0 退出）。
**v1 结果（12/12）**：准确率 100%、引用可溯 100%（8/8 用例含全部来源）、记忆命中 100%、技能复用 100%、越权拦截 100%；提效 pending（T6）。门禁自测：改坏 g-12 skillHit → 退出码 1。

### 8.2 专项集

- 记忆 5 对（第二轮不重复提问、更正生效、跨租户不串、TTL 过期、白名单拒绝）；
- 越权矩阵（3 租户 × order/supplier/sku × 正常/伪造参数）；
- 技能命中 2 条（A 命中、B 命中/回退）；
- 六指标口径：准确率=golden 通过率；引用可溯=答案中每个数值/条款都能对上 `provenanceRefs`；记忆命中=专项比例；技能复用=命中比例；提效=A/B 步数或 token 降幅；越权拦截=矩阵拒绝率。

### 8.3 A/B 提效

- 8 条 T-001 同类延迟工单（data-audit §12.2：`0114/0121/0108/0118/0170/0153/0109/0116`，覆盖 7 家供应商/4 个金额段，其中 5 家无 penalty 条款，逼出“未检索到”分支）；
- A 组把 `.dsh/skills` 临时移走，B 组保留；同模型/同数据/同 prompt；warm-up 丢弃；每条先 1 次，时间允许 3 次取中位；
- 主指标：`tool_call` 事件数（native executor）；辅助：token（`step_end.usage` 求和，缺省容错）、墙钟、结论五元组（action/金额/条款号/approvalPath/newDate）逐位一致率；
- 门禁：`Δsteps ≥30%` 或 `Δtokens ≥30%`，且 B 一致率 ≥ A；`eval/ab_report.md` 出对照表。

---

## 9. 数据口径与假设（交付前逐条对照）

| # | 口径/缺口 | 处理 |
|---|---|---|
| 1 | R8 汇率：无币种/汇率/日期字段 | **不可实现**；`IMP-` 金额按本币计，建议卡标“未锁汇，需财务复核”，不用硬编码汇率伪造 |
| 2 | R11 成本价：无 `cost_price` | 策略位保留、不伪造；字段级越权落 contacts 掩码 + 跨租户 |
| 3 | R9 风险分：无 `risk_score` | 自定公式（见 §4.6）并显式声明 |
| 4 | R10 等值边界 0 样本 | 纯函数/夹具断言，不改原库 |
| 5 | R7 ≥20 万 0 样本 | 纯函数断言 200,000.00 / 199,999.99；50,000.00 走主管 |
| 6 | R5 MOQ 合同优先无法唯一落地 | 以 `skus.moq` 为准；合同 MOQ 仅提示，冲突取更严（大）并提示人工 |
| 7 | `tickets` 无 supplier/金额/相似度 | join orders 派生；相似度规则分（§4.4） |
| 8 | 16/28 工单集中在 0129 | 按订单聚合展示 + 保留去重前计数（§4.4） |
| 9 | `SUP-1047` 无合同、5/8 A/B 无 penalty | “未检索到”分支 + 技能护栏禁止编造条款 |
| 10 | 建议卡 `newDate` 冲突 | **取题面样例技能口径：实际交期+14 天**（0042→2026-11-16；`delivered_at` 为空回退承诺+14）。量化依据见下方「newDate 决策量化」：显式改期日历史仅 1/28 条，且改用 +8 会让 24/38 延迟单的改期日早于实际交付 |
| 11 | README 80 单实际 79；`delivered_at` 空仅 0099 | 以 79 为准；NULL 容忍只用 0099 |
| 12 | OPEN/SHIPPED 0 样本 | 文档声明状态分支仅覆盖 CLOSED/DELAYED/DRAFT |
| 13 | 工具名带点 → API 400 | 全部下划线（映射见 §13） |
| 14 | 税率无字段 | `PEC_VAT_RATE` 默认 0.13，标注 `assumption:` |
| 15 | headless `ask`=deny | 人工确认 = 建议卡 `needHuman` + 审计 |


### newDate 决策量化（2026-11-07 复核）

| 口径 | 与数据一致 | 与文档一致 | 语义问题 |
|---|---|---|---|
| 实际交期+14（采用） | 28 条工单中仅 `EX-2061`（1 条）outcome 含显式改期日 `2026-10-28`，与本口径不一致；其余 27 条只写“改期至下一个可用交期/触发补货/拆单”等泛化结论，无法比对 | 与题面 §6.1 样例技能“newDate=实际交期+14 天”一致；与 §5.3 示例卡 `2026-10-28` 冲突 | 改期日恒晚于实际交付（38/38） |
| 承诺交期+8（未采用） | 与 `EX-2061` 的 10-28 一致（0042：10-20+8） | 与 §5.3 示例卡一致；与 §6.1 样例技能冲突 | 24/38 条 DELAYED 订单的“承诺+8”会**早于实际交付**（改期日落在交付前，语义不成立；如 0042 的 10-28 早于 11-02） |

结论：**显式改期日数据只有 1 条**，不构成“数据太多”；而 +8 口径会与题面样例技能文本冲突，并在 63% 延迟单上产生“改期日早于实际交付”的语义问题。故按用户要求“如果太多才改 +8”的判断，**维持实际交期+14**，并在 CHANGELOG 记录该偏差。

---

## 10. 关键决策记录（ADR 摘要）

| # | 决策 | 理由 | 备选与为何不选 |
|---|---|---|---|
| D1 | 身份 = `PEC_USER_ID` + `users` 表 | 平台无身份服务；进程环境是可信输入，模型不可伪造 | 模型参数传 userId/role：等于把鉴权交给模型 |
| D2 | provenance 只写进 `render()` | 模型看不见 `value/schema`；render 是唯一可见通道 | 只放 value：模型引不到来源，可溯率无从谈起 |
| D3 | BigInt 4 位定点 | 无 decimal.js（不新增依赖）；`(85/200).toFixed(2)="0.42"` 与库值 0.43 差 1 分 | JS number / 字符串浮点：违反 R1，边界不可控 |
| D4 | FTS5 + 同义词 + LIKE 回退 | trigram 只支持 ≥3 字；业务词与合同用词不一致 | 纯 FTS：短词/“运费承担”全不命中 |
| D5 | `ticket_similar` 规则相似度 + 放宽补位 | 无相似度字段；规则分可解释可复现；放宽避免空召回 | 硬过滤：SUP-1047 类场景直接空；模型打分：不可复现 |
| D6 | 单订单去重展示 + 保留去重前计数 | 16/28 集中 0129，否则召回被淹没 | 全量返回：top5 全是 0129；全去重：丢失事实 |
| D7 | `newDate` = `delivered_at + 14 天` | **用户拍板**：题面样例技能口径优先 | 承诺交期+8（历史工单口径）：与题面技能文本冲突 |
| D8 | 人工确认落 `needHuman` + 审计 | headless 无人值守 `ask`=deny；且 no-write 原则 | 依赖平台 `ask`：评测不可用 |
| D9 | 工具名下划线 | 真实 API 只接受 `^[a-zA-Z0-9_-]+$`，带点会 400 | 保留题面点号：工具无法上线 |
| D10 | A/B 主指标=工具调用步数 | PTC 会把子调用塌缩；技能文本抬高 token，用 token 会低估提效 | token 作主指标：口径受 prompt 长度影响 |
| D11 | 风险分自定公式 | R9 无字段；黑名单=D 级可验证（3/3） | 声称题面公式：无法逐位核对，属虚假声明 |
| D12 | 工具面 `restrict` 到业务工具 + skill | R14 不得绕过工具读表；本机 bash 沙箱不可用 | 放开 bash/read：越权面不可控 |

---

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 逐项确认节奏导致时间紧 | 截止风险 | 每项小步（≤60–90 分钟）；D1 优先工具+记忆+技能 A |
| 模型抖动影响评测/A-B | 指标不稳 | 固定 prompt/数据/模型；结论五元组逐位；warm-up；3 次中位（时间允许） |
| `systemPrompt.section` 版本差异 | 记忆注入失败 | 先最小 headless 验证；降级 `agent/pre-step` 注入 |
| restrict 对未知工具名抛错 | agent 创建失败 | 新增工具同步 `PEC_TOOLS` + 重编译 + headless 冒烟 |
| 数据缺口无法逐位 | 验收争议 | 纯函数测试向量 + design/CHANGELOG 显式声明自定口径 |
| 工具 value 含 `undefined` → 平台 lossless JSON 校验失败 | 工具整体不可用 | 可选字段条件写 + 冒烟测试递归扫描 `undefined`（T2 已修复 `contract_search`/`freight_calc`） |
| 技能 B 自动生成不可控 | 演示失败 | `skill_write` 严格校验 + 预演一次成功对话 + 保留可复现命令 |
| 16/28 工单集中单订单 | 技能命中/A-B 样本偏斜 | A/B 用 data-audit §12.2 的 8 条；黑名单单只做“护栏命中” |

---

## 12. 扩展点与 CR#1

- **扩展点**：工具注册集中在 `index.ts` + `business.ts`；策略集中在 `policy/*`；新增工具 = 一个文件 + 注册 + `tool-surface` allow + `build.sh` entry；技能 = `.dsh/skills/<name>/SKILL.md`；记忆字段 = `memory/store.ts` 白名单常量。CR#1 只应改“工具注册/策略配置/技能文本/记忆字段”，不改执行链路。
- **自拟 CR#1（计划 T9，非官方）**：`order_lookup` 增加物流商字段 + 金额 ≥10 万需财务会签 → 同时影响工具（字段/参数）、技能（护栏阈值）、记忆（画像/待办），45 分钟落地、既有 12 条全回归、新增 ≥2 条用例、CHANGELOG 标注“自拟 CR”。
- 失败归因 1 例（计划 T10）：候选“模型引用未检索到的条款号”或“金额二次 rescale”，记录修复前后对照。

---

## 13. 复现方式

```bash
cd pec-agent
./dev/build.sh && node dev/test-tools.mjs        # 工具级冒烟（不需要模型）
./dev/run-headless.sh --json "调用 order_lookup 查询订单 PO-20261013-0042 的承诺交期、实际交期、延迟天数和状态；最后一行写数据来源"
./dev/run-headless.sh --json "调用 ticket_similar 查询异常类型 DELAY、供应商 SUP-1050、金额上限 10000 的历史工单"
# 多轮记忆：第 1 轮不带 --session-id，从 session 事件取 sessionId；第 2 轮传入
./dev/run-headless.sh --json "记录一下：当前处理订单 PO-20261013-0042（供应商 SUP-1042，交期延迟），请写入会话记忆"
./dev/run-headless.sh --session-id <第 1 轮 sessionId> --json "那违约金多少"
# 评测 + 门禁（12 条 golden set）
bash eval/run.sh && node eval/collect.mjs --gate
```

**工具名映射**：`pec.data.catalog→pec_data_catalog`、`order.lookup→order_lookup`、`supplier.profile→supplier_profile`、`pricing.quote→pricing_quote`、`freight.calc→freight_calc`、`contract.search→contract_search`、`ticket.similar→ticket_similar`；新增一律下划线：`advice_card/memory_recall/memory_remember/memory_forget/skill_write`。

**验收清单映射（§8.3）**：① 工具合规→§4；② 策略生效→§3.3/§5；③ 算得对→§4.3；④ 记得住→§6；⑤ 写得像→§7；⑥ 会自举→§7 技能 B；⑦ 不越界→§2.3 目录边界 + tool-surface；⑧ 量得出→§8.3；⑨ 讲得明→本文 + defense。

---

## 14. 交付状态与已知缺口

- **已完成（D1）**：基线脚手架 + 6 个业务工具（含 `ticket_similar` 历史召回）+ `advice_card` 建议卡 + 3 个记忆工具与每轮注入 + `skill_write`；技能 A（手写 `delay-small-standard`）与技能 B（Agent 沉淀 `stock-replenish`）均命中验证；guard/审计/脱敏/工具面；定点金额与 provenance；**golden set 12 条 + 批跑/统计/门禁（12/12，五指标达标，提效待 T6）**；`plan.md/todo.md/design.md/CHANGELOG.md/memory/extract.md/eval/traces/`；工具冒烟 **113 passed**；headless 端到端：订单查询、历史召回、建议卡、两轮记忆、技能沉淀与命中。
- **计划中**：专项集/A-B（T6）、traces 补齐 qa/memory（T7）、文档定稿/`d1`（T8）、CR#1（T9）、失败归因（T10）、复现打包（T13）。
- **已知缺口（题面/数据造成，已声明）**：R8 汇率不可实现；R11 成本价字段不存在；R9 风险分自定；R10 等值边界 0 样本；R7 ≥20 万 0 样本；状态机仅 3/5 状态有样本。
