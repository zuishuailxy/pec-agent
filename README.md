# PEC 采购异常处置 Agent（Procurement Exception Copilot）

> 基于 DSH 0.2.1-rc.2 的采购异常处置 Agent 交付物：**12 个业务/记忆/技能工具 + 3 份 SKILL.md + 两层记忆 + 15 条 golden set + 专项集 + A/B 提效 + 门禁**。
> 六项指标全部达标：回答准确率 100% · 引用可溯 100% · 记忆命中 100% · 技能复用 100% · **提效 73.5%** · 越权拦截 100%（证据见 [`eval/report.md`](eval/report.md)、[`eval/ab_report.md`](eval/ab_report.md)）。

## 1. 环境与前置

| 项 | 值 |
|---|---|
| 平台 | DSH **0.2.1-rc.2**（`dev/node_modules/.bin/dsh`），headless profile：`.dsh-home/profiles/headless` |
| 模型 | `deepseek-official / deepseek-flash`（不换模型、不写网关） |
| 数据 | `db/pec.db`（只读 SQLite：orders 120 / suppliers 32 / skus 86 / contracts 46 / tickets 28 / users 8） |
| API Key | `pec-agent/.env`（**不提交、不打日志**；`.env.example` 给了模板） |
| 技能根 | `.dsh/skills/`（profile 已设 `includeDefaultRoots: false` + `customSkillDirs` 指向本目录，避免本机技能污染） |

```bash
cd pec-agent
./dev/build.sh                 # esbuild: plugins/pec-tools/src → lib（profile 加载 lib/index.js）
node dev/test-tools.mjs        # 工具级冒烟（不需要模型）：133 passed
```

## 2. 三段演示命令（题面要求）

```bash
# ① 单轮问答：订单延迟 + 条款 + 建议卡（工具序列与来源可核对）
./dev/run-headless.sh --json "处理订单 PO-20261013-0042 的交期延迟：先查订单事实，再检索该供应商的违约金条款，最后给出建议卡与审批路径"

# ② 多轮记忆：第 2 轮不再重复询问订单号（一键脚本，自动断言；也可按 memory/extract.md 手动两轮）
./dev/demo-memory.sh

# ③ 技能命中：不点名技能，由 catalog 自主命中 delay-small-standard（3 步出卡）
./dev/run-headless.sh --json "PO-20260906-0114 延迟，按标准流程处理，最后给出建议卡"
```

预期（详见 [`traces/`](traces/README.md) 的真实事件流快照）：

- 输入①：`tool_call` 依次出现 `order_lookup → contract_search → advice_card`；final 含延迟 **13 天**、金额 **57,600.00**、条款 **CL-07**、审批 **采购主管**、改期日 **2026-11-16**，并带 `[来源: orders#…] [来源: contracts#CL-07]`。
- 输入②：第 1 轮 `order_lookup` 自动写会话记忆；第 2 轮只问“那违约金多少？”时**不再问订单号**，审计出现 `memory.injected`（`lastOrderId="PO-20261013-0042"`）。
- 输入③：`tool_call skill {"name":"delay-small-standard"}` → `order_lookup → contract_search → advice_card`（业务工具 **3 步**），条款 **CL-45（1‰）**、金额 **5,239.50**、审批“自动”。

## 3. 目录结构

```
pec-agent/
├── plugins/pec-tools/          # 唯一业务代码：src/**.ts → ./dev/build.sh → lib/*.js（profile 加载 lib/index.js）
│   ├── src/index.ts            # 注册工具 + guard + tool-surface + 记忆注入
│   ├── src/tools/              # catalog / order_lookup / supplier_profile / pricing_quote /
│   │                           # freight_calc / contract_search / ticket_similar / advice_card /
│   │                           # memory_recall / memory_remember / memory_forget / skill_write
│   ├── src/policy/             # identity / audit / guard / masking / tool-surface
│   ├── src/core/               # money（BigInt 4 位定点）/ provenance（[来源: table#rowId]）
│   └── src/memory/             # store（两层记忆）/ inject（每轮 systemPrompt 注入）
├── .dsh/skills/                # delay-small-standard（手写）/ stock-replenish（Agent 沉淀）/ freight-anomaly-standard（样例）
├── memory/                     # store.json（运行产物，收工复位为空 seed）+ extract.md（白名单/抽取/注入规则）
├── eval/                       # golden_set.jsonl 15 条 / run.sh / run.mjs / collect.mjs / special.mjs / ab.mjs / failure-case.md
│                              # report.md / summary.json / ab_report.md / ab_summary.json / special_summary.json
├── traces/                     # qa / memory / skill-write / skill-hit 四类真实事件流 + failure/（T10 前后对照） + README.md
├── dev/                        # build.sh / run-headless.sh / test-tools.mjs / demo-memory.sh
├── plan.md / todo.md / design.md / ARCHITECTURE.md / CHANGELOG.md
└── db/                         # schema.sql / seed.sql / pec.db（只读）
```

## 4. 工具清单与命名映射

题面工具名含点号会被真实 DeepSeek Messages API 拒绝（`Invalid 'tools[1].name'`），实现统一下划线，技能/提示/断言都用实现名：

| 题面名 | 实现名 | 能力 |
|---|---|---|
| `pec.data.catalog` | `pec_data_catalog` | 6 张表行数（自检） |
| `order.lookup` | `order_lookup` | 订单/交期/状态/库存（租户校验 + provenance）；**CR#1 物流商派生字段** |
| `supplier.profile` | `supplier_profile` | 等级/黑名单/近 12 月延迟/风险分/联系人脱敏 |
| `pricing.quote` | `pricing_quote` | 阶梯价 + 金额/税额定点计算（R1/R4） |
| `freight.calc` | `freight_calc` | 体积进位（3.2→4、0.4→1）/ 总运费 / 计件（qty=0 → E_DIV_ZERO） |
| `contract.search` | `contract_search` | FTS5 + 同义词回退检索条款；无命中明确“未检索到” |
| `ticket.similar` | `ticket_similar` | 按异常类型+供应商+金额区间召回历史工单（规则相似度 + 按订单去重） |
| —（新增） | `advice_card` | 建议卡：R7 审批（含 **CR#1 ≥10 万财务会签**）/黑名单/证据存在性由工具强制校验 |
| —（新增） | `memory_recall` / `memory_remember` / `memory_forget` | 两层记忆读写与撤销 |
| —（新增） | `skill_write` | 技能落盘：frontmatter/护栏/反例校验 + 目录白名单 + 审计 |

工具面通过 `policy/tool-surface.ts` 收紧为上述 12 个 + `skill`（PEC agent 看不到 bash/read/write/grep，满足“不得绕过工具直接读表”）。**新增工具必须同步 `PEC_TOOLS` allow 列表、`index.ts`、`business.ts`、`dev/build.sh` 并重编译**。

## 5. 复跑评测与门禁（六指标）

```bash
bash eval/run.sh                  # 15 条 golden set（5 正常 / 3 边界 / 3 对抗 / 2 CR#1 / 1 记忆 / 1 技能）
node eval/special.mjs             # 专项集：记忆 5 对 / 越权矩阵 9 条 / 技能命中 2 条
node eval/ab.mjs                  # A/B：8 条 T-001 延迟工单，A 组无技能 vs B 组有技能
node eval/collect.mjs --gate      # 合并报告 + 门禁（任一已评测指标不达标 → 退出码非 0）
```

- 门禁目标：准确率 ≥90% / 引用可溯 100% / 记忆命中 ≥80% / 技能复用 ≥60% / 提效 ≥30% / 越权拦截 100%。
- 当前证据（一次运行）：`eval/report.md`（12/12；六指标全绿）、`eval/ab_report.md`（步数 12.25→3.25，↓73.5%；参考得分 0.875→0.9；逐位一致率 92.5%）、`eval/special_summary.json`（5/5、9/9、2/2）。
- 提效主指标 = **业务工具调用步数**（native executor 下数 `tool_call`，剔除 `skill` 加载本身）；token 作辅助（技能正文会抬高 token）。

> 注意：评测结果是模型真实输出，**不同运行数值/步数会有波动**；本仓提交的是某次完整运行快照，命令可随时复跑。

## 6. 插件如何被加载（答辩用）

1. `plugins/pec-tools/src/**.ts` 由 `./dev/build.sh`（esbuild，非 bundle → 所有被 import 的文件都要列 entry）编译到 `plugins/pec-tools/lib/`；
2. `plugins/pec-tools/package.json` 的 `main = lib/index.js`（**该文件保持预装原样，未改**）；
3. `.dsh-home/profiles/headless/cordis.patch.yml` 通过 `- insert: - id: pec-tools - name: 'file:///…/lib/index.js'` 挂载插件；`skill-filesystem` 配置限定技能根为 `.dsh/skills`；
4. `./dev/run-headless.sh`（强制 `DSH_HOME=pec-agent/.dsh-home`、`cd pec-agent`）启动 `dsh --profile headless` → loader import `lib/index.js` → `apply(ctx)` 注册工具/guard/工具面/记忆注入；
5. 验证：`./dev/run-headless.sh --json "调用 pec_data_catalog 看看有哪些表"`，看 `tool_call` + 6 张表；**改 `src/*.ts` 后必须重跑 `./dev/build.sh`**，否则加载旧 `lib/`。

## 7. 安全与口径要点（详见 design.md / CHANGELOG.md）

- **身份**：平台无 tenant/user 服务 → `PEC_USER_ID`（进程可信）→ `users` 表解析；模型传的 `tenantId/role/userId` 一律不用于鉴权；跨租户返回 `POLICY_DENIED` + JSONL 审计（不是 NOT_FOUND）。
- **引用可溯**：模型只看得到 `render()`，因此所有来源、统计、口径都写进 render 文本（`[来源: table#rowId]`）；`value/schema` 不上 wire。
- **金额**：`core/money.ts` 的 BigInt 4 位定点 + HALF_UP，中间值不二次 rescale；禁 JS number 累加。
- **脱敏**：联系人按角色掩码、合同原文 buyer/manager/auditor 不可见；脱敏/拒绝都留痕。
- **无害**：只读数据 + 建议卡，不执行写操作；人工确认体现在 `needHuman`/审批路径与审计，headless 下不依赖平台 `ask`。
- **能力边界**：system prompt 固定声明工具白名单（动态取 `PEC_TOOLS`）并明确“无 bash/文件工具、检索无命中如实回答、不得把 sqlite3/grep 命令交给用户”（T10 修复）；硬拦截仍由 `policy/tool-surface.ts` 的 restrict 保证。
- **题面缺口**（已声明，不伪造）：R8 汇率无字段 → 声明不支持；R11 成本价无字段 → 字段级越权落到 contacts 掩码+跨租户；R9 风险分为自定公式；R10 等值边界/R7 ≥20 万无样本 → 纯函数断言。
- **CR#1（自拟，非官方；线下无官方 CR）**：`order_lookup` 增物流商派生字段（数据表无该字段，按物流单价 78/85/92 三档确定性派生并标 `derived_rule_CR1-v1`）；`advice_card` 的 R7 增「金额 ≥100,000.00 需财务会签」档（10–20 万为“采购主管+财务会签”）；技能护栏与记忆抽取同步。假设与回归见 `CHANGELOG.md` v1.0。

## 8. 打包与提交提醒

- 最终打包 `姓名-PEC-日期.zip`；本仓以 **`Candidate` 占位**，提交前请把包名与 README 中的作者占位替换为真实姓名。
- 打包排除：`.env`、`node_modules/`、`.dsh-home/`、`runs/`、`.DS_Store`（`.gitignore` 已覆盖）。
- 每日收工打 tag：`d1`（第一天）/ `d2`（第二天）；工作区保持干净可重跑。

## 9. 文档索引

| 文档 | 内容 |
|---|---|
| [plan.md](plan.md) | 目标、架构、逐模块 spec（输入/输出/错误/验收/测试向量）、口径假设、风险、排期 |
| [todo.md](todo.md) | 按依赖排序的任务清单 + 完成定义 + 验证命令（每项完成汇报点） |
| [design.md](design.md) | 设计说明：平台适配、工具/权限/记忆/技能/评测设计、ADR 决策记录、数据缺口 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 分层架构、模块边界、一次处置的数据流、扩展点与运行时依赖 |
| [CHANGELOG.md](CHANGELOG.md) | 行为变化、评测结果、口径冲突与修复（含自拟 CR#1） |
| [traces/README.md](traces/README.md) | 四类 trace + T10 失败对照的复跑命令与证据点 |
| [eval/failure-case.md](eval/failure-case.md) | T10 失败归因：现象/根因/修复/前后对照 |
| [memory/extract.md](memory/extract.md) | 记忆白名单、抽取时机、冲突合并、注入规则、验证命令 |
