# CLAUDE.md — OpenSpace Snag Manager

## Project Overview
Construction snag/defect management app with embedded OpenSpace 360° viewer and MimaarAI-powered AI analysis. Single-page app: left panel = OpenSpace iframe, right panel = snag management + AI scan.

## Tech Stack
- **Backend**: Node.js + Express 5 + better-sqlite3 + multer + pdfkit
- **Frontend**: Plain HTML/CSS/JS (no build step, served from `public/`)
- **Database**: SQLite (`snags.db`, WAL mode)
- **AI**: MimaarAI platform (`https://mimarai.com/api/chat/enhanced`)
- **Deployment**: Railway (Nixpacks — `nixpacks.toml` sets Node 20 + Python for native deps)

## Architecture

### Server (`server.js` ~370 lines)
- Express 5 with `express.json({ limit: '50mb' })` for base64 image uploads
- **MimaarAI auth proxy**: `/api/mimarai/login` and `/api/mimarai/register` — forwards to `mimarai.com/api/auth/*`
- **CRUD**: `/api/snags` (GET/POST), `/api/snags/:id` (GET/PUT/DELETE)
- **AI endpoints**: `/api/snags/ai-categorize` (text), `/api/snags/ai-scan` (vision)
- **Export**: `/api/snags/export/csv`, `/api/snags/export/pdf`
- **Photos**: `/api/snags/:id/photos` (multer upload to `uploads/`)
- **Health**: `/api/health`

### Frontend (`public/` — 3 files)
- `index.html` — Single page: header + split layout (65% viewer / 35% snag panel)
- `styles.css` — Dark teal theme, DM Sans/DM Mono/Playfair Display fonts
- `app.js` — All DOM logic, API calls, MimaarAI auth, paste handler, OpenSpace viewer

### Database (`db/database.js`)
- Snag IDs: `SNG-` + 6 random alphanumeric chars
- Fields: title, description, category, priority, status, trade, location, floor, zone, assignee, due_date, root_cause, recommendation, effort, photos (JSON array), timestamps

## OpenSpace Integration

**OpenSpace has NO X-Frame-Options header.** Direct iframe embed works — no proxy needed.

```js
iframe.src = "https://ksa.openspace.ai/ohplayer?site=..."; // Direct URL
```

- User pastes their OpenSpace share URL via "Connect OpenSpace" overlay
- URL saved in `localStorage('openspace_url')` — persists across sessions
- User must be logged into OpenSpace in the same browser — cookies carry into iframe
- If not logged in, the iframe shows OpenSpace's login page — user can log in there

**CRITICAL**: Do NOT use a server-side proxy for OpenSpace. Previous attempts failed because:
1. OpenSpace requires auth cookies on ALL resources (CSS, JS, images, WebGL)
2. Proxy makes server-side requests that can't carry browser cookies
3. OpenSpace's JS bundle has hardcoded API URLs that bypass any proxy

## MimaarAI Integration

### Auth Flow
1. Frontend stores JWT token in `localStorage('mimarai_token')`
2. All AI requests include header: `X-Mimarai-Token: <jwt>`
3. Server reads `req.headers['x-mimarai-token']` → sends as `Authorization: Bearer <token>` to MimaarAI

### API Call Format — MUST use streaming endpoint
```js
POST https://mimarai.com/api/chat/enhanced/stream   // NOT /api/chat/enhanced
{
  message: "...",
  sessionId: "snag-<timestamp>",
  model: "mimarai-ultra",
  temperature: 0.3,
  stream: true,
  engineeringContext: { sbcMode: true, stream: "structural", category: "inspection", type: "qa_qc" }
}
```
Response is SSE: `data: {"content":"..."}\n` lines, ending with `data: [DONE]`.
Collect all `content` fields to get the full text.

### CRITICAL — Use /stream, NOT /enhanced
The non-streaming endpoint (`/api/chat/enhanced`) has `max_tokens: 8000`. MimaarAI auto-enables extended thinking for engineering queries (complexity score 17+), setting `budget_tokens: 20000`. Since `20000 > 8000`, it crashes with `max_tokens must be greater than thinking.budget_tokens`.

The streaming endpoint (`/api/chat/enhanced/stream`) has `max_tokens: 64000` — always sufficient. The `callMimaarAI()` helper in `server.js` handles SSE parsing.

`engineeringContext` is safe to send — it enables SBC-aware RAG analysis. The thinking crash is purely a max_tokens issue on the non-streaming endpoint.

### Model Fallback Order
- **Categorize**: `mimarai-ultra` → `mimarai-pro` → `mimarai-advanced`
- **Vision scan**: `mimarai-pro` → `mimarai-ultra` → `mimarai-advanced`

### Anonymous Rate Limit
- 5 messages/day without authentication
- Unlimited with MimaarAI account (login via `/api/mimarai/login`)

## Key Patterns

### Snag ID Format
`SNG-` + 6 random chars from `ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789` (e.g., `SNG-E1LMFI`)

### Photo Storage
- Uploaded via multer to `uploads/` directory
- Stored in DB as JSON array of paths: `["/uploads/1713...-abc.jpg"]`
- `uploads/` is gitignored except `.gitkeep`

### AI Response Parsing
MimaarAI returns natural language containing JSON. Extract with:
```js
const jsonMatch = content.match(/\{[\s\S]*\}/);  // Single object
const arrayMatch = content.match(/\[[\s\S]*\]/);  // Array
```

### Paste-to-Analyze
- Global `paste` event listener captures clipboard images
- Auto-switches to AI Scan tab
- Auto-triggers `aiScanPhotos()` after 500ms delay
- Base64 conversion via `FileReader` / `arrayBuffer` + `btoa`

## Deployment

### Railway
- **Builder**: Nixpacks (`nixpacks.toml`: `nodejs_20` + `python3` for better-sqlite3)
- **Start**: `node server.js`
- **Health**: `/api/health` (30s timeout)
- **URL**: `https://merry-manifestation-production-719b.up.railway.app`
- **Project**: `60c94fda-bca3-41f1-925b-e1ffc045876a`

### GitHub
- **Repo**: `https://github.com/NONEitnoname/openspace-snag-manager`
- **Branch**: `master`

## Commands
```bash
npm start          # Production
npm run dev        # Development (--watch)
railway up         # Deploy to Railway
railway logs       # View Railway logs
```
