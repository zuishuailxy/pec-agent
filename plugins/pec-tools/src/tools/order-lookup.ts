import { defineTool } from '@deepseek-ai/dsh-tools'
import { all, one } from '../db.js'
import { denied, invalid, notFound } from '../errors.js'
import { dayDiff } from '../core/money.js'
import { prov, renderLines, type ProvenanceRef } from '../core/provenance.js'
import { resolveIdentity } from '../policy/identity.js'
import { writeAudit } from '../policy/audit.js'
import { rememberSession } from '../memory/store.js'

interface OrderRow {
  id: string
  tenant_id: string
  supplier_id: string
  sku_id: string
  qty: number
  unit_price: number
  ordered_at: string
  promised_at: string
  delivered_at: string | null
  status: string
  freight_rate: number
  volume: number
  supplier_name: string
  risk_level: string
  blacklisted: number
  delay_days_12m: number
  sku_name: string
  safety_stock: number
  on_hand: number
  in_transit: number
  moq: number
}

const SELECT = `
  select o.id, o.tenant_id, o.supplier_id, o.sku_id, o.qty, o.unit_price,
         o.ordered_at, o.promised_at, o.delivered_at, o.status, o.freight_rate, o.volume,
         s.name as supplier_name, s.risk_level, s.blacklisted, s.delay_days_12m,
         k.name as sku_name, k.safety_stock, k.on_hand, k.in_transit, k.moq
  from orders o
  join suppliers s on s.id = o.supplier_id
  join skus k on k.id = o.sku_id
`

function mapOrder(row: OrderRow) {
  const delayDays = row.delivered_at ? dayDiff(row.promised_at, row.delivered_at) : null
  return {
    orderId: row.id,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    riskLevel: row.risk_level,
    blacklisted: Boolean(row.blacklisted),
    delayDays12m: row.delay_days_12m,
    skuId: row.sku_id,
    skuName: row.sku_name,
    qty: row.qty,
    unitPrice: row.unit_price.toFixed(2),
    orderedAt: row.ordered_at,
    promisedAt: row.promised_at,
    deliveredAt: row.delivered_at,
    status: row.status,
    freightRate: row.freight_rate.toFixed(2),
    volume: row.volume.toFixed(2),
    delayDays,
    isDelayed: row.status === 'DELAYED' || (delayDays ?? 0) > 0,
    stock: {
      onHand: row.on_hand,
      inTransit: row.in_transit,
      safetyStock: row.safety_stock,
      moq: row.moq,
      belowSafety: row.on_hand + row.in_transit < row.safety_stock,
    },
  }
}

function renderOrder(order: ReturnType<typeof mapOrder>, refs: ProvenanceRef[]): string[] {
  const stock = order.stock
  return [
    `订单 ${order.orderId}：状态 ${order.status}；供应商 ${order.supplierId} ${order.supplierName}（${order.riskLevel} 级，黑名单${order.blacklisted ? '是' : '否'}，近 12 月延迟 ${order.delayDays12m} 天）`,
    `  SKU ${order.skuId} ${order.skuName} × ${order.qty}，单价 ${order.unitPrice}；下单 ${order.orderedAt}，承诺交期 ${order.promisedAt}，实际交期 ${order.deliveredAt ?? '未交付'}`,
    `  延迟天数 ${order.delayDays ?? 'N/A'}；体积 ${order.volume}；物流单价 ${order.freightRate}`,
    `  库存：当前 ${stock.onHand} + 在途 ${stock.inTransit}，安全库存 ${stock.safetyStock}，MOQ ${stock.moq}${stock.belowSafety ? '（低于安全库存）' : ''}`,
  ]
}

/** 按订单号 / SKU / 供应商查询采购订单与履约信息（只读，按租户校验，结果带 provenance）。 */
export const orderLookup = defineTool({
  name: 'order_lookup',
  description:
    '按订单号、SKU 或供应商查询采购订单的履约信息（承诺/实际交期、延迟天数、状态、库存与在途）。适用：需要订单事实与库存事实时；不适用：算金额/税额（用 pricing.quote）、算运费（用 freight.calc）、查供应商画像（用 supplier.profile）。',
  parameters: {
    orderId: { type: 'string', description: '采购订单号，如 PO-20261013-0042' },
    skuId: { type: 'string', description: 'SKU 编码，如 SKU-88213；与 supplierId 至少给一个查询条件' },
    supplierId: { type: 'string', description: '供应商编码，如 SUP-1042' },
    tenantId: {
      type: 'string',
      description: '运行时注入的租户；模型不可自填。本实现以服务端身份为准，传错会被 guard 拒绝',
    },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => {
      const v = value as any
      const lines: string[] = []
      for (const order of v.data.orders as any[]) {
        lines.push(...renderOrder(order, v.provenance))
        lines.push('')
      }
      if (lines.length === 0) lines.push('未找到符合条件的订单。')
      return renderLines([lines.join('\n').trim()], v.provenance)
    },
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id)
    const sessionId = exec?.agent?.session?.id
    const { orderId, skuId, supplierId } = args as any
    if (!orderId && !skuId && !supplierId) {
      throw invalid('至少提供 orderId、skuId、supplierId 之一')
    }

    // 跨租户显式拒绝：先看资源是否存在、归属哪个租户（R11：不是 404）
    if (orderId) {
      const head = one<{ tenant_id: string }>('select tenant_id from orders where id = ?', [orderId])
      if (!head) throw notFound(`订单不存在：${orderId}`, { orderId })
      if (head.tenant_id !== identity.tenantId) {
        writeAudit({
          event: 'deny',
          reason: 'cross-tenant-order',
          tool: 'order_lookup',
          sessionId,
          userId: identity.userId,
          tenantId: identity.tenantId,
          resource: `orders#${orderId}`,
          ownerTenant: head.tenant_id,
        })
        throw denied(`POLICY_DENIED: 订单 ${orderId} 不属于当前租户 ${identity.tenantId}`, { orderId })
      }
    }
    if (skuId && !orderId) {
      const head = one<{ tenant_id: string }>('select tenant_id from skus where id = ?', [skuId])
      if (!head) throw notFound(`SKU 不存在：${skuId}`, { skuId })
      if (head.tenant_id !== identity.tenantId) throw denied(`POLICY_DENIED: SKU 不属于当前租户`, { skuId })
    }
    if (supplierId && !orderId) {
      const head = one<{ tenant_id: string }>('select tenant_id from suppliers where id = ?', [supplierId])
      if (!head) throw notFound(`供应商不存在：${supplierId}`, { supplierId })
      if (head.tenant_id !== identity.tenantId) throw denied(`POLICY_DENIED: 供应商不属于当前租户`, { supplierId })
    }

    const where: string[] = ['o.tenant_id = ?']
    const params: unknown[] = [identity.tenantId]
    if (orderId) {
      where.push('o.id = ?')
      params.push(orderId)
    }
    if (skuId) {
      where.push('o.sku_id = ?')
      params.push(skuId)
    }
    if (supplierId) {
      where.push('o.supplier_id = ?')
      params.push(supplierId)
    }

    const rows = all<OrderRow>(`${SELECT} where ${where.join(' and ')} order by o.id limit 50`, params)
    const orders = rows.map(mapOrder)
    const provenance: ProvenanceRef[] = []
    for (const row of rows) {
      provenance.push(
        prov('orders', row.id, ['promised_at', 'delivered_at', 'status', 'qty', 'unit_price']),
        prov('suppliers', row.supplier_id, ['risk_level', 'blacklisted', 'delay_days_12m']),
        prov('skus', row.sku_id, ['safety_stock', 'on_hand', 'in_transit', 'moq']),
      )
    }
    if (orders.length === 1 && sessionId) {
      rememberSession(identity, sessionId, {
        lastOrderId: orders[0].orderId,
        lastSupplierId: orders[0].supplierId,
        lastSkuId: orders[0].skuId,
        lastExceptionType: orders[0].isDelayed ? 'DELAY' : undefined,
      })
    }
    return { data: { orders }, provenance }
  },
})
