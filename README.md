# OpenSpace Snag Manager

Construction snag/defect manager with embedded OpenSpace 360° viewer and MimaarAI-powered analysis.

## Setup

1. `npm install`
2. `cp .env.example .env`
3. `npm start`
4. Open http://localhost:3000

## Features

- 360° OpenSpace viewer embedded via proxy
- AI-powered snag categorization via MimaarAI (mimarai-pro → mimarai-advanced fallback)
- Full snag lifecycle management (Open → In Progress → Resolved → Closed)
- CSV and PDF export
- Photo attachments
- Search, filter, and sort
- Persistent SQLite storage
- Railway deployment ready
