CREATE TABLE backup_account_leases (
  account_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE backup_firewall_rules (
  account_id TEXT NOT NULL,
  address TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(account_id, address)
);
