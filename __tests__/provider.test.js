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

test('active specification clauses are actually sent to the provider, as the consent says', async () => {
  await request(app).post('/api/spec-clauses').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)
    .send({ projectId, name: 'Fire-stopping at penetrations', description: 'Penetrations through fire-rated construction shall be sealed with an approved system.', sourceName: 'Division 07', sourcePage: '14', active: true }).expect(201);
  await request(app).post('/api/spec-clauses').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)
    .send({ projectId, name: 'Draft clause not yet active', description: 'Should never reach the provider.', active: false }).expect(201);

  let sentQuery = null;
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/api/v1/analyze')) { sentQuery = JSON.parse(options.body).query; return json(202, { jobId: 'job_spec' }); }
    return json(200, { status: 'completed', analysis: { findings: [] } });
  };
  await runAnalysis();
  expect(sentQuery).toContain('Fire-stopping at penetrations');       // active clause reaches the AI
  expect(sentQuery).toContain('Division 07, p. 14');                  // with its source, so a citation is checkable
  expect(sentQuery).not.toContain('Draft clause not yet active');     // inactive clauses stay out
}, 30000);

test('a finding the model did not rate is left unrated rather than defaulted to Medium', async () => {
  global.fetch = async url => {
    if (String(url).endsWith('/api/v1/analyze')) return json(202, { jobId: 'job_sev' });
    return json(200, { status: 'completed', analysis: { findings: [
      { title: 'Unrated issue', description: 'The model gave no severity.', severity: 'INFO' },
      { title: 'Critical issue', description: 'Rated by the model.', severity: 'CRITICAL' }
    ] } });
  };
  const run = await runAnalysis();
  const byTitle = Object.fromEntries(run.findings.map(f => [f.title, f.priority]));
  expect(byTitle['Unrated issue']).toBeNull();   // 'INFO' means the model declined to rate it
  expect(byTitle['Critical issue']).toBe('Critical');
}, 30000);

test('cancelling mid-run never uploads the withdrawn image, and the cancel is not recomputed away', async () => {
  const submitted = [];
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/api/v1/analyze')) {
      submitted.push(JSON.parse(options.body).imageData);
      await new Promise(resolve => setTimeout(resolve, 700)); // first image is slow: time to cancel
      return json(202, { jobId: `job_${submitted.length}` });
    }
    return json(200, { status: 'completed', analysis: { findings: [] } });
  };
  const created = await request(app).post('/api/analysis-runs').set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf)
    .field('projectId', projectId).field('openspaceUrl', 'https://ksa.openspace.ai/ohplayer?site=x').field('consentAccepted', 'true')
    .attach('images', JPEG, { filename: 'A.jpg', contentType: 'image/jpeg' })
    .attach('images', JPEG, { filename: 'B.jpg', contentType: 'image/jpeg' })
    .expect(202);

  await new Promise(resolve => setTimeout(resolve, 200)); // A is in flight, B still queued
  await request(app).post(`/api/analysis-runs/${created.body.runId}/cancel`).set('Cookie', session.cookie).set('X-CSRF-Token', session.csrf).expect(204);
  await new Promise(resolve => setTimeout(resolve, 2500)); // let the in-flight image finish

  const run = await request(app).get(`/api/analysis-runs/${created.body.runId}`).set('Cookie', session.cookie);
  expect(submitted).toHaveLength(1);          // B was withdrawn and must never reach the provider
  expect(run.body.state).toBe('cancelled');   // an asset finishing afterwards must not undo the cancel
  expect(run.body.assets.find(a => a.original_name === 'B.jpg').state).toBe('cancelled');
}, 30000);
