const state = { user: null, csrf: null, projects: [], selectedFiles: [], activeRun: null, poller: null };
const $ = id => document.getElementById(id);

function message(id, text = '', error = false) { const el = $(id); el.textContent = text; el.classList.toggle('error', error); }
function toast(text, error = false) { const el = $('toast'); el.textContent = text; el.classList.toggle('error', error); el.classList.add('show'); window.clearTimeout(toast.timer); toast.timer = window.setTimeout(() => el.classList.remove('show'), 3500); }
function escapeText(value) { return String(value ?? ''); }
function currentProject() { return $('projectSelect')?.value || state.projects[0]?.id; }
function apiHeaders(extra = {}) { return { ...extra, ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}) }; }
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: apiHeaders(options.headers) });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || 'Request failed');
  return data;
}
function showApp() { $('authView').classList.add('hidden'); $('appView').classList.remove('hidden'); $('userLabel').textContent = `${state.user.email} · ${state.user.role}`; setupProjects(); switchTab('analyze'); }
function setupProjects() { $('projectSelect').replaceChildren(...state.projects.map(p => { const option = document.createElement('option'); option.value = p.id; option.textContent = p.name; return option; })); }
function switchTab(name) {
  document.querySelectorAll('[role="tab"]').forEach(tab => { const active = tab.dataset.tab === name; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; });
  document.querySelectorAll('[role="tabpanel"]').forEach(panel => panel.classList.toggle('active', panel.id === `panel-${name}`));
  if (name === 'review') loadFindings();
  if (name === 'specs') loadSpecs();
}
async function hydrateSession() {
  try {
    const data = await api('/api/auth/me');
    state.user = data.user; state.csrf = data.csrfToken; state.projects = data.projects;
    showApp();
  } catch { showAuth(); }
}
function showAuth() {
  const token = new URLSearchParams(location.search).get('invite');
  $('loginForm').classList.toggle('hidden', Boolean(token)); $('inviteForm').classList.toggle('hidden', !token);
  if (token) $('inviteForm').dataset.token = token;
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
    history.replaceState({}, '', location.pathname); state.user = data.user; state.csrf = data.csrfToken; state.projects = (await api('/api/auth/me')).projects; showApp();
  } catch (error) { message('authMessage', error.message, true); }
}
async function logout() { try { await api('/api/auth/logout', { method: 'POST' }); } finally { location.reload(); } }
function validateContext() {
  const url = $('openspaceUrl').value.trim(); const reason = $('unlinkedReason').value.trim();
  if (!url && !reason) throw new Error('Attach an OpenSpace link or explain why the photos are unlinked.');
  return { url, reason };
}
function previewViewer() {
  try {
    const { url } = validateContext();
    if (!url) { toast('No OpenSpace link was supplied for this run.', true); return; }
    const parsed = new URL(url); if (parsed.protocol !== 'https:' || !(parsed.hostname === 'openspace.ai' || parsed.hostname.endsWith('.openspace.ai'))) throw new Error('Use an HTTPS openspace.ai share link.');
    $('openspaceViewer').src = parsed.toString(); $('viewerWrap').classList.remove('hidden'); $('openCapture').href = parsed.toString(); $('openCapture').classList.remove('hidden');
  } catch (error) { toast(error.message, true); }
}
function renderFilePreviews() {
  const container = $('imagePreviews'); container.replaceChildren();
  state.selectedFiles.forEach((file, index) => {
    const card = document.createElement('div'); card.className = 'preview';
    const image = document.createElement('img'); image.src = URL.createObjectURL(file); image.alt = `Selected evidence: ${file.name}`;
    const text = document.createElement('span'); text.textContent = `${file.name} · ${Math.ceil(file.size / 1024)} KB`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'quiet'; remove.textContent = 'Remove'; remove.addEventListener('click', () => { state.selectedFiles.splice(index, 1); renderFilePreviews(); });
    card.append(image, text, remove); container.appendChild(card);
  });
}
function chooseFiles(event) {
  const incoming = Array.from(event.target.files || []);
  const valid = incoming.filter(f => ['image/jpeg', 'image/png', 'image/webp'].includes(f.type) && f.size <= 8 * 1024 * 1024);
  if (valid.length !== incoming.length) toast('Only JPEG, PNG, or WebP images up to 8 MB were staged.', true);
  state.selectedFiles = valid.slice(0, 5); event.target.value = ''; renderFilePreviews();
}
async function startAnalysis() {
  message('analysisMessage');
  try {
    const { url, reason } = validateContext();
    if (!state.selectedFiles.length) throw new Error('Choose at least one supported image.');
    if (!$('analysisConsent').checked) throw new Error('Confirm the MimaarAI data-processing disclosure first.');
    const form = new FormData(); form.set('projectId', currentProject()); form.set('openspaceUrl', url); form.set('unlinkedReason', reason); form.set('consentAccepted', 'true'); state.selectedFiles.forEach(file => form.append('images', file));
    const data = await api('/api/analysis-runs', { method: 'POST', body: form });
    state.activeRun = data.runId; $('runStatus').classList.remove('hidden'); message('analysisMessage', 'Images staged. Tracking each file below.'); await loadRun();
  } catch (error) { message('analysisMessage', error.message, true); }
}
function renderRun(run) {
  const container = $('runItems'); container.replaceChildren();
  run.assets.forEach(asset => { const row = document.createElement('div'); row.className = `run-item ${asset.state}`; const title = document.createElement('strong'); title.textContent = asset.original_name; const detail = document.createElement('span'); detail.textContent = asset.state === 'failed' ? `Failed: ${asset.upstream_error || 'Unknown error'}` : asset.state; row.append(title, detail); container.appendChild(row); });
  if (['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(run.state)) { window.clearTimeout(state.poller); if (run.findings.length) toast(`${run.findings.length} draft finding(s) are ready for review.`); }
}
async function loadRun() {
  if (!state.activeRun) return;
  try { const run = await api(`/api/analysis-runs/${encodeURIComponent(state.activeRun)}`); renderRun(run); if (!['completed', 'completed_with_errors', 'failed', 'cancelled'].includes(run.state)) state.poller = window.setTimeout(loadRun, 1800); }
  catch (error) { message('analysisMessage', error.message, true); }
}
function findingCard(finding) {
  const card = document.createElement('article'); card.className = 'finding card';
  const heading = document.createElement('div'); heading.className = 'finding-heading'; const title = document.createElement('h3'); title.textContent = finding.title; const badge = document.createElement('span'); badge.className = `badge ${finding.priority || 'Medium'}`; badge.textContent = finding.priority || 'Medium'; heading.append(title, badge);
  const description = document.createElement('p'); description.textContent = finding.description || 'No description returned.';
  const meta = document.createElement('p'); meta.className = 'muted'; meta.textContent = `${finding.category || 'Uncategorised'} · ${finding.trade || 'No trade'} · ${finding.original_name}`;
  const context = document.createElement('div'); context.className = 'finding-links';
  const image = document.createElement('a'); image.href = `/api/assets/${encodeURIComponent(finding.asset_id)}/content`; image.target = '_blank'; image.rel = 'noopener'; image.textContent = 'Open evidence'; context.appendChild(image);
  if (finding.openspace_url) { const capture = document.createElement('a'); capture.href = finding.openspace_url; capture.target = '_blank'; capture.rel = 'noopener'; capture.textContent = 'Open capture'; context.appendChild(capture); }
  card.append(heading, description, meta, context);
  const claims = Array.isArray(finding.code_claims) ? finding.code_claims : [];
  if (claims.length) { const warning = document.createElement('p'); warning.className = 'warning'; warning.textContent = `Unverified code suggestion: ${claims.join('; ')}`; card.appendChild(warning); }
  const actions = document.createElement('div'); actions.className = 'finding-actions';
  if (finding.state === 'needs_review' && ['reviewer', 'admin'].includes(state.user.role)) {
    const approve = document.createElement('button'); approve.textContent = 'Approve'; approve.className = 'primary'; approve.addEventListener('click', () => decide(finding.id, 'approve')); const reject = document.createElement('button'); reject.textContent = 'Reject'; reject.addEventListener('click', () => decide(finding.id, 'reject')); actions.append(approve, reject);
  }
  if (finding.state === 'approved' && ['reviewer', 'admin'].includes(state.user.role)) {
    const input = document.createElement('input'); input.type = 'url'; input.placeholder = 'Paste resulting OpenSpace Field Note link'; input.setAttribute('aria-label', 'OpenSpace Field Note link'); const handoff = document.createElement('button'); handoff.textContent = 'Mark handed off'; handoff.className = 'primary'; handoff.addEventListener('click', () => handoffFinding(finding.id, input.value)); actions.append(input, handoff);
  }
  if (finding.openspace_field_note_url) { const note = document.createElement('a'); note.href = finding.openspace_field_note_url; note.target = '_blank'; note.rel = 'noopener'; note.textContent = 'Open handed-off Field Note'; actions.append(note); }
  if (actions.childElementCount) card.appendChild(actions); return card;
}
async function loadFindings() { const list = $('findingList'); list.replaceChildren(); try { const query = new URLSearchParams({ projectId: currentProject() }); if ($('findingState').value) query.set('state', $('findingState').value); const data = await api(`/api/findings?${query}`); if (!data.items.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No findings match this view.'; list.appendChild(empty); return; } data.items.forEach(item => list.appendChild(findingCard(item))); } catch (error) { toast(error.message, true); } }
async function decide(id, decision) { const note = decision === 'reject' ? window.prompt('Why is this finding rejected?') : ''; if (decision === 'reject' && !note) return; try { await api(`/api/findings/${encodeURIComponent(id)}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, note }) }); toast(`Finding ${decision}d.`); loadFindings(); } catch (error) { toast(error.message, true); } }
async function handoffFinding(id, openspaceFieldNoteUrl) { try { await api(`/api/findings/${encodeURIComponent(id)}/handoff`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ openspaceFieldNoteUrl }) }); toast('Handoff link recorded. OpenSpace remains the system of record.'); loadFindings(); } catch (error) { toast(error.message, true); } }
async function loadSpecs() { const list = $('specList'); list.replaceChildren(); try { const data = await api(`/api/spec-clauses?projectId=${encodeURIComponent(currentProject())}`); if (!data.items.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No reviewed clauses have been added.'; list.appendChild(empty); return; } data.items.forEach(item => { const row = document.createElement('article'); row.className = 'spec-row'; const title = document.createElement('strong'); title.textContent = item.name; const text = document.createElement('p'); text.textContent = item.description; const meta = document.createElement('small'); meta.textContent = `${item.active ? 'Active' : 'Draft'} · ${item.source_name || 'Manual source'}${item.source_page ? ` · p. ${item.source_page}` : ''}`; row.append(title, text, meta); list.appendChild(row); }); } catch (error) { toast(error.message, true); } }
async function saveSpec(event) { event.preventDefault(); message('specMessage'); try { await api('/api/spec-clauses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: currentProject(), name: $('specName').value, description: $('specDescription').value, category: $('specCategory').value, priority: $('specPriority').value, sourceName: $('specSource').value, sourcePage: $('specPage').value, active: $('specActive').checked }) }); event.currentTarget.reset(); message('specMessage', 'Clause saved.'); loadSpecs(); } catch (error) { message('specMessage', error.message, true); } }
async function createInvite(event) { event.preventDefault(); message('adminMessage'); try { const data = await api('/api/admin/invites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('inviteEmail').value, role: $('inviteRole').value }) }); $('inviteUrl').value = data.inviteUrl; $('inviteUrlWrap').classList.remove('hidden'); message('adminMessage', `Invite expires ${new Date(data.expiresAt).toLocaleString()}.`); } catch (error) { message('adminMessage', error.message, true); } }
function bindEvents() {
  $('loginForm').addEventListener('submit', login); $('inviteForm').addEventListener('submit', acceptInvite); $('logoutButton').addEventListener('click', logout); $('loadViewer').addEventListener('click', previewViewer); $('analysisImages').addEventListener('change', chooseFiles); $('startAnalysis').addEventListener('click', startAnalysis); $('findingState').addEventListener('change', loadFindings); $('specForm').addEventListener('submit', saveSpec); $('inviteCreateForm').addEventListener('submit', createInvite);
  document.querySelectorAll('[role="tab"]').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));
  document.querySelector('.tabs').addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; const tabs = [...document.querySelectorAll('[role="tab"]')]; const index = tabs.indexOf(document.activeElement); const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]; next.focus(); next.click(); });
}
document.addEventListener('DOMContentLoaded', () => { bindEvents(); hydrateSession(); });
