const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snag-prov-'));
process.env.TEST_DB_PATH = path.join(testDir, 'pilot.db');
process.env.UPLOADS_DIR = path.join(testDir, 'uploads');
process.env.BOOTSTRAP_ADMIN_EMAIL = 'admin@example.com';
process.env.BOOTSTRAP_ADMIN_PASSWORD = 'correct-horse-battery-staple';
process.env.APP_ORIGIN = 'http://127.0.0.1';
process.env.MIMARAI_API_TOKEN = 'test-token';
process.env.PROVIDER_POLL_MS = '20';
process.env.PROVIDER_DEADLINE_MS = '4000';

const { db } = require('../db/database');
const app = require('../server');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const realFetch = global.fetch;
let session;
let projectId;

function json(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }
async function runAnalysis() {
  const created = await request(app).post('/api/analysis-runs').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)
    .field('projectId', projectId).field('openspaceUrl', 'https://ksa.openspace.ai/ohplayer?site=x').field('consentAccepted', 'true')
    .attach('images', JPEG, { filename: 'e.jpg', contentType: 'image/jpeg' }).expect(202);
  for (let i = 0; i < 100; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const run = await request(app).get(`/api/analysis-runs/${created.body.runId}`).set('Cookie', session.cookie);
    if (['completed', 'completed_with_errors', 'failed'].includes(run.body.state)) return run.body;
  }
  throw new Error('run did not settle');
}

beforeAll(async () => {
  const login = await request(app).post('/api/auth/login').send({ email: 'admin@example.com', password: 'correct-horse-battery-staple' });
  session = { cookie: login.headers['set-cookie'][0].split(';')[0], csrf: login.body.csrfToken };
  const me = await request(app).get('/api/auth/me').set('Cookie', session.cookie);
  projectId = me.body.projects[0].id;
});
afterEach(() => { global.fetch = realFetch; });
afterAll(() => { db.close(); fs.rmSync(testDir, { recursive: true, force: true }); });

test('a transient 404 while the provider job is in flight does not fail the run', async () => {
  // The provider keeps jobs in memory across replicas, so polls intermittently 404.
  let poll = 0;
  global.fetch = async url => {
    if (String(url).endsWith('/api/v1/analyze')) return json(202, { jobId: 'job_1', status: 'processing' });
    poll += 1;
    if (poll <= 3) return json(404, { error: 'not found' });
    return json(200, { status: 'completed', analysis: { findings: [{ title: 'Exposed rebar', description: 'Visible at column base.', severity: 'MAJOR', trade: 'Civil', confidence: 0.8 }] } });
  };
  const run = await runAnalysis();
  expect(run.state).toBe('completed');
  expect(run.findings).toHaveLength(1);
  expect(run.findings[0].title).toBe('Exposed rebar');
  expect(run.findings[0].priority).toBe('High');
}, 30000);

test('an explicit provider failure fails the asset with the upstream message', async () => {
  global.fetch = async url => {
    if (String(url).endsWith('/api/v1/analyze')) return json(202, { jobId: 'job_2', status: 'processing' });
    return json(200, { status: 'failed', error: 'Vision model unavailable' });
  };
  const run = await runAnalysis();
  expect(run.state).toBe('failed');
  expect(run.assets[0].upstream_error).toContain('Vision model unavailable');
  expect(run.findings).toHaveLength(0);
}, 30000);

test('a quota rejection is reported in the provider\'s own words, not as a generic error', async () => {
  global.fetch = async () => json(429, { message: 'Daily usage limit reached. Please upgrade your plan.' });
  const run = await runAnalysis();
  expect(run.state).toBe('failed');
  expect(run.assets[0].upstream_error).toContain('Daily usage limit reached');
}, 30000);
