require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { createProxyMiddleware } = require('http-proxy-middleware');
const db = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
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

// OpenSpace proxy
const OPENSPACE_URL = 'https://ksa.openspace.ai/ohplayer?site=clQN_W4eSIqNUhIF-qCM-Q&bright=0&capture=MHmdrOblSVqiihnW5XEnww&pano=aoB9N6xnWayjdTuJkNW_iA&sheet=5l7yKKmdRF6P7pfoUQfgtQ&shadow=0&sharp=0&attitude=-0.7071%2C0%2C0%2C-0.7071&fov=1.33&pos=32.9045%2C-15.5963%2C1.6442';

app.use('/proxy/openspace', createProxyMiddleware({
  target: 'https://ksa.openspace.ai',
  changeOrigin: true,
  pathRewrite: (p) => {
    const url = new URL(OPENSPACE_URL);
    return url.pathname + url.search;
  },
  on: {
    proxyRes: (proxyRes) => {
      delete proxyRes.headers['x-frame-options'];
      delete proxyRes.headers['content-security-policy'];
      delete proxyRes.headers['x-content-type-options'];
    }
  }
}));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

// AI Categorize via MimaarAI
app.post('/api/snags/ai-categorize', async (req, res) => {
  const { description } = req.body;
  if (!description) return res.status(400).json({ error: 'Description is required' });

  const prompt = `You are a construction QA/QC expert. Analyze this snag description and respond ONLY with valid JSON (no markdown, no code fences, no explanation):
"${description}"
Return exactly this JSON structure: {"category":"one of: Structural, MEP, Finishing, Safety, Waterproofing, Electrical, Plumbing, HVAC, Fire Protection, Painting, Flooring, Ceiling, Doors & Windows, Facade, Landscaping, Other","priority":"Critical|High|Medium|Low","trade":"one of: General Contractor, Electrical, Mechanical, Plumbing, HVAC, Fire Protection, Painting, Flooring, Glazing, Steelwork, Concrete, Drywall, Roofing, Landscaping, Other","rootCause":"1 sentence","recommendation":"1-2 sentences","effort":"Minor (<1hr)|Moderate (1-4hrs)|Major (4-8hrs)|Extensive (>8hrs)"}`;

  const models = ['mimarai-pro', 'mimarai-advanced'];

  for (const model of models) {
    try {
      const response = await fetch('https://mimarai.com/api/chat/enhanced', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': `snag-categorize-${Date.now()}`
        },
        body: JSON.stringify({
          message: prompt,
          sessionId: `snag-categorize-${Date.now()}`,
          model,
          temperature: 0.3,
          engineeringContext: {
            sbcMode: true,
            stream: 'structural',
            type: 'qa_qc'
          }
        })
      });

      if (!response.ok) {
        console.log(`MimaarAI ${model} returned ${response.status}, trying fallback...`);
        continue;
      }

      const data = await response.json();
      const content = data.content || '';

      // Extract JSON from response (handle potential markdown wrapping)
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log(`MimaarAI ${model} returned non-JSON, trying fallback...`);
        continue;
      }

      const result = JSON.parse(jsonMatch[0]);
      return res.json({ success: true, model, ...result });
    } catch (err) {
      console.error(`MimaarAI ${model} error:`, err.message);
      continue;
    }
  }

  res.status(503).json({ error: 'AI categorization unavailable. Both MimaarAI models failed.' });
});

app.listen(PORT, () => {
  console.log(`OpenSpace Snag Manager running at http://localhost:${PORT}`);
});
