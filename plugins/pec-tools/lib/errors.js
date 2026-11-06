class ToolError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
    this.name = "ToolError";
  }
  code;
  detail;
}
function notFound(message, detail) {
  return new ToolError("NOT_FOUND", message, detail);
}
function invalid(message, detail) {
  return new ToolError("INVALID_ARGUMENT", message, detail);
}
function denied(message, detail) {
  return new ToolError("POLICY_DENIED", message, detail);
}
function eDivZero(message = "\u6570\u91CF\u4E3A 0\uFF0C\u4E0D\u80FD\u8BA1\u7B97\u8BA1\u4EF6\u8FD0\u8D39") {
  return new ToolError("INVALID_ARGUMENT", `E_DIV_ZERO: ${message}`, { reason: "E_DIV_ZERO" });
}
export {
  ToolError,
  denied,
  eDivZero,
  invalid,
  notFound
};
//# sourceMappingURL=errors.js.map
