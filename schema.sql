-- Echo Documents v1.0.0 — D1 Schema

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  plan TEXT DEFAULT 'starter',
  storage_limit_mb INTEGER DEFAULT 500,
  max_documents INTEGER DEFAULT 100,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT DEFAULT '#3B82F6',
  icon TEXT DEFAULT 'folder',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_folders_tenant ON folders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(tenant_id, parent_id);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  folder_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  file_type TEXT DEFAULT 'doc',
  file_size INTEGER DEFAULT 0,
  mime_type TEXT,
  r2_key TEXT,
  status TEXT DEFAULT 'active',
  is_deleted INTEGER DEFAULT 0,
  ai_summary TEXT,
  template_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (folder_id) REFERENCES folders(id)
);
CREATE INDEX IF NOT EXISTS idx_docs_tenant ON documents(tenant_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_docs_folder ON documents(tenant_id, folder_id, is_deleted);
CREATE INDEX IF NOT EXISTS idx_docs_status ON documents(tenant_id, status, is_deleted);
CREATE INDEX IF NOT EXISTS idx_docs_updated ON documents(tenant_id, updated_at);

CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  r2_key TEXT,
  file_size INTEGER DEFAULT 0,
  mime_type TEXT,
  change_note TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (document_id) REFERENCES documents(id)
);
CREATE INDEX IF NOT EXISTS idx_versions_doc ON document_versions(document_id);

CREATE TABLE IF NOT EXISTS document_tags (
  document_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (document_id, tag),
  FOREIGN KEY (document_id) REFERENCES documents(id)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON document_tags(tag);

CREATE TABLE IF NOT EXISTS document_shares (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  shared_with_email TEXT NOT NULL,
  permission TEXT DEFAULT 'view',
  token TEXT UNIQUE NOT NULL,
  expires_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (document_id) REFERENCES documents(id)
);
CREATE INDEX IF NOT EXISTS idx_shares_token ON document_shares(token);
CREATE INDEX IF NOT EXISTS idx_shares_doc ON document_shares(document_id);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT DEFAULT 'general',
  content TEXT,
  fields_json TEXT,
  is_global INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX IF NOT EXISTS idx_templates_tenant ON templates(tenant_id);
