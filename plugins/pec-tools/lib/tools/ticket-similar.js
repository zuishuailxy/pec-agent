import { defineTool } from "@deepseek-ai/dsh-tools";
import { ToolError } from "../errors.js";
const notImplemented = (name) => {
  throw new ToolError("NOT_IMPLEMENTED", `${name} \u5C1A\u672A\u5B9E\u73B0\uFF0C\u8BF7\u8865\u5168 execute`);
};
const ticketSimilar = defineTool({
  name: "ticket_similar",
  description: "\u6309\u5F02\u5E38\u7C7B\u578B\u4E0E\u4F9B\u5E94\u5546\u53EC\u56DE\u76F8\u4F3C\u5386\u53F2\u5DE5\u5355\uFF0C\u8FD4\u56DE\u5904\u7F6E\u52A8\u4F5C\u3001\u7ED3\u8BBA\u3001\u8017\u65F6\u4E0E\u76F8\u4F3C\u5EA6\u3002\u9002\u7528\uFF1A\u9700\u8981\u53C2\u8003\u5386\u53F2\u5904\u7F6E\u7ECF\u9A8C\u65F6\uFF1B\u4E0D\u9002\u7528\uFF1A\u67E5\u8BA2\u5355\u5C65\u7EA6\uFF08\u7528 order_lookup\uFF09\u3001\u67E5\u5408\u540C\u6761\u6B3E\uFF08\u7528 contract_search\uFF09\u3002",
  parameters: {
    exceptionType: { type: "string", required: true, description: "DELAY / STOCK / PRICE / FREIGHT / RISK" },
    supplierId: { type: "string", description: "\u53EF\u9009\u7684\u4F9B\u5E94\u5546\u8FC7\u6EE4" },
    amountMax: { type: "number", description: "\u53EF\u9009\uFF1A\u91D1\u989D\u4E0A\u9650\uFF08\u5143\uFF09" }
  },
  output: { schema: { type: "object", additionalProperties: true }, render: () => [{ type: "text", text: "" }] },
  async execute() {
    return notImplemented("ticket_similar");
  }
});
export {
  ticketSimilar
};
//# sourceMappingURL=ticket-similar.js.map
