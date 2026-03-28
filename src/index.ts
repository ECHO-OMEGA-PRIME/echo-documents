/**
 * Echo Documents v1.0.0 — AI-Powered Document Management
 * Cloudflare Worker with Hono, D1, R2, KV, service bindings
 *
 * Features: folders, documents, versions, sharing, tags,
 * AI summarization, full-text search, templates
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  FILES: R2Bucket;
  ENGINE_RUNTIME: Fetcher;
  SHARED_BRAIN: Fetcher;
  ECHO_API_KEY?: string;
}

interface RLState { c: number; t: number }

const app = new Hono<{ Bindings: Env }>();
app.use('*', cors({ origin: '*', allowMethods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'], allowHeaders: ['Content-Type','Authorization','X-Tenant-ID','X-Echo-API-Key'] }));

// ── Helpers ──
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const sanitize = (s: string, max = 2000) => s?.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, max) ?? '';
const sanitizeBody = (o: Record<string, unknown>) => {
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) r[k] = typeof v === 'string' ? sanitize(v) : v;
  return r;
};
const tid = (c: any) => c.req.header('X-Tenant-ID') || c.req.query('tenant_id') || '';
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
const log = (level: string, msg: string, meta: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ level, msg, service: 'echo-documents', ts: now(), ...meta }));

// ── Rate Limiting ──
async function rateLimit(kv: KVNamespace, key: string, limit: number, windowSec = 60): Promise<boolean> {
  const rlKey = `rl:${key}`;
  const nowMs = Date.now();
  const raw = await kv.get(rlKey);
  if (!raw) { await kv.put(rlKey, JSON.stringify({ c: 1, t: nowMs }), { expirationTtl: windowSec * 2 }); return false; }
  const st: RLState = JSON.parse(raw);
  const elapsed = (nowMs - st.t) / 1000;
  const decay = Math.max(0, st.c - (elapsed / windowSec) * limit);
  const count = decay + 1;
  await kv.put(rlKey, JSON.stringify({ c: count, t: nowMs }), { expirationTtl: windowSec * 2 });
  return count > limit;
}

// ── Rate limit middleware ──
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === '/health' || path === '/status') return next();
  const ip = c.req.header('cf-connecting-ip') || 'unknown';
  const isWrite = ['POST','PUT','PATCH','DELETE'].includes(c.req.method);
  const limited = await rateLimit(c.env.CACHE, `${ip}:${isWrite ? 'w' : 'r'}`, isWrite ? 60 : 200);
  if (limited) return json({ error: 'Rate limited' }, 429);
  return next();
});

// ── Auth middleware ──
app.use('*', async (c, next) => {
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  if (method === 'GET' || method === 'OPTIONS' || method === 'HEAD' || path === '/health' || path === '/status') return next();
  const apiKey = c.req.header('X-Echo-API-Key') || '';
  const bearer = (c.req.header('Authorization') || '').replace('Bearer ', '');
  const expected = c.env.ECHO_API_KEY;
  if (!expected || (apiKey !== expected && bearer !== expected)) {
    return json({ error: 'Unauthorized', message: 'Valid X-Echo-API-Key or Bearer token required for write operations' }, 401);
  }
  return next();
});

// ═══════════════════════════════════════════════════
// HEALTH & STATUS
// ═══════════════════════════════════════════════════
app.get('/health', async (c) => {
  let dbOk = false;
  try { await c.env.DB.prepare('SELECT 1').first(); dbOk = true; } catch {}
  return json({
    status: dbOk ? 'ok' : 'degraded',
    service: 'echo-documents',
    version: '1.0.0',
    time: now(),
    db: dbOk ? 'connected' : 'error'
  });
});

app.get('/status', async (c) => {
  const counts = await c.env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM documents) as documents,
      (SELECT COUNT(*) FROM folders) as folders,
      (SELECT COUNT(*) FROM document_versions) as versions,
      (SELECT COUNT(*) FROM document_shares) as shares,
      (SELECT COUNT(*) FROM templates) as templates,
      (SELECT COUNT(*) FROM tenants) as tenants
  `).first();
  return json({ service: 'echo-documents', version: '1.0.0', time: now(), counts });
});

// ═══════════════════════════════════════════════════
// TENANTS
// ═══════════════════════════════════════════════════
app.post('/tenants', async (c) => {
  const b = sanitizeBody(await c.req.json());
  const id = uid();
  await c.env.DB.prepare(`INSERT INTO tenants (id, name, email, plan, storage_limit_mb, max_documents) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, b.name, b.email || null, b.plan || 'starter', b.storage_limit_mb || 500, b.max_documents || 100).run();
  log('info', 'tenant_created', { tenant_id: id });
  return json({ id }, 201);
});

app.get('/tenants/:id', async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM tenants WHERE id=?').bind(c.req.param('id')).first();
  return r ? json(r) : json({ error: 'Not found' }, 404);
});

app.put('/tenants/:id', async (c) => {
  const b = sanitizeBody(await c.req.json());
  await c.env.DB.prepare(`UPDATE tenants SET name=coalesce(?,name), email=coalesce(?,email), plan=coalesce(?,plan), storage_limit_mb=coalesce(?,storage_limit_mb), max_documents=coalesce(?,max_documents), updated_at=datetime('now') WHERE id=?`)
    .bind(b.name || null, b.email || null, b.plan || null, b.storage_limit_mb || null, b.max_documents || null, c.req.param('id')).run();
  return json({ updated: true });
});

// ═══════════════════════════════════════════════════
// FOLDERS
// ═══════════════════════════════════════════════════
app.get('/folders', async (c) => {
  const t = tid(c);
  const parentId = c.req.query('parent_id') || null;
  let q = 'SELECT * FROM folders WHERE tenant_id=?';
  const params: (string | null)[] = [t];
  if (parentId) { q += ' AND parent_id=?'; params.push(parentId); }
  else { q += ' AND parent_id IS NULL'; }
  q += ' ORDER BY name';
  const r = await c.env.DB.prepare(q).bind(...params).all();
  return json(r.results);
});

app.post('/folders', async (c) => {
  const t = tid(c);
  const b = sanitizeBody(await c.req.json());
  const id = uid();
  await c.env.DB.prepare('INSERT INTO folders (id, tenant_id, parent_id, name, description, color, icon) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, t, b.parent_id || null, b.name, b.description || null, b.color || '#3B82F6', b.icon || 'folder').run();
  log('info', 'folder_created', { tenant_id: t, folder_id: id });
  return json({ id }, 201);
});

app.get('/folders/:id', async (c) => {
  const r = await c.env.DB.prepare('SELECT * FROM folders WHERE id=? AND tenant_id=?').bind(c.req.param('id'), tid(c)).first();
  if (!r) return json({ error: 'Not found' }, 404);
  const docs = await c.env.DB.prepare('SELECT id, name, file_type, file_size, status, created_at, updated_at FROM documents WHERE folder_id=? AND tenant_id=? AND is_deleted=0 ORDER BY name').bind(c.req.param('id'), tid(c)).all();
  const subfolders = await c.env.DB.prepare('SELECT * FROM folders WHERE parent_id=? AND tenant_id=? ORDER BY name').bind(c.req.param('id'), tid(c)).all();
  return json({ ...r, documents: docs.results, subfolders: subfolders.results });
});

app.put('/folders/:id', async (c) => {
  const b = sanitizeBody(await c.req.json());
  await c.env.DB.prepare('UPDATE folders SET name=coalesce(?,name), description=coalesce(?,description), color=coalesce(?,color), icon=coalesce(?,icon), parent_id=coalesce(?,parent_id), updated_at=datetime(\'now\') WHERE id=? AND tenant_id=?')
    .bind(b.name || null, b.description || null, b.color || null, b.icon || null, b.parent_id || null, c.req.param('id'), tid(c)).run();
  return json({ updated: true });
});

app.delete('/folders/:id', async (c) => {
  const t = tid(c);
  const folderId = c.req.param('id');
  const docs = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM documents WHERE folder_id=? AND tenant_id=? AND is_deleted=0').bind(folderId, t).first() as any;
  if (docs?.cnt > 0) return json({ error: 'Folder contains documents. Move or delete them first.' }, 400);
  const subs = await c.env.DB.prepare('SELECT COUNT(*) as cnt FROM folders WHERE parent_id=? AND tenant_id=?').bind(folderId, t).first() as any;
  if (subs?.cnt > 0) return json({ error: 'Folder contains subfolders. Delete them first.' }, 400);
  await c.env.DB.prepare('DELETE FROM folders WHERE id=? AND tenant_id=?').bind(folderId, t).run();
  return json({ deleted: true });
});

// ═══════════════════════════════════════════════════
// DOCUMENTS (CRUD + R2 upload/download)
// ═══════════════════════════════════════════════════
app.get('/documents', async (c) => {
  const t = tid(c);
  const folderId = c.req.query('folder_id');
  const search = c.req.query('search');
  const status = c.req.query('status');
  const tag = c.req.query('tag');
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
  const offset = parseInt(c.req.query('offset') || '0');

  let q = 'SELECT d.* FROM documents d WHERE d.tenant_id=? AND d.is_deleted=0';
  const params: (string | number)[] = [t];

  if (folderId) { q += ' AND d.folder_id=?'; params.push(folderId); }
  if (status) { q += ' AND d.status=?'; params.push(sanitize(status, 20)); }
  if (search) {
    const s = `%${sanitize(search, 100)}%`;
    q += ' AND (d.name LIKE ? OR d.description LIKE ? OR d.ai_summary LIKE ?)';
    params.push(s, s, s);
  }
  if (tag) {
    q += ' AND d.id IN (SELECT document_id FROM document_tags WHERE tag=?)';
    params.push(sanitize(tag, 50));
  }
  q += ' ORDER BY d.updated_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const r = await c.env.DB.prepare(q).bind(...params).all();
  return json({ documents: r.results, limit, offset });
});

app.post('/documents', async (c) => {
  const t = tid(c);
  const contentType = c.req.header('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const file = form.get('file') as File | null;
    if (!file) return json({ error: 'No file provided' }, 400);

    const id = uid();
    const name = sanitize(form.get('name') as string || file.name, 255);
    const folderId = form.get('folder_id') as string || null;
    const description = sanitize(form.get('description') as string || '', 2000);
    const r2Key = `documents/${t}/${id}/${file.name}`;

    await c.env.FILES.put(r2Key, file.stream(), {
      httpMetadata: { contentType: file.type },
      customMetadata: { tenant_id: t, document_id: id, original_name: file.name }
    });

    await c.env.DB.prepare(`INSERT INTO documents (id, tenant_id, folder_id, name, description, file_type, file_size, mime_type, r2_key, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`)
      .bind(id, t, folderId, name, description, file.name.split('.').pop()?.toLowerCase() || 'unknown', file.size, file.type, r2Key).run();

    await c.env.DB.prepare('INSERT INTO document_versions (id, document_id, tenant_id, version_number, r2_key, file_size, mime_type, change_note) VALUES (?, ?, ?, 1, ?, ?, ?, ?)')
      .bind(uid(), id, t, r2Key, file.size, file.type, 'Initial upload').run();

    log('info', 'document_uploaded', { tenant_id: t, document_id: id, size: file.size, type: file.type });
    return json({ id, r2_key: r2Key }, 201);
  }

  // JSON metadata-only creation
  const b = sanitizeBody(await c.req.json());
  const id = uid();
  await c.env.DB.prepare(`INSERT INTO documents (id, tenant_id, folder_id, name, description, file_type, status) VALUES (?, ?, ?, ?, ?, ?, 'draft')`)
    .bind(id, t, b.folder_id || null, b.name, b.description || null, b.file_type || 'doc').run();
  log('info', 'document_created', { tenant_id: t, document_id: id });
  return json({ id }, 201);
});

app.get('/documents/:id', async (c) => {
  const t = tid(c);
  const docId = c.req.param('id');
  const doc = await c.env.DB.prepare('SELECT * FROM documents WHERE id=? AND tenant_id=? AND is_deleted=0').bind(docId, t).first();
  if (!doc) return json({ error: 'Not found' }, 404);

  const versions = await c.env.DB.prepare('SELECT id, version_number, file_size, mime_type, change_note, created_at FROM document_versions WHERE document_id=? AND tenant_id=? ORDER BY version_number DESC').bind(docId, t).all();
  const tags = await c.env.DB.prepare('SELECT tag FROM document_tags WHERE document_id=?').bind(docId).all();
  const shares = await c.env.DB.prepare('SELECT id, shared_with_email, permission, expires_at, created_at FROM document_shares WHERE document_id=? AND tenant_id=?').bind(docId, t).all();

  return json({ ...doc, versions: versions.results, tags: tags.results.map((r: any) => r.tag), shares: shares.results });
});

app.put('/documents/:id', async (c) => {
  const b = sanitizeBody(await c.req.json());
  await c.env.DB.prepare(`UPDATE documents SET name=coalesce(?,name), description=coalesce(?,description), folder_id=coalesce(?,folder_id), status=coalesce(?,status), updated_at=datetime('now') WHERE id=? AND tenant_id=?`)
    .bind(b.name || null, b.description || null, b.folder_id || null, b.status || null, c.req.param('id'), tid(c)).run();
  return json({ updated: true });
});

app.delete('/documents/:id', async (c) => {
  // Soft delete
  await c.env.DB.prepare("UPDATE documents SET is_deleted=1, status='deleted', updated_at=datetime('now') WHERE id=? AND tenant_id=?")
    .bind(c.req.param('id'), tid(c)).run();
  log('info', 'document_deleted', { tenant_id: tid(c), document_id: c.req.param('id') });
  return json({ deleted: true });
});

// ── Download file from R2 ──
app.get('/documents/:id/download', async (c) => {
  const doc = await c.env.DB.prepare('SELECT r2_key, name, mime_type FROM documents WHERE id=? AND tenant_id=? AND is_deleted=0').bind(c.req.param('id'), tid(c)).first() as any;
  if (!doc?.r2_key) return json({ error: 'File not found' }, 404);

  const obj = await c.env.FILES.get(doc.r2_key);
  if (!obj) return json({ error: 'File not in storage' }, 404);

  return new Response(obj.body, {
    headers: {
      'Content-Type': doc.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${doc.name}"`,
      'Content-Length': String(obj.size),
    }
  });
});

// ── Upload new version ──
app.post('/documents/:id/versions', async (c) => {
  const t = tid(c);
  const docId = c.req.param('id');
  const doc = await c.env.DB.prepare('SELECT * FROM documents WHERE id=? AND tenant_id=? AND is_deleted=0').bind(docId, t).first() as any;
  if (!doc) return json({ error: 'Document not found' }, 404);

  const form = await c.req.formData();
  const file = form.get('file') as File | null;
  if (!file) return json({ error: 'No file provided' }, 400);

  const lastVersion = await c.env.DB.prepare('SELECT MAX(version_number) as max_v FROM document_versions WHERE document_id=? AND tenant_id=?').bind(docId, t).first() as any;
  const versionNum = (lastVersion?.max_v || 0) + 1;
  const r2Key = `documents/${t}/${docId}/v${versionNum}_${file.name}`;
  const changeNote = sanitize(form.get('change_note') as string || `Version ${versionNum}`, 500);

  await c.env.FILES.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type },
    customMetadata: { tenant_id: t, document_id: docId, version: String(versionNum) }
  });

  const vId = uid();
  await c.env.DB.prepare('INSERT INTO document_versions (id, document_id, tenant_id, version_number, r2_key, file_size, mime_type, change_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(vId, docId, t, versionNum, r2Key, file.size, file.type, changeNote).run();

  await c.env.DB.prepare("UPDATE documents SET r2_key=?, file_size=?, mime_type=?, file_type=?, updated_at=datetime('now') WHERE id=?")
    .bind(r2Key, file.size, file.type, file.name.split('.').pop()?.toLowerCase() || doc.file_type, docId).run();

  log('info', 'version_uploaded', { tenant_id: t, document_id: docId, version: versionNum, size: file.size });
  return json({ id: vId, version_number: versionNum }, 201);
});

// ═══════════════════════════════════════════════════
// TAGS
// ═══════════════════════════════════════════════════
app.get('/documents/:id/tags', async (c) => {
  const r = await c.env.DB.prepare('SELECT tag FROM document_tags WHERE document_id=?').bind(c.req.param('id')).all();
  return json(r.results.map((t: any) => t.tag));
});

app.post('/documents/:id/tags', async (c) => {
  const b = await c.req.json() as { tags: string[] };
  const docId = c.req.param('id');
  if (!b.tags?.length) return json({ error: 'tags array required' }, 400);
  for (const tag of b.tags) {
    await c.env.DB.prepare('INSERT OR IGNORE INTO document_tags (document_id, tag) VALUES (?, ?)')
      .bind(docId, sanitize(tag, 50)).run();
  }
  return json({ added: b.tags.length });
});

app.delete('/documents/:id/tags/:tag', async (c) => {
  await c.env.DB.prepare('DELETE FROM document_tags WHERE document_id=? AND tag=?')
    .bind(c.req.param('id'), c.req.param('tag')).run();
  return json({ removed: true });
});

// ── Tag cloud for tenant ──
app.get('/tags', async (c) => {
  const r = await c.env.DB.prepare(`
    SELECT dt.tag, COUNT(*) as count
    FROM document_tags dt
    JOIN documents d ON d.id = dt.document_id
    WHERE d.tenant_id=? AND d.is_deleted=0
    GROUP BY dt.tag ORDER BY count DESC LIMIT 100
  `).bind(tid(c)).all();
  return json(r.results);
});

// ═══════════════════════════════════════════════════
// SHARING
// ═══════════════════════════════════════════════════
app.post('/documents/:id/share', async (c) => {
  const t = tid(c);
  const docId = c.req.param('id');
  const b = sanitizeBody(await c.req.json());
  if (!b.shared_with_email) return json({ error: 'shared_with_email required' }, 400);

  const id = uid();
  const token = crypto.randomUUID().replace(/-/g, '');
  await c.env.DB.prepare('INSERT INTO document_shares (id, document_id, tenant_id, shared_with_email, permission, token, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, docId, t, b.shared_with_email, b.permission || 'view', token, b.expires_at || null).run();
  log('info', 'document_shared', { tenant_id: t, document_id: docId, email: b.shared_with_email });
  return json({ id, token, share_url: `https://echo-documents.bmcii1976.workers.dev/shared/${token}` }, 201);
});

app.get('/shared/:token', async (c) => {
  const share = await c.env.DB.prepare(`
    SELECT ds.*, d.name, d.description, d.file_type, d.file_size, d.mime_type, d.r2_key, d.ai_summary
    FROM document_shares ds
    JOIN documents d ON d.id = ds.document_id
    WHERE ds.token=? AND d.is_deleted=0
  `).bind(c.req.param('token')).first() as any;
  if (!share) return json({ error: 'Invalid or expired share link' }, 404);
  if (share.expires_at && new Date(share.expires_at) < new Date()) return json({ error: 'Share link expired' }, 410);
  return json({ name: share.name, description: share.description, file_type: share.file_type, file_size: share.file_size, permission: share.permission, ai_summary: share.ai_summary });
});

app.get('/shared/:token/download', async (c) => {
  const share = await c.env.DB.prepare(`
    SELECT ds.permission, d.r2_key, d.name, d.mime_type
    FROM document_shares ds
    JOIN documents d ON d.id = ds.document_id
    WHERE ds.token=? AND d.is_deleted=0
  `).bind(c.req.param('token')).first() as any;
  if (!share) return json({ error: 'Invalid share link' }, 404);
  if (share.permission === 'metadata') return json({ error: 'Download not permitted' }, 403);
  if (!share.r2_key) return json({ error: 'No file attached' }, 404);

  const obj = await c.env.FILES.get(share.r2_key);
  if (!obj) return json({ error: 'File not in storage' }, 404);
  return new Response(obj.body, {
    headers: {
      'Content-Type': share.mime_type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${share.name}"`,
    }
  });
});

app.delete('/documents/:id/share/:shareId', async (c) => {
  await c.env.DB.prepare('DELETE FROM document_shares WHERE id=? AND document_id=? AND tenant_id=?')
    .bind(c.req.param('shareId'), c.req.param('id'), tid(c)).run();
  return json({ revoked: true });
});

// ═══════════════════════════════════════════════════
// TEMPLATES
// ═══════════════════════════════════════════════════
app.get('/templates', async (c) => {
  const t = tid(c);
  const category = c.req.query('category');
  let q = 'SELECT * FROM templates WHERE (tenant_id=? OR is_global=1)';
  const params: string[] = [t];
  if (category) { q += ' AND category=?'; params.push(sanitize(category, 50)); }
  q += ' ORDER BY name';
  const r = await c.env.DB.prepare(q).bind(...params).all();
  return json(r.results);
});

app.post('/templates', async (c) => {
  const t = tid(c);
  const b = sanitizeBody(await c.req.json());
  const id = uid();
  await c.env.DB.prepare('INSERT INTO templates (id, tenant_id, name, description, category, content, fields_json, is_global) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, t, b.name, b.description || null, b.category || 'general', b.content || '', b.fields_json ? JSON.stringify(b.fields_json) : null, b.is_global ? 1 : 0).run();
  return json({ id }, 201);
});

app.post('/templates/:id/generate', async (c) => {
  const t = tid(c);
  const template = await c.env.DB.prepare('SELECT * FROM templates WHERE id=? AND (tenant_id=? OR is_global=1)').bind(c.req.param('id'), t).first() as any;
  if (!template) return json({ error: 'Template not found' }, 404);

  const b = await c.req.json() as { variables?: Record<string, string>; document_name?: string; folder_id?: string };
  let content = template.content || '';
  if (b.variables) {
    for (const [k, v] of Object.entries(b.variables)) {
      content = content.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), sanitize(v, 500));
    }
  }

  const docId = uid();
  const docName = sanitize(b.document_name || `${template.name} - ${new Date().toLocaleDateString()}`, 255);
  await c.env.DB.prepare(`INSERT INTO documents (id, tenant_id, folder_id, name, description, file_type, status, template_id) VALUES (?, ?, ?, ?, ?, 'doc', 'active', ?)`)
    .bind(docId, t, b.folder_id || null, docName, `Generated from template: ${template.name}`, c.req.param('id')).run();

  // Store generated content in R2
  const r2Key = `documents/${t}/${docId}/generated.txt`;
  await c.env.FILES.put(r2Key, content, { httpMetadata: { contentType: 'text/plain' } });
  await c.env.DB.prepare("UPDATE documents SET r2_key=?, file_size=?, mime_type='text/plain' WHERE id=?")
    .bind(r2Key, new TextEncoder().encode(content).length, docId).run();

  log('info', 'document_generated', { tenant_id: t, document_id: docId, template_id: c.req.param('id') });
  return json({ id: docId, name: docName, content_preview: content.slice(0, 500) }, 201);
});

// ═══════════════════════════════════════════════════
// AI FEATURES (via Engine Runtime)
// ═══════════════════════════════════════════════════
app.post('/documents/:id/summarize', async (c) => {
  const t = tid(c);
  const docId = c.req.param('id');
  const doc = await c.env.DB.prepare('SELECT * FROM documents WHERE id=? AND tenant_id=? AND is_deleted=0').bind(docId, t).first() as any;
  if (!doc) return json({ error: 'Document not found' }, 404);

  let content = '';
  if (doc.r2_key) {
    const obj = await c.env.FILES.get(doc.r2_key);
    if (obj) {
      const text = await obj.text();
      content = text.slice(0, 8000);
    }
  }
  if (!content) return json({ error: 'No readable content for summarization' }, 400);

  try {
    const resp = await c.env.ENGINE_RUNTIME.fetch('https://engine-runtime/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engine_id: 'LG04',
        query: `Summarize the following document concisely in 2-3 paragraphs:\n\n${content}`,
        max_tokens: 500
      })
    });
    const result = await resp.json() as any;
    const summary = result.response || result.answer || 'Summary generation failed';

    await c.env.DB.prepare("UPDATE documents SET ai_summary=?, updated_at=datetime('now') WHERE id=?")
      .bind(sanitize(summary, 5000), docId).run();

    log('info', 'document_summarized', { tenant_id: t, document_id: docId });
    return json({ summary });
  } catch (e: any) {
    log('error', 'summarize_failed', { error: e.message, document_id: docId });
    return json({ error: 'AI summarization temporarily unavailable' }, 503);
  }
});

app.post('/documents/:id/classify', async (c) => {
  const t = tid(c);
  const docId = c.req.param('id');
  const doc = await c.env.DB.prepare('SELECT * FROM documents WHERE id=? AND tenant_id=? AND is_deleted=0').bind(docId, t).first() as any;
  if (!doc) return json({ error: 'Document not found' }, 404);

  let content = '';
  if (doc.r2_key) {
    const obj = await c.env.FILES.get(doc.r2_key);
    if (obj) { content = (await obj.text()).slice(0, 4000); }
  }
  if (!content) content = `${doc.name} ${doc.description || ''}`;

  try {
    const resp = await c.env.ENGINE_RUNTIME.fetch('https://engine-runtime/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        engine_id: 'LG04',
        query: `Classify this document into one category (contract, invoice, report, letter, manual, policy, proposal, other) and suggest 3-5 relevant tags. Document: ${content}\n\nRespond as JSON: {"category":"...","tags":["..."],"confidence":0.0-1.0}`,
        max_tokens: 200
      })
    });
    const result = await resp.json() as any;
    const answer = result.response || result.answer || '';
    let classification = { category: 'other', tags: [] as string[], confidence: 0 };
    try { classification = JSON.parse(answer); } catch {}

    // Auto-apply tags
    for (const tag of classification.tags) {
      await c.env.DB.prepare('INSERT OR IGNORE INTO document_tags (document_id, tag) VALUES (?, ?)')
        .bind(docId, sanitize(tag, 50)).run();
    }

    return json(classification);
  } catch (e: any) {
    log('error', 'classify_failed', { error: e.message, document_id: docId });
    return json({ error: 'AI classification temporarily unavailable' }, 503);
  }
});

// ═══════════════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════════════
app.get('/search', async (c) => {
  const t = tid(c);
  const q = c.req.query('q');
  if (!q) return json({ error: 'q parameter required' }, 400);
  const s = `%${sanitize(q, 200)}%`;
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);

  const results = await c.env.DB.prepare(`
    SELECT d.id, d.name, d.description, d.file_type, d.file_size, d.status, d.ai_summary, d.created_at, d.updated_at,
           f.name as folder_name
    FROM documents d
    LEFT JOIN folders f ON f.id = d.folder_id
    WHERE d.tenant_id=? AND d.is_deleted=0
      AND (d.name LIKE ? OR d.description LIKE ? OR d.ai_summary LIKE ?
           OR d.id IN (SELECT document_id FROM document_tags WHERE tag LIKE ?))
    ORDER BY d.updated_at DESC LIMIT ?
  `).bind(t, s, s, s, s, limit).all();

  return json({ query: q, count: results.results.length, results: results.results });
});

// ═══════════════════════════════════════════════════
// RECENT ACTIVITY
// ═══════════════════════════════════════════════════
app.get('/activity', async (c) => {
  const t = tid(c);
  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
  const r = await c.env.DB.prepare(`
    SELECT id, name, file_type, status, updated_at, 'document' as type FROM documents WHERE tenant_id=? AND is_deleted=0
    UNION ALL
    SELECT id, name, NULL, NULL, updated_at, 'folder' as type FROM folders WHERE tenant_id=?
    ORDER BY updated_at DESC LIMIT ?
  `).bind(t, t, limit).all();
  return json(r.results);
});

// ═══════════════════════════════════════════════════
// STORAGE STATS
// ═══════════════════════════════════════════════════
app.get('/storage', async (c) => {
  const t = tid(c);
  const stats = await c.env.DB.prepare(`
    SELECT
      COUNT(*) as total_documents,
      SUM(CASE WHEN file_size IS NOT NULL THEN file_size ELSE 0 END) as total_bytes,
      COUNT(CASE WHEN status='active' THEN 1 END) as active,
      COUNT(CASE WHEN status='draft' THEN 1 END) as drafts,
      COUNT(CASE WHEN status='archived' THEN 1 END) as archived
    FROM documents WHERE tenant_id=? AND is_deleted=0
  `).bind(t).first();
  const tenant = await c.env.DB.prepare('SELECT storage_limit_mb, max_documents FROM tenants WHERE id=?').bind(t).first() as any;
  const totalBytes = (stats as any)?.total_bytes || 0;
  const limitBytes = ((tenant?.storage_limit_mb || 500) * 1024 * 1024);
  return json({
    ...stats,
    total_mb: Math.round(totalBytes / 1024 / 1024 * 100) / 100,
    limit_mb: tenant?.storage_limit_mb || 500,
    usage_percent: Math.round((totalBytes / limitBytes) * 10000) / 100,
    max_documents: tenant?.max_documents || 100
  });
});

// ═══════════════════════════════════════════════════
// TRASH (soft-deleted recovery)
// ═══════════════════════════════════════════════════
app.get('/trash', async (c) => {
  const r = await c.env.DB.prepare('SELECT id, name, file_type, file_size, updated_at FROM documents WHERE tenant_id=? AND is_deleted=1 ORDER BY updated_at DESC LIMIT 50').bind(tid(c)).all();
  return json(r.results);
});

app.post('/trash/:id/restore', async (c) => {
  await c.env.DB.prepare("UPDATE documents SET is_deleted=0, status='active', updated_at=datetime('now') WHERE id=? AND tenant_id=?")
    .bind(c.req.param('id'), tid(c)).run();
  return json({ restored: true });
});

app.delete('/trash/:id', async (c) => {
  const t = tid(c);
  const docId = c.req.param('id');
  const doc = await c.env.DB.prepare('SELECT r2_key FROM documents WHERE id=? AND tenant_id=? AND is_deleted=1').bind(docId, t).first() as any;
  if (!doc) return json({ error: 'Not found in trash' }, 404);

  // Delete all versions from R2
  const versions = await c.env.DB.prepare('SELECT r2_key FROM document_versions WHERE document_id=? AND tenant_id=?').bind(docId, t).all();
  for (const v of versions.results as any[]) {
    if (v.r2_key) await c.env.FILES.delete(v.r2_key);
  }
  if (doc.r2_key) await c.env.FILES.delete(doc.r2_key);

  // Hard delete from D1
  await c.env.DB.prepare('DELETE FROM document_versions WHERE document_id=? AND tenant_id=?').bind(docId, t).run();
  await c.env.DB.prepare('DELETE FROM document_tags WHERE document_id=?').bind(docId).run();
  await c.env.DB.prepare('DELETE FROM document_shares WHERE document_id=? AND tenant_id=?').bind(docId, t).run();
  await c.env.DB.prepare('DELETE FROM documents WHERE id=? AND tenant_id=?').bind(docId, t).run();

  log('info', 'document_purged', { tenant_id: t, document_id: docId });
  return json({ purged: true });
});

// ═══════════════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════════════

app.onError((err, c) => {
  if (err.message?.includes('JSON')) {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  console.error(`[echo-documents] ${err.message}`);
  return c.json({ error: 'Internal server error' }, 500);
});

app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Auto-purge: permanently delete trashed documents older than 30 days
    try {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const old = await env.DB.prepare('SELECT id, tenant_id, r2_key FROM documents WHERE is_deleted=1 AND updated_at < ?').bind(cutoff).all();
      for (const doc of old.results as any[]) {
        if (doc.r2_key) await env.FILES.delete(doc.r2_key);
        const versions = await env.DB.prepare('SELECT r2_key FROM document_versions WHERE document_id=?').bind(doc.id).all();
        for (const v of versions.results as any[]) { if ((v as any).r2_key) await env.FILES.delete((v as any).r2_key); }
        await env.DB.prepare('DELETE FROM document_versions WHERE document_id=?').bind(doc.id).run();
        await env.DB.prepare('DELETE FROM document_tags WHERE document_id=?').bind(doc.id).run();
        await env.DB.prepare('DELETE FROM document_shares WHERE document_id=?').bind(doc.id).run();
        await env.DB.prepare('DELETE FROM documents WHERE id=?').bind(doc.id).run();
      }
      log('info', 'trash_autopurge', { purged: old.results.length });
    } catch (e: any) {
      log('error', 'trash_autopurge_failed', { error: e.message });
    }
  }
};
