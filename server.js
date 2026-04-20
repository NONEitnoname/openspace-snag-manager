require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const db = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Multer config for photo uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|bmp/;
    if (allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype.replace('image/', ''))) {
      cb(null, true);
    } else {
      cb(new Error('Only image files allowed'));
    }
  }
});

// ── MimaarAI Auth Proxy ──────────────────────────────────────

// Login to MimaarAI
app.post('/api/mimarai/login', async (req, res) => {
  const { email, password, rememberMe } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const response = await fetch('https://mimarai.com/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, rememberMe: rememberMe || false })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot connect to MimaarAI' });
  }
});

// Register on MimaarAI
app.post('/api/mimarai/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Name, email, and password required' });
  try {
    const response = await fetch('https://mimarai.com/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Cannot connect to MimaarAI' });
  }
});

// Helper: build MimaarAI request headers (with auth if token provided)
function mimaraiHeaders(req) {
  const headers = { 'X-Session-ID': `snag-${Date.now()}` };
  const authToken = req.headers['x-mimarai-token'];
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
    console.log('[MimaarAI] Using authenticated request');
  } else {
    console.log('[MimaarAI] Anonymous request (no token)');
  }
  return headers;
}

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── Project Specs ────────────────────────────────────────────

app.get('/api/specs', (req, res) => {
  res.json(db.getAllSpecs({ category: req.query.category }));
});

app.post('/api/specs', (req, res) => {
  const { name, description } = req.body;
  if (!name || !description) return res.status(400).json({ error: 'Name and description required' });
  res.status(201).json(db.createSpec(req.body));
});

app.put('/api/specs/:id', (req, res) => {
  const spec = db.updateSpec(req.params.id, req.body);
  if (!spec) return res.status(404).json({ error: 'Spec not found' });
  res.json(spec);
});

app.delete('/api/specs/:id', (req, res) => {
  if (!db.deleteSpec(req.params.id)) return res.status(404).json({ error: 'Spec not found' });
  res.json({ success: true });
});

// Extract specs from uploaded PDF via MimaarAI
const specUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 }, fileFilter: (req, f, cb) => cb(null, f.mimetype === 'application/pdf') });

app.post('/api/specs/extract', specUpload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'PDF file required' });

  const base64 = req.file.buffer.toString('base64');
  const prompt = `Extract all construction project specifications and requirements from this document. Return ONLY a JSON array (no markdown, no code fences):
[{"name":"short spec name","category":"Structural|MEP|Safety|Electrical|Plumbing|HVAC|Fire Protection|Finishing|Waterproofing|Facade|Other","description":"the requirement in 1-2 sentences","priority":"Critical|High|Medium|Low"}]
Focus on: dimensions, materials, fire ratings, finish requirements, structural specs, MEP specs, safety requirements, SBC compliance items. Extract as many specific requirements as possible.`;

  try {
    const content = await collectMimaarAI(req, {
      message: prompt,
      model: 'mimarai-pro',
      temperature: 0.2,
      attachments: [{ type: 'application/pdf', data: base64, name: req.file.originalname }]
    });

    const arrayMatch = content.match(/\[[\s\S]*\]/);
    if (!arrayMatch) return res.json({ specs: [], raw: content });
    const specs = JSON.parse(arrayMatch[0]);
    res.json({ specs: Array.isArray(specs) ? specs : [specs], source: req.file.originalname });
  } catch (err) {
    console.error('[Spec Extract] Failed:', err.message);
    res.status(503).json({ error: 'Failed to extract specs. ' + err.message });
  }
});

// Extract specs from OneDrive link
app.post('/api/specs/onedrive', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'OneDrive URL required' });

  try {
    // Convert share link to download URL
    const encoded = Buffer.from(url).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
    const downloadUrl = `https://api.onedrive.com/v1.0/shares/u!${encoded}/root/content`;
    const fileRes = await fetch(downloadUrl, { redirect: 'follow' });
    if (!fileRes.ok) throw new Error(`OneDrive returned ${fileRes.status}`);
    const buf = Buffer.from(await fileRes.arrayBuffer());
    const base64 = buf.toString('base64');

    const prompt = `Extract all construction project specifications and requirements from this document. Return ONLY a JSON array (no markdown, no code fences):
[{"name":"short spec name","category":"Structural|MEP|Safety|Electrical|Plumbing|HVAC|Fire Protection|Finishing|Waterproofing|Facade|Other","description":"the requirement in 1-2 sentences","priority":"Critical|High|Medium|Low"}]
Focus on: dimensions, materials, fire ratings, finish requirements, structural specs, MEP specs, safety requirements.`;

    const content = await collectMimaarAI(req, {
      message: prompt,
      model: 'mimarai-pro',
      temperature: 0.2,
      attachments: [{ type: 'application/pdf', data: base64, name: 'onedrive-spec.pdf' }]
    });

    const arrayMatch = content.match(/\[[\s\S]*\]/);
    if (!arrayMatch) return res.json({ specs: [], raw: content });
    const specs = JSON.parse(arrayMatch[0]);
    res.json({ specs: Array.isArray(specs) ? specs : [specs], source: url });
  } catch (err) {
    console.error('[OneDrive Extract] Failed:', err.message);
    res.status(503).json({ error: 'Failed: ' + err.message });
  }
});

// Stats
app.get('/api/snags/stats', (req, res) => {
  res.json(db.getStats());
});

// List snags
app.get('/api/snags', (req, res) => {
  const { status, priority, search, sort } = req.query;
  const snags = db.getAllSnags({ status, priority, search, sort });
  const parsed = snags.map(s => ({ ...s, photos: JSON.parse(s.photos || '[]') }));
  res.json(parsed);
});

// Get single snag
app.get('/api/snags/export/csv', (req, res) => {
  const { status, priority, search } = req.query;
  const snags = db.getAllSnags({ status, priority, search });

  const headers = ['ID', 'Title', 'Description', 'Category', 'Priority', 'Status', 'Trade', 'Location', 'Floor', 'Zone', 'Assignee', 'Due Date', 'Root Cause', 'Recommendation', 'Effort', 'Created', 'Updated'];
  const escape = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  let csv = headers.join(',') + '\n';
  for (const s of snags) {
    csv += [s.id, s.title, s.description, s.category, s.priority, s.status, s.trade, s.location, s.floor, s.zone, s.assignee, s.due_date, s.root_cause, s.recommendation, s.effort, s.created_at, s.updated_at].map(escape).join(',') + '\n';
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="snags-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

// PDF export
app.get('/api/snags/export/pdf', (req, res) => {
  const { status, priority, search } = req.query;
  const snags = db.getAllSnags({ status, priority, search });
  const stats = db.getStats();

  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="snag-report-${new Date().toISOString().slice(0, 10)}.pdf"`);
  doc.pipe(res);

  // Header
  doc.rect(0, 0, doc.page.width, 80).fill('#0d3d38');
  doc.fillColor('#ffffff').fontSize(22).text('OpenSpace Snag Report', 40, 20);
  doc.fontSize(10).text(`Generated: ${new Date().toLocaleString()}`, 40, 50);

  // Stats
  doc.fillColor('#333333').fontSize(12);
  doc.text(`Total: ${stats.total}  |  Open: ${stats.open}  |  In Progress: ${stats.inProgress}  |  Resolved: ${stats.resolved}  |  Critical: ${stats.critical}`, 40, 100);
  doc.moveDown();

  // Snag entries
  const priorityColors = { Critical: '#dc2626', High: '#ea580c', Medium: '#ca8a04', Low: '#16a34a' };
  for (const s of snags) {
    if (doc.y > 700) doc.addPage();

    doc.rect(40, doc.y, doc.page.width - 80, 2).fill(priorityColors[s.priority] || '#999999');
    doc.moveDown(0.3);
    doc.fillColor('#111').fontSize(11).text(`${s.id} — ${s.title}`, 40);
    doc.fillColor('#555').fontSize(9);
    const details = [`Priority: ${s.priority}`, `Status: ${s.status}`, s.category, s.location, s.trade, s.assignee].filter(Boolean).join('  |  ');
    doc.text(details, 40);
    if (s.description) doc.fillColor('#333').fontSize(9).text(s.description, 40, undefined, { width: doc.page.width - 80 });
    if (s.root_cause) doc.fillColor('#666').text(`Root Cause: ${s.root_cause}`, 40);
    if (s.recommendation) doc.fillColor('#666').text(`Fix: ${s.recommendation}`, 40);
    doc.moveDown(0.8);
  }

  if (snags.length === 0) {
    doc.fillColor('#999').fontSize(14).text('No snags found.', 40, 140);
  }

  doc.end();
});

// Get single snag
app.get('/api/snags/:id', (req, res) => {
  const snag = db.getSnag(req.params.id);
  if (!snag) return res.status(404).json({ error: 'Snag not found' });
  res.json({ ...snag, photos: JSON.parse(snag.photos || '[]') });
});

// Create snag
app.post('/api/snags', (req, res) => {
  const { title, description } = req.body;
  if (!title || !description) return res.status(400).json({ error: 'Title and description are required' });
  const snag = db.createSnag(req.body);
  res.status(201).json({ ...snag, photos: JSON.parse(snag.photos || '[]') });
});

// Update snag
app.put('/api/snags/:id', (req, res) => {
  const snag = db.updateSnag(req.params.id, req.body);
  if (!snag) return res.status(404).json({ error: 'Snag not found' });
  res.json({ ...snag, photos: JSON.parse(snag.photos || '[]') });
});

// Delete snag
app.delete('/api/snags/:id', (req, res) => {
  const deleted = db.deleteSnag(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Snag not found' });
  res.json({ success: true });
});

// Photo upload
app.post('/api/snags/:id/photos', upload.array('photos', 10), (req, res) => {
  const snag = db.getSnag(req.params.id);
  if (!snag) return res.status(404).json({ error: 'Snag not found' });

  const existing = JSON.parse(snag.photos || '[]');
  const newPhotos = req.files.map(f => `/uploads/${f.filename}`);
  const all = [...existing, ...newPhotos];

  db.updateSnag(req.params.id, { photos: all });
  res.json({ photos: all });
});

// Helper: build specs section for AI prompts
function buildSpecsPrompt(category) {
  const specs = db.getSpecsByCategory(category, 10);
  if (specs.length === 0) return '';
  return 'PROJECT SPECS — check compliance and flag violations:\n' +
    specs.map(s => `- ${s.name}: ${s.description}`).join('\n') + '\n\n';
}

// Non-streaming MimaarAI call — collects full response (for spec extraction)
async function collectMimaarAI(req, { message, model, temperature, attachments }) {
  const models = [model, 'mimarai-ultra', 'mimarai-advanced'];
  for (const m of [...new Set(models)]) {
    try {
      const response = await fetch('https://mimarai.com/api/chat/enhanced/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...mimaraiHeaders(req) },
        body: JSON.stringify({
          message, sessionId: `snag-${Date.now()}`, model: m,
          temperature: temperature || 0.3, stream: true, isMobile: true,
          ...(attachments ? { attachments } : {})
        })
      });
      if (!response.ok) { console.log(`[MimaarAI] ${m} collect FAILED ${response.status}`); continue; }
      const text = await response.text();
      let content = '';
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const d = JSON.parse(payload);
          let chunk = d.content || d.text || d.delta || '';
          if (typeof chunk === 'object') chunk = chunk.text || chunk.value || JSON.stringify(chunk);
          if (typeof chunk === 'string') content += chunk;
        } catch {}
      }
      if (content.length > 0) { console.log(`[MimaarAI] ${m} collect OK, length: ${content.length}`); return content; }
    } catch (err) { console.log(`[MimaarAI] ${m} collect FAILED: ${err.message}`); }
  }
  throw new Error('All MimaarAI models failed');
}

// AI Categorize via MimaarAI
app.post('/api/snags/ai-categorize', async (req, res) => {
  const { description } = req.body;
  if (!description) return res.status(400).json({ error: 'Description is required' });

  const specsSection = buildSpecsPrompt(null);
  const prompt = `Saudi Building Code construction QA/QC snag analysis — structural concrete steel reinforcement, electrical, mechanical, fire protection, safety.

${specsSection ? 'PROJECT SPECS:\n' + specsSection + '\n' : ''}Analyze this construction snag and respond ONLY with valid JSON (no markdown, no code fences):
"${description}"
Return: {"category":"Structural|MEP|Finishing|Safety|Waterproofing|Electrical|Plumbing|HVAC|Fire Protection|Painting|Flooring|Ceiling|Doors & Windows|Facade|Landscaping|Other","priority":"Critical|High|Medium|Low","trade":"General Contractor|Electrical|Mechanical|Plumbing|HVAC|Fire Protection|Painting|Flooring|Glazing|Steelwork|Concrete|Drywall|Roofing|Landscaping|Other","rootCause":"1 sentence citing applicable SBC section","recommendation":"1-2 sentences with SBC compliance guidance","effort":"Minor (<1hr)|Moderate (1-4hrs)|Major (4-8hrs)|Extensive (>8hrs)","specViolations":["list any project spec violations, or empty array if none"]}`;

  try {
    const content = await collectMimaarAI(req, { message: prompt, model: 'mimarai-ultra', temperature: 0.3 });
    console.log(`[AI Categorize] Content preview: ${content.slice(0, 200)}`);
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.json({ success: true, raw: content });
    const result = JSON.parse(jsonMatch[0]);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[AI Categorize] Failed:', err.message);
    res.status(503).json({ error: 'AI categorization failed. Please login to MimaarAI first.' });
  }
});

// AI Scan — submits to MimaarAI async job API, polls for result
// MimaarAI: POST /api/v1/analyze → 202 {jobId} → GET /api/v1/analyze/:jobId (poll)

app.get('/api/snags/ai-scan/status/:jobId', async (req, res) => {
  // Proxy poll to MimaarAI's job status endpoint
  const authToken = req.headers['x-mimarai-token'];
  try {
    const response = await fetch(`https://mimarai.com/api/v1/analyze/${req.params.jobId}`, {
      headers: { ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}) }
    });
    const data = await response.json();

    // Map MimaarAI's response to our frontend format
    if (data.status === 'completed') {
      const snags = (data.analysis?.findings || []).map(f => ({
        title: f.text?.split('.')[0]?.slice(0, 80) || f.text?.slice(0, 80) || 'Defect',
        description: f.text || '',
        category: f.category || 'Safety',
        priority: f.severity === 'CRITICAL' ? 'Critical' : f.severity === 'MAJOR' ? 'High' : f.severity === 'MINOR' ? 'Low' : 'Medium',
        trade: f.category === 'Safety' ? 'Site Safety / HSE' : 'General Contractor',
        rootCause: '',
        recommendation: f.recommendation || '',
        effort: '',
        location: f.location || '',
        codeReference: f.codeReference || '',
        specViolations: []
      }));
      return res.json({ status: 'complete', snags, metadata: data.metadata, stage: data.stage, progress: 100 });
    } else if (data.status === 'failed') {
      return res.json({ status: 'error', error: data.error, stage: data.stage });
    } else {
      // Still processing — pass through stage info
      return res.json({
        status: 'processing',
        stage: data.stage || 'processing',
        stageMessage: data.stageMessage || 'Analyzing...',
        progress: data.progress || 0,
        elapsedMs: data.elapsedMs || 0
      });
    }
  } catch (err) {
    res.status(502).json({ status: 'error', error: 'Cannot reach MimaarAI: ' + err.message });
  }
});

app.post('/api/snags/ai-scan', async (req, res) => {
  const { attachments } = req.body;
  if (!attachments || attachments.length === 0) {
    return res.status(400).json({ error: 'At least one photo is required' });
  }

  const img = attachments[0];
  const authToken = req.headers['x-mimarai-token'];
  const specsSection = buildSpecsPrompt(null);
  const queryText = `Saudi Building Code construction site inspection — analyze for defects and code compliance:
STRUCTURAL: concrete cracks, spalling, exposed rebar, column damage, reinforcement cover, steel connections
SAFETY: fall protection, scaffolding, PPE, excavation shoring, fire exits, guardrails, barricades
MEP: exposed wiring, junction boxes, plumbing leaks, HVAC duct damage, fire sprinkler obstructions
FIRE PROTECTION: fire-rated assemblies, firestopping, sprinkler coverage, fire extinguisher placement
FINISHING: tile alignment, paint defects, waterproofing membrane, ceiling grid, facade cladding
HOUSEKEEPING: debris, trip hazards, material storage, access routes
${specsSection ? '\nPROJECT SPECS:\n' + specsSection : ''}
List ALL visible defects, safety violations, and quality issues. Cite applicable SBC sections.`;

  try {
    console.log(`[AI Scan] Submitting to /api/v1/analyze (${img.name || 'image'}, ${Math.round((img.data?.length || 0) / 1024)}KB)`);

    const response = await fetch('https://mimarai.com/api/v1/analyze', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {})
      },
      body: JSON.stringify({
        imageData: img.data,
        mimeType: img.type || 'image/jpeg',
        query: queryText,
        reviewType: 'safety',
        includeCoordinates: true
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.log(`[AI Scan] Submit FAILED ${response.status}:`, data.error || data.message);
      return res.status(response.status).json({ error: data.error || data.message || 'Submit failed' });
    }

    console.log(`[AI Scan] Job submitted: ${data.jobId}`);
    res.status(202).json({ jobId: data.jobId, status: 'processing' });
  } catch (err) {
    console.error('[AI Scan] Submit failed:', err.message);
    res.status(503).json({ error: 'Cannot reach MimaarAI: ' + err.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`OpenSpace Snag Manager running at http://localhost:${PORT}`);
  });
}

module.exports = app;
