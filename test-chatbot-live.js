const assert = require('assert');
const { MongoClient } = require('mongodb');
require('dotenv').config();

const {
  detectIntent,
  parseDateWindowHeuristic,
  eventOverlapsWindow,
  rankEventsByText,
  preferExactSummaryMatches,
  buildChatReplyData,
  formatFallbackResponse,
  mergeTokens,
} = require('./routes/chat');

function answerQuestion(message, events, now) {
  const intent = detectIntent(message);
  const window = parseDateWindowHeuristic(message, now);
  const tokens = mergeTokens(message, null);

  const effectiveIntent = {
    wantsCount: intent.wantsCount,
    wantsNext: intent.wantsNext,
    wantsLast: intent.wantsLast,
    wantsCancelled: intent.wantsCancelled,
    asksWhen: intent.asksWhen,
    asksAllDay: intent.asksAllDay,
    asksWhere: intent.asksWhere,
    asksWho: intent.asksWho,
    asksWhat: intent.asksWhat,
    asksUpcomingList: intent.asksUpcomingList,
    asksScheduleList: intent.asksScheduleList,
    asksEventList: intent.asksEventList,
    durationFilter: intent.durationFilter,
  };

  let filtered = events.filter((event) => eventOverlapsWindow(event, window));
  if (effectiveIntent.asksAllDay) {
    filtered = filtered.filter((event) => /^\d{4}-\d{2}-\d{2}$/.test(String(event.start || '')));
  }
  filtered = rankEventsByText(filtered, tokens);
  filtered = preferExactSummaryMatches(filtered, tokens);

  if (effectiveIntent.wantsNext) {
    filtered = filtered
      .filter((event) => {
        const start = new Date(event.start);
        return Number.isFinite(start.getTime()) ? start >= now : false;
      })
      .slice(0, 1);
  } else if (effectiveIntent.wantsLast) {
    filtered = filtered
      .slice()
      .sort((a, b) => new Date(b.start) - new Date(a.start))
      .slice(0, 1);
  }

  const data = buildChatReplyData({
    message,
    results: filtered,
    intent: effectiveIntent,
    window,
  });

  return {
    reply: formatFallbackResponse(data),
    filtered,
  };
}

function findFirstUsableEvent(events) {
  const withLocation = events.find((event) => event.summary && event.location);
  const withTime = events.find((event) => event.summary && event.start);
  const withDescription = events.find((event) => event.summary && event.description);
  const withPeople = events.find(
    (event) =>
      event.summary &&
      (
        (Array.isArray(event.attendeeNames) && event.attendeeNames.length) ||
        (Array.isArray(event.attendeeEmails) && event.attendeeEmails.length) ||
        event.organizerEmail ||
        event.creatorEmail
      )
  );
  const allDay = events.find((event) => /^\d{4}-\d{2}-\d{2}$/.test(String(event.start || '')));
  return { withLocation, withTime, withDescription, withPeople, allDay };
}

async function main() {
  const email = process.env.CHAT_TEST_EMAIL;
  if (!email) {
    throw new Error('CHAT_TEST_EMAIL is required for live chatbot tests.');
  }

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME);
  const events = await db.collection('calendar_events')
    .find(
      {
        email,
        $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
        status: { $ne: 'cancelled' },
      },
      {
        projection: {
          _id: 0,
          summary: 1,
          description: 1,
          location: 1,
          start: 1,
          end: 1,
          organizerEmail: 1,
          creatorEmail: 1,
          attendeeEmails: 1,
          attendeeNames: 1,
        },
      }
    )
    .sort({ startAt: 1, start: 1 })
    .toArray();

  assert(events.length > 0, `No active events found for ${email}.`);

  const { withLocation, withTime, withDescription, withPeople, allDay } = findFirstUsableEvent(events);
  assert(withTime, 'No usable timed event found for live chatbot tests.');

  const checks = [
    {
      label: 'next event',
      message: 'What is my next event?',
      validate: ({ reply }) => assert(reply.includes('Your next event is')),
    },
    {
      label: 'upcoming list',
      message: 'List my upcoming events',
      validate: ({ reply }) => assert(reply.includes('Here are your events:')),
    },
    {
      label: 'list them follow-up',
      message: 'list them',
      validate: ({ reply }) => assert(reply.includes('Here are your events:')),
    },
    {
      label: 'count today',
      message: 'How many events do I have today?',
      validate: ({ reply }) => assert(reply.length > 0),
    },
    {
      label: 'count this week',
      message: 'How many events do I have this week?',
      validate: ({ reply }) => assert(reply.length > 0),
    },
    {
      label: 'count next week',
      message: 'How many events do I have next week?',
      validate: ({ reply }) => assert(reply.length > 0),
    },
    {
      label: 'last event',
      message: 'when is my last event',
      validate: ({ reply }) => assert(reply.includes('Your last event is')),
    },
    {
      label: 'schedule this month',
      message: 'What is my schedule this month?',
      validate: ({ reply }) => assert(reply.length > 0),
    },
    {
      label: 'when by title',
      message: `When is ${withTime.summary}?`,
      validate: ({ reply }) => assert(reply.includes(`'${withTime.summary}' is scheduled`)),
    },
  ];

  if (withLocation) {
    checks.push({
      label: 'where by title',
      message: `Where is ${withLocation.summary}?`,
      validate: ({ reply, filtered }) => {
        assert(reply.includes(withLocation.location));
        assert(filtered[0]?.summary === withLocation.summary);
      },
    });
    checks.push({
      label: 'where next event',
      message: 'Where is my next event?',
      validate: ({ reply }) => assert(reply.length > 0),
    });
  }

  if (withDescription) {
    checks.push({
      label: 'what by title',
      message: `Tell me about ${withDescription.summary}`,
      validate: ({ reply }) => {
        assert(reply.includes(withDescription.summary));
        assert(reply.length > 0);
      },
    });
  }

  if (withPeople) {
    checks.push({
      label: 'who by title',
      message: `Who is ${withPeople.summary} with?`,
      validate: ({ reply }) => assert(reply.length > 0),
    });
    checks.push({
      label: 'who next event',
      message: 'Who is my next event with?',
      validate: ({ reply }) => assert(reply.length > 0),
    });
  }

  if (allDay) {
    checks.push({
      label: 'all day events',
      message: 'Show me all day events',
      validate: ({ reply }) => assert(reply.includes(allDay.summary)),
    });
  }

  console.log(`Testing live chatbot logic for ${email} with ${events.length} events.`);
  for (const check of checks) {
    const result = answerQuestion(check.message, events, new Date());
    check.validate(result);
    console.log(`PASS: ${check.label} -> ${check.message}`);
    console.log(`  ${result.reply}`);
  }

  await client.close();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
