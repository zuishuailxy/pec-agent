import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { writeAudit } from '../policy/audit.js'
import type { Identity } from '../policy/identity.js'

/**
 * 两层记忆存储（R13）：
 *  - Session Memory：一次会话/一个工单，≤ 8 个白名单字段，会话关闭后 7 天过期；
 *  - User Memory：一个用户跨会话，≤ 6 个白名单字段，默认 90 天，可撤销；
 *  - 键都含 tenantId，跨租户读写一律拒绝/不命中；
 *  - 用户显式更正优先于工具推断，覆盖时保留被覆盖值（history）。
 *
 * 存储文件默认 ./memory/store.json（可用 PEC_MEMORY_PATH 覆盖，评测时按场景隔离）。
 */

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const USER_TTL_MS = 90 * 24 * 60 * 60 * 1000
const MAX_SESSION_FIELDS = 8
const MAX_USER_FIELDS = 6

export const SESSION_FIELDS = [
  'lastOrderId',
  'lastSupplierId',
  'lastSkuId',
  'lastExceptionType',
  'lastTicketId',
  // CR#1：物流商记忆（替代从未被任何工具写入的 lastClauseNo，白名单保持 ≤8，不突破题面表 5-1 上限）
  'lastLogisticsProvider',
  'currentAction',
  'note',
] as const

export const USER_FIELDS = [
  'focusCategories',
  'commonSuppliers',
  'preferAction',
  'lastOpenTicket',
  'note',
] as const

export type SessionField = (typeof SESSION_FIELDS)[number]
export type UserField = (typeof USER_FIELDS)[number]

export interface SessionMemory {
  tenantId: string
  userId: string
  sessionId: string
  fields: Partial<Record<SessionField, unknown>>
  updatedAt: string
  expiresAt: string
}

export interface UserMemory {
  tenantId: string
  userId: string
  role: string
  fields: Partial<Record<UserField, unknown>>
  /** 用户显式更正/覆盖的历史（最多 10 条），用于「留痕」与冲突解释。 */
  history: Array<{ at: string; field: string; previous: unknown; next: unknown; source: string }>
  updatedAt: string
  expiresAt: string
}

interface Store {
  version: 1
  sessions: Record<string, SessionMemory>
  users: Record<string, UserMemory>
}

function memoryPath(): string {
  return resolve(process.env.PEC_MEMORY_PATH || './memory/store.json')
}

export function emptyStore(): Store {
  return { version: 1, sessions: {}, users: {} }
}

export function loadStore(): Store {
  const path = memoryPath()
  if (!existsSync(path)) return emptyStore()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Store>
    return {
      version: 1,
      sessions: parsed.sessions ?? {},
      users: parsed.users ?? {},
    }
  } catch (error) {
    writeAudit({ event: 'memory.corrupt', path, error: String(error) })
    return emptyStore()
  }
}

export function saveStore(store: Store): void {
  const path = memoryPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

function isExpired(expiresAt: string, now = Date.now()): boolean {
  const at = Date.parse(expiresAt)
  return Number.isFinite(at) ? at <= now : true
}

export function sessionKey(identity: Identity, sessionId: string | undefined): string {
  return `${identity.tenantId}:${identity.userId}:${sessionId || 'default'}`
}

export function userKey(identity: Identity): string {
  return `${identity.tenantId}:${identity.userId}`
}

function nowIso(): string {
  return new Date().toISOString()
}

function expire(iso: string, ttl: number): string {
  return new Date(Date.now() + ttl).toISOString()
}

/** 只保留白名单字段；超出的字段直接忽略（并留审计）。 */
function pickSessionFields(patch: Record<string, unknown>): Partial<Record<SessionField, unknown>> {
  const picked: Partial<Record<SessionField, unknown>> = {}
  for (const [key, value] of Object.entries(patch)) {
    if ((SESSION_FIELDS as readonly string[]).includes(key) && value !== undefined) {
      ;(picked as Record<string, unknown>)[key] = value
    }
  }
  return picked
}

function pickUserFields(patch: Record<string, unknown>): Partial<Record<UserField, unknown>> {
  const picked: Partial<Record<UserField, unknown>> = {}
  for (const [key, value] of Object.entries(patch)) {
    if ((USER_FIELDS as readonly string[]).includes(key) && value !== undefined) {
      ;(picked as Record<string, unknown>)[key] = value
    }
  }
  return picked
}

export function rememberSession(
  identity: Identity,
  sessionId: string | undefined,
  patch: Record<string, unknown>,
  source: 'tool_inference' | 'user_correction' = 'tool_inference',
): SessionMemory {
  const store = loadStore()
  const key = sessionKey(identity, sessionId)
  const current = store.sessions[key]
  const fields = { ...(current?.fields ?? {}), ...pickSessionFields(patch) }
  const fieldCount = Object.keys(fields).length
  if (fieldCount > MAX_SESSION_FIELDS) {
    throw new Error(`INVALID_ARGUMENT: 会话记忆字段超过 ${MAX_SESSION_FIELDS} 个上限`)
  }
  const next: SessionMemory = {
    tenantId: identity.tenantId,
    userId: identity.userId,
    sessionId: sessionId || 'default',
    fields,
    updatedAt: nowIso(),
    expiresAt: expire('', SESSION_TTL_MS),
  }
  store.sessions[key] = next
  saveStore(store)
  writeAudit({
    event: 'memory.session.updated',
    key,
    fields: Object.keys(patch).filter((key) => (SESSION_FIELDS as readonly string[]).includes(key)),
    source,
  })
  return next
}

function mergeUserField(field: UserField, previous: unknown, next: unknown, source: string): unknown {
  if (field === 'commonSuppliers' || field === 'focusCategories') {
    const mergeList = (a: unknown, b: unknown): string[] => {
      const list = [...(Array.isArray(a) ? (a as string[]) : []), ...(Array.isArray(b) ? (b as string[]) : [])]
      return [...new Set(list.filter((item) => typeof item === 'string'))].slice(0, 5)
    }
    return mergeList(previous, next)
  }
  if (field === 'preferAction') {
    const before = (previous ?? {}) as Record<string, number>
    const delta = (next ?? {}) as Record<string, number>
    const merged: Record<string, number> = { ...before }
    for (const [action, count] of Object.entries(delta)) {
      merged[action] = (merged[action] ?? 0) + (Number(count) || 1)
    }
    return merged
  }
  // 用户显式更正一律以用户为准；工具推断保留已有值（较新者优先由 source 决定）。
  if (source === 'user_correction') return next
  return previous ?? next
}

export function rememberUser(
  identity: Identity,
  patch: Record<string, unknown>,
  options: { source?: 'tool_inference' | 'user_correction'; conflict?: boolean } = {},
): UserMemory {
  const source = options.source ?? 'tool_inference'
  const store = loadStore()
  const key = userKey(identity)
  const current = store.users[key]
  const incoming = pickUserFields(patch)
  const fields: Partial<Record<UserField, unknown>> = { ...(current?.fields ?? {}) }
  const history = [...(current?.history ?? [])]
  for (const [field, value] of Object.entries(incoming) as Array<[UserField, unknown]>) {
    const previous = fields[field]
    const merged = mergeUserField(field, previous, value, source)
    if (JSON.stringify(previous) !== JSON.stringify(merged)) {
      history.push({ at: nowIso(), field, previous, next: merged, source })
      writeAudit({ event: 'memory.user.updated', key, field, previous, next: merged, source })
    }
    fields[field] = merged
  }
  if (Object.keys(fields).length > MAX_USER_FIELDS) {
    throw new Error(`INVALID_ARGUMENT: 用户记忆字段超过 ${MAX_USER_FIELDS} 个上限`)
  }
  const next: UserMemory = {
    tenantId: identity.tenantId,
    userId: identity.userId,
    role: identity.role,
    fields,
    history: history.slice(-10),
    updatedAt: nowIso(),
    expiresAt: expire('', USER_TTL_MS),
  }
  store.users[key] = next
  saveStore(store)
  return next
}

export interface RecalledMemory {
  session?: Omit<SessionMemory, 'fields'> & { fields: Partial<Record<SessionField, unknown>> }
  user?: Omit<UserMemory, 'fields' | 'history'> & { fields: Partial<Record<UserField, unknown>> }
  injected: string[]
}

/** 相关记忆挑选：优先当前工单/供应商/品类，最多 5 条（不整包塞回上下文）。 */
export function recallMemory(identity: Identity, sessionId: string | undefined, taskHint = ''): RecalledMemory {
  const store = loadStore()
  const skey = sessionKey(identity, sessionId)
  const ukey = userKey(identity)
  const session = store.sessions[skey]
  const user = store.users[ukey]
  const validSession = session && !isExpired(session.expiresAt) ? session : undefined
  const validUser = user && !isExpired(user.expiresAt) ? user : undefined
  if (session && !validSession) writeAudit({ event: 'memory.expired', scope: 'session', key: skey })
  if (user && !validUser) writeAudit({ event: 'memory.expired', scope: 'user', key: ukey })

  const injected: string[] = []
  if (validSession) {
    for (const field of SESSION_FIELDS) {
      const value = validSession.fields[field]
      if (value !== undefined && injected.length < 4) injected.push(`会话记忆.${field}=${JSON.stringify(value)}`)
    }
  }
  if (validUser) {
    const hint = taskHint.toLowerCase()
    const focus = (validUser.fields.focusCategories as string[] | undefined) ?? []
    const suppliers = (validUser.fields.commonSuppliers as string[] | undefined) ?? []
    for (const supplier of suppliers) {
      if (injected.length < 5 && (hint.includes(supplier.toLowerCase()) || hint.length === 0)) {
        injected.push(`用户偏好.常用供应商=${supplier}`)
      }
    }
    for (const category of focus) {
      if (injected.length < 5 && (hint.includes(category) || hint.length === 0)) {
        injected.push(`用户偏好.关注品类=${category}`)
      }
    }
    if (validUser.fields.preferAction && injected.length < 5) {
      injected.push(`用户偏好.历史处置动作=${JSON.stringify(validUser.fields.preferAction)}`)
    }
    if (validUser.fields.lastOpenTicket && injected.length < 5) {
      injected.push(`用户偏好.上次工单=${validUser.fields.lastOpenTicket}`)
    }
  }
  return {
    session: validSession
      ? {
          tenantId: validSession.tenantId,
          userId: validSession.userId,
          sessionId: validSession.sessionId,
          fields: validSession.fields,
          updatedAt: validSession.updatedAt,
          expiresAt: validSession.expiresAt,
        }
      : undefined,
    user: validUser
      ? {
          tenantId: validUser.tenantId,
          userId: validUser.userId,
          role: validUser.role,
          fields: validUser.fields,
          updatedAt: validUser.updatedAt,
          expiresAt: validUser.expiresAt,
        }
      : undefined,
    injected: injected.slice(0, 5),
  }
}

export function forgetMemory(identity: Identity, scope: 'session' | 'user', sessionId?: string): boolean {
  const store = loadStore()
  const key = scope === 'session' ? sessionKey(identity, sessionId) : userKey(identity)
  const target = scope === 'session' ? store.sessions : store.users
  if (!(key in target)) return false
  delete target[key]
  saveStore(store)
  writeAudit({ event: 'memory.forgotten', scope, key, userId: identity.userId, tenantId: identity.tenantId })
  return true
}

export function memoryStatePath(): string {
  return memoryPath()
}
