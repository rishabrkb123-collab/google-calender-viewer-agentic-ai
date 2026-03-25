// Test the fix for the matchesText function
const fs = require('fs');
const path = require('path');

// Simulate the functions we need
function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTextToken(term) {
  const BASE_STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'to', 'of', 'for', 'with', 'in', 'on', 'at',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'by', 'from', 'as', 'if', 'then',
    'this', 'that', 'these', 'those', 'there', 'here', 'about', 'show', 'list', 'find',
    'event', 'events', 'calendar', 'slot', 'slots', 'meeting', 'meetings',
    'when', 'what', 'which', 'who', 'where', 'why', 'how',
    'do', 'does', 'did', 'have', 'has', 'had', 'can', 'could', 'would', 'should',
    'i', 'me', 'my', 'mine', 'you', 'your', 'yours', 'we', 'our', 'ours', 'they', 'their',
    'any', 'all', 'only', 'just', 'please', 'tell', 'say', 'need', 'want', 'exactly',
    'today', 'tomorrow', 'yesterday', 'week', 'month', 'year', 'date', 'dates', 'time', 'times',
    'next', 'this', 'last', 'upcoming', 'current', 'mins', 'min', 'minute', 'minutes',
    'more', 'less', 'than', 'over', 'under', 'above', 'below', 'least', 'most', 'at', 'after', 'before',
    'many', 'full', 'day',
  ]);

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

function tokenizeQuery(text) {
  return cleanTextToken(text);
}

// Original buggy function
function matchesTextOriginal(event, tokens) {
  if (!tokens.length) return true;

  const searchableFields = [
    event.summary,
    event.description,
    event.location,
    event.organizerEmail,
    event.creatorEmail,
    event.status
  ].filter(Boolean);

  const searchable = normalizeText(searchableFields.join(' '));

  if (tokens.length === 0) return true;

  return tokens.some(token => {
    if (searchable.includes(token)) return true;
    const words = searchable.split(/\s+/);
    return words.some(word => word.includes(token));
  });
}

// Fixed function
function matchesTextFixed(event, tokens) {
  // If no tokens, match everything (show all events)
  if (!tokens || !tokens.length) return true;

  const searchableFields = [
    event.summary,
    event.description,
    event.location,
    event.organizerEmail,
    event.creatorEmail,
    event.status
  ].filter(Boolean);

  const searchable = normalizeText(searchableFields.join(' '));

  // For each token, check if it matches any part of the searchable text
  return tokens.some(token => {
    if (searchable.includes(token)) return true;
    const words = searchable.split(/\s+/);
    return words.some(word => word.includes(token));
  });
}

// Test cases
const testEvent = {
  summary: "holiii ada",
  description: "Special event for testing",
  location: "Home",
  start: "2026-03-04T10:00:00+05:30"
};

console.log("Testing 'how many events do I have' query...");
const originalTokens = tokenizeQuery("how many events do I have");
console.log("Original tokens:", originalTokens);

const originalResult = matchesTextOriginal(testEvent, originalTokens);
console.log("Original function result:", originalResult);

const fixedResult = matchesTextFixed(testEvent, originalTokens);
console.log("Fixed function result:", fixedResult);

console.log("\nTesting 'list all events' query...");
const tokens2 = tokenizeQuery("list all events");
console.log("Tokens:", tokens2);

const result2 = matchesTextFixed(testEvent, tokens2);
console.log("Result:", result2);

console.log("\nTesting with no tokens...");
const result3 = matchesTextFixed(testEvent, []);
console.log("Result with empty array:", result3);

const result4 = matchesTextFixed(testEvent, null);
console.log("Result with null:", result4);