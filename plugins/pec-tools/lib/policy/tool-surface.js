import { writeAudit } from "./audit.js";
const PEC_TOOLS = [
  "pec_data_catalog",
  "order_lookup",
  "supplier_profile",
  "pricing_quote",
  "freight_calc",
  "contract_search",
  "ticket_similar",
  // 注意：restrict 会对未知工具名抛错；新增工具实现后必须同步加到这里再重编译。
  // skill 加载工具必须保留，否则技能机制不可用
  "skill"
];
function installToolSurface(ctx) {
  ;
  ctx.on("agent/created", ({ agent }) => {
    try {
      const disposer = agent?.ctx?.tools?.restrict?.({ allow: [...PEC_TOOLS] });
      if (typeof disposer !== "function") throw new Error("restrict() returned no disposer");
      writeAudit({ event: "tool-surface.restricted", agentId: agent?.id, allow: PEC_TOOLS });
    } catch (error) {
      writeAudit({ event: "tool-surface.failed", agentId: agent?.id, error: String(error) });
    }
  });
}
export {
  PEC_TOOLS,
  installToolSurface
};
//# sourceMappingURL=tool-surface.js.map
