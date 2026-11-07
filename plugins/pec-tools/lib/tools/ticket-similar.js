import { defineTool } from "@deepseek-ai/dsh-tools";
import { all, one } from "../db.js";
import { denied, invalid, notFound } from "../errors.js";
import { fixedToString, toFixed } from "../core/money.js";
import { prov, renderLines } from "../core/provenance.js";
import { resolveIdentity } from "../policy/identity.js";
import { writeAudit } from "../policy/audit.js";
import { rememberSession } from "../memory/store.js";
const TYPE_ALIASES = {
  DELAY: "DELAY",
  DELAYED: "DELAY",
  \u5EF6\u8FDF: "DELAY",
  \u4EA4\u671F\u5EF6\u8FDF: "DELAY",
  \u5EF6\u671F: "DELAY",
  \u903E\u671F: "DELAY",
  STOCK: "STOCK",
  \u7F3A\u8D27: "STOCK",
  \u5E93\u5B58\u4E0D\u8DB3: "STOCK",
  \u5E93\u5B58: "STOCK",
  PRICE: "PRICE",
  \u4EF7\u683C: "PRICE",
  \u4EF7\u683C\u5F02\u52A8: "PRICE",
  \u6DA8\u4EF7: "PRICE",
  \u964D\u4EF7: "PRICE",
  FREIGHT: "FREIGHT",
  \u8FD0\u8D39: "FREIGHT",
  \u8FD0\u8D39\u5F02\u5E38: "FREIGHT",
  \u7269\u6D41\u8D39: "FREIGHT",
  RISK: "RISK",
  \u98CE\u9669: "RISK",
  \u4F9B\u5E94\u5546\u98CE\u9669: "RISK",
  \u98CE\u9669\u9884\u8B66: "RISK"
};
const VALID_EXCEPTION_TYPES = ["DELAY", "STOCK", "PRICE", "FREIGHT", "RISK"];
function normalizeExceptionType(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw invalid(`exceptionType \u5FC5\u586B\uFF0C\u53EF\u9009\u503C\uFF1A${VALID_EXCEPTION_TYPES.join(" / ")}`);
  const normalized = TYPE_ALIASES[raw.toUpperCase()] ?? TYPE_ALIASES[raw];
  if (!normalized) {
    throw invalid(`\u672A\u77E5\u5F02\u5E38\u7C7B\u578B\u300C${raw}\u300D\uFF0C\u53EF\u9009\u503C\uFF1A${VALID_EXCEPTION_TYPES.join(" / ")}\uFF08\u652F\u6301\u4E2D\u6587\u522B\u540D\uFF1A\u5EF6\u8FDF/\u7F3A\u8D27/\u4EF7\u683C/\u8FD0\u8D39/\u98CE\u9669\uFF09`);
  }
  return normalized;
}
function optionalAmount(value, name) {
  if (value === void 0 || value === null) return void 0;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) throw invalid(`${name} \u5FC5\u987B\u662F\u975E\u8D1F\u6570\u5B57\uFF08\u5143\uFF09`);
  return amount;
}
function amountDistance(amount, min, max) {
  if (amount < min) return min - amount;
  if (amount > max) return amount - max;
  return 0;
}
function amountProximity(amount, min, max) {
  const distance = amountDistance(amount, min, max);
  if (distance === 0) return 1;
  const span = Number.isFinite(max) && max > min ? max - min : Number.isFinite(max) ? max : Math.max(min, 1);
  return Math.max(0, 1 - distance / Math.max(span, 1));
}
function amountText(value) {
  return fixedToString(toFixed(value));
}
function rangeText(query) {
  if (query.amountMin === void 0 && query.amountMax === void 0) return "\u672A\u9650\u5B9A\u91D1\u989D\u533A\u95F4";
  const min = query.amountMin ?? "0.00";
  const max = query.amountMax ?? "\u4E0D\u9650";
  return `\u91D1\u989D\u533A\u95F4 [${min}, ${max}]\uFF08\u542B\u8FB9\u754C\uFF09`;
}
function sortedActionText(counts) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([action, count]) => `${action}\xD7${count}`).join(" / ");
}
const ticketSimilar = defineTool({
  name: "ticket_similar",
  description: "\u6309\u5F02\u5E38\u7C7B\u578B + \u4F9B\u5E94\u5546 + \u91D1\u989D\u533A\u95F4\u53EC\u56DE\u5386\u53F2\u5DE5\u5355\uFF0C\u8FD4\u56DE\u76F8\u4F3C\u5EA6\u3001\u5904\u7F6E\u52A8\u4F5C\u3001\u7ED3\u8BBA\u3001\u8017\u65F6\u4E0E\u662F\u5426\u4EBA\u5DE5\u6539\u5224\uFF08\u53EA\u8BFB\uFF0C\u6309\u79DF\u6237\u9694\u79BB\uFF0C\u7ED3\u679C\u5E26\u6765\u6E90\uFF09\u3002\u9002\u7528\uFF1A\u9700\u8981\u53C2\u8003\u8FC7\u53BB\u540C\u7C7B\u5F02\u5E38\u600E\u4E48\u5904\u7406\u3001\u6C89\u6DC0\u6280\u80FD\u3001\u9A8C\u8BC1\u5904\u7F6E\u53E3\u5F84\u65F6\uFF1B\u4E0D\u9002\u7528\uFF1A\u67E5\u8BA2\u5355\u4E8B\u5B9E\uFF08\u7528 order_lookup\uFF09\u3001\u67E5\u5408\u540C\u6761\u6B3E\uFF08\u7528 contract_search\uFF09\u3001\u7B97\u91D1\u989D/\u8FD0\u8D39\uFF08\u7528 pricing_quote / freight_calc\uFF09\u3002\u5386\u53F2\u5DE5\u5355\u53EA\u662F\u53C2\u8003\uFF0C\u4E0D\u662F\u5F53\u524D\u8BA2\u5355\u7ED3\u8BBA\u3002",
  parameters: {
    exceptionType: {
      type: "string",
      required: true,
      description: "\u5F02\u5E38\u7C7B\u578B\uFF1ADELAY / STOCK / PRICE / FREIGHT / RISK\uFF08\u4E5F\u63A5\u53D7\u4E2D\u6587\u522B\u540D\uFF1A\u5EF6\u8FDF/\u7F3A\u8D27/\u4EF7\u683C/\u8FD0\u8D39/\u98CE\u9669\uFF09"
    },
    orderId: {
      type: "string",
      description: "\u53EF\u9009\uFF1A\u5F53\u524D\u5904\u7406\u4E2D\u7684\u8BA2\u5355\u53F7\u3002\u7ED9\u5B9A\u65F6\u81EA\u52A8\u6D3E\u751F\u4F9B\u5E94\u5546\uFF0C\u8FD4\u56DE\u8BA2\u5355\u4E0A\u4E0B\u6587 provenance\uFF1B\u8BA2\u5355\u5FC5\u987B\u5C5E\u5F53\u524D\u79DF\u6237"
    },
    supplierId: { type: "string", description: "\u53EF\u9009\uFF1A\u4F9B\u5E94\u5546\u7F16\u7801\uFF0C\u5982 SUP-1050\uFF1B\u4E0E orderId \u6D3E\u751F\u503C\u51B2\u7A81\u4F1A\u62D2\u7EDD" },
    amountMin: { type: "number", description: "\u53EF\u9009\uFF1A\u91D1\u989D\u533A\u95F4\u4E0B\u9650\uFF08\u5143\uFF0C\u542B\u8FB9\u754C\uFF09" },
    amountMax: { type: "number", description: "\u53EF\u9009\uFF1A\u91D1\u989D\u533A\u95F4\u4E0A\u9650\uFF08\u5143\uFF0C\u542B\u8FB9\u754C\uFF09" },
    limit: { type: "integer", description: "\u53EF\u9009\uFF1A\u6700\u591A\u8FD4\u56DE\u591A\u5C11\u4E2A\u8BA2\u5355\uFF08\u53BB\u91CD\u540E\uFF09\uFF0C\u9ED8\u8BA4 5\uFF0C\u6700\u5927 20" },
    tenantId: {
      type: "string",
      description: "\u8FD0\u884C\u65F6\u6CE8\u5165\u7684\u79DF\u6237\uFF1B\u6A21\u578B\u4E0D\u53EF\u81EA\u586B\u3002\u672C\u5B9E\u73B0\u4EE5\u670D\u52A1\u7AEF\u8EAB\u4EFD\u4E3A\u51C6\uFF0C\u4F20\u9519\u4F1A\u88AB guard \u62D2\u7EDD"
    }
  },
  output: {
    schema: { type: "object", additionalProperties: true },
    render: (_args, value) => {
      const v = value;
      const d = v.data;
      if (!d.found) {
        return renderLines(
          [
            `\u672A\u53EC\u56DE\u76F8\u4F3C\u5386\u53F2\u5DE5\u5355\uFF08\u5F02\u5E38\u7C7B\u578B ${d.query.exceptionType}${d.query.supplierId ? `\uFF1B\u4F9B\u5E94\u5546 ${d.query.supplierId}` : ""}\uFF1B${rangeText(d.query)}\uFF09\u3002\u5386\u53F2\u5E93\u4E2D\u6CA1\u6709\u53EF\u590D\u7528\u7684\u540C\u7C7B\u5904\u7F6E\u8BB0\u5F55\uFF0C\u4E0D\u5F97\u7F16\u9020\u5386\u53F2\u52A8\u4F5C\u6216\u8017\u65F6\u3002`
          ],
          v.provenance
        );
      }
      const lines = [];
      lines.push(
        `\u53EC\u56DE ${d.totalTickets} \u6761\u5386\u53F2\u5DE5\u5355 / \u805A\u5408\u4E3A ${d.totalOrders} \u4E2A\u8BA2\u5355\uFF08\u5F02\u5E38\u7C7B\u578B ${d.query.exceptionType}${d.query.supplierId ? `\uFF1B\u4F9B\u5E94\u5546 ${d.query.supplierId}` : ""}\uFF1B${rangeText(d.query)}\uFF09\uFF1A\u4E25\u683C\u5339\u914D ${d.strictCount} \u4E2A\u8BA2\u5355\uFF0C\u653E\u5BBD ${d.relaxedCount} \u4E2A\u8BA2\u5355\uFF0C\u5C55\u793A ${d.returned} \u4E2A\u3002`
      );
      for (const item of d.tickets) {
        const extra = [];
        if (item.sameOrderTickets > 1) {
          extra.push(`\u540C\u8BA2\u5355\u540C\u7C7B\u5DE5\u5355 ${item.sameOrderTickets} \u6761\uFF08${sortedActionText(item.sameOrderActionCounts)}\uFF0C\u4EBA\u5DE5\u6539\u5224 ${item.sameOrderOverridden} \u6761\uFF09`);
        }
        if (item.relaxedOn.length > 0) extra.push(`\u653E\u5BBD\u7EF4\u5EA6\uFF1A${item.relaxedOn.join(" / ")}`);
        lines.push(
          `- ${item.ticketId} / \u8BA2\u5355 ${item.orderId}\uFF08${item.supplierId} ${item.supplierName}\uFF0C\u91D1\u989D ${item.amount}\uFF0C\u72B6\u6001 ${item.status}\uFF09\uFF1A\u76F8\u4F3C\u5EA6 ${item.similarity}\uFF1B\u5904\u7F6E ${item.action}\uFF1B\u7ED3\u8BBA\u300C${item.outcome}\u300D\uFF1B\u8017\u65F6 ${item.minutes} \u5206\u949F\uFF1B\u4EBA\u5DE5\u6539\u5224 ${item.overridden ? "\u662F" : "\u5426"}${extra.length ? `\uFF1B${extra.join("\uFF1B")}` : ""}`
        );
      }
      lines.push(
        `\u5386\u53F2\u7EDF\u8BA1\uFF1A\u5E73\u5747\u8017\u65F6 ${d.stats.avgMinutes} \u5206\u949F\uFF1B\u4EBA\u5DE5\u6539\u5224 ${d.stats.overriddenTickets}/${d.totalTickets} \u6761\uFF1B\u52A8\u4F5C\u5206\u5E03 ${sortedActionText(d.stats.actionCounts)}\uFF1B\u6D89\u53CA\u4F9B\u5E94\u5546 ${d.stats.supplierCount} \u5BB6\u3002\u4EE5\u4E0A\u662F\u5386\u53F2\u5904\u7F6E\u53C2\u8003\uFF0C\u5F15\u7528\u6570\u503C\u5FC5\u987B\u5E26\u6765\u6E90\u3002`
      );
      return renderLines(lines, v.provenance);
    }
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id);
    const sessionId = exec?.agent?.session?.id;
    const a = args;
    const exceptionType = normalizeExceptionType(a.exceptionType);
    const amountMin = optionalAmount(a.amountMin, "amountMin");
    const amountMax = optionalAmount(a.amountMax, "amountMax");
    if (amountMin !== void 0 && amountMax !== void 0 && amountMin > amountMax) {
      throw invalid(`amountMin(${amountMin}) \u4E0D\u80FD\u5927\u4E8E amountMax(${amountMax})`);
    }
    const limit = a.limit === void 0 ? 5 : Number(a.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw invalid("limit \u5FC5\u987B\u662F 1\u201320 \u7684\u6574\u6570");
    let orderContext;
    let supplierId = a.supplierId?.trim() || void 0;
    if (a.orderId) {
      const order = one(
        `select o.id, o.tenant_id, o.supplier_id, o.amount, o.status, s.name as supplier_name
           from orders o join suppliers s on s.id = o.supplier_id
          where o.id = ?`,
        [String(a.orderId)]
      );
      if (!order) throw notFound(`\u8BA2\u5355\u4E0D\u5B58\u5728\uFF1A${a.orderId}`, { orderId: a.orderId });
      if (order.tenant_id !== identity.tenantId) {
        writeAudit({
          event: "deny",
          reason: "cross-tenant-order",
          tool: "ticket_similar",
          sessionId,
          userId: identity.userId,
          tenantId: identity.tenantId,
          resource: `orders#${order.id}`,
          ownerTenant: order.tenant_id
        });
        throw denied(`POLICY_DENIED: \u8BA2\u5355 ${order.id} \u4E0D\u5C5E\u4E8E\u5F53\u524D\u79DF\u6237 ${identity.tenantId}`, { orderId: order.id });
      }
      if (supplierId && supplierId !== order.supplier_id) {
        throw invalid(`orderId ${order.id} \u7684\u4F9B\u5E94\u5546\u662F ${order.supplier_id}\uFF0C\u4E0E\u4F20\u5165 supplierId ${supplierId} \u4E0D\u4E00\u81F4`);
      }
      supplierId = order.supplier_id;
      orderContext = {
        orderId: order.id,
        supplierId: order.supplier_id,
        supplierName: order.supplier_name,
        amount: amountText(order.amount),
        status: order.status
      };
    }
    if (supplierId) {
      const supplier = one(
        "select id, tenant_id, name from suppliers where id = ?",
        [supplierId]
      );
      if (!supplier) throw notFound(`\u4F9B\u5E94\u5546\u4E0D\u5B58\u5728\uFF1A${supplierId}`, { supplierId });
      if (supplier.tenant_id !== identity.tenantId) {
        writeAudit({
          event: "deny",
          reason: "cross-tenant-supplier",
          tool: "ticket_similar",
          sessionId,
          userId: identity.userId,
          tenantId: identity.tenantId,
          resource: `suppliers#${supplierId}`,
          ownerTenant: supplier.tenant_id
        });
        throw denied(`POLICY_DENIED: \u4F9B\u5E94\u5546 ${supplierId} \u4E0D\u5C5E\u4E8E\u5F53\u524D\u79DF\u6237 ${identity.tenantId}`, { supplierId });
      }
    }
    const rows = all(
      `select t.id, t.order_id, t.tenant_id, t.exception_type, t.action, t.outcome,
              t.minutes, t.overridden,
              o.supplier_id, s.name as supplier_name, o.amount, o.status
         from tickets t
         join orders o on o.id = t.order_id
         join suppliers s on s.id = o.supplier_id
        where t.tenant_id = ? and t.exception_type = ?
        order by t.id`,
      [identity.tenantId, exceptionType]
    );
    const hasAmountRange = amountMin !== void 0 || amountMax !== void 0;
    const min = amountMin ?? 0;
    const max = amountMax ?? Number.POSITIVE_INFINITY;
    const weightTotal = 40 + (supplierId ? 30 : 0) + (hasAmountRange ? 30 : 0);
    const scored = rows.map((row) => {
      const supplierMatched = supplierId ? row.supplier_id === supplierId : null;
      const proximity = hasAmountRange ? amountProximity(row.amount, min, max) : null;
      const matchedOn = ["exceptionType"];
      const relaxedOn = [];
      let hitWeight = 40;
      if (supplierMatched === true) {
        hitWeight += 30;
        matchedOn.push("supplier");
      } else if (supplierMatched === false) {
        relaxedOn.push("supplier");
      }
      if (proximity !== null) {
        hitWeight += 30 * proximity;
        if (proximity === 1) matchedOn.push("amountRange");
        else relaxedOn.push("amountRange");
      }
      const similarity = Math.round(hitWeight / weightTotal * 100);
      return {
        row,
        similarity,
        strict: relaxedOn.length === 0,
        distance: hasAmountRange ? amountDistance(row.amount, min, max) : 0,
        matchedOn,
        relaxedOn
      };
    });
    scored.sort((x, y) => y.similarity - x.similarity || x.distance - y.distance || x.row.id.localeCompare(y.row.id));
    const groups = /* @__PURE__ */ new Map();
    for (const item of scored) {
      const group = groups.get(item.row.order_id);
      if (group) group.tickets.push(item);
      else groups.set(item.row.order_id, { representative: item, tickets: [item] });
    }
    const orderedGroups = [...groups.values()];
    const strictCount = orderedGroups.filter((group) => group.representative.strict).length;
    const actionCounts = {};
    let minutesSum = 0;
    let overriddenTickets = 0;
    const supplierSet = /* @__PURE__ */ new Set();
    for (const item of scored) {
      const row = item.row;
      actionCounts[row.action] = (actionCounts[row.action] ?? 0) + 1;
      minutesSum += row.minutes;
      overriddenTickets += row.overridden ? 1 : 0;
      supplierSet.add(row.supplier_id);
    }
    const provenance = [];
    for (const item of scored) {
      provenance.push(
        prov("tickets", item.row.id, ["exception_type", "action", "outcome", "minutes", "overridden"]),
        prov("orders", item.row.order_id, ["supplier_id", "amount", "status"]),
        prov("suppliers", item.row.supplier_id, ["name"])
      );
    }
    if (orderContext) {
      provenance.push(prov("orders", String(orderContext.orderId), ["supplier_id", "amount", "status"]));
    }
    const tickets = orderedGroups.slice(0, limit).map((group) => {
      const row = group.representative.row;
      const sameOrderActionCounts = {};
      let sameOrderOverridden = 0;
      for (const item of group.tickets) {
        sameOrderActionCounts[item.row.action] = (sameOrderActionCounts[item.row.action] ?? 0) + 1;
        sameOrderOverridden += item.row.overridden ? 1 : 0;
      }
      return {
        ticketId: row.id,
        orderId: row.order_id,
        exceptionType: row.exception_type,
        action: row.action,
        outcome: row.outcome,
        minutes: row.minutes,
        overridden: Boolean(row.overridden),
        supplierId: row.supplier_id,
        supplierName: row.supplier_name,
        amount: amountText(row.amount),
        status: row.status,
        similarity: group.representative.similarity,
        matchedOn: group.representative.matchedOn,
        relaxedOn: group.representative.relaxedOn,
        sameOrderTickets: group.tickets.length,
        sameOrderActionCounts,
        sameOrderOverridden
      };
    });
    if (tickets.length > 0) {
      const top = tickets[0];
      rememberSession(identity, sessionId, {
        lastTicketId: top.ticketId,
        lastExceptionType: exceptionType,
        lastSupplierId: top.supplierId,
        ...orderContext ? { lastOrderId: orderContext.orderId } : {}
      });
    }
    return {
      data: {
        query: {
          exceptionType,
          ...supplierId ? { supplierId } : {},
          ...amountMin !== void 0 ? { amountMin: amountText(amountMin) } : {},
          ...amountMax !== void 0 ? { amountMax: amountText(amountMax) } : {},
          limit,
          ...a.orderId ? { orderId: String(a.orderId) } : {},
          tenantId: identity.tenantId
        },
        ...orderContext ? { orderContext } : {},
        found: tickets.length > 0,
        ...tickets.length === 0 ? { noHitReason: "NO_HISTORY" } : {},
        totalTickets: scored.length,
        totalOrders: orderedGroups.length,
        strictCount,
        relaxedCount: orderedGroups.length - strictCount,
        returned: tickets.length,
        stats: {
          avgMinutes: scored.length ? Math.round(minutesSum / scored.length * 10) / 10 : 0,
          overriddenTickets,
          overriddenRate: scored.length ? Math.round(overriddenTickets / scored.length * 1e3) / 1e3 : 0,
          actionCounts,
          supplierCount: supplierSet.size
        },
        tickets
      },
      provenance
    };
  }
});
export {
  VALID_EXCEPTION_TYPES,
  normalizeExceptionType,
  ticketSimilar
};
//# sourceMappingURL=ticket-similar.js.map
