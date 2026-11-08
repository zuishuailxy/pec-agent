import type { Context } from '@deepseek-ai/cordis'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveIdentity, type Identity } from './identity.js'

const DEFAULT_AUDIT = process.env.PEC_AUDIT_PATH || './runs/audit.jsonl'

/**
 * 调用前的统一策略守卫（0.2.1 的 guard 是同步单参：返回字符串即拒绝，返回 undefined 放行）。
 *
 * 职责：
 *  - 身份只来自 resolveIdentity()（进程可信输入 / users 表），绝不读模型可传的 role/userId；
 *  - 模型若显式传 tenantId 且与身份不符 → POLICY_DENIED 并留痕（防伪造）；
 *  - 拒绝不静默：写 runs/audit.jsonl，答辩时可直接指到行。
 *
 * 资源级租户校验（order/supplier/sku 的真实 tenant_id）在工具执行体内做，
 * 因为那需要先取到数据行；本 guard 只拦参数层的伪造。
 */
/**
 * 参数层租户伪造判定（纯函数，可单测）：模型显式传的 tenantId 与身份租户不一致 → POLICY_DENIED。
 * 返回 undefined 表示放行。资源级租户校验不在这里（需要先取数据行）。
 */
export function tenantForgeryDecision(args: Record<string, unknown>, identity: Identity): string | undefined {
  const argTenant = typeof args.tenantId === 'string' && args.tenantId.trim() ? args.tenantId.trim() : undefined
  if (argTenant && argTenant !== identity.tenantId) {
    return `POLICY_DENIED: 跨租户访问被拒绝（${identity.tenantId} 不能访问 ${argTenant}）`
  }
  return undefined
}

export function installGuard(ctx: Context, auditPath = DEFAULT_AUDIT) {
  const audit = (entry: Record<string, unknown>) => {
    try {
      mkdirSync(dirname(auditPath), { recursive: true })
      appendFileSync(auditPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
    } catch {
      /* 审计失败不阻塞业务，但工具自身仍会返回 POLICY_DENIED */
    }
  }

  ctx.tools.guard((exec: any) => {
    let identity
    try {
      identity = resolveIdentity(exec?.agent?.session?.id)
    } catch (error) {
      audit({
        event: 'deny',
        reason: 'identity-unavailable',
        tool: exec?.name,
        callId: exec?.callId,
        sessionId: exec?.agent?.session?.id,
        error: String(error),
      })
      return 'POLICY_DENIED: 无法解析调用者身份'
    }

    const args = (exec?.arguments ?? {}) as Record<string, unknown>
    const decision = tenantForgeryDecision(args, identity)
    if (decision) {
      audit({
        event: 'deny',
        reason: 'cross-tenant-argument',
        tool: exec?.name,
        callId: exec?.callId,
        sessionId: exec?.agent?.session?.id,
        userId: identity.userId,
        tenantId: identity.tenantId,
        argTenant: args.tenantId,
      })
      return decision
    }

    // 字段级越权不在这里拒绝，而是由工具返回脱敏值；审计由工具写同一条 audit.jsonl。
    return undefined
  })
}
