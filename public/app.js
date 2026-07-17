const state = { user: null, csrf: null, projects: [], selectedFiles: [], activeRun: null, poller: null, snags: [], snagsTotal: 0, snagView: 'board', drawerSnag: null, currentTab: 'dashboard', viewerReady: false, linkedViewerUrl: null, viewerLoadIsOurs: false, auditCursor: null };
const $ = id => document.getElementById(id);
const SNAG_STATUSES = ['Open', 'In Progress', 'Resolved', 'Closed'];
const STATUS_COLORS = { Open: '#7ec4bc', 'In Progress': '#3d9c92', Resolved: '#167a70', Closed: '#0b4f49' };
const PRIORITY_COLORS = { Critical: '#b42318', High: '#b54708', Medium: '#8a6a00', Low: '#067647' };
const FINDING_STATE_LABELS = { needs_review: 'Needs review', approved: 'Approved', rejected: 'Rejected', handed_off: 'Handed off' };
const FINDING_STATE_COLORS = { needs_review: '#8a6a00', approved: '#067647', rejected: '#b42318', handed_off: '#1d4ed8' };

function message(id, text = '', error = false) { const el = $(id); el.textContent = text; el.classList.toggle('error', error); }
function toast(text, error = false) { const el = $('toast'); el.textContent = text; el.classList.toggle('error', error); el.classList.add('show'); window.clearTimeout(toast.timer); toast.timer = window.setTimeout(() => el.classList.remove('show'), 3500); }
function currentProject() { return state.projects[0]?.id; }
function apiHeaders(extra = {}) { return { ...extra, ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}) }; }
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: apiHeaders(options.headers) });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || 'Request failed');
  return data;
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function svg(tag, attrs = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
function isOverdue(snag) { return snag.due_date && snag.due_date < new Date().toISOString().slice(0, 10) && ['Open', 'In Progress'].includes(snag.status); }
function isReviewer() { return ['reviewer', 'admin'].includes(state.user.role); }

/* ── Session ─────────────────────────────────────── */
function showApp() {
  $('authView').classList.add('hidden'); $('appView').classList.remove('hidden');
  $('tbProject').textContent = state.projects[0]?.name || '—';
  $('tbDate').textContent = new Date().toISOString().slice(0, 10);
  $('tbUser').textContent = `${state.user.email.split('@')[0]} · ${state.user.role}`;
  document.querySelectorAll('.admin-only').forEach(node => node.classList.toggle('hidden', state.user.role !== 'admin'));
  switchTab('dashboard');
  refreshReviewBadge();
}
function showAuth() {
  const token = new URLSearchParams(location.search).get('invite');
  $('loginForm').classList.toggle('hidden', Boolean(token));
  $('inviteForm').classList.toggle('hidden', !token);
  if (token) $('inviteForm').dataset.token = token;
}
async function hydrateSession() {
  try {
    const data = await api('/api/auth/me');
    state.user = data.user; state.csrf = data.csrfToken; state.projects = data.projects;
    showApp();
  } catch { showAuth(); }
}
async function login(event) {
  event.preventDefault(); message('authMessage');
  try {
    const data = await api('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('loginEmail').value, password: $('loginPassword').value }) });
    state.user = data.user; state.csrf = data.csrfToken; state.projects = (await api('/api/auth/me')).projects; showApp();
  } catch (error) { message('authMessage', error.message, true); }
}
async function acceptInvite(event) {
  event.preventDefault(); message('authMessage');
  try {
    const data = await api('/api/auth/accept-invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: event.currentTarget.dataset.token, password: $('invitePassword').value }) });
    history.replaceState({}, '', location.pathname); state.user = data.user; state.csrf = data.csrf ?? data.csrfToken; state.projects = (await api('/api/auth/me')).projects; showApp();
  } catch (error) { message('authMessage', error.message, true); }
}
async function logout() { try { await api('/api/auth/logout', { method: 'POST' }); } finally { location.reload(); } }

/* ── Tabs ────────────────────────────────────────── */
function switchTab(name) {
  state.currentTab = name;
  document.querySelectorAll('[role="tab"]').forEach(tab => {
    const active = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    if (active) $('tbSheet').textContent = tab.dataset.sheet || 'SM-01';
  });
  document.querySelectorAll('[role="tabpanel"]').forEach(panel => panel.classList.toggle('active', panel.id === `panel-${name}`));
  if (name === 'analyze') initViewer();
  if (name === 'dashboard') loadDashboard();
  if (name === 'review') loadFindings();
  if (name === 'snags') loadSnags();
  if (name === 'specs') loadSpecs();
  if (name === 'admin') loadAudit(true);
}
async function refreshReviewBadge() {
  try {
    const stats = await api(`/api/projects/${encodeURIComponent(currentProject())}/stats`);
    const pending = stats.findings.needs_review || 0;
    $('reviewCount').textContent = String(pending);
    $('reviewCount').classList.toggle('hidden', !pending);
    return stats;
  } catch { return null; }
}

/* ── Dashboard ───────────────────────────────────── */
async function loadDashboard() {
  const stats = await refreshReviewBadge();
  if (!stats) { toast('Could not load project statistics.', true); return; }
  renderKpis(stats);
  renderStatusDonut(stats.snags);
  renderPriorityBars(stats.snags.byPriority);
  renderTrend(stats.trend);
  renderTradeBars(stats.snags.byTrade);
  renderFindingsBar(stats.findings, stats.runsTotal);
}
function kpi(label, value, alert = false) {
  const card = el('div', `kpi${alert ? ' alert' : ''}`);
  card.append(el('div', 'kpi-value', String(value)), el('div', 'kpi-label', label));
  return card;
}
function renderKpis(stats) {
  const row = $('kpiRow'); row.replaceChildren();
  row.append(
    kpi('Open snags', stats.snags.byStatus.Open),
    kpi('In progress', stats.snags.byStatus['In Progress']),
    kpi('Overdue', stats.snags.overdue, stats.snags.overdue > 0),
    kpi('Awaiting review', stats.findings.needs_review, stats.findings.needs_review > 0),
    kpi('Resolved + closed', stats.snags.byStatus.Resolved + stats.snags.byStatus.Closed)
  );
}
function emptyChart(container, text) {
  container.replaceChildren(el('p', 'hint', text));
}
function renderStatusDonut(snags) {
  const container = $('chartStatus'); container.replaceChildren();
  const total = snags.total;
  if (!total) return emptyChart(container, 'No snags logged yet. The donut fills in as work is logged.');
  const wrap = el('div', 'donut-wrap');
  const size = 190, r = 70, cx = size / 2, cy = size / 2, stroke = 26;
  const chart = svg('svg', { viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': `Snags by status, ${total} total` });
  chart.style.maxWidth = '190px';
  let angle = -90;
  for (const status of SNAG_STATUSES) {
    const count = snags.byStatus[status];
    if (!count) continue;
    const sweep = (count / total) * 360;
    let mark;
    if (count === total) {
      /* A 360 degree arc starts and ends on the same point, and the SVG spec drops such a
         segment entirely. One status holding every snag is the normal opening state of a
         project, so draw the ring as a circle rather than an arc that renders as nothing. */
      mark = svg('circle', { cx, cy, r, fill: 'none', stroke: STATUS_COLORS[status], 'stroke-width': stroke });
    } else {
      const pad = 2.2; /* 2px-equivalent gap between slices */
      const a0 = (angle + pad / 2) * Math.PI / 180, a1 = (angle + sweep - pad / 2) * Math.PI / 180;
      const large = sweep - pad > 180 ? 1 : 0;
      const d = `M ${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)}`;
      mark = svg('path', { d, fill: 'none', stroke: STATUS_COLORS[status], 'stroke-width': stroke, 'stroke-linecap': 'butt' });
    }
    const title = svg('title'); title.textContent = `${status}: ${count}`; mark.appendChild(title);
    chart.appendChild(mark);
    angle += sweep;
  }
  const value = svg('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', class: 'donut-center-value' }); value.textContent = String(total);
  const label = svg('text', { x: cx, y: cy + 18, 'text-anchor': 'middle', class: 'donut-center-label' }); label.textContent = 'snags';
  chart.append(value, label);
  const legend = el('div', 'legend');
  for (const status of SNAG_STATUSES) {
    const item = el('span'); const dot = el('i'); dot.style.background = STATUS_COLORS[status];
    item.append(dot, document.createTextNode(`${status} · ${snags.byStatus[status]}`)); legend.appendChild(item);
  }
  wrap.append(chart, legend); container.appendChild(wrap);
}
function horizontalBars(container, rows, colorFor, ariaLabel) {
  container.replaceChildren();
  if (!rows.length || rows.every(row => !row.count)) return emptyChart(container, 'Nothing to chart yet.');
  const max = Math.max(...rows.map(row => row.count), 1);
  const rowH = 34, labelW = 110, valueW = 40, width = 460;
  const chart = svg('svg', { viewBox: `0 0 ${width} ${rows.length * rowH}`, role: 'img', 'aria-label': ariaLabel });
  rows.forEach((row, index) => {
    const y = index * rowH;
    const barW = Math.max(((width - labelW - valueW) * row.count) / max, row.count ? 3 : 0);
    const label = svg('text', { x: labelW - 10, y: y + 21, 'text-anchor': 'end', class: 'bar-label' }); label.textContent = row.label;
    const bar = svg('rect', { x: labelW, y: y + 8, width: barW, height: 18, rx: 4, fill: colorFor(row) });
    const title = svg('title'); title.textContent = `${row.label}: ${row.count}`; bar.appendChild(title);
    const value = svg('text', { x: labelW + barW + 8, y: y + 21, class: 'bar-value' }); value.textContent = String(row.count);
    chart.append(label, bar, value);
  });
  container.appendChild(chart);
}
function renderPriorityBars(byPriority) {
  horizontalBars($('chartPriority'), Object.keys(PRIORITY_COLORS).map(p => ({ label: p, count: byPriority[p] || 0 })), row => PRIORITY_COLORS[row.label], 'Snags by priority');
}
function renderTradeBars(byTrade) {
  horizontalBars($('chartTrade'), byTrade.map(t => ({ label: t.trade, count: t.count })), () => '#0999a8', 'Snags by trade');
}
function renderFindingsBar(findings, runsTotal) {
  const rows = Object.keys(FINDING_STATE_LABELS).map(key => ({ label: FINDING_STATE_LABELS[key], count: findings[key] || 0, key }));
  const container = $('chartFindings');
  horizontalBars(container, rows, row => FINDING_STATE_COLORS[row.key], 'AI findings by review state');
  container.appendChild(el('p', 'hint', `${runsTotal} analysis run(s) to date. Every AI finding requires a human decision before it becomes work.`));
}
function renderTrend(days) {
  const container = $('chartTrend'); container.replaceChildren();
  const rawMax = Math.max(...days.map(d => Math.max(d.created, d.resolved)), 1);
  const max = rawMax % 2 ? rawMax + 1 : rawMax; /* even top so the midpoint tick is an integer */
  const width = 940, height = 210, padL = 34, padB = 26, padT = 12, plotW = width - padL - 12, plotH = height - padT - padB;
  const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Snags logged versus closed out per day, last 14 days' });
  for (let tick = 0; tick <= 2; tick += 1) {
    const value = (max * tick) / 2;
    const y = padT + plotH - (plotH * tick) / 2;
    chart.appendChild(svg('line', { x1: padL, y1: y, x2: padL + plotW, y2: y, stroke: '#e4ebe9', 'stroke-width': 1 }));
    const text = svg('text', { x: padL - 6, y: y + 4, 'text-anchor': 'end', class: 'axis-text' }); text.textContent = String(value);
    chart.appendChild(text);
  }
  const x = index => padL + (plotW * index) / (days.length - 1);
  const y = value => padT + plotH - (plotH * value) / max;
  const series = [{ key: 'created', color: '#d9480f', label: 'Logged' }, { key: 'resolved', color: '#0999a8', label: 'Closed out' }];
  for (const s of series) {
    const d = days.map((day, index) => `${index ? 'L' : 'M'} ${x(index)} ${y(day[s.key])}`).join(' ');
    chart.appendChild(svg('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    days.forEach((day, index) => {
      if (!day[s.key]) return;
      const dot = svg('circle', { cx: x(index), cy: y(day[s.key]), r: 3.5, fill: s.color, stroke: '#fff', 'stroke-width': 2 });
      const title = svg('title'); title.textContent = `${day.day} — ${s.label}: ${day[s.key]}`; dot.appendChild(title);
      chart.appendChild(dot);
    });
  }
  days.forEach((day, index) => {
    if (index % 2) return;
    const text = svg('text', { x: x(index), y: height - 6, 'text-anchor': 'middle', class: 'axis-text' }); text.textContent = day.day.slice(5);
    chart.appendChild(text);
  });
  container.appendChild(chart);
  const legend = el('div', 'legend');
  for (const s of series) { const item = el('span'); const dot = el('i'); dot.style.background = s.color; item.append(dot, document.createTextNode(s.label)); legend.appendChild(item); }
  container.appendChild(legend);
}

/* ── Capture & analyze ───────────────────────────── */
/* OpenSpace is regional. Default to KSA for this pilot, but once someone loads a capture
   remember its origin, so their sign-in lands on the region they actually work in. */
const OPENSPACE_DEFAULT_ORIGIN = 'https://ksa.openspace.ai';
function readStored(key) { try { return localStorage.getItem(key); } catch { return null; } }
function writeStored(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } }
function clearStored(key) { try { localStorage.removeItem(key); } catch { /* private mode */ } }
function openspaceOrigin() {
  const saved = readStored('openspace_origin');
  return saved && /^https:\/\/([a-z0-9-]+\.)*openspace\.ai$/.test(saved) ? saved : OPENSPACE_DEFAULT_ORIGIN;
}
function parseOpenspaceUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || !(parsed.hostname === 'openspace.ai' || parsed.hostname.endsWith('.openspace.ai'))) {
    throw new Error('Use an HTTPS openspace.ai share link.');
  }
  return parsed;
}
/* The share link is a claim about where an image was taken, so it must not outlive the
   viewer moving somewhere else. A cross-origin frame's URL is unreadable, but we do know
   what we navigated it to, and its load event tells us when it navigates again. */
function setViewerSrc(url, linked) {
  state.viewerLoadIsOurs = true;
  state.linkedViewerUrl = linked ? url : null;
  $('openspaceViewer').src = url;
  updateViewerStatus();
}
function onViewerLoad() {
  if (state.viewerLoadIsOurs) { state.viewerLoadIsOurs = false; return; }
  /* The viewer navigated on its own — whatever link is in the box no longer describes
     what is on screen. Prefer asking again over attributing evidence to the wrong spot. */
  state.linkedViewerUrl = null;
  updateViewerStatus();
}
/* Says only what can actually be observed: whether the frame is showing the capture whose
   link is in the box. Whether the user is signed in to OpenSpace is not knowable here. */
/* Reports our own bookkeeping — that the link in the box is what we last pointed the frame
   at — and not that OpenSpace served it. The frame is cross-origin, so a redirect to its
   login page, an expired link, or an empty capture are all invisible from here. */
function updateViewerStatus() {
  const linked = contextMatchesViewer();
  $('viewerStatus').textContent = linked ? 'Linked to capture' : 'Not linked';
  $('viewerStatus').classList.toggle('live', linked);
}
function contextMatchesViewer() {
  return Boolean(state.linkedViewerUrl) && state.linkedViewerUrl === $('openspaceUrl').value.trim();
}
function captureContextIsSound() {
  return Boolean($('unlinkedReason').value.trim()) || contextMatchesViewer();
}
/* Signed out, OpenSpace redirects this to its login page; signed in, to the user's orgs. */
function loadOpenspaceHome() {
  setViewerSrc(`${openspaceOrigin()}/`, false);
}
function initViewer() {
  if (state.viewerReady) return;
  state.viewerReady = true;
  $('openHome').href = `${openspaceOrigin()}/`;
  const saved = readStored('openspace_url');
  if (saved) { $('openspaceUrl').value = saved; previewViewer({ silent: true }); }
  else loadOpenspaceHome();
}
function validateContext() {
  const url = $('openspaceUrl').value.trim(); const reason = $('unlinkedReason').value.trim();
  if (!url && !reason) throw new Error('Attach an OpenSpace link or explain why the photos are unlinked.');
  return { url, reason };
}
function previewViewer({ silent = false } = {}) {
  try {
    const url = $('openspaceUrl').value.trim();
    if (!url) throw new Error('Paste an OpenSpace share link to load the viewer.');
    const parsed = parseOpenspaceUrl(url);
    $('openspaceUrl').value = parsed.toString();
    setViewerSrc(parsed.toString(), true);
    $('openCapture').href = parsed.toString(); $('openCapture').classList.remove('hidden');
    writeStored('openspace_url', parsed.toString());
    writeStored('openspace_origin', parsed.origin);
    $('openHome').href = `${parsed.origin}/`;
  } catch (error) {
    if (silent) {
      /* A stored link that no longer parses must not sit in the box looking like context. */
      $('openspaceUrl').value = '';
      clearStored('openspace_url');
      loadOpenspaceHome();
      return;
    }
    toast(error.message, true);
  }
}

/* Capture the live viewer. A cross-origin OpenSpace frame cannot be read from canvas,
   so the browser's own Screen Capture API composites it and the user grants each frame. */
async function grabTabFrame(stream) {
  const track = stream.getVideoTracks()[0];
  try {
    /* The video element — not ImageCapture, which Chromium gates behind the camera
       permission policy this app disables. */
    const video = document.createElement('video');
    video.srcObject = stream; video.muted = true; video.playsInline = true;
    await video.play();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const bitmap = await createImageBitmap(video);
    video.pause(); video.srcObject = null;
    return { bitmap, surface: track.getSettings().displaySurface };
  } finally { track.stop(); }
}
/* Pure geometry, split out so it can be tested without a browser (the DOM/canvas parts
   around it cannot). Maps the viewer's on-screen rect into the captured frame's pixels,
   clamps to the frame, and rejects a crop too small to be a real capture. */
function computeCropRect(rect, viewport, frame) {
  const scaleX = frame.width / viewport.width;
  const scaleY = frame.height / viewport.height;
  const x = Math.max(0, Math.round(rect.left * scaleX));
  const y = Math.max(0, Math.round(rect.top * scaleY));
  const width = Math.min(frame.width - x, Math.round(rect.width * scaleX));
  const height = Math.min(frame.height - y, Math.round(rect.height * scaleY));
  if (width < 40 || height < 40) return null;
  return { x, y, width, height };
}
if (typeof module !== 'undefined' && module.exports) module.exports = { computeCropRect };
function cropToViewer(bitmap) {
  return computeCropRect(
    $('viewerWrap').getBoundingClientRect(),
    { width: window.innerWidth, height: window.innerHeight },
    { width: bitmap.width, height: bitmap.height }
  );
}
async function captureViewer() {
  if (!navigator.mediaDevices?.getDisplayMedia) { toast('This browser cannot capture the view. Screenshot the viewer and paste it with Ctrl+V.', true); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'browser' }, preferCurrentTab: true, audio: false });
  } catch (error) {
    toast(error.name === 'NotAllowedError' ? 'Capture cancelled.' : 'Capture is unavailable. Screenshot the viewer and paste it with Ctrl+V.', true);
    return;
  }
  try {
    const { bitmap, surface } = await grabTabFrame(stream);
    const crop = surface === 'browser' ? cropToViewer(bitmap) : null;
    const canvas = document.createElement('canvas');
    canvas.width = crop ? crop.width : bitmap.width;
    canvas.height = crop ? crop.height : bitmap.height;
    const context = canvas.getContext('2d');
    if (crop) context.drawImage(bitmap, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    else context.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) throw new Error('The captured frame could not be encoded.');
    /* Everything said about this capture belongs inside the callback: if the frame did not
       make it into the tray, stageFiles has already said why, and a note about how the
       capture looks would only talk over it. */
    stageFiles([new File([blob], `openspace-view-${new Date().toISOString().replace(/[:.]/g, '-')}.jpg`, { type: 'image/jpeg' })], () => {
      /* What the image shows and where it was taken are separate problems, and both can
         be wrong at once — say every note that applies rather than only the first. */
      const notes = [];
      if (surface !== 'browser') notes.push('It shows the whole screen or window you chose to share, not just the viewer, so it may show more than the site — check the thumbnail');
      else if (!crop) notes.push('The viewer was too small or scrolled out of view to crop to, so the whole tab is staged — check the thumbnail');
      const contextMissing = !captureContextIsSound();
      /* The viewer is a full OpenSpace session, so people navigate away from the link they
         loaded. Cross-origin we cannot read where they ended up — ask now, while they are
         still standing on the spot, rather than record the wrong location. */
      if (contextMissing) notes.push('Paste the share link for the capture you are on so the finding can be traced back to this spot, or say why it is unlinked');
      if (notes.length) toast(`Captured. ${notes.join('. ')}.`, true);
      else toast('Viewer captured and staged. Tick consent, then send it to MimaarAI.');
      if (contextMissing) $('openspaceUrl').focus();
    });
  } catch (error) { toast(error.message || 'The view could not be captured.', true); }
}
const MAX_STAGED = 5;
/* Owns every message about what did and did not get staged. Callers must not announce
   success themselves — a success toast fired after this returns overwrites the warning
   and tells the inspector their evidence is staged when it was dropped. Pass what you
   want said on the happy path instead; it runs only when every file landed. */
function stageFiles(files, onAllStaged) {
  const valid = files.filter(file => ['image/jpeg', 'image/png', 'image/webp'].includes(file.type) && file.size <= 8 * 1024 * 1024);
  const room = Math.max(0, MAX_STAGED - state.selectedFiles.length);
  const accepted = valid.slice(0, room);
  const problems = [];
  if (valid.length !== files.length) problems.push(`${files.length - valid.length} file(s) are not JPEG, PNG, or WebP under 8 MB`);
  if (valid.length !== accepted.length) problems.push(`${valid.length - accepted.length} image(s) exceed the ${MAX_STAGED}-image limit for one run`);
  if (accepted.length) { state.selectedFiles = [...state.selectedFiles, ...accepted]; renderFilePreviews(); }
  if (problems.length) toast(`Not staged: ${problems.join(', and ')}.`, true);
  else onAllStaged?.();
  return accepted.length;
}
function handlePaste(event) {
  if (state.currentTab !== 'analyze') return;
  const files = Array.from(event.clipboardData?.items || []).filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
  if (!files.length) return;
  event.preventDefault();
  stageFiles(files, () => toast('Screenshot staged from the clipboard.'));
}
/* One object URL per File, revoked when the file leaves the tray — re-rendering the tray
   must not mint a second URL for an image that is already showing. */
const previewUrls = new WeakMap();
function previewUrl(file) {
  if (!previewUrls.has(file)) previewUrls.set(file, URL.createObjectURL(file));
  return previewUrls.get(file);
}
function releasePreviewUrl(file) {
  const url = previewUrls.get(file);
  if (url) { URL.revokeObjectURL(url); previewUrls.delete(file); }
}
function renderFilePreviews() {
  const container = $('imagePreviews'); container.replaceChildren();
  state.selectedFiles.forEach((file, index) => {
    const card = el('div', 'preview');
    const image = el('img'); image.src = previewUrl(file); image.alt = `Selected evidence: ${file.name}`;
    const text = el('span', null, `${file.name} · ${Math.ceil(file.size / 1024)} KB`);
    const remove = el('button', 'quiet', 'Remove'); remove.type = 'button';
    remove.addEventListener('click', () => { releasePreviewUrl(file); state.selectedFiles.splice(index, 1); renderFilePreviews(); });
    card.append(image, text, remove); container.appendChild(card);
  });
}
function chooseFiles(event) {
  const incoming = Array.from(event.target.files || []);
  event.target.value = '';
  stageFiles(incoming);
}
async function startAnalysis() {
  message('analysisMessage');
  try {
    const { url, reason } = validateContext();
    if (!state.selectedFiles.length) throw new Error('Choose at least one supported image.');
    if (!$('analysisConsent').checked) throw new Error('Confirm the MimaarAI data-processing disclosure first.');
    const form = new FormData();
    form.set('projectId', currentProject()); form.set('openspaceUrl', url); form.set('unlinkedReason', reason); form.set('consentAccepted', 'true');
    state.selectedFiles.forEach(file => form.append('images', file));
    const data = await api('/api/analysis-runs', { method: 'POST', body: form });
    state.activeRun = data.runId;
    $('runStatus').classList.remove('hidden');
    message('analysisMessage', 'Images staged. The pipeline below tracks each file.');
    await loadRun();
  } catch (error) { message('analysisMessage', error.message, true); }
}
function renderRun(run) {
  const container = $('runItems'); container.replaceChildren();
  for (const asset of run.assets) {
    const item = el('div', `run-item ${asset.state}`);
    const head = el('div', 'run-item-head');
    head.append(el('strong', null, asset.original_name), el('span', 'run-state', asset.state.replace(/_/g, ' ')));
    const rail = el('div', 'progress-rail');
    const fill = el('div', 'progress-fill');
    /* Only ever draw progress the provider actually reported. A nominal 5% invented a
       number, and filling the rail on failure drew a finished job. */
    fill.style.width = `${asset.state === 'completed' ? 100 : Number(asset.progress) || 0}%`;
    rail.appendChild(fill);
    const msg = el('p', 'progress-msg', asset.state === 'failed' ? (asset.upstream_error || 'Analysis failed.') : asset.state === 'completed' ? 'Analysis complete.' : asset.progress_message || (asset.state === 'queued' ? 'Waiting for a pipeline slot…' : 'Contacting MimaarAI…'));
    item.append(head, rail, msg);
    container.appendChild(item);
  }
  const done = ['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(run.state);
  $('cancelRun').classList.toggle('hidden', done);
  if (done) {
    window.clearTimeout(state.poller);
    /* "No findings" and "we could not look" are different answers, and only one of them
       means the images are clean. Never let a failed run read as a clean bill of health. */
    const failed = run.assets.filter(asset => asset.state === 'failed').length;
    const analysed = run.assets.filter(asset => asset.state === 'completed').length;
    if (run.findings.length) {
      $('runSummary').textContent = `${run.findings.length} draft finding(s) are waiting in the review queue. Nothing becomes a snag without a human decision.`
        + (failed ? ` ${failed} image(s) could not be analysed — those are not covered.` : '');
      refreshReviewBadge();
      toast(`${run.findings.length} draft finding(s) ready for review.`);
    } else if (failed) {
      $('runSummary').textContent = `No findings, because ${failed} image(s) could not be analysed — see the reason on each above. This is not a clean result: those images were never checked.`;
    } else if (run.state === 'cancelled') {
      $('runSummary').textContent = 'Run cancelled. Any image still queued was never sent.';
    } else {
      $('runSummary').textContent = `MimaarAI analysed ${analysed} image(s) and reported nothing. That is its opinion, not an inspection sign-off.`;
    }
  } else { $('runSummary').textContent = ''; }
}
async function loadRun() {
  if (!state.activeRun) return;
  try {
    const run = await api(`/api/analysis-runs/${encodeURIComponent(state.activeRun)}`);
    renderRun(run);
    if (!['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(run.state)) state.poller = window.setTimeout(loadRun, 1500);
  } catch (error) { message('analysisMessage', error.message, true); }
}
async function cancelRun() {
  if (!state.activeRun) return;
  try { await api(`/api/analysis-runs/${encodeURIComponent(state.activeRun)}/cancel`, { method: 'POST' }); toast('Queued images cancelled.'); await loadRun(); }
  catch (error) { toast(error.message, true); }
}

/* ── Review queue ────────────────────────────────── */
function findingCard(finding) {
  const card = el('article', 'finding card');
  const evidence = el('div', 'finding-evidence');
  const image = el('img'); image.src = `/api/assets/${encodeURIComponent(finding.asset_id)}/content`; image.alt = `Evidence photo for: ${finding.title}`; image.loading = 'lazy';
  const openEvidence = el('a', 'quiet-link', 'Open full size'); openEvidence.href = image.src; openEvidence.target = '_blank'; openEvidence.rel = 'noopener';
  evidence.append(image, openEvidence);
  if (finding.openspace_url) { const capture = el('a', 'quiet-link', 'Open capture'); capture.href = finding.openspace_url; capture.target = '_blank'; capture.rel = 'noopener'; evidence.appendChild(capture); }

  const body = el('div', 'finding-body');
  const heading = el('div', 'finding-heading');
  const titleWrap = el('div');
  titleWrap.append(el('h3', null, finding.title), el('span', `state-chip ${finding.state}`, FINDING_STATE_LABELS[finding.state] || finding.state));
  /* An absent severity is not a Medium one: say the model did not rate it and let the
     reviewer decide, rather than paint a default that looks like a judgement. */
  heading.append(titleWrap, el('span', `badge ${finding.priority || 'Unrated'}`, finding.priority || 'Unrated'));
  const description = el('p', null, finding.description || 'No description returned.');
  const meta = el('p', 'muted', [finding.category || 'Uncategorised', finding.trade || 'No trade', finding.original_name,
    /* The model's own number, not a calibrated score — say whose it is. */
    finding.confidence != null ? `model-reported confidence ${(finding.confidence * 100).toFixed(0)}%` : null].filter(Boolean).join(' · '));
  body.append(heading, description, meta);
  if (finding.recommendation) body.appendChild(el('p', 'hint', `Recommendation: ${finding.recommendation}`));
  const claims = Array.isArray(finding.code_claims) ? finding.code_claims : [];
  if (claims.length) body.appendChild(el('p', 'warning', `Unverified code suggestion — confirm before citing: ${claims.join('; ')}`));

  const actions = el('div', 'finding-actions');
  if (finding.state === 'needs_review' && isReviewer()) {
    const approve = el('button', 'primary', 'Approve'); approve.addEventListener('click', () => decide(finding.id, 'approve'));
    const reject = el('button', null, 'Reject'); reject.addEventListener('click', () => decide(finding.id, 'reject'));
    actions.append(approve, reject);
  }
  if (finding.state === 'approved' && isReviewer()) {
    const promote = el('button', 'primary', 'Create snag from finding'); promote.addEventListener('click', () => promoteFinding(finding.id));
    actions.appendChild(promote);
    const input = el('input'); input.type = 'url'; input.placeholder = 'Paste resulting OpenSpace Field Note link'; input.setAttribute('aria-label', 'OpenSpace Field Note link');
    const handoff = el('button', null, 'Mark handed off'); handoff.addEventListener('click', () => handoffFinding(finding.id, input.value));
    actions.append(input, handoff);
  }
  if (finding.openspace_field_note_url) { const note = el('a', 'quiet-link', 'Open handed-off Field Note'); note.href = finding.openspace_field_note_url; note.target = '_blank'; note.rel = 'noopener'; actions.appendChild(note); }
  if (actions.childElementCount) body.appendChild(actions);
  card.append(evidence, body);
  return card;
}
async function loadFindings() {
  const list = $('findingList'); list.replaceChildren();
  try {
    const query = new URLSearchParams({ projectId: currentProject(), limit: '100' });
    if ($('findingState').value) query.set('state', $('findingState').value);
    const data = await api(`/api/findings?${query}`);
    if (!data.items.length) {
      const empty = el('p', 'empty');
      empty.append(el('strong', null, 'Nothing waiting here.'), document.createTextNode('Run an analysis from Capture & analyze and its draft findings will queue up for review.'));
      list.appendChild(empty); return;
    }
    /* The tab badge counts every waiting finding, so a silently sliced list would leave
       the difference unreviewed with the UI insisting this is the queue. */
    if (data.total > data.items.length) {
      list.appendChild(el('p', 'warning', `Showing the ${data.items.length} most recent of ${data.total}. Decide on these and the rest will follow.`));
    }
    data.items.forEach(item => list.appendChild(findingCard(item)));
  } catch (error) { toast(error.message, true); }
}
async function decide(id, decision) {
  const note = decision === 'reject' ? window.prompt('Why is this finding rejected?') : '';
  if (decision === 'reject' && !note) return;
  try {
    await api(`/api/findings/${encodeURIComponent(id)}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, note }) });
    toast(decision === 'approve' ? 'Finding approved.' : 'Finding rejected.');
    refreshReviewBadge(); loadFindings();
  } catch (error) { toast(error.message, true); }
}
async function promoteFinding(id) {
  try {
    const snag = await api(`/api/findings/${encodeURIComponent(id)}/promote`, { method: 'POST' });
    toast(`Snag ${snag.human_ref} created from this finding.`);
    loadFindings();
  } catch (error) { toast(error.message, true); }
}
async function handoffFinding(id, openspaceFieldNoteUrl) {
  try {
    await api(`/api/findings/${encodeURIComponent(id)}/handoff`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ openspaceFieldNoteUrl }) });
    toast('Handoff link recorded. OpenSpace remains the system of record.');
    loadFindings();
  } catch (error) { toast(error.message, true); }
}

/* ── Snags ───────────────────────────────────────── */
function snagQuery() {
  const query = new URLSearchParams({ projectId: currentProject() });
  if ($('snagSearch').value.trim()) query.set('search', $('snagSearch').value.trim());
  if ($('snagPriority').value) query.set('priority', $('snagPriority').value);
  query.set('sort', $('snagSort').value);
  return query;
}
async function loadSnags() {
  try {
    const data = await api(`/api/snags?${snagQuery()}`);
    state.snags = data.items;
    state.snagsTotal = data.total;
    $('exportCsv').href = `/api/snags/export/csv?${snagQuery()}`;
    $('exportPdf').href = `/api/snags/export/pdf?${snagQuery()}`;
    renderSnags();
  } catch (error) { toast(error.message, true); }
}
function renderSnags() {
  if (state.snagView === 'board') renderBoard(); else renderList();
  $('snagBoard').classList.toggle('hidden', state.snagView !== 'board');
  $('snagList').classList.toggle('hidden', state.snagView !== 'list');
  /* Column counts and the dashboard tiles are counting different things the moment this
     view is capped, so say when it is rather than let them quietly disagree. */
  const truncated = state.snagsTotal > state.snags.length;
  $('snagTruncated').textContent = truncated ? `Showing ${state.snags.length} of ${state.snagsTotal} matching snags — narrow the filters, or use the exports for the full register.` : '';
  $('snagTruncated').classList.toggle('hidden', !truncated);
}
function snagCardNode(snag) {
  const card = el('article', 'snag-card');
  card.draggable = true; card.dataset.id = snag.id; card.tabIndex = 0;
  card.setAttribute('role', 'button'); card.setAttribute('aria-label', `${snag.human_ref}: ${snag.title}`);
  const top = el('div', 'snag-card-top');
  top.append(el('span', 'ref-tag', snag.human_ref), el('span', `badge ${snag.priority}`, snag.priority));
  const meta = el('div', 'snag-card-meta');
  for (const bit of [snag.trade, [snag.location, snag.floor, snag.zone].filter(Boolean).join(' / '), snag.assignee].filter(Boolean)) meta.appendChild(el('span', null, bit));
  if (snag.due_date) meta.appendChild(el('span', isOverdue(snag) ? 'overdue' : null, isOverdue(snag) ? `OVERDUE ${snag.due_date}` : `Due ${snag.due_date}`));
  card.append(top, el('div', 'snag-card-title', snag.title), meta);
  if (snag.source_finding_id) card.appendChild(el('span', 'snag-ai-chip', 'FROM AI FINDING · HUMAN APPROVED'));
  card.addEventListener('click', () => openDrawer(snag));
  card.addEventListener('keydown', event => { if (event.key === 'Enter') openDrawer(snag); });
  card.addEventListener('dragstart', event => { event.dataTransfer.setData('text/plain', snag.id); card.classList.add('dragging'); });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  return card;
}
function renderBoard() {
  const board = $('snagBoard'); board.replaceChildren();
  for (const status of SNAG_STATUSES) {
    const column = el('div', 'board-col');
    column.style.setProperty('--col', STATUS_COLORS[status]);
    column.dataset.status = status;
    const snags = state.snags.filter(s => s.status === status);
    const head = el('div', 'board-col-head');
    head.append(el('h3', null, status), el('span', 'board-col-count', String(snags.length)));
    column.appendChild(head);
    snags.forEach(snag => column.appendChild(snagCardNode(snag)));
    if (!snags.length) column.appendChild(el('p', 'hint', status === 'Open' ? 'No open snags. Log one or promote an approved finding.' : '—'));
    column.addEventListener('dragover', event => { event.preventDefault(); column.classList.add('drag-over'); });
    column.addEventListener('dragleave', () => column.classList.remove('drag-over'));
    column.addEventListener('drop', async event => {
      event.preventDefault(); column.classList.remove('drag-over');
      const snagId = event.dataTransfer.getData('text/plain');
      const snag = state.snags.find(s => s.id === snagId);
      if (!snag || snag.status === status) return;
      try {
        await api(`/api/snags/${encodeURIComponent(snagId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: snag.version, status }) });
        toast(`${snag.human_ref} moved to ${status}.`);
      } catch (error) { toast(error.message, true); }
      loadSnags();
    });
    board.appendChild(column);
  }
}
function renderList() {
  const wrap = $('snagList'); wrap.replaceChildren();
  if (!state.snags.length) {
    const empty = el('p', 'empty');
    empty.append(el('strong', null, 'The register is empty.'), document.createTextNode('Log the first snag with “+ New snag”, or promote an approved AI finding.'));
    wrap.appendChild(empty); return;
  }
  const table = el('table', 'snag-table');
  const head = el('thead'); const headRow = el('tr');
  for (const column of ['Ref', 'Title', 'Status', 'Priority', 'Trade', 'Location', 'Assignee', 'Due']) headRow.appendChild(el('th', null, column));
  head.appendChild(headRow); table.appendChild(head);
  const body = el('tbody');
  for (const snag of state.snags) {
    const row = el('tr');
    const refCell = el('td'); refCell.appendChild(el('span', 'ref-tag', snag.human_ref));
    const dueCell = el('td', isOverdue(snag) ? 'overdue' : null, snag.due_date || '—');
    if (isOverdue(snag)) dueCell.style.color = 'var(--signal)';
    row.append(refCell, el('td', null, snag.title), el('td', null, snag.status), el('td', null, snag.priority), el('td', null, snag.trade || '—'), el('td', null, [snag.location, snag.floor, snag.zone].filter(Boolean).join(' / ') || '—'), el('td', null, snag.assignee || '—'), dueCell);
    row.addEventListener('click', () => openDrawer(snag));
    body.appendChild(row);
  }
  table.appendChild(body); wrap.appendChild(table);
}

/* ── Snag drawer ─────────────────────────────────── */
function openDrawer(snag = null) {
  state.drawerSnag = snag;
  message('drawerMessage');
  $('drawerTitle').textContent = snag ? snag.title : 'New snag';
  $('drawerRef').textContent = snag ? snag.human_ref : '';
  $('drawerRef').classList.toggle('hidden', !snag);
  $('drawerSave').textContent = snag ? 'Save changes' : 'Create snag';
  $('drawerDelete').classList.toggle('hidden', !(snag && state.user.role === 'admin'));
  $('drawerPhotos').classList.toggle('hidden', !snag);
  $('s-title').value = snag?.title || '';
  $('s-description').value = snag?.description || '';
  $('s-status').value = snag?.status || 'Open';
  $('s-priority').value = snag?.priority || 'Medium';
  $('s-category').value = snag?.category || '';
  $('s-trade').value = snag?.trade || '';
  $('s-location').value = snag?.location || '';
  $('s-floor').value = snag?.floor || '';
  $('s-zone').value = snag?.zone || '';
  $('s-assignee').value = snag?.assignee || '';
  $('s-due').value = snag?.due_date || '';
  $('s-root').value = snag?.root_cause || '';
  $('s-reco').value = snag?.recommendation || '';
  if (snag) renderPhotoStrip(snag);
  $('snagDrawer').classList.remove('hidden');
  $('drawerScrim').classList.remove('hidden');
  $('s-title').focus();
}
function closeDrawer() { $('snagDrawer').classList.add('hidden'); $('drawerScrim').classList.add('hidden'); state.drawerSnag = null; }
function renderPhotoStrip(snag) {
  const strip = $('photoStrip'); strip.replaceChildren();
  for (const key of snag.photos || []) {
    const image = el('img'); image.src = `/api/snags/${encodeURIComponent(snag.id)}/photos/${encodeURIComponent(key)}`; image.alt = `Photo attached to ${snag.human_ref}`; image.loading = 'lazy';
    strip.appendChild(image);
  }
  if (!(snag.photos || []).length) strip.appendChild(el('p', 'hint', 'No photos attached yet.'));
}
function drawerPayload() {
  return {
    title: $('s-title').value, description: $('s-description').value, status: $('s-status').value, priority: $('s-priority').value,
    category: $('s-category').value, trade: $('s-trade').value, location: $('s-location').value, floor: $('s-floor').value,
    zone: $('s-zone').value, assignee: $('s-assignee').value, due_date: $('s-due').value, root_cause: $('s-root').value, recommendation: $('s-reco').value
  };
}
async function saveSnag(event) {
  event.preventDefault(); message('drawerMessage');
  try {
    if (state.drawerSnag) {
      await api(`/api/snags/${encodeURIComponent(state.drawerSnag.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...drawerPayload(), version: state.drawerSnag.version }) });
      toast(`${state.drawerSnag.human_ref} saved.`);
    } else {
      const snag = await api('/api/snags', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...drawerPayload(), projectId: currentProject() }) });
      toast(`Snag ${snag.human_ref} created.`);
    }
    closeDrawer(); loadSnags();
  } catch (error) { message('drawerMessage', error.message, true); }
}
async function deleteSnag() {
  if (!state.drawerSnag) return;
  if (!window.confirm(`Delete ${state.drawerSnag.human_ref}? This cannot be undone.`)) return;
  try {
    await api(`/api/snags/${encodeURIComponent(state.drawerSnag.id)}`, { method: 'DELETE' });
    toast(`${state.drawerSnag.human_ref} deleted.`);
    closeDrawer(); loadSnags();
  } catch (error) { message('drawerMessage', error.message, true); }
}
async function uploadSnagPhotos(event) {
  if (!state.drawerSnag) return;
  const files = Array.from(event.target.files || []); event.target.value = '';
  if (!files.length) return;
  const form = new FormData();
  files.slice(0, 5).forEach(file => form.append('photos', file));
  try {
    const snag = await api(`/api/snags/${encodeURIComponent(state.drawerSnag.id)}/photos`, { method: 'POST', body: form });
    state.drawerSnag = snag; renderPhotoStrip(snag); toast('Photos attached.');
  } catch (error) { message('drawerMessage', error.message, true); }
}

/* ── Specs & admin ───────────────────────────────── */
async function loadSpecs() {
  const list = $('specList'); list.replaceChildren();
  try {
    const data = await api(`/api/spec-clauses?projectId=${encodeURIComponent(currentProject())}`);
    if (!data.items.length) {
      const empty = el('p', 'empty');
      empty.append(el('strong', null, 'No clauses yet.'), document.createTextNode('An admin can add project clauses here. Active ones are sent to MimaarAI with every analysis to check the image against.'));
      list.appendChild(empty); return;
    }
    for (const item of data.items) {
      const row = el('article', 'spec-row');
      row.append(el('strong', null, item.name), el('p', null, item.description));
      const small = el('small', null, `${item.active ? 'Active' : 'Draft'} · ${item.source_name || 'Manual source'}${item.source_page ? ` · p. ${item.source_page}` : ''}`);
      row.appendChild(small); list.appendChild(row);
    }
  } catch (error) { toast(error.message, true); }
}
async function saveSpec(event) {
  event.preventDefault(); message('specMessage');
  try {
    await api('/api/spec-clauses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: currentProject(), name: $('specName').value, description: $('specDescription').value, category: $('specCategory').value, priority: $('specPriority').value, sourceName: $('specSource').value, sourcePage: $('specPage').value, active: $('specActive').checked }) });
    event.currentTarget.reset(); message('specMessage', 'Clause saved.'); loadSpecs();
  } catch (error) { message('specMessage', error.message, true); }
}
async function createInvite(event) {
  event.preventDefault(); message('adminMessage');
  try {
    const data = await api('/api/admin/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('inviteEmail').value, role: $('inviteRole').value }) });
    $('inviteUrl').value = data.inviteUrl; $('inviteUrlWrap').classList.remove('hidden');
    message('adminMessage', `Invite expires ${new Date(data.expiresAt).toLocaleString()}.`);
  } catch (error) { message('adminMessage', error.message, true); }
}

/* ── Audit trail ─────────────────────────────────── */
const AUDIT_VERBS = {
  created: 'created', edited: 'edited', deleted: 'deleted', photos_added: 'added photos to',
  promoted_from_finding: 'promoted an AI finding into', approved: 'approved', rejected: 'rejected',
  handed_off: 'handed off', cancelled: 'cancelled', analysed: 'AI-analysed', analysis_failed: 'AI analysis failed on',
  login: 'signed in', logout: 'signed out', bootstrap_admin: 'bootstrapped admin', invite_accepted: 'accepted an invite'
};
const AUDIT_ENTITY_LABELS = { snag: 'snag', finding: 'finding', analysis_run: 'run', analysis_asset: 'image', session: 'session', invite: 'invite', spec_clause: 'clause', user: 'user' };
function auditDetail(row) {
  const d = row.details || {};
  const bits = [];
  if (d.findings != null) bits.push(`${d.findings} finding(s)`);
  if (d.specClausesSent != null) bits.push(`${d.specClausesSent} spec clause(s) sent`);
  if (d.model) bits.push(d.model);
  if (d.error) bits.push(`error: ${d.error}`);
  if (d.fields) bits.push(`fields: ${d.fields.join(', ')}`);
  if (d.note) bits.push(`note: ${d.note}`);
  if (d.humanRef) bits.push(d.humanRef);
  if (d.role) bits.push(`role: ${d.role}`);
  if (d.count != null) bits.push(`${d.count} item(s)`);
  return bits.join(' · ');
}
function auditRow(row) {
  const item = el('article', 'audit-row');
  const when = el('time', 'audit-when', new Date(`${String(row.created_at).replace(' ', 'T')}Z`).toLocaleString());
  const line = el('p', 'audit-line');
  const actor = el('strong', null, row.actor_email ? row.actor_email.split('@')[0] : 'system');
  const verb = AUDIT_VERBS[row.action] || row.action.replace(/_/g, ' ');
  const entity = AUDIT_ENTITY_LABELS[row.entity_type] || row.entity_type;
  line.append(actor, document.createTextNode(` ${verb} ${entity}`));
  item.append(when, line);
  const detail = auditDetail(row);
  if (detail) item.append(el('p', 'audit-detail', detail));
  return item;
}
async function loadAudit(reset) {
  const list = $('auditList');
  if (reset) { list.replaceChildren(); state.auditCursor = null; }
  try {
    const query = new URLSearchParams({ limit: '50' });
    if ($('auditFilter').value) query.set('entityType', $('auditFilter').value);
    if (!reset && state.auditCursor) { query.set('beforeAt', state.auditCursor.beforeAt); query.set('beforeId', state.auditCursor.beforeId); }
    const data = await api(`/api/projects/${encodeURIComponent(currentProject())}/audit?${query}`);
    if (reset && !data.items.length) {
      const empty = el('p', 'empty');
      empty.append(el('strong', null, 'No events yet.'), document.createTextNode('Actions across the pilot appear here as they happen.'));
      list.appendChild(empty);
    }
    data.items.forEach(row => list.appendChild(auditRow(row)));
    state.auditCursor = data.nextCursor;
    $('auditMore').classList.toggle('hidden', !data.nextCursor);
  } catch (error) { toast(error.message, true); }
}

/* ── Wiring ──────────────────────────────────────── */
function bindEvents() {
  $('loginForm').addEventListener('submit', login);
  $('inviteForm').addEventListener('submit', acceptInvite);
  $('logoutButton').addEventListener('click', logout);
  $('loadViewer').addEventListener('click', () => previewViewer());
  $('viewerHome').addEventListener('click', loadOpenspaceHome);
  $('openspaceViewer').addEventListener('load', onViewerLoad);
  /* Typing a link is not loading it: the frame still shows whatever it showed before. */
  $('openspaceUrl').addEventListener('input', updateViewerStatus);
  $('captureView').addEventListener('click', captureViewer);
  document.addEventListener('paste', handlePaste);
  $('analysisImages').addEventListener('change', chooseFiles);
  $('startAnalysis').addEventListener('click', startAnalysis);
  $('cancelRun').addEventListener('click', cancelRun);
  $('findingState').addEventListener('change', loadFindings);
  $('specForm').addEventListener('submit', saveSpec);
  $('inviteCreateForm').addEventListener('submit', createInvite);
  $('auditFilter').addEventListener('change', () => loadAudit(true));
  $('auditMore').addEventListener('click', () => loadAudit(false));
  $('snagForm').addEventListener('submit', saveSnag);
  $('drawerClose').addEventListener('click', closeDrawer);
  $('drawerScrim').addEventListener('click', closeDrawer);
  $('drawerDelete').addEventListener('click', deleteSnag);
  $('snagPhotoInput').addEventListener('change', uploadSnagPhotos);
  $('newSnag').addEventListener('click', () => openDrawer(null));
  $('snagPriority').addEventListener('change', loadSnags);
  $('snagSort').addEventListener('change', loadSnags);
  let searchTimer;
  $('snagSearch').addEventListener('input', () => { window.clearTimeout(searchTimer); searchTimer = window.setTimeout(loadSnags, 250); });
  $('viewBoard').addEventListener('click', () => setSnagView('board'));
  $('viewList').addEventListener('click', () => setSnagView('list'));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('snagDrawer').classList.contains('hidden')) closeDrawer(); });
  document.querySelectorAll('[role="tab"]').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
  document.querySelector('.tabs').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const tabs = [...document.querySelectorAll('[role="tab"]')].filter(tab => !tab.classList.contains('hidden'));
    const index = tabs.indexOf(document.activeElement);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    next.focus(); next.click();
  });
}
function setSnagView(view) {
  state.snagView = view;
  $('viewBoard').classList.toggle('active', view === 'board');
  $('viewBoard').setAttribute('aria-pressed', String(view === 'board'));
  $('viewList').classList.toggle('active', view === 'list');
  $('viewList').setAttribute('aria-pressed', String(view === 'list'));
  renderSnags();
}
/* Guarded so the module can be required in a plain-node test to reach the pure helpers;
   in the browser `document` exists and this wires everything up as before. */
if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => { bindEvents(); hydrateSession(); });
