/**
 * A/B 提效对照（题面 §7.3）。
 *
 * 设计：
 *  - 8 条 T-001 同类延迟工单（analysis/data-audit.md §12.2），同一 prompt、同一模型、同一数据；
 *  - A 组（无技能）：把 `.dsh/skills` 临时移到 `runs/ab/skills-parked`，跑完立即恢复；
 *  - B 组（有技能）：保留 `.dsh/skills`；
 *  - 主指标：业务工具调用步数（`tool_call` 数，剔除 `skill` 加载本身），与题面一致用 native executor；
 *  - 辅助：token（`status.step_end.usage` 求和，缺省容错）、墙钟、结论一致率；
 *  - 结论仲裁：以数据/规则算出的**参考结论五元组**（动作/金额/条款/审批路径/改期日）为基准逐位比对，
 *    避免“A 说 X、B 说 Y 谁对”扯不清；同时统计 A/B 两组逐位一致率。
 *
 * 用法（在 pec-agent/ 下）：node eval/ab.mjs
 * 输出：runs/ab/<group>/<order>/（事件流+审计）、eval/ab_summary.json、eval/ab_report.md
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const RUNS = resolve(ROOT, 'runs/ab')
const SKILLS = resolve(ROOT, '.dsh/skills')
const PARKED = resolve(RUNS, 'skills-parked')
const ORDERS = ['PO-20260906-0114', 'PO-20261006-0121', 'PO-20261008-0108', 'PO-20261015-0118', 'PO-20260916-0170', 'PO-20261009-0153', 'PO-20260916-0109', 'PO-20261006-0116']
const PROMPT = (orderId) =>
  `处理订单 ${orderId} 的交期延迟：查订单与合同条款，给出处置建议（动作、金额、条款、审批路径、改期日），并引用数据来源。`

const norm = (text) => String(text ?? '').replace(/[,，\s]/g, '')
const addDays = (isoDate, days) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

// ---- 参考结论（来自 DB + R7 规则，不依赖模型）----
const Database = require(resolve(ROOT, 'plugins/pec-tools/node_modules/better-sqlite3'))
const db = new Database(resolve(ROOT, 'db/pec.db'), { readonly: true })
function referenceFor(orderId) {
  const order = db.prepare('select id, supplier_id, amount, promised_at, delivered_at from orders where id = ?').get(orderId)
  const supplier = db.prepare('select blacklisted from suppliers where id = ?').get(order.supplier_id)
  const clause = db.prepare("select clause_no from contracts where supplier_id = ? and type = 'penalty' order by clause_no limit 1").get(order.supplier_id)
  const cents = Math.round(Number(order.amount) * 100)
  const approvalPath = supplier.blacklisted ? '人工复核（黑名单供应商）' : cents >= 20_000_000 ? '总监+财务' : cents >= 5_000_000 ? '采购主管' : '自动（无需人工审批）'
  return {
    orderId,
    amount: Number(order.amount).toFixed(2),
    action: 'reschedule',
    clause: clause?.clause_no ?? null,
    approvalPath,
    newDate: addDays(order.delivered_at, 14),
    promisedAt: order.promised_at,
    deliveredAt: order.delivered_at,
  }
}
const references = ORDERS.map(referenceFor)

function parseEvents(stdout) {
  return String(stdout ?? '')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function runOne(group, orderId) {
  const caseDir = resolve(RUNS, group, orderId)
  rmSync(caseDir, { recursive: true, force: true })
  mkdirSync(caseDir, { recursive: true })
  const env = {
    ...process.env,
    PEC_USER_ID: 'U-07',
    PEC_MEMORY_PATH: resolve(caseDir, 'memory.json'),
    PEC_AUDIT_PATH: resolve(caseDir, 'audit.jsonl'),
    PEC_SKILLS_DIR: resolve(caseDir, 'skills'),
  }
  const startedAt = Date.now()
  const result = spawnSync('dev/run-headless.sh', ['--json', PROMPT(orderId)], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300_000,
  })
  const durationMs = Date.now() - startedAt
  const events = parseEvents(result.stdout)
  writeFileSync(resolve(caseDir, 'run.jsonl'), result.stdout ?? '')
  const toolCalls = events.filter((e) => e.type === 'tool_call')
  const businessSteps = toolCalls.filter((call) => call.tool !== 'skill').length
  const skillLoaded = toolCalls.filter((call) => call.tool === 'skill').map((call) => call.input?.name ?? 'skill')
  const usageEvents = events.filter((e) => e.type === 'status' && e.phase === 'step_end' && e.usage)
  const tokens = usageEvents.reduce((sum, event) => sum + Number(event.usage.totalTokens ?? event.usage.inputTokens + event.usage.outputTokens ?? 0), 0)
  const final = events.filter((e) => e.type === 'final').map((e) => String(e.text ?? '')).join('\n')
  return { group, orderId, exitCode: result.status, durationMs, businessSteps, totalToolCalls: toolCalls.length, skillLoaded, tokens, tokensMissing: usageEvents.length === 0, final, toolSequence: toolCalls.map((call) => call.tool) }
}

function scoreAgainstReference(run, reference) {
  const final = run.final
  const checks = {
    action: /reschedule/i.test(final) && reference.action === 'reschedule',
    amount: norm(final).includes(norm(reference.amount)),
    clause: reference.clause ? final.includes(reference.clause) : /未检索到|没有.*违约金|无违约金|未找到/.test(final),
    approvalPath: norm(final).includes(norm(reference.approvalPath)),
    newDate: final.includes(reference.newDate),
  }
  const matched = Object.values(checks).filter(Boolean).length
  return { checks, matched, score: matched / 5 }
}

function runGroup(group, skillMode) {
  return references.map((reference) => {
    const run = runOne(group, reference.orderId)
    const ref = scoreAgainstReference(run, reference)
    console.log(`${group} ${reference.orderId} tools=${run.toolSequence.join('→')} steps=${run.businessSteps} tokens=${run.tokens} score=${ref.matched}/5`)
    return { ...run, reference, referenceScore: ref.score, fieldChecks: ref.checks }
  })
}

mkdirSync(RUNS, { recursive: true })
mkdirSync(dirname(PARKED), { recursive: true })
const startedAt = Date.now()
let groupA
try {
  rmSync(PARKED, { recursive: true, force: true })
  renameSync(SKILLS, PARKED)
  try {
    console.log('A 组：已临时移走 .dsh/skills')
    groupA = runGroup('A')
  } finally {
    renameSync(PARKED, SKILLS)
    console.log('已恢复 .dsh/skills')
  }
} catch (error) {
  // 兜底：任何异常都要尽力恢复技能目录，避免交付物损坏
  if (!existsSync(SKILLS) && existsSync(PARKED)) {
    try {
      renameSync(PARKED, SKILLS)
    } catch {
      /* ignore */
    }
  }
  throw error
}
console.log('B 组：保留 .dsh/skills')
const groupB = runGroup('B')

const avg = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0)
const sum = (values) => values.reduce((total, value) => total + value, 0)
const avgStepsA = avg(groupA.map((run) => run.businessSteps))
const avgStepsB = avg(groupB.map((run) => run.businessSteps))
const avgTokensA = avg(groupA.map((run) => run.tokens))
const avgTokensB = avg(groupB.map((run) => run.tokens))
const stepsReductionPct = avgStepsA > 0 ? Number((((avgStepsA - avgStepsB) / avgStepsA) * 100).toFixed(1)) : 0
const tokensReductionPct = avgTokensA > 0 ? Number((((avgTokensA - avgTokensB) / avgTokensA) * 100).toFixed(1)) : 0
const referenceScoreA = avg(groupA.map((run) => run.referenceScore))
const referenceScoreB = avg(groupB.map((run) => run.referenceScore))
// 逐位一致率（以参考结论为仲裁：两组的 5 个字段命中布尔值是否一致）
let fieldMatches = 0
let fieldTotal = 0
const perOrder = references.map((reference, index) => {
  const a = groupA[index]
  const b = groupB[index]
  const fields = Object.keys(a.fieldChecks)
  const agreedFields = fields.filter((field) => a.fieldChecks[field] === b.fieldChecks[field])
  fieldMatches += agreedFields.length
  fieldTotal += fields.length
  const identical = fields.every((field) => a.fieldChecks[field] === b.fieldChecks[field])
  return { reference, a, b, identical, agreedFields, disagreedFields: fields.filter((field) => !agreedFields.includes(field)) }
})
const agreementPct = Number(((fieldMatches / Math.max(fieldTotal, 1)) * 100).toFixed(1))
const consistencyOk = referenceScoreB >= referenceScoreA
const efficiencyOk = Math.max(stepsReductionPct, tokensReductionPct) >= 30

const summary = {
  generatedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt,
  orders: ORDERS,
  prompt: PROMPT('<orderId>'),
  groupSize: ORDERS.length,
  avgStepsA: Number(avgStepsA.toFixed(2)),
  avgStepsB: Number(avgStepsB.toFixed(2)),
  stepsReductionPct,
  avgTokensA: Math.round(avgTokensA),
  avgTokensB: Math.round(avgTokensB),
  tokensReductionPct,
  referenceScoreA: Number(referenceScoreA.toFixed(3)),
  referenceScoreB: Number(referenceScoreB.toFixed(3)),
  agreementPct,
  consistencyOk,
  efficiencyOk,
  gatePass: efficiencyOk && consistencyOk,
  tokensMissingRuns: [...groupA, ...groupB].filter((run) => run.tokensMissing).length,
  // A 组偶发“模型猜到技能名但目录已移走 → unknown skill”的调用；skill 调用不计入业务步数，
  // 因此不影响 A/B 主指标，但需在报告里如实说明。
  aSkillAttempts: groupA.filter((run) => run.skillLoaded.length > 0).map((run) => run.orderId),
  details: perOrder.map(({ reference, a, b, identical, disagreedFields }) => ({
    orderId: reference.orderId,
    reference,
    A: { steps: a.businessSteps, tokens: a.tokens, ms: a.durationMs, score: a.referenceScore, toolSequence: a.toolSequence, skillLoaded: a.skillLoaded },
    B: { steps: b.businessSteps, tokens: b.tokens, ms: b.durationMs, score: b.referenceScore, toolSequence: b.toolSequence, skillLoaded: b.skillLoaded },
    identical,
    disagreedFields,
  })),
}
writeFileSync(resolve(HERE, 'ab_summary.json'), `${JSON.stringify(summary, null, 2)}\n`)

const fmt = (value) => (typeof value === 'number' ? String(value) : String(value ?? '-'))
const lines = []
lines.push('# A/B 提效对照报告（题面 §7.3）')
lines.push('')
lines.push(`- 生成时间：${summary.generatedAt}`)
lines.push(`- 工单：${ORDERS.length} 条 T-001 同类延迟工单（data-audit §12.2，供应商黑名单=0、金额<50,000）`)
lines.push(`- 分组：A 组（无技能，临时移走 \`.dsh/skills\`）/ B 组（保留技能）；同模型、同数据、同 prompt`)
lines.push(`- 主指标：业务工具调用步数（剔除 \`skill\` 加载）；辅助：token（\`step_end.usage\` 求和，缺失 ${summary.tokensMissingRuns} 条）、墙钟、结论一致率`)
lines.push('')
lines.push('## 1. 指标对照')
lines.push('')
lines.push('| 指标 | A 组（无技能） | B 组（有技能） | 变化 | 判定 |')
lines.push('|---|---|---|---|---|')
lines.push(`| 平均业务工具步数 | ${fmt(summary.avgStepsA)} | ${fmt(summary.avgStepsB)} | **↓ ${stepsReductionPct}%** | ${stepsReductionPct >= 30 ? '✅ ≥30%' : '❌ <30%'} |`)
lines.push(`| 平均 token | ${fmt(summary.avgTokensA)} | ${fmt(summary.avgTokensB)} | ${tokensReductionPct > 0 ? '↓' : '↑'} ${Math.abs(tokensReductionPct)}% | 参考 |`)
lines.push(`| 参考结论得分（0–1） | ${fmt(summary.referenceScoreA)} | ${fmt(summary.referenceScoreB)} | ${summary.referenceScoreB >= summary.referenceScoreA ? 'B ≥ A' : 'B < A'} | ${summary.consistencyOk ? '✅ 一致率不低于 A' : '❌ 低于 A'} |`)
lines.push(`| 逐位一致率（A vs B，以数据/规则仲裁） | - | - | ${agreementPct}% | 参考 |`)
lines.push('')
lines.push(`**门禁判定**：${summary.gatePass ? '✅ PASS' : '❌ FAIL'}（步数或 token 降幅 ≥30% 且结论一致率不低于 A）`)
lines.push('')
lines.push('## 2. 逐单对照')
lines.push('')
lines.push('| # | 订单 | 金额 | 条款 | 审批路径 | 改期日 | A 步数/token/得分 | B 步数/token/得分 | 结论一致 |')
lines.push('|---|---|---|---|---|---|---|---|---|')
perOrder.forEach((item, index) => {
  const { reference, a, b, identical, disagreedFields } = item
  lines.push(
    `| ${index + 1} | ${reference.orderId} | ${reference.amount} | ${reference.clause ?? '未检索到'} | ${reference.approvalPath} | ${reference.newDate} | ${a.businessSteps} / ${a.tokens} / ${(a.referenceScore * 5).toFixed(0)}/5 | ${b.businessSteps} / ${b.tokens} / ${(b.referenceScore * 5).toFixed(0)}/5 | ${identical ? '✅' : `⚠ ${disagreedFields.join('/')}`} |`,
  )
})
lines.push('')
lines.push('## 3. 口径与备注')
lines.push('')
lines.push('- 参考结论由「DB 实际金额 + R7 阈值 + 实际交期+14 天 + 该供应商 penalty 条款」确定性生成，作为逐位仲裁基准；未使用模型输出。')
lines.push('- A 组移走 `.dsh/skills` 后技能目录为空，模型走通用流程；B 组保留技能，允许命中按技能执行、未命中回退。')
lines.push('- 每条工单两组各跑 1 次（时间预算）；token 口径为 `step_end.usage.totalTokens` 求和，缺失运行已计数并在顶部标注。')
lines.push('- 技能命中：B 组 tool_call 中 `skill` 的加载记录见 `runs/ab/B/<order>/run.jsonl`。')
if (summary.aSkillAttempts.length > 0) {
  lines.push(`- **A 组异常（如实记录）**：${summary.aSkillAttempts.join('、')} 在 A 组（技能目录已移走）仍出现一次 \`skill\` 调用（\`unknown or no longer available\`，疑似模型猜测技能名），随后回退通用流程；该 \`skill\` 调用不计入业务工具步数，A 组实际无技能可用，不影响对照公平性。`)
}
lines.push('')
writeFileSync(resolve(HERE, 'ab_report.md'), `${lines.join('\n')}\n`)

console.log('')
console.log(`平均步数：A=${summary.avgStepsA} → B=${summary.avgStepsB}（↓${stepsReductionPct}%）`)
console.log(`平均 token：A=${summary.avgTokensA} → B=${summary.avgTokensB}（${tokensReductionPct}%）`)
console.log(`参考得分：A=${summary.referenceScoreA} B=${summary.referenceScoreB}；逐位一致率=${agreementPct}%`)
console.log(`门禁：${summary.gatePass ? 'PASS' : 'FAIL'}（效率 ${efficiencyOk ? 'OK' : 'NO'} / 一致 ${consistencyOk ? 'OK' : 'NO'}）`)
if (!summary.gatePass) process.exitCode = 1
