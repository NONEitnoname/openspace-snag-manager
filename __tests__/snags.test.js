const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snag-pro-'));
process.env.TEST_DB_PATH = path.join(testDir, 'pilot.db');
process.env.UPLOADS_DIR = path.join(testDir, 'uploads');
process.env.BOOTSTRAP_ADMIN_EMAIL = 'admin@example.com';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'correct-horse-battery-staple';
process.env.APP_ORIGIN = 'http://127.0.0.1';

const { db, id, json } = require('../db/database');
const app = require('../server');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from([0x00])]);

let admin;
let adminId;
let projectId;

async function signIn(email, password) {
  const response = await request(app).post('/api/auth/login').send({ email, password });
  return { cookie: response.headers['set-cookie'][0].split(';')[0], csrf: response.body.csrfToken };
}
function authed(agent, session) {
  return agent.set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf);
}
async function createSnag(overrides = {}) {
  const response = await authed(request(app).post('/api/snags'), admin)
    .send({ projectId, title: 'Cracked screed in corridor', description: 'Hairline crack across bay 4.', priority: 'High', trade: 'Civil', ...overrides });
  return response;
}

beforeAll(async () => {
  admin = await signIn('admin@example.com', 'correct-horse-battery-staple');
  const me = await request(app).get('/api/auth/me').set('Cookie', admin.cookie);
  adminId = me.body.user.id;
  projectId = me.body.projects[0].id;
});
afterAll(() => { db.close(); fs.rmSync(testDir, { recursive: true, force: true }); });

test('snag CRUD requires authentication', async () => {
  await request(app).get(`/api/snags?projectId=${projectId}`).expect(401);
  await request(app).post('/api/snags').send({ projectId, title: 'x', description: 'y' }).expect(401);
});

test('admin can create, read, filter, and update a snag', async () => {
  const created = await createSnag();
  expect(created.status).toBe(201);
  expect(created.body.human_ref).toMatch(/^SNG-[A-Z0-9]{6}$/);
  expect(created.body.status).toBe('Open');

  const list = await request(app).get(`/api/snags?projectId=${projectId}&priority=High&search=screed`).set('Cookie', admin.cookie).expect(200);
  expect(list.body.items.some(s => s.id === created.body.id)).toBe(true);

  const updated = await authed(request(app).patch(`/api/snags/${created.body.id}`), admin)
    .send({ version: created.body.version, status: 'In Progress', assignee: 'Fahad' }).expect(200);
  expect(updated.body.status).toBe('In Progress');
  expect(updated.body.version).toBe(created.body.version + 1);
});

test('stale version is rejected with a conflict', async () => {
  const created = await createSnag();
  await authed(request(app).patch(`/api/snags/${created.body.id}`), admin).send({ version: created.body.version, status: 'Resolved' }).expect(200);
  await authed(request(app).patch(`/api/snags/${created.body.id}`), admin).send({ version: created.body.version, status: 'Closed' }).expect(409);
});

test('invalid priority, status, and due date are rejected', async () => {
  await authed(request(app).post('/api/snags'), admin).send({ projectId, title: 'x', description: 'y', priority: 'Urgent' }).expect(400);
  const created = await createSnag();
  await authed(request(app).patch(`/api/snags/${created.body.id}`), admin).send({ version: created.body.version, status: 'Done' }).expect(400);
  await authed(request(app).patch(`/api/snags/${created.body.id}`), admin).send({ version: created.body.version, due_date: '17/07/2026' }).expect(400);
});

test('members of other projects cannot see or touch this project\'s snags', async () => {
  const created = await createSnag();
  db.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run('prj_other', 'Other Project');
  db.prepare('INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run('usr_outsider', 'outsider@example.com', 'scrypt$invalid$invalid', 'admin');
  db.prepare('INSERT INTO project_memberships (project_id, user_id, role) VALUES (?, ?, ?)').run('prj_other', 'usr_outsider', 'admin');
  db.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)')
    .run(require('crypto').createHash('sha256').update('outsider-token').digest('hex'), 'usr_outsider', 'outsider-csrf', new Date(Date.now() + 3600000).toISOString());
  const outsider = { cookie: 'snag_session=outsider-token', csrf: 'outsider-csrf' };

  await request(app).get(`/api/snags?projectId=${projectId}`).set('Cookie', outsider.cookie).expect(403);
  await request(app).get(`/api/snags/${created.body.id}`).set('Cookie', outsider.cookie).expect(404);
  await authed(request(app).patch(`/api/snags/${created.body.id}`), outsider).send({ version: 1, title: 'hijack' }).expect(404);
  await request(app).get(`/api/snags/export/csv?projectId=${projectId}`).set('Cookie', outsider.cookie).expect(403);
  await request(app).get(`/api/projects/${projectId}/stats`).set('Cookie', outsider.cookie).expect(403);
});

test('inspectors cannot delete snags; admins can', async () => {
  const invite = await authed(request(app).post('/api/admin/invites'), admin).send({ email: 'inspector@example.com', role: 'inspector' }).expect(201);
  const token = new URL(invite.body.inviteUrl).searchParams.get('invite');
  const accepted = await request(app).post('/api/auth/accept-invite').send({ token, password: 'inspector-password-1' }).expect(201);
  const inspector = { cookie: accepted.headers['set-cookie'][0].split(';')[0], csrf: accepted.body.csrfToken };

  const created = await createSnag();
  await authed(request(app).delete(`/api/snags/${created.body.id}`), inspector).expect(403);
  await authed(request(app).delete(`/api/snags/${created.body.id}`), admin).expect(204);
  await request(app).get(`/api/snags/${created.body.id}`).set('Cookie', admin.cookie).expect(404);
});

test('CSV export neutralises spreadsheet formulas', async () => {
  await createSnag({ title: '=cmd|calc', description: '+SUM(A1)' });
  const csv = await request(app).get(`/api/snags/export/csv?projectId=${projectId}`).set('Cookie', admin.cookie).expect(200);
  expect(csv.headers['content-type']).toContain('text/csv');
  expect(csv.text).toContain("'=cmd|calc");
  expect(csv.text).toContain("'+SUM(A1)");
});

test('PDF export streams a real PDF', async () => {
  const pdf = await request(app).get(`/api/snags/export/pdf?projectId=${projectId}`).set('Cookie', admin.cookie).buffer(true).parse((res, cb) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); }).expect(200);
  expect(pdf.headers['content-type']).toContain('application/pdf');
  expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
});

test('photos require valid image signatures and are served only to members', async () => {
  const created = await createSnag();
  await authed(request(app).post(`/api/snags/${created.body.id}/photos`), admin)
    .attach('photos', PNG, { filename: 'fake.jpg', contentType: 'image/jpeg' }).expect(400);
  const uploaded = await authed(request(app).post(`/api/snags/${created.body.id}/photos`), admin)
    .attach('photos', JPEG, { filename: 'real.jpg', contentType: 'image/jpeg' }).expect(200);
  expect(uploaded.body.photos).toHaveLength(1);
  const key = uploaded.body.photos[0];
  await request(app).get(`/api/snags/${created.body.id}/photos/${key}`).set('Cookie', admin.cookie).expect(200);
  await request(app).get(`/api/snags/${created.body.id}/photos/${key}`).expect(401);
  await request(app).get(`/api/snags/${created.body.id}/photos/..%2F..%2Fserver.js`).set('Cookie', admin.cookie).expect(404);
});

test('only approved findings can be promoted, and promotion is idempotent', async () => {
  db.prepare(`INSERT INTO analysis_runs (id, project_id, created_by, state, openspace_url, context_type, consent_at) VALUES ('run_promote', ?, ?, 'completed', 'https://ksa.openspace.ai/ohplayer?site=x', 'linked', ?)`)
    .run(projectId, adminId, new Date().toISOString());
  db.prepare(`INSERT INTO analysis_assets (id, run_id, original_name, mime_type, byte_size, storage_key, sha256, state) VALUES ('ast_promote', 'run_promote', 'evidence.jpg', 'image/jpeg', 8, 'ast_promote.jpg', 'deadbeef', 'completed')`).run();
  db.prepare(`INSERT INTO draft_findings (id, run_id, asset_id, title, description, category, priority, trade, recommendation, code_claims) VALUES ('fdg_promote', 'run_promote', 'ast_promote', 'Exposed rebar', 'Rebar visible at column base.', 'Structural', 'Critical', 'Civil', 'Chip back and patch with approved mortar.', ?)`).run(json(['SBC 304 §5.2 (unverified)']));

  await authed(request(app).post('/api/findings/fdg_promote/promote'), admin).expect(409);
  await authed(request(app).post('/api/findings/fdg_promote/decision'), admin).send({ decision: 'approve' }).expect(200);
  const first = await authed(request(app).post('/api/findings/fdg_promote/promote'), admin).expect(201);
  expect(first.body.title).toBe('Exposed rebar');
  expect(first.body.priority).toBe('Critical');
  expect(first.body.photos).toEqual(['ast_promote.jpg']);
  expect(first.body.source_finding_id).toBe('fdg_promote');
  const again = await authed(request(app).post('/api/findings/fdg_promote/promote'), admin).expect(200);
  expect(again.body.id).toBe(first.body.id);
});

test('resolution is stamped when it happens, and later edits do not re-date it', async () => {
  const created = await createSnag();
  expect(created.body.resolved_at).toBeNull();

  const resolved = await authed(request(app).patch(`/api/snags/${created.body.id}`), admin).send({ version: created.body.version, status: 'Resolved' }).expect(200);
  // Same shape as every other timestamp in the schema, so the column compares as a string.
  expect(resolved.body.resolved_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  // An unrelated edit moves updated_at but must leave the resolution date alone.
  db.prepare("UPDATE snags SET resolved_at = '2026-07-01 09:00:00' WHERE id = ?").run(created.body.id);
  const edited = await authed(request(app).patch(`/api/snags/${created.body.id}`), admin).send({ version: resolved.body.version, assignee: 'Someone else' }).expect(200);
  expect(edited.body.resolved_at).toBe('2026-07-01 09:00:00');

  // Closing an already-resolved snag keeps the original resolution moment.
  const closed = await authed(request(app).patch(`/api/snags/${created.body.id}`), admin).send({ version: edited.body.version, status: 'Closed' }).expect(200);
  expect(closed.body.resolved_at).toBe('2026-07-01 09:00:00');

  // Reopening clears it: an open snag has no resolution date.
  const reopened = await authed(request(app).patch(`/api/snags/${created.body.id}`), admin).send({ version: closed.body.version, status: 'Open' }).expect(200);
  expect(reopened.body.resolved_at).toBeNull();
});

test('the trend counts a resolution on the day it happened, not the day it was last edited', async () => {
  const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const readTrend = async () => (await request(app).get(`/api/projects/${projectId}/stats`).set('Cookie', admin.cookie).expect(200)).body.trend;
  const before = await readTrend(); // other tests in this suite resolve snags too, so measure the delta

  const created = await createSnag();
  await authed(request(app).patch(`/api/snags/${created.body.id}`), admin).send({ version: created.body.version, status: 'Resolved' }).expect(200);
  // Resolved five days ago, touched today: updated_at moves, resolved_at must not.
  db.prepare("UPDATE snags SET resolved_at = datetime('now','-5 days'), updated_at = datetime('now') WHERE id = ?").run(created.body.id);
  const after = await readTrend();

  const on = (trend, day) => trend.find(d => d.day === day).resolved;
  expect(on(after, fiveDaysAgo) - on(before, fiveDaysAgo)).toBe(1); // counted on the day it closed out
  expect(on(after, today) - on(before, today)).toBe(0);             // not on the day it was last edited
});

test('the audit trail records what the user changed, not what the server derived', async () => {
  const created = await createSnag();
  await authed(request(app).patch(`/api/snags/${created.body.id}`), admin).send({ version: created.body.version, status: 'Resolved' }).expect(200);
  const event = db.prepare("SELECT details FROM audit_events WHERE entity_id = ? AND action = 'edited' ORDER BY created_at DESC LIMIT 1").get(created.body.id);
  const fields = JSON.parse(event.details).fields;
  expect(fields).toEqual(['status']);          // what the request asked for
  expect(fields).not.toContain('resolved_at'); // a stamp the server wrote, not the user
});

test('data migrations are recorded and never re-run', async () => {
  const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version);
  expect(versions).toEqual([1, 2]);
  expect(db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count).toBe(versions.length);
});

test('any project member may progress a snag they did not raise (snags are collaborative)', async () => {
  // Deliberate asymmetry with draft findings, which restrict inspectors to their own.
  const invite = await authed(request(app).post('/api/admin/invites'), admin).send({ email: 'inspector2@example.com', role: 'inspector' }).expect(201);
  const token = new URL(invite.body.inviteUrl).searchParams.get('invite');
  const accepted = await request(app).post('/api/auth/accept-invite').send({ token, password: 'inspector-password-2' }).expect(201);
  const inspector = { cookie: accepted.headers['set-cookie'][0].split(';')[0], csrf: accepted.body.csrfToken };

  const created = await createSnag(); // raised by admin
  const updated = await authed(request(app).patch(`/api/snags/${created.body.id}`), inspector)
    .send({ version: created.body.version, status: 'In Progress' }).expect(200);
  expect(updated.body.status).toBe('In Progress');
});

test('stats endpoint returns full shape', async () => {
  const stats = await request(app).get(`/api/projects/${projectId}/stats`).set('Cookie', admin.cookie).expect(200);
  expect(stats.body.snags.byStatus).toHaveProperty('Open');
  expect(stats.body.snags.byPriority).toHaveProperty('Critical');
  expect(stats.body.findings).toHaveProperty('needs_review');
  expect(stats.body.trend).toHaveLength(14);
});
