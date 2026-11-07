import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { invalid } from '../errors.js'
import { resolveIdentity } from '../policy/identity.js'
import { writeAudit } from '../policy/audit.js'

/**
 * 技能落盘工具（题面任务三：技能沉淀的「写」通道）。
 *
 * 平台只负责扫描目录与解析 frontmatter（`dsh-skill-filesystem`），不会替我们校验内容质量；
 * 因此本工具承担三件事：
 *  1. **结构性校验**：name 必须是 kebab-case；description / whenToUse 必填；正文必须含「护栏」与「反例」段落
 *     ——对应题面 §6.3「触发/序列/护栏/反例」与 §8.3-5「写得像」；
 *  2. **边界安全**：只允许写 `<project>/.dsh/skills/<name>/SKILL.md`，拒绝路径穿越与非法名字；
 *  3. **留痕**：每次落盘写审计 `skill.written`（谁、什么技能、新建还是覆盖、字节数），答辩可指到行。
 *
 * 技能目录：默认 `path.resolve(process.cwd(), '.dsh/skills')`（headless 运行器会 cd 到 pec-agent），
 * 可用 `PEC_SKILLS_DIR` 覆盖（测试/隔离用）。
 */

const DEFAULT_SKILLS_DIR = (): string => resolve(process.env.PEC_SKILLS_DIR || join(process.cwd(), '.dsh', 'skills'))
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_BODY_BYTES = 12_000

export function skillsDir(): string {
  return DEFAULT_SKILLS_DIR()
}

function yamlValue(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  if (/^[A-Za-z0-9\u4e00-\u9fa5][^:#\n]*$/.test(flat) && !/^[-?]/.test(flat)) return flat
  return JSON.stringify(flat)
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${field} 必填且不能为空`)
  const text = value.replace(/\r\n/g, '\n').trim()
  if ([...text].length > max) throw invalid(`${field} 过长（上限 ${max} 字符）`)
  return text
}

/** 校验技能名 / 正文结构；返回可用于落盘的内容。导出供测试直接调用。 */
export function validateSkillDraft(draft: {
  name?: unknown
  description?: unknown
  whenToUse?: unknown
  body?: unknown
}): { name: string; description: string; whenToUse: string; body: string; hasGuardrail: boolean; hasCounterExample: boolean; content: string } {
  const name = String(draft.name ?? '').trim()
  if (!NAME_PATTERN.test(name)) throw invalid(`name 必须是 kebab-case（小写字母/数字/连字符），收到「${name}」`)
  if (name.length < 2 || name.length > 64) throw invalid('name 长度必须在 2–64 之间')
  const description = requireText(draft.description, 'description', 200)
  const whenToUse = requireText(draft.whenToUse, 'whenToUse', 300)
  const body = requireText(draft.body, 'body', MAX_BODY_BYTES)
  const hasGuardrail = /^#{1,6}\s*护栏/m.test(body) || /【?护栏】?[：:]/.test(body)
  const hasCounterExample = /^#{1,6}\s*反例/m.test(body) || /【?反例】?[：:]/.test(body)
  if (!hasGuardrail) throw invalid('正文缺少「护栏」段落（写成 “## 护栏”）：技能必须说明什么情况下停手/升级/回退（R14）')
  if (!hasCounterExample) throw invalid('正文缺少「反例」段落（写成 “## 反例”）：技能必须记录踩过的坑与下次怎么避开（题面 §6.3）')
  if ([...body].length < 100) throw invalid('正文过短（< 100 字符）：至少写清触发后调哪些工具、传什么参数、护栏与反例')
  const content = `---\nname: ${yamlValue(name)}\ndescription: ${yamlValue(description)}\nwhenToUse: ${yamlValue(whenToUse)}\n---\n\n${body}\n`
  return { name, description, whenToUse, body, hasGuardrail, hasCounterExample, content }
}

export const skillWrite = defineTool({
  name: 'skill_write',
  description:
    '把一次成功处置沉淀为技能文件 `.dsh/skills/<name>/SKILL.md`（Agent 自举通道）。工具会校验：name 必须 kebab-case、description/whenToUse 必填、正文必须含「护栏」与「反例」段落、只允许写技能目录内（防路径穿越）；已存在时需 overwrite=true。适用：一次处置成功且可复用、用户要求“沉淀/记住流程”时；不适用：普通记忆（用 memory_remember）、修改代码。',
  parameters: {
    name: {
      type: 'string',
      required: true,
      description: '技能名，kebab-case，如 delay-small-standard / stock-replenish；决定目录 .dsh/skills/<name>/',
    },
    description: { type: 'string', required: true, description: 'frontmatter description：一句话说明解决什么问题（≤200 字符）' },
    whenToUse: { type: 'string', required: true, description: 'frontmatter whenToUse：什么异常类型/金额区间/供应商状态使用，不适用于什么（≤300 字符）' },
    body: {
      type: 'string',
      required: true,
      description: '正文 Markdown：工具序列（每步调哪个工具/参数从哪来）+ “## 护栏”段 + “## 反例”段；不要复读对话',
    },
    overwrite: { type: 'boolean', description: '技能已存在时是否覆盖，默认 false（防误覆盖）' },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => {
      const v = value as any
      const d = v.data
      return [
        {
          type: 'text',
          text: [
            `技能已${d.created ? '新建' : '覆盖'}：.dsh/skills/${d.name}/SKILL.md（${d.bytes} 字节）`,
            `frontmatter：name=${d.frontmatter.name}；description=${d.frontmatter.description}`,
            `whenToUse：${d.frontmatter.whenToUse}`,
            `结构校验：护栏=${d.hasGuardrail ? '有' : '无'}；反例=${d.hasCounterExample ? '有' : '无'}`,
            '平台会在下一步扫描到该技能（catalog 暴露 name+description，模型可经 skill 工具按需加载正文）。',
          ].join('\n'),
        },
      ]
    },
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id)
    const sessionId = exec?.agent?.session?.id
    const a = args as any
    const draft = validateSkillDraft(a)
    const dir = skillsDir()
    const targetDir = resolve(dir, draft.name)
    if (!targetDir.startsWith(dir + sep)) throw invalid(`非法技能路径：${draft.name}`)
    const file = join(targetDir, 'SKILL.md')
    const existing = existsSync(file)
    if (existing && a.overwrite !== true) {
      throw invalid(`技能 ${draft.name} 已存在；确需覆盖请传 overwrite=true（覆盖会写审计）`)
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, draft.content, 'utf8')
    const bytes = Buffer.byteLength(draft.content, 'utf8')
    writeAudit({
      event: 'skill.written',
      tool: 'skill_write',
      name: draft.name,
      path: `.dsh/skills/${draft.name}/SKILL.md`,
      bytes,
      created: !existing,
      overwritten: existing,
      sessionId,
      userId: identity.userId,
      tenantId: identity.tenantId,
    })
    return {
      data: {
        name: draft.name,
        path: `.dsh/skills/${draft.name}/SKILL.md`,
        absolutePath: file,
        bytes,
        created: !existing,
        overwritten: existing,
        frontmatter: { name: draft.name, description: draft.description, whenToUse: draft.whenToUse },
        hasGuardrail: draft.hasGuardrail,
        hasCounterExample: draft.hasCounterExample,
      },
    }
  },
})
