const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const dbPath = path.join(__dirname, '..', 'snags.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS snags (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT,
    priority TEXT DEFAULT 'Medium',
    status TEXT DEFAULT 'Open',
    trade TEXT,
    location TEXT,
    floor TEXT,
    zone TEXT,
    assignee TEXT,
    due_date TEXT,
    root_cause TEXT,
    recommendation TEXT,
    effort TEXT,
    photos TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

function generateId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
  return `SNG-${code}`;
}

function getAllSnags({ status, priority, search, sort } = {}) {
  let sql = 'SELECT * FROM snags WHERE 1=1';
  const params = [];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (priority) {
    sql += ' AND priority = ?';
    params.push(priority);
  }
  if (search) {
    sql += ' AND (title LIKE ? OR description LIKE ? OR id LIKE ? OR location LIKE ? OR assignee LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s, s, s);
  }

  if (sort === 'priority') {
    sql += ` ORDER BY CASE priority WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Medium' THEN 3 WHEN 'Low' THEN 4 ELSE 5 END, created_at DESC`;
  } else {
    sql += ' ORDER BY created_at DESC';
  }

  return db.prepare(sql).all(...params);
}

function getSnag(id) {
  return db.prepare('SELECT * FROM snags WHERE id = ?').get(id);
}

function createSnag(data) {
  const id = generateId();
  const stmt = db.prepare(`
    INSERT INTO snags (id, title, description, category, priority, status, trade, location, floor, zone, assignee, due_date, root_cause, recommendation, effort, photos)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id, data.title, data.description, data.category || null,
    data.priority || 'Medium', data.status || 'Open', data.trade || null,
    data.location || null, data.floor || null, data.zone || null,
    data.assignee || null, data.due_date || null, data.root_cause || null,
    data.recommendation || null, data.effort || null,
    JSON.stringify(data.photos || [])
  );
  return getSnag(id);
}

function updateSnag(id, data) {
  const existing = getSnag(id);
  if (!existing) return null;

  const fields = ['title', 'description', 'category', 'priority', 'status', 'trade', 'location', 'floor', 'zone', 'assignee', 'due_date', 'root_cause', 'recommendation', 'effort', 'photos'];
  const updates = [];
  const params = [];

  for (const f of fields) {
    if (data[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(f === 'photos' ? JSON.stringify(data[f]) : data[f]);
    }
  }

  if (updates.length === 0) return existing;

  updates.push("updated_at = datetime('now')");
  params.push(id);

  db.prepare(`UPDATE snags SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  return getSnag(id);
}

function deleteSnag(id) {
  const existing = getSnag(id);
  if (!existing) return false;
  db.prepare('DELETE FROM snags WHERE id = ?').run(id);
  return true;
}

function getStats() {
  const total = db.prepare('SELECT COUNT(*) as count FROM snags').get().count;
  const open = db.prepare("SELECT COUNT(*) as count FROM snags WHERE status = 'Open'").get().count;
  const inProgress = db.prepare("SELECT COUNT(*) as count FROM snags WHERE status = 'In Progress'").get().count;
  const resolved = db.prepare("SELECT COUNT(*) as count FROM snags WHERE status IN ('Resolved', 'Closed')").get().count;
  const critical = db.prepare("SELECT COUNT(*) as count FROM snags WHERE priority = 'Critical' AND status NOT IN ('Resolved', 'Closed')").get().count;
  return { total, open, inProgress, resolved, critical };
}

module.exports = { getAllSnags, getSnag, createSnag, updateSnag, deleteSnag, getStats };
