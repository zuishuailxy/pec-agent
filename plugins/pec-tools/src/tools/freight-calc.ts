import { defineTool } from '@deepseek-ai/dsh-tools'
import { one } from '../db.js'
import { ToolError, denied, eDivZero, notFound } from '../errors.js'
import { ceilInt, divFixed, formatMoney, fixedToString, mulIntFixed, rescale, toFixed } from '../core/money.js'
import { prov, renderLines } from '../core/provenance.js'
import { resolveIdentity } from '../policy/identity.js'

interface OrderFreightRow {
  id: string
  tenant_id: string
  qty: number
  volume: number
  freight_rate: number
}

export const freightCalc = defineTool({
  name: 'freight_calc',
  description:
    '按订单的体积与物流费单价复算计费体积、总运费与计件运费（纯函数，不调模型）。适用：复核运费、验证体积进位、算计件运费时；不适用：查订单履约（用 order.lookup）、算金额/税额（用 pricing.quote）。qty=0 时返回 E_DIV_ZERO，不返回 0。',
  parameters: {
    orderId: { type: 'string', required: true, description: '订单号，如 PO-20261013-0042' },
    qty: { type: 'integer', required: true, description: '数量；为 0 时返回 E_DIV_ZERO' },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => {
      const v = value as any
      const d = v.data
      return renderLines(
        [
          `运费复算 ${d.orderId}：体积 ${d.volume} → 计费体积 ${d.billedVolume}（向上取整），物流单价 ${d.freightRate}`,
          `总运费 = ${d.billedVolume} × ${d.freightRate} = ${d.totalFreight}；计件运费 = ${d.totalFreight} ÷ ${d.qty} = ${d.unitFreight ?? 'N/A'}`,
          d.warning ? `注意：${d.warning}` : '',
        ].filter(Boolean),
        v.provenance,
      )
    },
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id)
    const { orderId, qty } = args as any
    if (!Number.isInteger(qty) || qty < 0) throw new ToolError('INVALID_ARGUMENT', 'qty 必须是 >= 0 的整数', { qty })
    const row = one<OrderFreightRow>('select id, tenant_id, qty, volume, freight_rate from orders where id = ?', [orderId])
    if (!row) throw notFound(`订单不存在：${orderId}`, { orderId })
    if (row.tenant_id !== identity.tenantId) {
      throw denied(`POLICY_DENIED: 订单 ${orderId} 不属于当前租户 ${identity.tenantId}`, { orderId })
    }

    const volume = toFixed(row.volume)
    const billedVolume = ceilInt(volume)
    // Fixed 始终 4 位定点，格式化时才取整（避免 rescale 两次）
    const totalFreight = mulIntFixed(billedVolume, toFixed(row.freight_rate))

    let unitFreight: string | null = null
    if (qty === 0) throw eDivZero('qty = 0，不能计算计件运费（不得返回 0）')
    const unit = divFixed(totalFreight, toFixed(qty))
    unitFreight = fixedToString(unit, 2)

    return {
      data: {
        orderId: row.id,
        qty,
        orderQty: row.qty,
        volume: fixedToString(volume, 2),
        billedVolume: Number(billedVolume),
        freightRate: fixedToString(toFixed(row.freight_rate), 2),
        totalFreight: fixedToString(totalFreight, 2),
        totalFreightReadable: formatMoney(totalFreight),
        unitFreight,
        warning: qty !== row.qty ? `传入 qty=${qty} 与订单 qty=${row.qty} 不一致，计件运费按传入 qty 计算` : undefined,
      },
      provenance: [prov('orders', row.id, ['volume', 'freight_rate', 'qty'])],
    }
  },
})
