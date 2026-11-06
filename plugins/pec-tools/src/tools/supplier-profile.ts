import { defineTool } from '@deepseek-ai/dsh-tools'
import { one } from '../db.js'
import { denied, notFound } from '../errors.js'
import { prov, renderLines } from '../core/provenance.js'
import { resolveIdentity } from '../policy/identity.js'
import { maskContacts, policyFor } from '../policy/masking.js'
import { writeAudit } from '../policy/audit.js'

interface SupplierRow {
  id: string
  tenant_id: string
  name: string
  risk_level: string
  blacklisted: number
  delay_days_12m: number
  contacts: string
}

const LEVEL_POINTS: Record<string, number> = { A: 0, B: 5, C: 10, D: 15 }

/**
 * R9 风险分（题面只给约束、数据无 risk_score 字段，公式为本实现自定口径，已写进 design.md）：
 *  - 黑名单 → 100；
 *  - 近 12 月延迟 > 10 天 → min(100, 70 + min(30, 延迟天数 - 10))；
 *  - 其它 → min(69, 20 + 4×延迟天数 + 等级分)。
 */
export function riskScore(row: { blacklisted: number; delay_days_12m: number; risk_level: string }): number {
  if (row.blacklisted) return 100
  const delay = row.delay_days_12m
  if (delay > 10) return Math.min(100, 70 + Math.min(30, delay - 10))
  return Math.min(69, 20 + 4 * delay + (LEVEL_POINTS[row.risk_level] ?? 0))
}

export const supplierProfile = defineTool({
  name: 'supplier_profile',
  description:
    '查询供应商画像：等级、黑名单、近 12 月延迟天数、风险分、预警联系人。适用：评估供应商风险与黑名单状态时；不适用：查订单履约（用 order.lookup）、算金额（用 pricing.quote）。联系人按调用者角色脱敏。',
  parameters: {
    supplierId: { type: 'string', required: true, description: '供应商编码，如 SUP-1042' },
    tenantId: { type: 'string', description: '运行时注入的租户；模型不可自填' },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => {
      const v = value as any
      const s = v.data
      const lines = [
        `供应商 ${s.supplierId} ${s.supplierName}：${s.riskLevel} 级，风险分 ${s.riskScore}，黑名单${s.blacklisted ? '是' : '否'}，近 12 月延迟 ${s.delayDays12m} 天`,
        `风险口径：${s.riskScoreRule}`,
        `预警联系人（${s.contactsAccess === 'full' ? '全量' : s.contactsAccess === 'masked' ? '已脱敏' : '不可见'}）：${
          s.contacts.length ? s.contacts.map((c: any) => `${c.name} ${c.phone}`).join('；') : '无'
        }`,
      ]
      return renderLines(lines, v.provenance)
    },
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id)
    const { supplierId } = args as any
    const row = one<SupplierRow>(
      'select id, tenant_id, name, risk_level, blacklisted, delay_days_12m, contacts from suppliers where id = ?',
      [supplierId],
    )
    if (!row) throw notFound(`供应商不存在：${supplierId}`, { supplierId })
    if (row.tenant_id !== identity.tenantId) {
      writeAudit({
        event: 'deny',
        reason: 'cross-tenant-supplier',
        tool: 'supplier_profile',
        userId: identity.userId,
        tenantId: identity.tenantId,
        resource: `suppliers#${supplierId}`,
        ownerTenant: row.tenant_id,
      })
      throw denied(`POLICY_DENIED: 供应商 ${supplierId} 不属于当前租户 ${identity.tenantId}`, { supplierId })
    }

    const access = policyFor(identity.role).supplierContacts
    const contacts = maskContacts(identity.role, JSON.parse(row.contacts), {
      tool: 'supplier_profile',
      userId: identity.userId,
      tenantId: identity.tenantId,
      resource: `suppliers#${supplierId}`,
    })
    const data = {
      supplierId: row.id,
      supplierName: row.name,
      riskLevel: row.risk_level,
      blacklisted: Boolean(row.blacklisted),
      delayDays12m: row.delay_days_12m,
      riskScore: riskScore(row),
      riskScoreRule: 'blacklist=100；delay>10 → 70+min(30,delay-10)；else 20+4×delay+level(A0/B5/C10/D15)（自定口径，题面无字段）',
      contactsAccess: access,
      contacts,
    }
    return {
      data,
      provenance: [prov('suppliers', row.id, ['risk_level', 'blacklisted', 'delay_days_12m', 'contacts'])],
    }
  },
})
