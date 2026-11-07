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
// 平台会校验工具返回值是 lossless JSON（undefined/BigInt 会整体失败），这里做回归扫描。
function findUndefined(value, path = '$') {
  if (value === undefined) return path
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) { const p = findUndefined(value[i], `${path}[${i}]`); if (p) return p }
    return null
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { const p = findUndefined(v, `${path}.${k}`); if (p) return p }
    return null
  }
  return null
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

// ---------- advice_card（T2）：R7 审批边界 / 金额权威复算 / evidence 校验 / newDate 确定性 ----------
const advice = tools.adviceCard
const { approvalFor, addDays, standardReschedule } = await import('../plugins/pec-tools/lib/tools/advice-card.js')
const { toFixed: moneyToFixed } = await import('../plugins/pec-tools/lib/core/money.js')

ok('R7 49999.99 → 自动', approvalFor(moneyToFixed('49999.99'), false).approvalPath === '自动（无需人工审批）')
ok('R7 50000.00 → 采购主管（非自动）', approvalFor(moneyToFixed('50000'), false).approvalPath === '采购主管')
ok('R7 199999.99 → 采购主管', approvalFor(moneyToFixed('199999.99'), false).approvalPath === '采购主管')
ok('R7 200000.00 → 总监+财务', approvalFor(moneyToFixed('200000'), false).approvalPath === '总监+财务')
const r7black = approvalFor(moneyToFixed('100'), true)
ok('R7 黑名单一律人工', r7black.needHuman === true && /黑名单/.test(r7black.approvalPath), JSON.stringify(r7black))
ok('newDate 实际交期+14', standardReschedule('2026-10-20', '2026-11-02').newDate === '2026-11-16' && standardReschedule('2026-10-20', '2026-11-02').newDateSource === 'delivered_at+14')
ok('newDate delivered 空回退承诺+14', standardReschedule('2026-10-17', null).newDate === '2026-10-31' && /delivered_at 为空/.test(standardReschedule('2026-10-17', null).newDateSource), JSON.stringify(standardReschedule('2026-10-17', null)))
ok('addDays 非法日期拒绝', (() => { try { addDays('not-a-date', 1); return false } catch (e) { return e.code === 'INVALID_ARGUMENT' } })())

const card1 = await run('advice-0042', advice, { action: 'reschedule', orderId: 'PO-20261013-0042', evidence: ['CL-07'], confidence: 0.82 })
const c1 = card1?.data?.card
ok('advice 0042 金额 57,600.00', c1?.amount === '57600.00', JSON.stringify(c1?.amount))
ok('advice 0042 → 采购主管 / 需人工', c1?.approvalPath === '采购主管' && c1?.needHuman === true, JSON.stringify(c1?.approvalPath))
ok('advice 0042 newDate 2026-11-16（delivered+14）', c1?.newDate === '2026-11-16' && c1?.newDateSource === 'delivered_at+14', JSON.stringify([c1?.newDate, c1?.newDateSource]))
ok('advice 0042 evidence 自动补订单+供应商', c1?.evidence?.some((e) => e.ref === 'orders#PO-20261013-0042') && c1?.evidence?.some((e) => e.ref === 'suppliers#SUP-1042') && c1?.evidence?.some((e) => e.type === 'clause' && e.ref === 'CL-07'), JSON.stringify(c1?.evidence))
ok('advice 0042 provenance 含条款', (card1?.provenance ?? []).some((r) => r.table === 'contracts' && r.rowId === 'CL-07'), JSON.stringify(card1?.provenance))
const c1render = advice.output.render({}, card1)[0].text
ok('advice render 含审批/金额/来源', /采购主管/.test(c1render) && /57,600\.00/.test(c1render) && /\[来源: orders#PO-20261013-0042\]/.test(c1render), c1render.slice(0, 300))

const card2 = await run('advice-0055', advice, { action: 'reschedule', orderId: 'PO-20261014-0055' })
ok('advice 0055 恰好 5 万 → 采购主管（非自动）', card2?.data?.card?.amount === '50000.00' && card2?.data?.card?.approvalPath === '采购主管', JSON.stringify(card2?.data?.card?.approvalPath))

const card3 = await run('advice-0129-blacklist', advice, { action: 'split', orderId: 'PO-20260917-0129', needHuman: false })
ok('advice 黑名单强制人工（模型不能降级）', card3?.data?.card?.supplier?.blacklisted === true && card3?.data?.card?.needHuman === true && /黑名单/.test(card3?.data?.card?.approvalPath), JSON.stringify(card3?.data?.card?.approvalPath))

const card4 = await run('advice-0042-newdate-override', advice, { action: 'reschedule', orderId: 'PO-20261013-0042', params: { newDate: '2099-01-01' } })
ok('advice reschedule 忽略模型 newDate', card4?.data?.card?.newDate === '2026-11-16' && card4?.data?.card?.params?.newDate === '2026-11-16', JSON.stringify(card4?.data?.card?.params))

const card5 = await run('advice-escalate', advice, { action: 'split', orderId: 'PO-20260906-0114', needHuman: true })
ok('advice 模型可升级 needHuman（自动流程）', card5?.data?.card?.approvalPath === '自动（无需人工审批）' && card5?.data?.card?.needHuman === true, JSON.stringify(card5?.data?.card?.approvalPath))

for (const [name, args, expectCode, expectMsg] of [
  ['advice amount 造假', { action: 'reschedule', orderId: 'PO-20261013-0042', amount: 1 }, 'INVALID_ARGUMENT', /权威金额不一致/],
  ['advice evidence 不存在', { action: 'reschedule', orderId: 'PO-20261013-0042', evidence: ['orders#NOPE'] }, 'INVALID_ARGUMENT', /E_EVIDENCE_NOT_FOUND/],
  ['advice 条款非本单供应商', { action: 'reschedule', orderId: 'PO-20261013-0042', evidence: ['CL-45'] }, 'INVALID_ARGUMENT', /E_EVIDENCE_MISMATCH/],
  ['advice 未知动作', { action: 'foo', orderId: 'PO-20261013-0042' }, 'INVALID_ARGUMENT', /未知动作/],
  ['advice confidence 越界', { action: 'split', orderId: 'PO-20261013-0042', confidence: 1.5 }, 'INVALID_ARGUMENT', /confidence/],
  ['advice qty=0 订单', { action: 'split', orderId: 'PO-20261010-0099' }, 'INVALID_ARGUMENT', /E_ZERO_AMOUNT/],
  ['advice 订单不存在', { action: 'split', orderId: 'PO-NOT-EXIST' }, 'NOT_FOUND', /订单不存在/],
]) {
  const bad = await run(name, advice, args)
  ok(name + ' → ' + expectCode, bad?.__error?.code === expectCode && expectMsg.test(bad?.__error?.message ?? ''), JSON.stringify(bad?.__error?.message))
}

// 平台 lossless JSON 回归：所有工具返回 value 与其 render 输出都不得含 undefined
for (const [name, value] of [
  ['contract_search', clause07?.data],
  ['contract_search 无命中', noClause?.data],
  ['freight_calc', freight?.data],
  ['order_lookup', order?.data],
  ['pricing_quote', pricing?.data],
  ['supplier_profile', supplier?.data],
  ['ticket_similar', t1?.data],
  ['advice_card', card1?.data],
]) {
  ok('lossless JSON: ' + name, findUndefined(value) === null, String(findUndefined(value)))
}
for (const [name, tool, value] of [
  ['contract_search', tools.contractSearch, clause07],
  ['freight_calc', tools.freightCalc, freight],
  ['advice_card', tools.adviceCard, card1],
]) {
  const rendered = tool.output.render({}, value)
  ok('lossless JSON render: ' + name, findUndefined(rendered) === null, String(findUndefined(rendered)))
}

const plugin = await import('../plugins/pec-tools/lib/index.js')
const surface = await import('../plugins/pec-tools/lib/policy/tool-surface.js')
ok('advice_card 已注册到入口', plugin.inject?.includes?.('tools'), JSON.stringify(plugin.inject))
ok('advice_card 在工具面 allow 列表', surface.PEC_TOOLS.includes('advice_card'), JSON.stringify(surface.PEC_TOOLS))

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
const adviceCross = await run('advice-cross-tenant', tools.adviceCard, { action: 'reschedule', orderId: 'PO-20261013-0042' })
ok('advice 跨租户 → POLICY_DENIED', adviceCross?.__error?.code === 'POLICY_DENIED', JSON.stringify(adviceCross?.__error?.message))
delete process.env.PEC_USER_ID
identityModule.resetIdentity()

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
