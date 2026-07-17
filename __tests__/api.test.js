const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snag-pilot-'));
process.env.TEST_DB_PATH = path.join(testDir, 'pilot.db');
process.env.UPLOADS_DIR = path.join(testDir, 'uploads');
process.env.BOOTSTRAP_ADMIN_EMAIL = 'admin@example.com';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'correct-horse-battery-staple';
process.env.APP_ORIGIN = 'http://127.0.0.1';

const { db } = require('../db/database');
const app = require('../server');

async function signIn() {
  const response = await request(app).post('/api/auth/login').send({ email: 'admin@example.com', password: 'correct-horse-battery-staple' });
  return { cookie: response.headers['set-cookie'][0].split(';')[0], csrf: response.body.csrfToken };
}

afterAll(() => { db.close(); fs.rmSync(testDir, { recursive: true, force: true }); });

test('liveness and readiness endpoints are available', async () => {
  await request(app).get('/api/health/live').expect(200).expect(r => expect(r.body.status).toBe('ok'));
  await request(app).get('/api/health/ready').expect(200).expect(r => expect(r.body.status).toBe('ready'));
});

test('anonymous users cannot read the review queue', async () => {
  await request(app).get('/api/findings?projectId=missing').expect(401);
});

test('admin can sign in and create a one-time invite', async () => {
  const session = await signIn();
  const me = await request(app).get('/api/auth/me').set('Cookie', session.cookie).expect(200);
  expect(me.body.user.role).toBe('admin');
  const invite = await request(app).post('/api/admin/invites').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).send({ email: 'reviewer@example.com', role: 'reviewer' }).expect(201);
  expect(invite.body.inviteUrl).toContain('invite=');
});

test('analysis runs require context, consent, and authenticated uploads', async () => {
  const session = await signIn();
  const me = await request(app).get('/api/auth/me').set('Cookie', session.cookie);
  const projectId = me.body.projects[0].id;
  await request(app).post('/api/analysis-runs').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)
    .field('projectId', projectId).field('openspaceUrl', 'https://ksa.openspace.ai/ohplayer?site=pilot').field('consentAccepted', 'false')
    .attach('images', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), { filename: 'evidence.jpg', contentType: 'image/jpeg' }).expect(400);
  const created = await request(app).post('/api/analysis-runs').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)
    .field('projectId', projectId).field('openspaceUrl', 'https://ksa.openspace.ai/ohplayer?site=pilot').field('consentAccepted', 'true')
    .attach('images', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), { filename: 'evidence.jpg', contentType: 'image/jpeg' }).expect(202);
  expect(created.body.items).toHaveLength(1);
});
