# OpenSpace Snag Manager — "Pilot Pro" design

Date: 2026-07-17 · Status: approved by user ("make it awesome and wow")

## Goal

Merge the two existing versions into one production-grade app and redeploy on Railway:

- **Committed demo (84387bc)**: rich features (split-screen OpenSpace viewer, snag CRUD, AI scan, CSV/PDF export, photos) but zero auth.
- **Pilot rewrite (225f330)**: hardened multi-user backend (scrypt auth, sessions + CSRF, roles, invites, consent-gated analysis runs, review workflow, Field Note handoff, spec clauses, audit log) but skeleton UI and no snag features.

Result: the pilot's security spine + the demo's feature set + a new "wow" UI.

## Concept

Two connected loops, project-scoped, behind auth:

1. **AI loop**: capture/upload evidence → consent-gated analysis run (MimaarAI `/api/v1/analyze`, job-based, SBC RAG) → draft findings → human review (approve/reject) → handoff to OpenSpace Field Note **or promote to snag**.
2. **Field loop**: snags (Open → In Progress → Resolved → Closed) with trade/location/assignee/due date/photos → kanban + list → CSV/PDF export.

"Promote to snag" is the new bridge: an approved AI finding becomes a snag in one click, carrying evidence, category, priority, trade, recommendation.

## Backend (extend `server.js` + `db/database.js`; security spine unchanged)

New tables: `snags` (id `snag_…`, project_id, human_ref `SNG-XXXXXX`, title, description, category, priority, status Open/In Progress/Resolved/Closed, trade, location, floor, zone, assignee, due_date, root_cause, recommendation, photos JSON, source_finding_id NULL, created_by, version, timestamps).

New routes (all `requireAuth`, membership-checked; writes also `requireCsrf`):

- `GET/POST /api/snags`, `GET/PATCH/DELETE /api/snags/:id` — filters: status, priority, search, sort. Optimistic-concurrency `version` on PATCH. Delete is admin-only.
- `POST /api/snags/:id/photos` — multer memory storage, signature-checked JPEG/PNG/WebP, stored under DATA_DIR uploads, served via authed `GET /api/assets/...`-style route (no static /uploads).
- `POST /api/findings/:id/promote` — reviewer/admin; approved findings only; one snag per finding (idempotent); links evidence asset as snag photo reference; audit event.
- `GET /api/projects/:id/stats` — counts by status/priority/trade, overdue, findings-by-state, 14-day created/resolved trend.
- `GET /api/snags/export/csv` + `/export/pdf` — project-scoped, authed. CSV formula-injection-safe (prefix `'` on `=+-@`). PDF: branded pdfkit report with stats header.
- MimaarAI token: `MIMARAI_API_TOKEN` env; optional `MIMARAI_EMAIL`/`MIMARAI_PASSWORD` auto-login + refresh on 401 so analysis doesn't die when the JWT expires. Fail-closed: provider errors surface as asset failures, never fabricated findings.

## Frontend (full redesign, `public/`, no build step)

Tabs: **Dashboard** (stat tiles, SVG donut/bars/trend), **Capture & Analyze** (OpenSpace viewer + evidence staging + live staged progress from job API), **Review queue** (evidence image beside finding; approve / reject / promote), **Snags** (kanban by status with drag-drop + filterable list toggle, drawer for detail/edit/photos), **Specs**, **Admin** (invites, audit trail view).

Visual identity: professional construction-ops aesthetic (frontend-design + dataviz skills at implementation); accessible (roles/aria kept from pilot), keyboard-navigable, proper empty/loading/error states, toasts.

## Deploy

New Railway project (old one deleted — root cause of the dead URL). Railway **volume mounted at `/data`** (`DATA_DIR=/data`) so SQLite + uploads persist. Env: `NODE_ENV=production`, `APP_ORIGIN`, `BOOTSTRAP_ADMIN_EMAIL/PASSWORD` (removed after first boot), `MIMARAI_API_TOKEN` (or EMAIL/PASSWORD). Healthcheck `/api/health/ready`. Live E2E verification after deploy (login, snag CRUD, exports, analysis run if token present).

## Testing

Extend supertest suite: authz + IDOR (cross-project) on every new route, promote flow (approved-only, idempotent), CSV injection guard, version conflict, stats shape, photo signature rejection.

## Out of scope

Arabic/RTL, real OpenSpace Field Note API integration (link-paste handoff stays), multi-project admin UI (single pilot project bootstrap stays).
