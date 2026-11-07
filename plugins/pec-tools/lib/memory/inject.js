import { resolveIdentity } from "../policy/identity.js";
import { writeAudit } from "../policy/audit.js";
import { recallMemory } from "../memory/store.js";
const reportedSessions = /* @__PURE__ */ new Set();
function installMemoryInjection(ctx) {
  const systemPrompt = ctx.get?.("systemPrompt") ?? ctx.systemPrompt;
  if (!systemPrompt || typeof systemPrompt.section !== "function") {
    writeAudit({ event: "memory.inject.unavailable", reason: "systemPrompt service not found" });
    return;
  }
  systemPrompt.section({
    name: "pec:memory",
    order: 10050,
    interpolate: false,
    text: (context) => {
      try {
        const agent = context?.agent;
        if (!agent?.session?.id) return "";
        const sessionId = agent.session.id;
        const identity = resolveIdentity(sessionId);
        const recalled = recallMemory(identity, sessionId);
        if (recalled.injected.length === 0) return "";
        if (!reportedSessions.has(sessionId)) {
          reportedSessions.add(sessionId);
          writeAudit({
            event: "memory.injected",
            sessionId,
            userId: identity.userId,
            tenantId: identity.tenantId,
            count: recalled.injected.length,
            items: recalled.injected
          });
        }
        return [
          "<pec_memory>",
          "\u4EE5\u4E0B\u662F\u672C\u4F1A\u8BDD/\u5F53\u524D\u7528\u6237\u5DF2\u786E\u8BA4\u7684\u8BB0\u5FC6\uFF08\u7531\u5DE5\u5177\u5199\u5165\u6216\u7528\u6237\u663E\u5F0F\u66F4\u6B63\uFF09\u3002\u56DE\u7B54\u524D\u5148\u6838\u5BF9\uFF1B\u5DF2\u77E5\u4E8B\u5B9E\u4E0D\u8981\u91CD\u590D\u8BE2\u95EE\uFF1A",
          ...recalled.injected.map((item, index) => `${index + 1}. ${item}`),
          "</pec_memory>"
        ].join("\n");
      } catch (error) {
        try {
          writeAudit({ event: "memory.inject.error", error: String(error) });
        } catch {
        }
        return "";
      }
    }
  });
}
export {
  installMemoryInjection
};
//# sourceMappingURL=inject.js.map
