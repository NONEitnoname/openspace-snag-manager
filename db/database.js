const Database = require('better-sqlite3');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const dbPath = process.env.TEST_DB_PATH || process.env.DATABASE_PATH || path.join(dataDir, 'snag-pilot.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

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
`);

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

module.exports = { db, id, json, parseJson, ensurePilotProject, audit, close, dbPath };
