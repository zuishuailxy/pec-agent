#!/bin/sh
# 记忆演示（T3 验收脚本）：两轮 headless，证明「第 2 轮不再重复询问订单号」且注入被审计。
#
# 用法：cd pec-agent && ./dev/demo-memory.sh
# 说明：使用独立记忆/审计文件（runs/ 下），不污染 memory/store.json；自动校验，失败退出码非 0。
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
RUNS="$ROOT/runs"
mkdir -p "$RUNS"
STORE="$RUNS/demo-memory-store.json"
AUDIT="$RUNS/demo-memory-audit.jsonl"
TURN1="$RUNS/demo-memory-turn1.jsonl"
TURN2="$RUNS/demo-memory-turn2.jsonl"
rm -f "$STORE" "$AUDIT" "$TURN1" "$TURN2"
export PEC_MEMORY_PATH="$STORE"
export PEC_AUDIT_PATH="$AUDIT"

echo ">>> 第 1 轮：查订单（order_lookup 会自动写会话记忆；不要求模型调用 memory_remember，避免依赖模型行为）"
./dev/run-headless.sh --json "处理订单 PO-20261013-0042 的交期延迟：先用 order_lookup 查询该订单的承诺交期、实际交期、状态与延迟天数，然后简要说明" > "$TURN1"

SID=$(node - "$TURN1" <<'EOF'
const fs = require('node:fs')
const [file] = process.argv.slice(2)
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue
  const e = JSON.parse(line)
  if (e.type === 'session' && e.sessionId) { console.log(e.sessionId); break }
}
EOF
)
if [ -z "${SID:-}" ]; then echo "FAIL: 第 1 轮没有拿到 sessionId"; exit 1; fi
echo "    sessionId=$SID"

echo ">>> 第 2 轮：同一会话只问『那违约金多少？』（期望：不再询问订单号，直接用记忆中的 0042 / SUP-1042）"
./dev/run-headless.sh --session-id "$SID" --json "那违约金多少？" > "$TURN2"

node - "$TURN1" "$TURN2" "$AUDIT" <<'EOF'
const fs = require('node:fs')
const [turn1File, turn2File, auditFile] = process.argv.slice(2)
const readEvents = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
const turn1 = readEvents(turn1File)
const turn2 = readEvents(turn2File)
const audit = readEvents(auditFile)
const toolCalls = (events) => events.filter((e) => e.type === 'tool_call')
const finalText = (events) => [...events].reverse().find((e) => e.type === 'final')?.text ?? ''
const fail = (msg) => { console.error('FAIL:', msg); process.exitCode = 1 }
const ok = (msg) => console.log('PASS:', msg)

// 1) 第 1 轮确实调用了 order_lookup（自动抽取路径）
if (toolCalls(turn1).some((e) => e.tool === 'order_lookup')) ok('第 1 轮调用 order_lookup（自动抽取会话记忆）')
else fail('第 1 轮没有调用 order_lookup')

// 2) 会话记忆已落盘
if (audit.some((e) => e.event === 'memory.session.updated' && (e.fields ?? []).includes('lastOrderId'))) ok('审计显示会话记忆已写入（memory.session.updated, lastOrderId）')
else fail('审计里没有 memory.session.updated / lastOrderId')

// 3) 第 2 轮注入被触发（注入文本进了上下文）
const injected = audit.find((e) => e.event === 'memory.injected')
if (injected && (injected.items ?? []).some((i) => i.includes('PO-20261013-0042'))) ok(`第 2 轮注入 ${injected.count} 条记忆（含 PO-20261013-0042）`)
else fail('审计里没有 memory.injected 或注入内容不含 0042')

// 4) 第 2 轮没有重复询问订单号：两种合法路径都接受
//    a) 调工具时直接用记忆里的 0042 / SUP-1042；
//    b) 记忆足够时直接作答（0 次工具调用，更快），但必须给出 0042/CL-07 等关键事实。
const calls2 = toolCalls(turn2)
const usedOrder = calls2.some((e) => e.tool === 'order_lookup' && JSON.stringify(e.input ?? {}).includes('PO-20261013-0042'))
const usedSupplier = calls2.some((e) => e.tool === 'contract_search' && JSON.stringify(e.input ?? {}).includes('SUP-1042'))
const answeredFromMemory = calls2.length === 0 && /0042|CL-07/.test(finalText(turn2))
if (usedOrder || usedSupplier) ok(`第 2 轮直接使用记忆中的上下文（${calls2.map((c) => c.tool).join(' → ')}）`)
else if (answeredFromMemory) ok('第 2 轮凭记忆直接作答（0 次工具调用，更快）')
else fail(`第 2 轮既未使用 0042/SUP-1042，也未凭记忆直接作答（tool calls: ${calls2.map((c) => c.tool).join(', ')}）`)

// 5) 第 2 轮给出违约金数字（完整链路 2,246.40 或至少引用 CL-07）
const text2 = finalText(turn2)
if (/2[,，]?246\.40|2246\.40/.test(text2) || /CL-07/.test(text2)) ok('第 2 轮给出违约金结论（2,246.40 / CL-07）')
else fail('第 2 轮 final 未出现 2,246.40 或 CL-07')

if (process.exitCode) process.exit(process.exitCode)
console.log('\n全部通过：两轮记忆演示 OK（证据文件：runs/demo-memory-turn1.jsonl / turn2.jsonl / audit.jsonl）')
EOF
