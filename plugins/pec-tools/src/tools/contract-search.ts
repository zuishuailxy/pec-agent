import { defineTool } from '@deepseek-ai/dsh-tools'
import { all, one } from '../db.js'
import { ToolError, denied, notFound } from '../errors.js'
import { prov, renderLines } from '../core/provenance.js'
import { resolveIdentity } from '../policy/identity.js'
import { auditFieldAccess, contractTextAccess } from '../policy/masking.js'

interface ClauseRow {
  clause_no: string
  supplier_id: string
  type: string
  text: string
  effective_from: string
}

/**
 * 关键词归一化：FTS5 trigram 只支持 ≥3 字子串；业务词与合同用词经常对不上
 * （如「运费」vs「运输费用」）。这里做显式同义词 + LIKE 回退，保证短词也能命中。
 */
const SYNONYMS: Array<[RegExp, string]> = [
  [/违约|赔付|罚金/, '违约金'],
  [/运费|运输费|物流费/, '运输费用'],
  [/质保|保修|质量保证/, '质保期'],
  [/付款|账期|货款|回款/, '支付货款'],
  [/延迟|交期|逾期/, '延迟交货'],
  [/起订|最少订购|MOQ/i, '最小起订量'],
]

export function expandTerms(keyword: string): string[] {
  const terms = new Set<string>()
  const trimmed = keyword.trim()
  if (trimmed) terms.add(trimmed)
  for (const [pattern, canonical] of SYNONYMS) {
    if (pattern.test(trimmed)) terms.add(canonical)
  }
  // 复合词再拆一次（如「运费承担」→ 运输费用；「违约金条款」→ 违约金）
  for (const term of [...terms]) {
    for (const [pattern, canonical] of SYNONYMS) {
      if (pattern.test(term)) terms.add(canonical)
    }
  }
  return [...terms].filter(Boolean)
}

function ftsSearch(supplierId: string, term: string): ClauseRow[] {
  return all<ClauseRow>(
    `select c.clause_no, c.supplier_id, c.type, c.text, c.effective_from
       from contracts_fts f join contracts c on c.clause_no = f.clause_no
      where contracts_fts match ? and c.supplier_id = ?
      order by bm25(contracts_fts) limit 5`,
    [term, supplierId],
  )
}

function likeSearch(supplierId: string, term: string): ClauseRow[] {
  return all<ClauseRow>(
    `select clause_no, supplier_id, type, text, effective_from
       from contracts where supplier_id = ? and text like ? order by clause_no limit 5`,
    [supplierId, `%${term}%`],
  )
}

/** 从条款原文确定性抽取结构化摘要（不算「原文」，用于角色脱敏后的业务判断）。 */
export function summarizeClause(row: ClauseRow): Record<string, unknown> {
  const text = row.text
  const summary: Record<string, unknown> = {}
  if (row.type === 'penalty') {
    const rate = text.match(/(\d+(?:\.\d+)?)\s*‰/)
    const cap = text.match(/(\d+(?:\.\d+)?)\s*%/)
    if (rate) summary.ratePermille = rate[1]
    if (cap) summary.capPercent = cap[1]
    summary.basis = '合同金额'
    summary.perDay = true
  } else if (row.type === 'moq') {
    const moq = text.match(/最小起订量为\s*(\d+)\s*件/)
    if (moq) summary.minOrderQty = Number(moq[1])
  } else if (row.type === 'freight') {
    const bearer = text.match(/运输费用由(买方|卖方)承担/)
    if (bearer) summary.freightBearer = bearer[1]
    summary.billingRule = '计费体积按向上取整的立方尺计算'
  } else if (row.type === 'payment') {
    const days = text.match(/(\d+)\s*日内支付货款/)
    const overdue = text.match(/日万分之(\d+(?:\.\d+)?)/)
    if (days) summary.paymentDays = Number(days[1])
    if (overdue) summary.overdueDailyRate = `万分之${overdue[1]}`
  } else if (row.type === 'warranty') {
    const months = text.match(/质保期为交付之日起\s*(\d+)\s*个月/)
    if (months) summary.warrantyMonths = Number(months[1])
  }
  return summary
}

export const contractSearch = defineTool({
  name: 'contract_search',
  description:
    '按供应商 + 关键词检索合同条款（FTS5 关键词召回 + 同义词回退），返回条款号、类型、结构化摘要与出处；无命中时明确返回「未检索到」。适用：找违约金/运费/质保/MOQ/账期条款时；不适用：查订单事实（用 order.lookup）、查供应商画像（用 supplier.profile）。只允许引用本工具返回的条款号。',
  parameters: {
    supplierId: { type: 'string', required: true, description: '供应商编码，如 SUP-1042' },
    keyword: { type: 'string', required: true, description: '检索词，如「违约金」「运输费用」「质保期」；短词会自动归一化' },
    tenantId: { type: 'string', description: '运行时注入的租户；模型不可自填' },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => {
      const v = value as any
      const d = v.data
      if (!d.found) {
        return renderLines(
          [`未检索到与该供应商匹配的条款（关键词：${d.keyword}；扩展词：${d.expandedTerms.join(' / ')}）。不得引用任何条款号，也不得虚构合同内容。`],
          v.provenance,
        )
      }
      const lines = d.hits.map((hit: any) => {
        const terms = JSON.stringify(hit.terms)
        return `${hit.clauseNo} [${hit.type}] ${hit.summaryText}；结构化摘要 ${terms}${hit.text ? `；原文：${hit.text}` : '；原文按角色不可见'}`
      })
      lines.unshift(`匹配到 ${d.hits.length} 条条款（关键词：${d.keyword}；扩展词：${d.expandedTerms.join(' / ')}）`)
      return renderLines(lines, v.provenance)
    },
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id)
    const { supplierId, keyword } = args as any
    if (!supplierId || !keyword?.trim()) throw new ToolError('INVALID_ARGUMENT', 'supplierId 与 keyword 必填', {})

    const supplier = one<{ tenant_id: string }>('select tenant_id from suppliers where id = ?', [supplierId])
    if (!supplier) throw notFound(`供应商不存在：${supplierId}`, { supplierId })
    if (supplier.tenant_id !== identity.tenantId) {
      throw denied(`POLICY_DENIED: 供应商 ${supplierId} 不属于当前租户 ${identity.tenantId}`, { supplierId })
    }

    const expandedTerms = expandTerms(keyword)
    const found = new Map<string, ClauseRow>()
    for (const term of expandedTerms) {
      if ([...term].length >= 3) {
        for (const row of ftsSearch(supplierId, term)) found.set(row.clause_no, row)
      }
      for (const row of likeSearch(supplierId, term)) found.set(row.clause_no, row)
      if (found.size >= 5) break
    }

    const access = contractTextAccess(identity.role)
    auditFieldAccess(identity.role, 'contract.text', access, {
      tool: 'contract_search',
      userId: identity.userId,
      tenantId: identity.tenantId,
      supplierId,
    })

    if (found.size === 0) {
      return {
        data: {
          found: false,
          keyword,
          expandedTerms,
          supplierId,
          noHitReason: 'NO_CLAUSE_MATCH',
          hits: [],
        },
        provenance: [prov('suppliers', supplierId)],
      }
    }

    const hits = [...found.values()].slice(0, 5).map((row) => {
      const terms = summarizeClause(row)
      const summaryText =
        row.type === 'penalty'
          ? `违约金 ${terms.ratePermille ?? '?'}‰/日，上限 ${terms.capPercent ?? '?'}%`
          : row.type === 'freight'
            ? `运输费用由${terms.freightBearer ?? '?'}承担`
            : row.type === 'moq'
              ? `最小起订量 ${terms.minOrderQty ?? '?'} 件`
              : row.type === 'payment'
                ? `账期 ${terms.paymentDays ?? '?'} 日`
                : row.type === 'warranty'
                  ? `质保 ${terms.warrantyMonths ?? '?'} 个月`
                  : row.type
      // 注意：平台会校验「value is not lossless JSON」，值为 undefined 的属性会整体失败。
      // 因此不可见时省略 text、只写 textOmitted，而不是写成 undefined。
      const hit: Record<string, unknown> = {
        clauseNo: row.clause_no,
        supplierId: row.supplier_id,
        type: row.type,
        effectiveFrom: row.effective_from,
        summaryText,
        terms,
      }
      if (access === 'full') hit.text = row.text
      else hit.textOmitted = access
      return hit
    })

    return {
      data: {
        found: true,
        keyword,
        expandedTerms,
        supplierId,
        textAccess: access,
        hits,
      },
      provenance: [
        prov('suppliers', supplierId),
        ...hits.map((hit) => prov('contracts', hit.clauseNo, ['type', 'text', 'effective_from'])),
      ],
    }
  },
})
