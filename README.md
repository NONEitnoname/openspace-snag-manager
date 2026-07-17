# OpenSpace Snag Manager

Construction snag manager for a site-QA pilot: walk a live OpenSpace 360° capture, send the view to MimaarAI for analysis, review every AI finding by hand, and run the resulting snags to closure.

## What it does

- **Live OpenSpace viewer** — the viewer opens OpenSpace itself, so you sign in without leaving the app, then paste a capture's share link to load it.
- **Capture the view** — grab the live 360° view through the browser's Screen Capture API, cropped to the viewer, and send it to MimaarAI with the project's active specification clauses. Pasting a screenshot (Ctrl+V) or picking files also works.
- **Human review gate** — MimaarAI returns *draft findings*. Nothing becomes work until a reviewer approves it. Code references are flagged as unverified suggestions, model confidence is labelled as the model's own, and a finding the model did not rate stays "Unrated" rather than being defaulted.
- **Snag register** — kanban board with drag-to-move status, list view, filters/search, photos, due dates, overdue flagging, CSV and PDF export.
- **Promote to snag** — an approved finding becomes a snag in one click, carrying its evidence.
- **Roles and audit** — admin / inspector / reviewer, invite-only accounts, and an audit log of every decision (including what the AI produced and what it failed on). The log has no reader UI yet — query `audit_events` directly.

**Read [`docs/KNOWN_GAPS.md`](docs/KNOWN_GAPS.md) before trusting any of this in the field.** The headline loop — a real image analysed by MimaarAI into real findings — has never completed end to end, and nobody has yet signed in to OpenSpace through the viewer with a real account. That file says exactly what is proven and what is not.

## Setup

```bash
npm install
cp .env.example .env     # set BOOTSTRAP_ADMIN_EMAIL + BOOTSTRAP_ADMIN_PASSWORD (12+ chars)
npm start                # http://localhost:3000
```

Sign in with the bootstrap admin, then remove the bootstrap variables and invite the rest of the team from the Admin tab.

For AI analysis, set either `MIMARAI_API_TOKEN` or `MIMARAI_EMAIL` + `MIMARAI_PASSWORD`. Without them the app runs and the analysis pipeline reports honestly that the provider is not configured — it never invents findings.

## Tests

```bash
npx jest --runInBand
```

## Deploy (Railway)

Nixpacks, start `node server.js`, health check `/api/health/ready`. Attach a **volume at `/data`** and set `DATA_DIR=/data`, or the database and uploads are lost on every redeploy.
