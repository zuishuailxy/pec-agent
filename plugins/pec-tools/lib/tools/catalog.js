import { defineTool } from "@deepseek-ai/dsh-tools";
import { all } from "../db.js";
const catalogTool = defineTool({
  name: "pec_data_catalog",
  description: "\u5217\u51FA\u5F53\u524D\u6570\u636E\u96C6\u5305\u542B\u7684\u8868\u3001\u884C\u6570\u4E0E\u5B57\u6BB5\u540D\u3002\u7528\u4E8E\u5F00\u5DE5\u81EA\u68C0\u4E0E\u6392\u67E5\uFF1B\u4E0D\u8FD4\u56DE\u4E1A\u52A1\u6570\u636E\u3002",
  parameters: {
    table: { type: "string", description: "\u53EF\u9009\uFF1A\u53EA\u770B\u67D0\u5F20\u8868" }
  },
  output: {
    schema: { type: "object", additionalProperties: true },
    render: (_args, v) => [{
      type: "text",
      text: (v.data?.tables ?? v.tables ?? []).map((t) => `${t.name}  ${t.rows} \u884C  (${t.columns.join(", ")})`).join("\n")
    }]
  },
  async execute(args, exec) {
    const wanted = args.table?.trim();
    const tables = ["suppliers", "skus", "orders", "contracts", "tickets", "users"].filter((t) => !wanted || t === wanted).map((t) => ({
      name: t,
      rows: all(`select count(*) as n from ${t}`)[0].n,
      columns: all(`pragma table_info(${t})`).map((c) => c.name)
    }));
    return { data: { tables }, provenance: [{ table: "orders", rowId: "catalog" }] };
  }
});
export {
  catalogTool
};
//# sourceMappingURL=catalog.js.map
