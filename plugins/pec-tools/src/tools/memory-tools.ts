import { defineTool } from '@deepseek-ai/dsh-tools'
import { invalid } from '../errors.js'
import { resolveIdentity } from '../policy/identity.js'
import { writeAudit } from '../policy/audit.js'
import {
  SESSION_FIELDS,
  USER_FIELDS,
  forgetMemory,
  loadStore,
  memoryStatePath,
  recallMemory,
  rememberSession,
  rememberUser,
} from '../memory/store.js'

/**
 * 记忆工具（R13 / 题面任务二）。
 *
 *  - `memory_recall`：读两层记忆（会话 / 用户），返回 3–5 条可直接注入的相关记忆与 TTL 状态；
 *  - `memory_remember`：写白名单字段；用户显式更正（source=user_correction）覆盖并留 history；
 *  - `memory_forget`：撤销（需 confirm=true，防误删）。
 *
 * 硬约束：白名单外字段直接 `INVALID_ARGUMENT`（不静默丢字段）；键含 tenantId（跨租户不命中）；
 * 会话记忆只写当前 agent 的 sessionId（模型不能指定别人的会话）；所有写入/删除都写审计。
 */

const SESSION_TTL_DAYS = 7
const USER_TTL_DAYS = 90

type Scope = 'session' | 'user' | 'both'

function agentSessionId(exec: any): string | undefined {
  return exec?.agent?.session?.id
}

function parseScope(raw: unknown): Scope {
  const scope = String(raw ?? 'both').trim()
  if (scope !== 'session' && scope !== 'user' && scope !== 'both') {
    throw invalid(`scope 可选值：session / user / both（收到「${scope}」）`)
  }
  return scope
}

function validateWhitelist(scope: 'session' | 'user', fields: unknown): Record<string, unknown> {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw invalid('fields 必须是对象（字段名 → 值）')
  const allowed: readonly string[] = scope === 'session' ? SESSION_FIELDS : USER_FIELDS
  const keys = Object.keys(fields as Record<string, unknown>)
  if (keys.length === 0) throw invalid('fields 不能为空')
  const unknown = keys.filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw invalid(
      `fields 含白名单外字段：${unknown.join(', ')}；${scope === 'session' ? '会话' : '用户'}记忆白名单：${allowed.join(' / ')}`,
      { unknown, allowed },
    )
  }
  return fields as Record<string, unknown>
}

export const memoryRecall = defineTool({
  name: 'memory_recall',
  description:
    '读取本会话记忆与当前用户记忆（白名单字段、含 TTL 状态与用户更正 history），返回可直接复用的 3–5 条相关记忆。适用：需要回看已知订单/供应商/偏好、避免重复提问时；不适用：查订单事实（用 order_lookup）、查历史工单（用 ticket_similar）。',
  parameters: {
    scope: { type: 'string', description: '读取范围：session / user / both（默认 both）' },
    taskHint: { type: 'string', description: '可选：当前任务提示（用于挑相关条目，如订单号/供应商/品类）' },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => {
      const v = value as any
      const d = v.data
      const lines: string[] = []
      lines.push(`记忆读取（${d.scope}；租户 ${d.tenantId}；用户 ${d.userId}；会话 ${d.sessionId ?? '无'}）`)
      if (d.session) {
        lines.push(`会话记忆（${Object.keys(d.session.fields).length} 字段，过期 ${d.session.expiresAt}）：${JSON.stringify(d.session.fields)}`)
      } else {
        lines.push('会话记忆：无（或已过期/未写入）')
      }
      if (d.user) {
        lines.push(`用户记忆（${Object.keys(d.user.fields).length} 字段，过期 ${d.user.expiresAt}）：${JSON.stringify(d.user.fields)}`)
      } else {
        lines.push('用户记忆：无（或已过期/未写入）')
      }
      if (d.history.length > 0) {
        lines.push(`更正留痕：${d.history.map((h: any) => `${h.field}: ${JSON.stringify(h.previous)} → ${JSON.stringify(h.next)}（${h.source}）`).join('；')}`)
      }
      lines.push(d.injected.length > 0 ? `建议注入（${d.injected.length} 条）：\n${d.injected.map((item: string, i: number) => `  ${i + 1}. ${item}`).join('\n')}` : '建议注入：无')
      lines.push(`存储：${d.memoryPath}；TTL：会话 ${SESSION_TTL_DAYS} 天 / 用户 ${USER_TTL_DAYS} 天。`)
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id)
    const sessionId = agentSessionId(exec)
    const a = args as any
    const scope = parseScope(a.scope)
    const recalled = recallMemory(identity, sessionId, String(a.taskHint ?? ''))
    const history = (loadStore().users[`${identity.tenantId}:${identity.userId}`]?.history ?? []).slice(-5).map((entry) => ({
      at: entry.at,
      field: entry.field,
      previous: entry.previous ?? null,
      next: entry.next ?? null,
      source: entry.source,
    }))
    const data = {
      scope,
      tenantId: identity.tenantId,
      userId: identity.userId,
      sessionId: sessionId ?? null,
      session:
        scope !== 'user' && recalled.session
          ? { fields: recalled.session.fields, updatedAt: recalled.session.updatedAt, expiresAt: recalled.session.expiresAt, ttlDays: SESSION_TTL_DAYS }
          : null,
      user:
        scope !== 'session' && recalled.user
          ? { fields: recalled.user.fields, role: recalled.user.role, updatedAt: recalled.user.updatedAt, expiresAt: recalled.user.expiresAt, ttlDays: USER_TTL_DAYS }
          : null,
      history,
      injected: recalled.injected,
      injectedCount: recalled.injected.length,
      memoryPath: memoryStatePath(),
    }
    writeAudit({
      event: 'memory.recalled',
      tool: 'memory_recall',
      sessionId,
      userId: identity.userId,
      tenantId: identity.tenantId,
      scope,
      injectedCount: data.injectedCount,
    })
    return { data }
  },
})

export const memoryRemember = defineTool({
  name: 'memory_remember',
  description:
    '写入记忆白名单字段：会话记忆（lastOrderId/lastSupplierId/lastSkuId/lastExceptionType/lastTicketId/lastClauseNo/currentAction/note，≤8）或用户记忆（focusCategories/commonSuppliers/preferAction/lastOpenTicket/note，≤6）。用户显式更正用 source=user_correction（覆盖旧值并留 history）。白名单外字段会被拒绝。适用：用户明确说“记住/更正”时；不适用：自动抽取（工具已自动写会话记忆）。',
  parameters: {
    scope: { type: 'string', required: true, description: 'session 或 user' },
    fields: { type: 'object', additionalProperties: true, required: true, description: '白名单字段对象，如 {"lastOrderId":"PO-20261013-0042"} 或 {"commonSuppliers":["SUP-1042"]}' },
    source: { type: 'string', description: 'tool_inference（默认）或 user_correction（用户显式更正，优先级最高）' },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => {
      const v = value as any
      const d = v.data
      const lines = [
        `记忆已写入（${d.scope}；租户 ${d.tenantId}；用户 ${d.userId}${d.sessionId ? `；会话 ${d.sessionId}` : ''}）`,
        `字段：${JSON.stringify(d.fields)}`,
        `过期时间：${d.expiresAt}（TTL ${d.ttlDays} 天；来源 ${d.source}）`,
      ]
      if (d.history.length > 0) lines.push(`更正留痕：${d.history.map((h: any) => `${h.field}: ${JSON.stringify(h.previous)} → ${JSON.stringify(h.next)}`).join('；')}`)
      lines.push(`存储：${d.memoryPath}`)
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id)
    const sessionId = agentSessionId(exec)
    const a = args as any
    const scope = String(a.scope ?? '').trim()
    if (scope !== 'session' && scope !== 'user') throw invalid('scope 必填，可选：session / user')
    const fields = validateWhitelist(scope, a.fields)
    const source = a.source === 'user_correction' ? 'user_correction' : 'tool_inference'

    if (scope === 'session') {
      if (!sessionId) throw invalid('无法解析当前会话 id，不能写会话记忆')
      let memory
      try {
        memory = rememberSession(identity, sessionId, fields, source)
      } catch (error) {
        throw invalid(String((error as Error).message))
      }
      return {
        data: {
          scope,
          tenantId: identity.tenantId,
          userId: identity.userId,
          sessionId,
          fields: memory.fields,
          updatedAt: memory.updatedAt,
          expiresAt: memory.expiresAt,
          ttlDays: SESSION_TTL_DAYS,
          source,
          history: [],
          memoryPath: memoryStatePath(),
        },
      }
    }

    let memory
    try {
      memory = rememberUser(identity, fields, { source })
    } catch (error) {
      throw invalid(String((error as Error).message))
    }
    return {
      data: {
        scope,
        tenantId: identity.tenantId,
        userId: identity.userId,
        sessionId: sessionId ?? null,
        fields: memory.fields,
        updatedAt: memory.updatedAt,
        expiresAt: memory.expiresAt,
        ttlDays: USER_TTL_DAYS,
        source,
        history: memory.history.slice(-5).map((entry) => ({
          at: entry.at,
          field: entry.field,
          previous: entry.previous ?? null,
          next: entry.next ?? null,
          source: entry.source,
        })),
        memoryPath: memoryStatePath(),
      },
    }
  },
})

export const memoryForget = defineTool({
  name: 'memory_forget',
  description:
    '撤销记忆（会话或用户）。必须显式 confirm=true 才执行；删除写审计。适用：用户明确说“忘掉/撤销记忆”时；不适用：只是想查看记忆（用 memory_recall）。',
  parameters: {
    scope: { type: 'string', required: true, description: 'session 或 user' },
    confirm: { type: 'boolean', required: true, description: '必须显式传 true 才删除（防误删）' },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => {
      const v = value as any
      const d = v.data
      return [
        {
          type: 'text',
          text: d.deleted
            ? `已撤销${d.scope === 'session' ? '会话' : '用户'}记忆（租户 ${d.tenantId}；用户 ${d.userId}${d.sessionId ? `；会话 ${d.sessionId}` : ''}），删除已写审计。`
            : `未找到可撤销的${d.scope === 'session' ? '会话' : '用户'}记忆（可能已过期或从未写入）。`,
        },
      ]
    },
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id)
    const sessionId = agentSessionId(exec)
    const a = args as any
    const scope = String(a.scope ?? '').trim()
    if (scope !== 'session' && scope !== 'user') throw invalid('scope 必填，可选：session / user')
    if (a.confirm !== true) throw invalid('删除记忆需显式 confirm=true（防误删）')
    if (scope === 'session' && !sessionId) throw invalid('无法解析当前会话 id，不能撤销会话记忆')
    const deleted = forgetMemory(identity, scope, sessionId)
    writeAudit({
      event: 'memory.forget.called',
      tool: 'memory_forget',
      scope,
      sessionId,
      userId: identity.userId,
      tenantId: identity.tenantId,
      deleted,
    })
    return {
      data: {
        scope,
        tenantId: identity.tenantId,
        userId: identity.userId,
        sessionId: sessionId ?? null,
        deleted,
        memoryPath: memoryStatePath(),
      },
    }
  },
})
