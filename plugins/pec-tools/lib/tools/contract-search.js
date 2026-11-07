import { defineTool } from "@deepseek-ai/dsh-tools";
import { all, one } from "../db.js";
import { ToolError, denied, notFound } from "../errors.js";
import { prov, renderLines } from "../core/provenance.js";
import { resolveIdentity } from "../policy/identity.js";
import { auditFieldAccess, contractTextAccess } from "../policy/masking.js";
const SYNONYMS = [
  [/违约|赔付|罚金/, "\u8FDD\u7EA6\u91D1"],
  [/运费|运输费|物流费/, "\u8FD0\u8F93\u8D39\u7528"],
  [/质保|保修|质量保证/, "\u8D28\u4FDD\u671F"],
  [/付款|账期|货款|回款/, "\u652F\u4ED8\u8D27\u6B3E"],
  [/延迟|交期|逾期/, "\u5EF6\u8FDF\u4EA4\u8D27"],
  [/起订|最少订购|MOQ/i, "\u6700\u5C0F\u8D77\u8BA2\u91CF"]
];
function expandTerms(keyword) {
  const terms = /* @__PURE__ */ new Set();
  const trimmed = keyword.trim();
  if (trimmed) terms.add(trimmed);
  for (const [pattern, canonical] of SYNONYMS) {
    if (pattern.test(trimmed)) terms.add(canonical);
  }
  for (const term of [...terms]) {
    for (const [pattern, canonical] of SYNONYMS) {
      if (pattern.test(term)) terms.add(canonical);
    }
  }
  return [...terms].filter(Boolean);
}
function ftsSearch(supplierId, term) {
  return all(
    `select c.clause_no, c.supplier_id, c.type, c.text, c.effective_from
       from contracts_fts f join contracts c on c.clause_no = f.clause_no
      where contracts_fts match ? and c.supplier_id = ?
      order by bm25(contracts_fts) limit 5`,
    [term, supplierId]
  );
}
function likeSearch(supplierId, term) {
  return all(
    `select clause_no, supplier_id, type, text, effective_from
       from contracts where supplier_id = ? and text like ? order by clause_no limit 5`,
    [supplierId, `%${term}%`]
  );
}
function summarizeClause(row) {
  const text = row.text;
  const summary = {};
  if (row.type === "penalty") {
    const rate = text.match(/(\d+(?:\.\d+)?)\s*‰/);
    const cap = text.match(/(\d+(?:\.\d+)?)\s*%/);
    if (rate) summary.ratePermille = rate[1];
    if (cap) summary.capPercent = cap[1];
    summary.basis = "\u5408\u540C\u91D1\u989D";
    summary.perDay = true;
  } else if (row.type === "moq") {
    const moq = text.match(/最小起订量为\s*(\d+)\s*件/);
    if (moq) summary.minOrderQty = Number(moq[1]);
  } else if (row.type === "freight") {
    const bearer = text.match(/运输费用由(买方|卖方)承担/);
    if (bearer) summary.freightBearer = bearer[1];
    summary.billingRule = "\u8BA1\u8D39\u4F53\u79EF\u6309\u5411\u4E0A\u53D6\u6574\u7684\u7ACB\u65B9\u5C3A\u8BA1\u7B97";
  } else if (row.type === "payment") {
    const days = text.match(/(\d+)\s*日内支付货款/);
    const overdue = text.match(/日万分之(\d+(?:\.\d+)?)/);
    if (days) summary.paymentDays = Number(days[1]);
    if (overdue) summary.overdueDailyRate = `\u4E07\u5206\u4E4B${overdue[1]}`;
  } else if (row.type === "warranty") {
    const months = text.match(/质保期为交付之日起\s*(\d+)\s*个月/);
    if (months) summary.warrantyMonths = Number(months[1]);
  }
  return summary;
}
const contractSearch = defineTool({
  name: "contract_search",
  description: "\u6309\u4F9B\u5E94\u5546 + \u5173\u952E\u8BCD\u68C0\u7D22\u5408\u540C\u6761\u6B3E\uFF08FTS5 \u5173\u952E\u8BCD\u53EC\u56DE + \u540C\u4E49\u8BCD\u56DE\u9000\uFF09\uFF0C\u8FD4\u56DE\u6761\u6B3E\u53F7\u3001\u7C7B\u578B\u3001\u7ED3\u6784\u5316\u6458\u8981\u4E0E\u51FA\u5904\uFF1B\u65E0\u547D\u4E2D\u65F6\u660E\u786E\u8FD4\u56DE\u300C\u672A\u68C0\u7D22\u5230\u300D\u3002\u9002\u7528\uFF1A\u627E\u8FDD\u7EA6\u91D1/\u8FD0\u8D39/\u8D28\u4FDD/MOQ/\u8D26\u671F\u6761\u6B3E\u65F6\uFF1B\u4E0D\u9002\u7528\uFF1A\u67E5\u8BA2\u5355\u4E8B\u5B9E\uFF08\u7528 order.lookup\uFF09\u3001\u67E5\u4F9B\u5E94\u5546\u753B\u50CF\uFF08\u7528 supplier.profile\uFF09\u3002\u53EA\u5141\u8BB8\u5F15\u7528\u672C\u5DE5\u5177\u8FD4\u56DE\u7684\u6761\u6B3E\u53F7\u3002",
  parameters: {
    supplierId: { type: "string", required: true, description: "\u4F9B\u5E94\u5546\u7F16\u7801\uFF0C\u5982 SUP-1042" },
    keyword: { type: "string", required: true, description: "\u68C0\u7D22\u8BCD\uFF0C\u5982\u300C\u8FDD\u7EA6\u91D1\u300D\u300C\u8FD0\u8F93\u8D39\u7528\u300D\u300C\u8D28\u4FDD\u671F\u300D\uFF1B\u77ED\u8BCD\u4F1A\u81EA\u52A8\u5F52\u4E00\u5316" },
    tenantId: { type: "string", description: "\u8FD0\u884C\u65F6\u6CE8\u5165\u7684\u79DF\u6237\uFF1B\u6A21\u578B\u4E0D\u53EF\u81EA\u586B" }
  },
  output: {
    schema: { type: "object", additionalProperties: true },
    render: (_args, value) => {
      const v = value;
      const d = v.data;
      if (!d.found) {
        return renderLines(
          [`\u672A\u68C0\u7D22\u5230\u4E0E\u8BE5\u4F9B\u5E94\u5546\u5339\u914D\u7684\u6761\u6B3E\uFF08\u5173\u952E\u8BCD\uFF1A${d.keyword}\uFF1B\u6269\u5C55\u8BCD\uFF1A${d.expandedTerms.join(" / ")}\uFF09\u3002\u4E0D\u5F97\u5F15\u7528\u4EFB\u4F55\u6761\u6B3E\u53F7\uFF0C\u4E5F\u4E0D\u5F97\u865A\u6784\u5408\u540C\u5185\u5BB9\u3002`],
          v.provenance
        );
      }
      const lines = d.hits.map((hit) => {
        const terms = JSON.stringify(hit.terms);
        return `${hit.clauseNo} [${hit.type}] ${hit.summaryText}\uFF1B\u7ED3\u6784\u5316\u6458\u8981 ${terms}${hit.text ? `\uFF1B\u539F\u6587\uFF1A${hit.text}` : "\uFF1B\u539F\u6587\u6309\u89D2\u8272\u4E0D\u53EF\u89C1"}`;
      });
      lines.unshift(`\u5339\u914D\u5230 ${d.hits.length} \u6761\u6761\u6B3E\uFF08\u5173\u952E\u8BCD\uFF1A${d.keyword}\uFF1B\u6269\u5C55\u8BCD\uFF1A${d.expandedTerms.join(" / ")}\uFF09`);
      return renderLines(lines, v.provenance);
    }
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id);
    const { supplierId, keyword } = args;
    if (!supplierId || !keyword?.trim()) throw new ToolError("INVALID_ARGUMENT", "supplierId \u4E0E keyword \u5FC5\u586B", {});
    const supplier = one("select tenant_id from suppliers where id = ?", [supplierId]);
    if (!supplier) throw notFound(`\u4F9B\u5E94\u5546\u4E0D\u5B58\u5728\uFF1A${supplierId}`, { supplierId });
    if (supplier.tenant_id !== identity.tenantId) {
      throw denied(`POLICY_DENIED: \u4F9B\u5E94\u5546 ${supplierId} \u4E0D\u5C5E\u4E8E\u5F53\u524D\u79DF\u6237 ${identity.tenantId}`, { supplierId });
    }
    const expandedTerms = expandTerms(keyword);
    const found = /* @__PURE__ */ new Map();
    for (const term of expandedTerms) {
      if ([...term].length >= 3) {
        for (const row of ftsSearch(supplierId, term)) found.set(row.clause_no, row);
      }
      for (const row of likeSearch(supplierId, term)) found.set(row.clause_no, row);
      if (found.size >= 5) break;
    }
    const access = contractTextAccess(identity.role);
    auditFieldAccess(identity.role, "contract.text", access, {
      tool: "contract_search",
      userId: identity.userId,
      tenantId: identity.tenantId,
      supplierId
    });
    if (found.size === 0) {
      return {
        data: {
          found: false,
          keyword,
          expandedTerms,
          supplierId,
          noHitReason: "NO_CLAUSE_MATCH",
          hits: []
        },
        provenance: [prov("suppliers", supplierId)]
      };
    }
    const hits = [...found.values()].slice(0, 5).map((row) => {
      const terms = summarizeClause(row);
      const summaryText = row.type === "penalty" ? `\u8FDD\u7EA6\u91D1 ${terms.ratePermille ?? "?"}\u2030/\u65E5\uFF0C\u4E0A\u9650 ${terms.capPercent ?? "?"}%` : row.type === "freight" ? `\u8FD0\u8F93\u8D39\u7528\u7531${terms.freightBearer ?? "?"}\u627F\u62C5` : row.type === "moq" ? `\u6700\u5C0F\u8D77\u8BA2\u91CF ${terms.minOrderQty ?? "?"} \u4EF6` : row.type === "payment" ? `\u8D26\u671F ${terms.paymentDays ?? "?"} \u65E5` : row.type === "warranty" ? `\u8D28\u4FDD ${terms.warrantyMonths ?? "?"} \u4E2A\u6708` : row.type;
      const hit = {
        clauseNo: row.clause_no,
        supplierId: row.supplier_id,
        type: row.type,
        effectiveFrom: row.effective_from,
        summaryText,
        terms
      };
      if (access === "full") hit.text = row.text;
      else hit.textOmitted = access;
      return hit;
    });
    return {
      data: {
        found: true,
        keyword,
        expandedTerms,
        supplierId,
        textAccess: access,
        hits
      },
      provenance: [
        prov("suppliers", supplierId),
        ...hits.map((hit) => prov("contracts", hit.clauseNo, ["type", "text", "effective_from"]))
      ]
    };
  }
});
export {
  contractSearch,
  expandTerms,
  summarizeClause
};
//# sourceMappingURL=contract-search.js.map
