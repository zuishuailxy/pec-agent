# traces 使用说明

> 交付物之一（任务书 §8.1 / §8.2）。四类真实运行证据，全部由 `dsh --profile headless --json` 产生，可直接用 `traces/README.md` 中的命令复跑。
> 文件为 NDJSON 事件流（`session / status / thinking / text / tool_call / tool_result / final`）；`*-audit.jsonl` 是同一次运行的业务审计（guard / 字段脱敏 / 记忆 / 技能落盘）。

## 目录

| 目录 | 内容 | 关键证据 |
|---|---|---|
| `qa/` | 问答类代表性 run（T7 补齐） | 工具调用与 `[来源: table#rowId]` |
| `memory/` | 两轮记忆（T7 从 `dev/demo-memory.sh` 的 run 复制） | 第 2 轮不重复问订单号 + `memory.injected` |
| `skill-write/` | **技能 B 由 Agent 在真实对话中生成并落盘** | `tool_call skill_write` + 审计 `skill.written` |
| `skill-hit/` | **技能 A / B 在后续会话命中** | `tool_call skill`（name=技能名）+ 工具序列 |

## skill-write（T4，2026-11-07）

```bash
PEC_AUDIT_PATH=runs/t4-skill-b-audit.jsonl ./dev/run-headless.sh --json \
  "处理订单 PO-20260917-0129 的缺货问题：先用 order_lookup 取……按 (安全库存×2 − 当前库存 − 在途) 向上取整到 MOQ 整数倍算补货量，再用 supplier_profile 确认供应商是否黑名单；最后把这次可复用的处置沉淀成技能 stock-replenish：调用 skill_write 落盘，正文必须包含「## 护栏」与「## 反例」两段……"
```

- 文件：`skill-b-generated.jsonl`（事件流）、`skill-b-audit.jsonl`（审计）
- 结果：`skill_write` 成功落盘 `.dsh/skills/stock-replenish/SKILL.md`（3002 字节，新建）；
  审计 `skill.written` 含 `name/path/bytes/created/sessionId/userId/tenantId`；
- 同一轮还验证了：补货量 `raw=800×2−420−200=980 → ceil(980/500)×500=1000`；黑名单 `SUP-1062` → `advice_card` 强制 `needHuman=true`。

## skill-hit（T4，2026-11-07）

```bash
# 技能 A（手写 delay-small-standard）命中：金额 5,239.50、SUP-1050、CL-45（1‰）
./dev/run-headless.sh --json "处理订单 PO-20260906-0114 的交期延迟，按标准流程（delay-small-standard）处理，最后给出建议卡"

# 技能 B（Agent 沉淀 stock-replenish）在**新会话**命中
./dev/run-headless.sh --json "PO-20260917-0129 缺货，按 stock-replenish 处理：算补货量并说明是否需人工"
```

| 文件 | 命中技能 | 工具序列（`tool_call` 顺序） | 结论 |
|---|---|---|---|
| `skill-a-hit.jsonl` | `delay-small-standard` | `skill` → `order_lookup` → `contract_search` → `advice_card` | 金额 5,239.50、条款 CL-45（1‰）、newDate 2026-10-18（实际交期+14）、审批“自动” |
| `skill-b-hit.jsonl` | `stock-replenish` | `skill` → `order_lookup` → `supplier_profile` → `advice_card` | 补货量 1000、黑名单强制人工、金额 6,732.00（工具复算） |

> 技能命中判定：事件流出现 `{"type":"tool_call","tool":"skill","input":{"name":"<技能名>"}}`，且随后工具序列显著短于通用流程。
> 技能 A 的 `whenToUse` 收窄到“金额 <5 万且非黑名单”，所以金额 57,600 的 0042 只会走取证、必须升级主管（护栏）。

## 复跑前置

```bash
cd pec-agent
./dev/build.sh && node dev/test-tools.mjs     # 113 passed（T4 后）
ls .dsh/skills/                               # delay-small-standard / stock-replenish / freight-anomaly-standard
```
