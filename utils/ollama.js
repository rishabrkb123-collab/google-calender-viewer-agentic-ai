const DEFAULT_TIMEOUT_MS = 60000;

function normalizeBaseUrl(value) {
  const base = String(value || '').trim() || 'http://localhost:11434';
  return base.replace(/\/$/, '');
}

function cleanupModelText(text) {
  if (!text) return '';
  return String(text).replace(/```(?:json)?/gi, '').trim();
}

function extractFirstJsonObject(text) {
  const cleaned = cleanupModelText(text);
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  return cleaned.slice(first, last + 1);
}

function createOllamaClient({ baseUrl, model, timeoutMs } = {}) {
  const url = `${normalizeBaseUrl(baseUrl)}/api/generate`;
  const defaultModel = String(model || 'gpt-oss:120b-cloud').trim() || 'gpt-oss:120b-cloud';
  const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : DEFAULT_TIMEOUT_MS;

  async function generate({ prompt, model: overrideModel } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      console.log(`[ollama] Generating response with model: ${overrideModel || defaultModel}`);
      console.log(`[ollama] Prompt length: ${String(prompt || '').length} characters`);

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: String(overrideModel || defaultModel),
          prompt: String(prompt || ''),
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errorText = await resp.text().catch(() => '');
        const errorMsg = `Ollama error: ${errorText || resp.statusText} (Status: ${resp.status})`;
        console.error(`[ollama] ${errorMsg}`);
        throw new Error(errorMsg);
      }

      const data = await resp.json();
      const response = String(data?.response || '').trim();
      console.log(`[ollama] Response length: ${response.length} characters`);

      return response;
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error(`[ollama] Request timed out after ${timeout}ms`);
        throw new Error(`Ollama request timed out after ${timeout}ms`);
      }
      console.error(`[ollama] Error: ${error.message}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    generate,
    extractFirstJsonObject,
    cleanupModelText,
  };
}

module.exports = {
  createOllamaClient,
  extractFirstJsonObject,
  cleanupModelText,
};
