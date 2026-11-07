/**
 * golden set 批跑器（headless 逐条执行）。
 *
 * 用法（在 pec-agent/ 下）：
 *   bash eval/run.sh                 # 跑全部 12 条
 *   bash eval/run.sh --only g-01,g-09  # 只跑指定用例（调试用）
 *
 * 每条用例：
 *  - 独立目录 runs/eval/<id>/（记忆/审计按 case 隔离）；
 *  - 单轮直接 `--json`；多轮第 1 轮不带 --session-id，从 session 事件取 id，后续轮复用；
 *  - fixture 用例自动从 db/pec.db 复制并注入夹具（不改原件）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildInjectionDb } from './fixtures.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const RUNS = resolve(ROOT, 'runs/eval')

const args = process.argv.slice(2)
const onlyIndex = args.indexOf('--only')
const only = onlyIndex >= 0 ? new Set((args[onlyIndex + 1] ?? '').split(',').filter(Boolean)) : null

const cases = readFileSync(resolve(HERE, 'golden_set.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line))
  .filter((item) => !only || only.has(item.id))

let fixtureDb = null
function fixturePath() {
  if (!fixtureDb) fixtureDb = buildInjectionDb(ROOT)
  return fixtureDb
}

function readSessionId(file) {
  if (!existsSync(file)) return undefined
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (event.type === 'session' && event.sessionId) return event.sessionId
    } catch {
      /* 非 JSON 行跳过 */
    }
  }
  return undefined
}

mkdirSync(RUNS, { recursive: true })
const failures = []

for (const testCase of cases) {
  const caseDir = resolve(RUNS, testCase.id)
  rmSync(caseDir, { recursive: true, force: true })
  mkdirSync(caseDir, { recursive: true })
  const env = {
    ...process.env,
    PEC_USER_ID: testCase.user || 'U-07',
    PEC_MEMORY_PATH: resolve(caseDir, 'memory.json'),
    PEC_AUDIT_PATH: resolve(caseDir, 'audit.jsonl'),
    // 评测不得改动交付技能目录：即使模型调用 skill_write，也只写到 case 目录
    PEC_SKILLS_DIR: resolve(caseDir, 'skills'),
    ...(testCase.fixture ? { PEC_DB_PATH: fixturePath() } : {}),
  }
  let sessionId
  const turnMeta = []
  const startedAt = Date.now()
  for (const [index, prompt] of testCase.turns.entries()) {
    const turnNo = index + 1
    const turnFile = resolve(caseDir, `turn${turnNo}.jsonl`)
    const errFile = resolve(caseDir, `turn${turnNo}.err`)
    const command = ['dev/run-headless.sh', '--json']
    if (index > 0) command.push('--session-id', sessionId)
    command.push(prompt)
    const result = spawnSync(command[0], command.slice(1), {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
    })
    writeFileSync(turnFile, result.stdout ?? '')
    writeFileSync(errFile, result.stderr ?? '')
    if (index === 0) sessionId = readSessionId(turnFile)
    const ok = result.status === 0 && sessionId
    turnMeta.push({ turn: turnNo, exitCode: result.status, ms: Date.now() - startedAt })
    process.stdout.write(`  ${testCase.id} turn${turnNo} exit=${result.status}${ok ? '' : ' (FAILED)'}\n`)
    if (!ok) failures.push(`${testCase.id} turn${turnNo} exit=${result.status}`)
  }
  writeFileSync(
    resolve(caseDir, 'meta.json'),
    `${JSON.stringify({ id: testCase.id, user: testCase.user, sessionId, fixture: testCase.fixture ?? null, turns: turnMeta, durationMs: Date.now() - startedAt }, null, 2)}\n`,
  )
}

console.log(`\n批跑完成：${cases.length} 条用例${failures.length ? `，${failures.length} 个运行失败` : '，全部运行成功'}`)
if (failures.length) {
  for (const failure of failures) console.error('RUN_FAIL:', failure)
  process.exitCode = 1
}
