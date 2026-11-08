# ARCHITECTURE · PEC 采购异常处置 Agent

> 本文只讲**结构与边界**；设计取舍与数据口径见 [design.md](design.md)，逐模块 spec 见 [plan.md](plan.md)，行为变化见 [CHANGELOG.md](CHANGELOG.md)。
> 运行时：DSH 0.2.1-rc.2 · headless profile · 模型 `deepseek-flash`（deepseek-official） · 数据 `db/pec.db`（只读）。

## 1. 分层视图

```
┌──────────────────────────────────────────────────────────────────────────┐
│ DSH 平台（不改内核）                                                       │
│  Session / Agent loop / headless --json / systemPrompt.section / 技能 catalog │
│  tools runtime：defineTool 参数校验、guard（同步单调）、render（模型唯一可见）  │
└───────────────────────────────▲──────────────────────────────────────────┘
                                │ 插件（profile 加载 lib/index.js，apply(ctx)）
┌───────────────────────────────┴──────────────────────────────────────────┐
│ plugins/pec-tools（唯一业务代码）                                          │
│  index.ts：注册 12 工具 + guard + tool-surface + memory injection         │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────────────┐ ┌──────────┐ │
│  │ tools/   │ │ policy/  │ │ core/                        │ │ memory/  │ │
│  │ 12 个    │ │ identity │ │ money（BigInt 4 位定点）      │ │ store    │ │
│  │ defineTool│ │ audit    │ │ provenance（[来源: table#id]） │ │ inject   │ │
│  │          │ │ guard    │ │                              │ │          │ │
│  │          │ │ masking  │ │                              │ │          │ │
│  │          │ │ surface  │ │                              │ │          │ │
│  └──────────┘ └──────────┘ └──────────────────────────────┘ └──────────┘ │
└───────────────────────────────▲──────────────────────────────────────────┘
                                │ CLI / 批跑
┌───────────────────────────────┴──────────────────────────────────────────┐
│ 会话与交付层                                                               │
│  .dsh/skills/（3 份 SKILL.md） · memory/（两层记忆落盘+规则）              │
│  eval/（golden set / 专项集 / A/B / 门禁） · traces/（四类真实事件流）      │
│  docs：README / plan / design / ARCHITECTURE / CHANGELOG                  │
└──────────────────────────────────────────────────────────────────────────┘
```

## 2. 模块边界（谁负责什么）

| 模块 | 位置 | 职责 | 不负责 |
|---|---|---|---|
| 插件入口 | `src/index.ts` | 注册工具、安装 guard/tool-surface/记忆注入；`export const inject = ['tools']` | 业务规则细节 |
| 业务工具 | `src/tools/*.ts` | 每个 `defineTool` 一个文件：入参校验、租户归属校验、render、provenance | 跨工具编排（由 Agent/技能决定） |
| 策略 | `src/policy/` | `identity`（PEC_USER_ID→users）、`audit`（JSONL）、`guard`（伪造 tenantId 拒绝）、`masking`（角色矩阵）、`tool-surface`（allow 12+skill） | 资源级归属判断（在工具内做） |
| 核心 | `src/core/` | `money`（定点/舍入/日期差）、`provenance`（来源标记与 render 拼接） | 任何 I/O |
| 记忆 | `src/memory/` | `store`（会话/用户两层、TTL、白名单、冲突 history）、`inject`（每 step 注入 3–5 条） | 业务数据查询 |
| 技能 | `.dsh/skills/` | SKILL.md 文本（触发/序列/护栏/反例）；`skill_write` 负责落盘校验 | 硬约束（由工具/guard 兜底） |
| 评测 | `eval/` | golden set、专项集、A/B、断言、六指标、门禁 | 线上服务 |
| 证据 | `traces/` | 四类真实 headless 事件流 + 审计快照 | 可替代测试（但可复跑） |

## 3. 一次典型处置的数据流（题面 §2.3）

```
用户问题（如「处理 PO-20261013-0042 的交期延迟」）
 ① 理解    模型解析订单号/异常类型；信息不足追问
 ② 取证    order_lookup（订单/交期/库存，带 [来源: orders#…]）
           supplier_profile（等级/黑名单/风险分，联系人脱敏）
           ticket_similar（历史同类工单 + 处置动作）
 ③ 计算    pricing_quote / freight_calc（纯函数定点）
            contract_search（FTS5+同义词，只引用命中的条款号；无命中写“未检索到”）
 ④ 建议    advice_card：工具权威复算金额、校验 evidence 存在性、强制 R7/黑名单（含 CR#1 ≥10 万财务会签）、确定性 newDate
 ⑤ 记忆    order_lookup/ticket_similar/advice_card 自动写会话记忆；下一 step 由 systemPrompt.section 注入
 ⑥ 复核    人确认/修改 → 标注集 → 技能沉淀（skill_write）/ A/B 素材
```

**关键契约**：模型只能看到工具 `render()` 的文本（`value/output.schema` 不上 wire）→ 所以来源标记、统计口径、护栏说明必须写进 render；`tool-surface` 让 PEC agent 只能看到 12 个业务工具 + `skill`。

## 4. 工具面与注册链

```
src/tools/<tool>.ts  ──re-export──►  src/tools/business.ts
        │                                   │
        └──────────► src/index.ts ◄─────────┘
                        │ apply(ctx)
                        ├─ ctx.tools.register(each tool)          // defineTool：参数 schema + output.schema + render + execute
                        ├─ installGuard(ctx)                       // ctx.tools.guard(exec => string | undefined)
                        ├─ installToolSurface(ctx)                 // agent/created → agent.ctx.tools.restrict({allow: PEC_TOOLS+skill})
                        └─ installMemoryInjection(ctx)             // ctx.get('systemPrompt')?.section({text: (ctx) => …})
```

**新增工具 checklist**：`src/tools/<name>.ts` → `business.ts` re-export → `index.ts` 注册 → `policy/tool-surface.ts` `PEC_TOOLS` allow 列表 → `dev/build.sh` entry → `./dev/build.sh` → `node dev/test-tools.mjs`。

## 5. 鉴权与安全边界

```
PEC_USER_ID（进程环境，可信）
   └─► users 表 → { userId, tenantId, role }        ← 模型不可伪造（不读 args.userId/role/tenantId）
          ├─ guard：模型若显式传 tenantId 且与身份不符 → POLICY_DENIED + audit（cross-tenant-argument）
          └─ 工具：先取资源行 → 判断 row.tenant_id === identity.tenantId
                   ├─ 相符 → 继续；按 role 矩阵脱敏（contacts 掩码 / 合同原文可见性）
                   └─ 不符 → writeAudit(deny, reason=cross-tenant-*) → POLICY_DENIED（不是 NOT_FOUND）
```

- 审计统一 JSONL（`PEC_AUDIT_PATH`，默认 `./runs/audit.jsonl`）：拒绝、脱敏、记忆更新/注入/撤销、技能落盘都在同一文件，答辩可指到行。
- 只读：所有工具打开 SQLite `readonly`（`PEC_DB_PATH` 可指向夹具副本，不改原件）。
- 工具面：`restrict({allow})` 在 `agent/created` 时对 PEC agent 生效，屏蔽 bash/read/write/grep。

## 6. 记忆子系统

```
工具执行 ──rememberSession/rememberUser──► memory/store.json（键含 tenantId；TTL 7/90 天；白名单；history）
                                                   │
每个 proposed step：systemPrompt.section({name:'pec:memory', text:(ctx)=>…})
   └─ resolveIdentity(sessionId) → recallMemory → 挑选 3–5 条 → <pec_memory>…</pec_memory>
       └─ 空记忆返回 ''（整段消失）；异常 try/catch 降级；每会话首次注入写 memory.injected 审计
```

- 会话记忆：`lastOrderId/lastSupplierId/lastSkuId/lastExceptionType/lastTicketId/lastLogisticsProvider/currentAction/note`（CR#1 换出 `lastClauseNo`，仍为 8 字段）。
- 用户记忆：`focusCategories/commonSuppliers/preferAction/lastOpenTicket/note`；用户显式更正优先并留 history。
- 隔离：键 = `${tenantId}:${userId}:${sessionId}` / `${tenantId}:${userId}`；跨租户不命中（专项 m-* 已断言）。

## 7. 技能子系统

```
.dsh/skills/<name>/SKILL.md ──平台 watcher 扫描──► catalog（name+description 常驻）
        │                                              │ 模型按需 tool_call skill({name}) 加载正文
        │                                              ▼
        └── skill_write（Agent 沉淀通道）：校验 name/description/whenToUse + 正文含「护栏/反例」
                → 写入 .dsh/skills/<name>/SKILL.md → 审计 skill.written
```

- 技能正文**只是文本**，硬约束必须由 `advice_card`/guard 兜底（R14）：金额阈值、黑名单、evidence 存在性都由工具强制。
- 评测/脚本调用 `skill_write` 时通过 `PEC_SKILLS_DIR` 隔离到 case 目录，**不会污染交付技能**。

## 8. 评测子系统

```
eval/golden_set.jsonl ──eval/run.mjs(串行 headless)──► runs/eval/<id>/turnN.jsonl（每 case 隔离记忆/审计/技能目录）
eval/special.mjs ────────────────────────────────────► runs/special/<group>/<id>/  + special_summary.json
eval/ab.mjs ──(临时移走 .dsh/skills)────────────────► runs/ab/{A,B}/<order>/    + ab_summary.json/ab_report.md
                                                        │
eval/collect.mjs ──断言 + 六指标 + 合并专项/AB──────────► eval/report.md / summary.json ；--gate 不达标退出码非 0
```

## 9. 运行时依赖与环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `PEC_USER_ID` | `U-07`（T-001 buyer） | 进程可信身份 → tenantId/role |
| `PEC_DB_PATH` | `./db/pec.db` | SQLite 数据（只读打开；评测夹具指向副本） |
| `PEC_MEMORY_PATH` | `./memory/store.json` | 两层记忆落盘文件（评测按 case 隔离） |
| `PEC_AUDIT_PATH` | `./runs/audit.jsonl` | 审计 JSONL |
| `PEC_SKILLS_DIR` | `<cwd>/.dsh/skills` | `skill_write` 落盘目录（测试/评测隔离用） |
| `PEC_VAT_RATE` | `0.13` | 税率（数据无税率字段，标注 assumption） |
| `DSH_HOME` | 由 `dev/run-headless.sh` 强制为 `pec-agent/.dsh-home` | 防止继承开发会话环境 |

## 10. 扩展点与已知边界

- **CR#1 类变更**（新增字段/审批档/工具）预期只改：`tools/*.ts` + `index.ts` + `tool-surface.ts` + 对应 SKILL.md + memory 白名单（如需要）+ 评测用例；**不改执行链路**。
- 失败语义：`NOT_FOUND / INVALID_ARGUMENT / POLICY_DENIED / UPSTREAM_TIMEOUT`（除零以 `INVALID_ARGUMENT reason=E_DIV_ZERO` 表达）。
- 已知边界：题面 R8 汇率无数据源（声明不支持）、R11 成本价无字段（不伪造）、R9 风险分自定公式、R10 等值边界/R7 ≥20 万无真实样本（纯函数断言）；headless 下平台 `ask` 等于拒绝，人工确认用建议卡 `needHuman` + 审计表达。
- 平台约束：工具名只接受 `^[a-zA-Z0-9_-]+$`（题面点号已统一改下划线）；`output.schema` 必须显式 `additionalProperties`；工具返回 value 必须 lossless JSON（`undefined` 属性会让整个调用失败）。
