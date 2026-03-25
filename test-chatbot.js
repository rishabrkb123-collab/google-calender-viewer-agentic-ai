const assert = require('assert');
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

const now = new Date('2026-03-10T09:00:00+05:30');
const events = [
  {
    summary: 'Team Standup',
    description: 'Daily sync with engineering',
    location: 'Zoom',
    organizerEmail: 'manager@example.com',
    creatorEmail: 'manager@example.com',
    attendeeEmails: ['alex@example.com', 'sarah@example.com'],
    attendeeNames: ['Alex', 'Sarah'],
    start: '2026-03-10T10:00:00+05:30',
    end: '2026-03-10T10:30:00+05:30',
  },
  {
    summary: 'Lunch with Alex',
    description: 'Discuss roadmap',
    location: 'Cafe Terra',
    organizerEmail: 'alex@example.com',
    creatorEmail: 'alex@example.com',
    attendeeEmails: ['alex@example.com'],
    attendeeNames: ['Alex'],
    start: '2026-03-10T13:00:00+05:30',
    end: '2026-03-10T14:00:00+05:30',
  },
  {
    summary: 'Design Review with Sarah',
    description: 'Review calendar chatbot UI',
    location: 'Meeting Room 2',
    organizerEmail: 'sarah@example.com',
    creatorEmail: 'sarah@example.com',
    attendeeEmails: ['sarah@example.com'],
    attendeeNames: ['Sarah'],
    start: '2026-03-11T15:00:00+05:30',
    end: '2026-03-11T16:00:00+05:30',
  },
  {
    summary: 'Office Holiday',
    description: 'Holiday',
    location: '',
    organizerEmail: 'hr@example.com',
    creatorEmail: 'hr@example.com',
    attendeeEmails: [],
    attendeeNames: [],
    start: '2026-03-12',
    end: '2026-03-12',
  },
  {
    summary: 'Client Planning Session',
    description: 'Quarterly planning with Priya and John',
    location: 'Conference Room A',
    organizerEmail: 'priya@example.com',
    creatorEmail: 'priya@example.com',
    attendeeEmails: ['priya@example.com', 'john@example.com'],
    attendeeNames: ['Priya', 'John'],
    start: '2026-03-17T09:30:00+05:30',
    end: '2026-03-17T10:30:00+05:30',
  },
  {
    summary: 'Doctor Appointment',
    description: 'Routine checkup',
    location: 'City Clinic',
    organizerEmail: 'clinic@example.com',
    creatorEmail: 'clinic@example.com',
    attendeeEmails: [],
    attendeeNames: [],
    start: '2026-03-18T18:00:00+05:30',
    end: '2026-03-18T18:45:00+05:30',
  },
];

const cases = [
  {
    message: 'How many events do I have today?',
    check: ({ reply }) => assert(reply.includes('You have 2 events for today.')),
  },
  {
    message: "What's my next event?",
    check: ({ reply }) => assert(reply.includes("Your next event is 'Team Standup'")),
  },
  {
    message: 'When is my design review with Sarah?',
    check: ({ reply }) => assert(reply.includes("'Design Review with Sarah' is scheduled")),
  },
  {
    message: 'Where is my lunch with Alex?',
    check: ({ reply }) => assert(reply.includes("'Lunch with Alex' is at Cafe Terra.")),
  },
  {
    message: 'Who is my meeting with Sarah?',
    check: ({ reply }) => assert(reply.includes('Sarah')),
  },
  {
    message: 'List my upcoming events',
    check: ({ reply }) => {
      assert(reply.includes('Here are your events:'));
      assert(reply.includes('Team Standup'));
      assert(reply.includes('Lunch with Alex'));
    },
  },
  {
    message: 'Where is my next event?',
    check: ({ reply }) => assert(reply.includes('is at Zoom.')),
  },
  {
    message: 'Show me all day events',
    check: ({ reply }) => assert(reply.includes('Office Holiday')),
  },
  {
    message: 'Where is Team Standup?',
    check: ({ reply, filtered }) => {
      assert(reply.includes("'Team Standup' is at Zoom."));
      assert.strictEqual(filtered.length, 1);
    },
  },
  {
    message: 'Which events do I have today?',
    check: ({ reply }) => {
      assert(reply.includes('Here are your events for today:'));
      assert(reply.includes('Team Standup'));
      assert(reply.includes('Lunch with Alex'));
    },
  },
  {
    message: 'What do I have tomorrow?',
    check: ({ reply }) => assert(reply.includes('Design Review with Sarah')),
  },
  {
    message: 'How many events do I have tomorrow?',
    check: ({ reply }) => assert(reply.includes('You have 1 events for tomorrow.')),
  },
  {
    message: 'How many events do I have this week?',
    check: ({ reply }) => assert(reply.includes('You have 4 events for this week.')),
  },
  {
    message: 'How many events do I have next week?',
    check: ({ reply }) => assert(reply.includes('You have 2 events for next week.')),
  },
  {
    message: 'Show me events next week',
    check: ({ reply }) => {
      assert(reply.includes('Client Planning Session'));
      assert(reply.includes('Doctor Appointment'));
    },
  },
  {
    message: 'When is Client Planning Session?',
    check: ({ reply, filtered }) => {
      assert(reply.includes("'Client Planning Session' is scheduled"));
      assert.strictEqual(filtered.length, 1);
    },
  },
  {
    message: 'Where is Client Planning Session?',
    check: ({ reply }) => assert(reply.includes('Conference Room A')),
  },
  {
    message: 'Who is Client Planning Session with?',
    check: ({ reply }) => {
      assert(reply.includes('Priya'));
      assert(reply.includes('John'));
    },
  },
  {
    message: 'What is Client Planning Session about?',
    check: ({ reply }) => {
      assert(reply.includes('Client Planning Session'));
      assert(reply.includes('Description: Quarterly planning with Priya and John'));
    },
  },
  {
    message: 'What is my schedule today?',
    check: ({ reply }) => {
      assert(reply.includes('Team Standup'));
      assert(reply.includes('Lunch with Alex'));
    },
  },
  {
    message: 'Do I have any all day events this week?',
    check: ({ reply }) => assert(reply.includes('Office Holiday')),
  },
  {
    message: 'Where is Doctor Appointment?',
    check: ({ reply, filtered }) => {
      assert(reply.includes('City Clinic'));
      assert.strictEqual(filtered.length, 1);
    },
  },
  {
    message: 'When is lunch with Alex?',
    check: ({ reply }) => assert(reply.includes("'Lunch with Alex' is scheduled")),
  },
  {
    message: 'Who is my next event with?',
    check: ({ reply }) => {
      assert(reply.includes('Alex'));
      assert(reply.includes('Sarah'));
    },
  },
  {
    message: 'Where is my design review with Sarah?',
    check: ({ reply }) => assert(reply.includes('Meeting Room 2')),
  },
  {
    message: 'What is my next event about?',
    check: ({ reply }) => assert(reply.includes("Your next event is 'Team Standup'")),
  },
  {
    message: 'Tell me about Team Standup',
    check: ({ reply }) => {
      assert(reply.includes('Team Standup'));
      assert(reply.includes('Description: Daily sync with engineering'));
    },
  },
  {
    message: 'list them',
    check: ({ reply }) => {
      assert(reply.includes('Here are your events:'));
      assert(reply.includes('Team Standup'));
    },
  },
  {
    message: 'when is my last event',
    check: ({ reply }) => assert(reply.includes("Your last event is 'Doctor Appointment'") || reply.includes("Your last event is 'Hello event'")),
  },
  {
    message: 'what events do i have in the month of march',
    check: ({ reply }) => {
      assert(reply.includes('Here are your events for march 2026:') || reply.includes('Here are your events for March 2026:') || reply.includes('Here are your events for march 2026'));
      assert(reply.includes('Team Standup'));
      assert(reply.includes('Doctor Appointment'));
    },
  },
];

let passed = 0;
for (const testCase of cases) {
  const result = answerQuestion(testCase.message, events, now);
  testCase.check(result);
  passed += 1;
  console.log(`PASS: ${testCase.message}`);
}

console.log(`\n${passed}/${cases.length} chatbot regression checks passed.`);
