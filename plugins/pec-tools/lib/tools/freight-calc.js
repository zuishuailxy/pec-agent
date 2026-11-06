import { defineTool } from "@deepseek-ai/dsh-tools";
import { one } from "../db.js";
import { ToolError, denied, eDivZero, notFound } from "../errors.js";
import { ceilInt, divFixed, formatMoney, fixedToString, mulIntFixed, toFixed } from "../core/money.js";
import { prov, renderLines } from "../core/provenance.js";
import { resolveIdentity } from "../policy/identity.js";
const freightCalc = defineTool({
  name: "freight_calc",
  description: "\u6309\u8BA2\u5355\u7684\u4F53\u79EF\u4E0E\u7269\u6D41\u8D39\u5355\u4EF7\u590D\u7B97\u8BA1\u8D39\u4F53\u79EF\u3001\u603B\u8FD0\u8D39\u4E0E\u8BA1\u4EF6\u8FD0\u8D39\uFF08\u7EAF\u51FD\u6570\uFF0C\u4E0D\u8C03\u6A21\u578B\uFF09\u3002\u9002\u7528\uFF1A\u590D\u6838\u8FD0\u8D39\u3001\u9A8C\u8BC1\u4F53\u79EF\u8FDB\u4F4D\u3001\u7B97\u8BA1\u4EF6\u8FD0\u8D39\u65F6\uFF1B\u4E0D\u9002\u7528\uFF1A\u67E5\u8BA2\u5355\u5C65\u7EA6\uFF08\u7528 order.lookup\uFF09\u3001\u7B97\u91D1\u989D/\u7A0E\u989D\uFF08\u7528 pricing.quote\uFF09\u3002qty=0 \u65F6\u8FD4\u56DE E_DIV_ZERO\uFF0C\u4E0D\u8FD4\u56DE 0\u3002",
  parameters: {
    orderId: { type: "string", required: true, description: "\u8BA2\u5355\u53F7\uFF0C\u5982 PO-20261013-0042" },
    qty: { type: "integer", required: true, description: "\u6570\u91CF\uFF1B\u4E3A 0 \u65F6\u8FD4\u56DE E_DIV_ZERO" }
  },
  output: {
    schema: { type: "object", additionalProperties: true },
    render: (_args, value) => {
      const v = value;
      const d = v.data;
      return renderLines(
        [
          `\u8FD0\u8D39\u590D\u7B97 ${d.orderId}\uFF1A\u4F53\u79EF ${d.volume} \u2192 \u8BA1\u8D39\u4F53\u79EF ${d.billedVolume}\uFF08\u5411\u4E0A\u53D6\u6574\uFF09\uFF0C\u7269\u6D41\u5355\u4EF7 ${d.freightRate}`,
          `\u603B\u8FD0\u8D39 = ${d.billedVolume} \xD7 ${d.freightRate} = ${d.totalFreight}\uFF1B\u8BA1\u4EF6\u8FD0\u8D39 = ${d.totalFreight} \xF7 ${d.qty} = ${d.unitFreight ?? "N/A"}`,
          d.warning ? `\u6CE8\u610F\uFF1A${d.warning}` : ""
        ].filter(Boolean),
        v.provenance
      );
    }
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id);
    const { orderId, qty } = args;
    if (!Number.isInteger(qty) || qty < 0) throw new ToolError("INVALID_ARGUMENT", "qty \u5FC5\u987B\u662F >= 0 \u7684\u6574\u6570", { qty });
    const row = one("select id, tenant_id, qty, volume, freight_rate from orders where id = ?", [orderId]);
    if (!row) throw notFound(`\u8BA2\u5355\u4E0D\u5B58\u5728\uFF1A${orderId}`, { orderId });
    if (row.tenant_id !== identity.tenantId) {
      throw denied(`POLICY_DENIED: \u8BA2\u5355 ${orderId} \u4E0D\u5C5E\u4E8E\u5F53\u524D\u79DF\u6237 ${identity.tenantId}`, { orderId });
    }
    const volume = toFixed(row.volume);
    const billedVolume = ceilInt(volume);
    const totalFreight = mulIntFixed(billedVolume, toFixed(row.freight_rate));
    let unitFreight = null;
    if (qty === 0) throw eDivZero("qty = 0\uFF0C\u4E0D\u80FD\u8BA1\u7B97\u8BA1\u4EF6\u8FD0\u8D39\uFF08\u4E0D\u5F97\u8FD4\u56DE 0\uFF09");
    const unit = divFixed(totalFreight, toFixed(qty));
    unitFreight = fixedToString(unit, 2);
    return {
      data: {
        orderId: row.id,
        qty,
        orderQty: row.qty,
        volume: fixedToString(volume, 2),
        billedVolume: Number(billedVolume),
        freightRate: fixedToString(toFixed(row.freight_rate), 2),
        totalFreight: fixedToString(totalFreight, 2),
        totalFreightReadable: formatMoney(totalFreight),
        unitFreight,
        warning: qty !== row.qty ? `\u4F20\u5165 qty=${qty} \u4E0E\u8BA2\u5355 qty=${row.qty} \u4E0D\u4E00\u81F4\uFF0C\u8BA1\u4EF6\u8FD0\u8D39\u6309\u4F20\u5165 qty \u8BA1\u7B97` : void 0
      },
      provenance: [prov("orders", row.id, ["volume", "freight_rate", "qty"])]
    };
  }
});
export {
  freightCalc
};
//# sourceMappingURL=freight-calc.js.map
