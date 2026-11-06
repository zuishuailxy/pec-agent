import { writeAudit } from "./audit.js";
const ROLE_POLICY = {
  //            订单    成本价   联系人  合同原文 审计
  admin: { orders: "full", costPrice: "full", supplierContacts: "full", contractText: "full", auditLog: "full" },
  buyer: { orders: "full", costPrice: "masked", supplierContacts: "masked", contractText: "none", auditLog: "none" },
  manager: { orders: "full", costPrice: "full", supplierContacts: "masked", contractText: "none", auditLog: "none" },
  finance: { orders: "full", costPrice: "full", supplierContacts: "full", contractText: "full", auditLog: "none" },
  risk: { orders: "full", costPrice: "masked", supplierContacts: "full", contractText: "masked", auditLog: "none" },
  auditor: { orders: "full", costPrice: "masked", supplierContacts: "masked", contractText: "none", auditLog: "full" }
};
function policyFor(role) {
  return ROLE_POLICY[role] ?? ROLE_POLICY.buyer;
}
function maskPhone(phone) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return "***";
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}
function maskName(name) {
  const chars = [...name];
  if (chars.length <= 1) return "*";
  return `${chars[0]}${"*".repeat(chars.length - 1)}`;
}
function maskContacts(role, contacts, context) {
  const access = policyFor(role).supplierContacts;
  if (access === "full") {
    return contacts.map((contact) => ({ ...contact, masked: false }));
  }
  if (access === "none") {
    writeAudit({ event: "field-denied", field: "supplier.contacts", reason: "role-none", role, ...context });
    return [];
  }
  writeAudit({ event: "field-masked", field: "supplier.contacts", reason: "role-masked", role, ...context });
  return contacts.map((contact) => ({
    name: maskName(contact.name),
    phone: maskPhone(contact.phone),
    masked: true
  }));
}
function contractTextAccess(role) {
  return policyFor(role).contractText;
}
function auditFieldAccess(role, field, access, context) {
  if (access === "full") return;
  writeAudit({
    event: access === "none" ? "field-denied" : "field-masked",
    field,
    role,
    reason: `role-${access}`,
    ...context
  });
}
export {
  ROLE_POLICY,
  auditFieldAccess,
  contractTextAccess,
  maskContacts,
  maskName,
  maskPhone,
  policyFor
};
//# sourceMappingURL=masking.js.map
