import { defineTool } from "@deepseek-ai/dsh-tools";
import { invalid } from "../errors.js";
import { resolveIdentity } from "../policy/identity.js";
import { writeAudit } from "../policy/audit.js";
import {
  SESSION_FIELDS,
  USER_FIELDS,
  forgetMemory,
  loadStore,
  memoryStatePath,
  recallMemory,
  rememberSession,
  rememberUser
} from "../memory/store.js";
const SESSION_TTL_DAYS = 7;
const USER_TTL_DAYS = 90;
function agentSessionId(exec) {
  return exec?.agent?.session?.id;
}
function parseScope(raw) {
  const scope = String(raw ?? "both").trim();
  if (scope !== "session" && scope !== "user" && scope !== "both") {
    throw invalid(`scope \u53EF\u9009\u503C\uFF1Asession / user / both\uFF08\u6536\u5230\u300C${scope}\u300D\uFF09`);
  }
  return scope;
}
function validateWhitelist(scope, fields) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw invalid("fields \u5FC5\u987B\u662F\u5BF9\u8C61\uFF08\u5B57\u6BB5\u540D \u2192 \u503C\uFF09");
  const allowed = scope === "session" ? SESSION_FIELDS : USER_FIELDS;
  const keys = Object.keys(fields);
  if (keys.length === 0) throw invalid("fields \u4E0D\u80FD\u4E3A\u7A7A");
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw invalid(
      `fields \u542B\u767D\u540D\u5355\u5916\u5B57\u6BB5\uFF1A${unknown.join(", ")}\uFF1B${scope === "session" ? "\u4F1A\u8BDD" : "\u7528\u6237"}\u8BB0\u5FC6\u767D\u540D\u5355\uFF1A${allowed.join(" / ")}`,
      { unknown, allowed }
    );
  }
  return fields;
}
const memoryRecall = defineTool({
  name: "memory_recall",
  description: "\u8BFB\u53D6\u672C\u4F1A\u8BDD\u8BB0\u5FC6\u4E0E\u5F53\u524D\u7528\u6237\u8BB0\u5FC6\uFF08\u767D\u540D\u5355\u5B57\u6BB5\u3001\u542B TTL \u72B6\u6001\u4E0E\u7528\u6237\u66F4\u6B63 history\uFF09\uFF0C\u8FD4\u56DE\u53EF\u76F4\u63A5\u590D\u7528\u7684 3\u20135 \u6761\u76F8\u5173\u8BB0\u5FC6\u3002\u9002\u7528\uFF1A\u9700\u8981\u56DE\u770B\u5DF2\u77E5\u8BA2\u5355/\u4F9B\u5E94\u5546/\u504F\u597D\u3001\u907F\u514D\u91CD\u590D\u63D0\u95EE\u65F6\uFF1B\u4E0D\u9002\u7528\uFF1A\u67E5\u8BA2\u5355\u4E8B\u5B9E\uFF08\u7528 order_lookup\uFF09\u3001\u67E5\u5386\u53F2\u5DE5\u5355\uFF08\u7528 ticket_similar\uFF09\u3002",
  parameters: {
    scope: { type: "string", description: "\u8BFB\u53D6\u8303\u56F4\uFF1Asession / user / both\uFF08\u9ED8\u8BA4 both\uFF09" },
    taskHint: { type: "string", description: "\u53EF\u9009\uFF1A\u5F53\u524D\u4EFB\u52A1\u63D0\u793A\uFF08\u7528\u4E8E\u6311\u76F8\u5173\u6761\u76EE\uFF0C\u5982\u8BA2\u5355\u53F7/\u4F9B\u5E94\u5546/\u54C1\u7C7B\uFF09" }
  },
  output: {
    schema: { type: "object", additionalProperties: true },
    render: (_args, value) => {
      const v = value;
      const d = v.data;
      const lines = [];
      lines.push(`\u8BB0\u5FC6\u8BFB\u53D6\uFF08${d.scope}\uFF1B\u79DF\u6237 ${d.tenantId}\uFF1B\u7528\u6237 ${d.userId}\uFF1B\u4F1A\u8BDD ${d.sessionId ?? "\u65E0"}\uFF09`);
      if (d.session) {
        lines.push(`\u4F1A\u8BDD\u8BB0\u5FC6\uFF08${Object.keys(d.session.fields).length} \u5B57\u6BB5\uFF0C\u8FC7\u671F ${d.session.expiresAt}\uFF09\uFF1A${JSON.stringify(d.session.fields)}`);
      } else {
        lines.push("\u4F1A\u8BDD\u8BB0\u5FC6\uFF1A\u65E0\uFF08\u6216\u5DF2\u8FC7\u671F/\u672A\u5199\u5165\uFF09");
      }
      if (d.user) {
        lines.push(`\u7528\u6237\u8BB0\u5FC6\uFF08${Object.keys(d.user.fields).length} \u5B57\u6BB5\uFF0C\u8FC7\u671F ${d.user.expiresAt}\uFF09\uFF1A${JSON.stringify(d.user.fields)}`);
      } else {
        lines.push("\u7528\u6237\u8BB0\u5FC6\uFF1A\u65E0\uFF08\u6216\u5DF2\u8FC7\u671F/\u672A\u5199\u5165\uFF09");
      }
      if (d.history.length > 0) {
        lines.push(`\u66F4\u6B63\u7559\u75D5\uFF1A${d.history.map((h) => `${h.field}: ${JSON.stringify(h.previous)} \u2192 ${JSON.stringify(h.next)}\uFF08${h.source}\uFF09`).join("\uFF1B")}`);
      }
      lines.push(d.injected.length > 0 ? `\u5EFA\u8BAE\u6CE8\u5165\uFF08${d.injected.length} \u6761\uFF09\uFF1A
${d.injected.map((item, i) => `  ${i + 1}. ${item}`).join("\n")}` : "\u5EFA\u8BAE\u6CE8\u5165\uFF1A\u65E0");
      lines.push(`\u5B58\u50A8\uFF1A${d.memoryPath}\uFF1BTTL\uFF1A\u4F1A\u8BDD ${SESSION_TTL_DAYS} \u5929 / \u7528\u6237 ${USER_TTL_DAYS} \u5929\u3002`);
      return [{ type: "text", text: lines.join("\n") }];
    }
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id);
    const sessionId = agentSessionId(exec);
    const a = args;
    const scope = parseScope(a.scope);
    const recalled = recallMemory(identity, sessionId, String(a.taskHint ?? ""));
    const history = (loadStore().users[`${identity.tenantId}:${identity.userId}`]?.history ?? []).slice(-5).map((entry) => ({
      at: entry.at,
      field: entry.field,
      previous: entry.previous ?? null,
      next: entry.next ?? null,
      source: entry.source
    }));
    const data = {
      scope,
      tenantId: identity.tenantId,
      userId: identity.userId,
      sessionId: sessionId ?? null,
      session: scope !== "user" && recalled.session ? { fields: recalled.session.fields, updatedAt: recalled.session.updatedAt, expiresAt: recalled.session.expiresAt, ttlDays: SESSION_TTL_DAYS } : null,
      user: scope !== "session" && recalled.user ? { fields: recalled.user.fields, role: recalled.user.role, updatedAt: recalled.user.updatedAt, expiresAt: recalled.user.expiresAt, ttlDays: USER_TTL_DAYS } : null,
      history,
      injected: recalled.injected,
      injectedCount: recalled.injected.length,
      memoryPath: memoryStatePath()
    };
    writeAudit({
      event: "memory.recalled",
      tool: "memory_recall",
      sessionId,
      userId: identity.userId,
      tenantId: identity.tenantId,
      scope,
      injectedCount: data.injectedCount
    });
    return { data };
  }
});
const memoryRemember = defineTool({
  name: "memory_remember",
  description: "\u5199\u5165\u8BB0\u5FC6\u767D\u540D\u5355\u5B57\u6BB5\uFF1A\u4F1A\u8BDD\u8BB0\u5FC6\uFF08lastOrderId/lastSupplierId/lastSkuId/lastExceptionType/lastTicketId/lastClauseNo/currentAction/note\uFF0C\u22648\uFF09\u6216\u7528\u6237\u8BB0\u5FC6\uFF08focusCategories/commonSuppliers/preferAction/lastOpenTicket/note\uFF0C\u22646\uFF09\u3002\u7528\u6237\u663E\u5F0F\u66F4\u6B63\u7528 source=user_correction\uFF08\u8986\u76D6\u65E7\u503C\u5E76\u7559 history\uFF09\u3002\u767D\u540D\u5355\u5916\u5B57\u6BB5\u4F1A\u88AB\u62D2\u7EDD\u3002\u9002\u7528\uFF1A\u7528\u6237\u660E\u786E\u8BF4\u201C\u8BB0\u4F4F/\u66F4\u6B63\u201D\u65F6\uFF1B\u4E0D\u9002\u7528\uFF1A\u81EA\u52A8\u62BD\u53D6\uFF08\u5DE5\u5177\u5DF2\u81EA\u52A8\u5199\u4F1A\u8BDD\u8BB0\u5FC6\uFF09\u3002",
  parameters: {
    scope: { type: "string", required: true, description: "session \u6216 user" },
    fields: { type: "object", additionalProperties: true, required: true, description: '\u767D\u540D\u5355\u5B57\u6BB5\u5BF9\u8C61\uFF0C\u5982 {"lastOrderId":"PO-20261013-0042"} \u6216 {"commonSuppliers":["SUP-1042"]}' },
    source: { type: "string", description: "tool_inference\uFF08\u9ED8\u8BA4\uFF09\u6216 user_correction\uFF08\u7528\u6237\u663E\u5F0F\u66F4\u6B63\uFF0C\u4F18\u5148\u7EA7\u6700\u9AD8\uFF09" }
  },
  output: {
    schema: { type: "object", additionalProperties: true },
    render: (_args, value) => {
      const v = value;
      const d = v.data;
      const lines = [
        `\u8BB0\u5FC6\u5DF2\u5199\u5165\uFF08${d.scope}\uFF1B\u79DF\u6237 ${d.tenantId}\uFF1B\u7528\u6237 ${d.userId}${d.sessionId ? `\uFF1B\u4F1A\u8BDD ${d.sessionId}` : ""}\uFF09`,
        `\u5B57\u6BB5\uFF1A${JSON.stringify(d.fields)}`,
        `\u8FC7\u671F\u65F6\u95F4\uFF1A${d.expiresAt}\uFF08TTL ${d.ttlDays} \u5929\uFF1B\u6765\u6E90 ${d.source}\uFF09`
      ];
      if (d.history.length > 0) lines.push(`\u66F4\u6B63\u7559\u75D5\uFF1A${d.history.map((h) => `${h.field}: ${JSON.stringify(h.previous)} \u2192 ${JSON.stringify(h.next)}`).join("\uFF1B")}`);
      lines.push(`\u5B58\u50A8\uFF1A${d.memoryPath}`);
      return [{ type: "text", text: lines.join("\n") }];
    }
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id);
    const sessionId = agentSessionId(exec);
    const a = args;
    const scope = String(a.scope ?? "").trim();
    if (scope !== "session" && scope !== "user") throw invalid("scope \u5FC5\u586B\uFF0C\u53EF\u9009\uFF1Asession / user");
    const fields = validateWhitelist(scope, a.fields);
    const source = a.source === "user_correction" ? "user_correction" : "tool_inference";
    if (scope === "session") {
      if (!sessionId) throw invalid("\u65E0\u6CD5\u89E3\u6790\u5F53\u524D\u4F1A\u8BDD id\uFF0C\u4E0D\u80FD\u5199\u4F1A\u8BDD\u8BB0\u5FC6");
      let memory2;
      try {
        memory2 = rememberSession(identity, sessionId, fields, source);
      } catch (error) {
        throw invalid(String(error.message));
      }
      return {
        data: {
          scope,
          tenantId: identity.tenantId,
          userId: identity.userId,
          sessionId,
          fields: memory2.fields,
          updatedAt: memory2.updatedAt,
          expiresAt: memory2.expiresAt,
          ttlDays: SESSION_TTL_DAYS,
          source,
          history: [],
          memoryPath: memoryStatePath()
        }
      };
    }
    let memory;
    try {
      memory = rememberUser(identity, fields, { source });
    } catch (error) {
      throw invalid(String(error.message));
    }
    return {
      data: {
        scope,
        tenantId: identity.tenantId,
        userId: identity.userId,
        sessionId: sessionId ?? null,
        fields: memory.fields,
        updatedAt: memory.updatedAt,
        expiresAt: memory.expiresAt,
        ttlDays: USER_TTL_DAYS,
        source,
        history: memory.history.slice(-5).map((entry) => ({
          at: entry.at,
          field: entry.field,
          previous: entry.previous ?? null,
          next: entry.next ?? null,
          source: entry.source
        })),
        memoryPath: memoryStatePath()
      }
    };
  }
});
const memoryForget = defineTool({
  name: "memory_forget",
  description: "\u64A4\u9500\u8BB0\u5FC6\uFF08\u4F1A\u8BDD\u6216\u7528\u6237\uFF09\u3002\u5FC5\u987B\u663E\u5F0F confirm=true \u624D\u6267\u884C\uFF1B\u5220\u9664\u5199\u5BA1\u8BA1\u3002\u9002\u7528\uFF1A\u7528\u6237\u660E\u786E\u8BF4\u201C\u5FD8\u6389/\u64A4\u9500\u8BB0\u5FC6\u201D\u65F6\uFF1B\u4E0D\u9002\u7528\uFF1A\u53EA\u662F\u60F3\u67E5\u770B\u8BB0\u5FC6\uFF08\u7528 memory_recall\uFF09\u3002",
  parameters: {
    scope: { type: "string", required: true, description: "session \u6216 user" },
    confirm: { type: "boolean", required: true, description: "\u5FC5\u987B\u663E\u5F0F\u4F20 true \u624D\u5220\u9664\uFF08\u9632\u8BEF\u5220\uFF09" }
  },
  output: {
    schema: { type: "object", additionalProperties: true },
    render: (_args, value) => {
      const v = value;
      const d = v.data;
      return [
        {
          type: "text",
          text: d.deleted ? `\u5DF2\u64A4\u9500${d.scope === "session" ? "\u4F1A\u8BDD" : "\u7528\u6237"}\u8BB0\u5FC6\uFF08\u79DF\u6237 ${d.tenantId}\uFF1B\u7528\u6237 ${d.userId}${d.sessionId ? `\uFF1B\u4F1A\u8BDD ${d.sessionId}` : ""}\uFF09\uFF0C\u5220\u9664\u5DF2\u5199\u5BA1\u8BA1\u3002` : `\u672A\u627E\u5230\u53EF\u64A4\u9500\u7684${d.scope === "session" ? "\u4F1A\u8BDD" : "\u7528\u6237"}\u8BB0\u5FC6\uFF08\u53EF\u80FD\u5DF2\u8FC7\u671F\u6216\u4ECE\u672A\u5199\u5165\uFF09\u3002`
        }
      ];
    }
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id);
    const sessionId = agentSessionId(exec);
    const a = args;
    const scope = String(a.scope ?? "").trim();
    if (scope !== "session" && scope !== "user") throw invalid("scope \u5FC5\u586B\uFF0C\u53EF\u9009\uFF1Asession / user");
    if (a.confirm !== true) throw invalid("\u5220\u9664\u8BB0\u5FC6\u9700\u663E\u5F0F confirm=true\uFF08\u9632\u8BEF\u5220\uFF09");
    if (scope === "session" && !sessionId) throw invalid("\u65E0\u6CD5\u89E3\u6790\u5F53\u524D\u4F1A\u8BDD id\uFF0C\u4E0D\u80FD\u64A4\u9500\u4F1A\u8BDD\u8BB0\u5FC6");
    const deleted = forgetMemory(identity, scope, sessionId);
    writeAudit({
      event: "memory.forget.called",
      tool: "memory_forget",
      scope,
      sessionId,
      userId: identity.userId,
      tenantId: identity.tenantId,
      deleted
    });
    return {
      data: {
        scope,
        tenantId: identity.tenantId,
        userId: identity.userId,
        sessionId: sessionId ?? null,
        deleted,
        memoryPath: memoryStatePath()
      }
    };
  }
});
export {
  memoryForget,
  memoryRecall,
  memoryRemember
};
//# sourceMappingURL=memory-tools.js.map
