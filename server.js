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
        try { const d = JSON.parse(payload); content += d.content || d.text || d.delta || ''; } catch {}
      }
      if (content.length > 0) { console.log(`[MimaarAI] ${m} collect OK, length: ${content.length}`); return content; }
    } catch (err) { console.log(`[MimaarAI] ${m} collect FAILED: ${err.message}`); }
  }
  throw new Error('All MimaarAI models failed');
}

// SSE streaming passthrough: pipes MimaarAI stream → frontend in real-time
// No fixed timeout — keeps connection alive with heartbeats until MimaarAI finishes or errors
async function streamMimaarAI(req, res, { message, model, temperature, attachments, engineeringContext }) {
  // Send keepalive every 15s so proxies/browsers don't kill the connection
  let heartbeat;
  let clientDisconnected = false;

  try {
    const response = await fetch('https://mimarai.com/api/chat/enhanced/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...mimaraiHeaders(req) },
      body: JSON.stringify({
        message,
        sessionId: `snag-${Date.now()}`,
        model,
        temperature: temperature || 0.3,
        stream: true,
        isMobile: true,
        ...(attachments ? { attachments } : {}),
        ...(engineeringContext ? { engineeringContext } : {})
      })
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      throw new Error(`${response.status}: ${errBody.slice(0, 300)}`);
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    // Detect client disconnect
    res.on('close', () => { clientDisconnected = true; });

    // Send heartbeat keepalives every 15s so Railway/browser don't timeout
    heartbeat = setInterval(() => {
      if (!clientDisconnected) {
        res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
      }
    }, 15000);

    // Send initial status
    res.write(`data: ${JSON.stringify({ type: 'status', message: 'Connected to MimaarAI, waiting for response...' })}\n\n`);

    // Pipe MimaarAI SSE → frontend, accumulate content
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';

    while (true) {
      if (clientDisconnected) break;
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const data = JSON.parse(payload);
          const text = data.content || data.text || data.delta || '';
          if (text) {
            fullContent += text;
            if (!clientDisconnected) {
              res.write(`data: ${JSON.stringify({ type: 'chunk', content: text })}\n\n`);
            }
          }
        } catch {}
      }
    }

    clearInterval(heartbeat);
    return fullContent;
  } catch (err) {
    if (heartbeat) clearInterval(heartbeat);
    throw err;
  }
}

// AI Categorize via MimaarAI (SSE streaming)
app.post('/api/snags/ai-categorize', async (req, res) => {
  const { description } = req.body;
  if (!description) return res.status(400).json({ error: 'Description is required' });

  const specsSection = buildSpecsPrompt(null);
  const prompt = `${specsSection}You are a construction QA/QC expert. Analyze this snag and respond ONLY with valid JSON (no markdown, no code fences):
"${description}"
Return: {"category":"Structural|MEP|Finishing|Safety|Waterproofing|Electrical|Plumbing|HVAC|Fire Protection|Painting|Flooring|Ceiling|Doors & Windows|Facade|Landscaping|Other","priority":"Critical|High|Medium|Low","trade":"General Contractor|Electrical|Mechanical|Plumbing|HVAC|Fire Protection|Painting|Flooring|Glazing|Steelwork|Concrete|Drywall|Roofing|Landscaping|Other","rootCause":"1 sentence","recommendation":"1-2 sentences","effort":"Minor (<1hr)|Moderate (1-4hrs)|Major (4-8hrs)|Extensive (>8hrs)","specViolations":["list any project spec violations, or empty array if none"]}`;

  const models = ['mimarai-ultra', 'mimarai-pro', 'mimarai-advanced'];
  const engCtx = { sbcMode: true, stream: 'structural', category: 'inspection', type: 'qa_qc' };

  for (const model of models) {
    try {
      console.log(`[MimaarAI] Trying ${model} for categorize...`);
      const content = await streamMimaarAI(req, res, { message: prompt, model, temperature: 0.3, engineeringContext: engCtx });
      console.log(`[MimaarAI] ${model} categorize OK, length: ${content.length}`);

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        res.write(`data: ${JSON.stringify({ type: 'result', model, ...result })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ type: 'result', model, raw: content })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    } catch (err) {
      console.log(`[MimaarAI] ${model} categorize FAILED: ${err.message}`);
      continue;
    }
  }

  if (!res.headersSent) {
    res.status(503).json({ error: 'AI categorization unavailable. Please login to MimaarAI first.' });
  } else {
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'All models failed' })}\n\n`);
    res.end();
  }
});

// AI Scan — vision-based defect detection (SSE streaming)
app.post('/api/snags/ai-scan', async (req, res) => {
  const { attachments } = req.body;
  if (!attachments || attachments.length === 0) {
    return res.status(400).json({ error: 'At least one photo is required' });
  }

  const specsSection = buildSpecsPrompt(null);
  const prompt = `${specsSection}Look at these construction site photos. List all visible defects, quality issues, safety hazards, and any violations of project specs above. Return a JSON array only, no markdown.

Each object: {"title":"short name","description":"detail","category":"Structural|MEP|Finishing|Safety|Waterproofing|Electrical|Plumbing|HVAC|Fire Protection|Painting|Flooring|Ceiling|Doors & Windows|Facade|Landscaping|Other","priority":"Critical|High|Medium|Low","trade":"responsible trade","rootCause":"cause","recommendation":"fix per SBC standards","effort":"Minor (<1hr)|Moderate (1-4hrs)|Major (4-8hrs)|Extensive (>8hrs)","location":"where in image","specViolations":["any project spec violations"]}

If no defects found, return: []`;

  const models = ['mimarai-pro', 'mimarai-ultra', 'mimarai-advanced'];
  const engCtx = { sbcMode: true, stream: 'structural', category: 'site_photo', type: 'field_observation' };

  for (const model of models) {
    try {
      console.log(`[MimaarAI] Trying ${model} for scan...`);
      const content = await streamMimaarAI(req, res, {
        message: prompt,
        model,
        temperature: 0.4,
        engineeringContext: engCtx,
        attachments: attachments.map(a => ({
          type: a.type || 'image/jpeg',
          data: a.data,
          name: a.name || 'site-photo.jpg'
        }))
      });
      console.log(`[MimaarAI] ${model} scan OK, length: ${content.length}`);

      const arrayMatch = content.match(/\[[\s\S]*\]/);
      let snags = [];
      if (arrayMatch) {
        snags = JSON.parse(arrayMatch[0]);
        if (!Array.isArray(snags)) snags = [snags];
      } else {
        const objMatch = content.match(/\{[\s\S]*\}/);
        if (objMatch) snags = [JSON.parse(objMatch[0])];
      }
      res.write(`data: ${JSON.stringify({ type: 'result', model, snags })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    } catch (err) {
      console.log(`[MimaarAI] ${model} scan FAILED: ${err.message}`);
      continue;
    }
  }

  if (!res.headersSent) {
    res.status(503).json({ error: 'AI scan unavailable. Please login to MimaarAI first.' });
  } else {
    res.write(`data: ${JSON.stringify({ type: 'error', error: 'All models failed' })}\n\n`);
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`OpenSpace Snag Manager running at http://localhost:${PORT}`);
});
