# CLAUDE.md — OpenSpace Snag Manager

## Project Overview
Construction snag/defect manager for a pilot: a live OpenSpace 360° viewer, MimaarAI vision analysis of the captured view, a human review gate, and a full snag register. Multi-user with roles; OpenSpace stays the system of record.

Two connected loops:
1. **AI loop** — load capture → capture the live view → consent → MimaarAI analysis run → draft findings → human approve/reject → hand off to a Field Note **or promote to a snag**.
2. **Field loop** — snags (Open → In Progress → Resolved → Closed) with trade/location/assignee/due date/photos → kanban + list → CSV/PDF export.

## Tech Stack
- **Backend**: Node.js 24+ · Express 5 · `node:sqlite` (no native build) · multer · pdfkit
- **Frontend**: plain HTML/CSS/JS, no build step, served from `public/`
- **DB**: SQLite at `$DATA_DIR/snag-pilot.db` (WAL). Uploads at `$DATA_DIR/uploads`.
- **AI**: MimaarAI job API — `POST /api/v1/analyze` → `GET /api/v1/analyze/:jobId`
- **Deploy**: Railway (Nixpacks), project `openspace-snag-manager`, service `web`, **volume mounted at `/data`**

## Security spine (do not regress)
- scrypt password hashing; session cookie `snag_session` (httpOnly, sameSite=lax, secure in prod); CSRF token required on every write; `APP_ORIGIN` origin check
- Roles: `admin` / `inspector` / `reviewer`. Every route is membership-checked against the project — there are IDOR tests, keep them passing.
- **Snags are collaborative; draft findings are not.** Any project member may edit any snag (the assignee has to progress work they did not raise), and only an admin may delete one. A draft finding is AI output attributed to the run that produced it, so `PATCH /api/findings/:id` restricts inspectors to their own. This asymmetry is deliberate — both rules are pinned by tests; do not "harmonise" them without changing the tests on purpose.
- Uploads: magic-byte signature check (JPEG/PNG/WebP), served only through authed routes — never static `/uploads`
- CSV export prefixes `=+-@` to defuse spreadsheet formula injection
- CSP + `Permissions-Policy` set in `server.js`. `frame-src` allows `*.openspace.ai` only.

## OpenSpace integration
**OpenSpace sends no X-Frame-Options — direct iframe embed works. Never proxy it** (auth cookies ride on every resource; its JS bundle hardcodes API URLs, so a proxy cannot work). The user must be signed into OpenSpace in the same browser; otherwise the iframe shows OpenSpace's login page.

### Capturing the live view
A cross-origin iframe cannot be read from canvas, so capture goes through the **Screen Capture API**:
`getDisplayMedia({ video: { displaySurface: 'browser' }, preferCurrentTab: true })` → paint the frame into a `<video>` → `createImageBitmap` → **crop to `#viewerWrap`'s bounding rect** (scale = `bitmap.width / window.innerWidth`) → JPEG.

- Do **not** use `ImageCapture.grabFrame()` — Chromium gates it behind the `camera` permission policy, which this app disables. The `<video>` path is the working one.
- `Permissions-Policy` must keep `display-capture=(self)`.
- If `track.getSettings().displaySurface !== 'browser'` the user shared a screen/window rather than the tab: **skip cropping and warn**, because the frame may contain unrelated windows.
- Ctrl+V paste of a screenshot is the fallback path.

## MimaarAI integration
`POST https://mimarai.com/api/v1/analyze` with `{ imageData: <base64>, mimeType, reviewType: 'construction_qa', includeCoordinates: true, query }` → `{ jobId }`; poll `GET /api/v1/analyze/:jobId` until `status === 'completed'`. Polling also carries `message`/`progress`, which is persisted per asset and drives the UI progress rails.

Auth: `MIMARAI_API_TOKEN`, or `MIMARAI_EMAIL` + `MIMARAI_PASSWORD` (preferred — login JWTs expire; the server mints one at boot and re-mints on a 401).

**Fail-closed**: no credentials or a provider error ⇒ the asset is marked `failed` with the real upstream message. Findings are never fabricated. Code references from the model are shown as *unverified suggestions*.

## Key patterns
- Snag ref: `SNG-` + 6 chars from an unambiguous alphabet (no I/O/0/1)
- Writes take `version` for optimistic concurrency → 409 on conflict
- Promote is idempotent (unique index on `snags.source_finding_id`)
- `db.transaction()` does not exist in `node:sqlite` — use the `transaction(fn)` helper from `db/database.js`

## Env
`PORT` `NODE_ENV` `APP_ORIGIN` `DATA_DIR` `PILOT_PROJECT_NAME` `BOOTSTRAP_ADMIN_EMAIL` `BOOTSTRAP_ADMIN_PASSWORD` (first boot only, then remove) `MIMARAI_API_TOKEN` | `MIMARAI_EMAIL`+`MIMARAI_PASSWORD`

## Commands
```bash
npm start            # production
npm run dev          # node --watch
npx jest --runInBand # tests (15)
railway up           # deploy
railway logs         # logs
```
