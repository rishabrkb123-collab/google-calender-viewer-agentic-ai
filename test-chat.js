const { createOllamaClient } = require('./utils/ollama');
const { inferWithModel } = require('./routes/chat');

// Test the chat functionality
async function testChat() {
  const ollama = createOllamaClient({
    baseUrl: 'http://localhost:11434',
    model: 'gpt-oss:120b-cloud',
    timeoutMs: 60000,
  });

  const testMessages = [
    "Hello!",
    "Show me my meetings for tomorrow",
    "How many events do I have next week?",
    "What's my next event?",
    "Find all-day events in March",
    "List events with John",
    "When is my meeting with Sarah?",
  ];

  for (const message of testMessages) {
    console.log(`\nTesting message: "${message}"`);
    try {
      const intent = await inferWithModel({ ollama, message });
      console.log('Intent detected:', JSON.stringify(intent, null, 2));
    } catch (error) {
      console.error('Error:', error.message);
    }
  }
}

testChat();