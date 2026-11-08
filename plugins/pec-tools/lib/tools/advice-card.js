import { defineTool } from "@deepseek-ai/dsh-tools";
import { one } from "../db.js";
import { denied, invalid, notFound } from "../errors.js";
import { dayDiff, fixedToString, formatMoney, mulIntFixed, toFixed } from "../core/money.js";
import { prov, renderLines } from "../core/provenance.js";
import { resolveIdentity } from "../policy/identity.js";
import { writeAudit } from "../policy/audit.js";
import { rememberSession } from "../memory/store.js";
const ADVICE_ACTIONS = ["reschedule", "switch_source", "split", "replenish", "audit_freight"];
const R7_THRESHOLDS = {
  /** < 5 万自动 */
  manager: toFixed("50000"),
  /** CR#1：≥ 10 万需财务会签 */
  finance: toFixed("100000"),
  /** ≥ 20 万总监 + 财务 */
  director: toFixed("200000")
};
function approvalFor(amount, blacklisted) {
  const financeCountersign = amount >= R7_THRESHOLDS.finance;
  const financeHit = financeCountersign ? ["CR1:GE_100000_FINANCE"] : [];
  if (blacklisted) {
    return {
      approvalPath: "\u4EBA\u5DE5\u590D\u6838\uFF08\u9ED1\u540D\u5355\u4F9B\u5E94\u5546\uFF09",
      needHuman: true,
      financeCountersign,
      ruleHits: ["R7:blacklist", ...financeHit]
    };
  }
  if (amount >= R7_THRESHOLDS.director) {
    return {
      approvalPath: "\u603B\u76D1+\u8D22\u52A1",
      needHuman: true,
      financeCountersign: true,
      ruleHits: ["R7:GE_200000", "CR1:GE_100000_FINANCE"]
    };
  }
  if (financeCountersign) {
    return {
      approvalPath: "\u91C7\u8D2D\u4E3B\u7BA1+\u8D22\u52A1\u4F1A\u7B7E",
      needHuman: true,
      financeCountersign: true,
      ruleHits: ["R7:GE_50000", "CR1:GE_100000_FINANCE"]
    };
  }
  if (amount >= R7_THRESHOLDS.manager) {
    return { approvalPath: "\u91C7\u8D2D\u4E3B\u7BA1", needHuman: true, financeCountersign: false, ruleHits: ["R7:GE_50000"] };
  }
  return { approvalPath: "\u81EA\u52A8\uFF08\u65E0\u9700\u4EBA\u5DE5\u5BA1\u6279\uFF09", needHuman: false, financeCountersign: false, ruleHits: ["R7:AUTO_LT_50000"] };
}
function addDays(isoDate, days) {
  const base = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(base)) throw invalid(`\u975E\u6CD5\u65E5\u671F\uFF1A${isoDate}`);
  return new Date(base + days * 864e5).toISOString().slice(0, 10);
}
function standardReschedule(promisedAt, deliveredAt) {
  if (deliveredAt) return { newDate: addDays(deliveredAt, 14), newDateSource: "delivered_at+14" };
  return { newDate: addDays(promisedAt, 14), newDateSource: "promised_at+14\uFF08delivered_at \u4E3A\u7A7A\u56DE\u9000\uFF09" };
}
const EVIDENCE_TABLES = ["orders", "suppliers", "skus", "contracts", "tickets", "users"];
function validateEvidenceRef(raw, identity, orderSupplierId, auditBase) {
  const ref = raw.trim();
  if (!ref) throw invalid("evidence \u91CC\u5B58\u5728\u7A7A ref");
  if (ref.includes("#")) {
    const [table, rowId] = ref.split("#");
    if (!rowId) throw invalid(`\u8BC1\u636E ref \u975E\u6CD5\uFF1A${ref}`);
    if (!EVIDENCE_TABLES.includes(table)) {
      throw invalid(`\u8BC1\u636E\u8868\u540D\u975E\u6CD5\uFF1A${table}\uFF08\u53EF\u9009\uFF1A${EVIDENCE_TABLES.join(" / ")}\uFF09`);
    }
    const row = table === "contracts" ? one("select clause_no, supplier_id from contracts where clause_no = ?", [rowId]) : table === "users" ? one("select id, tenant_id from users where id = ?", [rowId]) : one(`select id, tenant_id from ${table} where id = ?`, [rowId]);
    if (!row) throw invalid(`E_EVIDENCE_NOT_FOUND: \u8BC1\u636E\u4E0D\u5B58\u5728 ${table}#${rowId}`, { reason: "E_EVIDENCE_NOT_FOUND", ref });
    if (table === "contracts") {
      if (row.supplier_id !== orderSupplierId) {
        throw invalid(
          `E_EVIDENCE_MISMATCH: \u6761\u6B3E ${rowId} \u5C5E\u4E8E\u4F9B\u5E94\u5546 ${row.supplier_id}\uFF0C\u4E0D\u5C5E\u4E8E\u672C\u5355\u4F9B\u5E94\u5546 ${orderSupplierId}`,
          { reason: "E_EVIDENCE_MISMATCH", ref }
        );
      }
      return { type: "clause", ref: rowId };
    }
    if (row.tenant_id !== identity.tenantId) {
      writeAudit({ event: "deny", reason: "cross-tenant-evidence", ref, ...auditBase });
      throw denied(`POLICY_DENIED: \u8BC1\u636E ${ref} \u4E0D\u5C5E\u4E8E\u5F53\u524D\u79DF\u6237 ${identity.tenantId}`, { ref });
    }
    return { type: "table", ref };
  }
  const clause = one(
    "select clause_no, supplier_id from contracts where clause_no = ?",
    [ref]
  );
  if (!clause) throw invalid(`E_EVIDENCE_NOT_FOUND: \u8BC1\u636E\u4E0D\u5B58\u5728 ${ref}\uFF08\u8868\u5F15\u7528\u8BF7\u7528 table#rowId\uFF0C\u6761\u6B3E\u5F15\u7528\u7528 CL-xx\uFF09`, { reason: "E_EVIDENCE_NOT_FOUND", ref });
  if (clause.supplier_id !== orderSupplierId) {
    throw invalid(`E_EVIDENCE_MISMATCH: \u6761\u6B3E ${ref} \u5C5E\u4E8E\u4F9B\u5E94\u5546 ${clause.supplier_id}\uFF0C\u4E0D\u5C5E\u4E8E\u672C\u5355\u4F9B\u5E94\u5546 ${orderSupplierId}`, {
      reason: "E_EVIDENCE_MISMATCH",
      ref
    });
  }
  return { type: "clause", ref };
}
function evidenceProvenance(evidence) {
  return evidence.map((item) => {
    if (item.type === "clause") return prov("contracts", item.ref, ["type", "text"]);
    const [table, rowId] = item.ref.split("#");
    return prov(table, rowId);
  });
}
function dedupeRisks(risks) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const risk of risks) {
    const trimmed = risk.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result.slice(0, 8);
}
const adviceCard = defineTool({
  name: "advice_card",
  description: "\u751F\u6210\u91C7\u8D2D\u5F02\u5E38\u5904\u7F6E\u5EFA\u8BAE\u5361\uFF08\u53EA\u8BFB\u3001\u5EFA\u8BAE\u4E0D\u6267\u884C\uFF09\uFF1A\u52A8\u4F5C\u3001\u53C2\u6570\u3001\u91D1\u989D\u3001\u8BC1\u636E\u3001\u98CE\u9669\u3001\u5BA1\u6279\u8DEF\u5F84\u3001\u7F6E\u4FE1\u5EA6\u4E0E\u662F\u5426\u9700\u4EBA\u5DE5\u786E\u8BA4\u3002\u5DE5\u5177\u4F1A\u6743\u5A01\u590D\u7B97\u91D1\u989D\u3001\u6821\u9A8C R7 \u5BA1\u6279\u9608\u503C\uFF08<5 \u4E07\u81EA\u52A8 / 5\u201310 \u4E07\u91C7\u8D2D\u4E3B\u7BA1 / 10\u201320 \u4E07\u91C7\u8D2D\u4E3B\u7BA1+\u8D22\u52A1\u4F1A\u7B7E / \u226520 \u4E07\u603B\u76D1+\u8D22\u52A1 / \u9ED1\u540D\u5355\u4E00\u5F8B\u4EBA\u5DE5\uFF0C\u8D22\u52A1\u4F1A\u7B7E\u4E3A CR#1 \u65B0\u589E\uFF09\u4E0E\u6BCF\u6761 evidence \u662F\u5426\u771F\u5B9E\u5B58\u5728\uFF0C\u6A21\u578B\u4E0D\u80FD\u7ED5\u8FC7\u3002\u9002\u7528\uFF1A\u4E00\u6B21\u5904\u7F6E\u53D6\u8BC1\u5B8C\u6210\u540E\u8F93\u51FA\u6700\u7EC8\u5EFA\u8BAE\u65F6\uFF1B\u4E0D\u9002\u7528\uFF1A\u67E5\u4E8B\u5B9E\uFF08order_lookup\uFF09\u3001\u67E5\u5386\u53F2\uFF08ticket_similar\uFF09\u3001\u68C0\u7D22\u6761\u6B3E\uFF08contract_search\uFF09\u3002",
  parameters: {
    action: {
      type: "string",
      required: true,
      description: `\u5904\u7F6E\u52A8\u4F5C\uFF1A${ADVICE_ACTIONS.join(" / ")}`
    },
    orderId: { type: "string", required: true, description: "\u91C7\u8D2D\u8BA2\u5355\u53F7\uFF0C\u5982 PO-20261013-0042\uFF1B\u5FC5\u987B\u5C5E\u5F53\u524D\u79DF\u6237" },
    params: {
      type: "object",
      additionalProperties: true,
      description: '\u52A8\u4F5C\u53C2\u6570\uFF08\u53EF\u9009\uFF09\uFF0C\u5982 {"newDate":"2026-11-16","qty":1000}\uFF1Breschedule \u7684 newDate \u7531\u5DE5\u5177\u786E\u5B9A\u6027\u91CD\u7B97\uFF0C\u4F20\u5165\u503C\u4F1A\u88AB\u5FFD\u7565'
    },
    amount: { type: "number", description: "\u53EF\u9009\uFF1A\u6A21\u578B\u7ED9\u51FA\u7684\u91D1\u989D\uFF08\u5143\uFF09\u3002\u5DE5\u5177\u6309\u8BA2\u5355 qty \xD7 unit_price \u6743\u5A01\u590D\u7B97\uFF0C\u4E0D\u4E00\u81F4\u4F1A\u62D2\u7EDD" },
    evidence: {
      type: "array",
      items: { type: "string" },
      description: '\u8BC1\u636E ref \u5217\u8868\uFF08\u53EF\u9009\uFF09\uFF1A\u8868\u5F15\u7528\u5199 "orders#PO-..."\u3001"tickets#EX-..."\uFF1B\u6761\u6B3E\u5F15\u7528\u5199 "CL-07"\u3002\u5DE5\u5177\u4F1A\u81EA\u52A8\u8865\u8BA2\u5355/\u4F9B\u5E94\u5546\u6765\u6E90\uFF0C\u5E76\u6821\u9A8C\u6BCF\u4E2A ref \u771F\u5B9E\u5B58\u5728\u4E14\u6761\u6B3E\u5C5E\u672C\u5355\u4F9B\u5E94\u5546'
    },
    risks: { type: "array", items: { type: "string" }, description: "\u6A21\u578B\u8BC6\u522B\u5230\u7684\u98CE\u9669\uFF08\u53EF\u9009\uFF09\uFF1B\u5DE5\u5177\u4F1A\u6309\u8BA2\u5355/\u4F9B\u5E94\u5546\u4E8B\u5B9E\u8865\u5145\u98CE\u9669" },
    confidence: { type: "number", description: "\u7F6E\u4FE1\u5EA6 0\u20131\uFF08\u53EF\u9009\uFF0C\u9ED8\u8BA4 0.8\uFF09" },
    needHuman: { type: "boolean", description: "\u53EF\u9009\uFF1A\u6A21\u578B\u8BA4\u4E3A\u9700\u8981\u4EBA\u5DE5\u786E\u8BA4\u3002\u5DE5\u5177\u6309 R7 \u5F3A\u5236\uFF0C\u6A21\u578B\u53EA\u80FD\u5347\u7EA7\uFF08true\uFF09\u4E0D\u80FD\u964D\u7EA7\u4E3A false" },
    tenantId: { type: "string", description: "\u8FD0\u884C\u65F6\u6CE8\u5165\u7684\u79DF\u6237\uFF1B\u6A21\u578B\u4E0D\u53EF\u81EA\u586B\uFF0C\u4F20\u9519\u4F1A\u88AB guard \u62D2\u7EDD" }
  },
  output: {
    schema: { type: "object", additionalProperties: true },
    render: (_args, value) => {
      const v = value;
      const c = v.data.card;
      const lines = [];
      lines.push(`\u5EFA\u8BAE\u5361\uFF08${c.needHuman ? "\u9700\u4EBA\u5DE5\u786E\u8BA4" : "\u53EF\u81EA\u52A8\u6267\u884C"}\uFF09\uFF1A${c.action}`);
      lines.push(
        `- \u8BA2\u5355\uFF1A${c.order.orderId}\uFF08\u72B6\u6001 ${c.order.status}\uFF1B\u4F9B\u5E94\u5546 ${c.supplier.supplierId} ${c.supplier.supplierName}\uFF0C${c.supplier.riskLevel} \u7EA7\uFF0C\u9ED1\u540D\u5355${c.supplier.blacklisted ? "\u662F" : "\u5426"}\uFF0C\u8FD1 12 \u6708\u5EF6\u8FDF ${c.supplier.delayDays12m} \u5929\uFF09`
      );
      lines.push(
        `- \u52A8\u4F5C\uFF1A${c.action}\uFF1B\u53C2\u6570\uFF1A${JSON.stringify(c.params)}${c.newDate ? `\uFF08newDate \u6309 ${c.newDateSource} \u786E\u5B9A\u6027\u91CD\u7B97\uFF09` : ""}`
      );
      lines.push(`- \u91D1\u989D\uFF1A${formatMoney(toFixed(c.amount))}\uFF08\u8BA2\u5355\u6743\u5A01\u590D\u7B97\uFF1A${c.order.qty} \xD7 ${c.order.unitPrice}\uFF09`);
      lines.push(`- \u5BA1\u6279\u8DEF\u5F84\uFF1A${c.approvalPath}\uFF08\u89C4\u5219\u547D\u4E2D ${c.ruleHits.join(" / ")}\uFF09`);
      lines.push(
        c.financeCountersign ? `- \u8D22\u52A1\u4F1A\u7B7E\uFF1A\u9700\uFF08\u91D1\u989D \u2265 100,000.00\uFF0CCR#1 \u9608\u503C\uFF1B\u672C\u5355 ${formatMoney(toFixed(c.amount))}\uFF09` : `- \u8D22\u52A1\u4F1A\u7B7E\uFF1A\u4E0D\u9700\u8981\uFF08\u91D1\u989D < 100,000.00\uFF0CCR#1 \u9608\u503C\uFF09`
      );
      if (c.risks.length) lines.push(`- \u98CE\u9669\uFF1A${c.risks.join("\uFF1B")}`);
      lines.push(`- \u7F6E\u4FE1\u5EA6\uFF1A${c.confidence}`);
      lines.push(`- \u8BC1\u636E\uFF1A${c.evidence.map((e) => e.type === "clause" ? `\u6761\u6B3E ${e.ref}` : e.ref).join("\u3001")}`);
      lines.push(
        "\u53E3\u5F84\uFF1AR7 \u9608\u503C 50,000.00 / 100,000.00 / 200,000.00\uFF08\u226510 \u4E07\u9700\u8D22\u52A1\u4F1A\u7B7E\u3001\u226520 \u4E07\u603B\u76D1+\u8D22\u52A1\uFF0C\u9ED1\u540D\u5355\u4E00\u5F8B\u4EBA\u5DE5\uFF1B\u8D22\u52A1\u4F1A\u7B7E\u4E3A CR#1 \u65B0\u589E\uFF09\uFF1B\u672C\u5361\u53EA\u4EA7\u51FA\u5EFA\u8BAE\uFF0C\u4E0D\u6267\u884C\u4EFB\u4F55\u5199\u64CD\u4F5C\uFF0C\u7528\u6237\u786E\u8BA4\u6216\u4FEE\u6539\u540E\u624D\u8FDB\u5165\u6807\u6CE8\u96C6\u3002"
      );
      return renderLines(lines, v.provenance);
    }
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id);
    const sessionId = exec?.agent?.session?.id;
    const a = args;
    const auditBase = { tool: "advice_card", sessionId, userId: identity.userId, tenantId: identity.tenantId };
    const action = String(a.action ?? "").trim();
    if (!ADVICE_ACTIONS.includes(action)) {
      throw invalid(`\u672A\u77E5\u52A8\u4F5C\u300C${action}\u300D\uFF0C\u53EF\u9009\uFF1A${ADVICE_ACTIONS.join(" / ")}`);
    }
    if (!a.orderId) throw invalid("orderId \u5FC5\u586B");
    const order = one(
      `select id, tenant_id, supplier_id, sku_id, qty, unit_price, amount, promised_at, delivered_at, status
         from orders where id = ?`,
      [String(a.orderId)]
    );
    if (!order) throw notFound(`\u8BA2\u5355\u4E0D\u5B58\u5728\uFF1A${a.orderId}`, { orderId: a.orderId });
    if (order.tenant_id !== identity.tenantId) {
      writeAudit({ event: "deny", reason: "cross-tenant-order", resource: `orders#${order.id}`, ownerTenant: order.tenant_id, ...auditBase });
      throw denied(`POLICY_DENIED: \u8BA2\u5355 ${order.id} \u4E0D\u5C5E\u4E8E\u5F53\u524D\u79DF\u6237 ${identity.tenantId}`, { orderId: order.id });
    }
    const supplier = one(
      "select id, tenant_id, name, risk_level, blacklisted, delay_days_12m from suppliers where id = ?",
      [order.supplier_id]
    );
    if (!supplier) throw notFound(`\u4F9B\u5E94\u5546\u4E0D\u5B58\u5728\uFF1A${order.supplier_id}`, { supplierId: order.supplier_id });
    if (supplier.tenant_id !== identity.tenantId) {
      writeAudit({ event: "deny", reason: "cross-tenant-supplier", resource: `suppliers#${supplier.id}`, ...auditBase });
      throw denied(`POLICY_DENIED: \u4F9B\u5E94\u5546 ${supplier.id} \u4E0D\u5C5E\u4E8E\u5F53\u524D\u79DF\u6237 ${identity.tenantId}`, { supplierId: supplier.id });
    }
    const amountFixed = mulIntFixed(order.qty, toFixed(order.unit_price));
    if (amountFixed <= 0n) {
      throw invalid("E_ZERO_AMOUNT: \u8BA2\u5355\u91D1\u989D\u4E3A 0\uFF08qty=0\uFF1F\uFF09\uFF0C\u4E0D\u80FD\u751F\u6210\u91D1\u989D\u7C7B\u5EFA\u8BAE\u5361", { reason: "E_ZERO_AMOUNT" });
    }
    const amountStr = fixedToString(amountFixed);
    if (a.amount !== void 0 && a.amount !== null) {
      const given = fixedToString(toFixed(Number(a.amount)));
      if (given !== amountStr) {
        throw invalid(`amount \u4E0E\u8BA2\u5355\u6743\u5A01\u91D1\u989D\u4E0D\u4E00\u81F4\uFF1A\u8BA2\u5355 ${amountStr}\uFF0C\u4F20\u5165 ${given}`, { expected: amountStr, got: given });
      }
    }
    const confidence = a.confidence === void 0 ? 0.8 : Number(a.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw invalid("confidence \u5FC5\u987B\u662F 0\u20131 \u7684\u6570\u5B57");
    const decision = approvalFor(amountFixed, Boolean(supplier.blacklisted));
    const rawEvidence = Array.isArray(a.evidence) ? a.evidence.map((x) => String(x)) : [];
    const autoRefs = [`orders#${order.id}`, `suppliers#${supplier.id}`];
    const evidence = [];
    for (const ref of [...autoRefs, ...rawEvidence]) {
      const normalized = validateEvidenceRef(ref, identity, order.supplier_id, auditBase);
      if (!evidence.some((item) => item.ref === normalized.ref)) evidence.push(normalized);
    }
    const provenance = [
      prov("orders", order.id, ["qty", "unit_price", "promised_at", "delivered_at", "status"]),
      prov("suppliers", supplier.id, ["name", "risk_level", "blacklisted", "delay_days_12m"]),
      ...evidenceProvenance(evidence)
    ];
    const params = a.params && typeof a.params === "object" && !Array.isArray(a.params) ? { ...a.params } : {};
    let newDate;
    let newDateSource;
    if (action === "reschedule") {
      const standard = standardReschedule(order.promised_at, order.delivered_at);
      newDate = standard.newDate;
      newDateSource = standard.newDateSource;
      params.newDate = newDate;
    }
    const autoRisks = [];
    if (order.delivered_at) autoRisks.push(`\u5EF6\u8FDF ${dayDiff(order.promised_at, order.delivered_at)} \u5929`);
    if (supplier.blacklisted) autoRisks.push(`\u4F9B\u5E94\u5546\u4E3A\u9ED1\u540D\u5355\uFF08${supplier.risk_level} \u7EA7\uFF09`);
    else if (supplier.risk_level === "D") autoRisks.push("\u4F9B\u5E94\u5546\u98CE\u9669\u7B49\u7EA7 D");
    if (supplier.delay_days_12m > 0) autoRisks.push(`\u8FD1 12 \u6708\u7D2F\u8BA1\u5EF6\u8FDF ${supplier.delay_days_12m} \u5929`);
    if (amountFixed >= R7_THRESHOLDS.director) autoRisks.push(`\u91D1\u989D\u8D85\u8FC7 20 \u4E07\u9608\u503C\uFF08${amountStr}\uFF09\uFF0C\u9700\u603B\u76D1+\u8D22\u52A1\u5BA1\u6279`);
    else if (amountFixed >= R7_THRESHOLDS.finance) autoRisks.push(`\u91D1\u989D\u8D85\u8FC7 10 \u4E07\u9608\u503C\uFF08${amountStr}\uFF09\uFF0C\u9700\u8D22\u52A1\u4F1A\u7B7E\uFF08CR#1\uFF09`);
    else if (amountFixed >= R7_THRESHOLDS.manager) autoRisks.push(`\u91D1\u989D\u8D85\u8FC7 5 \u4E07\u9608\u503C\uFF08${amountStr}\uFF09`);
    else autoRisks.push(`\u91D1\u989D\u4F4E\u4E8E 5 \u4E07\u9608\u503C\uFF08${amountStr}\uFF09\uFF0C\u53EF\u6309\u81EA\u52A8\u6D41\u7A0B\u5904\u7406`);
    const risks = dedupeRisks([...Array.isArray(a.risks) ? a.risks.map((x) => String(x)) : [], ...autoRisks]);
    const needHuman = decision.needHuman || a.needHuman === true;
    const noteParts = [
      ...newDate ? [`newDate=${newDate}`] : [],
      `approval=${decision.approvalPath}`,
      `financeCountersign=${decision.financeCountersign ? "yes" : "no"}`
    ];
    rememberSession(identity, sessionId, {
      lastOrderId: order.id,
      lastSupplierId: supplier.id,
      currentAction: action,
      note: noteParts.join(";")
    });
    const card = {
      action,
      params,
      amount: amountStr,
      evidence,
      risks,
      confidence,
      needHuman,
      approvalPath: decision.approvalPath,
      financeCountersign: decision.financeCountersign,
      ruleHits: decision.ruleHits,
      ...newDate ? { newDate } : {},
      ...newDateSource ? { newDateSource } : {},
      order: {
        orderId: order.id,
        status: order.status,
        qty: order.qty,
        unitPrice: order.unit_price.toFixed(2),
        amount: amountStr,
        promisedAt: order.promised_at,
        deliveredAt: order.delivered_at
      },
      supplier: {
        supplierId: supplier.id,
        supplierName: supplier.name,
        riskLevel: supplier.risk_level,
        blacklisted: Boolean(supplier.blacklisted),
        delayDays12m: supplier.delay_days_12m
      }
    };
    return {
      data: {
        card,
        ruleSummary: `R7\uFF1A<50000.00 \u81EA\u52A8\uFF1B50000.00\u201399999.99 \u91C7\u8D2D\u4E3B\u7BA1\uFF1B100000.00\u2013199999.99 \u91C7\u8D2D\u4E3B\u7BA1+\u8D22\u52A1\u4F1A\u7B7E\uFF08CR#1\uFF09\uFF1B\u2265200000.00 \u603B\u76D1+\u8D22\u52A1\uFF1B\u9ED1\u540D\u5355\u4E00\u5F8B\u4EBA\u5DE5\uFF08\u672C\u5355 ${amountStr} \u2192 ${decision.approvalPath}\uFF0C\u8D22\u52A1\u4F1A\u7B7E=${decision.financeCountersign ? "\u9700" : "\u4E0D\u9700\u8981"}\uFF09`
      },
      provenance: [...new Map(provenance.map((ref) => [`${ref.table}#${ref.rowId}`, ref])).values()]
    };
  }
});
export {
  ADVICE_ACTIONS,
  R7_THRESHOLDS,
  addDays,
  adviceCard,
  approvalFor,
  standardReschedule
};
//# sourceMappingURL=advice-card.js.map
