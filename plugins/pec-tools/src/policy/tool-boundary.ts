import type { Context } from '@deepseek-ai/cordis'
import { writeAudit } from './audit.js'
import { PEC_TOOLS } from './tool-surface.js'

/**
 * 工具能力边界说明（T10 失败归因后的产品侧修复）。
 *
 * 失败现象：当 `contract_search` 检索无命中时，模型按“通用编码助手”的习惯尝试调用
 * `bash` 搜索代码库/数据库（被工具面 restrict 拒绝：`Error: unknown tool "bash"`）。
 * 硬拦截保证了安全（没有数据泄露），但模型不知道自己的能力边界 → 产生无效工具调用、
 * 浪费步数，并在回答里给出 sqlite3/grep 命令引导用户绕过工具面取数。
 *
 * 修复：在 system prompt 里固定一段静态能力边界（与记忆注入同一机制，order 略早于记忆段），
 * 明确“只有这些工具、没有 bash/文件工具、无命中就如实说未检索到、不要引导用户绕过工具面”。
 * 该段只影响模型行为，不参与鉴权；真正的硬拦截仍在 `policy/tool-surface.ts` 的 restrict。
 */
export const TOOL_BOUNDARY_SECTION = 'pec:tool-boundary'
export const TOOL_BOUNDARY_ORDER = 10040

export function toolBoundaryText(): string {
  return [
    '<pec_tool_boundary>',
    '本会话是 PEC 采购异常处置专用 Agent，能力边界固定：',
    `1. 可用工具仅限：${PEC_TOOLS.join(' / ')}。`,
    '2. 不存在 bash / shell / read / write / grep / sqlite 等工具；调用不存在的工具会返回 unknown tool。不要尝试，也不要臆测存在其他工具。',
    '3. 所有业务数据必须通过业务工具读取；不得绕过工具面直接读表、读文件或用 shell 查询。工具检索无命中时，如实回复“未检索到”（同一事实最多换 1–2 个同义词复检，不要穷举关键词刷调用），不得编造，也不要把 sqlite3/grep 等绕过工具面的命令交给用户执行。',
    '4. 工具返回 POLICY_DENIED（跨租户）或 INVALID_ARGUMENT 时无法绕过：说明原因并转人工或改用工具面内合法路径，不要重试越界手段。',
    '</pec_tool_boundary>',
  ].join('\n')
}

export function installToolBoundary(ctx: Context): void {
  const systemPrompt = (ctx as any).get?.('systemPrompt') ?? (ctx as any).systemPrompt
  if (!systemPrompt || typeof systemPrompt.section !== 'function') {
    writeAudit({ event: 'tool-boundary.unavailable', reason: 'systemPrompt service not found' })
    return
  }
  systemPrompt.section({
    name: TOOL_BOUNDARY_SECTION,
    order: TOOL_BOUNDARY_ORDER,
    interpolate: false,
    text: () => toolBoundaryText(),
  })
  writeAudit({ event: 'tool-boundary.installed', section: TOOL_BOUNDARY_SECTION, chars: toolBoundaryText().length })
}
