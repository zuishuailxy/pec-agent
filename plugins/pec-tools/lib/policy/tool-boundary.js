import { writeAudit } from "./audit.js";
import { PEC_TOOLS } from "./tool-surface.js";
const TOOL_BOUNDARY_SECTION = "pec:tool-boundary";
const TOOL_BOUNDARY_ORDER = 10040;
function toolBoundaryText() {
  return [
    "<pec_tool_boundary>",
    "\u672C\u4F1A\u8BDD\u662F PEC \u91C7\u8D2D\u5F02\u5E38\u5904\u7F6E\u4E13\u7528 Agent\uFF0C\u80FD\u529B\u8FB9\u754C\u56FA\u5B9A\uFF1A",
    `1. \u53EF\u7528\u5DE5\u5177\u4EC5\u9650\uFF1A${PEC_TOOLS.join(" / ")}\u3002`,
    "2. \u4E0D\u5B58\u5728 bash / shell / read / write / grep / sqlite \u7B49\u5DE5\u5177\uFF1B\u8C03\u7528\u4E0D\u5B58\u5728\u7684\u5DE5\u5177\u4F1A\u8FD4\u56DE unknown tool\u3002\u4E0D\u8981\u5C1D\u8BD5\uFF0C\u4E5F\u4E0D\u8981\u81C6\u6D4B\u5B58\u5728\u5176\u4ED6\u5DE5\u5177\u3002",
    "3. \u6240\u6709\u4E1A\u52A1\u6570\u636E\u5FC5\u987B\u901A\u8FC7\u4E1A\u52A1\u5DE5\u5177\u8BFB\u53D6\uFF1B\u4E0D\u5F97\u7ED5\u8FC7\u5DE5\u5177\u9762\u76F4\u63A5\u8BFB\u8868\u3001\u8BFB\u6587\u4EF6\u6216\u7528 shell \u67E5\u8BE2\u3002\u5DE5\u5177\u68C0\u7D22\u65E0\u547D\u4E2D\u65F6\uFF0C\u5982\u5B9E\u56DE\u590D\u201C\u672A\u68C0\u7D22\u5230\u201D\uFF08\u540C\u4E00\u4E8B\u5B9E\u6700\u591A\u6362 1\u20132 \u4E2A\u540C\u4E49\u8BCD\u590D\u68C0\uFF0C\u4E0D\u8981\u7A77\u4E3E\u5173\u952E\u8BCD\u5237\u8C03\u7528\uFF09\uFF0C\u4E0D\u5F97\u7F16\u9020\uFF0C\u4E5F\u4E0D\u8981\u628A sqlite3/grep \u7B49\u7ED5\u8FC7\u5DE5\u5177\u9762\u7684\u547D\u4EE4\u4EA4\u7ED9\u7528\u6237\u6267\u884C\u3002",
    "4. \u5DE5\u5177\u8FD4\u56DE POLICY_DENIED\uFF08\u8DE8\u79DF\u6237\uFF09\u6216 INVALID_ARGUMENT \u65F6\u65E0\u6CD5\u7ED5\u8FC7\uFF1A\u8BF4\u660E\u539F\u56E0\u5E76\u8F6C\u4EBA\u5DE5\u6216\u6539\u7528\u5DE5\u5177\u9762\u5185\u5408\u6CD5\u8DEF\u5F84\uFF0C\u4E0D\u8981\u91CD\u8BD5\u8D8A\u754C\u624B\u6BB5\u3002",
    "</pec_tool_boundary>"
  ].join("\n");
}
function installToolBoundary(ctx) {
  const systemPrompt = ctx.get?.("systemPrompt") ?? ctx.systemPrompt;
  if (!systemPrompt || typeof systemPrompt.section !== "function") {
    writeAudit({ event: "tool-boundary.unavailable", reason: "systemPrompt service not found" });
    return;
  }
  systemPrompt.section({
    name: TOOL_BOUNDARY_SECTION,
    order: TOOL_BOUNDARY_ORDER,
    interpolate: false,
    text: () => toolBoundaryText()
  });
  writeAudit({ event: "tool-boundary.installed", section: TOOL_BOUNDARY_SECTION, chars: toolBoundaryText().length });
}
export {
  TOOL_BOUNDARY_ORDER,
  TOOL_BOUNDARY_SECTION,
  installToolBoundary,
  toolBoundaryText
};
//# sourceMappingURL=tool-boundary.js.map
