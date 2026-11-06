import { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolError } from '../errors.js'

const notImplemented = (name: string) => {
  throw new ToolError('NOT_IMPLEMENTED', `${name} 尚未实现，请补全 execute`)
}

/**
 * 相似历史工单召回（第六个业务工具）。本地接线阶段先保留桩，
 * 第一天实现：按异常类型 + 供应商 + 金额区间召回，返回相似度/处置动作/耗时/是否人工改判。
 */
export const ticketSimilar = defineTool({
  name: 'ticket_similar',
  description:
    '按异常类型与供应商召回相似历史工单，返回处置动作、结论、耗时与相似度。适用：需要参考历史处置经验时；不适用：查订单履约（用 order_lookup）、查合同条款（用 contract_search）。',
  parameters: {
    exceptionType: { type: 'string', required: true, description: 'DELAY / STOCK / PRICE / FREIGHT / RISK' },
    supplierId: { type: 'string', description: '可选的供应商过滤' },
    amountMax: { type: 'number', description: '可选：金额上限（元）' },
  },
  output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: '' }] },
  async execute() {
    return notImplemented('ticket_similar') as never
  },
})
