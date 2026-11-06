import type { Context } from '@deepseek-ai/cordis'
import { installGuard } from './policy/guard.js'
import { installToolSurface } from './policy/tool-surface.js'
import { catalogTool } from './tools/catalog.js'
import { orderLookup, supplierProfile, pricingQuote, freightCalc, contractSearch, ticketSimilar } from './tools/business.js'

export const name = '@pec/pec-tools'

// cordis 4.x：访问 ctx.tools 前必须声明依赖服务，否则 "cannot get property tools without inject"。
export const inject = ['tools']

export function apply(ctx: Context) {
  for (const tool of [catalogTool, orderLookup, supplierProfile, pricingQuote, freightCalc, contractSearch, ticketSimilar]) {
    ctx.tools.register(tool)
  }
  installGuard(ctx)
  installToolSurface(ctx)
}
