import { defineTool } from '@deepseek-ai/dsh-tools'
import { one } from '../db.js'
import { denied, invalid, notFound } from '../errors.js'
import { type Fixed, dayDiff, fixedToString, formatMoney, mulIntFixed, toFixed } from '../core/money.js'
import { prov, renderLines, type ProvenanceRef, type ProvenanceTable } from '../core/provenance.js'
import { resolveIdentity } from '../policy/identity.js'
import { writeAudit } from '../policy/audit.js'
import { rememberSession } from '../memory/store.js'

/**
 * 建议卡（R7 / §5.3 / §8.3-1）。
 *
 * 设计原则（答辩口径）：
 *  - 模型不能绕过规则：金额由工具按订单 qty × unit_price 权威复算，模型传入的 amount 只用于核对；
 *  - evidence 每条 ref 必须真实存在，且条款必须属于该订单供应商（防止引用不存在/别家条款的幻觉）；
 *  - R7 审批档位与黑名单由工具强制写死，模型只能“升级”不能“降级” needHuman；
 *  - CR#1（自拟，非官方）：R7 增加「金额 ≥ 100,000.00 需财务会签」一档（同时与 ≥20 万总监+财务叠加），
 *    输出 financeCountersign 字段，render/ruleSummary/记忆 note 同步；
 *  - reschedule 的 newDate 由工具确定性重算（实际交期 + 14 天，题面 §6.1 样例技能口径），忽略模型传值，
 *    这样 A/B 两组的结论五元组才能逐位一致；
 *  - 只产出建议卡，不做任何写操作（题面 §1.4）。
 */

export const ADVICE_ACTIONS = ['reschedule', 'switch_source', 'split', 'replenish', 'audit_freight'] as const

export const R7_THRESHOLDS = {
  /** < 5 万自动 */
  manager: toFixed('50000'),
  /** CR#1：≥ 10 万需财务会签 */
  finance: toFixed('100000'),
  /** ≥ 20 万总监 + 财务 */
  director: toFixed('200000'),
} as const

export interface ApprovalDecision {
  approvalPath: string
  needHuman: boolean
  /** CR#1：金额是否触发 ≥100,000.00 的财务会签（独立于审批路径，便于下游/审计直接取用） */
  financeCountersign: boolean
  ruleHits: string[]
}

/**
 * R7 审批建议（纯函数，边界可单测）：
 *  - 黑名单一律人工（优先级最高）；
 *  - ≥ 200,000.00 → 总监+财务（财务会签含在内）；
 *  - [100,000.00, 200,000.00) → 采购主管 + 财务会签（CR#1 新增档）；
 *  - [50,000.00, 100,000.00) → 采购主管；
 *  - < 50,000.00 → 自动（无需人工审批）。
 * 临界 50,000.00 走主管（不是自动）；临界 100,000.00 起需财务会签。
 */
export function approvalFor(amount: Fixed, blacklisted: boolean): ApprovalDecision {
  const financeCountersign = amount >= R7_THRESHOLDS.finance
  const financeHit = financeCountersign ? ['CR1:GE_100000_FINANCE'] : []
  if (blacklisted) {
    return {
      approvalPath: '人工复核（黑名单供应商）',
      needHuman: true,
      financeCountersign,
      ruleHits: ['R7:blacklist', ...financeHit],
    }
  }
  if (amount >= R7_THRESHOLDS.director) {
    return {
      approvalPath: '总监+财务',
      needHuman: true,
      financeCountersign: true,
      ruleHits: ['R7:GE_200000', 'CR1:GE_100000_FINANCE'],
    }
  }
  if (financeCountersign) {
    return {
      approvalPath: '采购主管+财务会签',
      needHuman: true,
      financeCountersign: true,
      ruleHits: ['R7:GE_50000', 'CR1:GE_100000_FINANCE'],
    }
  }
  if (amount >= R7_THRESHOLDS.manager) {
    return { approvalPath: '采购主管', needHuman: true, financeCountersign: false, ruleHits: ['R7:GE_50000'] }
  }
  return { approvalPath: '自动（无需人工审批）', needHuman: false, financeCountersign: false, ruleHits: ['R7:AUTO_LT_50000'] }
}

/** ISO 日期 + N 天（UTC，避免本地时区偏移）。 */
export function addDays(isoDate: string, days: number): string {
  const base = Date.parse(`${isoDate}T00:00:00Z`)
  if (Number.isNaN(base)) throw invalid(`非法日期：${isoDate}`)
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10)
}

/** reschedule 的标准改期日：实际交期 + 14 天；未交付时回退承诺交期 + 14 天。 */
export function standardReschedule(
  promisedAt: string,
  deliveredAt: string | null | undefined,
): { newDate: string; newDateSource: string } {
  if (deliveredAt) return { newDate: addDays(deliveredAt, 14), newDateSource: 'delivered_at+14' }
  return { newDate: addDays(promisedAt, 14), newDateSource: 'promised_at+14（delivered_at 为空回退）' }
}

const EVIDENCE_TABLES: ProvenanceTable[] = ['orders', 'suppliers', 'skus', 'contracts', 'tickets', 'users']

interface OrderRow {
  id: string
  tenant_id: string
  supplier_id: string
  sku_id: string
  qty: number
  unit_price: number
  amount: number | null
  promised_at: string
  delivered_at: string | null
  status: string
}

interface SupplierRow {
  id: string
  tenant_id: string
  name: string
  risk_level: string
  blacklisted: number
  delay_days_12m: number
}

/** 校验一条证据 ref 是否存在；返回标准化的 {type, ref} 供卡片输出。 */
function validateEvidenceRef(
  raw: string,
  identity: { tenantId: string },
  orderSupplierId: string,
  auditBase: Record<string, unknown>,
): { type: 'table' | 'clause'; ref: string } {
  const ref = raw.trim()
  if (!ref) throw invalid('evidence 里存在空 ref')
  if (ref.includes('#')) {
    const [table, rowId] = ref.split('#')
    if (!rowId) throw invalid(`证据 ref 非法：${ref}`)
    if (!EVIDENCE_TABLES.includes(table as ProvenanceTable)) {
      throw invalid(`证据表名非法：${table}（可选：${EVIDENCE_TABLES.join(' / ')}）`)
    }
    const row =
      table === 'contracts'
        ? one<{ clause_no: string; supplier_id: string }>('select clause_no, supplier_id from contracts where clause_no = ?', [rowId])
        : table === 'users'
          ? one<{ id: string; tenant_id: string }>('select id, tenant_id from users where id = ?', [rowId])
          : one<{ id: string; tenant_id: string }>(`select id, tenant_id from ${table} where id = ?`, [rowId])
    if (!row) throw invalid(`E_EVIDENCE_NOT_FOUND: 证据不存在 ${table}#${rowId}`, { reason: 'E_EVIDENCE_NOT_FOUND', ref })
    if (table === 'contracts') {
      if ((row as { supplier_id: string }).supplier_id !== orderSupplierId) {
        throw invalid(
          `E_EVIDENCE_MISMATCH: 条款 ${rowId} 属于供应商 ${(row as { supplier_id: string }).supplier_id}，不属于本单供应商 ${orderSupplierId}`,
          { reason: 'E_EVIDENCE_MISMATCH', ref },
        )
      }
      return { type: 'clause', ref: rowId }
    }
    if ((row as { tenant_id: string }).tenant_id !== identity.tenantId) {
      writeAudit({ event: 'deny', reason: 'cross-tenant-evidence', ref, ...auditBase })
      throw denied(`POLICY_DENIED: 证据 ${ref} 不属于当前租户 ${identity.tenantId}`, { ref })
    }
    return { type: 'table', ref }
  }
  // 无 # 的 ref 视为条款号（如 CL-07）
  const clause = one<{ clause_no: string; supplier_id: string }>(
    'select clause_no, supplier_id from contracts where clause_no = ?',
    [ref],
  )
  if (!clause) throw invalid(`E_EVIDENCE_NOT_FOUND: 证据不存在 ${ref}（表引用请用 table#rowId，条款引用用 CL-xx）`, { reason: 'E_EVIDENCE_NOT_FOUND', ref })
  if (clause.supplier_id !== orderSupplierId) {
    throw invalid(`E_EVIDENCE_MISMATCH: 条款 ${ref} 属于供应商 ${clause.supplier_id}，不属于本单供应商 ${orderSupplierId}`, {
      reason: 'E_EVIDENCE_MISMATCH',
      ref,
    })
  }
  return { type: 'clause', ref }
}

function evidenceProvenance(evidence: Array<{ type: 'table' | 'clause'; ref: string }>): ProvenanceRef[] {
  return evidence.map((item) => {
    if (item.type === 'clause') return prov('contracts', item.ref, ['type', 'text'])
    const [table, rowId] = item.ref.split('#')
    return prov(table as ProvenanceTable, rowId)
  })
}

function dedupeRisks(risks: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const risk of risks) {
    const trimmed = risk.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    result.push(trimmed)
  }
  return result.slice(0, 8)
}

export const adviceCard = defineTool({
  name: 'advice_card',
  description:
    '生成采购异常处置建议卡（只读、建议不执行）：动作、参数、金额、证据、风险、审批路径、置信度与是否需人工确认。工具会权威复算金额、校验 R7 审批阈值（<5 万自动 / 5–10 万采购主管 / 10–20 万采购主管+财务会签 / ≥20 万总监+财务 / 黑名单一律人工，财务会签为 CR#1 新增）与每条 evidence 是否真实存在，模型不能绕过。适用：一次处置取证完成后输出最终建议时；不适用：查事实（order_lookup）、查历史（ticket_similar）、检索条款（contract_search）。',
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: `处置动作：${ADVICE_ACTIONS.join(' / ')}`,
    },
    orderId: { type: 'string', required: true, description: '采购订单号，如 PO-20261013-0042；必须属当前租户' },
    params: {
      type: 'object',
      additionalProperties: true,
      description: '动作参数（可选），如 {"newDate":"2026-11-16","qty":1000}；reschedule 的 newDate 由工具确定性重算，传入值会被忽略',
    },
    amount: { type: 'number', description: '可选：模型给出的金额（元）。工具按订单 qty × unit_price 权威复算，不一致会拒绝' },
    evidence: {
      type: 'array',
      items: { type: 'string' },
      description: '证据 ref 列表（可选）：表引用写 "orders#PO-..."、"tickets#EX-..."；条款引用写 "CL-07"。工具会自动补订单/供应商来源，并校验每个 ref 真实存在且条款属本单供应商',
    },
    risks: { type: 'array', items: { type: 'string' }, description: '模型识别到的风险（可选）；工具会按订单/供应商事实补充风险' },
    confidence: { type: 'number', description: '置信度 0–1（可选，默认 0.8）' },
    needHuman: { type: 'boolean', description: '可选：模型认为需要人工确认。工具按 R7 强制，模型只能升级（true）不能降级为 false' },
    tenantId: { type: 'string', description: '运行时注入的租户；模型不可自填，传错会被 guard 拒绝' },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => {
      const v = value as any
      const c = v.data.card
      const lines: string[] = []
      lines.push(`建议卡（${c.needHuman ? '需人工确认' : '可自动执行'}）：${c.action}`)
      lines.push(
        `- 订单：${c.order.orderId}（状态 ${c.order.status}；供应商 ${c.supplier.supplierId} ${c.supplier.supplierName}，${c.supplier.riskLevel} 级，黑名单${c.supplier.blacklisted ? '是' : '否'}，近 12 月延迟 ${c.supplier.delayDays12m} 天）`,
      )
      lines.push(
        `- 动作：${c.action}；参数：${JSON.stringify(c.params)}${c.newDate ? `（newDate 按 ${c.newDateSource} 确定性重算）` : ''}`,
      )
      lines.push(`- 金额：${formatMoney(toFixed(c.amount))}（订单权威复算：${c.order.qty} × ${c.order.unitPrice}）`)
      lines.push(`- 审批路径：${c.approvalPath}（规则命中 ${c.ruleHits.join(' / ')}）`)
      lines.push(
        c.financeCountersign
          ? `- 财务会签：需（金额 ≥ 100,000.00，CR#1 阈值；本单 ${formatMoney(toFixed(c.amount))}）`
          : `- 财务会签：不需要（金额 < 100,000.00，CR#1 阈值）`,
      )
      if (c.risks.length) lines.push(`- 风险：${c.risks.join('；')}`)
      lines.push(`- 置信度：${c.confidence}`)
      lines.push(`- 证据：${c.evidence.map((e: any) => (e.type === 'clause' ? `条款 ${e.ref}` : e.ref)).join('、')}`)
      lines.push(
        '口径：R7 阈值 50,000.00 / 100,000.00 / 200,000.00（≥10 万需财务会签、≥20 万总监+财务，黑名单一律人工；财务会签为 CR#1 新增）；本卡只产出建议，不执行任何写操作，用户确认或修改后才进入标注集。',
      )
      return renderLines(lines, v.provenance)
    },
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id)
    const sessionId = exec?.agent?.session?.id
    const a = args as any
    const auditBase = { tool: 'advice_card', sessionId, userId: identity.userId, tenantId: identity.tenantId }

    const action = String(a.action ?? '').trim()
    if (!ADVICE_ACTIONS.includes(action as (typeof ADVICE_ACTIONS)[number])) {
      throw invalid(`未知动作「${action}」，可选：${ADVICE_ACTIONS.join(' / ')}`)
    }
    if (!a.orderId) throw invalid('orderId 必填')

    // ---- 订单 + 供应商（跨租户 POLICY_DENIED，不是 NOT_FOUND）----
    const order = one<OrderRow>(
      `select id, tenant_id, supplier_id, sku_id, qty, unit_price, amount, promised_at, delivered_at, status
         from orders where id = ?`,
      [String(a.orderId)],
    )
    if (!order) throw notFound(`订单不存在：${a.orderId}`, { orderId: a.orderId })
    if (order.tenant_id !== identity.tenantId) {
      writeAudit({ event: 'deny', reason: 'cross-tenant-order', resource: `orders#${order.id}`, ownerTenant: order.tenant_id, ...auditBase })
      throw denied(`POLICY_DENIED: 订单 ${order.id} 不属于当前租户 ${identity.tenantId}`, { orderId: order.id })
    }
    const supplier = one<SupplierRow>(
      'select id, tenant_id, name, risk_level, blacklisted, delay_days_12m from suppliers where id = ?',
      [order.supplier_id],
    )
    if (!supplier) throw notFound(`供应商不存在：${order.supplier_id}`, { supplierId: order.supplier_id })
    if (supplier.tenant_id !== identity.tenantId) {
      writeAudit({ event: 'deny', reason: 'cross-tenant-supplier', resource: `suppliers#${supplier.id}`, ...auditBase })
      throw denied(`POLICY_DENIED: 供应商 ${supplier.id} 不属于当前租户 ${identity.tenantId}`, { supplierId: supplier.id })
    }

    // ---- 金额：工具权威复算（Fixed 4 位定点，HALF_UP）----
    const amountFixed = mulIntFixed(order.qty, toFixed(order.unit_price))
    if (amountFixed <= 0n) {
      throw invalid('E_ZERO_AMOUNT: 订单金额为 0（qty=0？），不能生成金额类建议卡', { reason: 'E_ZERO_AMOUNT' })
    }
    const amountStr = fixedToString(amountFixed)
    if (a.amount !== undefined && a.amount !== null) {
      const given = fixedToString(toFixed(Number(a.amount)))
      if (given !== amountStr) {
        throw invalid(`amount 与订单权威金额不一致：订单 ${amountStr}，传入 ${given}`, { expected: amountStr, got: given })
      }
    }

    const confidence = a.confidence === undefined ? 0.8 : Number(a.confidence)
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw invalid('confidence 必须是 0–1 的数字')

    // ---- R7：工具强制，模型只能升级 needHuman ----
    const decision = approvalFor(amountFixed, Boolean(supplier.blacklisted))

    // ---- evidence：自动补订单/供应商来源，校验其余 ref 存在且条款属本单供应商 ----
    const rawEvidence: string[] = Array.isArray(a.evidence) ? a.evidence.map((x: unknown) => String(x)) : []
    const autoRefs = [`orders#${order.id}`, `suppliers#${supplier.id}`]
    const evidence: Array<{ type: 'table' | 'clause'; ref: string }> = []
    for (const ref of [...autoRefs, ...rawEvidence]) {
      const normalized = validateEvidenceRef(ref, identity, order.supplier_id, auditBase)
      if (!evidence.some((item) => item.ref === normalized.ref)) evidence.push(normalized)
    }
    const provenance: ProvenanceRef[] = [
      prov('orders', order.id, ['qty', 'unit_price', 'promised_at', 'delivered_at', 'status']),
      prov('suppliers', supplier.id, ['name', 'risk_level', 'blacklisted', 'delay_days_12m']),
      ...evidenceProvenance(evidence),
    ]

    // ---- 参数：reschedule 的 newDate 确定性重算（题面 §6.1 样例技能口径：实际交期+14 天）----
    const params: Record<string, unknown> = a.params && typeof a.params === 'object' && !Array.isArray(a.params) ? { ...a.params } : {}
    let newDate: string | undefined
    let newDateSource: string | undefined
    if (action === 'reschedule') {
      const standard = standardReschedule(order.promised_at, order.delivered_at)
      newDate = standard.newDate
      newDateSource = standard.newDateSource
      params.newDate = newDate
    }

    // ---- 风险：模型风险 + 工具按事实补充（去重、截断）----
    const autoRisks: string[] = []
    if (order.delivered_at) autoRisks.push(`延迟 ${dayDiff(order.promised_at, order.delivered_at)} 天`)
    if (supplier.blacklisted) autoRisks.push(`供应商为黑名单（${supplier.risk_level} 级）`)
    else if (supplier.risk_level === 'D') autoRisks.push('供应商风险等级 D')
    if (supplier.delay_days_12m > 0) autoRisks.push(`近 12 月累计延迟 ${supplier.delay_days_12m} 天`)
    if (amountFixed >= R7_THRESHOLDS.director) autoRisks.push(`金额超过 20 万阈值（${amountStr}），需总监+财务审批`)
    else if (amountFixed >= R7_THRESHOLDS.finance) autoRisks.push(`金额超过 10 万阈值（${amountStr}），需财务会签（CR#1）`)
    else if (amountFixed >= R7_THRESHOLDS.manager) autoRisks.push(`金额超过 5 万阈值（${amountStr}）`)
    else autoRisks.push(`金额低于 5 万阈值（${amountStr}），可按自动流程处理`)
    const risks = dedupeRisks([...(Array.isArray(a.risks) ? a.risks.map((x: unknown) => String(x)) : []), ...autoRisks])

    const needHuman = decision.needHuman || a.needHuman === true

    // 会话记忆：当前动作/订单，供下一轮注入（R13）
    // CR#1：记忆层的抽取内容同步扩展——下一轮可直接复用审批路径与财务会签结论，不必重复出卡
    const noteParts = [
      ...(newDate ? [`newDate=${newDate}`] : []),
      `approval=${decision.approvalPath}`,
      `financeCountersign=${decision.financeCountersign ? 'yes' : 'no'}`,
    ]
    rememberSession(identity, sessionId, {
      lastOrderId: order.id,
      lastSupplierId: supplier.id,
      currentAction: action,
      note: noteParts.join(';'),
    })

    const card = {
      action,
      params,
      amount: amountStr,
      evidence,
      risks,
      confidence,
      needHuman,
      approvalPath: decision.approvalPath,
      financeCountersign: decision.financeCountersign,
      ruleHits: decision.ruleHits,
      ...(newDate ? { newDate } : {}),
      ...(newDateSource ? { newDateSource } : {}),
      order: {
        orderId: order.id,
        status: order.status,
        qty: order.qty,
        unitPrice: order.unit_price.toFixed(2),
        amount: amountStr,
        promisedAt: order.promised_at,
        deliveredAt: order.delivered_at,
      },
      supplier: {
        supplierId: supplier.id,
        supplierName: supplier.name,
        riskLevel: supplier.risk_level,
        blacklisted: Boolean(supplier.blacklisted),
        delayDays12m: supplier.delay_days_12m,
      },
    }

    return {
      data: {
        card,
        ruleSummary: `R7：<50000.00 自动；50000.00–99999.99 采购主管；100000.00–199999.99 采购主管+财务会签（CR#1）；≥200000.00 总监+财务；黑名单一律人工（本单 ${amountStr} → ${decision.approvalPath}，财务会签=${decision.financeCountersign ? '需' : '不需要'}）`,
      },
      provenance: [...new Map(provenance.map((ref) => [`${ref.table}#${ref.rowId}`, ref])).values()],
    }
  },
})
