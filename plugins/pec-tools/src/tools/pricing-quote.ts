import { defineTool } from '@deepseek-ai/dsh-tools'
import { one } from '../db.js'
import { denied, invalid, notFound } from '../errors.js'
import {
  divFixed,
  formatMoney,
  fixedToString,
  mulFixed,
  mulIntFixed,
  rescale,
  toFixed,
} from '../core/money.js'
import { prov, renderLines } from '../core/provenance.js'
import { resolveIdentity } from '../policy/identity.js'

interface SkuRow {
  id: string
  tenant_id: string
  name: string
  price_tiers: string
  moq: number
  volume: number
}

interface Tier {
  low: number
  high: number | null
  price: number
}

export function parseTiers(raw: string): Tier[] {
  const parsed = JSON.parse(raw) as Array<[number, number | null, number]>
  return parsed.map(([low, high, price]) => ({ low, high, price }))
}

/** R4：按总量落唯一区间，跨区间不拆单。 */
export function pickTier(tiers: Tier[], qty: number): Tier | undefined {
  return tiers.find((tier) => qty >= tier.low && (tier.high === null || qty <= tier.high))
}

/** 税率题面未给数据；本实现按 PEC_VAT_RATE（默认 13%）作为显式假设，并在结果里标注来源。 */
export function vatRate(): { rate: string; source: string } {
  const raw = process.env.PEC_VAT_RATE || '0.13'
  return { rate: fixedToString(toFixed(raw), 4), source: `assumption:PEC_VAT_RATE=${raw}` }
}

export const pricingQuote = defineTool({
  name: 'pricing_quote',
  description:
    '按 SKU + 数量命中阶梯价，用十进制定点计算金额与税额（纯函数，不调模型）。适用：算订单金额、审批金额、税额、阶梯单价时；不适用：算运费（用 freight.calc）、查订单履约（用 order.lookup）。',
  parameters: {
    skuId: { type: 'string', required: true, description: 'SKU 编码，如 SKU-88213' },
    qty: { type: 'integer', required: true, description: '采购数量，必须 > 0' },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => {
      const v = value as any
      const d = v.data
      return renderLines(
        [
          `报价 ${d.skuId} × ${d.qty}：命中阶梯 [${d.tier.low}, ${d.tier.high ?? '∞'}]，单价 ${d.unitPrice}`,
          `金额（DECIMAL 18,4 → HALF_UP 2 位）= ${d.amount}；税率 ${d.taxRate}（${d.taxSource}），税额 ${d.taxAmount}`,
        ],
        v.provenance,
      )
    },
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id)
    const { skuId, qty } = args as any
    if (!Number.isInteger(qty) || qty <= 0) {
      throw invalid('qty 必须是大于 0 的整数', { qty })
    }
    const row = one<SkuRow>('select id, tenant_id, name, price_tiers, moq, volume from skus where id = ?', [skuId])
    if (!row) throw notFound(`SKU 不存在：${skuId}`, { skuId })
    if (row.tenant_id !== identity.tenantId) {
      throw denied(`POLICY_DENIED: SKU ${skuId} 不属于当前租户 ${identity.tenantId}`, { skuId })
    }
    const tier = pickTier(parseTiers(row.price_tiers), qty)
    if (!tier) throw invalid(`数量 ${qty} 未落在任何阶梯价区间（区间从 ${row.moq ? 1 : 1} 起）`, { skuId, qty })

    const unitPrice = toFixed(tier.price)
    // 注意：Fixed 始终是 4 位定点；fixedToString 内部才做取整，这里不要再 rescale 一次。
    const amount = mulIntFixed(qty, unitPrice)
    const { rate, source } = vatRate()
    const tax = mulFixed(amount, toFixed(rate))
    return {
      data: {
        skuId: row.id,
        skuName: row.name,
        qty,
        tier: { low: tier.low, high: tier.high, price: fixedToString(unitPrice, 2) },
        unitPrice: fixedToString(unitPrice, 2),
        amount: fixedToString(amount, 2),
        amountReadable: formatMoney(amount),
        taxRate: fixedToString(toFixed(rate), 4),
        taxSource: source,
        taxAmount: fixedToString(tax, 2),
      },
      provenance: [prov('skus', row.id, ['price_tiers', 'moq'])],
    }
  },
})
