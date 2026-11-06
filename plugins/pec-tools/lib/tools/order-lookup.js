import { defineTool } from "@deepseek-ai/dsh-tools";
import { all, one } from "../db.js";
import { denied, invalid, notFound } from "../errors.js";
import { dayDiff } from "../core/money.js";
import { prov, renderLines } from "../core/provenance.js";
import { resolveIdentity } from "../policy/identity.js";
import { writeAudit } from "../policy/audit.js";
import { rememberSession } from "../memory/store.js";
const SELECT = `
  select o.id, o.tenant_id, o.supplier_id, o.sku_id, o.qty, o.unit_price,
         o.ordered_at, o.promised_at, o.delivered_at, o.status, o.freight_rate, o.volume,
         s.name as supplier_name, s.risk_level, s.blacklisted, s.delay_days_12m,
         k.name as sku_name, k.safety_stock, k.on_hand, k.in_transit, k.moq
  from orders o
  join suppliers s on s.id = o.supplier_id
  join skus k on k.id = o.sku_id
`;
function mapOrder(row) {
  const delayDays = row.delivered_at ? dayDiff(row.promised_at, row.delivered_at) : null;
  return {
    orderId: row.id,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    riskLevel: row.risk_level,
    blacklisted: Boolean(row.blacklisted),
    delayDays12m: row.delay_days_12m,
    skuId: row.sku_id,
    skuName: row.sku_name,
    qty: row.qty,
    unitPrice: row.unit_price.toFixed(2),
    orderedAt: row.ordered_at,
    promisedAt: row.promised_at,
    deliveredAt: row.delivered_at,
    status: row.status,
    freightRate: row.freight_rate.toFixed(2),
    volume: row.volume.toFixed(2),
    delayDays,
    isDelayed: row.status === "DELAYED" || (delayDays ?? 0) > 0,
    stock: {
      onHand: row.on_hand,
      inTransit: row.in_transit,
      safetyStock: row.safety_stock,
      moq: row.moq,
      belowSafety: row.on_hand + row.in_transit < row.safety_stock
    }
  };
}
function renderOrder(order, refs) {
  const stock = order.stock;
  return [
    `\u8BA2\u5355 ${order.orderId}\uFF1A\u72B6\u6001 ${order.status}\uFF1B\u4F9B\u5E94\u5546 ${order.supplierId} ${order.supplierName}\uFF08${order.riskLevel} \u7EA7\uFF0C\u9ED1\u540D\u5355${order.blacklisted ? "\u662F" : "\u5426"}\uFF0C\u8FD1 12 \u6708\u5EF6\u8FDF ${order.delayDays12m} \u5929\uFF09`,
    `  SKU ${order.skuId} ${order.skuName} \xD7 ${order.qty}\uFF0C\u5355\u4EF7 ${order.unitPrice}\uFF1B\u4E0B\u5355 ${order.orderedAt}\uFF0C\u627F\u8BFA\u4EA4\u671F ${order.promisedAt}\uFF0C\u5B9E\u9645\u4EA4\u671F ${order.deliveredAt ?? "\u672A\u4EA4\u4ED8"}`,
    `  \u5EF6\u8FDF\u5929\u6570 ${order.delayDays ?? "N/A"}\uFF1B\u4F53\u79EF ${order.volume}\uFF1B\u7269\u6D41\u5355\u4EF7 ${order.freightRate}`,
    `  \u5E93\u5B58\uFF1A\u5F53\u524D ${stock.onHand} + \u5728\u9014 ${stock.inTransit}\uFF0C\u5B89\u5168\u5E93\u5B58 ${stock.safetyStock}\uFF0CMOQ ${stock.moq}${stock.belowSafety ? "\uFF08\u4F4E\u4E8E\u5B89\u5168\u5E93\u5B58\uFF09" : ""}`
  ];
}
const orderLookup = defineTool({
  name: "order_lookup",
  description: "\u6309\u8BA2\u5355\u53F7\u3001SKU \u6216\u4F9B\u5E94\u5546\u67E5\u8BE2\u91C7\u8D2D\u8BA2\u5355\u7684\u5C65\u7EA6\u4FE1\u606F\uFF08\u627F\u8BFA/\u5B9E\u9645\u4EA4\u671F\u3001\u5EF6\u8FDF\u5929\u6570\u3001\u72B6\u6001\u3001\u5E93\u5B58\u4E0E\u5728\u9014\uFF09\u3002\u9002\u7528\uFF1A\u9700\u8981\u8BA2\u5355\u4E8B\u5B9E\u4E0E\u5E93\u5B58\u4E8B\u5B9E\u65F6\uFF1B\u4E0D\u9002\u7528\uFF1A\u7B97\u91D1\u989D/\u7A0E\u989D\uFF08\u7528 pricing.quote\uFF09\u3001\u7B97\u8FD0\u8D39\uFF08\u7528 freight.calc\uFF09\u3001\u67E5\u4F9B\u5E94\u5546\u753B\u50CF\uFF08\u7528 supplier.profile\uFF09\u3002",
  parameters: {
    orderId: { type: "string", description: "\u91C7\u8D2D\u8BA2\u5355\u53F7\uFF0C\u5982 PO-20261013-0042" },
    skuId: { type: "string", description: "SKU \u7F16\u7801\uFF0C\u5982 SKU-88213\uFF1B\u4E0E supplierId \u81F3\u5C11\u7ED9\u4E00\u4E2A\u67E5\u8BE2\u6761\u4EF6" },
    supplierId: { type: "string", description: "\u4F9B\u5E94\u5546\u7F16\u7801\uFF0C\u5982 SUP-1042" },
    tenantId: {
      type: "string",
      description: "\u8FD0\u884C\u65F6\u6CE8\u5165\u7684\u79DF\u6237\uFF1B\u6A21\u578B\u4E0D\u53EF\u81EA\u586B\u3002\u672C\u5B9E\u73B0\u4EE5\u670D\u52A1\u7AEF\u8EAB\u4EFD\u4E3A\u51C6\uFF0C\u4F20\u9519\u4F1A\u88AB guard \u62D2\u7EDD"
    }
  },
  output: {
    schema: { type: "object", additionalProperties: true },
    render: (_args, value) => {
      const v = value;
      const lines = [];
      for (const order of v.data.orders) {
        lines.push(...renderOrder(order, v.provenance));
        lines.push("");
      }
      if (lines.length === 0) lines.push("\u672A\u627E\u5230\u7B26\u5408\u6761\u4EF6\u7684\u8BA2\u5355\u3002");
      return renderLines([lines.join("\n").trim()], v.provenance);
    }
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id);
    const sessionId = exec?.agent?.session?.id;
    const { orderId, skuId, supplierId } = args;
    if (!orderId && !skuId && !supplierId) {
      throw invalid("\u81F3\u5C11\u63D0\u4F9B orderId\u3001skuId\u3001supplierId \u4E4B\u4E00");
    }
    if (orderId) {
      const head = one("select tenant_id from orders where id = ?", [orderId]);
      if (!head) throw notFound(`\u8BA2\u5355\u4E0D\u5B58\u5728\uFF1A${orderId}`, { orderId });
      if (head.tenant_id !== identity.tenantId) {
        writeAudit({
          event: "deny",
          reason: "cross-tenant-order",
          tool: "order_lookup",
          sessionId,
          userId: identity.userId,
          tenantId: identity.tenantId,
          resource: `orders#${orderId}`,
          ownerTenant: head.tenant_id
        });
        throw denied(`POLICY_DENIED: \u8BA2\u5355 ${orderId} \u4E0D\u5C5E\u4E8E\u5F53\u524D\u79DF\u6237 ${identity.tenantId}`, { orderId });
      }
    }
    if (skuId && !orderId) {
      const head = one("select tenant_id from skus where id = ?", [skuId]);
      if (!head) throw notFound(`SKU \u4E0D\u5B58\u5728\uFF1A${skuId}`, { skuId });
      if (head.tenant_id !== identity.tenantId) throw denied(`POLICY_DENIED: SKU \u4E0D\u5C5E\u4E8E\u5F53\u524D\u79DF\u6237`, { skuId });
    }
    if (supplierId && !orderId) {
      const head = one("select tenant_id from suppliers where id = ?", [supplierId]);
      if (!head) throw notFound(`\u4F9B\u5E94\u5546\u4E0D\u5B58\u5728\uFF1A${supplierId}`, { supplierId });
      if (head.tenant_id !== identity.tenantId) throw denied(`POLICY_DENIED: \u4F9B\u5E94\u5546\u4E0D\u5C5E\u4E8E\u5F53\u524D\u79DF\u6237`, { supplierId });
    }
    const where = ["o.tenant_id = ?"];
    const params = [identity.tenantId];
    if (orderId) {
      where.push("o.id = ?");
      params.push(orderId);
    }
    if (skuId) {
      where.push("o.sku_id = ?");
      params.push(skuId);
    }
    if (supplierId) {
      where.push("o.supplier_id = ?");
      params.push(supplierId);
    }
    const rows = all(`${SELECT} where ${where.join(" and ")} order by o.id limit 50`, params);
    const orders = rows.map(mapOrder);
    const provenance = [];
    for (const row of rows) {
      provenance.push(
        prov("orders", row.id, ["promised_at", "delivered_at", "status", "qty", "unit_price"]),
        prov("suppliers", row.supplier_id, ["risk_level", "blacklisted", "delay_days_12m"]),
        prov("skus", row.sku_id, ["safety_stock", "on_hand", "in_transit", "moq"])
      );
    }
    if (orders.length === 1 && sessionId) {
      rememberSession(identity, sessionId, {
        lastOrderId: orders[0].orderId,
        lastSupplierId: orders[0].supplierId,
        lastSkuId: orders[0].skuId,
        lastExceptionType: orders[0].isDelayed ? "DELAY" : void 0
      });
    }
    return { data: { orders }, provenance };
  }
});
export {
  orderLookup
};
//# sourceMappingURL=order-lookup.js.map
