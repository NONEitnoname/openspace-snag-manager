const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/* Checked here, before the first mkdir, because everything below writes to this path.
   A DATA_DIR that is not an absolute POSIX path in production almost always means a
   mangled env var (Git Bash rewrites "/data" into a Windows path), which silently sends
   the database to the container's ephemeral disk instead of the mounted volume. Refuse
   to create anything rather than accept writes that will vanish on the next deploy. */
if (process.env.NODE_ENV === 'production' && process.env.DATA_DIR && !/^\/[^\s:]*$/.test(process.env.DATA_DIR)) {
  throw new Error(`DATA_DIR must be an absolute path with no drive letter or spaces; received "${process.env.DATA_DIR}". Data would not persist.`);
}

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const dbPath = process.env.TEST_DB_PATH || process.env.DATABASE_PATH || path.join(dataDir, 'snag-pilot.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true });
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','inspector','reviewer')),
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invites (
    token_hash TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    role TEXT NOT NULL CHECK(role IN ('admin','inspector','reviewer')),
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS project_memberships (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('admin','inspector','reviewer')),
    PRIMARY KEY(project_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS analysis_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL REFERENCES users(id),
    state TEXT NOT NULL CHECK(state IN ('queued','processing','completed','completed_with_errors','failed','cancelled')),
    openspace_url TEXT,
    context_type TEXT NOT NULL CHECK(context_type IN ('linked','unlinked')),
    unlinked_reason TEXT,
    consent_at TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'mimarai',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS analysis_assets (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','processing','completed','failed','cancelled')),
    upstream_job_id TEXT,
    upstream_error TEXT,
    progress INTEGER NOT NULL DEFAULT 0,
    progress_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS draft_findings (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES analysis_assets(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK(state IN ('needs_review','approved','rejected','handed_off')) DEFAULT 'needs_review',
    version INTEGER NOT NULL DEFAULT 1,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT,
    priority TEXT CHECK(priority IN ('Critical','High','Medium','Low')),
    trade TEXT,
    recommendation TEXT,
    confidence REAL,
    code_claims TEXT NOT NULL DEFAULT '[]',
    spec_matches TEXT NOT NULL DEFAULT '[]',
    provider_model TEXT,
    prompt_version TEXT NOT NULL DEFAULT 'pilot-v1',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS handoffs (
    finding_id TEXT PRIMARY KEY REFERENCES draft_findings(id) ON DELETE CASCADE,
    openspace_field_note_url TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    handed_off_by TEXT NOT NULL REFERENCES users(id),
    handed_off_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS spec_clauses (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT,
    priority TEXT CHECK(priority IN ('Critical','High','Medium','Low')),
    source_name TEXT,
    source_page TEXT,
    revision TEXT,
    active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS snags (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    human_ref TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT,
    priority TEXT NOT NULL DEFAULT 'Medium' CHECK(priority IN ('Critical','High','Medium','Low')),
    status TEXT NOT NULL DEFAULT 'Open' CHECK(status IN ('Open','In Progress','Resolved','Closed')),
    trade TEXT,
    location TEXT,
    floor TEXT,
    zone TEXT,
    assignee TEXT,
    due_date TEXT,
    root_cause TEXT,
    recommendation TEXT,
    resolved_at TEXT,
    photos TEXT NOT NULL DEFAULT '[]',
    source_finding_id TEXT REFERENCES draft_findings(id) ON DELETE SET NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    actor_id TEXT REFERENCES users(id),
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_runs_project_created ON analysis_runs(project_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_assets_run ON analysis_assets(run_id);
  CREATE INDEX IF NOT EXISTS idx_findings_state_created ON draft_findings(state, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_user_expiry ON sessions(user_id, expires_at);
  CREATE INDEX IF NOT EXISTS idx_snags_project_status ON snags(project_id, status, created_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_snags_source_finding ON snags(source_finding_id) WHERE source_finding_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_audit_project_created ON audit_events(project_id, created_at DESC, id DESC);
`);

function transaction(fn) {
  db.exec('BEGIN');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

/* Adding a column is idempotent by catch, so these can run on every boot. */
for (const alter of [
  'ALTER TABLE analysis_assets ADD COLUMN progress INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE analysis_assets ADD COLUMN progress_message TEXT',
  'ALTER TABLE snags ADD COLUMN resolved_at TEXT'
]) {
  try { db.exec(alter); } catch { /* column already exists */ }
}

/* Data migrations are NOT idempotent, so each runs exactly once and is recorded in
   schema_migrations — the table this schema has always declared. Re-running one of these
   on every boot is how a backfill quietly turns into corruption. */
const DATA_MIGRATIONS = [
  {
    version: 1,
    /* Snags resolved before resolved_at existed have only updated_at to go on. That is
       the approximation the column exists to stop making: fill it from the best signal
       available this once, and never infer a resolution date again. */
    apply: () => db.exec("UPDATE snags SET resolved_at = updated_at WHERE resolved_at IS NULL AND status IN ('Resolved','Closed')")
  },
  {
    version: 2,
    /* The first resolved_at stamps were written with JS toISOString ('...T...Z') while
       every other timestamp here is SQLite datetime('now'). Two shapes in one column do
       not compare as strings, so normalise the stragglers onto the schema's convention. */
    apply: () => db.exec("UPDATE snags SET resolved_at = datetime(resolved_at) WHERE resolved_at IS NOT NULL AND resolved_at LIKE '%T%'")
  }
];
const migrationApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?');
const recordMigration = db.prepare('INSERT INTO schema_migrations (version) VALUES (?)');
for (const migration of DATA_MIGRATIONS) {
  if (migrationApplied.get(migration.version)) continue;
  transaction(() => { migration.apply(); recordMigration.run(migration.version); });
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function json(value) {
  return JSON.stringify(value ?? []);
}

function parseJson(value, fallback = []) {
  try { return JSON.parse(value || JSON.stringify(fallback)); } catch { return fallback; }
}

function ensurePilotProject() {
  const existing = db.prepare('SELECT * FROM projects ORDER BY created_at LIMIT 1').get();
  if (existing) return existing;
  const project = { id: id('prj'), name: process.env.PILOT_PROJECT_NAME || 'OpenSpace Pilot' };
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(project.id, project.name);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
}

function audit({ projectId = null, actorId = null, entityType, entityId, action, details = {} }) {
  db.prepare('INSERT INTO audit_events (id, project_id, actor_id, entity_type, entity_id, action, details) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id('evt'), projectId, actorId, entityType, entityId, action, JSON.stringify(details));
}

function close() { db.close(); }

module.exports = { db, id, json, parseJson, ensurePilotProject, audit, transaction, close, dbPath };
