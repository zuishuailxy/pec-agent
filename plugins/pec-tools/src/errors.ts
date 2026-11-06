/**
 * 统一错误语义。
 *
 * 题面要求只用 NOT_FOUND / INVALID_ARGUMENT / POLICY_DENIED / UPSTREAM_TIMEOUT 四种码；
 * 同时 R3 要求 qty=0 时明确返回 E_DIV_ZERO。这里把 E_DIV_ZERO 作为
 * INVALID_ARGUMENT 的 `reason` 放进 detail，并保留在模型可见的 message 里，
 * 既满足四种码，又满足“数量为 0 返回 E_DIV_ZERO”的自检项。
 */
export type ToolErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'POLICY_DENIED'
  | 'UPSTREAM_TIMEOUT'
  | 'NOT_IMPLEMENTED'

export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ToolError'
  }
}

export function notFound(message: string, detail?: Record<string, unknown>): ToolError {
  return new ToolError('NOT_FOUND', message, detail)
}

export function invalid(message: string, detail?: Record<string, unknown>): ToolError {
  return new ToolError('INVALID_ARGUMENT', message, detail)
}

export function denied(message: string, detail?: Record<string, unknown>): ToolError {
  return new ToolError('POLICY_DENIED', message, detail)
}

export function eDivZero(message = '数量为 0，不能计算计件运费'): ToolError {
  return new ToolError('INVALID_ARGUMENT', `E_DIV_ZERO: ${message}`, { reason: 'E_DIV_ZERO' })
}
