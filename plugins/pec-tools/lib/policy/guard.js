import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { resolveIdentity } from "./identity.js";
const DEFAULT_AUDIT = process.env.PEC_AUDIT_PATH || "./runs/audit.jsonl";
function tenantForgeryDecision(args, identity) {
  const argTenant = typeof args.tenantId === "string" && args.tenantId.trim() ? args.tenantId.trim() : void 0;
  if (argTenant && argTenant !== identity.tenantId) {
    return `POLICY_DENIED: \u8DE8\u79DF\u6237\u8BBF\u95EE\u88AB\u62D2\u7EDD\uFF08${identity.tenantId} \u4E0D\u80FD\u8BBF\u95EE ${argTenant}\uFF09`;
  }
  return void 0;
}
function installGuard(ctx, auditPath = DEFAULT_AUDIT) {
  const audit = (entry) => {
    try {
      mkdirSync(dirname(auditPath), { recursive: true });
      appendFileSync(auditPath, JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), ...entry }) + "\n");
    } catch {
    }
  };
  ctx.tools.guard((exec) => {
    let identity;
    try {
      identity = resolveIdentity(exec?.agent?.session?.id);
    } catch (error) {
      audit({
        event: "deny",
        reason: "identity-unavailable",
        tool: exec?.name,
        callId: exec?.callId,
        sessionId: exec?.agent?.session?.id,
        error: String(error)
      });
      return "POLICY_DENIED: \u65E0\u6CD5\u89E3\u6790\u8C03\u7528\u8005\u8EAB\u4EFD";
    }
    const args = exec?.arguments ?? {};
    const decision = tenantForgeryDecision(args, identity);
    if (decision) {
      audit({
        event: "deny",
        reason: "cross-tenant-argument",
        tool: exec?.name,
        callId: exec?.callId,
        sessionId: exec?.agent?.session?.id,
        userId: identity.userId,
        tenantId: identity.tenantId,
        argTenant: args.tenantId
      });
      return decision;
    }
    return void 0;
  });
}
export {
  installGuard,
  tenantForgeryDecision
};
//# sourceMappingURL=guard.js.map
