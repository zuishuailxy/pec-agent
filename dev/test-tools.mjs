/**
 * 本地接线后的工具冒烟测试（不需要模型）。在 pec-agent/ 下运行：
 *   node dev/test-tools.mjs
 */
process.env.PEC_AUDIT_PATH = process.env.PEC_AUDIT_PATH || '/tmp/pec-audit-test.jsonl'
process.env.PEC_MEMORY_PATH = process.env.PEC_MEMORY_PATH || '/tmp/pec-memory-test.json'

const tools = await import('../plugins/pec-tools/lib/tools/business.js')
const { catalogTool } = await import('../plugins/pec-tools/lib/tools/catalog.js')

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('PASS', name) }
  else { fail++; console.log('FAIL', name, detail ?? '') }
}
async function run(name, tool, args) {
  try { return await tool.execute(args, {}) }
  catch (e) { return { __error: e } }
}

const catalog = await run('catalog', catalogTool, {})
ok('catalog 6 表', catalog?.data?.tables?.length === 6, JSON.stringify(catalog).slice(0, 200))

const order = await run('order', tools.orderLookup, { orderId: 'PO-20261013-0042' })
const o = order?.data?.orders?.[0]
ok('order_lookup 真实返回', !!o && o.orderId === 'PO-20261013-0042', JSON.stringify(order).slice(0, 200))
ok('order 延迟 13 天', o?.delayDays === 13, String(o?.delayDays))
ok('order provenance', Array.isArray(order?.provenance) && order.provenance.length >= 3, JSON.stringify(order?.provenance))

const pricing = await run('pricing', tools.pricingQuote, { skuId: 'SKU-88213', qty: 600 })
ok('pricing 57,600.00', pricing?.data?.amount === '57600.00', JSON.stringify(pricing?.data))
ok('pricing 税额 13%', pricing?.data?.taxAmount === '7488.00', String(pricing?.data?.taxAmount))
const pricing50k = await run('pricing50k', tools.pricingQuote, { skuId: 'SKU-88215', qty: 500 })
ok('pricing 恰好 50,000.00', pricing50k?.data?.amount === '50000.00', String(pricing50k?.data?.amount))

const freight = await run('freight', tools.freightCalc, { orderId: 'PO-20261013-0042', qty: 600 })
ok('freight 计费体积 4', freight?.data?.billedVolume === 4, JSON.stringify(freight?.data))
ok('freight 总运费 340.00', freight?.data?.totalFreight === '340.00', String(freight?.data?.totalFreight))
ok('freight 计件 0.57', freight?.data?.unitFreight === '0.57', String(freight?.data?.unitFreight))
const freight04 = await run('freight04', tools.freightCalc, { orderId: 'PO-20261015-0066', qty: 200 })
ok('freight 0.40→1 / 85.00', freight04?.data?.billedVolume === 1 && freight04?.data?.totalFreight === '85.00', JSON.stringify(freight04?.data))
const freightZero = await run('freightZero', tools.freightCalc, { orderId: 'PO-20261010-0099', qty: 0 })
ok('freight qty=0 → E_DIV_ZERO', freightZero?.__error?.code === 'INVALID_ARGUMENT' && /E_DIV_ZERO/.test(freightZero?.__error?.message || ''), JSON.stringify(freightZero?.__error?.message))

const clause07 = await run('clause07', tools.contractSearch, { supplierId: 'SUP-1042', keyword: '违约金' })
const hit07 = clause07?.data?.hits?.[0]
ok('contract CL-07', hit07?.clauseNo === 'CL-07', JSON.stringify(clause07?.data).slice(0, 300))
ok('contract 3‰', hit07?.terms?.ratePermille === '3', JSON.stringify(hit07?.terms))
const freightClause = await run('freightClause', tools.contractSearch, { supplierId: 'SUP-1046', keyword: '运费承担' })
ok('contract 短词回退命中运费条款', freightClause?.data?.found === true, JSON.stringify(freightClause?.data).slice(0, 300))
const noClause = await run('noClause', tools.contractSearch, { supplierId: 'SUP-1047', keyword: '违约金' })
ok('contract 无合同 → 未检索到', noClause?.data?.found === false, JSON.stringify(noClause?.data).slice(0, 200))

const supplier = await run('supplier', tools.supplierProfile, { supplierId: 'SUP-1042' })
ok('supplier 画像', supplier?.data?.supplierId === 'SUP-1042', JSON.stringify(supplier?.data).slice(0, 200))
ok('buyer 联系人脱敏', supplier?.data?.contacts?.every?.((c) => /\*\*\*\*/.test(c.phone)), JSON.stringify(supplier?.data?.contacts))

// ---------- ticket_similar（T6）：召回 / 去重 / 派生 / 别名 / 无命中 / 跨租户 / 非法参数 ----------
const t1 = await run('ticket-delay', tools.ticketSimilar, { exceptionType: 'DELAY' })
ok('ticket DELAY 召回 15 条 / 12 单', t1?.data?.totalTickets === 15 && t1?.data?.totalOrders === 12, JSON.stringify(t1?.data?.totalTickets) + '/' + JSON.stringify(t1?.data?.totalOrders))
const t1refs = t1?.provenance ?? []
ok('ticket provenance 含 EX-2061 + 0042', t1refs.some((r) => r.table === 'tickets' && r.rowId === 'EX-2061') && t1refs.some((r) => r.table === 'orders' && r.rowId === 'PO-20261013-0042'), JSON.stringify(t1refs).slice(0, 240))
const t1render = tools.ticketSimilar.output.render({}, t1)
ok('ticket render 含相似度与来源', /相似度/.test(t1render?.[0]?.text) && /\[来源: tickets#/.test(t1render?.[0]?.text), String(t1render?.[0]?.text).slice(0, 240))

const t2 = await run('ticket-sup-1050', tools.ticketSimilar, { exceptionType: 'DELAY', supplierId: 'SUP-1050', amountMax: 10000 })
ok('ticket 严格命中 2 单 / 放宽补位', t2?.data?.strictCount === 2 && t2?.data?.returned === 5 && t2?.data?.totalOrders === 12, JSON.stringify({ strict: t2?.data?.strictCount, returned: t2?.data?.returned, orders: t2?.data?.totalOrders }))
const t2strict = (t2?.data?.tickets ?? []).filter((x) => x.similarity === 100)
const t2amounts = t2strict.map((x) => x.amount).sort()
ok('ticket 严格金额逐位 5,239.50 / 6,732.00', JSON.stringify(t2amounts) === JSON.stringify(['5239.50', '6732.00']), JSON.stringify(t2amounts))
ok('ticket 放宽维度标注', (t2?.data?.tickets ?? []).filter((x) => x.similarity < 100).every((x) => x.relaxedOn.length > 0), JSON.stringify(t2?.data?.tickets?.map((x) => x.relaxedOn)))

const t3 = await run('ticket-stock', tools.ticketSimilar, { exceptionType: 'STOCK', supplierId: 'SUP-1062' })
ok('ticket 单订单去重 4→1', t3?.data?.totalTickets === 4 && t3?.data?.totalOrders === 1 && t3?.data?.tickets?.[0]?.sameOrderTickets === 4, JSON.stringify(t3?.data?.tickets?.[0]))
ok('ticket 人工改判统计', t3?.data?.stats?.overriddenTickets === 1 && t3?.data?.tickets?.[0]?.sameOrderOverridden === 1, JSON.stringify(t3?.data?.stats?.overriddenTickets))
ok('ticket 动作分布 split×3/reschedule×1', t3?.data?.stats?.actionCounts?.split === 3 && t3?.data?.stats?.actionCounts?.reschedule === 1, JSON.stringify(t3?.data?.stats?.actionCounts))

const t4 = await run('ticket-order', tools.ticketSimilar, { exceptionType: 'STOCK', orderId: 'PO-20260917-0129' })
ok('ticket orderId 派生供应商', t4?.data?.orderContext?.supplierId === 'SUP-1062' && t4?.data?.query?.supplierId === 'SUP-1062', JSON.stringify(t4?.data?.orderContext))
ok('ticket orderContext provenance', (t4?.provenance ?? []).some((r) => r.table === 'orders' && r.rowId === 'PO-20260917-0129'), JSON.stringify(t4?.provenance ?? []).slice(0, 200))

const t5 = await run('ticket-risk', tools.ticketSimilar, { exceptionType: 'RISK' })
const t5render = tools.ticketSimilar.output.render({}, t5)
ok('ticket 无命中 found=false', t5?.data?.found === false && t5?.data?.totalTickets === 0, JSON.stringify(t5?.data))
ok('ticket 无命中 render 禁止编造', /未召回/.test(t5render?.[0]?.text) && /不得编造/.test(t5render?.[0]?.text), String(t5render?.[0]?.text).slice(0, 200))

const t6 = await run('ticket-alias', tools.ticketSimilar, { exceptionType: '交期延迟' })
ok('ticket 中文别名归一化 DELAY', t6?.data?.query?.exceptionType === 'DELAY' && t6?.data?.totalTickets === 15, JSON.stringify(t6?.data?.query))

const t7boundary = await run('ticket-amount-exact', tools.ticketSimilar, { exceptionType: 'DELAY', supplierId: 'SUP-1050', amountMin: 5239.5, amountMax: 5239.5 })
ok('ticket 金额边界含等号', t7boundary?.data?.strictCount === 1 && t7boundary?.data?.tickets?.[0]?.ticketId === 'EX-2065' && t7boundary?.data?.tickets?.[0]?.similarity === 100, JSON.stringify(t7boundary?.data?.tickets?.[0]))

const t8 = await run('ticket-realistic', tools.ticketSimilar, { exceptionType: 'DELAY', supplierId: 'SUP-1042', amountMax: 60000 })
ok('ticket 0042 同供应商严格命中', t8?.data?.strictCount === 1 && t8?.data?.tickets?.[0]?.orderId === 'PO-20261013-0042' && t8?.data?.tickets?.[0]?.action === 'reschedule', JSON.stringify(t8?.data?.tickets?.[0]))

for (const [name, args] of [
  ['ticket 未知类型', { exceptionType: 'FOO' }],
  ['ticket 区间倒挂', { exceptionType: 'DELAY', amountMin: 100, amountMax: 50 }],
  ['ticket limit 越界', { exceptionType: 'DELAY', limit: 0 }],
]) {
  const bad = await run(name, tools.ticketSimilar, args)
  ok(name + ' → INVALID_ARGUMENT', bad?.__error?.code === 'INVALID_ARGUMENT', JSON.stringify(bad?.__error?.message))
}

// 跨租户：U-08 是 T-002 用户；只应看到 T-002 工单，查 T-001 供应商必须 POLICY_DENIED
const identityModule = await import('../plugins/pec-tools/lib/policy/identity.js')
const { readFileSync } = await import('node:fs')
process.env.PEC_USER_ID = 'U-08'
identityModule.resetIdentity()
const t9 = await run('ticket-t002', tools.ticketSimilar, { exceptionType: 'DELAY' })
ok('ticket U-08 只见 T-002', t9?.data?.totalTickets === 1 && t9?.data?.tickets?.[0]?.ticketId === 'EX-2062', JSON.stringify(t9?.data))
const t10 = await run('ticket-cross-tenant', tools.ticketSimilar, { exceptionType: 'DELAY', supplierId: 'SUP-1042' })
ok('ticket 跨租户 → POLICY_DENIED', t10?.__error?.code === 'POLICY_DENIED', JSON.stringify(t10?.__error?.message))
let auditText = ''
try { auditText = readFileSync('/tmp/pec-audit-test.jsonl', 'utf8') } catch {}
ok('ticket 跨租户拒绝留痕', auditText.includes('cross-tenant-supplier'), auditText.slice(-200))
delete process.env.PEC_USER_ID
identityModule.resetIdentity()

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
