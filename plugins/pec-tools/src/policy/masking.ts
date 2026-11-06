import { writeAudit } from './audit.js'

/**
 * 角色 × 资源权限矩阵（题面表 2-2）+ 字段级脱敏。
 *
 * 题面两处口径冲突，这里显式记录取舍（design.md / CHANGELOG 同款）：
 *  1) 表 2-2 的「○ 只读」没有说是否脱敏；题面正文又要求「供应商联系人按角色脱敏」。
 *     本实现按更安全的一侧：非 ● 角色一律返回掩码，并写审计。
 *  2) 表 2-2 把「成本价」列为资源，但数据里没有 cost_price 字段；本实现保留策略位，
 *     实际只对 contacts / 合同原文 生效，不伪造成本价数据。
 */
export type Role = 'admin' | 'buyer' | 'manager' | 'finance' | 'risk' | 'auditor'
export type Access = 'full' | 'masked' | 'none'

export interface RolePolicy {
  orders: Access
  costPrice: Access
  supplierContacts: Access
  contractText: Access
  auditLog: Access
}

export const ROLE_POLICY: Record<Role, RolePolicy> = {
  //            订单    成本价   联系人  合同原文 审计
  admin:   { orders: 'full', costPrice: 'full',   supplierContacts: 'full',   contractText: 'full',   auditLog: 'full' },
  buyer:   { orders: 'full', costPrice: 'masked', supplierContacts: 'masked', contractText: 'none',   auditLog: 'none' },
  manager: { orders: 'full', costPrice: 'full',   supplierContacts: 'masked', contractText: 'none',   auditLog: 'none' },
  finance: { orders: 'full', costPrice: 'full',   supplierContacts: 'full',   contractText: 'full',   auditLog: 'none' },
  risk:    { orders: 'full', costPrice: 'masked', supplierContacts: 'full',   contractText: 'masked', auditLog: 'none' },
  auditor: { orders: 'full', costPrice: 'masked', supplierContacts: 'masked', contractText: 'none',   auditLog: 'full' },
}

export function policyFor(role: string): RolePolicy {
  return ROLE_POLICY[(role as Role)] ?? ROLE_POLICY.buyer
}

/** 手机号掩码：保留前 3 后 4，例如 138****8732。 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 8) return '***'
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`
}

/** 姓名掩码：保留姓，名用 *，例如 张静 → 张*。 */
export function maskName(name: string): string {
  const chars = [...name]
  if (chars.length <= 1) return '*'
  return `${chars[0]}${'*'.repeat(chars.length - 1)}`
}

export interface MaskedContact {
  name: string
  phone: string
  masked: boolean
}

export function maskContacts(
  role: string,
  contacts: Array<{ name: string; phone: string }>,
  context: Record<string, unknown>,
): MaskedContact[] {
  const access = policyFor(role).supplierContacts
  if (access === 'full') {
    return contacts.map((contact) => ({ ...contact, masked: false }))
  }
  if (access === 'none') {
    writeAudit({ event: 'field-denied', field: 'supplier.contacts', reason: 'role-none', role, ...context })
    return []
  }
  writeAudit({ event: 'field-masked', field: 'supplier.contacts', reason: 'role-masked', role, ...context })
  return contacts.map((contact) => ({
    name: maskName(contact.name),
    phone: maskPhone(contact.phone),
    masked: true,
  }))
}

/**
 * 合同原文出口：
 *  - full   → 原文
 *  - masked → 只给结构化摘要（费率/上限/期限），不给原文
 *  - none   → 只给条款号与类型，摘要也不给
 * 摘要由 contract.search 从原文确定性抽取，不属于「原文」。
 */
export function contractTextAccess(role: string): Access {
  return policyFor(role).contractText
}

export function auditFieldAccess(role: string, field: string, access: Access, context: Record<string, unknown>): void {
  if (access === 'full') return
  writeAudit({
    event: access === 'none' ? 'field-denied' : 'field-masked',
    field,
    role,
    reason: `role-${access}`,
    ...context,
  })
}
