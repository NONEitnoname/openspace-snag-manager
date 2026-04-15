const DEFAULT_OS_URL = 'https://ksa.openspace.ai/ohplayer?site=clQN_W4eSIqNUhIF-qCM-Q&bright=0&capture=MHmdrOblSVqiihnW5XEnww&pano=aoB9N6xnWayjdTuJkNW_iA&sheet=5l7yKKmdRF6P7pfoUQfgtQ&shadow=0&sharp=0&attitude=-0.7071%2C0%2C0%2C-0.7071&fov=1.33&pos=32.9045%2C-15.5963%2C1.6442';

let allSnags = [];
let totalSnags = 0;
let selectedPhotos = [];
let currentOsUrl = null;

// Init
document.addEventListener('DOMContentLoaded', () => {
  initViewer();
  loadStats();
  loadSnags();
  document.getElementById('f-photos').addEventListener('change', handlePhotoSelect);
  document.getElementById('f-scanphotos').addEventListener('change', handleScanPhotoSelect);
});

// ────────────────────────────────────────────
// OpenSpace Viewer
// ────────────────────────────────────────────

function initViewer() {
  const saved = localStorage.getItem('openspace_url');
  if (saved) {
    loadOpenSpaceUrl(saved);
  } else {
    showViewerWelcome();
  }
}

function osUrlToProxy(osUrl) {
  try {
    const u = new URL(osUrl);
    const host = u.host; // e.g. ksa.openspace.ai
    return `/proxy/os/${host}${u.pathname}${u.search}`;
  } catch { return null; }
}

function loadOpenSpaceUrl(url) {
  currentOsUrl = url;
  localStorage.setItem('openspace_url', url);
  const proxyUrl = osUrlToProxy(url);
  if (!proxyUrl) {
    toast('Invalid OpenSpace URL', 'error');
    return;
  }

  const frame = document.getElementById('viewerFrame');
  frame.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.src = proxyUrl;
  iframe.setAttribute('allow', 'fullscreen');
  frame.appendChild(iframe);

  // Update toolbar status
  updateOsStatus(true);

  // Fallback after 10s if iframe appears empty
  setTimeout(() => {
    try {
      const doc = iframe.contentDocument;
      if (doc && doc.body && doc.body.innerHTML.length < 50) showViewerFallback();
    } catch (e) {
      // Cross-origin means proxy worked and content loaded
      updateOsStatus(true);
    }
  }, 10000);
}

function showViewerWelcome() {
  const frame = document.getElementById('viewerFrame');
  frame.innerHTML = `
    <div class="viewer-fallback">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
      <h3 style="color:#fff;font-family:'Playfair Display',serif">Connect Your OpenSpace</h3>
      <p>Paste your OpenSpace share link to load the 360° viewer here.</p>
      <button onclick="showOsConnect()">Connect OpenSpace</button>
    </div>`;
  updateOsStatus(false);
}

function showViewerFallback() {
  const frame = document.getElementById('viewerFrame');
  frame.innerHTML = `
    <div class="viewer-fallback">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
      <p>OpenSpace blocked iframe embedding.<br>You can still use the viewer in a new tab.</p>
      <button onclick="openOriginal()">Open Viewer in New Tab</button>
      <button onclick="showOsConnect()" style="background:transparent;border:1px solid rgba(255,255,255,0.3);margin-top:4px">Try Different URL</button>
    </div>`;
  updateOsStatus(false);
}

function updateOsStatus(connected) {
  const btn = document.getElementById('osConnectBtn');
  if (connected) {
    btn.innerHTML = `<span class="os-status"><span class="os-status-dot"></span> Connected</span>`;
  } else {
    btn.innerHTML = 'Connect OpenSpace';
  }
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
  loadOpenSpaceUrl(url);
  toast('Loading OpenSpace viewer...', 'success');
}

function toggleViewerFull() {
  document.getElementById('mainLayout').classList.toggle('viewer-full');
}

function openOriginal() {
  window.open(currentOsUrl || DEFAULT_OS_URL, '_blank');
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

async function aiCategorize() {
  const desc = document.getElementById('f-description').value.trim();
  if (!desc) return toast('Enter a description first', 'error');

  const btn = document.getElementById('aiBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = 'Analyzing with MimaarAI...';

  try {
    const res = await fetch('/api/snags/ai-categorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: desc })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'AI failed');

    if (data.category) setSelectValue('f-category', data.category);
    if (data.priority) setSelectValue('f-priority', data.priority);
    if (data.trade) setSelectValue('f-trade', data.trade);
    if (data.rootCause) document.getElementById('f-rootcause').value = data.rootCause;
    if (data.recommendation) document.getElementById('f-recommendation').value = data.recommendation;
    if (data.effort) document.getElementById('f-effort').value = data.effort;

    toast(`Categorized by MimaarAI (${data.model || 'AI'})`, 'success');
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
  if (scanPhotos.length === 0) return toast('Upload site photos first', 'error');

  const btn = document.getElementById('aiScanBtn');
  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = 'MimaarAI scanning for defects...';
  const results = document.getElementById('scanResults');
  results.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Analyzing images...</p>';

  try {
    // Convert photos to base64
    const attachments = await Promise.all(scanPhotos.map(async (f) => {
      const buf = await f.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return { type: f.type, data: btoa(binary), name: f.name };
    }));

    const res = await fetch('/api/snags/ai-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attachments })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'AI scan failed');

    if (!data.snags || data.snags.length === 0) {
      results.innerHTML = '<p style="color:var(--low);font-size:13px;font-weight:600">No defects detected. Site looks good!</p>';
      toast('AI scan complete — no defects found', 'success');
      return;
    }

    // Render detected snags with accept buttons
    results.innerHTML = `<p style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${data.snags.length} potential snag(s) detected by MimaarAI (${data.model || 'AI'})</p>`;
    data.snags.forEach((s, i) => {
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

    // Store for accept action
    window._scanDetectedSnags = data.snags;
    toast(`${data.snags.length} snag(s) detected`, 'success');
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
