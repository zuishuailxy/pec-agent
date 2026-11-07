import { defineTool } from '@deepseek-ai/dsh-tools'
import { all, one } from '../db.js'
import { denied, invalid, notFound } from '../errors.js'
import { fixedToString, toFixed } from '../core/money.js'
import { prov, renderLines, type ProvenanceRef } from '../core/provenance.js'
import { resolveIdentity } from '../policy/identity.js'
import { writeAudit } from '../policy/audit.js'
import { rememberSession } from '../memory/store.js'

/**
 * 相似历史工单召回（T6）。
 *
 * 数据事实（见 analysis/data-audit.md §13-7/§13-8）：
 *  - tickets 表没有 supplier_id、没有金额字段 → 必须 join orders 派生；
 *  - 没有相似度字段 → 相似度是「规则分」，不是模型分，口径写死、可解释：
 *      已提供维度权重：异常类型 40（必选）、供应商 30、金额区间 30；
 *      similarity = round(命中权重 / 已提供维度总权重 × 100)。
 *  - 28 条工单里 16 条集中在 PO-20260917-0129 → 按 order_id 聚合展示代表工单，
 *    同时保留 totalTickets（去重前）与 sameOrderTickets（同订单同类工单数），避免被单订单淹没。
 *
 * 金额区间是「含边界」的硬口径；区间外的候选按邻近度给部分分，严格命中优先返回。
 * 所有候选强制按当前身份租户过滤；跨租户 supplier/order 显式 POLICY_DENIED 并审计（R11）。
 */

interface TicketRow {
  id: string
  order_id: string
  tenant_id: string
  exception_type: string
  action: string
  outcome: string
  minutes: number
  overridden: number
  supplier_id: string
  supplier_name: string
  amount: number
  status: string
}

const TYPE_ALIASES: Record<string, string> = {
  DELAY: 'DELAY',
  DELAYED: 'DELAY',
  延迟: 'DELAY',
  交期延迟: 'DELAY',
  延期: 'DELAY',
  逾期: 'DELAY',
  STOCK: 'STOCK',
  缺货: 'STOCK',
  库存不足: 'STOCK',
  库存: 'STOCK',
  PRICE: 'PRICE',
  价格: 'PRICE',
  价格异动: 'PRICE',
  涨价: 'PRICE',
  降价: 'PRICE',
  FREIGHT: 'FREIGHT',
  运费: 'FREIGHT',
  运费异常: 'FREIGHT',
  物流费: 'FREIGHT',
  RISK: 'RISK',
  风险: 'RISK',
  供应商风险: 'RISK',
  风险预警: 'RISK',
}

export const VALID_EXCEPTION_TYPES = ['DELAY', 'STOCK', 'PRICE', 'FREIGHT', 'RISK'] as const

export function normalizeExceptionType(input: unknown): string {
  const raw = String(input ?? '').trim()
  if (!raw) throw invalid(`exceptionType 必填，可选值：${VALID_EXCEPTION_TYPES.join(' / ')}`)
  const normalized = TYPE_ALIASES[raw.toUpperCase()] ?? TYPE_ALIASES[raw]
  if (!normalized) {
    throw invalid(`未知异常类型「${raw}」，可选值：${VALID_EXCEPTION_TYPES.join(' / ')}（支持中文别名：延迟/缺货/价格/运费/风险）`)
  }
  return normalized
}

function optionalAmount(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) throw invalid(`${name} 必须是非负数字（元）`)
  return amount
}

/** 金额到区间的距离（在区间内为 0）；用于排序与金额维度部分分。 */
function amountDistance(amount: number, min: number, max: number): number {
  if (amount < min) return min - amount
  if (amount > max) return amount - max
  return 0
}

/** 金额邻近度 0–1：区间内 1；区间外按「距离 / 参考跨度」线性衰减到 0。 */
function amountProximity(amount: number, min: number, max: number): number {
  const distance = amountDistance(amount, min, max)
  if (distance === 0) return 1
  const span = Number.isFinite(max) && max > min ? max - min : Number.isFinite(max) ? max : Math.max(min, 1)
  return Math.max(0, 1 - distance / Math.max(span, 1))
}

function amountText(value: number): string {
  return fixedToString(toFixed(value))
}

function rangeText(query: { amountMin?: string; amountMax?: string }): string {
  if (query.amountMin === undefined && query.amountMax === undefined) return '未限定金额区间'
  const min = query.amountMin ?? '0.00'
  const max = query.amountMax ?? '不限'
  return `金额区间 [${min}, ${max}]（含边界）`
}

function sortedActionText(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([action, count]) => `${action}×${count}`)
    .join(' / ')
}

export const ticketSimilar = defineTool({
  name: 'ticket_similar',
  description:
    '按异常类型 + 供应商 + 金额区间召回历史工单，返回相似度、处置动作、结论、耗时与是否人工改判（只读，按租户隔离，结果带来源）。适用：需要参考过去同类异常怎么处理、沉淀技能、验证处置口径时；不适用：查订单事实（用 order_lookup）、查合同条款（用 contract_search）、算金额/运费（用 pricing_quote / freight_calc）。历史工单只是参考，不是当前订单结论。',
  parameters: {
    exceptionType: {
      type: 'string',
      required: true,
      description: '异常类型：DELAY / STOCK / PRICE / FREIGHT / RISK（也接受中文别名：延迟/缺货/价格/运费/风险）',
    },
    orderId: {
      type: 'string',
      description: '可选：当前处理中的订单号。给定时自动派生供应商，返回订单上下文 provenance；订单必须属当前租户',
    },
    supplierId: { type: 'string', description: '可选：供应商编码，如 SUP-1050；与 orderId 派生值冲突会拒绝' },
    amountMin: { type: 'number', description: '可选：金额区间下限（元，含边界）' },
    amountMax: { type: 'number', description: '可选：金额区间上限（元，含边界）' },
    limit: { type: 'integer', description: '可选：最多返回多少个订单（去重后），默认 5，最大 20' },
    tenantId: {
      type: 'string',
      description: '运行时注入的租户；模型不可自填。本实现以服务端身份为准，传错会被 guard 拒绝',
    },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => {
      const v = value as any
      const d = v.data
      if (!d.found) {
        return renderLines(
          [
            `未召回相似历史工单（异常类型 ${d.query.exceptionType}${d.query.supplierId ? `；供应商 ${d.query.supplierId}` : ''}；${rangeText(d.query)}）。历史库中没有可复用的同类处置记录，不得编造历史动作或耗时。`,
          ],
          v.provenance,
        )
      }
      const lines: string[] = []
      lines.push(
        `召回 ${d.totalTickets} 条历史工单 / 聚合为 ${d.totalOrders} 个订单（异常类型 ${d.query.exceptionType}${
          d.query.supplierId ? `；供应商 ${d.query.supplierId}` : ''
        }；${rangeText(d.query)}）：严格匹配 ${d.strictCount} 个订单，放宽 ${d.relaxedCount} 个订单，展示 ${d.returned} 个。`,
      )
      for (const item of d.tickets as any[]) {
        const extra: string[] = []
        if (item.sameOrderTickets > 1) {
          extra.push(`同订单同类工单 ${item.sameOrderTickets} 条（${sortedActionText(item.sameOrderActionCounts)}，人工改判 ${item.sameOrderOverridden} 条）`)
        }
        if (item.relaxedOn.length > 0) extra.push(`放宽维度：${item.relaxedOn.join(' / ')}`)
        lines.push(
          `- ${item.ticketId} / 订单 ${item.orderId}（${item.supplierId} ${item.supplierName}，金额 ${item.amount}，状态 ${item.status}）：相似度 ${item.similarity}；处置 ${item.action}；结论「${item.outcome}」；耗时 ${item.minutes} 分钟；人工改判 ${item.overridden ? '是' : '否'}${
            extra.length ? `；${extra.join('；')}` : ''
          }`,
        )
      }
      lines.push(
        `历史统计：平均耗时 ${d.stats.avgMinutes} 分钟；人工改判 ${d.stats.overriddenTickets}/${d.totalTickets} 条；动作分布 ${sortedActionText(d.stats.actionCounts)}；涉及供应商 ${d.stats.supplierCount} 家。以上是历史处置参考，引用数值必须带来源。`,
      )
      return renderLines(lines, v.provenance)
    },
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id)
    const sessionId = exec?.agent?.session?.id
    const a = args as any
    const exceptionType = normalizeExceptionType(a.exceptionType)
    const amountMin = optionalAmount(a.amountMin, 'amountMin')
    const amountMax = optionalAmount(a.amountMax, 'amountMax')
    if (amountMin !== undefined && amountMax !== undefined && amountMin > amountMax) {
      throw invalid(`amountMin(${amountMin}) 不能大于 amountMax(${amountMax})`)
    }
    const limit = a.limit === undefined ? 5 : Number(a.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw invalid('limit 必须是 1–20 的整数')

    // ---- 订单上下文：给 orderId 时派生供应商，并做租户校验（跨租户 POLICY_DENIED，不是 NOT_FOUND）----
    let orderContext: Record<string, unknown> | undefined
    let supplierId: string | undefined = a.supplierId?.trim() || undefined
    if (a.orderId) {
      const order = one<{ id: string; tenant_id: string; supplier_id: string; amount: number; status: string; supplier_name: string }>(
        `select o.id, o.tenant_id, o.supplier_id, o.amount, o.status, s.name as supplier_name
           from orders o join suppliers s on s.id = o.supplier_id
          where o.id = ?`,
        [String(a.orderId)],
      )
      if (!order) throw notFound(`订单不存在：${a.orderId}`, { orderId: a.orderId })
      if (order.tenant_id !== identity.tenantId) {
        writeAudit({
          event: 'deny',
          reason: 'cross-tenant-order',
          tool: 'ticket_similar',
          sessionId,
          userId: identity.userId,
          tenantId: identity.tenantId,
          resource: `orders#${order.id}`,
          ownerTenant: order.tenant_id,
        })
        throw denied(`POLICY_DENIED: 订单 ${order.id} 不属于当前租户 ${identity.tenantId}`, { orderId: order.id })
      }
      if (supplierId && supplierId !== order.supplier_id) {
        throw invalid(`orderId ${order.id} 的供应商是 ${order.supplier_id}，与传入 supplierId ${supplierId} 不一致`)
      }
      supplierId = order.supplier_id
      orderContext = {
        orderId: order.id,
        supplierId: order.supplier_id,
        supplierName: order.supplier_name,
        amount: amountText(order.amount),
        status: order.status,
      }
    }

    if (supplierId) {
      const supplier = one<{ id: string; tenant_id: string; name: string }>(
        'select id, tenant_id, name from suppliers where id = ?',
        [supplierId],
      )
      if (!supplier) throw notFound(`供应商不存在：${supplierId}`, { supplierId })
      if (supplier.tenant_id !== identity.tenantId) {
        writeAudit({
          event: 'deny',
          reason: 'cross-tenant-supplier',
          tool: 'ticket_similar',
          sessionId,
          userId: identity.userId,
          tenantId: identity.tenantId,
          resource: `suppliers#${supplierId}`,
          ownerTenant: supplier.tenant_id,
        })
        throw denied(`POLICY_DENIED: 供应商 ${supplierId} 不属于当前租户 ${identity.tenantId}`, { supplierId })
      }
    }

    // ---- 候选：强制租户过滤 + 异常类型过滤；供应商/金额作为「召回维度」而不是硬过滤，允许放宽补位 ----
    const rows = all<TicketRow>(
      `select t.id, t.order_id, t.tenant_id, t.exception_type, t.action, t.outcome,
              t.minutes, t.overridden,
              o.supplier_id, s.name as supplier_name, o.amount, o.status
         from tickets t
         join orders o on o.id = t.order_id
         join suppliers s on s.id = o.supplier_id
        where t.tenant_id = ? and t.exception_type = ?
        order by t.id`,
      [identity.tenantId, exceptionType],
    )

    const hasAmountRange = amountMin !== undefined || amountMax !== undefined
    const min = amountMin ?? 0
    const max = amountMax ?? Number.POSITIVE_INFINITY
    const weightTotal = 40 + (supplierId ? 30 : 0) + (hasAmountRange ? 30 : 0)

    interface Scored {
      row: TicketRow
      similarity: number
      strict: boolean
      distance: number
      matchedOn: string[]
      relaxedOn: string[]
    }

    const scored: Scored[] = rows.map((row) => {
      const supplierMatched = supplierId ? row.supplier_id === supplierId : null
      const proximity = hasAmountRange ? amountProximity(row.amount, min, max) : null
      const matchedOn = ['exceptionType']
      const relaxedOn: string[] = []
      let hitWeight = 40
      if (supplierMatched === true) {
        hitWeight += 30
        matchedOn.push('supplier')
      } else if (supplierMatched === false) {
        relaxedOn.push('supplier')
      }
      if (proximity !== null) {
        hitWeight += 30 * proximity
        if (proximity === 1) matchedOn.push('amountRange')
        else relaxedOn.push('amountRange')
      }
      const similarity = Math.round((hitWeight / weightTotal) * 100)
      return {
        row,
        similarity,
        strict: relaxedOn.length === 0,
        distance: hasAmountRange ? amountDistance(row.amount, min, max) : 0,
        matchedOn,
        relaxedOn,
      }
    })

    // 严格命中优先 → 相似度降序 → 金额距离升序 → ticketId 升序（确定性排序）
    scored.sort((x, y) => y.similarity - x.similarity || x.distance - y.distance || x.row.id.localeCompare(y.row.id))

    // ---- 按 order_id 聚合：单订单 16 条工单不能让召回被淹没，代表工单 + 同订单统计 ----
    interface Group {
      representative: Scored
      tickets: Scored[]
    }
    const groups = new Map<string, Group>()
    for (const item of scored) {
      const group = groups.get(item.row.order_id)
      if (group) group.tickets.push(item)
      else groups.set(item.row.order_id, { representative: item, tickets: [item] })
    }
    const orderedGroups = [...groups.values()] // Map 保持首次插入顺序 = 排序后的顺序
    const strictCount = orderedGroups.filter((group) => group.representative.strict).length

    const actionCounts: Record<string, number> = {}
    let minutesSum = 0
    let overriddenTickets = 0
    const supplierSet = new Set<string>()
    for (const item of scored) {
      const row = item.row
      actionCounts[row.action] = (actionCounts[row.action] ?? 0) + 1
      minutesSum += row.minutes
      overriddenTickets += row.overridden ? 1 : 0
      supplierSet.add(row.supplier_id)
    }

    const provenance: ProvenanceRef[] = []
    for (const item of scored) {
      provenance.push(
        prov('tickets', item.row.id, ['exception_type', 'action', 'outcome', 'minutes', 'overridden']),
        prov('orders', item.row.order_id, ['supplier_id', 'amount', 'status']),
        prov('suppliers', item.row.supplier_id, ['name']),
      )
    }
    if (orderContext) {
      provenance.push(prov('orders', String(orderContext.orderId), ['supplier_id', 'amount', 'status']))
    }

    const tickets = orderedGroups.slice(0, limit).map((group) => {
      const row = group.representative.row
      const sameOrderActionCounts: Record<string, number> = {}
      let sameOrderOverridden = 0
      for (const item of group.tickets) {
        sameOrderActionCounts[item.row.action] = (sameOrderActionCounts[item.row.action] ?? 0) + 1
        sameOrderOverridden += item.row.overridden ? 1 : 0
      }
      return {
        ticketId: row.id,
        orderId: row.order_id,
        exceptionType: row.exception_type,
        action: row.action,
        outcome: row.outcome,
        minutes: row.minutes,
        overridden: Boolean(row.overridden),
        supplierId: row.supplier_id,
        supplierName: row.supplier_name,
        amount: amountText(row.amount),
        status: row.status,
        similarity: group.representative.similarity,
        matchedOn: group.representative.matchedOn,
        relaxedOn: group.representative.relaxedOn,
        sameOrderTickets: group.tickets.length,
        sameOrderActionCounts,
        sameOrderOverridden,
      }
    })

    // 会话记忆：下一轮注入可直接复用（R13）。只在命中时写，避免空结果污染。
    if (tickets.length > 0) {
      const top = tickets[0]
      rememberSession(identity, sessionId, {
        lastTicketId: top.ticketId,
        lastExceptionType: exceptionType,
        lastSupplierId: top.supplierId,
        ...(orderContext ? { lastOrderId: orderContext.orderId } : {}),
      })
    }

    return {
      data: {
        query: {
          exceptionType,
          ...(supplierId ? { supplierId } : {}),
          ...(amountMin !== undefined ? { amountMin: amountText(amountMin) } : {}),
          ...(amountMax !== undefined ? { amountMax: amountText(amountMax) } : {}),
          limit,
          ...(a.orderId ? { orderId: String(a.orderId) } : {}),
          tenantId: identity.tenantId,
        },
        ...(orderContext ? { orderContext } : {}),
        found: tickets.length > 0,
        ...(tickets.length === 0 ? { noHitReason: 'NO_HISTORY' } : {}),
        totalTickets: scored.length,
        totalOrders: orderedGroups.length,
        strictCount,
        relaxedCount: orderedGroups.length - strictCount,
        returned: tickets.length,
        stats: {
          avgMinutes: scored.length ? Math.round((minutesSum / scored.length) * 10) / 10 : 0,
          overriddenTickets,
          overriddenRate: scored.length ? Math.round((overriddenTickets / scored.length) * 1000) / 1000 : 0,
          actionCounts,
          supplierCount: supplierSet.size,
        },
        tickets,
      },
      provenance,
    }
  },
})
