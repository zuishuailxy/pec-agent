import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
function auditPath() {
  return resolve(process.env.PEC_AUDIT_PATH || "./runs/audit.jsonl");
}
function writeAudit(entry) {
  const line = JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), ...entry });
  try {
    const target = auditPath();
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, `${line}
`);
  } catch {
  }
}
export {
  auditPath,
  writeAudit
};
//# sourceMappingURL=audit.js.map
