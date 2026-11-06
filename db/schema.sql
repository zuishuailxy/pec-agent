PRAGMA foreign_keys = ON;

CREATE TABLE contracts (
  clause_no TEXT PRIMARY KEY, supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  type TEXT NOT NULL, text TEXT NOT NULL, effective_from TEXT NOT NULL
);
CREATE TABLE orders (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  sku_id TEXT NOT NULL REFERENCES skus(id),
  qty INTEGER NOT NULL, unit_price REAL NOT NULL,
  ordered_at TEXT NOT NULL, promised_at TEXT NOT NULL, delivered_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('OPEN','SHIPPED','DELAYED','CLOSED','DRAFT')),
  freight_rate REAL NOT NULL, volume REAL NOT NULL,
  amount REAL, billed_volume INTEGER, freight REAL, unit_freight REAL
);
CREATE TABLE skus (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  safety_stock INTEGER NOT NULL, on_hand INTEGER NOT NULL, in_transit INTEGER NOT NULL,
  moq INTEGER NOT NULL, volume REAL NOT NULL, price_tiers TEXT NOT NULL
);
CREATE TABLE suppliers (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('A','B','C','D')),
  blacklisted INTEGER NOT NULL DEFAULT 0, delay_days_12m INTEGER NOT NULL DEFAULT 0,
  contacts TEXT NOT NULL
);
CREATE TABLE tickets (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), tenant_id TEXT NOT NULL,
  exception_type TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL,
  minutes INTEGER NOT NULL, overridden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE users (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL, focus_categories TEXT NOT NULL
);
CREATE INDEX idx_orders_tenant ON orders(tenant_id);
CREATE INDEX idx_orders_supplier ON orders(supplier_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_tickets_order ON tickets(order_id);
CREATE INDEX idx_contracts_supplier ON contracts(supplier_id);
