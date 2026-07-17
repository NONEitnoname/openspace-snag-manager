require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { db, id, json, parseJson, ensurePilotProject, audit } = require('./db/database');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const uploadsDir = process.env.UPLOADS_DIR || path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'uploads');
const providerRuns = new Map();
const loginAttempts = new Map();
fs.mkdirSync(uploadsDir, { recursive: true });

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src https://*.openspace.ai https://openspace.ai; base-uri 'self'; form-action 'self'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function now() { return new Date().toISOString(); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function randomToken() { return crypto.randomBytes(32).toString('base64url'); }
function cookieOptions() { return { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 12 * 60 * 60 * 1000 }; }
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const index = v.indexOf('=');
    return index < 0 ? [v, ''] : [v.slice(0, index), decodeURIComponent(v.slice(index + 1))];
  }));
}
function sendError(res, status, code, message, fields) {
  return res.status(status).json({ error: { code, message, requestId: res.locals.requestId, ...(fields ? { fields } : {}) } });
}
function safeJson(value, fallback = []) { return parseJson(value, fallback); }
function serializeFinding(row) {
  return { ...row, code_claims: safeJson(row.code_claims), spec_matches: safeJson(row.spec_matches), confidence: row.confidence == null ? null : Number(row.confidence) };
}
function allowedOpenSpaceUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !(host === 'openspace.ai' || host.endsWith('.openspace.ai'))) return null;
    return url.toString();
  } catch { return null; }
}
function rateLimit(bucket, max, windowMs) {
  return (req, res, next) => {
    const key = `${bucket}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    const entry = loginAttempts.get(key);
    const stamp = Date.now();
    if (!entry || stamp - entry.startedAt > windowMs) {
      loginAttempts.set(key, { startedAt: stamp, count: 1 });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) return sendError(res, 429, 'rate_limited', 'Too many attempts. Try again later.');
    next();
  };
}
function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}
function passwordMatches(password, stored) {
  const [kind, salt, digest] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !digest) return false;
  const candidate = crypto.scryptSync(password, Buffer.from(salt, 'base64url'), 64);
  const expected = Buffer.from(digest, 'base64url');
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}
function validPassword(password) { return typeof password === 'string' && password.length >= 12 && password.length <= 128; }
function createSession(userId) {
  const token = randomToken();
  const csrf = randomToken();
  const expires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), userId, csrf, expires);
  return { token, csrf, expires };
}
function currentUser(req) {
  const token = parseCookies(req).snag_session;
  if (!token) return null;
  return db.prepare(`SELECT u.id, u.email, u.role, u.active, s.csrf_token, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`).get(sha256(token), now()) || null;
}
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return sendError(res, 401, 'authentication_required', 'Sign in is required.');
  req.user = user;
  next();
}
function requireRole(...roles) {
  return (req, res, next) => roles.includes(req.user.role) ? next() : sendError(res, 403, 'forbidden', 'You do not have permission for this action.');
}
function requireCsrf(req, res, next) {
  const origin = req.headers.origin;
  const expectedOrigin = process.env.APP_ORIGIN;
  if (expectedOrigin && origin && origin !== expectedOrigin) return sendError(res, 403, 'origin_invalid', 'Request origin is not allowed.');
  if (req.headers['x-csrf-token'] !== req.user.csrf_token) return sendError(res, 403, 'csrf_invalid', 'Your session token is missing or expired.');
  next();
}
function projectForUser(userId, projectId) {
  return db.prepare(`SELECT p.* FROM projects p JOIN project_memberships m ON m.project_id = p.id WHERE m.user_id = ? AND p.id = ?`).get(userId, projectId);
}
function userProjects(userId) {
  return db.prepare(`SELECT p.*, m.role FROM projects p JOIN project_memberships m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.created_at`).all(userId);
}
function logEvent(projectId, actorId, entityType, entityId, action, details = {}) {
  audit({ projectId, actorId, entityType, entityId, action, details });
}

function bootstrapAdmin() {
  const project = ensurePilotProject();
  const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (count || !process.env.BOOTSTRAP_ADMIN_EMAIL || !process.env.BOOTSTRAP_ADMIN_PASSWORD) return;
  if (!validPassword(process.env.BOOTSTRAP_ADMIN_PASSWORD)) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters');
  const userId = id('usr');
  db.prepare('INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(userId, process.env.BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase(), passwordHash(process.env.BOOTSTRAP_ADMIN_PASSWORD), 'admin');
  db.prepare('INSERT INTO project_memberships (project_id, user_id, role) VALUES (?, ?, ?)').run(project.id, userId, 'admin');
  logEvent(project.id, userId, 'user', userId, 'bootstrap_admin');
}
bootstrapAdmin();

function hasAllowedImageSignature(buffer, mime) {
  const jpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png = buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp = buffer.length > 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  return (mime === 'image/jpeg' && jpeg) || (mime === 'image/png' && png) || (mime === 'image/webp' && webp);
}
function extensionFor(mime) { return mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg'; }
const upload = multer({ storage: multer.memoryStorage(), limits: { files: 5, fileSize: 8 * 1024 * 1024, fields: 10 }, fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) });

async function providerFetch(url, options, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
function mappedFindings(data) {
  const findings = data?.analysis?.findings || data?.findings || [];
  if (!Array.isArray(findings)) return [];
  return findings.map(item => ({
    title: String(item.title || item.text?.split('.')[0] || 'Potential site issue').slice(0, 160),
    description: String(item.description || item.text || '').slice(0, 4000),
    category: item.category ? String(item.category).slice(0, 80) : null,
    priority: item.severity === 'CRITICAL' ? 'Critical' : item.severity === 'MAJOR' ? 'High' : item.severity === 'MINOR' ? 'Low' : 'Medium',
    trade: item.trade ? String(item.trade).slice(0, 120) : null,
    recommendation: item.recommendation ? String(item.recommendation).slice(0, 2000) : null,
    confidence: Number.isFinite(Number(item.confidence)) ? Math.max(0, Math.min(1, Number(item.confidence))) : null,
    codeClaims: item.codeReference ? [String(item.codeReference).slice(0, 500)] : []
  }));
}
function refreshRunState(runId) {
  const assets = db.prepare('SELECT state FROM analysis_assets WHERE run_id = ?').all(runId);
  const states = assets.map(a => a.state);
  let state = 'processing';
  if (states.every(s => s === 'cancelled')) state = 'cancelled';
  else if (states.every(s => s === 'failed')) state = 'failed';
  else if (states.every(s => s === 'completed')) state = 'completed';
  else if (states.every(s => ['completed', 'failed', 'cancelled'].includes(s))) state = 'completed_with_errors';
  db.prepare("UPDATE analysis_runs SET state = ?, updated_at = datetime('now') WHERE id = ?").run(state, runId);
}
async function processAsset(run, asset) {
  if (!process.env.MIMARAI_API_TOKEN) {
    db.prepare("UPDATE analysis_assets SET state = 'failed', upstream_error = ?, updated_at = datetime('now') WHERE id = ?").run('MimaarAI is not configured for this pilot.', asset.id);
    return;
  }
  try {
    db.prepare("UPDATE analysis_assets SET state = 'processing', updated_at = datetime('now') WHERE id = ?").run(asset.id);
    const file = fs.readFileSync(path.join(uploadsDir, asset.storage_key));
    const submit = await providerFetch('https://mimarai.com/api/v1/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.MIMARAI_API_TOKEN}` },
      body: JSON.stringify({ imageData: file.toString('base64'), mimeType: asset.mime_type, reviewType: 'construction_qa', includeCoordinates: true,
        query: 'Identify visible construction quality, safety, MEP, finishing, and fire-protection issues. Return concise evidence-based findings. Code references are suggestions that require human verification.' })
    }, 30000);
    const submitData = await submit.json().catch(() => ({}));
    const jobId = submitData.jobId || submitData.id || submitData.job_id;
    if (!(submit.ok || submit.status === 202) || !jobId) throw new Error(submitData.error || submitData.message || 'Provider did not return a job ID');
    db.prepare('UPDATE analysis_assets SET upstream_job_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(String(jobId), asset.id);
    const deadline = Date.now() + 5 * 60 * 1000;
    let result = null;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const status = await providerFetch(`https://mimarai.com/api/v1/analyze/${encodeURIComponent(jobId)}`, { headers: { Authorization: `Bearer ${process.env.MIMARAI_API_TOKEN}` } }, 15000);
      const data = await status.json().catch(() => ({}));
      if (!status.ok || data.success === false || data.status === 'failed') throw new Error(data.error || data.message || 'Provider analysis failed');
      if (data.status === 'completed' || data.status === 'complete') { result = data; break; }
    }
    if (!result) throw new Error('Provider analysis timed out');
    const createFinding = db.prepare(`INSERT INTO draft_findings (id, run_id, asset_id, title, description, category, priority, trade, recommendation, confidence, code_claims, provider_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const findings = mappedFindings(result);
    const transaction = db.transaction(() => findings.forEach(f => createFinding.run(id('fdg'), run.id, asset.id, f.title, f.description, f.category, f.priority, f.trade, f.recommendation, f.confidence, json(f.codeClaims), result.metadata?.model || null)));
    transaction();
    db.prepare("UPDATE analysis_assets SET state = 'completed', updated_at = datetime('now') WHERE id = ?").run(asset.id);
  } catch (error) {
    db.prepare("UPDATE analysis_assets SET state = 'failed', upstream_error = ?, updated_at = datetime('now') WHERE id = ?").run(String(error.message || 'Provider analysis failed').slice(0, 1000), asset.id);
  }
}
async function processRun(runId) {
  if (providerRuns.has(runId)) return providerRuns.get(runId);
  const task = (async () => {
    const run = db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(runId);
    if (!run || run.state === 'cancelled') return;
    db.prepare("UPDATE analysis_runs SET state = 'processing', updated_at = datetime('now') WHERE id = ?").run(runId);
    const assets = db.prepare("SELECT * FROM analysis_assets WHERE run_id = ? AND state = 'queued' ORDER BY created_at").all(runId);
    for (const asset of assets) {
      const state = db.prepare('SELECT state FROM analysis_runs WHERE id = ?').get(runId)?.state;
      if (state === 'cancelled') break;
      await processAsset(run, asset);
      refreshRunState(runId);
    }
    refreshRunState(runId);
  })().finally(() => providerRuns.delete(runId));
  providerRuns.set(runId, task);
  return task;
}

app.use((req, res, next) => { res.locals.requestId = crypto.randomUUID(); res.setHeader('X-Request-ID', res.locals.requestId); next(); });
app.get('/api/health/live', (req, res) => res.json({ status: 'ok', requestId: res.locals.requestId }));
app.get('/api/health/ready', (req, res) => {
  try { db.prepare('SELECT 1').get(); fs.accessSync(uploadsDir, fs.constants.W_OK); res.json({ status: 'ready', requestId: res.locals.requestId }); }
  catch { sendError(res, 503, 'not_ready', 'Database or storage is unavailable.'); }
});

app.post('/api/auth/login', rateLimit('login', 5, 15 * 60 * 1000), (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
  if (!user || !passwordMatches(password, user.password_hash)) return sendError(res, 401, 'login_invalid', 'Email or password is incorrect.');
  const session = createSession(user.id);
  res.cookie('snag_session', session.token, cookieOptions());
  logEvent(null, user.id, 'session', user.id, 'login');
  res.json({ user: { id: user.id, email: user.email, role: user.role }, csrfToken: session.csrf, expiresAt: session.expires });
});
app.post('/api/auth/logout', requireAuth, requireCsrf, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(parseCookies(req).snag_session));
  res.clearCookie('snag_session', cookieOptions());
  logEvent(null, req.user.id, 'session', req.user.id, 'logout');
  res.status(204).end();
});
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: { id: req.user.id, email: req.user.email, role: req.user.role }, csrfToken: req.user.csrf_token, projects: userProjects(req.user.id) }));
app.post('/api/auth/accept-invite', rateLimit('invite', 5, 15 * 60 * 1000), (req, res) => {
  const token = String(req.body?.token || '');
  const password = String(req.body?.password || '');
  if (!validPassword(password)) return sendError(res, 400, 'password_invalid', 'Password must be 12–128 characters.');
  const invite = db.prepare('SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').get(sha256(token), now());
  if (!invite) return sendError(res, 400, 'invite_invalid', 'This invite is invalid or expired.');
  const project = ensurePilotProject();
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(invite.email);
  const userId = existing?.id || id('usr');
  const transaction = db.transaction(() => {
    if (existing) db.prepare('UPDATE users SET password_hash = ?, role = ?, active = 1 WHERE id = ?').run(passwordHash(password), invite.role, userId);
    else db.prepare('INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)').run(userId, invite.email, passwordHash(password), invite.role);
    db.prepare('INSERT OR REPLACE INTO project_memberships (project_id, user_id, role) VALUES (?, ?, ?)').run(project.id, userId, invite.role);
    db.prepare("UPDATE invites SET used_at = datetime('now') WHERE token_hash = ?").run(invite.token_hash);
  });
  transaction();
  const session = createSession(userId);
  res.cookie('snag_session', session.token, cookieOptions());
  logEvent(project.id, userId, 'user', userId, 'invite_accepted');
  res.status(201).json({ user: { id: userId, email: invite.email, role: invite.role }, csrfToken: session.csrf, expiresAt: session.expires });
});

app.post('/api/admin/invites', requireAuth, requireCsrf, requireRole('admin'), (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const role = String(req.body?.role || 'inspector');
  if (!/^\S+@\S+\.\S+$/.test(email) || !['admin', 'inspector', 'reviewer'].includes(role)) return sendError(res, 400, 'invite_invalid', 'Provide a valid email and role.');
  const token = randomToken();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO invites (token_hash, email, role, expires_at, created_by) VALUES (?, ?, ?, ?, ?)').run(sha256(token), email, role, expires, req.user.id);
  const project = userProjects(req.user.id)[0];
  logEvent(project?.id || null, req.user.id, 'invite', email, 'created', { role, expiresAt: expires });
  res.status(201).json({ inviteUrl: `${process.env.APP_ORIGIN || `${req.protocol}://${req.get('host')}`}/?invite=${encodeURIComponent(token)}`, expiresAt: expires });
});

app.post('/api/analysis-runs', requireAuth, requireCsrf, upload.array('images', 5), (req, res) => {
  const projectId = String(req.body?.projectId || '');
  const project = projectForUser(req.user.id, projectId);
  if (!project) return sendError(res, 403, 'project_forbidden', 'You do not have access to this project.');
  const contextUrl = allowedOpenSpaceUrl(req.body?.openspaceUrl);
  const unlinkedReason = String(req.body?.unlinkedReason || '').trim();
  if (!contextUrl && !unlinkedReason) return sendError(res, 400, 'context_required', 'Attach an OpenSpace share link or explain why the photo is unlinked.');
  if (String(req.body?.consentAccepted) !== 'true') return sendError(res, 400, 'consent_required', 'Explicit consent is required before images are sent to MimaarAI.');
  if (!req.files?.length) return sendError(res, 400, 'images_required', 'Upload at least one JPEG, PNG, or WebP image.');
  for (const file of req.files) if (!hasAllowedImageSignature(file.buffer, file.mimetype)) return sendError(res, 400, 'image_invalid', 'One or more files do not match their claimed image type.');
  const runId = id('run');
  const transaction = db.transaction(() => {
    db.prepare(`INSERT INTO analysis_runs (id, project_id, created_by, state, openspace_url, context_type, unlinked_reason, consent_at)
      VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`)
      .run(runId, project.id, req.user.id, contextUrl, contextUrl ? 'linked' : 'unlinked', contextUrl ? null : unlinkedReason.slice(0, 500), now());
    for (const file of req.files) {
      const assetId = id('ast');
      const storageKey = `${assetId}${extensionFor(file.mimetype)}`;
      fs.writeFileSync(path.join(uploadsDir, storageKey), file.buffer, { flag: 'wx' });
      db.prepare(`INSERT INTO analysis_assets (id, run_id, original_name, mime_type, byte_size, storage_key, sha256, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'queued')`).run(assetId, runId, path.basename(file.originalname).slice(0, 255), file.mimetype, file.size, storageKey, sha256(file.buffer));
    }
  });
  try { transaction(); } catch (error) { return sendError(res, 500, 'run_create_failed', 'Could not stage this analysis run.'); }
  logEvent(project.id, req.user.id, 'analysis_run', runId, 'created', { assetCount: req.files.length, contextType: contextUrl ? 'linked' : 'unlinked' });
  setImmediate(() => processRun(runId));
  const assets = db.prepare('SELECT id, original_name, state FROM analysis_assets WHERE run_id = ?').all(runId);
  res.status(202).json({ runId, state: 'queued', items: assets });
});
app.get('/api/analysis-runs/:id', requireAuth, (req, res) => {
  const run = db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(req.params.id);
  if (!run || !projectForUser(req.user.id, run.project_id)) return sendError(res, 404, 'run_not_found', 'Analysis run not found.');
  const assets = db.prepare('SELECT id, original_name, mime_type, byte_size, state, upstream_error, created_at FROM analysis_assets WHERE run_id = ? ORDER BY created_at').all(run.id);
  const findings = db.prepare('SELECT * FROM draft_findings WHERE run_id = ? ORDER BY created_at').all(run.id).map(serializeFinding);
  res.json({ ...run, assets, findings });
});
app.post('/api/analysis-runs/:id/cancel', requireAuth, requireCsrf, (req, res) => {
  const run = db.prepare('SELECT * FROM analysis_runs WHERE id = ?').get(req.params.id);
  if (!run || !projectForUser(req.user.id, run.project_id)) return sendError(res, 404, 'run_not_found', 'Analysis run not found.');
  db.transaction(() => {
    db.prepare("UPDATE analysis_runs SET state = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(run.id);
    db.prepare("UPDATE analysis_assets SET state = 'cancelled', updated_at = datetime('now') WHERE run_id = ? AND state = 'queued'").run(run.id);
  })();
  logEvent(run.project_id, req.user.id, 'analysis_run', run.id, 'cancelled');
  res.status(204).end();
});

app.get('/api/findings', requireAuth, (req, res) => {
  const projectId = String(req.query.projectId || '');
  if (!projectForUser(req.user.id, projectId)) return sendError(res, 403, 'project_forbidden', 'You do not have access to this project.');
  const state = req.query.state && ['needs_review', 'approved', 'rejected', 'handed_off'].includes(req.query.state) ? req.query.state : null;
  const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
  const rows = db.prepare(`SELECT f.*, r.openspace_url, a.original_name, h.openspace_field_note_url
    FROM draft_findings f JOIN analysis_runs r ON r.id = f.run_id JOIN analysis_assets a ON a.id = f.asset_id
    LEFT JOIN handoffs h ON h.finding_id = f.id WHERE r.project_id = ? ${state ? 'AND f.state = ?' : ''}
    ORDER BY f.created_at DESC, f.id DESC LIMIT ?`).all(...(state ? [projectId, state, limit] : [projectId, limit]));
  res.json({ items: rows.map(serializeFinding) });
});
app.patch('/api/findings/:id', requireAuth, requireCsrf, (req, res) => {
  const finding = db.prepare(`SELECT f.*, r.project_id, r.created_by FROM draft_findings f JOIN analysis_runs r ON r.id = f.run_id WHERE f.id = ?`).get(req.params.id);
  if (!finding || !projectForUser(req.user.id, finding.project_id)) return sendError(res, 404, 'finding_not_found', 'Finding not found.');
  if (req.user.role === 'inspector' && finding.created_by !== req.user.id) return sendError(res, 403, 'forbidden', 'Inspectors can edit only their own findings.');
  const version = Number(req.body?.version);
  if (!Number.isInteger(version) || version !== finding.version) return sendError(res, 409, 'version_conflict', 'This finding changed. Reload before saving.');
  const fields = ['title', 'description', 'category', 'priority', 'trade', 'recommendation'];
  const values = {};
  for (const field of fields) if (req.body[field] !== undefined) values[field] = String(req.body[field] || '').trim().slice(0, field === 'description' ? 4000 : 500) || null;
  if (values.priority && !['Critical', 'High', 'Medium', 'Low'].includes(values.priority)) return sendError(res, 400, 'priority_invalid', 'Priority is invalid.');
  if (!Object.keys(values).length) return sendError(res, 400, 'update_empty', 'Provide at least one editable field.');
  const state = finding.state === 'approved' ? 'needs_review' : finding.state;
  const assignments = Object.keys(values).map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE draft_findings SET ${assignments}, state = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(values), state, finding.id);
  logEvent(finding.project_id, req.user.id, 'finding', finding.id, 'edited', { approvalInvalidated: finding.state === 'approved' });
  res.json(serializeFinding(db.prepare('SELECT * FROM draft_findings WHERE id = ?').get(finding.id)));
});
app.post('/api/findings/:id/decision', requireAuth, requireCsrf, requireRole('reviewer', 'admin'), (req, res) => {
  const finding = db.prepare(`SELECT f.*, r.project_id FROM draft_findings f JOIN analysis_runs r ON r.id = f.run_id WHERE f.id = ?`).get(req.params.id);
  if (!finding || !projectForUser(req.user.id, finding.project_id)) return sendError(res, 404, 'finding_not_found', 'Finding not found.');
  const decision = req.body?.decision;
  const note = String(req.body?.note || '').trim().slice(0, 1000);
  if (!['approve', 'reject'].includes(decision) || (decision === 'reject' && !note)) return sendError(res, 400, 'decision_invalid', 'Approvals need a decision; rejections also need a reason.');
  db.prepare("UPDATE draft_findings SET state = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?").run(decision === 'approve' ? 'approved' : 'rejected', finding.id);
  logEvent(finding.project_id, req.user.id, 'finding', finding.id, decision === 'approve' ? 'approved' : 'rejected', { note });
  res.json(serializeFinding(db.prepare('SELECT * FROM draft_findings WHERE id = ?').get(finding.id)));
});
app.post('/api/findings/:id/handoff', requireAuth, requireCsrf, requireRole('reviewer', 'admin'), (req, res) => {
  const finding = db.prepare(`SELECT f.*, r.project_id, r.openspace_url FROM draft_findings f JOIN analysis_runs r ON r.id = f.run_id WHERE f.id = ?`).get(req.params.id);
  if (!finding || !projectForUser(req.user.id, finding.project_id)) return sendError(res, 404, 'finding_not_found', 'Finding not found.');
  if (finding.state !== 'approved') return sendError(res, 409, 'handoff_not_approved', 'Only approved findings can be handed off.');
  if (!finding.openspace_url) return sendError(res, 409, 'handoff_context_missing', 'Attach an OpenSpace share link before handoff.');
  const targetUrl = allowedOpenSpaceUrl(req.body?.openspaceFieldNoteUrl);
  if (!targetUrl) return sendError(res, 400, 'handoff_url_invalid', 'Provide an HTTPS OpenSpace Field Note link.');
  const payloadHash = sha256(JSON.stringify({ findingId: finding.id, title: finding.title, description: finding.description, targetUrl }));
  db.transaction(() => {
    db.prepare('INSERT INTO handoffs (finding_id, openspace_field_note_url, payload_hash, handed_off_by) VALUES (?, ?, ?, ?)').run(finding.id, targetUrl, payloadHash, req.user.id);
    db.prepare("UPDATE draft_findings SET state = 'handed_off', version = version + 1, updated_at = datetime('now') WHERE id = ?").run(finding.id);
  })();
  logEvent(finding.project_id, req.user.id, 'finding', finding.id, 'handed_off', { targetUrl, payloadHash });
  res.status(201).json({ findingId: finding.id, openspaceFieldNoteUrl: targetUrl, payloadHash });
});

app.get('/api/assets/:id/content', requireAuth, (req, res) => {
  const asset = db.prepare(`SELECT a.* FROM analysis_assets a JOIN analysis_runs r ON r.id = a.run_id WHERE a.id = ?`).get(req.params.id);
  if (!asset) return sendError(res, 404, 'asset_not_found', 'Asset not found.');
  const run = db.prepare('SELECT project_id FROM analysis_runs WHERE id = ?').get(asset.run_id);
  if (!projectForUser(req.user.id, run.project_id)) return sendError(res, 404, 'asset_not_found', 'Asset not found.');
  const filePath = path.join(uploadsDir, asset.storage_key);
  if (!fs.existsSync(filePath)) return sendError(res, 404, 'asset_missing', 'Asset file is unavailable.');
  res.type(asset.mime_type).sendFile(filePath);
});

app.get('/api/spec-clauses', requireAuth, (req, res) => {
  const projectId = String(req.query.projectId || '');
  if (!projectForUser(req.user.id, projectId)) return sendError(res, 403, 'project_forbidden', 'You do not have access to this project.');
  res.json({ items: db.prepare('SELECT * FROM spec_clauses WHERE project_id = ? ORDER BY active DESC, created_at DESC').all(projectId) });
});
app.post('/api/spec-clauses', requireAuth, requireCsrf, requireRole('admin'), (req, res) => {
  const projectId = String(req.body?.projectId || '');
  if (!projectForUser(req.user.id, projectId)) return sendError(res, 403, 'project_forbidden', 'You do not have access to this project.');
  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').trim();
  const priority = req.body?.priority || null;
  if (!name || !description || name.length > 250 || description.length > 5000 || (priority && !['Critical', 'High', 'Medium', 'Low'].includes(priority))) return sendError(res, 400, 'spec_invalid', 'Provide a valid specification clause.');
  const clauseId = id('spc');
  db.prepare('INSERT INTO spec_clauses (id, project_id, name, description, category, priority, source_name, source_page, revision, active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(clauseId, projectId, name, description, String(req.body?.category || '').slice(0, 80) || null, priority, String(req.body?.sourceName || '').slice(0, 250) || null, String(req.body?.sourcePage || '').slice(0, 80) || null, String(req.body?.revision || '').slice(0, 80) || null, req.body?.active ? 1 : 0, req.user.id);
  logEvent(projectId, req.user.id, 'spec_clause', clauseId, 'created');
  res.status(201).json(db.prepare('SELECT * FROM spec_clauses WHERE id = ?').get(clauseId));
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return sendError(res, err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, 'upload_invalid', err.message);
  if (err) return sendError(res, 500, 'internal_error', 'An unexpected error occurred.');
  next();
});

if (require.main === module) app.listen(PORT, () => console.log(`OpenSpace AI companion listening on ${PORT}`));
module.exports = app;
