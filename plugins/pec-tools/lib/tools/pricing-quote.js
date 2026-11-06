import { defineTool } from "@deepseek-ai/dsh-tools";
import { one } from "../db.js";
import { denied, invalid, notFound } from "../errors.js";
import {
  formatMoney,
  fixedToString,
  mulFixed,
  mulIntFixed,
  toFixed
} from "../core/money.js";
import { prov, renderLines } from "../core/provenance.js";
import { resolveIdentity } from "../policy/identity.js";
function parseTiers(raw) {
  const parsed = JSON.parse(raw);
  return parsed.map(([low, high, price]) => ({ low, high, price }));
}
function pickTier(tiers, qty) {
  return tiers.find((tier) => qty >= tier.low && (tier.high === null || qty <= tier.high));
}
function vatRate() {
  const raw = process.env.PEC_VAT_RATE || "0.13";
  return { rate: fixedToString(toFixed(raw), 4), source: `assumption:PEC_VAT_RATE=${raw}` };
}
const pricingQuote = defineTool({
  name: "pricing_quote",
  description: "\u6309 SKU + \u6570\u91CF\u547D\u4E2D\u9636\u68AF\u4EF7\uFF0C\u7528\u5341\u8FDB\u5236\u5B9A\u70B9\u8BA1\u7B97\u91D1\u989D\u4E0E\u7A0E\u989D\uFF08\u7EAF\u51FD\u6570\uFF0C\u4E0D\u8C03\u6A21\u578B\uFF09\u3002\u9002\u7528\uFF1A\u7B97\u8BA2\u5355\u91D1\u989D\u3001\u5BA1\u6279\u91D1\u989D\u3001\u7A0E\u989D\u3001\u9636\u68AF\u5355\u4EF7\u65F6\uFF1B\u4E0D\u9002\u7528\uFF1A\u7B97\u8FD0\u8D39\uFF08\u7528 freight.calc\uFF09\u3001\u67E5\u8BA2\u5355\u5C65\u7EA6\uFF08\u7528 order.lookup\uFF09\u3002",
  parameters: {
    skuId: { type: "string", required: true, description: "SKU \u7F16\u7801\uFF0C\u5982 SKU-88213" },
    qty: { type: "integer", required: true, description: "\u91C7\u8D2D\u6570\u91CF\uFF0C\u5FC5\u987B > 0" }
  },
  output: {
    schema: { type: "object", additionalProperties: true },
    render: (_args, value) => {
      const v = value;
      const d = v.data;
      return renderLines(
        [
          `\u62A5\u4EF7 ${d.skuId} \xD7 ${d.qty}\uFF1A\u547D\u4E2D\u9636\u68AF [${d.tier.low}, ${d.tier.high ?? "\u221E"}]\uFF0C\u5355\u4EF7 ${d.unitPrice}`,
          `\u91D1\u989D\uFF08DECIMAL 18,4 \u2192 HALF_UP 2 \u4F4D\uFF09= ${d.amount}\uFF1B\u7A0E\u7387 ${d.taxRate}\uFF08${d.taxSource}\uFF09\uFF0C\u7A0E\u989D ${d.taxAmount}`
        ],
        v.provenance
      );
    }
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id);
    const { skuId, qty } = args;
    if (!Number.isInteger(qty) || qty <= 0) {
      throw invalid("qty \u5FC5\u987B\u662F\u5927\u4E8E 0 \u7684\u6574\u6570", { qty });
    }
    const row = one("select id, tenant_id, name, price_tiers, moq, volume from skus where id = ?", [skuId]);
    if (!row) throw notFound(`SKU \u4E0D\u5B58\u5728\uFF1A${skuId}`, { skuId });
    if (row.tenant_id !== identity.tenantId) {
      throw denied(`POLICY_DENIED: SKU ${skuId} \u4E0D\u5C5E\u4E8E\u5F53\u524D\u79DF\u6237 ${identity.tenantId}`, { skuId });
    }
    const tier = pickTier(parseTiers(row.price_tiers), qty);
    if (!tier) throw invalid(`\u6570\u91CF ${qty} \u672A\u843D\u5728\u4EFB\u4F55\u9636\u68AF\u4EF7\u533A\u95F4\uFF08\u533A\u95F4\u4ECE ${row.moq ? 1 : 1} \u8D77\uFF09`, { skuId, qty });
    const unitPrice = toFixed(tier.price);
    const amount = mulIntFixed(qty, unitPrice);
    const { rate, source } = vatRate();
    const tax = mulFixed(amount, toFixed(rate));
    return {
      data: {
        skuId: row.id,
        skuName: row.name,
        qty,
        tier: { low: tier.low, high: tier.high, price: fixedToString(unitPrice, 2) },
        unitPrice: fixedToString(unitPrice, 2),
        amount: fixedToString(amount, 2),
        amountReadable: formatMoney(amount),
        taxRate: fixedToString(toFixed(rate), 4),
        taxSource: source,
        taxAmount: fixedToString(tax, 2)
      },
      provenance: [prov("skus", row.id, ["price_tiers", "moq"])]
    };
  }
});
export {
  parseTiers,
  pickTier,
  pricingQuote,
  vatRate
};
//# sourceMappingURL=pricing-quote.js.map
