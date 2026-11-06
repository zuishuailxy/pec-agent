/** 溯源：每个工具返回的所有业务数值/条款都必须能指回表 + 行 id。 */

export type ProvenanceTable = 'orders' | 'suppliers' | 'skus' | 'contracts' | 'tickets' | 'users'

export interface ProvenanceRef {
  table: ProvenanceTable
  rowId: string
  /** 该行里被引用的字段，便于引用可溯率逐项核对。 */
  fields?: string[]
}

export function prov(table: ProvenanceTable, rowId: string, fields?: string[]): ProvenanceRef {
  return fields?.length ? { table, rowId, fields } : { table, rowId }
}

/** 模型可见的来源标记；render 必须把它渲染出来，否则模型无法引用。 */
export function sourceTag(ref: ProvenanceRef): string {
  return `[来源: ${ref.table}#${ref.rowId}]`
}

export function renderSources(refs: ProvenanceRef[]): string {
  const unique = new Map<string, ProvenanceRef>()
  for (const ref of refs) unique.set(`${ref.table}#${ref.rowId}`, ref)
  return [...unique.values()].map(sourceTag).join(' ')
}

/** 统一 render 文本：每行正文后附来源，保证「引用可溯」可被模型照抄。 */
export function renderLines(lines: string[], refs: ProvenanceRef[]): { type: 'text'; text: string }[] {
  const body = lines.join('\n')
  const sources = renderSources(refs)
  return [{ type: 'text', text: sources ? `${body}\n${sources}` : body }]
}
