import { defineTool } from "@deepseek-ai/dsh-tools";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { invalid } from "../errors.js";
import { resolveIdentity } from "../policy/identity.js";
import { writeAudit } from "../policy/audit.js";
const DEFAULT_SKILLS_DIR = () => resolve(process.env.PEC_SKILLS_DIR || join(process.cwd(), ".dsh", "skills"));
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_BODY_BYTES = 12e3;
function skillsDir() {
  return DEFAULT_SKILLS_DIR();
}
function yamlValue(value) {
  const flat = value.replace(/\s+/g, " ").trim();
  if (/^[A-Za-z0-9\u4e00-\u9fa5][^:#\n]*$/.test(flat) && !/^[-?]/.test(flat)) return flat;
  return JSON.stringify(flat);
}
function requireText(value, field, max) {
  if (typeof value !== "string" || !value.trim()) throw invalid(`${field} \u5FC5\u586B\u4E14\u4E0D\u80FD\u4E3A\u7A7A`);
  const text = value.replace(/\r\n/g, "\n").trim();
  if ([...text].length > max) throw invalid(`${field} \u8FC7\u957F\uFF08\u4E0A\u9650 ${max} \u5B57\u7B26\uFF09`);
  return text;
}
function validateSkillDraft(draft) {
  const name = String(draft.name ?? "").trim();
  if (!NAME_PATTERN.test(name)) throw invalid(`name \u5FC5\u987B\u662F kebab-case\uFF08\u5C0F\u5199\u5B57\u6BCD/\u6570\u5B57/\u8FDE\u5B57\u7B26\uFF09\uFF0C\u6536\u5230\u300C${name}\u300D`);
  if (name.length < 2 || name.length > 64) throw invalid("name \u957F\u5EA6\u5FC5\u987B\u5728 2\u201364 \u4E4B\u95F4");
  const description = requireText(draft.description, "description", 200);
  const whenToUse = requireText(draft.whenToUse, "whenToUse", 300);
  const body = requireText(draft.body, "body", MAX_BODY_BYTES);
  const hasGuardrail = /^#{1,6}\s*护栏/m.test(body) || /【?护栏】?[：:]/.test(body);
  const hasCounterExample = /^#{1,6}\s*反例/m.test(body) || /【?反例】?[：:]/.test(body);
  if (!hasGuardrail) throw invalid("\u6B63\u6587\u7F3A\u5C11\u300C\u62A4\u680F\u300D\u6BB5\u843D\uFF08\u5199\u6210 \u201C## \u62A4\u680F\u201D\uFF09\uFF1A\u6280\u80FD\u5FC5\u987B\u8BF4\u660E\u4EC0\u4E48\u60C5\u51B5\u4E0B\u505C\u624B/\u5347\u7EA7/\u56DE\u9000\uFF08R14\uFF09");
  if (!hasCounterExample) throw invalid("\u6B63\u6587\u7F3A\u5C11\u300C\u53CD\u4F8B\u300D\u6BB5\u843D\uFF08\u5199\u6210 \u201C## \u53CD\u4F8B\u201D\uFF09\uFF1A\u6280\u80FD\u5FC5\u987B\u8BB0\u5F55\u8E29\u8FC7\u7684\u5751\u4E0E\u4E0B\u6B21\u600E\u4E48\u907F\u5F00\uFF08\u9898\u9762 \xA76.3\uFF09");
  if ([...body].length < 100) throw invalid("\u6B63\u6587\u8FC7\u77ED\uFF08< 100 \u5B57\u7B26\uFF09\uFF1A\u81F3\u5C11\u5199\u6E05\u89E6\u53D1\u540E\u8C03\u54EA\u4E9B\u5DE5\u5177\u3001\u4F20\u4EC0\u4E48\u53C2\u6570\u3001\u62A4\u680F\u4E0E\u53CD\u4F8B");
  const content = `---
name: ${yamlValue(name)}
description: ${yamlValue(description)}
whenToUse: ${yamlValue(whenToUse)}
---

${body}
`;
  return { name, description, whenToUse, body, hasGuardrail, hasCounterExample, content };
}
const skillWrite = defineTool({
  name: "skill_write",
  description: "\u628A\u4E00\u6B21\u6210\u529F\u5904\u7F6E\u6C89\u6DC0\u4E3A\u6280\u80FD\u6587\u4EF6 `.dsh/skills/<name>/SKILL.md`\uFF08Agent \u81EA\u4E3E\u901A\u9053\uFF09\u3002\u5DE5\u5177\u4F1A\u6821\u9A8C\uFF1Aname \u5FC5\u987B kebab-case\u3001description/whenToUse \u5FC5\u586B\u3001\u6B63\u6587\u5FC5\u987B\u542B\u300C\u62A4\u680F\u300D\u4E0E\u300C\u53CD\u4F8B\u300D\u6BB5\u843D\u3001\u53EA\u5141\u8BB8\u5199\u6280\u80FD\u76EE\u5F55\u5185\uFF08\u9632\u8DEF\u5F84\u7A7F\u8D8A\uFF09\uFF1B\u5DF2\u5B58\u5728\u65F6\u9700 overwrite=true\u3002\u9002\u7528\uFF1A\u4E00\u6B21\u5904\u7F6E\u6210\u529F\u4E14\u53EF\u590D\u7528\u3001\u7528\u6237\u8981\u6C42\u201C\u6C89\u6DC0/\u8BB0\u4F4F\u6D41\u7A0B\u201D\u65F6\uFF1B\u4E0D\u9002\u7528\uFF1A\u666E\u901A\u8BB0\u5FC6\uFF08\u7528 memory_remember\uFF09\u3001\u4FEE\u6539\u4EE3\u7801\u3002",
  parameters: {
    name: {
      type: "string",
      required: true,
      description: "\u6280\u80FD\u540D\uFF0Ckebab-case\uFF0C\u5982 delay-small-standard / stock-replenish\uFF1B\u51B3\u5B9A\u76EE\u5F55 .dsh/skills/<name>/"
    },
    description: { type: "string", required: true, description: "frontmatter description\uFF1A\u4E00\u53E5\u8BDD\u8BF4\u660E\u89E3\u51B3\u4EC0\u4E48\u95EE\u9898\uFF08\u2264200 \u5B57\u7B26\uFF09" },
    whenToUse: { type: "string", required: true, description: "frontmatter whenToUse\uFF1A\u4EC0\u4E48\u5F02\u5E38\u7C7B\u578B/\u91D1\u989D\u533A\u95F4/\u4F9B\u5E94\u5546\u72B6\u6001\u4F7F\u7528\uFF0C\u4E0D\u9002\u7528\u4E8E\u4EC0\u4E48\uFF08\u2264300 \u5B57\u7B26\uFF09" },
    body: {
      type: "string",
      required: true,
      description: "\u6B63\u6587 Markdown\uFF1A\u5DE5\u5177\u5E8F\u5217\uFF08\u6BCF\u6B65\u8C03\u54EA\u4E2A\u5DE5\u5177/\u53C2\u6570\u4ECE\u54EA\u6765\uFF09+ \u201C## \u62A4\u680F\u201D\u6BB5 + \u201C## \u53CD\u4F8B\u201D\u6BB5\uFF1B\u4E0D\u8981\u590D\u8BFB\u5BF9\u8BDD"
    },
    overwrite: { type: "boolean", description: "\u6280\u80FD\u5DF2\u5B58\u5728\u65F6\u662F\u5426\u8986\u76D6\uFF0C\u9ED8\u8BA4 false\uFF08\u9632\u8BEF\u8986\u76D6\uFF09" }
  },
  output: {
    schema: { type: "object", additionalProperties: true },
    render: (_args, value) => {
      const v = value;
      const d = v.data;
      return [
        {
          type: "text",
          text: [
            `\u6280\u80FD\u5DF2${d.created ? "\u65B0\u5EFA" : "\u8986\u76D6"}\uFF1A.dsh/skills/${d.name}/SKILL.md\uFF08${d.bytes} \u5B57\u8282\uFF09`,
            `frontmatter\uFF1Aname=${d.frontmatter.name}\uFF1Bdescription=${d.frontmatter.description}`,
            `whenToUse\uFF1A${d.frontmatter.whenToUse}`,
            `\u7ED3\u6784\u6821\u9A8C\uFF1A\u62A4\u680F=${d.hasGuardrail ? "\u6709" : "\u65E0"}\uFF1B\u53CD\u4F8B=${d.hasCounterExample ? "\u6709" : "\u65E0"}`,
            "\u5E73\u53F0\u4F1A\u5728\u4E0B\u4E00\u6B65\u626B\u63CF\u5230\u8BE5\u6280\u80FD\uFF08catalog \u66B4\u9732 name+description\uFF0C\u6A21\u578B\u53EF\u7ECF skill \u5DE5\u5177\u6309\u9700\u52A0\u8F7D\u6B63\u6587\uFF09\u3002"
          ].join("\n")
        }
      ];
    }
  },
  async execute(args, exec) {
    const identity = resolveIdentity(exec?.agent?.session?.id);
    const sessionId = exec?.agent?.session?.id;
    const a = args;
    const draft = validateSkillDraft(a);
    const dir = skillsDir();
    const targetDir = resolve(dir, draft.name);
    if (!targetDir.startsWith(dir + sep)) throw invalid(`\u975E\u6CD5\u6280\u80FD\u8DEF\u5F84\uFF1A${draft.name}`);
    const file = join(targetDir, "SKILL.md");
    const existing = existsSync(file);
    if (existing && a.overwrite !== true) {
      throw invalid(`\u6280\u80FD ${draft.name} \u5DF2\u5B58\u5728\uFF1B\u786E\u9700\u8986\u76D6\u8BF7\u4F20 overwrite=true\uFF08\u8986\u76D6\u4F1A\u5199\u5BA1\u8BA1\uFF09`);
    }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, draft.content, "utf8");
    const bytes = Buffer.byteLength(draft.content, "utf8");
    writeAudit({
      event: "skill.written",
      tool: "skill_write",
      name: draft.name,
      path: `.dsh/skills/${draft.name}/SKILL.md`,
      bytes,
      created: !existing,
      overwritten: existing,
      sessionId,
      userId: identity.userId,
      tenantId: identity.tenantId
    });
    return {
      data: {
        name: draft.name,
        path: `.dsh/skills/${draft.name}/SKILL.md`,
        absolutePath: file,
        bytes,
        created: !existing,
        overwritten: existing,
        frontmatter: { name: draft.name, description: draft.description, whenToUse: draft.whenToUse },
        hasGuardrail: draft.hasGuardrail,
        hasCounterExample: draft.hasCounterExample
      }
    };
  }
});
export {
  skillWrite,
  skillsDir,
  validateSkillDraft
};
//# sourceMappingURL=skill-write.js.map
