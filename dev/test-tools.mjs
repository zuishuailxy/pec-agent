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

const ticket = await run('ticket', tools.ticketSimilar, { exceptionType: 'DELAY' })
ok('ticket_similar 仍是桩', ticket?.__error?.code === 'NOT_IMPLEMENTED', JSON.stringify(ticket?.__error?.message))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
