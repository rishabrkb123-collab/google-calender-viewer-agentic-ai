const express = require('express');
const session = require('express-session');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const { google } = require('googleapis');
const dotenv = require('dotenv');
const { createChatRouter } = require('./routes/chat');
const { createOllamaClient } = require('./utils/ollama');

dotenv.config();

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI = 'http://localhost:3000/oauth2callback',
  SESSION_SECRET,
  AGENT_API_KEY = '',
  GOOGLE_TOKEN_ENCRYPTION_SECRET = '',
  MONGODB_URI,
  MONGODB_DB_NAME,
  OLLAMA_BASE_URL = 'http://localhost:11434',
  OLLAMA_MODEL = 'gpt-oss:120b-cloud',
  OLLAMA_TIMEOUT_MS = '60000',
  N8N_CHAT_ENABLED = 'false',
  N8N_CHAT_WEBHOOK_URL = 'http://localhost:5678/webhook/calendar-chatbot',
  N8N_CHAT_TIMEOUT_MS = '60000',
  N8N_CHAT_API_KEY = '',
  PORT = 3000,
} = process.env;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in .env');
  process.exit(1);
}

if (!SESSION_SECRET) {
  console.error('Missing SESSION_SECRET in .env');
  process.exit(1);
}

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI in .env');
  process.exit(1);
}

const app = express();
const mongoClient = new MongoClient(MONGODB_URI);
let eventSnapshotsCollection;
let calendarEventsCollection;
let userProfilesCollection;
let usersCollection;
let resolvedMongoDbName;

function safeFileId(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function buildTokenCipherKey() {
  return crypto
    .createHash('sha256')
    .update(String(GOOGLE_TOKEN_ENCRYPTION_SECRET || SESSION_SECRET || 'change-me'))
    .digest();
}

const GOOGLE_TOKEN_CIPHER_KEY = buildTokenCipherKey();

function encryptTokens(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', GOOGLE_TOKEN_CIPHER_KEY, iv);
  const plaintext = JSON.stringify(tokens);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    content: encrypted.toString('base64'),
    tag: tag.toString('base64'),
  };
}

function decryptTokens(payload) {
  if (!payload?.iv || !payload?.content || !payload?.tag) return null;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      GOOGLE_TOKEN_CIPHER_KEY,
      Buffer.from(payload.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.content, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (error) {
    console.warn('Failed to decrypt stored Google tokens:', error?.message || error);
    return null;
  }
}

function resolveMongoDbName() {
  const envDb = String(MONGODB_DB_NAME || '').trim();
  if (envDb) return envDb;
  try {
    const parsed = new URL(MONGODB_URI);
    const fromPath = parsed.pathname.replace(/^\//, '').trim();
    return fromPath || 'test';
  } catch {
    return 'test';
  }
}

function buildOAuthClient(redirectUri) {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, redirectUri);
}

function getRedirectUriForRequest(req) {
  const configured = String(GOOGLE_REDIRECT_URI || '').trim();
  if (configured) return configured;
  const host = req.get('host') || `localhost:${PORT}`;
  return `http://${host}/oauth2callback`;
}

function getOAuthClientForRequest(req) {
  const redirectUri = req.session?.oauthRedirectUri || getRedirectUriForRequest(req);
  const client = buildOAuthClient(redirectUri);
  if (req.session?.tokens) {
    client.setCredentials(req.session.tokens);
  }
  return client;
}

function clearGoogleSession(req) {
  req.session.tokens = undefined;
  req.session.user = undefined;
  req.session.grantedScopes = undefined;
  req.session.lastEventsQuery = undefined;
  req.session.oauthState = undefined;
  req.session.oauthRedirectUri = undefined;
}

async function resolveSessionUser(req, { forceRefresh = false } = {}) {
  if (!req.session?.tokens) return null;

  if (!forceRefresh && req.session?.user?.email) {
    return req.session.user;
  }

  try {
    const oauthClient = getOAuthClientForRequest(req);
    const oauth2 = google.oauth2({ auth: oauthClient, version: 'v2' });
    const profile = await oauth2.userinfo.get();
    const user = {
      name: profile.data.name || null,
      email: profile.data.email || null,
      picture: profile.data.picture || null,
    };
    req.session.user = user;
    return user;
  } catch (error) {
    console.warn('Failed to resolve Google session user:', error?.message || error);
    return req.session?.user || null;
  }
}

async function getSessionEmail(req, options = {}) {
  const user = await resolveSessionUser(req, options);
  const email = user?.email;
  return typeof email === 'string' && email.trim() ? email.trim() : null;
}

function requireLocalAuth(req, res, next) {
  if (!req.session?.localUser) {
    return res.status(401).json({ message: 'Local login required.' });
  }
  return next();
}

function hashPassword(password, salt) {
  const actualSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), actualSalt, 100000, 64, 'sha512').toString('hex');
  return { salt: actualSalt, hash };
}

function verifyPassword(password, stored) {
  if (!stored?.salt || !stored?.hash) return false;
  const attempt = crypto.pbkdf2Sync(String(password), stored.salt, 100000, 64, 'sha512').toString('hex');
  return crypto.timingSafeEqual(Buffer.from(attempt), Buffer.from(stored.hash));
}

async function ensureAdminUser() {
  const existing = await usersCollection.findOne({ username: 'admin' });
  if (existing) return;
  const { salt, hash } = hashPassword('admin');
  await usersCollection.insertOne({
    username: 'admin',
    password: { salt, hash },
    createdAt: new Date(),
    lastLoginAt: null,
  });
  console.log('Seeded default admin user (admin/admin).');
}

async function initMongo() {
  await mongoClient.connect();
  resolvedMongoDbName = resolveMongoDbName();
  const db = mongoClient.db(resolvedMongoDbName);
  eventSnapshotsCollection = db.collection('event_snapshots');
  calendarEventsCollection = db.collection('calendar_events');
  userProfilesCollection = db.collection('user_profiles');
  usersCollection = db.collection('users');
  await eventSnapshotsCollection.createIndex({ email: 1 }, { unique: true });
  await calendarEventsCollection.createIndex({ email: 1, eventId: 1 }, { unique: true });
  await calendarEventsCollection.createIndex({ email: 1, googleUpdatedAt: -1 });
  await calendarEventsCollection.createIndex({ email: 1, startAt: 1, endAt: 1 });
  await calendarEventsCollection.createIndex({ email: 1, searchTokens: 1 });
  await calendarEventsCollection.createIndex({ email: 1, attendeeEmails: 1 });
  await userProfilesCollection.createIndex({ email: 1 }, { unique: true });
  await usersCollection.createIndex({ username: 1 }, { unique: true });
  await backfillCalendarEventSearchFields();
  await ensureAdminUser();
  console.log(
    `MongoDB connected. DB=${resolvedMongoDbName}, collections=event_snapshots,calendar_events,user_profiles,users`
  );
}

async function saveEventsSnapshot(email, payload, queryMeta) {
  const result = await eventSnapshotsCollection.updateOne(
    { email },
    {
      $set: {
        email,
        payload,
        queryMeta,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
  return result;
}

async function getEventsSnapshot(email) {
  const doc = await eventSnapshotsCollection.findOne({ email });
  return doc?.payload || null;
}

async function upsertUserProfile(user, grantedScopes, options = {}) {
  if (!user?.email) return;
  const setPayload = {
    email: user.email,
    name: user.name || null,
    picture: user.picture || null,
    grantedScopes: Array.isArray(grantedScopes) ? grantedScopes : [],
    lastLoginAt: new Date(),
  };

  if (options.tokens && typeof options.tokens === 'object') {
    setPayload.googleTokensEncrypted = encryptTokens(options.tokens);
    setPayload.googleTokensUpdatedAt = new Date();
  }

  await userProfilesCollection.updateOne(
    { email: user.email },
    {
      $set: setPayload,
    },
    { upsert: true }
  );
}

async function saveUserGoogleTokens(email, tokens) {
  if (!email || !tokens || typeof tokens !== 'object') return;
  await userProfilesCollection.updateOne(
    { email },
    {
      $set: {
        googleTokensEncrypted: encryptTokens(tokens),
        googleTokensUpdatedAt: new Date(),
      },
    },
    { upsert: false }
  );
}

async function getStoredGoogleTokens(email) {
  if (!email) return null;
  const profile = await userProfilesCollection.findOne(
    { email },
    { projection: { _id: 0, googleTokensEncrypted: 1 } }
  );
  return decryptTokens(profile?.googleTokensEncrypted);
}

function attachTokenPersistence(oauthClient, email) {
  oauthClient.on('tokens', async (tokens) => {
    try {
      const merged = {
        ...oauthClient.credentials,
        ...tokens,
      };
      await saveUserGoogleTokens(email, merged);
    } catch (error) {
      console.warn(`Failed to persist refreshed Google tokens for ${email}:`, error?.message || error);
    }
  });
}

async function getOAuthClientForEmail(email) {
  const tokens = await getStoredGoogleTokens(email);
  if (!tokens?.access_token && !tokens?.refresh_token) {
    throw new Error(`No stored Google tokens found for ${email}. Reconnect Google in the app.`);
  }
  const client = buildOAuthClient(GOOGLE_REDIRECT_URI);
  client.setCredentials(tokens);
  attachTokenPersistence(client, email);
  return client;
}

function getEventStartValue(event) {
  return event?.start?.dateTime || event?.start?.date || null;
}

function getEventEndValue(event) {
  return event?.end?.dateTime || event?.end?.date || null;
}

function toDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function startOfWeek(date) {
  const day = date.getDay(); // Sunday = 0
  const start = new Date(date);
  start.setDate(date.getDate() - day);
  return startOfDay(start);
}

function endOfWeek(date) {
  const start = startOfWeek(date);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return endOfDay(end);
}

function parseDateString(input, now) {
  const text = String(input || '').trim().toLowerCase();
  if (!text) return null;

  const isoMatch = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const year = Number(isoMatch[1]);
    const month = Number(isoMatch[2]) - 1;
    const day = Number(isoMatch[3]);
    const d = new Date(year, month, day);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const slashMatch = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slashMatch) {
    const month = Number(slashMatch[1]) - 1;
    const day = Number(slashMatch[2]);
    let year = slashMatch[3] ? Number(slashMatch[3]) : now.getFullYear();
    if (year < 100) year += 2000;
    const d = new Date(year, month, day);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const monthNames = {
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, sept: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11,
  };

  const monthMatch = text.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/
  );
  if (monthMatch) {
    const monthKey = monthMatch[1];
    const month = monthNames[monthKey];
    const day = Number(monthMatch[2]);
    const year = monthMatch[3] ? Number(monthMatch[3]) : now.getFullYear();
    const d = new Date(year, month, day);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  return null;
}

function parseDateRangeFromMessage(message, now) {
  const text = String(message || '').toLowerCase();
  if (!text.trim()) return null;

  if (/\btoday\b/.test(text)) {
    return { start: startOfDay(now), end: endOfDay(now), label: 'today' };
  }
  if (/\btomorrow\b/.test(text)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return { start: startOfDay(d), end: endOfDay(d), label: 'tomorrow' };
  }
  if (/\byesterday\b/.test(text)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return { start: startOfDay(d), end: endOfDay(d), label: 'yesterday' };
  }
  if (/\bthis week\b/.test(text)) {
    return { start: startOfWeek(now), end: endOfWeek(now), label: 'this week' };
  }
  if (/\bnext week\b/.test(text)) {
    const next = new Date(now);
    next.setDate(next.getDate() + 7);
    return { start: startOfWeek(next), end: endOfWeek(next), label: 'next week' };
  }

  const weekOfMatch = text.match(/\bweek\s+(?:of|starting)\s+(.+)\b/);
  if (weekOfMatch?.[1]) {
    const date = parseDateString(weekOfMatch[1], now);
    if (date) {
      return { start: startOfWeek(date), end: endOfWeek(date), label: 'week of' };
    }
  }

  const onMatch = text.match(/\bon\s+([a-z0-9,\-/\s]+)\b/);
  if (onMatch?.[1]) {
    const date = parseDateString(onMatch[1], now);
    if (date) {
      return { start: startOfDay(date), end: endOfDay(date), label: 'on date' };
    }
  }

  const directDate = parseDateString(text, now);
  if (directDate) {
    return { start: startOfDay(directDate), end: endOfDay(directDate), label: 'date' };
  }

  return null;
}

function eventOverlapsRange(event, range) {
  if (!range?.start || !range?.end) return false;
  const startVal = event?.start;
  const endVal = event?.end || event?.start;
  const start = toDateOrNull(startVal);
  const end = toDateOrNull(endVal) || start;
  if (!start) return false;
  return start <= range.end && end >= range.start;
}

function formatEventForChat(eventDoc) {
  const raw = eventDoc?.rawEvent || {};
  const summary = raw.summary || eventDoc.summary || '(No title)';
  const description = raw.description || eventDoc.description || '';
  const location = raw.location || eventDoc.location || '';
  const start = raw.start?.dateTime || raw.start?.date || eventDoc.start || '';
  const end = raw.end?.dateTime || raw.end?.date || eventDoc.end || '';
  return { summary, description, location, start, end };
}

function extractLabeledValue(text, label) {
  if (!text) return '';
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(new RegExp(`\\b${label}\\b\\s*[:\\-]\\s*(.+)$`, 'i'));
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function extractPatientAndTreatment(event) {
  const summary = event.summary || '';
  const description = event.description || '';

  const patientFromDesc = extractLabeledValue(description, 'patient');
  const treatmentFromDesc = extractLabeledValue(description, 'treatment');
  const patientFromSummary = extractLabeledValue(summary, 'patient');
  const treatmentFromSummary = extractLabeledValue(summary, 'treatment');

  let patient = patientFromDesc || patientFromSummary;
  let treatment = treatmentFromDesc || treatmentFromSummary;

  if (!patient || !treatment) {
    const parts = String(summary).split(/\s*[-|]\s*/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      patient = patient || parts[0];
      treatment = treatment || parts.slice(1).join(' - ');
    }
  }

  return {
    patientName: patient || '',
    treatmentType: treatment || '',
  };
}

function tokenizeQuery(text) {
  const stop = new Set([
    'the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'with', 'in', 'on', 'at',
    'is', 'are', 'was', 'were', 'be', 'by', 'from', 'this', 'that', 'these', 'those',
    'show', 'list', 'find', 'about', 'event', 'events', 'calendar',
  ]);
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s:-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !stop.has(w));
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

function buildEventSearchDocument(event) {
  const attendeeEmails = uniqueStrings((event.attendees || []).map((attendee) => attendee?.email));
  const attendeeNames = uniqueStrings((event.attendees || []).map((attendee) => attendee?.displayName));
  const { patientName, treatmentType } = extractPatientAndTreatment(event);
  const searchText = [
    event.summary,
    event.description,
    event.location,
    event.creator?.email,
    event.organizer?.email,
    ...attendeeEmails,
    ...attendeeNames,
    patientName,
    treatmentType,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    attendeeEmails,
    attendeeNames,
    patientName,
    treatmentType,
    searchText,
    searchTokens: uniqueStrings(tokenizeQuery(searchText)),
    startAt: toDateOrNull(getEventStartValue(event)),
    endAt: toDateOrNull(getEventEndValue(event) || getEventStartValue(event)),
  };
}

function buildStoredEventSearchDocument(doc) {
  const rawEvent = doc?.rawEvent || {};
  return buildEventSearchDocument({
    ...rawEvent,
    summary: rawEvent.summary || doc.summary || '',
    description: rawEvent.description || doc.description || '',
    location: rawEvent.location || doc.location || '',
    start: rawEvent.start || { dateTime: doc.start, date: doc.start },
    end: rawEvent.end || { dateTime: doc.end, date: doc.end },
    creator: rawEvent.creator || { email: doc.creatorEmail || '' },
    organizer: rawEvent.organizer || { email: doc.organizerEmail || '' },
    attendees: Array.isArray(rawEvent.attendees)
      ? rawEvent.attendees
      : [
          ...(Array.isArray(doc.attendeeEmails) ? doc.attendeeEmails.map((email) => ({ email })) : []),
          ...(Array.isArray(doc.attendeeNames) ? doc.attendeeNames.map((displayName) => ({ displayName })) : []),
        ],
  });
}

async function backfillCalendarEventSearchFields() {
  const cursor = calendarEventsCollection.find(
    {
      $or: [
        { searchTokens: { $exists: false } },
        { startAt: { $exists: false } },
        { attendeeEmails: { $exists: false } },
      ],
    },
    {
      projection: {
        _id: 1,
        rawEvent: 1,
        summary: 1,
        description: 1,
        location: 1,
        start: 1,
        end: 1,
        creatorEmail: 1,
        organizerEmail: 1,
        attendeeEmails: 1,
        attendeeNames: 1,
      },
    }
  );

  const ops = [];
  let scanned = 0;
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!doc?._id) continue;
    scanned += 1;
    const searchDoc = buildStoredEventSearchDocument(doc);
    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: {
            attendeeEmails: searchDoc.attendeeEmails,
            attendeeNames: searchDoc.attendeeNames,
            patientName: searchDoc.patientName,
            treatmentType: searchDoc.treatmentType,
            searchText: searchDoc.searchText,
            searchTokens: searchDoc.searchTokens,
            startAt: searchDoc.startAt,
            endAt: searchDoc.endAt,
          },
        },
      },
    });

    if (ops.length >= 200) {
      await calendarEventsCollection.bulkWrite(ops, { ordered: false });
      ops.length = 0;
    }
  }

  if (ops.length) {
    await calendarEventsCollection.bulkWrite(ops, { ordered: false });
  }

  if (scanned > 0) {
    console.log(`Backfilled chat search fields for ${scanned} stored calendar events.`);
  }
}

async function upsertFullEvents(email, calendarId, events, queryMeta) {
  const safeEvents = Array.isArray(events) ? events : [];
  const ops = safeEvents
    .filter((event) => event && typeof event === 'object' && typeof event.id === 'string')
    .map((event) => {
      const searchDoc = buildEventSearchDocument(event);
      return {
        updateOne: {
          filter: { email, eventId: event.id },
          update: {
            $set: {
              email,
              eventId: event.id,
              calendarId,
              status: event.status || null,
              summary: event.summary || null,
              description: event.description || null,
              location: event.location || null,
              htmlLink: event.htmlLink || null,
              creatorEmail: event.creator?.email || null,
              organizerEmail: event.organizer?.email || null,
              attendeeEmails: searchDoc.attendeeEmails,
              attendeeNames: searchDoc.attendeeNames,
              start: getEventStartValue(event),
              end: getEventEndValue(event),
              startAt: searchDoc.startAt,
              endAt: searchDoc.endAt,
              patientName: searchDoc.patientName,
              treatmentType: searchDoc.treatmentType,
              searchText: searchDoc.searchText,
              searchTokens: searchDoc.searchTokens,
              googleUpdatedAt: toDateOrNull(event.updated),
              queryMeta,
              rawEvent: event,
              lastSyncedAt: new Date(),
              deletedAt: null,
            },
          },
          upsert: true,
        },
      };
    });

  if (!ops.length) {
    return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
  }

  const result = await calendarEventsCollection.bulkWrite(ops, { ordered: false });
  return {
    matchedCount: result.matchedCount || 0,
    modifiedCount: result.modifiedCount || 0,
    upsertedCount: result.upsertedCount || 0,
  };
}

async function markEventDeleted(email, eventId) {
  if (!eventId) return;
  await calendarEventsCollection.updateOne(
    { email, eventId },
    {
      $set: {
        email,
        eventId,
        status: 'cancelled',
        deletedAt: new Date(),
        lastSyncedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

function requireAuth(req, res) {
  if (!req.session.tokens) {
    res.status(401).json({ message: 'Not authenticated.' });
    return false;
  }
  return true;
}

function requireAgentApiKey(req, res, next) {
  if (!AGENT_API_KEY) {
    return res.status(503).json({ message: 'AGENT_API_KEY is not configured on the server.' });
  }

  const headerValue = req.get('x-agent-api-key');
  if (!headerValue || headerValue !== AGENT_API_KEY) {
    return res.status(401).json({ message: 'Invalid or missing agent API key.' });
  }

  return next();
}

function resolveAgentUserEmail(req) {
  const candidates = [
    req.get('x-user-email'),
    req.body?.userEmail,
    req.query?.userEmail,
  ];

  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim().toLowerCase();
    }
  }
  return null;
}

function getSendUpdates(value) {
  const v = String(value || '').trim();
  if (!v) return undefined;
  if (v === 'all' || v === 'none' || v === 'externalOnly') return v;
  return undefined;
}

function parseIsoDateTime(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing ${fieldName}.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${fieldName} datetime.`);
  }
  return value;
}

function applyEditableDateTime(requestBody, fieldName, value) {
  if (typeof value === 'string') {
    requestBody[fieldName] = { dateTime: parseIsoDateTime(value, fieldName) };
    return;
  }

  if (value && typeof value === 'object') {
    if (typeof value.date === 'string') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date)) {
        throw new Error(`Invalid ${fieldName} date (expected YYYY-MM-DD).`);
      }
      requestBody[fieldName] = { date: value.date };
      return;
    }

    if (typeof value.dateTime === 'string') {
      const payload = { dateTime: parseIsoDateTime(value.dateTime, fieldName) };
      if (typeof value.timeZone === 'string' && value.timeZone.trim()) {
        payload.timeZone = value.timeZone.trim();
      }
      requestBody[fieldName] = payload;
      return;
    }
  }

  throw new Error(`Invalid ${fieldName} value.`);
}

function normalizeAttendees(attendees) {
  if (!Array.isArray(attendees)) return undefined;
  const normalized = attendees
    .map((attendee) => {
      if (typeof attendee === 'string' && attendee.trim()) {
        return { email: attendee.trim() };
      }
      if (attendee && typeof attendee === 'object') {
        const email = typeof attendee.email === 'string' ? attendee.email.trim() : '';
        const displayName = typeof attendee.displayName === 'string' ? attendee.displayName.trim() : '';
        const resource = attendee.resource === true;
        const optional = attendee.optional === true;
        if (!email && !displayName) return null;
        const payload = {};
        if (email) payload.email = email;
        if (displayName) payload.displayName = displayName;
        if (resource) payload.resource = true;
        if (optional) payload.optional = true;
        return payload;
      }
      return null;
    })
    .filter(Boolean);

  return normalized.length ? normalized : undefined;
}

function buildSearchWindow({ date, timeMin, timeMax }) {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(`${date}T23:59:59.999Z`);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
      return { start, end };
    }
  }

  const start = typeof timeMin === 'string' && timeMin.trim() ? new Date(timeMin) : null;
  const end = typeof timeMax === 'string' && timeMax.trim() ? new Date(timeMax) : null;
  if (start && end && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && start <= end) {
    return { start, end };
  }
  if (start && !Number.isNaN(start.getTime())) {
    return { start, end: null };
  }
  return null;
}

function scoreStoredEvent(event, tokens) {
  if (!tokens.length) return 0;
  const searchTokens = Array.isArray(event.searchTokens) ? event.searchTokens : [];
  let score = 0;
  for (const token of tokens) {
    if (searchTokens.includes(token)) {
      score += 3;
      continue;
    }
    if ((event.summary || '').toLowerCase().includes(token)) {
      score += 2;
      continue;
    }
    if ((event.description || '').toLowerCase().includes(token) || (event.location || '').toLowerCase().includes(token)) {
      score += 1;
    }
  }
  return score;
}

async function searchStoredEvents({
  email,
  query = '',
  summary = '',
  eventId = '',
  date = '',
  timeMin = '',
  timeMax = '',
  includeDeleted = false,
  includeCancelled = false,
  limit = 10,
} = {}) {
  const resolvedLimit = Math.min(Math.max(Number(limit) || 10, 1), 25);
  const tokens = uniqueStrings(tokenizeQuery(`${query} ${summary}`)).slice(0, 8);
  const window = buildSearchWindow({ date, timeMin, timeMax });

  const filter = {
    email,
    ...(includeDeleted ? {} : { $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }] }),
    status: includeCancelled ? { $in: ['confirmed', 'tentative', 'cancelled', null] } : { $ne: 'cancelled' },
  };

  if (typeof eventId === 'string' && eventId.trim()) {
    filter.eventId = eventId.trim();
  }

  if (tokens.length) {
    filter.searchTokens = { $in: tokens };
  }

  if (window?.start && window?.end) {
    filter.startAt = { $lte: window.end };
    filter.endAt = { $gte: window.start };
  } else if (window?.start) {
    filter.endAt = { $gte: window.start };
  }

  const docs = await calendarEventsCollection
    .find(filter, {
      projection: {
        _id: 0,
        eventId: 1,
        calendarId: 1,
        status: 1,
        summary: 1,
        description: 1,
        location: 1,
        start: 1,
        end: 1,
        startAt: 1,
        endAt: 1,
        attendeeEmails: 1,
        attendeeNames: 1,
        searchTokens: 1,
        deletedAt: 1,
        lastSyncedAt: 1,
      },
    })
    .sort({ startAt: 1, summary: 1 })
    .limit(200)
    .toArray();

  const events = docs
    .map((event) => ({
      ...event,
      matchScore: scoreStoredEvent(event, tokens),
    }))
    .sort((a, b) => {
      if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
      const aStart = toDateOrNull(a.startAt || a.start)?.getTime() || 0;
      const bStart = toDateOrNull(b.startAt || b.start)?.getTime() || 0;
      return aStart - bStart;
    })
    .slice(0, resolvedLimit);

  return {
    count: events.length,
    filters: {
      email,
      eventId: typeof eventId === 'string' ? eventId.trim() : '',
      query: String(query || ''),
      summary: String(summary || ''),
      date: String(date || ''),
      timeMin: String(timeMin || ''),
      timeMax: String(timeMax || ''),
      tokens,
    },
    events,
  };
}

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
    },
  })
);

app.use(express.json({ limit: '256kb' }));

app.use(express.static(path.join(__dirname, 'public')));

const ollamaClient = createOllamaClient({
  baseUrl: OLLAMA_BASE_URL,
  model: OLLAMA_MODEL,
  timeoutMs: Number(OLLAMA_TIMEOUT_MS) || 60000,
});

const chatRouter = createChatRouter({
  getCollection: () => calendarEventsCollection,
  getSnapshotCollection: () => eventSnapshotsCollection,
  getSessionEmail,
  requireLocalAuth,
  ollama: ollamaClient,
  refreshEvents: refreshAndPersistForWindow,
  maxResults: 50,
  n8n: {
    enabled: N8N_CHAT_ENABLED === 'true',
    webhookUrl: N8N_CHAT_WEBHOOK_URL,
    timeoutMs: Number(N8N_CHAT_TIMEOUT_MS) || 60000,
    apiKey: N8N_CHAT_API_KEY,
  },
});

app.use('/api', chatRouter);

const SCOPES = [
  // Read/write access to events (includes reading events).
  // Note: switching from readonly requires re-consent (logout then connect again).
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'openid',
];

async function getGrantedScopes(tokens) {
  // Helpful for debugging "insufficient authentication scopes" errors.
  if (!tokens?.access_token) return null;
  try {
    const tokenClient = new google.auth.OAuth2();
    const info = await tokenClient.getTokenInfo(tokens.access_token);
    return info?.scopes || null;
  } catch {
    return null;
  }
}

app.post('/api/local/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required.' });
    }

    const user = await usersCollection.findOne({ username: String(username).trim() });
    if (!user || !verifyPassword(password, user.password)) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    clearGoogleSession(req);
    req.session.localUser = { username: user.username };
    await usersCollection.updateOne(
      { _id: user._id },
      { $set: { lastLoginAt: new Date() } }
    );

    return res.json({ ok: true, user: { username: user.username } });
  } catch (error) {
    console.error('Local login failed:', error?.message || error);
    return res.status(500).json({ message: 'Local login failed.' });
  }
});

app.post('/api/local/logout', (req, res) => {
  req.session.localUser = undefined;
  clearGoogleSession(req);
  res.status(204).end();
});

app.get('/api/local/me', (req, res) => {
  if (!req.session?.localUser) return res.json({ authenticated: false });
  return res.json({ authenticated: true, user: req.session.localUser });
});

app.get('/auth/google', requireLocalAuth, (req, res) => {
  req.session.tokens = undefined;
  req.session.user = undefined;
  req.session.grantedScopes = undefined;
  req.session.lastEventsQuery = undefined;
  const redirectUri = getRedirectUriForRequest(req);
  req.session.oauthRedirectUri = redirectUri;
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const oauthClientForAuth = buildOAuthClient(redirectUri);

  const authUrl = oauthClientForAuth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state,
    redirect_uri: redirectUri,
  });

  res.redirect(authUrl);
});

app.get('/oauth2callback', requireLocalAuth, async (req, res) => {
  try {
    const { code, state, error: oauthError, error_description: errorDescription } = req.query;

    if (oauthError) {
      console.error(
        'OAuth provider returned error:',
        oauthError,
        errorDescription || '',
        'redirectUri=',
        req.session.oauthRedirectUri || getRedirectUriForRequest(req)
      );
      return res
        .status(400)
        .send(`OAuth error: ${oauthError}${errorDescription ? ` - ${errorDescription}` : ''}`);
    }

    if (!code) {
      return res.status(400).send('Missing OAuth code.');
    }

    if (!state || state !== req.session.oauthState) {
      return res.status(400).send('Invalid OAuth state.');
    }

    const redirectUri = req.session.oauthRedirectUri || getRedirectUriForRequest(req);
    const oauthClientForCallback = buildOAuthClient(redirectUri);

    const { tokens } = await oauthClientForCallback.getToken({
      code,
      redirect_uri: redirectUri,
    });
    req.session.tokens = tokens;
    req.session.oauthState = undefined;
    req.session.oauthRedirectUri = undefined;

    // Cache basic profile info in session (used for per-user snapshot storage).
    try {
      const oauthClientForProfile = buildOAuthClient(redirectUri);
      oauthClientForProfile.setCredentials(tokens);
      const oauth2 = google.oauth2({ auth: oauthClientForProfile, version: 'v2' });
      const profile = await oauth2.userinfo.get();
      req.session.user = {
        name: profile.data.name || null,
        email: profile.data.email || null,
        picture: profile.data.picture || null,
      };
    } catch (e) {
      // Profile fetch isn't strictly required for calendar reads.
      req.session.user = undefined;
      console.warn('Warning: failed to fetch user profile during OAuth callback:', e?.message || e);
    }

    const scopes = await getGrantedScopes(tokens);
    if (scopes) {
      req.session.grantedScopes = scopes;
      if (!scopes.includes('https://www.googleapis.com/auth/calendar.events')) {
        console.warn(
          'Warning: OAuth token missing calendar.events scope. Granted scopes:',
          scopes
        );
      }
    } else {
      req.session.grantedScopes = undefined;
    }

    await upsertUserProfile(req.session.user, req.session.grantedScopes, { tokens });

    // Auto-sync once right after login so Mongo is populated without requiring manual refresh.
    try {
      await refreshAndPersistLatest(req);
    } catch (syncError) {
      console.warn('Post-login event sync failed:', syncError?.message || syncError);
    }

    res.redirect('/app.html');
  } catch (error) {
    console.error('OAuth callback error:', error);
    res.status(500).send('Authentication failed. Check server logs.');
  }
});

app.post('/auth/logout', requireLocalAuth, (req, res) => {
  clearGoogleSession(req);
  res.status(204).end();
});

app.get('/api/me', requireLocalAuth, async (req, res) => {
  try {
    if (!req.session.tokens) {
      return res.json({ authenticated: false });
    }

    const user = await resolveSessionUser(req, { forceRefresh: true });
    if (!user?.email) {
      return res.json({ authenticated: false });
    }

    await upsertUserProfile(user, req.session.grantedScopes);

    return res.json({
      authenticated: true,
      user: {
        name: user.name,
        email: user.email,
        picture: user.picture,
      },
      grantedScopes: req.session.grantedScopes || null,
    });
  } catch (error) {
    console.error('Failed to load profile:', error);
    return res.status(500).json({ message: 'Failed to load profile.' });
  }
});

app.get('/api/tokeninfo', requireLocalAuth, async (req, res) => {
  if (!req.session.tokens) {
    return res.status(401).json({ message: 'Not authenticated.' });
  }

  const scopes = await getGrantedScopes(req.session.tokens);
  return res.json({ scopes });
});

app.post('/api/events/search', requireLocalAuth, async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const email = await getSessionEmail(req, { forceRefresh: true });
    if (!email) {
      return res.status(400).json({ message: 'No user email available yet. Connect Google first.' });
    }

    const result = await searchStoredEvents({
      email,
      ...(req.body || {}),
    });

    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Failed to search events:', error?.message || error);
    return res.status(500).json({ message: 'Failed to search events.' });
  }
});

app.post('/api/events', requireLocalAuth, async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const {
      summary,
      description,
      location,
      start,
      end,
      attendees,
      calendarId = 'primary',
    } = req.body || {};
    const sendUpdates = getSendUpdates(req.query.sendUpdates || req.body?.sendUpdates);

    if (typeof summary !== 'string' || !summary.trim()) {
      return res.status(400).json({ message: 'Event summary is required.' });
    }

    const requestBody = {
      summary: summary.trim(),
    };

    if (typeof description === 'string') requestBody.description = description;
    if (typeof location === 'string') requestBody.location = location;

    try {
      applyEditableDateTime(requestBody, 'start', start);
      applyEditableDateTime(requestBody, 'end', end);
    } catch (error) {
      return res.status(400).json({ message: error?.message || 'Invalid start/end.' });
    }

    const normalizedAttendees = normalizeAttendees(attendees);
    if (normalizedAttendees) {
      requestBody.attendees = normalizedAttendees;
    }

    const calendar = google.calendar({ version: 'v3', auth: getOAuthClientForRequest(req) });
    const response = await calendar.events.insert({
      calendarId,
      sendUpdates,
      requestBody,
    });

    const createdEvent = response.data;
    const email = await getSessionEmail(req, { forceRefresh: true });
    if (email) {
      await upsertFullEvents(email, calendarId, [createdEvent], {
        source: 'api_create_event',
      });
    }

    const latest = await refreshAndPersistLatest(req);
    return res.status(201).json({
      ok: true,
      event: createdEvent,
      latest,
    });
  } catch (error) {
    const data = error.response?.data;
    console.error('Failed to create event:', data || error.message || error);

    const status = Number(data?.error?.code) || 500;
    if (
      status === 403 &&
      (data?.error?.message || '').toLowerCase().includes('insufficient authentication scopes')
    ) {
      return res.status(403).json({
        message:
          'Missing Google Calendar write scope. Logout and re-connect, then approve calendar.events.',
        details: data?.error || null,
        grantedScopes: req.session.grantedScopes || null,
      });
    }

    return res.status(500).json({
      message: data?.error?.message || 'Failed to create event.',
      details: data?.error || null,
    });
  }
});

app.post('/api/agent/events/search', requireAgentApiKey, async (req, res) => {
  try {
    const email = resolveAgentUserEmail(req);
    if (!email) {
      return res.status(400).json({ message: 'userEmail is required for agent search.' });
    }

    const result = await searchStoredEvents({
      email,
      ...(req.body || {}),
    });

    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error('Agent event search failed:', error?.message || error);
    return res.status(500).json({ message: 'Agent event search failed.' });
  }
});

app.post('/api/agent/events', requireAgentApiKey, async (req, res) => {
  try {
    const email = resolveAgentUserEmail(req);
    if (!email) {
      return res.status(400).json({ message: 'userEmail is required for agent create.' });
    }

    const {
      summary,
      description,
      location,
      start,
      end,
      attendees,
      calendarId = 'primary',
      sendUpdates,
      sync = true,
    } = req.body || {};

    if (typeof summary !== 'string' || !summary.trim()) {
      return res.status(400).json({ message: 'Event summary is required.' });
    }

    const requestBody = { summary: summary.trim() };
    if (typeof description === 'string') requestBody.description = description;
    if (typeof location === 'string') requestBody.location = location;

    try {
      applyEditableDateTime(requestBody, 'start', start);
      applyEditableDateTime(requestBody, 'end', end);
    } catch (error) {
      return res.status(400).json({ message: error?.message || 'Invalid start/end.' });
    }

    const normalizedAttendees = normalizeAttendees(attendees);
    if (normalizedAttendees) requestBody.attendees = normalizedAttendees;

    const auth = await getOAuthClientForEmail(email);
    const calendar = google.calendar({ version: 'v3', auth });
    const response = await calendar.events.insert({
      calendarId,
      sendUpdates: getSendUpdates(sendUpdates),
      requestBody,
    });

    await upsertFullEvents(email, calendarId, [response.data], { source: 'agent_create_event' });
    const latest = sync ? await refreshAndPersistLatestForEmail(email, { auth }) : null;
    return res.status(201).json({ ok: true, event: response.data, latest });
  } catch (error) {
    const data = error.response?.data;
    console.error('Agent create event failed:', data || error?.message || error);
    return res.status(500).json({
      message: data?.error?.message || error?.message || 'Agent create event failed.',
      details: data?.error || null,
    });
  }
});

app.patch('/api/agent/events/:eventId', requireAgentApiKey, async (req, res) => {
  try {
    const email = resolveAgentUserEmail(req);
    if (!email) {
      return res.status(400).json({ message: 'userEmail is required for agent update.' });
    }

    const { summary, description, location, start, end, sendUpdates, sync = true } = req.body || {};
    const requestBody = {};
    if (typeof summary === 'string') requestBody.summary = summary;
    if (typeof description === 'string') requestBody.description = description;
    if (typeof location === 'string') requestBody.location = location;
    try {
      if (typeof start !== 'undefined') applyEditableDateTime(requestBody, 'start', start);
      if (typeof end !== 'undefined') applyEditableDateTime(requestBody, 'end', end);
    } catch (error) {
      return res.status(400).json({ message: error?.message || 'Invalid start/end.' });
    }

    if (!Object.keys(requestBody).length) {
      return res.status(400).json({ message: 'No editable fields provided.' });
    }

    const auth = await getOAuthClientForEmail(email);
    const calendar = google.calendar({ version: 'v3', auth });
    const response = await calendar.events.patch({
      calendarId: 'primary',
      eventId: req.params.eventId,
      sendUpdates: getSendUpdates(sendUpdates),
      requestBody,
    });

    await upsertFullEvents(email, 'primary', [response.data], { source: 'agent_patch_event' });
    const latest = sync ? await refreshAndPersistLatestForEmail(email, { auth }) : null;
    return res.json({ ok: true, event: response.data, latest });
  } catch (error) {
    const data = error.response?.data;
    console.error('Agent update event failed:', data || error?.message || error);
    return res.status(500).json({
      message: data?.error?.message || error?.message || 'Agent update event failed.',
      details: data?.error || null,
    });
  }
});

app.delete('/api/agent/events/:eventId', requireAgentApiKey, async (req, res) => {
  try {
    const email = resolveAgentUserEmail(req);
    if (!email) {
      return res.status(400).json({ message: 'userEmail is required for agent delete.' });
    }

    const sendUpdates = getSendUpdates(req.query.sendUpdates || req.body?.sendUpdates);
    const sync = req.query.sync !== 'false' && req.body?.sync !== false;
    const auth = await getOAuthClientForEmail(email);
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({
      calendarId: 'primary',
      eventId: req.params.eventId,
      sendUpdates,
    });

    await markEventDeleted(email, req.params.eventId);
    const latest = sync ? await refreshAndPersistLatestForEmail(email, { auth }) : null;
    return res.json({ ok: true, latest });
  } catch (error) {
    const data = error.response?.data;
    console.error('Agent delete event failed:', data || error?.message || error);
    return res.status(500).json({
      message: data?.error?.message || error?.message || 'Agent delete event failed.',
      details: data?.error || null,
    });
  }
});

app.get('/api/events', requireLocalAuth, async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const maxResults = Math.min(Number(req.query.maxResults) || 20, 100);
    const timeMin = req.query.timeMin || new Date().toISOString();
    req.session.lastEventsQuery = { maxResults, timeMin };

    const calendar = google.calendar({ version: 'v3', auth: getOAuthClientForRequest(req) });
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      maxResults,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const rawEvents = response.data.items || [];
    const events = rawEvents.map((event) => ({
      id: event.id,
      status: event.status,
      summary: event.summary || '(No title)',
      description: event.description || '',
      location: event.location || '',
      htmlLink: event.htmlLink,
      creator: event.creator?.email || '',
      organizer: event.organizer?.email || '',
      start: event.start?.dateTime || event.start?.date || null,
      end: event.end?.dateTime || event.end?.date || null,
      updated: event.updated || null,
    }));

    const email = await getSessionEmail(req, { forceRefresh: true });

    const payload = {
      fetchedAt: new Date().toISOString(),
      calendarId: 'primary',
      timeMin,
      maxResults,
      count: events.length,
      events,
    };

    let fullEventsResult = null;
    let saveResult = null;
    if (email) {
      fullEventsResult = await upsertFullEvents(email, 'primary', rawEvents, {
        maxResults,
        timeMin,
      });
      saveResult = await saveEventsSnapshot(email, payload, { maxResults, timeMin });
    }
    res.json({
      ...payload,
      storage: {
        ok: Boolean(email),
        db: resolvedMongoDbName,
        collections: ['event_snapshots', 'calendar_events', 'user_profiles'],
        email,
        upsertedId: saveResult?.upsertedId || null,
        matchedCount: saveResult?.matchedCount || 0,
        modifiedCount: saveResult?.modifiedCount || 0,
        eventDocuments: fullEventsResult || { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 },
        reason: email ? null : 'No user email available for storage.',
      },
    });
  } catch (error) {
    const data = error.response?.data;
    console.error('Failed to fetch events:', data || error.message || error);

    const status = Number(data?.error?.code) || 500;
    if (
      status === 403 &&
      (data?.error?.message || '').toLowerCase().includes('insufficient authentication scopes')
    ) {
      return res.status(403).json({
        message:
          'Google token missing Calendar scope. Ensure you consented to calendar.events, then logout and re-connect.',
        details: data?.error || null,
        grantedScopes: req.session.grantedScopes || null,
      });
    }

    return res.status(500).json({ message: 'Failed to fetch Google Calendar events.' });
  }
});

async function refreshAndPersistLatestForEmail(email, options = {}) {
  const maxResults = Math.min(Number(options.maxResults) || 20, 100);
  const timeMin = options.timeMin || new Date().toISOString();
  const auth = options.auth || await getOAuthClientForEmail(email);
  const calendar = google.calendar({ version: 'v3', auth });
  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    maxResults,
    singleEvents: true,
    orderBy: 'startTime',
  });

  const rawEvents = response.data.items || [];
  const events = rawEvents.map((event) => ({
    id: event.id,
    status: event.status,
    summary: event.summary || '(No title)',
    description: event.description || '',
    location: event.location || '',
    htmlLink: event.htmlLink,
    creator: event.creator?.email || '',
    organizer: event.organizer?.email || '',
    start: event.start?.dateTime || event.start?.date || null,
    end: event.end?.dateTime || event.end?.date || null,
    updated: event.updated || null,
  }));

  const payload = {
    fetchedAt: new Date().toISOString(),
    calendarId: 'primary',
    timeMin,
    maxResults,
    count: events.length,
    events,
  };

  if (email) {
    const fullEventsResult = await upsertFullEvents(email, 'primary', rawEvents, {
      maxResults,
      timeMin,
    });
    const saveResult = await saveEventsSnapshot(email, payload, { maxResults, timeMin });
    console.log(
      `Snapshot saved for ${email}. matched=${saveResult.matchedCount}, modified=${saveResult.modifiedCount}, upserted=${saveResult.upsertedId ? 'yes' : 'no'}`
    );
    console.log(
      `Full events synced for ${email}. matched=${fullEventsResult.matchedCount}, modified=${fullEventsResult.modifiedCount}, upserted=${fullEventsResult.upsertedCount}`
    );
  } else {
    console.warn('Skipping MongoDB sync: no user email available.');
  }
  return payload;
}

async function refreshAndPersistLatest(req) {
  // Re-list events after a write so the JSON download stays in sync.
  const maxResults = Math.min(Number(req.session.lastEventsQuery?.maxResults) || 20, 100);
  const timeMin = req.session.lastEventsQuery?.timeMin || new Date().toISOString();
  const email = await getSessionEmail(req, { forceRefresh: true });
  const auth = getOAuthClientForRequest(req);
  return refreshAndPersistLatestForEmail(email, { maxResults, timeMin, auth });
}

async function refreshAndPersistForWindow(req, window) {
  if (!window?.start) {
    return refreshAndPersistLatest(req);
  }

  const maxResults = Math.min(Number(req.session.lastEventsQuery?.maxResults) || 100, 250);
  const timeMin = window.start.toISOString();
  const timeMax = window.end?.toISOString ? window.end.toISOString() : undefined;

  const calendar = google.calendar({ version: 'v3', auth: getOAuthClientForRequest(req) });
  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin,
    timeMax,
    maxResults,
    singleEvents: true,
    orderBy: 'startTime',
  });

  const rawEvents = response.data.items || [];
  const events = rawEvents.map((event) => ({
    id: event.id,
    status: event.status,
    summary: event.summary || '(No title)',
    description: event.description || '',
    location: event.location || '',
    htmlLink: event.htmlLink,
    creator: event.creator?.email || '',
    organizer: event.organizer?.email || '',
    start: event.start?.dateTime || event.start?.date || null,
    end: event.end?.dateTime || event.end?.date || null,
    updated: event.updated || null,
  }));

  const payload = {
    fetchedAt: new Date().toISOString(),
    calendarId: 'primary',
    timeMin,
    maxResults,
    count: events.length,
    events,
  };

  const email = await getSessionEmail(req, { forceRefresh: true });
  if (email) {
    await upsertFullEvents(email, 'primary', rawEvents, {
      maxResults,
      timeMin,
      timeMax,
      windowLabel: window.label || null,
    });
    await saveEventsSnapshot(email, payload, { maxResults, timeMin, timeMax, windowLabel: window.label || null });
  }

  return payload;
}

app.get('/api/events/:eventId', requireLocalAuth, async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const calendar = google.calendar({ version: 'v3', auth: getOAuthClientForRequest(req) });
    const event = await calendar.events.get({
      calendarId: 'primary',
      eventId: req.params.eventId,
    });
    return res.json(event.data);
  } catch (error) {
    const data = error.response?.data;
    console.error('Failed to get event:', data || error.message || error);
    return res.status(500).json({ message: 'Failed to load event.' });
  }
});

app.patch('/api/events/:eventId', requireLocalAuth, async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

    const { summary, description, location, start, end } = req.body || {};
    const sendUpdates = getSendUpdates(req.query.sendUpdates);

    const requestBody = {};
    if (typeof summary === 'string') requestBody.summary = summary;
    if (typeof description === 'string') requestBody.description = description;
    if (typeof location === 'string') requestBody.location = location;

    try {
      if (typeof start !== 'undefined') applyEditableDateTime(requestBody, 'start', start);
      if (typeof end !== 'undefined') applyEditableDateTime(requestBody, 'end', end);
    } catch (e) {
      return res.status(400).json({ message: e?.message || 'Invalid start/end.' });
    }

    if (!Object.keys(requestBody).length) {
      return res.status(400).json({ message: 'No editable fields provided.' });
    }

    const calendar = google.calendar({ version: 'v3', auth: getOAuthClientForRequest(req) });
    await calendar.events.patch({
      calendarId: 'primary',
      eventId: req.params.eventId,
      sendUpdates,
      requestBody,
    });

    const latest = await refreshAndPersistLatest(req);
    return res.json({ ok: true, latest });
  } catch (error) {
    const data = error.response?.data;
    console.error('Failed to update event:', data || error.message || error);

    const status = Number(data?.error?.code) || 500;
    if (
      status === 403 &&
      (data?.error?.message || '').toLowerCase().includes('insufficient authentication scopes')
    ) {
      return res.status(403).json({
        message:
          'Missing Google Calendar write scope. Logout and re-connect, then approve calendar.events.',
        details: data?.error || null,
        grantedScopes: req.session.grantedScopes || null,
      });
    }

    return res.status(500).json({
      message: data?.error?.message || 'Failed to update event.',
      details: data?.error || null,
    });
  }
});

app.delete('/api/events/:eventId', requireLocalAuth, async (req, res) => {
  try {
    if (!requireAuth(req, res)) return;

  const email = await getSessionEmail(req, { forceRefresh: true });
    const sendUpdates = getSendUpdates(req.query.sendUpdates);
    const calendar = google.calendar({ version: 'v3', auth: getOAuthClientForRequest(req) });
    await calendar.events.delete({
      calendarId: 'primary',
      eventId: req.params.eventId,
      sendUpdates,
    });
    if (email) {
      await markEventDeleted(email, req.params.eventId);
    }

    const latest = await refreshAndPersistLatest(req);
    return res.json({ ok: true, latest });
  } catch (error) {
    const data = error.response?.data;
    console.error('Failed to delete event:', data || error.message || error);

    const status = Number(data?.error?.code) || 500;
    if (
      status === 403 &&
      (data?.error?.message || '').toLowerCase().includes('insufficient authentication scopes')
    ) {
      return res.status(403).json({
        message:
          'Missing Google Calendar write scope. Logout and re-connect, then approve calendar.events.',
        details: data?.error || null,
        grantedScopes: req.session.grantedScopes || null,
      });
    }

    return res.status(500).json({
      message: data?.error?.message || 'Failed to delete event.',
      details: data?.error || null,
    });
  }
});

app.post('/api/events/:eventId/cancel', requireLocalAuth, async (req, res) => {
  // Google Calendar API doesn't have a separate "cancel" call for most events;
  // "cancelling" is effectively deleting the event (optionally notifying attendees).
  try {
    if (!requireAuth(req, res)) return;

    const email = await getSessionEmail(req, { forceRefresh: true });
    const sendUpdates = getSendUpdates(req.query.sendUpdates) || 'all';
    const calendar = google.calendar({ version: 'v3', auth: getOAuthClientForRequest(req) });
    await calendar.events.delete({
      calendarId: 'primary',
      eventId: req.params.eventId,
      sendUpdates,
    });
    if (email) {
      await markEventDeleted(email, req.params.eventId);
    }

    const latest = await refreshAndPersistLatest(req);
    return res.json({ ok: true, latest });
  } catch (error) {
    const data = error.response?.data;
    console.error('Failed to cancel event:', data || error.message || error);

    const status = Number(data?.error?.code) || 500;
    if (
      status === 403 &&
      (data?.error?.message || '').toLowerCase().includes('insufficient authentication scopes')
    ) {
      return res.status(403).json({
        message:
          'Missing Google Calendar write scope. Logout and re-connect, then approve calendar.events.',
        details: data?.error || null,
        grantedScopes: req.session.grantedScopes || null,
      });
    }

    return res.status(500).json({ message: 'Failed to cancel event.' });
  }
});

app.get('/api/events/download', requireLocalAuth, async (req, res) => {
  try {
    if (!req.session.tokens) {
      return res.status(401).send('Not authenticated.');
    }

    const email = await getSessionEmail(req, { forceRefresh: true });
    if (!email) {
      return res.status(400).send('No user email available yet. Refresh after login.');
    }
    const payload = await getEventsSnapshot(email);
    if (!payload) {
      return res.status(400).send('No saved events yet. Click Refresh first.');
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `calendar-events-${safeFileId(email)}-${stamp}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(JSON.stringify(payload, null, 2) + '\\n');

  } catch (e) {
    console.error('Failed to download events:', e?.message || e);
    return res.status(500).send('Failed to download JSON.');
  }
});

async function handleStorageSync(req, res) {
  try {
    if (!requireAuth(req, res)) return;
    const latest = await refreshAndPersistLatest(req);
    const email = await getSessionEmail(req, { forceRefresh: true });
    if (!email) {
      return res.json({
        ok: false,
        db: resolvedMongoDbName,
        email: null,
        message: 'No user email available for storage sync.',
      });
    }
    const eventDocCount = await calendarEventsCollection.countDocuments({ email });
    const userDoc = await userProfilesCollection.findOne(
      { email },
      { projection: { _id: 0, email: 1, name: 1, lastLoginAt: 1 } }
    );
    return res.json({
      ok: true,
      db: resolvedMongoDbName,
      email,
      count: latest.count,
      eventDocumentCount: eventDocCount,
      userProfile: userDoc || null,
    });
  } catch (error) {
    console.error('Manual storage sync failed:', error?.message || error);
    return res.status(500).json({ message: 'Manual storage sync failed.' });
  }
}

app.post('/api/storage-sync', requireLocalAuth, handleStorageSync);
app.get('/api/storage-sync', requireLocalAuth, handleStorageSync);

app.get('/api/storage-status', requireLocalAuth, async (req, res) => {
  try {
    if (!req.session.tokens) {
      return res.status(401).json({ message: 'Not authenticated.' });
    }
    const email = await getSessionEmail(req, { forceRefresh: true });
    if (!email) {
      return res.json({
        ok: false,
        db: resolvedMongoDbName,
        email: null,
        message: 'No user email available yet.',
      });
    }
    const doc = await eventSnapshotsCollection.findOne(
      { email },
      { projection: { _id: 0, email: 1, updatedAt: 1, queryMeta: 1 } }
    );
    const userDoc = await userProfilesCollection.findOne(
      { email },
      { projection: { _id: 0, email: 1, name: 1, picture: 1, grantedScopes: 1, lastLoginAt: 1 } }
    );
    const eventDocCount = await calendarEventsCollection.countDocuments({ email });
    const activeEventDocCount = await calendarEventsCollection.countDocuments({
      email,
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    });
    const recentEvents = await calendarEventsCollection
      .find({ email }, { projection: { _id: 0, eventId: 1, summary: 1, status: 1, lastSyncedAt: 1 } })
      .sort({ lastSyncedAt: -1 })
      .limit(5)
      .toArray();
    return res.json({
      ok: true,
      db: resolvedMongoDbName,
      collections: ['event_snapshots', 'calendar_events', 'user_profiles'],
      email,
      exists: Boolean(doc),
      document: doc || null,
      userProfileExists: Boolean(userDoc),
      userProfile: userDoc || null,
      eventDocumentCount: eventDocCount,
      activeEventDocumentCount: activeEventDocCount,
      recentEvents,
    });
  } catch (error) {
    console.error('Failed to read storage status:', error?.message || error);
    return res.status(500).json({ message: 'Failed to read storage status.' });
  }
});

app.get('/api/chat-debug', requireLocalAuth, async (req, res) => {
  try {
    if (!req.session.tokens) {
      return res.status(401).json({ message: 'Not authenticated.' });
    }

    const email = await getSessionEmail(req, { forceRefresh: true });
    if (!email) {
      return res.json({
        ok: false,
        email: null,
        message: 'No active Google email available.',
      });
    }

    const snapshot = await eventSnapshotsCollection.findOne(
      { email },
      { projection: { _id: 0, updatedAt: 1, queryMeta: 1, 'payload.count': 1, 'payload.timeMin': 1, 'payload.events.id': 1, 'payload.events.summary': 1, 'payload.events.start': 1 } }
    );

    const activeEventDocCount = await calendarEventsCollection.countDocuments({
      email,
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
      status: { $ne: 'cancelled' },
    });

    const historicalEventDocCount = await calendarEventsCollection.countDocuments({ email });
    const lastChatContext = req.session?.lastChatContext || null;
    const contextEventIds = Array.isArray(lastChatContext?.eventIds) ? lastChatContext.eventIds : [];
    const contextEvents = contextEventIds.length
      ? await calendarEventsCollection.find(
          { email, eventId: { $in: contextEventIds } },
          { projection: { _id: 0, eventId: 1, summary: 1, start: 1, location: 1 } }
        ).toArray()
      : [];

    const contextOrder = new Map(contextEventIds.map((id, index) => [id, index]));
    contextEvents.sort((a, b) => (contextOrder.get(a.eventId) ?? Number.MAX_SAFE_INTEGER) - (contextOrder.get(b.eventId) ?? Number.MAX_SAFE_INTEGER));

    return res.json({
      ok: true,
      email,
      googleUser: req.session.user || null,
      snapshot: snapshot
        ? {
            updatedAt: snapshot.updatedAt || null,
            queryMeta: snapshot.queryMeta || null,
            count: snapshot.payload?.count || 0,
            timeMin: snapshot.payload?.timeMin || null,
            eventsPreview: Array.isArray(snapshot.payload?.events) ? snapshot.payload.events.slice(0, 10) : [],
          }
        : null,
      counts: {
        activeEventDocCount,
        historicalEventDocCount,
        lastChatContextEventCount: contextEventIds.length,
      },
      lastChatContext: lastChatContext
        ? {
            query: lastChatContext.query || '',
            window: lastChatContext.window || null,
            eventIds: contextEventIds,
            eventsPreview: contextEvents.slice(0, 20),
          }
        : null,
    });
  } catch (error) {
    console.error('Failed to read chat debug context:', error?.message || error);
    return res.status(500).json({ message: 'Failed to read chat debug context.' });
  }
});

app.get(/^\/(?!api|auth|oauth2callback).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ message: 'Invalid JSON payload.' });
  }
  console.error('Unhandled error:', err?.message || err);
  return res.status(500).json({ message: 'Server error.' });
});

async function startServer() {
  try {
    await initMongo();
    app.listen(PORT, () => {
      console.log(`Google Calendar Viewer running at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error?.message || error);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  await mongoClient.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await mongoClient.close();
  process.exit(0);
});

startServer();

