import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** 审计落盘：拒绝、脱敏、记忆覆盖、技能落盘都写同一条 JSONL（R11「拒绝也留痕」）。 */
export function auditPath(): string {
  return resolve(process.env.PEC_AUDIT_PATH || './runs/audit.jsonl')
}

export interface AuditEntry {
  event: string
  [key: string]: unknown
}

export function writeAudit(entry: AuditEntry): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
  try {
    const target = auditPath()
    mkdirSync(dirname(target), { recursive: true })
    appendFileSync(target, `${line}\n`)
  } catch {
    // 审计失败不影响业务；调用方已经把拒绝/脱敏结果返回给模型。
  }
}
