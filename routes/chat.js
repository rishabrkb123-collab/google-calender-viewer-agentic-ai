const express = require('express');

const MONTH_INDEX = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const BASE_STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'with', 'in', 'on', 'at',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'by', 'from', 'as', 'if', 'then',
  'this', 'that', 'these', 'those', 'there', 'here', 'about', 'show', 'list', 'find',
  'event', 'events', 'calendar', 'slot', 'slots', 'meeting', 'meetings',
  'schedule', 'agenda', 'plan', 'plans',
  'when', 'what', 'which', 'who', 'where', 'why', 'how',
  'do', 'does', 'did', 'have', 'has', 'had', 'can', 'could', 'would', 'should',
  'i', 'me', 'my', 'mine', 'you', 'your', 'yours', 'we', 'our', 'ours', 'they', 'their', 'them',
  'any', 'all', 'only', 'just', 'please', 'tell', 'say', 'need', 'want', 'exactly',
  'today', 'tomorrow', 'yesterday', 'week', 'month', 'year', 'date', 'dates', 'time', 'times',
  'next', 'this', 'last', 'upcoming', 'current', 'mins', 'min', 'minute', 'minutes',
  'more', 'less', 'than', 'over', 'under', 'above', 'below', 'least', 'most', 'at', 'after', 'before',
  'many', 'full', 'day',
]);
Object.keys(MONTH_INDEX).forEach((m) => BASE_STOP_WORDS.add(m));

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTextToken(term) {
  return normalizeText(term)
    .split(/\s+/)
    .map((part) => {
      if (!part) return '';
      if (BASE_STOP_WORDS.has(part)) return '';
      if (part.endsWith("'s")) return part.slice(0, -2);
      if (part.endsWith('s') && part.length > 3) return part.slice(0, -1);
      return part;
    })
    .filter((part) => part && part.length > 1 && !/^\d+$/.test(part) && !BASE_STOP_WORDS.has(part));
}

function tokenizeWords(text) {
  return normalizeText(text).split(/\s+/).filter(Boolean);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const alen = a.length;
  const blen = b.length;
  if (!alen) return blen;
  if (!blen) return alen;

  const v0 = new Array(blen + 1);
  const v1 = new Array(blen + 1);
  for (let i = 0; i <= blen; i += 1) v0[i] = i;

  for (let i = 0; i < alen; i += 1) {
    v1[0] = i + 1;
    for (let j = 0; j < blen; j += 1) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(
        v1[j] + 1,
        v0[j + 1] + 1,
        v0[j] + cost
      );
    }
    for (let j = 0; j <= blen; j += 1) v0[j] = v1[j];
  }
  return v1[blen];
}

function fuzzyEquals(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (Math.abs(a.length - b.length) > 2) return false;
  const maxEdits = a.length <= 4 ? 1 : 2;
  return levenshtein(a, b) <= maxEdits;
}

function hasWord(tokens, word) {
  return tokens.some((token) => token === word || fuzzyEquals(token, word));
}

function hasAllWords(tokens, words) {
  return words.every((word) => hasWord(tokens, word));
}

function hasSequence(tokens, words) {
  if (!words.length) return false;
  for (let i = 0; i <= tokens.length - words.length; i += 1) {
    let ok = true;
    for (let j = 0; j < words.length; j += 1) {
      if (!(tokens[i + j] === words[j] || fuzzyEquals(tokens[i + j], words[j]))) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function uniqueArray(items) {
  return [...new Set(items.filter(Boolean))];
}

function toDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function endOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function startOfWeek(date) {
  const day = (date.getDay() + 6) % 7; // Monday = 0
  const start = new Date(date);
  start.setDate(start.getDate() - day);
  return startOfDay(start);
}

function endOfWeek(date) {
  const start = startOfWeek(date);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return endOfDay(end);
}

function nextWeekWindow(now, offsetWeeks = 0) {
  const baseStart = startOfWeek(now);
  const start = new Date(baseStart);
  start.setDate(start.getDate() + offsetWeeks * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return { start: startOfDay(start), end: endOfDay(end) };
}

function startOfMonth(year, month) {
  return new Date(year, month, 1, 0, 0, 0, 0);
}

function endOfMonth(year, month) {
  return new Date(year, month + 1, 0, 23, 59, 59, 999);
}

function countNextBefore(text, unit) {
  const regex = new RegExp(`((?:\\bnext\\b\\s*)+)\\b${unit}\\b`);
  const match = text.match(regex);
  if (!match?.[1]) return 0;
  return (match[1].match(/\bnext\b/g) || []).length;
}

function parseDateString(text, now) {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const slash = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (slash) {
    let year = slash[3] ? Number(slash[3]) : now.getFullYear();
    if (year < 100) year += 2000;
    const d = new Date(year, Number(slash[1]) - 1, Number(slash[2]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const monthDay = text.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/
  );
  if (monthDay) {
    const month = MONTH_INDEX[monthDay[1]];
    const day = Number(monthDay[2]);
    const year = monthDay[3] ? Number(monthDay[3]) : now.getFullYear();
    const d = new Date(year, month, day);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const dayMonth = text.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:,?\s*(\d{4}))?\b/
  );
  if (dayMonth) {
    const day = Number(dayMonth[1]);
    const month = MONTH_INDEX[dayMonth[2]];
    const year = dayMonth[3] ? Number(dayMonth[3]) : now.getFullYear();
    const d = new Date(year, month, day);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  return null;
}

function parseMonthWindow(text, now) {
  const explicit = text.match(
    /\b(?:in|on|for|during)?\s*(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+month)?(?:\s+(\d{4}))?\b/
  );
  if (!explicit) return null;

  const month = MONTH_INDEX[explicit[1]];
  const year = explicit[2] ? Number(explicit[2]) : now.getFullYear();
  if (Number.isNaN(month) || Number.isNaN(year)) return null;

  return {
    start: startOfMonth(year, month),
    end: endOfMonth(year, month),
    label: `${explicit[1]} ${year}`,
  };
}

function parseDateWindowHeuristic(message, now) {
  const text = normalizeText(message);
  const tokens = tokenizeWords(message);
  if (!text) return null;

  if (hasWord(tokens, 'today')) return { start: startOfDay(now), end: endOfDay(now), label: 'today' };
  if (hasSequence(tokens, ['day', 'after', 'tomorrow']) || hasAllWords(tokens, ['day', 'after', 'tomorrow'])) {
    const d = new Date(now);
    d.setDate(d.getDate() + 2);
    return { start: startOfDay(d), end: endOfDay(d), label: 'day after tomorrow' };
  }
  if (hasWord(tokens, 'tomorrow')) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return { start: startOfDay(d), end: endOfDay(d), label: 'tomorrow' };
  }
  if (hasWord(tokens, 'yesterday')) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return { start: startOfDay(d), end: endOfDay(d), label: 'yesterday' };
  }
  if (hasSequence(tokens, ['day', 'before', 'yesterday']) || hasAllWords(tokens, ['day', 'before', 'yesterday'])) {
    const d = new Date(now);
    d.setDate(d.getDate() - 2);
    return { start: startOfDay(d), end: endOfDay(d), label: 'day before yesterday' };
  }

  if (hasSequence(tokens, ['this', 'week']) || hasAllWords(tokens, ['this', 'week'])) {
    const { start, end } = nextWeekWindow(now, 0);
    return { start, end, label: 'this week' };
  }

  const nextWeekCount = countNextBefore(text, 'week');
  if (nextWeekCount > 0) {
    const { start, end } = nextWeekWindow(now, nextWeekCount);
    return {
      start,
      end,
      label: nextWeekCount === 1 ? 'next week' : `${nextWeekCount} weeks ahead`,
    };
  }

  if (hasSequence(tokens, ['this', 'month']) || hasAllWords(tokens, ['this', 'month'])) {
    return {
      start: startOfMonth(now.getFullYear(), now.getMonth()),
      end: endOfMonth(now.getFullYear(), now.getMonth()),
      label: 'this month',
    };
  }

  const nextMonthCount = countNextBefore(text, 'month');
  if (nextMonthCount > 0) {
    const d = new Date(now.getFullYear(), now.getMonth() + nextMonthCount, 1);
    return {
      start: startOfMonth(d.getFullYear(), d.getMonth()),
      end: endOfMonth(d.getFullYear(), d.getMonth()),
      label: nextMonthCount === 1 ? 'next month' : `${nextMonthCount} months ahead`,
    };
  }

  if (hasSequence(tokens, ['this', 'year']) || hasAllWords(tokens, ['this', 'year'])) {
    return {
      start: new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0),
      end: new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999),
      label: 'this year',
    };
  }

  const nextYearCount = countNextBefore(text, 'year');
  if (nextYearCount > 0) {
    const year = now.getFullYear() + nextYearCount;
    return {
      start: new Date(year, 0, 1, 0, 0, 0, 0),
      end: new Date(year, 11, 31, 23, 59, 59, 999),
      label: nextYearCount === 1 ? 'next year' : `${nextYearCount} years ahead`,
    };
  }

  const monthWindow = parseMonthWindow(text, now);
  if (monthWindow) return monthWindow;

  const onMatch = text.match(/\bon\s+([a-z0-9\-/\s]+)\b/);
  if (onMatch?.[1]) {
    const d = parseDateString(onMatch[1], now);
    if (d) return { start: startOfDay(d), end: endOfDay(d), label: 'that date' };
  }

  const direct = parseDateString(text, now);
  if (direct) return { start: startOfDay(direct), end: endOfDay(direct), label: 'that date' };

  return null;
}

function parseIsoDate(value) {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDateWindowFromLlmIntent(llmIntent, now) {
  const intentRange = llmIntent?.dateRange;
  const timeExpression = llmIntent?.timeExpression;

  if (intentRange && typeof intentRange === 'object') {
    const start = parseIsoDate(intentRange.start);
    const end = parseIsoDate(intentRange.end);
    if (start && end && start <= end) {
      return { start, end, label: intentRange.label || 'custom range' };
    }
  }

  if (typeof timeExpression === 'string' && timeExpression.trim()) {
    return parseDateWindowHeuristic(timeExpression, now);
  }

  return null;
}

function parseDurationFilter(text) {
  const normalized = normalizeText(text);
  const minuteMatch = normalized.match(/\b(\d+)\s*(?:min|mins|minute|minutes)\b/);
  if (!minuteMatch) return null;

  const minutes = Number(minuteMatch[1]);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;

  let op = 'eq';
  if (/\b(more than|greater than|over|above)\b/.test(normalized)) op = 'gt';
  else if (/\b(less than|below|under)\b/.test(normalized)) op = 'lt';
  else if (/\b(at least|minimum|not less than)\b/.test(normalized)) op = 'gte';
  else if (/\b(at most|maximum|not more than)\b/.test(normalized)) op = 'lte';

  return { op, minutes };
}

function looksCalendarQuestion(text) {
  return /\b(event|events|calendar|meeting|meetings|schedule|birthday|slot|slots|today|tomorrow|week|month|date|when|next|upcoming|count|how many)\b/.test(
    normalizeText(text)
  );
}

function detectIntent(message) {
  const text = normalizeText(message);
  const durationFilter = parseDurationFilter(text);
  const wantsCount = /\b(how many|count|number of|total)\b/.test(text);
  const asksUpcomingList = /\b(list|show|what are)\b.*\b(upcoming)\b|\bupcoming (events|meetings|appointments)\b/.test(text);
  const wantsNext = !asksUpcomingList && /\b(next event|next meeting|what is my next|whats my next|soonest)\b/.test(text);
  const wantsLast = /\b(last event|latest event|final event|my last event)\b/.test(text);
  const wantsCancelled = /\b(cancelled|canceled|deleted|removed)\b/.test(text);
  const asksScheduleList = /\b(schedule|agenda|plan)\b/.test(text) && !/\b(when|what time|at what time)\b/.test(text);
  const asksEventList = /\b(list|show|which|what)\b.*\b(events|meetings|appointments)\b|\bwhat do i have\b|\blist them\b|\bshow them\b|\blist all\b/.test(text);
  const asksWhen = /\b(when|what time|at what time)\b/.test(text);
  const asksAllDay = /\b(all day|full day|whole day)\b/.test(text);
  const isGreeting = /^(h+i+|he+y+|hello+|yo+|hola+|sup+|greetings|good\s*(morning|afternoon|evening)|hey|hiya)\b/.test(text);

  // Additional intent detection for common queries
  const asksWhere = /\b(where|location|place|venue|address)\b/.test(text);
  const asksWho = /\b(who|attendees|participants|people|person|with whom)\b/.test(text);
  const asksWhat = /\b(what|details|information|about|describe)\b/.test(text);

  return {
    wantsCount,
    wantsNext,
    wantsLast,
    wantsCancelled,
    asksWhen,
    asksAllDay,
    isGreeting,
    asksWhere,
    asksWho,
    asksWhat,
    asksUpcomingList,
    asksScheduleList,
    asksEventList,
    durationFilter,
  };
}

function eventOverlapsWindow(event, window) {
  if (!window?.start || !window?.end) return true;
  const start = toDateOrNull(event.start);
  const end = toDateOrNull(event.end) || start;
  if (!start) return false;
  return start <= window.end && end >= window.start;
}

function isAllDayEvent(event) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(event?.start || ''));
}

function getDurationMinutes(event) {
  const start = toDateOrNull(event.start);
  const end = toDateOrNull(event.end) || start;
  if (!start || !end) return null;
  const diff = Math.max(0, end.getTime() - start.getTime());
  if (isAllDayEvent(event) && diff === 0) return 24 * 60;
  return Math.round(diff / 60000);
}

function matchesDuration(event, filter) {
  if (!filter) return true;
  const duration = getDurationMinutes(event);
  if (duration == null) return false;
  if (filter.op === 'gt') return duration > filter.minutes;
  if (filter.op === 'lt') return duration < filter.minutes;
  if (filter.op === 'gte') return duration >= filter.minutes;
  if (filter.op === 'lte') return duration <= filter.minutes;
  return duration === filter.minutes;
}

function tokenizeQuery(text) {
  return cleanTextToken(text);
}

function buildSearchWords(event) {
  const searchableFields = [
    event.summary,
    event.description,
    event.location,
    event.organizerEmail,
    event.creatorEmail,
  ].filter(Boolean);

  return uniqueArray(
    normalizeText(searchableFields.join(' '))
      .split(/\s+/)
      .filter(Boolean)
  );
}

function scoreEventMatch(event, tokens) {
  if (!tokens || !tokens.length) return { matched: true, score: 0, matchedTokens: 0 };

  const words = buildSearchWords(event);
  let score = 0;
  let matchedTokens = 0;

  for (const token of tokens) {
    let tokenMatched = false;
    for (const word of words) {
      if (word === token) {
        score += 3;
        tokenMatched = true;
        break;
      }
      if (word.includes(token) || token.includes(word)) {
        score += 2;
        tokenMatched = true;
        break;
      }
      if (tokens.length > 1 && fuzzyEquals(word, token)) {
        score += 1;
        tokenMatched = true;
        break;
      }
    }
    if (tokenMatched) matchedTokens += 1;
  }

  const minimumMatches = tokens.length <= 2 ? tokens.length : Math.max(2, Math.ceil(tokens.length * 0.6));
  return {
    matched: matchedTokens >= minimumMatches,
    score,
    matchedTokens,
  };
}

function rankEventsByText(events, tokens) {
  if (!tokens || !tokens.length) return events;

  return events
    .map((event) => ({ event, match: scoreEventMatch(event, tokens) }))
    .filter(({ match }) => match.matched)
    .sort((a, b) => {
      if (b.match.matchedTokens !== a.match.matchedTokens) {
        return b.match.matchedTokens - a.match.matchedTokens;
      }
      return b.match.score - a.match.score;
    })
    .map(({ event }) => event);
}

function preferExactSummaryMatches(events, tokens) {
  if (!tokens || !tokens.length || !Array.isArray(events) || !events.length) return events;

  const strictMatches = events.filter((event) => {
    const summaryWords = cleanTextToken(event.summary || '');
    if (!summaryWords.length) return false;
    return tokens.every((token) =>
      summaryWords.some((word) => word === token || word.includes(token) || token.includes(word))
    );
  });

  return strictMatches.length ? strictMatches : events;
}

function buildMongoPreFilter(baseFilter, window, tokens) {
  const filter = { ...baseFilter };
  const andClauses = [];

  if (window?.start && window?.end) {
    andClauses.push({
      $or: [
        { startAt: { $lte: window.end }, endAt: { $gte: window.start } },
        { startAt: { $exists: false } },
        { endAt: { $exists: false } },
      ],
    });
  }

  if (tokens?.length) {
    andClauses.push({
      $or: [
        { searchTokens: { $in: tokens.slice(0, 6) } },
        { searchTokens: { $exists: false } },
      ],
    });
  }

  if (andClauses.length) {
    filter.$and = andClauses;
  }

  return filter;
}

function isBroadSnapshotQuery({ tokens, window, intent }) {
  if (tokens?.length) return false;
  if (intent?.wantsCancelled) return false;
  return true;
}

function isContextFollowUp(message, tokens, window) {
  const text = normalizeText(message);
  if (window) return false;
  if (tokens?.length) return false;
  return /\b(them|those|these|it|that one|last one|first one)\b/.test(text);
}

function serializeWindow(window) {
  if (!window?.start || !window?.end) return null;
  return {
    label: window.label || 'range',
    start: window.start.toISOString(),
    end: window.end.toISOString(),
  };
}

function deserializeWindow(window) {
  if (!window?.start || !window?.end) return null;
  const start = parseIsoDate(window.start);
  const end = parseIsoDate(window.end);
  if (!start || !end || start > end) return null;
  return {
    label: window.label || 'range',
    start,
    end,
  };
}

const TIMED_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const DATE_ONLY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const TIME_ONLY_FORMATTER = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
});

function formatWhen(event) {
  if (!event?.start) return 'Unknown time';
  if (isAllDayEvent(event)) {
    const d = new Date(`${event.start}T00:00:00`);
    return `${Number.isNaN(d.getTime()) ? String(event.start) : DATE_ONLY_FORMATTER.format(d)} (all day)`;
  }
  const d = toDateOrNull(event.start);
  return d ? `${DATE_ONLY_FORMATTER.format(d)} at ${TIME_ONLY_FORMATTER.format(d)}` : String(event.start);
}

function buildListLines(results, limit = 8) {
  return results
    .slice(0, limit)
    .map((event, index) => `${index + 1}. ${event.summary || '(No title)'} - ${formatWhen(event)}`);
}

function buildChatReplyData({ message, results, intent, window }) {
  const now = new Date();
  const next =
    results.find((event) => {
      const start = toDateOrNull(event.start);
      return start ? start >= now : false;
    }) || results[0] || null;

  const details = results.slice(0, 8).map((event, index) => ({
    index: index + 1,
    summary: event.summary || '(No title)',
    when: formatWhen(event),
    start: event.start || null,
    end: event.end || null,
    location: event.location || '',
    description: event.description || '',
    organizerEmail: event.organizerEmail || '',
    creatorEmail: event.creatorEmail || '',
    attendeeEmails: Array.isArray(event.attendeeEmails) ? event.attendeeEmails : [],
    attendeeNames: Array.isArray(event.attendeeNames) ? event.attendeeNames : [],
  }));
  return {
    query: String(message || ''),
    intent: {
      wantsCount: Boolean(intent?.wantsCount),
      wantsNext: Boolean(intent?.wantsNext),
      wantsLast: Boolean(intent?.wantsLast),
      asksWhen: Boolean(intent?.asksWhen),
      wantsCancelled: Boolean(intent?.wantsCancelled),
      asksAllDay: Boolean(intent?.asksAllDay),
      asksWhere: Boolean(intent?.asksWhere),
      asksWho: Boolean(intent?.asksWho),
      asksWhat: Boolean(intent?.asksWhat),
      asksUpcomingList: Boolean(intent?.asksUpcomingList),
      asksScheduleList: Boolean(intent?.asksScheduleList),
      asksEventList: Boolean(intent?.asksEventList),
    },
    window: window
      ? {
          label: window.label || 'range',
          start: window.start?.toISOString ? window.start.toISOString() : null,
          end: window.end?.toISOString ? window.end.toISOString() : null,
        }
      : null,
    count: results.length,
    hasMore: results.length > details.length,
    nextEvent: next
      ? { summary: next.summary || '(No title)', when: formatWhen(next) }
      : null,
    eventsPreview: details,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
  };
}

function shouldUseSemanticLlm({ message, intent, tokens }) {
  if (process.env.CHAT_USE_LLM_SEMANTIC_FALLBACK !== 'true') return false;
  const text = normalizeText(message);
  if (!text) return false;
  if (intent?.wantsCount || intent?.wantsNext || intent?.wantsLast) return false;
  if (intent?.asksWhen || intent?.asksWhere || intent?.asksWho) return false;
  if (intent?.asksAllDay) return false;

  if (
    /\b(summarize|summary|summarise|important|priority|priorities|related to|related|theme|themes|health related|work related|personal|seems important|looks important)\b/.test(text)
  ) {
    return true;
  }

  if (
    /\b(what is .* about|what are .* about|tell me about my .* this month|summarize my .*|group my .*|categorize my .*)\b/.test(text)
  ) {
    return true;
  }

  return Array.isArray(tokens) && tokens.length >= 5 && /\b(about|related|summary|summarize|explain)\b/.test(text);
}

async function generateSemanticReply({ message, data, ollama }) {
  if (!ollama?.generate) {
    return formatFallbackResponse(data);
  }

  const prompt = [
    'You are a calendar assistant.',
    'Answer only from the provided calendar data.',
    'Do not invent events, dates, categories, or details.',
    'If the user asks for a summary, summarize only the listed events.',
    'If the user asks for events related to a theme, include only events that clearly match from titles, descriptions, or locations.',
    'If no events clearly match, say so plainly.',
    'Keep the answer concise and factual.',
    '',
    'Calendar data:',
    JSON.stringify(data, null, 2),
    '',
    'User query: ' + message,
    'Answer:',
  ].join('\n');

  try {
    const reply = await ollama.generate({ prompt });
    const cleanReply = String(reply || '').trim();
    return cleanReply || formatFallbackResponse(data);
  } catch (error) {
    console.log('[chat.debug] Semantic LLM fallback error:', error?.message || error);
    return formatFallbackResponse(data);
  }
}

async function generateChatReply({ message, data, ollama }) {
  const deterministicReply = formatFallbackResponse(data);
  const useLlmReply = process.env.CHAT_USE_LLM_REPLY === 'true';

  if (!useLlmReply) {
    return deterministicReply;
  }

  if (!ollama?.generate) {
    console.log('[chat.debug] No Ollama client available, returning raw data');
    return deterministicReply;
  }

  const prompt = [
    'You are a helpful calendar assistant. Your job is to provide clear, accurate responses based on the calendar data provided.',
    'Follow these rules strictly:',
    '1. ONLY use the data provided below. Never invent events, dates, or counts.',
    '2. If the data shows no events, clearly state that no matching events were found.',
    '3. If the user asks for a count, provide the exact count from data.count.',
    '4. If the user asks for details, list events from data.eventsPreview with summary and timing.',
    '5. If the user asks for the next event, use data.nextEvent if available.',
    '6. Always be helpful and conversational, but stick to facts from the data.',
    '7. Format your response clearly with proper punctuation and spacing.',
    '8. If data is missing or unclear, acknowledge that honestly.',
    '9. If the user asks about a specific time range, mention it in your response.',
    '10. Keep responses concise but complete.',
    '',
    'Example responses:',
    '- For count queries: "You have 3 events scheduled for tomorrow."',
    '- For detail queries: "Here are your upcoming meetings: 1. Team Standup - Mar 5, 2026 10:00 AM, 2. Lunch with Alex - Mar 5, 2026 1:00 PM"',
    '- For next event queries: "Your next event is \'Team Planning\' on March 7, 2026 at 2:00 PM."',
    '- For no events: "I don\'t see any events matching your request."',
    '',
    'Calendar Data:',
    JSON.stringify(data, null, 2),
    '',
    'User Query: ' + message,
    'Assistant Response:'
  ].join('\n');

  try {
    console.log('[chat.debug] Generating response with prompt:', prompt.substring(0, 200) + '...');
    const reply = await ollama.generate({ prompt });
    const cleanReply = String(reply || '').trim();

    if (!cleanReply) {
      console.log('[chat.debug] Empty response from Ollama, using fallback');
      return deterministicReply;
    }

    console.log('[chat.debug] Generated reply:', cleanReply);
    return cleanReply;
  } catch (error) {
    console.log('[chat.debug] Error generating response:', error?.message || error);
    return deterministicReply;
  }
}

function formatFallbackResponse(data) {
  if (!data) return "I'm having trouble accessing your calendar data right now.";

  if (data.count === 0) {
    if (data.window) {
      return `I don't see any events matching your request for ${data.window.label || 'the specified time range'}.`;
    }
    return "I don't see any events matching your request.";
  }

  if (data.intent?.wantsCount) {
    if (data.window) {
      return `You have ${data.count} events ${data.window.label ? `for ${data.window.label}` : 'in the specified time range'}.`;
    }
    return `You have ${data.count} events matching your request.`;
  }

  if (data.intent?.wantsLast && data.eventsPreview && data.eventsPreview.length > 0) {
    const lastEvent = data.eventsPreview[data.eventsPreview.length - 1];
    return `Your last event is '${lastEvent.summary}' on ${lastEvent.when}.`;
  }

  if (data.intent?.wantsNext && data.nextEvent) {
    const firstEvent = data.eventsPreview?.[0];
    if (data.intent?.asksWhere && firstEvent) {
      return firstEvent.location
        ? `Your next event, '${firstEvent.summary}', is at ${firstEvent.location}.`
        : `Your next event is '${firstEvent.summary}' on ${firstEvent.when}, and it does not have a location saved.`;
    }
    if (data.intent?.asksWho && firstEvent) {
      const people = uniqueArray([
        ...(firstEvent.attendeeNames || []),
        ...(firstEvent.attendeeEmails || []),
        firstEvent.organizerEmail,
        firstEvent.creatorEmail,
      ].filter(Boolean));
      return people.length
        ? `Your next event, '${firstEvent.summary}', is associated with ${people.join(', ')}.`
        : `Your next event is '${firstEvent.summary}' on ${firstEvent.when}, and I do not see attendee details saved for it.`;
    }
    return `Your next event is '${data.nextEvent.summary}' on ${data.nextEvent.when}.`;
  }

  if (data.eventsPreview && data.eventsPreview.length > 0) {
    const firstEvent = data.eventsPreview[0];

    if (data.intent?.asksWhen) {
      return `'${firstEvent.summary}' is scheduled for ${firstEvent.when}.`;
    }

    if (data.intent?.asksWhere) {
      return firstEvent.location
        ? `'${firstEvent.summary}' is at ${firstEvent.location}.`
        : `I found '${firstEvent.summary}', but it does not have a location saved.`;
    }

    if (data.intent?.asksWho) {
      const people = uniqueArray([
        ...(firstEvent.attendeeNames || []),
        ...(firstEvent.attendeeEmails || []),
        firstEvent.organizerEmail,
        firstEvent.creatorEmail,
      ].filter(Boolean));
      return people.length
        ? `'${firstEvent.summary}' is associated with ${people.join(', ')}.`
        : `I found '${firstEvent.summary}', but I do not see attendee details saved for it.`;
    }

    if (
      data.intent?.asksWhat &&
      !data.intent?.asksScheduleList &&
      !data.intent?.asksUpcomingList &&
      !data.intent?.asksEventList
    ) {
      const detailParts = [`'${firstEvent.summary}' is on ${firstEvent.when}`];
      if (firstEvent.location) detailParts.push(`at ${firstEvent.location}`);
      if (firstEvent.description) detailParts.push(`Description: ${firstEvent.description}`);
      return `${detailParts.join('. ')}.`;
    }
  }

  if (data.eventsPreview && data.eventsPreview.length > 0) {
    const eventList = data.eventsPreview.map((event) => `${event.index}. ${event.summary} - ${event.when}`).join('\n');

    if (data.window) {
      return `Here are your events ${data.window.label ? `for ${data.window.label}` : 'in the specified time range'}:\n${eventList}`;
    }
    return `Here are your events:\n${eventList}`;
  }

  return "I found some calendar data, but I'm not sure how to present it. Could you rephrase your request?";
}

function extractFirstJsonObject(text) {
  const raw = String(text || '').replace(/```(?:json)?/gi, '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

async function inferWithModel({ ollama, message }) {
  if (!ollama?.generate) return null;

  const prompt = [
    'You are a calendar assistant AI. Convert the user message into structured intent JSON for a calendar assistant.',
    'Always return valid JSON. No markdown or extra text.',
    'Instructions:',
    '- Always return a JSON object with the specified fields',
    '- If uncertain, default to kind="calendar" and set minimal fields',
    '- For greetings/smalltalk, set kind="smalltalk"',
    '- Extract time expressions, date ranges, search terms, and person names when mentioned',
    '- Identify if user wants counts, next events, all-day events, or cancelled events',
    '',
    'JSON Schema:',
    '{',
    '  "kind": "smalltalk" | "calendar",',
    '  "reply": "string (only for smalltalk)",',
    '  "count": boolean,',
    '  "next": boolean,',
    '  "allDay": boolean,',
    '  "wantsCancelled": boolean,',
    '  "timeExpression": "string",',
    '  "dateRange": {"start":"ISO-8601","end":"ISO-8601","label":"string"} | null,',
    '  "searchPhrases": ["string"],',
    '  "personTerms": ["string"],',
    '  "duration": {"op":"eq|gt|lt|gte|lte","minutes":number} | null',
    '}',
    '',
    'Examples:',
    'User: "Hello!"',
    'Response: {"kind":"smalltalk","reply":"Hello! How can I help you with your calendar today?","count":false,"next":false,"allDay":false,"wantsCancelled":false,"timeExpression":"","dateRange":null,"searchPhrases":[],"personTerms":[],"duration":null}',
    '',
    'User: "Show me meetings with John next week"',
    'Response: {"kind":"calendar","reply":"","count":false,"next":false,"allDay":false,"wantsCancelled":false,"timeExpression":"next week","dateRange":null,"searchPhrases":["meetings with John"],"personTerms":["John"],"duration":null}',
    '',
    'User: "How many events do I have today?"',
    'Response: {"kind":"calendar","reply":"","count":true,"next":false,"allDay":false,"wantsCancelled":false,"timeExpression":"today","dateRange":null,"searchPhrases":[],"personTerms":[],"duration":null}',
    '',
    'User message: ' + message,
  ].join('\n');

  try {
    const response = await ollama.generate({ prompt });
    const jsonText = ollama.extractFirstJsonObject ? ollama.extractFirstJsonObject(response) : extractFirstJsonObject(response);
    if (!jsonText) {
      console.log('[chat.debug] Failed to extract JSON from LLM response:', response);
      return null;
    }

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch (parseError) {
      console.log('[chat.debug] Failed to parse JSON from LLM response:', jsonText);
      return null;
    }

    const result = {
      kind: (parsed?.kind === 'smalltalk' || parsed?.kind === 'calendar') ? parsed.kind : 'calendar',
      reply: typeof parsed?.reply === 'string' ? parsed.reply.trim() : '',
      count: Boolean(parsed?.count),
      next: Boolean(parsed?.next),
      allDay: Boolean(parsed?.allDay),
      wantsCancelled: Boolean(parsed?.wantsCancelled),
      timeExpression: typeof parsed?.timeExpression === 'string' ? parsed.timeExpression.trim() : '',
      dateRange: null,
      searchPhrases: Array.isArray(parsed?.searchPhrases) ? parsed.searchPhrases.filter((x) => typeof x === 'string') : [],
      personTerms: Array.isArray(parsed?.personTerms) ? parsed.personTerms.filter((x) => typeof x === 'string') : [],
      duration: null,
    };

    if (parsed?.duration && typeof parsed.duration === 'object') {
      const op = ['eq', 'gt', 'lt', 'gte', 'lte'].includes(parsed.duration.op) ? parsed.duration.op : null;
      const minutes = Number(parsed.duration.minutes);
      if (op && Number.isFinite(minutes) && minutes > 0) {
        result.duration = { op, minutes };
      }
    }

    if (parsed?.dateRange && typeof parsed.dateRange === 'object') {
      const start = parseIsoDate(parsed.dateRange.start);
      const end = parseIsoDate(parsed.dateRange.end);
      if (start && end && start <= end) {
        result.dateRange = {
          start: start.toISOString(),
          end: end.toISOString(),
          label: typeof parsed.dateRange.label === 'string' ? parsed.dateRange.label.trim() : 'custom range',
        };
      }
    }

    console.log('[chat.debug] LLM intent result:', result);
    return result;
  } catch (error) {
    console.log('[chat.debug] LLM intent error:', error?.message || error);
    return null;
  }
}

function smallTalkReply(message, llmReply) {
  if (llmReply) return llmReply;
  if (/\b(thank|thanks|ty)\b/.test(normalizeText(message))) return 'You are welcome.';
  return 'Hi! I’m here to help with your calendar. What would you like to know?';
}

function mergeTokens(message, llmIntent) {
  const base = tokenizeQuery(message);
  if (!base.length) return base;
  const llmText = [
    ...(llmIntent?.searchPhrases || []),
    ...(llmIntent?.personTerms || []),
  ].join(' ');
  const fromLlm = tokenizeQuery(llmText);
  return uniqueArray([...base, ...fromLlm]);
}

function normalizeN8nReply(payload) {
  if (!payload) return '';
  if (typeof payload.reply === 'string' && payload.reply.trim()) return payload.reply.trim();
  if (typeof payload.response === 'string' && payload.response.trim()) return payload.response.trim();
  if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim();
  if (typeof payload.text === 'string' && payload.text.trim()) return payload.text.trim();
  if (Array.isArray(payload.data) && payload.data.length) {
    for (const item of payload.data) {
      const nested = normalizeN8nReply(item);
      if (nested) return nested;
    }
  }
  return '';
}

async function callN8nChatWebhook({
  webhookUrl,
  timeoutMs,
  apiKey,
  message,
  userId,
  sessionId,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message,
        query: message,
        user_message: message,
        userEmail: userId,
        email: userId,
        user_id: userId,
        session_id: sessionId,
      }),
      signal: controller.signal,
    });

    const rawText = await response.text();
    let payload = null;
    try {
      payload = rawText ? JSON.parse(rawText) : null;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const details = normalizeN8nReply(payload) || rawText || `Webhook returned ${response.status}`;
      throw new Error(details);
    }

    const reply = normalizeN8nReply(payload);
    if (!reply) throw new Error('n8n workflow response did not include a usable reply.');

    return { reply, payload };
  } finally {
    clearTimeout(timer);
  }
}

function createChatRouter({
  getCollection,
  getSnapshotCollection,
  getSessionEmail,
  requireLocalAuth,
  ollama,
  refreshEvents,
  maxResults = 50,
  n8n = {},
} = {}) {
  const router = express.Router();

  router.post('/chat', requireLocalAuth, async (req, res) => {
    try {
      const message = String(req.body?.message || '').trim();
      if (!message) return res.status(400).json({ message: 'Message is required.' });

      const email = await getSessionEmail(req);
      if (!email) return res.status(400).json({ message: 'No user email available. Connect Google first.' });

      if (n8n?.enabled === true) {
        const sessionId = req.sessionID || req.session?.id || 'default';
        const result = await callN8nChatWebhook({
          webhookUrl: n8n.webhookUrl,
          timeoutMs: n8n.timeoutMs,
          apiKey: n8n.apiKey,
          message,
          userId: email,
          sessionId,
        });
        req.session.lastChatContext = {
          query: message,
          eventIds: [],
          window: null,
          source: 'n8n',
        };
        return res.json({ reply: result.reply, source: 'n8n' });
      }

      const collection = getCollection();
      if (!collection) return res.status(503).json({ message: 'Database not ready yet.' });

      const intent = detectIntent(message);
      const useLlmIntent = process.env.CHAT_USE_LLM_INTENT === 'true';
      const llmIntent = useLlmIntent ? await inferWithModel({ ollama, message }) : null;

      if ((intent.isGreeting || llmIntent?.kind === 'smalltalk') && !looksCalendarQuestion(message)) {
        return res.json({ reply: smallTalkReply(message, llmIntent?.reply) });
      }

      const effectiveIntent = {
        wantsCount: intent.wantsCount || Boolean(llmIntent?.count),
        wantsNext: intent.wantsNext || Boolean(llmIntent?.next),
        wantsLast: intent.wantsLast,
        wantsCancelled: intent.wantsCancelled || Boolean(llmIntent?.wantsCancelled),
        asksWhen: intent.asksWhen || Boolean(llmIntent?.timeExpression),
        asksAllDay: intent.asksAllDay || Boolean(llmIntent?.allDay),
        asksWhere: intent.asksWhere,
        asksWho: intent.asksWho,
        asksWhat: intent.asksWhat,
        asksUpcomingList: intent.asksUpcomingList,
        asksScheduleList: intent.asksScheduleList,
        asksEventList: intent.asksEventList,
        durationFilter: intent.durationFilter || llmIntent?.duration || null,
      };

      const baseFilter = {
        email,
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
        status: effectiveIntent.wantsCancelled ? 'cancelled' : { $ne: 'cancelled' },
      };

      const now = new Date();
      let window =
        parseDateWindowHeuristic(message, now) ||
        parseDateWindowFromLlmIntent(llmIntent, now);

      const tokens = mergeTokens(message, llmIntent);
      const priorChatContext = req.session?.lastChatContext || null;
      const isFollowUp = isContextFollowUp(message, tokens, window);
      if (!window && isFollowUp) {
        window = deserializeWindow(priorChatContext?.window);
      }
      const mongoFilter = buildMongoPreFilter(baseFilter, window, tokens);
      const snapshotCollection = typeof getSnapshotCollection === 'function' ? getSnapshotCollection() : null;

      console.log('[chat.debug] query=', message);
      console.log('[chat.debug] intent=', {
        wantsCount: effectiveIntent.wantsCount,
        wantsNext: effectiveIntent.wantsNext,
        asksWhen: effectiveIntent.asksWhen,
        wantsCancelled: effectiveIntent.wantsCancelled,
      });
      console.log('[chat.debug] window=', window ? {
        label: window.label || null,
        start: window.start?.toISOString ? window.start.toISOString() : null,
        end: window.end?.toISOString ? window.end.toISOString() : null,
      } : null);
      console.log('[chat.debug] tokens=', tokens);

      const runQuery = async (filter, limit) => collection
        .find(filter, {
          projection: {
            _id: 0,
            eventId: 1,
            summary: 1,
            description: 1,
            start: 1,
            end: 1,
            startAt: 1,
            endAt: 1,
            status: 1,
            location: 1,
            organizerEmail: 1,
            creatorEmail: 1,
            attendeeEmails: 1,
            attendeeNames: 1,
            email: 1,
            searchTokens: 1,
          },
        })
        .sort({ startAt: 1, start: 1 })
        .limit(limit)
        .toArray();

      let dbResults = [];
      const useSnapshotScope = isBroadSnapshotQuery({ tokens, window, intent: effectiveIntent });
      let latestSnapshot = null;
      const contextEventIds = isFollowUp && Array.isArray(priorChatContext?.eventIds)
        ? priorChatContext.eventIds.filter(Boolean)
        : [];

      if (contextEventIds.length) {
        dbResults = await runQuery(
          {
            ...baseFilter,
            eventId: { $in: contextEventIds },
          },
          Math.max(contextEventIds.length, maxResults)
        );

        const contextOrder = new Map(contextEventIds.map((id, index) => [id, index]));
        dbResults.sort((a, b) => (contextOrder.get(a.eventId) ?? Number.MAX_SAFE_INTEGER) - (contextOrder.get(b.eventId) ?? Number.MAX_SAFE_INTEGER));
      }

      if (!dbResults.length && useSnapshotScope && snapshotCollection) {
        latestSnapshot = await snapshotCollection.findOne(
          { email },
          { projection: { _id: 0, payload: 1, updatedAt: 1, queryMeta: 1 } }
        );
        const snapshotIds = Array.isArray(latestSnapshot?.payload?.events)
          ? latestSnapshot.payload.events.map((event) => event?.id).filter(Boolean)
          : [];

        if (snapshotIds.length) {
          dbResults = await runQuery(
            {
              ...baseFilter,
              eventId: { $in: snapshotIds },
            },
            Math.max(snapshotIds.length, maxResults)
          );

          const order = new Map(snapshotIds.map((id, index) => [id, index]));
          dbResults.sort((a, b) => (order.get(a.eventId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.eventId) ?? Number.MAX_SAFE_INTEGER));
        }
      }

      if (!dbResults.length) {
        dbResults = await runQuery(mongoFilter, 300);
      }
      if (!dbResults.length && mongoFilter.$and?.length) {
        dbResults = await runQuery(baseFilter, 1000);
      }

      let filtered = dbResults.filter((event) => eventOverlapsWindow(event, window));
      console.log('[chat.debug] after window filter=', filtered.length);

      if (effectiveIntent.asksAllDay) {
        filtered = filtered.filter((event) => isAllDayEvent(event));
      }

      if (effectiveIntent.durationFilter) {
        filtered = filtered
          .filter((event) => !isAllDayEvent(event))
          .filter((event) => matchesDuration(event, effectiveIntent.durationFilter));
      }

      filtered = rankEventsByText(filtered, tokens);
      filtered = preferExactSummaryMatches(filtered, tokens);
      console.log('[chat.debug] after text filter=', filtered.length);

      if (effectiveIntent.wantsNext) {
        filtered = filtered
          .filter((event) => {
            const start = toDateOrNull(event.start);
            return start ? start >= now : false;
          })
          .slice(0, 1);
      } else if (effectiveIntent.wantsLast) {
        filtered = filtered
          .slice()
          .sort((a, b) => {
            const aStart = toDateOrNull(a.start)?.getTime() || 0;
            const bStart = toDateOrNull(b.start)?.getTime() || 0;
            return bStart - aStart;
          })
          .slice(0, 1);
      } else if (filtered.length > maxResults) {
        filtered = filtered.slice(0, maxResults);
      }

      if (!filtered.length && window && typeof refreshEvents === 'function') {
        try {
          await refreshEvents(req, window);
          const refreshed = await collection
            .find(mongoFilter, {
              projection: {
                _id: 0,
                eventId: 1,
                summary: 1,
                description: 1,
                start: 1,
                end: 1,
                startAt: 1,
                endAt: 1,
                status: 1,
                location: 1,
                organizerEmail: 1,
                creatorEmail: 1,
                attendeeEmails: 1,
                attendeeNames: 1,
                email: 1,
                searchTokens: 1,
              },
            })
            .sort({ startAt: 1, start: 1 })
            .limit(300)
            .toArray();

          let retry = refreshed.filter((event) => eventOverlapsWindow(event, window));
          if (effectiveIntent.durationFilter) {
            retry = retry
              .filter((event) => !isAllDayEvent(event))
              .filter((event) => matchesDuration(event, effectiveIntent.durationFilter));
          }
          retry = rankEventsByText(retry, tokens);
          retry = preferExactSummaryMatches(retry, tokens);
          if (effectiveIntent.wantsNext) {
            retry = retry
              .filter((event) => {
                const start = toDateOrNull(event.start);
                return start ? start >= now : false;
              })
              .slice(0, 1);
          } else if (effectiveIntent.wantsLast) {
            retry = retry
              .slice()
              .sort((a, b) => {
                const aStart = toDateOrNull(a.start)?.getTime() || 0;
                const bStart = toDateOrNull(b.start)?.getTime() || 0;
                return bStart - aStart;
              })
              .slice(0, 1);
          } else if (retry.length > maxResults) {
            retry = retry.slice(0, maxResults);
          }
          filtered = retry;
        } catch (e) {
          console.warn('Chat refresh failed:', e?.message || e);
        }
      }

      const data = buildChatReplyData({
        message,
        results: filtered,
        intent: effectiveIntent,
        window,
      });
      req.session.lastChatContext = {
        query: message,
        eventIds: filtered.map((event) => event.eventId).filter(Boolean).slice(0, 200),
        window: serializeWindow(window),
      };
      const useSemanticLlm = shouldUseSemanticLlm({ message, intent: effectiveIntent, tokens });
      const reply = useSemanticLlm
        ? await generateSemanticReply({ message, data, ollama })
        : await generateChatReply({ message, data, ollama });
      return res.json({ reply });
    } catch (error) {
      console.error('Chat error:', error?.message || error);
      return res.status(500).json({ message: 'Chat request failed.' });
    }
  });

  return router;
}

module.exports = {
  createChatRouter,
  inferWithModel,
  detectIntent,
  shouldUseSemanticLlm,
  generateSemanticReply,
  parseDateWindowHeuristic,
  eventOverlapsWindow,
  rankEventsByText,
  preferExactSummaryMatches,
  buildChatReplyData,
  formatFallbackResponse,
  mergeTokens,
};
