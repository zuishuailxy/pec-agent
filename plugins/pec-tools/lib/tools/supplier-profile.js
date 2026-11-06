import { defineTool } from "@deepseek-ai/dsh-tools";
import { one } from "../db.js";
import { denied, notFound } from "../errors.js";
import { prov, renderLines } from "../core/provenance.js";
import { resolveIdentity } from "../policy/identity.js";
import { maskContacts, policyFor } from "../policy/masking.js";
import { writeAudit } from "../policy/audit.js";
const LEVEL_POINTS = { A: 0, B: 5, C: 10, D: 15 };
function riskScore(row) {
  if (row.blacklisted) return 100;
  const delay = row.delay_days_12m;
  if (delay > 10) return Math.min(100, 70 + Math.min(30, delay - 10));
  return Math.min(69, 20 + 4 * delay + (LEVEL_POINTS[row.risk_level] ?? 0));
}
const supplierProfile = defineTool({
  name: "supplier_profile",
  description: "\u67E5\u8BE2\u4F9B\u5E94\u5546\u753B\u50CF\uFF1A\u7B49\u7EA7\u3001\u9ED1\u540D\u5355\u3001\u8FD1 12 \u6708\u5EF6\u8FDF\u5929\u6570\u3001\u98CE\u9669\u5206\u3001\u9884\u8B66\u8054\u7CFB\u4EBA\u3002\u9002\u7528\uFF1A\u8BC4\u4F30\u4F9B\u5E94\u5546\u98CE\u9669\u4E0E\u9ED1\u540D\u5355\u72B6\u6001\u65F6\uFF1B\u4E0D\u9002\u7528\uFF1A\u67E5\u8BA2\u5355\u5C65\u7EA6\uFF08\u7528 order.lookup\uFF09\u3001\u7B97\u91D1\u989D\uFF08\u7528 pricing.quote\uFF09\u3002\u8054\u7CFB\u4EBA\u6309\u8C03\u7528\u8005\u89D2\u8272\u8131\u654F\u3002",
  parameters: {
    supplierId: { type: "string", required: true, description: "\u4F9B\u5E94\u5546\u7F16\u7801\uFF0C\u5982 SUP-1042" },
    tenantId: { type: "string", description: "\u8FD0\u884C\u65F6\u6CE8\u5165\u7684\u79DF\u6237\uFF1B\u6A21\u578B\u4E0D\u53EF\u81EA\u586B" }
  },
  output: {
    schema: { type: "object", additionalProperties: true },
    render: (_args, value) => {
      const v = value;
      const s = v.data;
      const lines = [
        `\u4F9B\u5E94\u5546 ${s.supplierId} ${s.supplierName}\uFF1A${s.riskLevel} \u7EA7\uFF0C\u98CE\u9669\u5206 ${s.riskScore}\uFF0C\u9ED1\u540D\u5355${s.blacklisted ? "\u662F" : "\u5426"}\uFF0C\u8FD1 12 \u6708\u5EF6\u8FDF ${s.delayDays12m} \u5929`,
        `\u98CE\u9669\u53E3\u5F84\uFF1A${s.riskScoreRule}`,
        `\u9884\u8B66\u8054\u7CFB\u4EBA\uFF08${s.contactsAccess === "full" ? "\u5168\u91CF" : s.contactsAccess === "masked" ? "\u5DF2\u8131\u654F" : "\u4E0D\u53EF\u89C1"}\uFF09\uFF1A${s.contacts.length ? s.contacts.map((c) => `${c.name} ${c.phone}`).join("\uFF1B") : "\u65E0"}`
      ];
      return renderLines(lines, v.provenance);
    }
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id);
    const { supplierId } = args;
    const row = one(
      "select id, tenant_id, name, risk_level, blacklisted, delay_days_12m, contacts from suppliers where id = ?",
      [supplierId]
    );
    if (!row) throw notFound(`\u4F9B\u5E94\u5546\u4E0D\u5B58\u5728\uFF1A${supplierId}`, { supplierId });
    if (row.tenant_id !== identity.tenantId) {
      writeAudit({
        event: "deny",
        reason: "cross-tenant-supplier",
        tool: "supplier_profile",
        userId: identity.userId,
        tenantId: identity.tenantId,
        resource: `suppliers#${supplierId}`,
        ownerTenant: row.tenant_id
      });
      throw denied(`POLICY_DENIED: \u4F9B\u5E94\u5546 ${supplierId} \u4E0D\u5C5E\u4E8E\u5F53\u524D\u79DF\u6237 ${identity.tenantId}`, { supplierId });
    }
    const access = policyFor(identity.role).supplierContacts;
    const contacts = maskContacts(identity.role, JSON.parse(row.contacts), {
      tool: "supplier_profile",
      userId: identity.userId,
      tenantId: identity.tenantId,
      resource: `suppliers#${supplierId}`
    });
    const data = {
      supplierId: row.id,
      supplierName: row.name,
      riskLevel: row.risk_level,
      blacklisted: Boolean(row.blacklisted),
      delayDays12m: row.delay_days_12m,
      riskScore: riskScore(row),
      riskScoreRule: "blacklist=100\uFF1Bdelay>10 \u2192 70+min(30,delay-10)\uFF1Belse 20+4\xD7delay+level(A0/B5/C10/D15)\uFF08\u81EA\u5B9A\u53E3\u5F84\uFF0C\u9898\u9762\u65E0\u5B57\u6BB5\uFF09",
      contactsAccess: access,
      contacts
    };
    return {
      data,
      provenance: [prov("suppliers", row.id, ["risk_level", "blacklisted", "delay_days_12m", "contacts"])]
    };
  }
});
export {
  riskScore,
  supplierProfile
};
//# sourceMappingURL=supplier-profile.js.map
