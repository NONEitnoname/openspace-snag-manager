const DEFAULT_OS_URL = 'https://ksa.openspace.ai/ohplayer?site=clQN_W4eSIqNUhIF-qCM-Q&bright=0&capture=MHmdrOblSVqiihnW5XEnww&pano=aoB9N6xnWayjdTuJkNW_iA&sheet=5l7yKKmdRF6P7pfoUQfgtQ&shadow=0&sharp=0&attitude=-0.7071%2C0%2C0%2C-0.7071&fov=1.33&pos=32.9045%2C-15.5963%2C1.6442';

let allSnags = [];
let totalSnags = 0;
let selectedPhotos = [];
let currentOsUrl = null;
let mimaraiToken = localStorage.getItem('mimarai_token');
let mimaraiUser = JSON.parse(localStorage.getItem('mimarai_user') || 'null');
let pastedImages = []; // images pasted via Ctrl+V

// Init
document.addEventListener('DOMContentLoaded', () => {
  initViewer();
  loadStats();
  loadSnags();
  initPasteListener();
  updateAuthUI();
  document.getElementById('f-photos').addEventListener('change', handlePhotoSelect);
  document.getElementById('f-scanphotos').addEventListener('change', handleScanPhotoSelect);
});

// ────────────────────────────────────────────
// OpenSpace Viewer
// ────────────────────────────────────────────

function initViewer() {
  const saved = localStorage.getItem('openspace_url');
  if (saved) {
    currentOsUrl = saved;
    loadIframe(saved);
  } else {
    showViewerWelcome();
  }
}

function loadIframe(url) {
  currentOsUrl = url;
  localStorage.setItem('openspace_url', url);
  const frame = document.getElementById('viewerFrame');
  frame.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.src = url; // Direct URL — no proxy needed, OpenSpace has no X-Frame-Options
  iframe.allow = 'fullscreen';
  iframe.referrerPolicy = 'no-referrer';
  iframe.style.cssText = 'width:100%;height:100%;border:none';
  frame.appendChild(iframe);
  updateOsStatus(true);
}

function showViewerWelcome() {
  const frame = document.getElementById('viewerFrame');
  frame.innerHTML = `
    <div class="viewer-hub">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:48px;height:48px;opacity:0.4;margin-bottom:12px"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
      <h3 style="color:#fff;font-family:'Playfair Display',serif;margin-bottom:6px">OpenSpace 360° Viewer</h3>
      <p style="color:#999;font-size:13px;margin-bottom:16px">Paste your OpenSpace share link to load the viewer here.</p>
      <button class="viewer-hub-btn primary" onclick="showOsConnect()">Connect OpenSpace</button>
    </div>`;
  updateOsStatus(false);
}

function updateOsStatus(connected) {
  const btn = document.getElementById('osConnectBtn');
  btn.textContent = connected ? 'Change URL' : 'Connect OpenSpace';
}

function openOriginal() {
  window.open(currentOsUrl || DEFAULT_OS_URL, '_blank');
}

function showOsConnect() {
  const overlay = document.getElementById('osConnectOverlay');
  const input = document.getElementById('osUrlInput');
  input.value = currentOsUrl || DEFAULT_OS_URL;
  overlay.style.display = 'flex';
  input.focus();
  input.select();
}

function hideOsConnect() {
  document.getElementById('osConnectOverlay').style.display = 'none';
}

function connectOpenSpace() {
  const url = document.getElementById('osUrlInput').value.trim();
  if (!url) return toast('Enter an OpenSpace URL', 'error');

  try {
    const u = new URL(url);
    const validHosts = ['ksa.openspace.ai', 'app.openspace.ai', 'eu.openspace.ai', 'openspace.ai'];
    if (!validHosts.some(h => u.host.includes(h))) {
      return toast('URL must be from openspace.ai', 'error');
    }
  } catch {
    return toast('Invalid URL format', 'error');
  }

  hideOsConnect();
  loadIframe(url);
  toast('OpenSpace viewer loaded', 'success');
}

function toggleViewerFull() {
  document.getElementById('mainLayout').classList.toggle('viewer-full');
}

function openOriginal() {
  launchOpenSpace();
}

// ────────────────────────────────────────────
// Tabs
// ────────────────────────────────────────────

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  ['form', 'list', 'scan'].forEach(t => {
    const el = document.getElementById(`tab-${t}`);
    if (el) el.classList.toggle('active', t === tab);
  });
  if (tab === 'list') loadSnags();
}

// ────────────────────────────────────────────
// Stats
// ────────────────────────────────────────────

async function loadStats() {
  try {
    const res = await fetch('/api/snags/stats');
    const s = await res.json();
    const el = document.getElementById('headerStats');
    el.innerHTML = `
      <span class="stat-badge">${s.total} Total</span>
      <span class="stat-badge open">${s.open} Open</span>
      <span class="stat-badge in-progress">${s.inProgress} In Progress</span>
      <span class="stat-badge resolved">${s.resolved} Resolved</span>
      ${s.critical > 0 ? `<span class="stat-badge critical">${s.critical} Critical</span>` : ''}
    `;
    totalSnags = s.total;
  } catch (e) { console.error('Stats error:', e); }
}

// ────────────────────────────────────────────
// Load & Render Snags
// ────────────────────────────────────────────

async function loadSnags() {
  const params = new URLSearchParams();
  const status = document.getElementById('filterStatus').value;
  const priority = document.getElementById('filterPriority').value;
  const search = document.getElementById('searchBar').value;
  const sort = document.getElementById('filterSort').value;

  if (status) params.set('status', status);
  if (priority) params.set('priority', priority);
  if (search) params.set('search', search);
  if (sort) params.set('sort', sort);

  try {
    const res = await fetch(`/api/snags?${params}`);
    allSnags = await res.json();
    renderSnags();
  } catch (e) { console.error('Load error:', e); }
}

function renderSnags() {
  const list = document.getElementById('snagList');
  const countEl = document.getElementById('showingCount');
  countEl.textContent = `Showing ${allSnags.length} of ${totalSnags} snags`;

  if (allSnags.length === 0) {
    list.innerHTML = `<div class="empty-state"><h3>No snags found</h3><p>Create your first snag using the form, or use AI Scan to detect snags from photos.</p></div>`;
    return;
  }

  list.innerHTML = allSnags.map(s => {
    const photos = Array.isArray(s.photos) ? s.photos : [];
    const statusClass = s.status.replace(/\s/g, '-');
    return `
    <div class="snag-card" id="card-${s.id}">
      <div class="snag-card-header" onclick="toggleCard('${s.id}')">
        <div class="priority-dot ${s.priority}"></div>
        <div class="snag-card-info">
          <div class="snag-card-top">
            <span class="snag-id">${s.id}</span>
            <span class="pill ${s.priority}">${s.priority}</span>
            <span class="pill ${statusClass}">${s.status}</span>
            ${s.category ? `<span class="pill category">${s.category}</span>` : ''}
          </div>
          <div class="snag-card-title">${esc(s.title)}</div>
          <div class="snag-card-meta">
            ${s.location ? `<span>${esc(s.location)}</span>` : ''}
            ${s.trade ? `<span>${esc(s.trade)}</span>` : ''}
            ${s.assignee ? `<span>${esc(s.assignee)}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="snag-card-body">
        <div class="snag-description">${esc(s.description)}</div>
        <div class="detail-grid">
          <div class="detail-item"><label>Floor</label><span>${esc(s.floor || '—')}</span></div>
          <div class="detail-item"><label>Zone</label><span>${esc(s.zone || '—')}</span></div>
          <div class="detail-item"><label>Due Date</label><span>${s.due_date || '—'}</span></div>
          <div class="detail-item"><label>Effort</label><span>${esc(s.effort || '—')}</span></div>
          <div class="detail-item"><label>Root Cause</label><span>${esc(s.root_cause || '—')}</span></div>
          <div class="detail-item"><label>Recommended Fix</label><span>${esc(s.recommendation || '—')}</span></div>
        </div>
        ${photos.length ? `<div class="snag-photos">${photos.map(p => `<img src="${p}" onclick="window.open('${p}','_blank')">`).join('')}</div>` : ''}
        <div class="snag-card-actions">
          <select onchange="quickStatus('${s.id}', this.value)">
            ${['Open','In Progress','Resolved','Closed'].map(st => `<option ${st === s.status ? 'selected' : ''}>${st}</option>`).join('')}
          </select>
          <button onclick="editSnag('${s.id}')">Edit</button>
          <button class="delete" onclick="confirmDelete('${s.id}')">Delete</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function toggleCard(id) {
  document.getElementById(`card-${id}`).classList.toggle('expanded');
}

// ────────────────────────────────────────────
// Quick Status
// ────────────────────────────────────────────

async function quickStatus(id, status) {
  try {
    await fetch(`/api/snags/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    loadStats();
    loadSnags();
    toast(`Status updated to ${status}`, 'success');
  } catch (e) { toast('Failed to update status', 'error'); }
}

// ────────────────────────────────────────────
// Submit / Edit / Delete
// ────────────────────────────────────────────

async function submitSnag() {
  const title = document.getElementById('f-title').value.trim();
  const description = document.getElementById('f-description').value.trim();
  if (!title || !description) return toast('Title and description are required', 'error');

  const data = {
    title, description,
    category: document.getElementById('f-category').value,
    priority: document.getElementById('f-priority').value,
    status: document.getElementById('f-status').value,
    trade: document.getElementById('f-trade').value,
    location: document.getElementById('f-location').value,
    floor: document.getElementById('f-floor').value,
    zone: document.getElementById('f-zone').value,
    assignee: document.getElementById('f-assignee').value,
    due_date: document.getElementById('f-duedate').value,
    root_cause: document.getElementById('f-rootcause').value,
    recommendation: document.getElementById('f-recommendation').value,
    effort: document.getElementById('f-effort').value,
  };

  const editId = document.getElementById('editId').value;
  const method = editId ? 'PUT' : 'POST';
  const url = editId ? `/api/snags/${editId}` : '/api/snags';

  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const snag = await res.json();
    if (!res.ok) return toast(snag.error || 'Failed to save', 'error');

    if (selectedPhotos.length > 0 && snag.id) {
      const fd = new FormData();
      selectedPhotos.forEach(f => fd.append('photos', f));
      await fetch(`/api/snags/${snag.id}/photos`, { method: 'POST', body: fd });
    }

    toast(editId ? 'Snag updated' : 'Snag created', 'success');
    resetForm();
    loadStats();
    loadSnags();
    switchTab('list');
  } catch (e) { toast('Failed to save snag', 'error'); }
}

function editSnag(id) {
  const s = allSnags.find(x => x.id === id);
  if (!s) return;
  document.getElementById('editId').value = s.id;
  document.getElementById('f-title').value = s.title;
  document.getElementById('f-description').value = s.description;
  document.getElementById('f-category').value = s.category || '';
  document.getElementById('f-priority').value = s.priority || 'Medium';
  document.getElementById('f-status').value = s.status || 'Open';
  document.getElementById('f-trade').value = s.trade || '';
  document.getElementById('f-location').value = s.location || '';
  document.getElementById('f-floor').value = s.floor || '';
  document.getElementById('f-zone').value = s.zone || '';
  document.getElementById('f-assignee').value = s.assignee || '';
  document.getElementById('f-duedate').value = s.due_date || '';
  document.getElementById('f-rootcause').value = s.root_cause || '';
  document.getElementById('f-recommendation').value = s.recommendation || '';
  document.getElementById('f-effort').value = s.effort || '';
  document.getElementById('cancelEditBtn').style.display = 'block';
  switchTab('form');
}

function cancelEdit() { resetForm(); }

function resetForm() {
  document.getElementById('editId').value = '';
  ['f-title','f-description','f-location','f-floor','f-zone','f-assignee','f-duedate','f-rootcause','f-recommendation','f-effort'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('f-category').value = '';
  document.getElementById('f-priority').value = 'Medium';
  document.getElementById('f-status').value = 'Open';
  document.getElementById('f-trade').value = '';
  document.getElementById('cancelEditBtn').style.display = 'none';
  selectedPhotos = [];
  document.getElementById('photoThumbnails').innerHTML = '';
  document.getElementById('f-photos').value = '';
}

function confirmDelete(id) {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  overlay.innerHTML = `
    <div class="confirm-box">
      <h3>Delete Snag?</h3>
      <p>This action cannot be undone.</p>
      <div class="btn-row">
        <button onclick="this.closest('.confirm-overlay').remove()">Cancel</button>
        <button class="danger" onclick="doDelete('${id}', this)">Delete</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

async function doDelete(id, btn) {
  btn.closest('.confirm-overlay').remove();
  try {
    await fetch(`/api/snags/${id}`, { method: 'DELETE' });
    toast('Snag deleted', 'success');
    loadStats();
    loadSnags();
  } catch (e) { toast('Failed to delete', 'error'); }
}

// ────────────────────────────────────────────
// AI Categorize (single snag)
// ────────────────────────────────────────────

// Helper: consume SSE stream from our server
async function consumeSSE(response, onChunk) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = '';
  let result = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]' || !payload) continue;
      try {
        const data = JSON.parse(payload);
        if (data.type === 'chunk' && data.content) {
          fullText += data.content;
          if (onChunk) onChunk(fullText, data.content);
        }
        if (data.type === 'result') result = data;
        if (data.type === 'error') throw new Error(data.error);
      } catch (e) {
        if (e.message && !e.message.includes('JSON')) throw e;
      }
    }
  }
  return { fullText, result };
}

async function aiCategorize() {
  const desc = document.getElementById('f-description').value.trim();
  if (!desc) return toast('Enter a description first', 'error');

  const btn = document.getElementById('aiBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = 'Connecting to MimaarAI...';

  try {
    const res = await fetch('/api/snags/ai-categorize', {
      method: 'POST',
      headers: mimaraiHeaders(),
      body: JSON.stringify({ description: desc })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Failed (${res.status})`);
    }

    const { result } = await consumeSSE(res, (fullText) => {
      btn.textContent = 'Analyzing: ' + fullText.slice(-60).replace(/[{}\[\]"]/g, '').trim() + '...';
    });

    if (result) {
      if (result.category) setSelectValue('f-category', result.category);
      if (result.priority) setSelectValue('f-priority', result.priority);
      if (result.trade) setSelectValue('f-trade', result.trade);
      if (result.rootCause) document.getElementById('f-rootcause').value = result.rootCause;
      if (result.recommendation) document.getElementById('f-recommendation').value = result.recommendation;
      if (result.effort) document.getElementById('f-effort').value = result.effort;
      toast(`Categorized by MimaarAI (${result.model || 'AI'})`, 'success');
    }
  } catch (e) {
    toast(e.message || 'AI categorization failed', 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.innerHTML = 'AI Auto-Categorize (MimaarAI)';
  }
}

// ────────────────────────────────────────────
// AI Scan — Vision analysis of site photos
// ────────────────────────────────────────────

let scanPhotos = [];

function handleScanPhotoSelect(e) {
  scanPhotos = Array.from(e.target.files);
  const container = document.getElementById('scanPhotoThumbnails');
  container.innerHTML = '';
  scanPhotos.forEach(f => {
    const img = document.createElement('img');
    img.className = 'photo-thumb';
    img.src = URL.createObjectURL(f);
    container.appendChild(img);
  });
}

async function aiScanPhotos() {
  const allPhotos = [...pastedImages, ...scanPhotos];
  if (allPhotos.length === 0) return toast('Upload or paste site photos first', 'error');

  const btn = document.getElementById('aiScanBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = 'Uploading to MimaarAI...';
  const results = document.getElementById('scanResults');
  results.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Preparing images...</p>';

  try {
    // Convert photos to base64
    const attachments = await Promise.all(allPhotos.map(async (f) => {
      const buf = await f.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return { type: f.type, data: btoa(binary), name: f.name };
    }));

    btn.textContent = 'MimaarAI analyzing...';
    results.innerHTML = '<p style="color:var(--text-muted);font-size:13px">AI is inspecting the site photo...</p>';

    const res = await fetch('/api/snags/ai-scan', {
      method: 'POST',
      headers: mimaraiHeaders(),
      body: JSON.stringify({ attachments })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Failed (${res.status})`);
    }

    // Stream SSE response
    const { result } = await consumeSSE(res, (fullText) => {
      btn.textContent = 'Scanning: ' + fullText.slice(-50).replace(/[{}\[\]"]/g, '').trim() + '...';
      results.innerHTML = `<p style="color:var(--teal);font-size:12px">AI analysis streaming...</p><pre style="font-size:11px;max-height:200px;overflow:auto;background:#f9fafb;padding:8px;border-radius:6px;white-space:pre-wrap">${esc(fullText.slice(-500))}</pre>`;
    });

    if (!result || !result.snags || result.snags.length === 0) {
      results.innerHTML = '<p style="color:var(--low);font-size:13px;font-weight:600">No defects detected. Site looks good!</p>';
      toast('AI scan complete — no defects found', 'success');
      return;
    }

    // Render detected snags with accept buttons
    results.innerHTML = `<p style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${result.snags.length} potential snag(s) detected by MimaarAI (${result.model || 'AI'})</p>`;
    result.snags.forEach((s, i) => {
      const div = document.createElement('div');
      div.className = 'scan-result-card';
      div.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:start;gap:8px">
          <div style="flex:1">
            <strong style="font-size:13px">${esc(s.title)}</strong>
            <p style="font-size:12px;color:#555;margin:4px 0">${esc(s.description)}</p>
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">
              <span class="pill ${s.priority}">${s.priority}</span>
              ${s.category ? `<span class="pill category">${s.category}</span>` : ''}
              ${s.trade ? `<span style="font-size:10px;color:var(--text-muted)">${esc(s.trade)}</span>` : ''}
            </div>
          </div>
          <button onclick="acceptScanSnag(${i})" style="padding:6px 12px;background:var(--teal);color:#fff;border:none;border-radius:5px;cursor:pointer;font-size:11px;white-space:nowrap">+ Add</button>
        </div>`;
      results.appendChild(div);
    });

    window._scanDetectedSnags = result.snags;
    toast(`${result.snags.length} snag(s) detected`, 'success');
  } catch (e) {
    results.innerHTML = '';
    toast(e.message || 'AI scan failed', 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.textContent = 'AI Scan for Snags (MimaarAI)';
  }
}

async function acceptScanSnag(index) {
  const s = window._scanDetectedSnags?.[index];
  if (!s) return;

  try {
    const res = await fetch('/api/snags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: s.title,
        description: s.description,
        category: s.category,
        priority: s.priority,
        trade: s.trade,
        root_cause: s.rootCause,
        recommendation: s.recommendation,
        effort: s.effort,
        location: s.location || '',
      })
    });
    if (!res.ok) throw new Error('Failed to create');
    toast(`Snag "${s.title}" added`, 'success');
    loadStats();
    loadSnags();
    // Grey out the button
    const btns = document.querySelectorAll('.scan-result-card button');
    if (btns[index]) {
      btns[index].textContent = 'Added';
      btns[index].disabled = true;
      btns[index].style.background = '#999';
    }
  } catch (e) { toast('Failed to add snag', 'error'); }
}

async function acceptAllScanSnags() {
  const snags = window._scanDetectedSnags;
  if (!snags || snags.length === 0) return;

  let added = 0;
  for (const s of snags) {
    try {
      const res = await fetch('/api/snags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: s.title, description: s.description, category: s.category,
          priority: s.priority, trade: s.trade, root_cause: s.rootCause,
          recommendation: s.recommendation, effort: s.effort, location: s.location || '',
        })
      });
      if (res.ok) added++;
    } catch {}
  }
  toast(`${added} snag(s) added`, 'success');
  loadStats();
  loadSnags();
  switchTab('list');
}

// ────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────

function setSelectValue(id, value) {
  const sel = document.getElementById(id);
  for (const opt of sel.options) {
    if (opt.value.toLowerCase() === value.toLowerCase() || opt.textContent.toLowerCase() === value.toLowerCase()) {
      sel.value = opt.value; return;
    }
  }
  for (const opt of sel.options) {
    if (opt.value.toLowerCase().includes(value.toLowerCase()) || value.toLowerCase().includes(opt.value.toLowerCase())) {
      sel.value = opt.value; return;
    }
  }
}

function handlePhotoSelect(e) {
  selectedPhotos = Array.from(e.target.files);
  const container = document.getElementById('photoThumbnails');
  container.innerHTML = '';
  selectedPhotos.forEach(f => {
    const img = document.createElement('img');
    img.className = 'photo-thumb';
    img.src = URL.createObjectURL(f);
    container.appendChild(img);
  });
}

function exportCSV() { window.open(`/api/snags/export/csv?${getFilterParams()}`, '_blank'); }
function exportPDF() { window.open(`/api/snags/export/pdf?${getFilterParams()}`, '_blank'); }

function getFilterParams() {
  const params = new URLSearchParams();
  const status = document.getElementById('filterStatus').value;
  const priority = document.getElementById('filterPriority').value;
  const search = document.getElementById('searchBar').value;
  if (status) params.set('status', status);
  if (priority) params.set('priority', priority);
  if (search) params.set('search', search);
  return params.toString();
}

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// Helper: get auth headers for MimaarAI requests
function mimaraiHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (mimaraiToken) headers['X-Mimarai-Token'] = mimaraiToken;
  return headers;
}

// ────────────────────────────────────────────
// MimaarAI Authentication
// ────────────────────────────────────────────

let authMode = 'login'; // 'login' or 'register'

function updateAuthUI() {
  const btn = document.getElementById('mimaraiAuthBtn');
  if (mimaraiUser) {
    btn.textContent = mimaraiUser.name || mimaraiUser.email;
    btn.title = `Logged in as ${mimaraiUser.email}. Click to logout.`;
    btn.onclick = logoutMimarai;
  } else {
    btn.textContent = 'Login';
    btn.title = 'Sign in to MimaarAI for unlimited AI analysis';
    btn.onclick = showMimaraiAuth;
  }
}

function showMimaraiAuth() {
  authMode = 'login';
  document.getElementById('authNameGroup').style.display = 'none';
  document.getElementById('authSubmitBtn').textContent = 'Sign In';
  document.getElementById('authToggle').textContent = 'Create account';
  document.getElementById('authError').style.display = 'none';
  document.getElementById('mimaraiAuthModal').style.display = 'flex';
  document.getElementById('auth-email').focus();
}

function hideMimaraiAuth() {
  document.getElementById('mimaraiAuthModal').style.display = 'none';
}

function toggleAuthMode() {
  authMode = authMode === 'login' ? 'register' : 'login';
  document.getElementById('authNameGroup').style.display = authMode === 'register' ? 'block' : 'none';
  document.getElementById('authSubmitBtn').textContent = authMode === 'register' ? 'Create Account' : 'Sign In';
  document.getElementById('authToggle').textContent = authMode === 'register' ? 'Already have an account?' : 'Create account';
  document.getElementById('authError').style.display = 'none';
}

async function submitMimaraiAuth() {
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const rememberMe = document.getElementById('auth-remember').checked;
  const errEl = document.getElementById('authError');

  if (!email || !password) { errEl.textContent = 'Email and password required'; errEl.style.display = 'block'; return; }

  const btn = document.getElementById('authSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Connecting...';

  try {
    const body = authMode === 'register'
      ? { email, password, name: document.getElementById('auth-name').value.trim() || email.split('@')[0] }
      : { email, password, rememberMe };

    const res = await fetch(`/api/mimarai/${authMode === 'register' ? 'register' : 'login'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.message || data.error || 'Authentication failed';
      errEl.style.display = 'block';
      return;
    }

    // Save token and user
    mimaraiToken = data.token;
    mimaraiUser = data.user;
    localStorage.setItem('mimarai_token', data.token);
    localStorage.setItem('mimarai_user', JSON.stringify(data.user));

    hideMimaraiAuth();
    updateAuthUI();
    toast(`Signed in as ${data.user.name || data.user.email}`, 'success');
  } catch (e) {
    errEl.textContent = 'Cannot connect to MimaarAI';
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = authMode === 'register' ? 'Create Account' : 'Sign In';
  }
}

function logoutMimarai() {
  mimaraiToken = null;
  mimaraiUser = null;
  localStorage.removeItem('mimarai_token');
  localStorage.removeItem('mimarai_user');
  updateAuthUI();
  toast('Logged out from MimaarAI', 'success');
}

// ────────────────────────────────────────────
// Clipboard Paste (Ctrl+V screenshots)
// ────────────────────────────────────────────

function initPasteListener() {
  // Global paste listener
  document.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) {
          pastedImages.push(file);
          renderPastedThumbnails();
          switchTab('scan');
          toast('Screenshot pasted - analyzing...', 'success');
          // Auto-trigger AI scan after short delay for thumbnails to render
          setTimeout(() => aiScanPhotos(), 500);
        }
        return;
      }
    }
  });

  // Also handle paste zone click
  const pasteZone = document.getElementById('pasteZone');
  if (pasteZone) {
    pasteZone.addEventListener('dragover', (e) => { e.preventDefault(); pasteZone.classList.add('dragover'); });
    pasteZone.addEventListener('dragleave', () => pasteZone.classList.remove('dragover'));
    pasteZone.addEventListener('drop', (e) => {
      e.preventDefault();
      pasteZone.classList.remove('dragover');
      for (const file of e.dataTransfer.files) {
        if (file.type.startsWith('image/')) {
          pastedImages.push(file);
        }
      }
      renderPastedThumbnails();
    });
  }
}

function renderPastedThumbnails() {
  const container = document.getElementById('pastedThumbnails');
  container.innerHTML = '';
  pastedImages.forEach(f => {
    const img = document.createElement('img');
    img.className = 'photo-thumb';
    img.src = URL.createObjectURL(f);
    container.appendChild(img);
  });
}

// ────────────────────────────────────────────
// Capture + Analyze (screen capture API)
// ────────────────────────────────────────────

async function captureAndAnalyze() {
  try {
    // Use Screen Capture API to grab the screen
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { mediaSource: 'screen' },
      preferCurrentTab: true
    });

    const track = stream.getVideoTracks()[0];
    const imageCapture = new ImageCapture(track);
    const bitmap = await imageCapture.grabFrame();
    track.stop();

    // Convert to blob
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);

    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));
    const file = new File([blob], 'openspace-capture.jpg', { type: 'image/jpeg' });

    pastedImages = [file];
    renderPastedThumbnails();
    switchTab('scan');
    toast('Screen captured - analyzing...', 'success');

    // Auto-trigger scan
    aiScanPhotos();
  } catch (e) {
    if (e.name === 'NotAllowedError') {
      toast('Screen capture cancelled', 'error');
    } else {
      toast('Screen capture not supported - use Ctrl+V to paste a screenshot', 'error');
    }
  }
}
