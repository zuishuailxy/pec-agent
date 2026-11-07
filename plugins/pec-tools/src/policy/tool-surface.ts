import type { Context } from '@deepseek-ai/cordis'
import { writeAudit } from './audit.js'

/**
 * 收窄 PEC agent 的工具面：它只应看到业务工具 + catalog + skill 加载工具，
 * 不应看到 bash / read / write / grep 等内置工具（题面 R14：「不得绕过工具直接读表」）。
 *
 * 关键 API 约束（0.2.1-rc.2 实测）：
 *  - ctx.tools.restrict 存在，但**只能在 agent 作用域上下文**里调用；
 *    在插件全局 ctx 上调用会抛 "tools.restrict() requires a scoped context (agent.ctx)"。
 *  - 因此这里监听 agent/created，拿到 payload.agent，再用 agent.ctx.tools.restrict。
 *  - restrict 只过滤「继承的全局工具」，不碰该 agent 自己层注册的工具；
 *    我们的 7 个工具是插件（profile 全局层）注册的，属于继承面，所以必须写进 allow。
 */
export const PEC_TOOLS = [
  'pec_data_catalog',
  'order_lookup',
  'supplier_profile',
  'pricing_quote',
  'freight_calc',
  'contract_search',
  'ticket_similar',
  'advice_card',
  'memory_recall',
  'memory_remember',
  'memory_forget',
  // 注意：restrict 会对未知工具名抛错；新增工具实现后必须同步加到这里再重编译。
  // skill 加载工具必须保留，否则技能机制不可用
  'skill',
] as const

export function installToolSurface(ctx: Context): void {
  ;(ctx as any).on('agent/created', ({ agent }: { agent: any }) => {
    try {
      const disposer = agent?.ctx?.tools?.restrict?.({ allow: [...PEC_TOOLS] })
      if (typeof disposer !== 'function') throw new Error('restrict() returned no disposer')
      writeAudit({ event: 'tool-surface.restricted', agentId: agent?.id, allow: PEC_TOOLS })
    } catch (error) {
      // 不阻断 agent 创建，但审计里必须留下失败原因（便于答辩时说明）
      writeAudit({ event: 'tool-surface.failed', agentId: agent?.id, error: String(error) })
    }
  })
}
