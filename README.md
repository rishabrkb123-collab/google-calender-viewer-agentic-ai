# Google Calendar Viewer (View / Modify / Delete + Chat)

Node.js + Express + React app for:
- local login
- Google Calendar OAuth connect
- viewing, modifying, deleting, and cancelling events
- AI-style chat over saved calendar events
- MongoDB persistence for snapshots and event documents

## Features

- Local session login (`admin/admin` is seeded on first run)
- Google OAuth2 connect flow
- Event list with filters, sorting, timeline/list view
- Modify event fields (`summary`, `location`, `description`, `start`, `end`)
- Delete/cancel events with optional attendee notifications
- Download latest fetched events as JSON
- Storage sync/status endpoints for MongoDB checks
- Chat endpoint (`/api/chat`) that answers from saved event data

## Tech Stack

- Backend: Node.js, Express, `googleapis`, `mongodb`, `express-session`
- Frontend: React + Vite (build output served from `public/`)
- Database: MongoDB Atlas (or compatible MongoDB URI)

## Prerequisites

- Node.js 18+
- Google Cloud OAuth client credentials
- MongoDB connection URI
- (Optional for chat quality) Ollama running locally

## Google Cloud Setup

1. Enable **Google Calendar API**.
2. Configure OAuth consent screen.
3. Add authorized redirect URI:
   - `http://localhost:3000/oauth2callback`
4. Ensure consent includes:
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/userinfo.profile`
   - `openid`

## Environment Variables

Copy `.env.example` to `.env` and fill values:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI` (default `http://localhost:3000/oauth2callback`)
- `SESSION_SECRET`
- `AGENT_API_KEY` (required for n8n agent routes)
- `GOOGLE_TOKEN_ENCRYPTION_SECRET` (recommended; used to encrypt stored Google tokens)
- `PORT` (default `3000`)
- `MONGODB_URI`
- `MONGODB_DB_NAME` (optional)
- `OLLAMA_BASE_URL` (optional, default `http://localhost:11434`)
- `OLLAMA_MODEL` (optional)
- `OLLAMA_TIMEOUT_MS` (optional)
- `CHAT_USE_LLM_INTENT` (optional, default `false`)
- `CHAT_USE_LLM_REPLY` (optional, default `false`)
- `CHAT_USE_LLM_SEMANTIC_FALLBACK` (optional, default `false`)
- `N8N_CHAT_ENABLED` (optional, default `false`)
- `N8N_CHAT_WEBHOOK_URL` (optional, default `http://localhost:5678/webhook/calendar-chatbot`)
- `N8N_CHAT_TIMEOUT_MS` (optional, default `60000`)
- `N8N_CHAT_API_KEY` (optional)

## Run

1. Install backend dependencies:
   ```bash
   npm install
   ```
2. Install frontend dependencies:
   ```bash
   npm --prefix client install
   ```
3. Build frontend into `public/`:
   ```bash
   npm run client:build
   ```
4. Start server:
   ```bash
   npm start
   ```
5. Open `http://localhost:3000`.

## Local Auth Flow

1. Sign in with local credentials on `/login`.
2. Default seeded user on first startup:
   - username: `admin`
   - password: `admin`
3. After local login, connect Google account from dashboard.

## Development Commands

- Backend only:
  - `npm start`
  - `npm run dev`
  - `npm run n8n:start`
- Chatbot smoke test:
  - `npm run test:chatbot`
- Frontend dev server:
  - `npm run client:dev`
- Frontend build/preview:
  - `npm run client:build`
  - `npm run client:preview`

## API Endpoints

### Auth

- `POST /api/local/login`
- `POST /api/local/logout`
- `GET /api/local/me`
- `GET /auth/google`
- `GET /oauth2callback`
- `POST /auth/logout`
- `GET /api/me`
- `GET /api/tokeninfo`

### Events

- `POST /api/events/search`
- `POST /api/events`
- `POST /api/agent/events/search`
- `POST /api/agent/events`
- `GET /api/events?maxResults=100&timeMin=<ISO>`
- `GET /api/events/:eventId`
- `PATCH /api/agent/events/:eventId`
- `PATCH /api/events/:eventId?sendUpdates=all|none|externalOnly`
- `DELETE /api/agent/events/:eventId`
- `DELETE /api/events/:eventId?sendUpdates=all|none|externalOnly`
- `POST /api/events/:eventId/cancel?sendUpdates=all|none|externalOnly`
- `GET /api/events/download`

### Storage

- `GET /api/storage-status`
- `GET /api/storage-sync`
- `POST /api/storage-sync`
- `GET /api/chat-debug`

### Chat

- `POST /api/chat`
  - body: `{ "message": "your question" }`

## Chatbot Details

- LLM provider: local Ollama server (`OLLAMA_BASE_URL`, default `http://localhost:11434`)
- Default model used by server: `gpt-oss:120b-cloud` (from `OLLAMA_MODEL`)
- Timeout: `OLLAMA_TIMEOUT_MS` (default `60000`)

### How Chat Works

1. Frontend sends user message to `POST /api/chat`.
2. Backend reads that user's saved events from MongoDB (`calendar_events`).
3. Intent/date filtering is applied (time range, next event, count, duration, keyword/person matching).
4. Backend answers simple questions directly from filtered calendar data.
5. Ollama can be enabled optionally for semantic-summary questions, intent parsing, or reply wording.
6. If Ollama is unavailable or disabled, chat still works from saved event data.

### Notes

- Chat responses are grounded in saved/synced calendar data.
- For best results, keep Ollama running and set `OLLAMA_MODEL` to a model available on your machine.
- For best accuracy and speed on simple calendar questions, leave `CHAT_USE_LLM_INTENT=false` and `CHAT_USE_LLM_REPLY=false`.
- If you want hybrid behavior, set `CHAT_USE_LLM_SEMANTIC_FALLBACK=true` so only fuzzy summary-style questions use the LLM.
- If `N8N_CHAT_ENABLED=true`, `/api/chat` proxies the request to your n8n workflow instead of using the local Ollama-backed chat path.
- The imported n8n workflow file is stored at [AI-Powered Google Calendar Chatbot with Natural Language Intent Parsing.json](/D:/Google%20calendar%20viewer%20for%20chatbot%20-%20n8n/google-calendar-viewer%20view%20modify%20delete%20working%20(2)/google-calendar-viewer%20view%20modify%20delete%20working/n8n/workflows/AI-Powered%20Google%20Calendar%20Chatbot%20with%20Natural%20Language%20Intent%20Parsing.json).

## n8n Integration

Use n8n for orchestration and keep this backend as the deterministic execution layer.

Important:
- n8n cannot use your browser session reliably.
- The server now stores Google OAuth tokens per connected user in MongoDB, encrypted with `GOOGLE_TOKEN_ENCRYPTION_SECRET` or `SESSION_SECRET`.
- Reconnect your Google account once after pulling these changes so the encrypted token copy is stored for agent use.

Recommended flow:
1. Chat trigger in n8n
2. LLM parses the user message into action + fields
3. HTTP Request node calls `POST /api/agent/events/search` to resolve candidates
4. If exactly one event matches, n8n calls:
   - `POST /api/agent/events` to create
   - `PATCH /api/agent/events/:eventId` to modify or move
   - `DELETE /api/agent/events/:eventId` to delete
5. Backend updates Google Calendar and refreshes MongoDB so both stay in sync

Headers for every agent call:
- `x-agent-api-key: <AGENT_API_KEY>`
- `x-user-email: <the Google account email to act as>`

Importable workflow:
- [calendar-agent.json](/D:/Google%20calendar%20viewer%20for%20chatbot%20-%20n8n/google-calendar-viewer%20view%20modify%20delete%20working%20(2)/google-calendar-viewer%20view%20modify%20delete%20working/n8n/workflows/calendar-agent.json)

### Search payload

```json
{
  "userEmail": "owner@example.com",
  "query": "dentist on monday",
  "summary": "dentist",
  "date": "2026-03-23",
  "limit": 5
}
```

### Create payload

```json
{
  "userEmail": "owner@example.com",
  "summary": "Meeting with Sarah",
  "description": "Created by n8n",
  "location": "Google Meet",
  "start": { "dateTime": "2026-03-24T15:00:00+05:30", "timeZone": "Asia/Calcutta" },
  "end": { "dateTime": "2026-03-24T15:30:00+05:30", "timeZone": "Asia/Calcutta" },
  "attendees": ["sarah@example.com"]
}
```

### Modify payload

```json
{
  "userEmail": "owner@example.com",
  "summary": "Updated title",
  "start": { "dateTime": "2026-03-25T10:00:00+05:30", "timeZone": "Asia/Calcutta" },
  "end": { "dateTime": "2026-03-25T10:30:00+05:30", "timeZone": "Asia/Calcutta" }
}
```

## MongoDB Collections

- `users` (local auth users)
- `user_profiles` (Google profile + scopes)
- `event_snapshots` (latest fetched payload per user email)
- `calendar_events` (normalized event docs for chat/filtering)

## Troubleshooting

### 403 insufficient authentication scopes

If Google API returns insufficient scopes:
1. Confirm OAuth consent includes `calendar.events`.
2. Run local logout and Google logout in app.
3. Reconnect Google and grant consent again.
4. Check scopes with `GET /api/tokeninfo`.

### Chat fallback behavior

If Ollama is unavailable or errors, chat still responds using server-side fallback text generated from saved calendar data.
