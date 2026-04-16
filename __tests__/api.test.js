const path = require('path');
const fs = require('fs');
const os = require('os');

// Each test run uses a fresh temporary SQLite database
const testDbPath = path.join(os.tmpdir(), `snag-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.TEST_DB_PATH = testDbPath;

// Require modules AFTER setting env var so database.js picks it up
const db = require('../db/database');
const request = require('supertest');
const app = require('../server');

afterAll(() => {
  // Clean up temp database files
  try { fs.unlinkSync(testDbPath); } catch {}
  try { fs.unlinkSync(testDbPath + '-wal'); } catch {}
  try { fs.unlinkSync(testDbPath + '-shm'); } catch {}
});

// ═══════════════════════════════════════════════════════════════
// DATABASE TESTS (db/database.js)
// ═══════════════════════════════════════════════════════════════

describe('Database — Snags', () => {
  let createdId;

  afterEach(() => {
    // Clean all snags between tests
    const allSnags = db.getAllSnags();
    for (const s of allSnags) {
      db.deleteSnag(s.id);
    }
  });

  test('createSnag with all fields', () => {
    const snag = db.createSnag({
      title: 'Crack in wall',
      description: 'Vertical crack in wall panel B2',
      category: 'Structural',
      priority: 'Critical',
      status: 'Open',
      trade: 'Concrete',
      location: 'Main Lobby',
      floor: 'Level 2',
      zone: 'Zone A',
      assignee: 'John Doe',
      due_date: '2026-05-01',
      root_cause: 'Thermal expansion',
      recommendation: 'Inject epoxy resin',
      effort: 'Major (4-8hrs)',
      photos: ['/uploads/photo1.jpg']
    });

    expect(snag).toBeDefined();
    expect(snag.id).toMatch(/^SNG-[A-Z0-9]{6}$/);
    expect(snag.title).toBe('Crack in wall');
    expect(snag.description).toBe('Vertical crack in wall panel B2');
    expect(snag.category).toBe('Structural');
    expect(snag.priority).toBe('Critical');
    expect(snag.status).toBe('Open');
    expect(snag.trade).toBe('Concrete');
    expect(snag.location).toBe('Main Lobby');
    expect(snag.floor).toBe('Level 2');
    expect(snag.zone).toBe('Zone A');
    expect(snag.assignee).toBe('John Doe');
    expect(snag.due_date).toBe('2026-05-01');
    expect(snag.root_cause).toBe('Thermal expansion');
    expect(snag.recommendation).toBe('Inject epoxy resin');
    expect(snag.effort).toBe('Major (4-8hrs)');
    expect(JSON.parse(snag.photos)).toEqual(['/uploads/photo1.jpg']);
    expect(snag.created_at).toBeDefined();
    expect(snag.updated_at).toBeDefined();
  });

  test('createSnag with minimal fields (title + description only)', () => {
    const snag = db.createSnag({
      title: 'Minor scratch',
      description: 'Small scratch on door frame'
    });

    expect(snag.id).toMatch(/^SNG-[A-Z0-9]{6}$/);
    expect(snag.title).toBe('Minor scratch');
    expect(snag.description).toBe('Small scratch on door frame');
    expect(snag.priority).toBe('Medium');
    expect(snag.status).toBe('Open');
    expect(snag.category).toBeNull();
    expect(snag.trade).toBeNull();
    expect(snag.location).toBeNull();
    expect(JSON.parse(snag.photos)).toEqual([]);
  });

  test('getSnag by ID', () => {
    const created = db.createSnag({ title: 'Test', description: 'Test snag' });
    const fetched = db.getSnag(created.id);

    expect(fetched).toBeDefined();
    expect(fetched.id).toBe(created.id);
    expect(fetched.title).toBe('Test');
  });

  test('getSnag with non-existent ID returns undefined', () => {
    const result = db.getSnag('SNG-ZZZZZZ');
    expect(result).toBeUndefined();
  });

  test('getAllSnags with no filters', () => {
    db.createSnag({ title: 'Snag A', description: 'Desc A' });
    db.createSnag({ title: 'Snag B', description: 'Desc B' });
    db.createSnag({ title: 'Snag C', description: 'Desc C' });

    const all = db.getAllSnags();
    expect(all).toHaveLength(3);
  });

  test('getAllSnags with status filter', () => {
    db.createSnag({ title: 'Open snag', description: 'D', status: 'Open' });
    db.createSnag({ title: 'Closed snag', description: 'D', status: 'Closed' });

    const open = db.getAllSnags({ status: 'Open' });
    expect(open).toHaveLength(1);
    expect(open[0].status).toBe('Open');
  });

  test('getAllSnags with priority filter', () => {
    db.createSnag({ title: 'Critical', description: 'D', priority: 'Critical' });
    db.createSnag({ title: 'Low', description: 'D', priority: 'Low' });

    const critical = db.getAllSnags({ priority: 'Critical' });
    expect(critical).toHaveLength(1);
    expect(critical[0].priority).toBe('Critical');
  });

  test('getAllSnags with search query', () => {
    db.createSnag({ title: 'Crack in column', description: 'Structural issue' });
    db.createSnag({ title: 'Paint peeling', description: 'Finishing defect' });

    const results = db.getAllSnags({ search: 'column' });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Crack in column');
  });

  test('getAllSnags with sort by priority', () => {
    db.createSnag({ title: 'Low', description: 'D', priority: 'Low' });
    db.createSnag({ title: 'Critical', description: 'D', priority: 'Critical' });
    db.createSnag({ title: 'High', description: 'D', priority: 'High' });

    const sorted = db.getAllSnags({ sort: 'priority' });
    expect(sorted[0].priority).toBe('Critical');
    expect(sorted[1].priority).toBe('High');
    expect(sorted[2].priority).toBe('Low');
  });

  test('updateSnag fields', () => {
    const snag = db.createSnag({ title: 'Original', description: 'Original desc' });
    const updated = db.updateSnag(snag.id, {
      title: 'Updated Title',
      status: 'In Progress',
      priority: 'High'
    });

    expect(updated.title).toBe('Updated Title');
    expect(updated.status).toBe('In Progress');
    expect(updated.priority).toBe('High');
    expect(updated.description).toBe('Original desc');
  });

  test('updateSnag with non-existent ID returns null', () => {
    const result = db.updateSnag('SNG-ZZZZZZ', { title: 'X' });
    expect(result).toBeNull();
  });

  test('deleteSnag', () => {
    const snag = db.createSnag({ title: 'To Delete', description: 'D' });
    const result = db.deleteSnag(snag.id);
    expect(result).toBe(true);

    const fetched = db.getSnag(snag.id);
    expect(fetched).toBeUndefined();
  });

  test('deleteSnag with non-existent ID returns false', () => {
    const result = db.deleteSnag('SNG-ZZZZZZ');
    expect(result).toBe(false);
  });

  test('getStats returns correct counts', () => {
    db.createSnag({ title: 'A', description: 'D', status: 'Open', priority: 'Critical' });
    db.createSnag({ title: 'B', description: 'D', status: 'In Progress', priority: 'High' });
    db.createSnag({ title: 'C', description: 'D', status: 'Resolved', priority: 'Medium' });
    db.createSnag({ title: 'D', description: 'D', status: 'Closed', priority: 'Low' });
    db.createSnag({ title: 'E', description: 'D', status: 'Open', priority: 'Critical' });

    const stats = db.getStats();
    expect(stats.total).toBe(5);
    expect(stats.open).toBe(2);
    expect(stats.inProgress).toBe(1);
    expect(stats.resolved).toBe(2); // Resolved + Closed
    expect(stats.critical).toBe(2); // Critical AND not resolved/closed
  });
});

// ═══════════════════════════════════════════════════════════════
// DATABASE TESTS — Project Specs
// ═══════════════════════════════════════════════════════════════

describe('Database — Project Specs', () => {
  afterEach(() => {
    const allSpecs = db.getAllSpecs();
    for (const s of allSpecs) {
      db.deleteSpec(s.id);
    }
  });

  test('createSpec', () => {
    const spec = db.createSpec({
      name: 'Column Min Size',
      category: 'Structural',
      description: 'Load-bearing columns min 400mm x 400mm',
      priority: 'Critical'
    });

    expect(spec).toBeDefined();
    expect(spec.id).toMatch(/^SPEC-[A-Z0-9]{6}$/);
    expect(spec.name).toBe('Column Min Size');
    expect(spec.category).toBe('Structural');
    expect(spec.description).toBe('Load-bearing columns min 400mm x 400mm');
    expect(spec.priority).toBe('Critical');
    expect(spec.source).toBe('manual');
  });

  test('getAllSpecs lists all specs', () => {
    db.createSpec({ name: 'Spec A', description: 'Desc A' });
    db.createSpec({ name: 'Spec B', description: 'Desc B' });

    const all = db.getAllSpecs();
    expect(all).toHaveLength(2);
  });

  test('getAllSpecs filtered by category', () => {
    db.createSpec({ name: 'S1', description: 'D', category: 'Structural' });
    db.createSpec({ name: 'S2', description: 'D', category: 'MEP' });
    db.createSpec({ name: 'S3', description: 'D', category: 'Structural' });

    const structural = db.getAllSpecs({ category: 'Structural' });
    expect(structural).toHaveLength(2);
    structural.forEach(s => expect(s.category).toBe('Structural'));
  });

  test('updateSpec', () => {
    const spec = db.createSpec({ name: 'Original', description: 'D', priority: 'Low' });
    const updated = db.updateSpec(spec.id, { name: 'Updated', priority: 'High' });

    expect(updated.name).toBe('Updated');
    expect(updated.priority).toBe('High');
    expect(updated.description).toBe('D');
  });

  test('updateSpec with non-existent ID returns null', () => {
    const result = db.updateSpec('SPEC-ZZZZZZ', { name: 'X' });
    expect(result).toBeNull();
  });

  test('deleteSpec', () => {
    const spec = db.createSpec({ name: 'To Delete', description: 'D' });
    const result = db.deleteSpec(spec.id);
    expect(result).toBe(true);

    const fetched = db.getSpec(spec.id);
    expect(fetched).toBeUndefined();
  });

  test('deleteSpec with non-existent ID returns false', () => {
    const result = db.deleteSpec('SPEC-ZZZZZZ');
    expect(result).toBe(false);
  });

  test('getSpecsByCategory returns max 10 results sorted by priority', () => {
    // Create 12 specs in Structural category with various priorities
    for (let i = 0; i < 12; i++) {
      db.createSpec({
        name: `Spec ${i}`,
        description: `Description ${i}`,
        category: 'Structural',
        priority: i < 3 ? 'Critical' : i < 6 ? 'High' : i < 9 ? 'Medium' : 'Low'
      });
    }

    const results = db.getSpecsByCategory('Structural', 10);
    expect(results.length).toBeLessThanOrEqual(10);

    // Verify sorted by priority (Critical first)
    const priorities = results.map(s => s.priority);
    const priorityOrder = { Critical: 1, High: 2, Medium: 3, Low: 4 };
    for (let i = 1; i < priorities.length; i++) {
      expect(priorityOrder[priorities[i]]).toBeGreaterThanOrEqual(priorityOrder[priorities[i - 1]]);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// API ENDPOINT TESTS (server.js)
// ═══════════════════════════════════════════════════════════════

describe('API — Health', () => {
  test('GET /api/health returns 200 with status ok', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
  });
});

describe('API — Snags CRUD', () => {
  let snagId;

  afterEach(async () => {
    // Clean up all snags
    const res = await request(app).get('/api/snags');
    for (const s of res.body) {
      await request(app).delete(`/api/snags/${s.id}`);
    }
  });

  test('POST /api/snags creates snag (201)', async () => {
    const res = await request(app)
      .post('/api/snags')
      .send({ title: 'Test Snag', description: 'Test description', priority: 'High' });

    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^SNG-/);
    expect(res.body.title).toBe('Test Snag');
    expect(res.body.priority).toBe('High');
    expect(res.body.photos).toEqual([]);
    snagId = res.body.id;
  });

  test('POST /api/snags with missing title returns 400', async () => {
    const res = await request(app)
      .post('/api/snags')
      .send({ description: 'No title here' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('POST /api/snags with missing description returns 400', async () => {
    const res = await request(app)
      .post('/api/snags')
      .send({ title: 'No description' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('GET /api/snags returns array', async () => {
    await request(app).post('/api/snags').send({ title: 'S1', description: 'D1' });
    await request(app).post('/api/snags').send({ title: 'S2', description: 'D2' });

    const res = await request(app).get('/api/snags');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
  });

  test('GET /api/snags?status=Open filters by status', async () => {
    await request(app).post('/api/snags').send({ title: 'S1', description: 'D', status: 'Open' });
    await request(app).post('/api/snags').send({ title: 'S2', description: 'D', status: 'Closed' });

    const res = await request(app).get('/api/snags?status=Open');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].status).toBe('Open');
  });

  test('GET /api/snags/:id returns snag', async () => {
    const created = await request(app).post('/api/snags').send({ title: 'Find Me', description: 'D' });
    const res = await request(app).get(`/api/snags/${created.body.id}`);

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Find Me');
    expect(Array.isArray(res.body.photos)).toBe(true);
  });

  test('GET /api/snags/:id with bad ID returns 404', async () => {
    const res = await request(app).get('/api/snags/SNG-NONEXISTENT');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });

  test('PUT /api/snags/:id updates fields', async () => {
    const created = await request(app).post('/api/snags').send({ title: 'Original', description: 'D' });
    const res = await request(app)
      .put(`/api/snags/${created.body.id}`)
      .send({ title: 'Updated', status: 'In Progress' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Updated');
    expect(res.body.status).toBe('In Progress');
  });

  test('PUT /api/snags/:id with bad ID returns 404', async () => {
    const res = await request(app)
      .put('/api/snags/SNG-NONEXISTENT')
      .send({ title: 'X' });
    expect(res.status).toBe(404);
  });

  test('DELETE /api/snags/:id deletes', async () => {
    const created = await request(app).post('/api/snags').send({ title: 'Delete Me', description: 'D' });
    const res = await request(app).delete(`/api/snags/${created.body.id}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const check = await request(app).get(`/api/snags/${created.body.id}`);
    expect(check.status).toBe(404);
  });

  test('DELETE /api/snags/:id with bad ID returns 404', async () => {
    const res = await request(app).delete('/api/snags/SNG-NONEXISTENT');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeDefined();
  });
});

describe('API — Snag Stats', () => {
  afterEach(async () => {
    const res = await request(app).get('/api/snags');
    for (const s of res.body) {
      await request(app).delete(`/api/snags/${s.id}`);
    }
  });

  test('GET /api/snags/stats returns counts', async () => {
    await request(app).post('/api/snags').send({ title: 'A', description: 'D', status: 'Open', priority: 'Critical' });
    await request(app).post('/api/snags').send({ title: 'B', description: 'D', status: 'In Progress', priority: 'High' });
    await request(app).post('/api/snags').send({ title: 'C', description: 'D', status: 'Resolved', priority: 'Low' });

    const res = await request(app).get('/api/snags/stats');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.open).toBe(1);
    expect(res.body.inProgress).toBe(1);
    expect(res.body.resolved).toBe(1);
    expect(res.body.critical).toBe(1);
  });
});

describe('API — Export', () => {
  afterEach(async () => {
    const res = await request(app).get('/api/snags');
    for (const s of res.body) {
      await request(app).delete(`/api/snags/${s.id}`);
    }
  });

  test('GET /api/snags/export/csv returns CSV with correct headers', async () => {
    await request(app).post('/api/snags').send({ title: 'CSV Snag', description: 'For export' });

    const res = await request(app).get('/api/snags/export/csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);

    const lines = res.text.split('\n');
    const headerLine = lines[0];
    expect(headerLine).toContain('ID');
    expect(headerLine).toContain('Title');
    expect(headerLine).toContain('Description');
    expect(headerLine).toContain('Category');
    expect(headerLine).toContain('Priority');
    expect(headerLine).toContain('Status');
    // Verify data row exists
    expect(lines[1]).toContain('CSV Snag');
  });

  test('GET /api/snags/export/pdf returns PDF content-type', async () => {
    const res = await request(app).get('/api/snags/export/pdf');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });
});

describe('API — Specs CRUD', () => {
  afterEach(async () => {
    const res = await request(app).get('/api/specs');
    for (const s of res.body) {
      await request(app).delete(`/api/specs/${s.id}`);
    }
  });

  test('POST /api/specs creates spec', async () => {
    const res = await request(app)
      .post('/api/specs')
      .send({ name: 'Fire Rating', description: '2-hour fire rated walls required', category: 'Safety', priority: 'Critical' });

    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^SPEC-/);
    expect(res.body.name).toBe('Fire Rating');
    expect(res.body.category).toBe('Safety');
  });

  test('POST /api/specs with missing fields returns 400', async () => {
    const res = await request(app)
      .post('/api/specs')
      .send({ name: 'No description' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('GET /api/specs returns array', async () => {
    await request(app).post('/api/specs').send({ name: 'S1', description: 'D1' });
    await request(app).post('/api/specs').send({ name: 'S2', description: 'D2' });

    const res = await request(app).get('/api/specs');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);
  });

  test('GET /api/specs?category=Structural filters', async () => {
    await request(app).post('/api/specs').send({ name: 'S1', description: 'D', category: 'Structural' });
    await request(app).post('/api/specs').send({ name: 'S2', description: 'D', category: 'MEP' });

    const res = await request(app).get('/api/specs?category=Structural');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].category).toBe('Structural');
  });

  test('PUT /api/specs/:id updates', async () => {
    const created = await request(app).post('/api/specs').send({ name: 'Original', description: 'D' });
    const res = await request(app)
      .put(`/api/specs/${created.body.id}`)
      .send({ name: 'Updated Name' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Name');
  });

  test('PUT /api/specs/:id with bad ID returns 404', async () => {
    const res = await request(app)
      .put('/api/specs/SPEC-NONEXIST')
      .send({ name: 'X' });
    expect(res.status).toBe(404);
  });

  test('DELETE /api/specs/:id deletes', async () => {
    const created = await request(app).post('/api/specs').send({ name: 'Delete Me', description: 'D' });
    const res = await request(app).delete(`/api/specs/${created.body.id}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('DELETE /api/specs/:id with bad ID returns 404', async () => {
    const res = await request(app).delete('/api/specs/SPEC-NONEXIST');
    expect(res.status).toBe(404);
  });
});

describe('API — MimaarAI & AI Endpoints (validation)', () => {
  test('POST /api/mimarai/login with missing fields returns 400', async () => {
    const res = await request(app)
      .post('/api/mimarai/login')
      .send({ email: 'test@test.com' }); // missing password

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('POST /api/mimarai/login with no body returns 400', async () => {
    const res = await request(app)
      .post('/api/mimarai/login')
      .send({});

    expect(res.status).toBe(400);
  });

  test('POST /api/snags/ai-categorize with missing description returns 400', async () => {
    const res = await request(app)
      .post('/api/snags/ai-categorize')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/[Dd]escription/);
  });

  test('POST /api/snags/ai-scan with missing attachments returns 400', async () => {
    const res = await request(app)
      .post('/api/snags/ai-scan')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/photo/i);
  });

  test('POST /api/snags/ai-scan with empty attachments array returns 400', async () => {
    const res = await request(app)
      .post('/api/snags/ai-scan')
      .send({ attachments: [] });

    expect(res.status).toBe(400);
  });
});
