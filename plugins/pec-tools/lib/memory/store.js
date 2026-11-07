import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeAudit } from "../policy/audit.js";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
const USER_TTL_MS = 90 * 24 * 60 * 60 * 1e3;
const MAX_SESSION_FIELDS = 8;
const MAX_USER_FIELDS = 6;
const SESSION_FIELDS = [
  "lastOrderId",
  "lastSupplierId",
  "lastSkuId",
  "lastExceptionType",
  "lastTicketId",
  "lastClauseNo",
  "currentAction",
  "note"
];
const USER_FIELDS = [
  "focusCategories",
  "commonSuppliers",
  "preferAction",
  "lastOpenTicket",
  "note"
];
function memoryPath() {
  return resolve(process.env.PEC_MEMORY_PATH || "./memory/store.json");
}
function emptyStore() {
  return { version: 1, sessions: {}, users: {} };
}
function loadStore() {
  const path = memoryPath();
  if (!existsSync(path)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return {
      version: 1,
      sessions: parsed.sessions ?? {},
      users: parsed.users ?? {}
    };
  } catch (error) {
    writeAudit({ event: "memory.corrupt", path, error: String(error) });
    return emptyStore();
  }
}
function saveStore(store) {
  const path = memoryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}
`, "utf8");
}
function isExpired(expiresAt, now = Date.now()) {
  const at = Date.parse(expiresAt);
  return Number.isFinite(at) ? at <= now : true;
}
function sessionKey(identity, sessionId) {
  return `${identity.tenantId}:${identity.userId}:${sessionId || "default"}`;
}
function userKey(identity) {
  return `${identity.tenantId}:${identity.userId}`;
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function expire(iso, ttl) {
  return new Date(Date.now() + ttl).toISOString();
}
function pickSessionFields(patch) {
  const picked = {};
  for (const [key, value] of Object.entries(patch)) {
    if (SESSION_FIELDS.includes(key) && value !== void 0) {
      ;
      picked[key] = value;
    }
  }
  return picked;
}
function pickUserFields(patch) {
  const picked = {};
  for (const [key, value] of Object.entries(patch)) {
    if (USER_FIELDS.includes(key) && value !== void 0) {
      ;
      picked[key] = value;
    }
  }
  return picked;
}
function rememberSession(identity, sessionId, patch, source = "tool_inference") {
  const store = loadStore();
  const key = sessionKey(identity, sessionId);
  const current = store.sessions[key];
  const fields = { ...current?.fields ?? {}, ...pickSessionFields(patch) };
  const fieldCount = Object.keys(fields).length;
  if (fieldCount > MAX_SESSION_FIELDS) {
    throw new Error(`INVALID_ARGUMENT: \u4F1A\u8BDD\u8BB0\u5FC6\u5B57\u6BB5\u8D85\u8FC7 ${MAX_SESSION_FIELDS} \u4E2A\u4E0A\u9650`);
  }
  const next = {
    tenantId: identity.tenantId,
    userId: identity.userId,
    sessionId: sessionId || "default",
    fields,
    updatedAt: nowIso(),
    expiresAt: expire("", SESSION_TTL_MS)
  };
  store.sessions[key] = next;
  saveStore(store);
  writeAudit({
    event: "memory.session.updated",
    key,
    fields: Object.keys(patch).filter((key2) => SESSION_FIELDS.includes(key2)),
    source
  });
  return next;
}
function mergeUserField(field, previous, next, source) {
  if (field === "commonSuppliers" || field === "focusCategories") {
    const mergeList = (a, b) => {
      const list = [...Array.isArray(a) ? a : [], ...Array.isArray(b) ? b : []];
      return [...new Set(list.filter((item) => typeof item === "string"))].slice(0, 5);
    };
    return mergeList(previous, next);
  }
  if (field === "preferAction") {
    const before = previous ?? {};
    const delta = next ?? {};
    const merged = { ...before };
    for (const [action, count] of Object.entries(delta)) {
      merged[action] = (merged[action] ?? 0) + (Number(count) || 1);
    }
    return merged;
  }
  if (source === "user_correction") return next;
  return previous ?? next;
}
function rememberUser(identity, patch, options = {}) {
  const source = options.source ?? "tool_inference";
  const store = loadStore();
  const key = userKey(identity);
  const current = store.users[key];
  const incoming = pickUserFields(patch);
  const fields = { ...current?.fields ?? {} };
  const history = [...current?.history ?? []];
  for (const [field, value] of Object.entries(incoming)) {
    const previous = fields[field];
    const merged = mergeUserField(field, previous, value, source);
    if (JSON.stringify(previous) !== JSON.stringify(merged)) {
      history.push({ at: nowIso(), field, previous, next: merged, source });
      writeAudit({ event: "memory.user.updated", key, field, previous, next: merged, source });
    }
    fields[field] = merged;
  }
  if (Object.keys(fields).length > MAX_USER_FIELDS) {
    throw new Error(`INVALID_ARGUMENT: \u7528\u6237\u8BB0\u5FC6\u5B57\u6BB5\u8D85\u8FC7 ${MAX_USER_FIELDS} \u4E2A\u4E0A\u9650`);
  }
  const next = {
    tenantId: identity.tenantId,
    userId: identity.userId,
    role: identity.role,
    fields,
    history: history.slice(-10),
    updatedAt: nowIso(),
    expiresAt: expire("", USER_TTL_MS)
  };
  store.users[key] = next;
  saveStore(store);
  return next;
}
function recallMemory(identity, sessionId, taskHint = "") {
  const store = loadStore();
  const skey = sessionKey(identity, sessionId);
  const ukey = userKey(identity);
  const session = store.sessions[skey];
  const user = store.users[ukey];
  const validSession = session && !isExpired(session.expiresAt) ? session : void 0;
  const validUser = user && !isExpired(user.expiresAt) ? user : void 0;
  if (session && !validSession) writeAudit({ event: "memory.expired", scope: "session", key: skey });
  if (user && !validUser) writeAudit({ event: "memory.expired", scope: "user", key: ukey });
  const injected = [];
  if (validSession) {
    for (const field of SESSION_FIELDS) {
      const value = validSession.fields[field];
      if (value !== void 0 && injected.length < 4) injected.push(`\u4F1A\u8BDD\u8BB0\u5FC6.${field}=${JSON.stringify(value)}`);
    }
  }
  if (validUser) {
    const hint = taskHint.toLowerCase();
    const focus = validUser.fields.focusCategories ?? [];
    const suppliers = validUser.fields.commonSuppliers ?? [];
    for (const supplier of suppliers) {
      if (injected.length < 5 && (hint.includes(supplier.toLowerCase()) || hint.length === 0)) {
        injected.push(`\u7528\u6237\u504F\u597D.\u5E38\u7528\u4F9B\u5E94\u5546=${supplier}`);
      }
    }
    for (const category of focus) {
      if (injected.length < 5 && (hint.includes(category) || hint.length === 0)) {
        injected.push(`\u7528\u6237\u504F\u597D.\u5173\u6CE8\u54C1\u7C7B=${category}`);
      }
    }
    if (validUser.fields.preferAction && injected.length < 5) {
      injected.push(`\u7528\u6237\u504F\u597D.\u5386\u53F2\u5904\u7F6E\u52A8\u4F5C=${JSON.stringify(validUser.fields.preferAction)}`);
    }
    if (validUser.fields.lastOpenTicket && injected.length < 5) {
      injected.push(`\u7528\u6237\u504F\u597D.\u4E0A\u6B21\u5DE5\u5355=${validUser.fields.lastOpenTicket}`);
    }
  }
  return {
    session: validSession ? {
      tenantId: validSession.tenantId,
      userId: validSession.userId,
      sessionId: validSession.sessionId,
      fields: validSession.fields,
      updatedAt: validSession.updatedAt,
      expiresAt: validSession.expiresAt
    } : void 0,
    user: validUser ? {
      tenantId: validUser.tenantId,
      userId: validUser.userId,
      role: validUser.role,
      fields: validUser.fields,
      updatedAt: validUser.updatedAt,
      expiresAt: validUser.expiresAt
    } : void 0,
    injected: injected.slice(0, 5)
  };
}
function forgetMemory(identity, scope, sessionId) {
  const store = loadStore();
  const key = scope === "session" ? sessionKey(identity, sessionId) : userKey(identity);
  const target = scope === "session" ? store.sessions : store.users;
  if (!(key in target)) return false;
  delete target[key];
  saveStore(store);
  writeAudit({ event: "memory.forgotten", scope, key, userId: identity.userId, tenantId: identity.tenantId });
  return true;
}
function memoryStatePath() {
  return memoryPath();
}
export {
  SESSION_FIELDS,
  USER_FIELDS,
  emptyStore,
  forgetMemory,
  loadStore,
  memoryStatePath,
  recallMemory,
  rememberSession,
  rememberUser,
  saveStore,
  sessionKey,
  userKey
};
//# sourceMappingURL=store.js.map
