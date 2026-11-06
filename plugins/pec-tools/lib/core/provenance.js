function prov(table, rowId, fields) {
  return fields?.length ? { table, rowId, fields } : { table, rowId };
}
function sourceTag(ref) {
  return `[\u6765\u6E90: ${ref.table}#${ref.rowId}]`;
}
function renderSources(refs) {
  const unique = /* @__PURE__ */ new Map();
  for (const ref of refs) unique.set(`${ref.table}#${ref.rowId}`, ref);
  return [...unique.values()].map(sourceTag).join(" ");
}
function renderLines(lines, refs) {
  const body = lines.join("\n");
  const sources = renderSources(refs);
  return [{ type: "text", text: sources ? `${body}
${sources}` : body }];
}
export {
  prov,
  renderLines,
  renderSources,
  sourceTag
};
//# sourceMappingURL=provenance.js.map
