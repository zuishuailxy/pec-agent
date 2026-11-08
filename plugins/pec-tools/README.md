# @pec/pec-tools

PEC 采购异常处置 Agent 插件。随 headless profile 加载（`.dsh-home/profiles/headless/cordis.patch.yml` 里 `- insert:` 指向 `lib/index.js`），**无需安装、不改 profile 原件**。

## 入口与加载

- `package.json` 的 `main = lib/index.js`（预装原样，未改）；
- 源码 `src/**/*.ts` 经 `pec-agent/dev/build.sh`（esbuild，非 bundle）编译到 `lib/`；
- `src/index.ts` 里 `export const inject = ['tools']`，`apply(ctx)` 注册工具 + guard + 工具面 + 记忆注入。

## 当前实现（12 个工具）

| 工具 | 文件 | 说明 |
|---|---|---|
| `pec_data_catalog` | `src/tools/catalog.ts` | 6 张表行数（自检） |
| `order_lookup` | `src/tools/order-lookup.ts` | 订单履约/库存/物流商（CR#1 派生），租户校验 |
| `supplier_profile` | `src/tools/supplier-profile.ts` | 等级/黑名单/风险分/联系人脱敏 |
| `pricing_quote` | `src/tools/pricing-quote.ts` | 阶梯价 + 金额/税额（Fixed 定点） |
| `freight_calc` | `src/tools/freight-calc.ts` | 体积进位/总运费/计件；qty=0 → E_DIV_ZERO |
| `contract_search` | `src/tools/contract-search.ts` | 条款检索（FTS5+同义词回退），无命中“未检索到” |
| `ticket_similar` | `src/tools/ticket-similar.ts` | 历史工单召回（规则相似度 + 按订单去重） |
| `advice_card` | `src/tools/advice-card.ts` | 建议卡（R7 含 CR#1 财务会签/黑名单/evidence 强制校验） |
| `memory_recall` / `memory_remember` / `memory_forget` | `src/tools/memory-tools.ts` | 两层记忆读写/撤销 |
| `skill_write` | `src/tools/skill-write.ts` | 技能落盘（frontmatter/护栏/反例校验） |

策略与基础设施：`src/policy/{identity,audit,guard,masking,tool-surface,tool-boundary}.ts`、`src/core/{money,provenance}.ts`、`src/memory/{store,inject}.ts`、`src/{db,errors}.ts`。

## 契约（所有工具遵守）

1. `defineTool` 声明 `parameters`（平台校验）、`output.schema`（显式 `additionalProperties`）、`output.render`（模型唯一可见通道）；
2. 返回值统一 `{ data, provenance }`，provenance 到 `table + rowId`；来源标记必须写进 `render` 文本（`[来源: table#rowId]`）；
3. 错误码只用 `NOT_FOUND / INVALID_ARGUMENT / POLICY_DENIED / UPSTREAM_TIMEOUT`（除零用 `INVALID_ARGUMENT reason=E_DIV_ZERO`）；
4. 金额/体积走 `core/money.ts` 的 BigInt 4 位定点，禁止 JS number 累加；
5. 只读：SQLite 以 `readonly` 打开；不执行写操作；
6. **新增工具必须同步**：`src/tools/business.ts` re-export → `src/index.ts` 注册 → `src/policy/tool-surface.ts` 的 `PEC_TOOLS` allow 列表 → `dev/build.sh` entry → 重编译。
