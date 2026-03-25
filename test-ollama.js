const express = require('express');
const { createOllamaClient } = require('./utils/ollama');

// Test the Ollama client
async function testOllama() {
  const ollama = createOllamaClient({
    baseUrl: 'http://localhost:11434',
    model: 'gpt-oss:120b-cloud',
    timeoutMs: 60000,
  });

  try {
    console.log('Testing Ollama connection...');
    const response = await ollama.generate({
      prompt: 'Hello, how are you?',
    });
    console.log('Ollama response:', response);
  } catch (error) {
    console.error('Ollama test failed:', error.message);
  }
}

testOllama();