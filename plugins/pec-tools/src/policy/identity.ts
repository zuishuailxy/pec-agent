import { one } from '../db.js'

/**
 * 可信身份适配层。
 *
 * 题面假设 DSH 由 Session 注入 tenantId / userId / role；本仓库运行的开源 DSH
 * 没有这些字段，因此这里用「进程级可信输入」代替：
 *   1) PEC_USER_ID 环境变量（推荐，评测 / 演示用）；
 *   2) 缺省回落到 U-07（T-001 采购员，题面记忆示例中的用户）；
 *   3) 身份只从 users 表解析，绝不从模型传入的工具参数里取。
 *
 * 键包含 tenantId：后续记忆/审计都必须用 (tenantId, userId) 作为隔离键。
 */
export interface Identity {
  userId: string
  tenantId: string
  role: string
}

interface UserRow {
  id: string
  tenant_id: string
  role: string
}

let cached: Identity | undefined

export function resolveIdentity(sessionId?: string): Identity {
  if (cached) return cached
  const candidates: string[] = []
  if (process.env.PEC_USER_ID?.trim()) candidates.push(process.env.PEC_USER_ID.trim())
  candidates.push('U-07')
  for (const userId of candidates) {
    const row = one<UserRow>('select id, tenant_id, role from users where id = ?', [userId])
    if (row) {
      cached = { userId: row.id, tenantId: row.tenant_id, role: row.role }
      return cached
    }
  }
  const row = one<UserRow>('select id, tenant_id, role from users order by id limit 1')
  if (!row) throw new Error('PEC_IDENTITY_UNAVAILABLE: users 表为空或不可读')
  cached = { userId: row.id, tenantId: row.tenant_id, role: row.role }
  return cached
}

/** 测试用：清空缓存（切换身份/租户）。 */
export function resetIdentity(): void {
  cached = undefined
}
