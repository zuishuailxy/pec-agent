import { defineTool } from '@deepseek-ai/dsh-tools'
import { all } from '../db.js'

/** 完整示例：带 schema、provenance、错误语义与 render。候选人可照此模式实现其余工具。 */
export const catalogTool = defineTool({
  name: 'pec_data_catalog',
  description: '列出当前数据集包含的表、行数与字段名。用于开工自检与排查；不返回业务数据。',
  parameters: {
    table: { type: 'string', description: '可选：只看某张表' },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, v: any) => [{
      type: 'text',
      text: ((v as any).data?.tables ?? (v as any).tables ?? []).map((t: any) => `${t.name}  ${t.rows} 行  (${t.columns.join(', ')})`).join('\n'),
    }],
  },
  async execute(args, exec) {
    const wanted = args.table?.trim()
    const tables = ['suppliers', 'skus', 'orders', 'contracts', 'tickets', 'users']
      .filter(t => !wanted || t === wanted)
      .map(t => ({
        name: t,
        rows: all<{ n: number }>(`select count(*) as n from ${t}`)[0].n,
        columns: all<{ name: string }>(`pragma table_info(${t})`).map(c => c.name),
      }))
    return { data: { tables }, provenance: [{ table: 'orders' as const, rowId: 'catalog' }] }
  },
})
