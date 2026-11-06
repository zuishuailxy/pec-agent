import { one } from "../db.js";
let cached;
function resolveIdentity(sessionId) {
  if (cached) return cached;
  const candidates = [];
  if (process.env.PEC_USER_ID?.trim()) candidates.push(process.env.PEC_USER_ID.trim());
  candidates.push("U-07");
  for (const userId of candidates) {
    const row2 = one("select id, tenant_id, role from users where id = ?", [userId]);
    if (row2) {
      cached = { userId: row2.id, tenantId: row2.tenant_id, role: row2.role };
      return cached;
    }
  }
  const row = one("select id, tenant_id, role from users order by id limit 1");
  if (!row) throw new Error("PEC_IDENTITY_UNAVAILABLE: users \u8868\u4E3A\u7A7A\u6216\u4E0D\u53EF\u8BFB");
  cached = { userId: row.id, tenantId: row.tenant_id, role: row.role };
  return cached;
}
function resetIdentity() {
  cached = void 0;
}
export {
  resetIdentity,
  resolveIdentity
};
//# sourceMappingURL=identity.js.map
