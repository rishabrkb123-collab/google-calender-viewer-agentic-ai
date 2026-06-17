# Google Calendar Agent

A full-stack web application that connects to your Google Calendar and provides an **agentic AI chatbot** capable of viewing, creating, moving, and deleting calendar events through natural language — with full two-way sync between Google Calendar and MongoDB.

---

## Table of Contents

1. [What This App Does](#what-this-app-does)
2. [Tech Stack](#tech-stack)
3. [System Architecture](#system-architecture)
4. [Application Flow Diagrams](#application-flow-diagrams)
   - [First-Time Setup Flow](#first-time-setup-flow)
   - [Authentication Flow](#authentication-flow)
   - [Chat Agent Decision Flow](#chat-agent-decision-flow)
   - [Data Sync Flow](#data-sync-flow)
   - [Delete Event Flow](#delete-event-flow-with-confirmation)
   - [Create Event Flow](#create-event-flow)
   - [Move / Reschedule Event Flow](#move--reschedule-event-flow)
5. [Project Structure](#project-structure)
6. [Database Schema](#database-schema)
7. [API Reference](#api-reference)
8. [Environment Variables](#environment-variables)
9. [Getting Started](#getting-started)
10. [Chatbot Capabilities](#chatbot-capabilities)
11. [Security Design](#security-design)
12. [npm Scripts Reference](#npm-scripts-reference)

---

## What This App Does

| Capability | How |
|---|---|
| View your Google Calendar events | OAuth2 → Google Calendar API v3 |
| Search events by name, date, attendee | Full-text search on MongoDB |
| Ask questions in natural language | Chatbot with deterministic NLP + optional Ollama LLM |
| Create new events via chat | Chat → Google Calendar API → MongoDB sync |
| Move / reschedule events via chat | Chat → patch Google Calendar → MongoDB sync |
| Delete events via chat (with confirmation) | Chat → asks yes/no → delete from Google Calendar → MongoDB |
| All changes stay in sync | Every write touches Google Calendar first, then MongoDB |

---

## Tech Stack

### Backend

| Technology | Version | Why It's Used | Where |
|---|---|---|---|
| **Node.js** | 18+ | JavaScript runtime — async I/O, native fetch, large ecosystem | Entire backend |
| **Express.js** | 5.x | Minimal HTTP server and router — simple middleware chain | `server.js` |
| **express-session** | 1.19 | Server-side sessions for OAuth tokens and pending chat actions | `server.js` — all protected routes |
| **googleapis** | 171.x | Official Google API client — Calendar v3, OAuth2, userinfo | `server.js` — all calendar operations |
| **mongodb** | 7.x | Native MongoDB driver — event storage, user profiles, sync | `server.js` — all DB operations |
| **dotenv** | 17.x | Load `.env` file into `process.env` at startup | `server.js` top-level |
| **n8n** | 2.x | Optional workflow automation platform (chat webhook fallback) | `routes/chat.js` — n8n path |

### Frontend

| Technology | Version | Why It's Used | Where |
|---|---|---|---|
| **React** | 18.3 | Component-based UI, reactive state management | All pages and components |
| **React Router** | 6.26 | Client-side SPA routing (no page reloads) | `App.jsx` — route definitions |
| **Vite** | 5.4 | Fast build tool with HMR for development, optimised production bundles | `client/vite.config.js` |

### Infrastructure / Services

| Technology | Why It's Used | How It's Connected |
|---|---|---|
| **MongoDB Atlas** | Cloud database — stores events, user profiles, OAuth tokens, snapshots | `MONGODB_URI` in `.env` — driver connects at startup |
| **Google Cloud OAuth 2.0** | Grants the app permission to read/write the user's calendar | `/auth/google` → Google → `/oauth2callback` |
| **Ollama** (optional) | Local LLM server for AI-enhanced natural language replies | `OLLAMA_BASE_URL` in `.env` — HTTP calls from `utils/ollama.js` |

### Why This Specific Stack?

- **Express over Fastify / Koa** — lightest possible setup; the Google Node.js SDK expects a plain Node http server
- **MongoDB over PostgreSQL** — Google Calendar event objects are deeply nested JSON; MongoDB stores them without schema migrations and lets you do full-text token search natively
- **React + Vite over Next.js** — this is a pure SPA served as static files from Express; no server-side rendering is needed
- **Ollama over OpenAI** — zero cost, no API key, runs locally; the chatbot degrades gracefully to deterministic rule-based replies when Ollama is unavailable
- **express-session over JWT** — OAuth tokens (which can be megabytes) live server-side; the browser only holds a session cookie

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Browser (React SPA)                         │
│                                                                     │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐  ┌────────────────┐    │
│  │  Login   │  │ Dashboard │  │  Events  │  │  Search Page   │    │
│  │  Page    │  │   Page    │  │   Page   │  │                │    │
│  └──────────┘  └───────────┘  └──────────┘  └────────────────┘    │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │               ChatWidget  (floating, always visible)        │    │
│  │  User types → POST /api/chat → Reply + optional Yes/No btns │    │
│  └────────────────────────────────────────────────────────────┘    │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ HTTP (same-origin, no CORS needed)
┌───────────────────────────────▼─────────────────────────────────────┐
│                    Express.js  server.js  :3000                     │
│                                                                     │
│  ┌──────────────┐  ┌────────────────┐  ┌───────────────────────┐  │
│  │  Auth Routes │  │  Event Routes  │  │  Chat Router          │  │
│  │  /auth/google│  │  GET  /events  │  │  POST /api/chat       │  │
│  │  /oauth2cb   │  │  POST /events  │  │  routes/chat.js       │  │
│  │  /api/local/ │  │  PATCH /:id    │  │  ── NLP engine        │  │
│  │              │  │  DELETE /:id   │  │  ── Mutation handler  │  │
│  └──────┬───────┘  └───────┬────────┘  └──────────┬────────────┘  │
│         │                  │                       │               │
│  ┌──────▼───────┐  ┌───────▼────────┐  ┌──────────▼────────────┐  │
│  │ Google OAuth │  │ Google Calendar│  │  utils/ollama.js       │  │
│  │ googleapis   │  │ API v3         │  │  HTTP → localhost:11434│  │
│  └──────────────┘  └───────┬────────┘  └───────────────────────┘  │
│                             │                                       │
└─────────────────────────────┼───────────────────────────────────────┘
                              │  upsertFullEvents / markEventDeleted
                              │  refreshAndPersistLatest
             ┌────────────────▼──────────────────────────┐
             │              MongoDB Atlas                 │
             │                                           │
             │  calendar_events    ← searchable event store
             │  event_snapshots    ← latest-list cache    │
             │  user_profiles      ← encrypted OAuth tokens
             │  users              ← local admin auth     │
             └───────────────────────────────────────────┘
```

---

## Application Flow Diagrams

### First-Time Setup Flow

```
New Machine / Fresh Clone
          │
          ▼
┌─────────────────────────────────────┐
│   install-dependencies.bat          │
│                                     │
│   1. Checks Node.js is installed    │
│   2. npm install  (backend)         │
│   3. npm install  (client/)         │
│   4. npm run client:build           │
│      → builds React → public/       │
│   5. Copies .env.example → .env     │
│   6. Prints setup instructions      │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│   Fill in .env                      │
│                                     │
│   GOOGLE_CLIENT_ID=...              │
│   GOOGLE_CLIENT_SECRET=...          │
│   SESSION_SECRET=...                │
│   MONGODB_URI=...                   │
└──────────────────┬──────────────────┘
                   │
                   ▼
┌─────────────────────────────────────┐
│   run-project.bat                   │
│                                     │
│   Checks (no installs):             │
│   ✓ node found                      │
│   ✓ node_modules/ exists            │
│   ✓ public/index.html exists        │
│   ✓ .env credentials present        │
│                                     │
│   Actions:                          │
│   → Kills any process on :3000      │
│   → Starts Ollama if available      │
│   → node server.js  (new window)    │
│   → Polls :3000 until ready         │
│   → Opens http://localhost:3000     │
└─────────────────────────────────────┘
```

---

### Authentication Flow

The app uses a **two-layer auth system**: local login first (who are you?), then Google OAuth (grant calendar access).

```
User visits http://localhost:3000
                │
                ▼
        GET /api/local/me
                │
          authenticated?
        ┌───────┴───────┐
       NO              YES
        │               │
        ▼               ▼
   /login page    Has Google tokens?
   (admin/admin)  ┌──────┴──────┐
        │        NO            YES
        │         │              │
        │         ▼              ▼
        │    Dashboard        App fully ready
        │    shows:           (Events, Search,
        │    "Connect         Chat all work)
        │    Google"
        │         │
        └─────────┘
               │
               ▼
        GET /auth/google
               │   (generates random state, stores in session)
               ▼
        Redirects to Google:
        accounts.google.com/o/oauth2/auth
        ?scope=calendar.events+email+profile
        &state=<random>
        &redirect_uri=http://localhost:3000/oauth2callback
               │
        User approves in Google UI
               │
               ▼
        GET /oauth2callback?code=...&state=...
               │
               ├── Verify state matches session (CSRF protection)
               ├── Exchange code for { access_token, refresh_token }
               ├── Fetch user profile (email, name, picture)
               ├── Encrypt tokens with AES-256-GCM
               ├── Store encrypted tokens in MongoDB user_profiles
               ├── Auto-sync events: Google Calendar → MongoDB
               └── Redirect to dashboard (/app.html)
```

---

### Chat Agent Decision Flow

Every `POST /api/chat` message passes through this pipeline in order:

```
User sends a message
        │
        ▼
POST /api/chat  { message: "..." }
        │
        ├─ No email in session?
        │  → "Connect Google first"  (400)
        │
        ▼
┌──────────────────────────────────────────────────┐
│  STAGE 1 — Pending Confirmation Check            │
│                                                  │
│  Is req.session.pendingChatAction set?           │
│           │                                      │
│     ┌─────┴──────┐                               │
│    YES            NO ──────────────────► STAGE 2 │
│     │                                            │
│  isConfirmation(message)?                        │
│  ("yes","ok","sure","confirm",...)               │
│     │                                            │
│   ┌─┴─┐                                          │
│  YES  NO/("no","cancel","nevermind")             │
│   │      └─── Clear session                      │
│   │           → "Action cancelled"               │
│   ▼                                              │
│  Execute stored action:                          │
│  ├── type:'delete'                               │
│  │   google.events.delete(eventId)               │
│  │   markEventDeleted(email, eventId)            │
│  │   refreshAndPersistLatest(req)                │
│  │   → "Done! Deleted 'X'"                       │
│  │                                               │
│  └── type:'update'                               │
│      google.events.patch(eventId, updates)       │
│      upsertFullEvents(email, [updated])          │
│      refreshAndPersistLatest(req)                │
│      → "Done! Updated 'X'"                       │
└──────────────────────────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────┐
│  STAGE 2 — Mutation Intent Detection             │
│                                                  │
│  detectMutationIntent(message)                   │
│  Looks for: delete/remove/cancel                 │
│             create/add/schedule/book             │
│             move/reschedule/shift/change         │
│           │                                      │
│    ┌──────┼──────────┐                           │
│  DELETE  CREATE   UPDATE                         │
│    │       │         │                           │
│    ▼       ▼         ▼                           │
│  Search  Parse    Search +                       │
│  MongoDB details  Parse new                      │
│  for event from   date/time                      │
│    │     message      │                          │
│    │       │          │                          │
│    ▼       ▼          ▼                          │
│  Store  Create in  Store in                      │
│  in     Google Cal session,                      │
│  session + MongoDB  ask confirm                  │
│  ask    + sync      → Yes/No                     │
│  confirm            reply                        │
└──────────────────────────────────────────────────┘
        │
        ▼  (only reached if no mutation matched)
┌──────────────────────────────────────────────────┐
│  STAGE 3 — Read Query (original behavior)        │
│                                                  │
│  detectIntent(message) →                         │
│  { wantsCount, wantsNext, asksWhen,              │
│    asksWhere, asksWho, durationFilter, ... }     │
│           │                                      │
│  parseDateWindowHeuristic →                      │
│  { start, end, label }  (today/tomorrow/etc.)    │
│           │                                      │
│  tokenizeQuery(message) → search tokens          │
│           │                                      │
│  Query MongoDB calendar_events                   │
│  Filter by window + tokens                       │
│  Rank by relevance                               │
│           │                                      │
│  Generate reply:                                 │
│  ├── Deterministic template (always works)       │
│  └── Ollama LLM (if CHAT_USE_LLM_REPLY=true)     │
└──────────────────────────────────────────────────┘
        │
        ▼
Return JSON:
{
  reply: "...",
  requiresConfirmation: true/false,
  actionCompleted: { type, eventId } | null
}
```

---

### Data Sync Flow

**Rule: Google Calendar is the source of truth. MongoDB is the local mirror.**
Every write hits Google first, then MongoDB is updated immediately after.

```
Any write operation (Chat or UI)
              │
              ▼
┌─────────────────────────────────────┐
│  Step 1: Write to Google Calendar   │
│                                     │
│  CREATE  → events.insert(requestBody)
│  UPDATE  → events.patch(id, changes)│
│  DELETE  → events.delete(id)        │
└───────────────────┬─────────────────┘
                    │
             Google Calendar updated ✓
                    │
                    ▼
┌─────────────────────────────────────┐
│  Step 2: Mirror to MongoDB          │
│                                     │
│  CREATE / UPDATE:                   │
│  upsertFullEvents(email, [event])   │
│  ├── Writes full event document     │
│  ├── Generates searchTokens array   │
│  ├── Sets startAt / endAt (Dates)   │
│  └── Updates lastSyncedAt           │
│                                     │
│  DELETE:                            │
│  markEventDeleted(email, eventId)   │
│  ├── Sets deletedAt: new Date()     │
│  └── Sets status: 'cancelled'       │
└───────────────────┬─────────────────┘
                    │
                    ▼
┌─────────────────────────────────────┐
│  Step 3: Full Re-sync               │
│                                     │
│  refreshAndPersistLatest(req)       │
│  ├── Calls events.list() from Google│
│  ├── upsertFullEvents (all events)  │
│  └── saveEventsSnapshot (cache)     │
└─────────────────────────────────────┘
                    │
                    ▼
         Google Calendar = MongoDB ✓
         (both contain identical data)
```

**Why sync to MongoDB at all?**
| Reason | Detail |
|---|---|
| Speed | MongoDB query: ~5ms. Google API call: ~200–500ms |
| Rate limits | Google Calendar API: 1M queries/day per project |
| Rich search | MongoDB indexes searchTokens, dates, attendees |
| Offline reads | Chat can answer questions even if Google API is down |
| Enriched fields | searchTokens, attendeeNames not stored natively in Google |

---

### Delete Event Flow (with Confirmation)

```
User: "delete the nose checkup"
              │
              ▼
detectMutationIntent → { action: 'delete' }
              │
              ▼
extractEventRefFromMessage → "nose checkup"
              │
              ▼
tokenizeQuery("nose checkup") → ["nose", "checkup"]
              │
              ▼
MongoDB query:
  calendar_events WHERE
  email = user@gmail.com
  AND searchTokens IN ["nose","checkup"]
  AND deletedAt IS NULL
  AND status != 'cancelled'
              │
         ┌────┴────────┐
     0 results     1+ results
         │               │
         ▼               ▼
  "I couldn't       rankEventsByText()
   find that        preferExactSummaryMatches()
   event"                │
                    ┌────┴────┐
                 1 result   Multiple
                    │           │
                    ▼           ▼
   req.session.pendingChatAction = {    "Found multiple.
     type: 'delete',                    Be more specific"
     eventId: 'abc123',
     eventSummary: 'Nose checkup'
   }
                    │
                    ▼
   Response:
   {
     reply: "Found 'Nose checkup' on Thu Apr 30 at 2:30 PM.
             Are you sure you want to permanently delete it?
             Reply yes to confirm or no to cancel.",
     requiresConfirmation: true       ← ChatWidget shows Yes/No buttons
   }
                    │
         ┌──────────┴──────────┐
        YES                    NO
         │                      │
         ▼                      ▼
   Clear pendingChatAction  Clear pendingChatAction
         │                  "Action cancelled"
         ▼
   google.events.delete('abc123')   ← Google Calendar
         │
   markEventDeleted(email,'abc123') ← MongoDB
   { deletedAt: now, status:'cancelled' }
         │
   refreshAndPersistLatest(req)     ← re-sync both
         │
         ▼
   Response: {
     reply: "Done! Deleted 'Nose checkup'
             from your Google Calendar ✓",
     actionCompleted: { type:'delete', eventId:'abc123' }
   }
```

---

### Create Event Flow

```
User: "Create a project review on April 5 at 2 PM for 1 hour"
              │
              ▼
detectMutationIntent → { action: 'create' }
              │
              ▼
parseCreateEventDetails(message, now):
┌────────────────────────────────────────────────┐
│                                                │
│  Title extraction (regex patterns):            │
│  "project review"  ← from "create a X on"     │
│                                                │
│  Date: parseDateString(text) → Apr 5 2026      │
│  OR    parseDateWindowHeuristic → (relative)   │
│  (specific date tried FIRST)                   │
│                                                │
│  Time: parseTimeFromText("2 PM") → { h:14,m:0}│
│  Supports: "2 PM", "2pm", "14:00", "2.30PM"   │
│                                                │
│  Duration: parseDurationFromText("for 1 hour") │
│  → 60 minutes                                  │
│                                                │
│  startDateTime = 2026-04-05T14:00:00.000Z      │
│  endDateTime   = 2026-04-05T15:00:00.000Z      │
└────────────────────────────────────────────────┘
              │
      Summary present?   Date/Time present?
      ┌────────┴────┐    ┌────────┴─────┐
     NO            YES  NO             YES
      │                  │
      ▼                  ▼
  "What should     "What date and
   I call it?"      time for
                    'Project Review'?"
              │
              ▼
google.calendar.events.insert({
  summary: "Project Review",
  start: { dateTime: "2026-04-05T14:00:00.000Z" },
  end:   { dateTime: "2026-04-05T15:00:00.000Z" }
})
              │
upsertFullEvents(email, 'primary', [newEvent])
              │
refreshAndPersistLatest(req)
              │
              ▼
Response: {
  reply: "Done! Created 'Project Review'
         📅 Starts: Sun, Apr 5, 2026 2:00 PM
         ⏰ Ends:   Sun, Apr 5, 2026 3:00 PM",
  actionCompleted: { type: 'create', eventId: 'xyz' }
}
```

---

### Move / Reschedule Event Flow

```
User: "Move the nose checkup to November 29 2026 at 9 PM"
              │
              ▼
detectMutationIntent → { action: 'update' }
              │
              ▼
extractEventRefFromMessage → "nose checkup"
  (strips "move the ... to November...")
              │
              ▼
tokenizeQuery → ["nose", "checkup"]
              │
              ▼
MongoDB query → finds "Nose checkup"
              │
              ▼
parseUpdateEventDetails(message, now):
┌──────────────────────────────────────────────────┐
│                                                  │
│  Date parsing order (specific BEFORE relative):  │
│                                                  │
│  1. parseDateString(text)           ← original  │
│     "November" (capital N) → no match           │
│                                                  │
│  2. parseDateString(text.toLowerCase())          │
│     "november 29 2026" → Nov 29 2026  ✓         │
│                                                  │
│  Time: parseTimeFromText("9 PM") → { h:21, m:0 }│
│                                                  │
│  updates = {                                     │
│    start: { dateTime: "2026-11-29T21:00:00Z" }, │
│    end:   { dateTime: "2026-11-29T22:00:00Z" }  │
│  }                                               │
└──────────────────────────────────────────────────┘
              │
              ▼
req.session.pendingChatAction = {
  type: 'update',
  eventId: 'abc123',
  eventSummary: 'Nose checkup',
  updates: { start: {...}, end: {...} }
}
              │
              ▼
Response: {
  reply: "I'll move 'Nose checkup' to
          Sun, Nov 29, 2026, 9:00 PM.
          Shall I proceed? (yes/no)",
  requiresConfirmation: true
}
              │
      User replies "yes"
              │
              ▼
google.events.patch('abc123', {
  start: { dateTime: "2026-11-29T21:00:00Z" },
  end:   { dateTime: "2026-11-29T22:00:00Z" }
})
              │
upsertFullEvents(email, 'primary', [patchedEvent])
              │
refreshAndPersistLatest(req)
              │
              ▼
Response: {
  reply: "Done! Updated 'Nose checkup' —
          changes saved in Google Calendar
          and synced locally ✓",
  actionCompleted: { type: 'update' }
}
```

---

## Project Structure

```
google-calendar-viewer/
│
├── server.js                     Main Express server
│   ├── MongoDB connection and collection setup
│   ├── AES-256-GCM token encryption / decryption
│   ├── Google OAuth2 flow (/auth/google, /oauth2callback)
│   ├── Event CRUD routes (/api/events/*)
│   ├── Agent API routes  (/api/agent/*)
│   ├── Storage sync routes (/api/storage-sync, /api/storage-status)
│   └── Mounts chat router at /api  (POST /api/chat)
│
├── routes/
│   └── chat.js                   Chat engine  — all NLP and mutation logic
│       ├── isConfirmation / isRejection  — "yes"/"no" detection
│       ├── detectMutationIntent         — create/delete/update intent
│       ├── extractEventRefFromMessage   — isolate event name from command
│       ├── parseTimeFromText            — "3 PM", "2.30pm", "14:30"
│       ├── parseDurationFromText        — "for 1 hour", "30 minutes"
│       ├── parseCreateEventDetails      — full event data extraction
│       ├── parseUpdateEventDetails      — new date/time extraction
│       ├── formatEventTimeForChat       — human-readable time strings
│       ├── detectIntent                 — read intent (count/next/when/who...)
│       ├── parseDateWindowHeuristic     — today/tomorrow/next week/etc.
│       ├── rankEventsByText             — relevance scoring
│       ├── generateChatReply            — deterministic or LLM reply
│       └── createChatRouter()           — Express router factory
│
├── utils/
│   ├── ollama.js                 Ollama HTTP client (generate, extractFirstJsonObject)
│   └── queryValidator.js         Input validation helpers
│
├── client/                       React SPA
│   ├── vite.config.js            Vite config (proxies /api → :3000 in dev)
│   └── src/
│       ├── main.jsx              React entry point
│       ├── styles.css            All styles (CSS variables, dark/light theme)
│       ├── App.jsx               Router + AuthContext + ThemeContext + UiContext
│       ├── pages/
│       │   ├── LoginPage.jsx     Local login form (admin/admin by default)
│       │   ├── DashboardPage.jsx Google Calendar connection status + event list
│       │   ├── EventsPage.jsx    Event cards with inline edit/delete UI
│       │   ├── SearchPage.jsx    MongoDB full-text search interface
│       │   └── SettingsPage.jsx  Storage status, sync controls, token info
│       └── components/
│           ├── Layout.jsx        Nav sidebar + header shell
│           ├── ChatWidget.jsx    Floating chat UI
│           │   ├── MessageBubble   renders bold text, line breaks
│           │   ├── Yes/No buttons  shown when requiresConfirmation=true
│           │   ├── Typing dots     animated while waiting for response
│           │   └── Success/warn    coloured left border on action messages
│           └── ui/
│               ├── Button.jsx
│               ├── Card.jsx
│               ├── Input.jsx
│               └── Badge.jsx
│
├── public/                       Built frontend (generated, not committed)
│   ├── index.html
│   └── assets/
│
├── .env                          Credentials — never commit this file
├── .env.example                  Template for .env
├── run-project.bat               Checks deps, starts server, opens browser
├── install-dependencies.bat      First-time full install script
└── README.md                     This file
```

---

## Database Schema

### `calendar_events` — Primary event store, always synced with Google

```js
{
  email:           "user@gmail.com",      // partition key — all queries filter by this
  eventId:         "abc123xyz",           // Google Calendar event ID (unique per email)
  calendarId:      "primary",
  status:          "confirmed",           // "confirmed" | "tentative" | "cancelled"
  summary:         "Team Standup",        // event title
  description:     "Daily sync",
  location:        "Zoom",
  start:           "2026-04-06T10:00:00Z",// raw value from Google (dateTime or date)
  end:             "2026-04-06T10:30:00Z",
  startAt:         Date,                  // parsed — used for range queries
  endAt:           Date,                  // parsed — used for range queries
  creatorEmail:    "creator@example.com",
  organizerEmail:  "org@example.com",
  attendeeEmails:  ["alice@x.com"],
  attendeeNames:   ["Alice"],
  searchTokens:    ["team","standup"],    // indexed — primary chatbot search field
  searchText:      "team standup zoom",  // full searchable string
  googleUpdatedAt: Date,
  lastSyncedAt:    Date,
  deletedAt:       null,                  // set to Date when deleted (soft delete)
  rawEvent:        { ...full Google Calendar event object }
}

Indexes:
  { email: 1, eventId: 1 }       unique compound
  { email: 1, startAt: 1, endAt: 1 }
  { email: 1, searchTokens: 1 }
  { email: 1, googleUpdatedAt: -1 }
  { email: 1, attendeeEmails: 1 }
```

### `event_snapshots` — Latest event list cache (one doc per user)

```js
{
  email:    "user@gmail.com",
  payload: {
    fetchedAt: "2026-04-06T...",
    count:     12,
    events: [
      { id, summary, start, end, status, location, creator, organizer }
      // lightweight — for quick listing
    ]
  },
  queryMeta: { maxResults: 20, timeMin: "..." },
  updatedAt: Date
}

Index: { email: 1 }  unique
```

### `user_profiles` — OAuth tokens + user identity

```js
{
  email:    "user@gmail.com",
  name:     "Alice Smith",
  picture:  "https://lh3.googleusercontent.com/...",
  grantedScopes: [
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/userinfo.email",
    ...
  ],
  googleTokensEncrypted: {
    iv:      "base64...",   // 12-byte random IV for AES-GCM
    content: "base64...",   // AES-256-GCM encrypted { access_token, refresh_token, ... }
    tag:     "base64..."    // GCM authentication tag (prevents tampering)
  },
  googleTokensUpdatedAt: Date,
  lastLoginAt: Date
}

Index: { email: 1 }  unique
```

### `users` — Local admin authentication

```js
{
  username:    "admin",
  password: {
    salt: "a3f1...hex",      // random 16 bytes, unique per user
    hash: "9b2e...hex"       // PBKDF2-SHA512, 100,000 iterations
  },
  createdAt:   Date,
  lastLoginAt: Date
}

Index: { username: 1 }  unique
```

---

## API Reference

### Authentication

| Method | Endpoint | Requires | Description |
|---|---|---|---|
| `POST` | `/api/local/login` | none | `{ username, password }` → sets session |
| `POST` | `/api/local/logout` | Local session | Clears local session |
| `GET` | `/api/local/me` | none | Returns `{ authenticated: true/false }` |
| `GET` | `/auth/google` | Local session | Starts Google OAuth flow |
| `GET` | `/oauth2callback` | Local session | Handles Google redirect, syncs events |
| `POST` | `/auth/logout` | Local session | Clears Google tokens from session |

### Chat (Agentic)

| Method | Endpoint | Requires | Description |
|---|---|---|---|
| `POST` | `/api/chat` | Local + Google connected | Send a natural language message |

**Request:**
```json
{ "message": "Move the standup to tomorrow at 4 PM" }
```

**Response (normal read query):**
```json
{
  "reply": "Your next event is 'Team Standup' on Mon Apr 6 at 10:00 AM."
}
```

**Response (confirmation needed):**
```json
{
  "reply": "I'll move 'Team Standup' to Tue, Apr 7, 2026 at 4:00 PM.\nShall I proceed? (yes/no)",
  "requiresConfirmation": true,
  "pendingAction": { "type": "update", "eventSummary": "Team Standup", "newTime": "Tue, Apr 7..." }
}
```

**Response (action completed):**
```json
{
  "reply": "Done! Updated 'Team Standup' — changes saved in Google Calendar and synced locally.",
  "actionCompleted": { "type": "update", "eventId": "abc123" }
}
```

### Events (UI)

| Method | Endpoint | Requires | Description |
|---|---|---|---|
| `GET` | `/api/events` | Local + Google | Fetch events from Google + sync to MongoDB |
| `GET` | `/api/events/:id` | Local + Google | Get a single event |
| `POST` | `/api/events` | Local + Google | Create an event `{ summary, start, end, ... }` |
| `PATCH` | `/api/events/:id` | Local + Google | Update an event |
| `DELETE` | `/api/events/:id` | Local + Google | Delete an event |
| `POST` | `/api/events/:id/cancel` | Local + Google | Cancel and notify attendees |
| `POST` | `/api/events/search` | Local + Google | Search MongoDB events |
| `GET` | `/api/events/download` | Local + Google | Download events as JSON file |
| `POST` | `/api/storage-sync` | Local + Google | Force full re-sync Google → MongoDB |
| `GET` | `/api/storage-status` | Local + Google | Check sync status and counts |

### Agent API (programmatic / automation)

All agent routes require header: `x-agent-api-key: <AGENT_API_KEY from .env>`

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/agent/events/search` | Search events for `userEmail` |
| `POST` | `/api/agent/events` | Create an event for `userEmail` |
| `PATCH` | `/api/agent/events/:id` | Update an event |
| `DELETE` | `/api/agent/events/:id` | Delete an event |

---

## Environment Variables

```bash
# ── Google OAuth (required) ────────────────────────────────────────────────
# Get from: https://console.cloud.google.com → APIs & Services → Credentials
GOOGLE_CLIENT_ID=your_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...
GOOGLE_REDIRECT_URI=http://localhost:3000/oauth2callback
# Must exactly match an Authorized Redirect URI in your OAuth2 client config.

# ── Security (required) ────────────────────────────────────────────────────
SESSION_SECRET=any-long-random-string-here
# Signs session cookies. Change if deploying publicly.

AGENT_API_KEY=another-long-random-string
# Required header value for /api/agent/* routes.

GOOGLE_TOKEN_ENCRYPTION_SECRET=yet-another-long-random-string
# Derives the AES-256-GCM key used to encrypt Google OAuth tokens in MongoDB.

# ── Server ─────────────────────────────────────────────────────────────────
PORT=3000

# ── MongoDB Atlas (required) ───────────────────────────────────────────────
# Get from: https://cloud.mongodb.com → Connect → Drivers
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/
MONGODB_DB_NAME=google_calendar_viewer
# Collections are created automatically on first run.

# ── Ollama — optional local LLM ────────────────────────────────────────────
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=llama3          # any model you've pulled: ollama pull llama3
OLLAMA_TIMEOUT_MS=60000

# These all default to false. The app works fully without Ollama.
CHAT_USE_LLM_INTENT=false           # LLM parses intent from the user message
CHAT_USE_LLM_REPLY=false            # LLM generates the reply text
CHAT_USE_LLM_SEMANTIC_FALLBACK=false # LLM handles complex semantic queries

# ── n8n workflow integration — optional ────────────────────────────────────
N8N_CHAT_ENABLED=false
N8N_CHAT_WEBHOOK_URL=https://your-n8n.example/webhook/calendar-chatbot
N8N_CHAT_TIMEOUT_MS=60000
N8N_CHAT_API_KEY=
```

---

## Getting Started

### Prerequisites

| Tool | Required | Notes |
|---|---|---|
| Node.js 18+ | Yes | https://nodejs.org |
| MongoDB Atlas account | Yes | Free M0 tier works — https://mongodb.com/atlas |
| Google Cloud project | Yes | https://console.cloud.google.com |
| Ollama | No | Enhances chat replies — https://ollama.com |

### Step 1 — Google Cloud Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a new project (or select an existing one)
3. Enable **Google Calendar API** under *APIs & Services → Library*
4. Go to *APIs & Services → Credentials* → **Create Credentials → OAuth 2.0 Client ID**
   - Application type: **Web application**
   - Authorized redirect URI: `http://localhost:3000/oauth2callback`
5. Copy the **Client ID** and **Client Secret** into `.env`

### Step 2 — MongoDB Atlas Setup

1. Create a free cluster at [mongodb.com/atlas](https://www.mongodb.com/cloud/atlas/register)
2. Create a database user with **Read and Write** access
3. Network Access → Add IP Address → allow your IP (or `0.0.0.0/0` for development)
4. Connect → Drivers → copy the connection string into `MONGODB_URI` in `.env`
   - Replace `<username>` and `<password>` with your database user credentials
   - All collections and indexes are created automatically on first run

### Step 3 — Install and Start

```bat
REM First time only — installs everything and builds frontend:
install-dependencies.bat

REM Edit .env with your credentials (GOOGLE_CLIENT_ID, etc.), then:
run-project.bat
```

The browser opens automatically at `http://localhost:3000`.

### Step 4 — First Login

1. Log in with **admin** / **admin**
2. Click **"Connect Google Calendar"** on the dashboard
3. Approve calendar access in Google's consent screen
4. Events sync automatically — the chatbot is ready

### Changing the Admin Password

```js
// Run this in a Node.js REPL or a one-off script:
const crypto = require('crypto');
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.pbkdf2Sync('YOUR_NEW_PASSWORD', salt, 100000, 64, 'sha512').toString('hex');
console.log({ salt, hash });
// Update the users collection in MongoDB Atlas with these values
```

---

## Chatbot Capabilities

### Supported Phrases

**Read / Query**

| Example message | What it does |
|---|---|
| "How many events do I have this week?" | Count in current week window |
| "What is my next meeting?" | Find the next upcoming event |
| "List my events for tomorrow" | All events on tomorrow |
| "Show me events in April" | All events in April |
| "When is the project review?" | Search by name → return date/time |
| "Where is the standup?" | Return location of matching event |
| "Who is in the team sync?" | Return attendees of matching event |
| "Show events longer than 1 hour" | Duration filter |
| "Show cancelled events" | Query status = cancelled |

**Mutations**

| Example message | What it does |
|---|---|
| "Delete the nose checkup" | Find → ask yes/no → delete from GCal + MongoDB |
| "Create a meeting on April 5 at 2 PM" | Parse details → create in GCal → sync |
| "Schedule a standup for Friday at 9 AM for 30 minutes" | Create with custom duration |
| "Move the standup to 4 PM tomorrow" | Find → ask confirmation → move in GCal + MongoDB |
| "Reschedule nose checkup to Nov 29 2026 at 9 PM" | Parse specific date → ask confirm → update |
| "Shift the checkup to 10/30/2026 at 2.30PM" | Slash date + dot-notation time → update |
| "yes" / "ok" / "sure" / "go ahead" | Confirm pending action |
| "no" / "cancel" / "nevermind" | Cancel pending action |

### Date and Time Formats Understood

| Input format | Example | Parsed as |
|---|---|---|
| Relative day | "today", "tomorrow", "yesterday" | Relative to current date |
| Relative period | "next week", "this month", "next month" | Period windows |
| Named month + day | "April 5", "Nov 29 2026" | Specific date |
| Day-first format | "29th November 2026", "5th April" | Specific date |
| Slash format | "10/30/2026", "4/5" | MM/DD/YYYY |
| Time with am/pm | "3 PM", "9am", "3pm" | Specific time |
| Time with colon | "3:30 PM", "14:30" | Specific time with minutes |
| Time with dot | "2.30PM", "3.30pm" | Specific time with minutes |
| Duration | "for 1 hour", "for 30 minutes", "for 90 minutes" | Event length |

### Ollama LLM Modes

All three flags default to `false`. The bot works fully without Ollama.

| Flag | Effect |
|---|---|
| `CHAT_USE_LLM_INTENT=true` | LLM extracts intent from complex phrasing |
| `CHAT_USE_LLM_REPLY=true` | LLM generates conversational reply text |
| `CHAT_USE_LLM_SEMANTIC_FALLBACK=true` | LLM handles "summarise" / "categorise" queries |

---

## Security Design

### Google Token Encryption

OAuth tokens are never stored in plaintext. Before writing to MongoDB:

```
tokens (JSON)
    │
    ▼
AES-256-GCM encrypt
key  = SHA-256(GOOGLE_TOKEN_ENCRYPTION_SECRET || SESSION_SECRET)
iv   = random 12 bytes (unique per write)
    │
    ▼
MongoDB user_profiles.googleTokensEncrypted = {
  iv:      "<base64>",   // random nonce
  content: "<base64>",   // ciphertext
  tag:     "<base64>"    // GCM auth tag — detects tampering
}
```

Even with full MongoDB access, the tokens are unreadable without `GOOGLE_TOKEN_ENCRYPTION_SECRET`.

### Password Hashing

Local admin passwords use **PBKDF2-SHA512**, 100,000 iterations, random 16-byte salt. This matches the strength of common password managers.

### Session Security

```
cookie: {
  httpOnly: true,    // JavaScript cannot read the cookie
  sameSite: 'lax'   // Prevents CSRF on cross-site requests
}
```

The `SESSION_SECRET` signs cookies with HMAC so they cannot be forged.

### OAuth CSRF Protection

A random 16-byte hex `state` parameter is generated before each OAuth redirect and verified on the callback. A mismatched state returns HTTP 400.

### Pending Action Safety

Destructive operations (delete, move) are stored in the **server-side session** — not in the browser. The confirmation prompt requires the same user's session to confirm. A different user cannot confirm another user's pending action.

---

## npm Scripts Reference

```bash
# ── Server ─────────────────────────────────────────────────────────────────
npm start                  # Start the Express server (production)
npm run dev                # Start with --watch (auto-restart on file changes)

# ── Frontend ───────────────────────────────────────────────────────────────
npm run client:build       # Build React app → public/  (required for production)
npm run client:dev         # Start Vite dev server with HMR on :5173
npm run client:preview     # Preview the production build locally

# ── Testing ────────────────────────────────────────────────────────────────
npm run test:chatbot       # Run offline chatbot unit tests
npm run test:chatbot:live  # Run chatbot tests against a running server

# ── n8n (optional workflow automation) ─────────────────────────────────────
npm run n8n:start          # Start local n8n instance on :5678
```

---

*Built with Node.js · Express.js · React · Vite · MongoDB Atlas · Google Calendar API v3 · Ollama*
