// Minimal Anthropic Messages API client (fetch only). Configuration is read from the environment on every call:
//   ANTHROPIC_API_KEY (required) · ASSISTANT_MODEL (claude-haiku-5-5) · ASSISTANT_API_BASE (https://api.anthropic.com)
//   ASSISTANT_MAX_TOKENS (600) · ASSISTANT_TIMEOUT_MS (25000)
// Errors are mapped to clean statuses/messages; the key and the upstream response body are never exposed to callers.
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 && v !== '' && v !== undefined ? n : d; };

const config = () => ({
  key: (process.env.ANTHROPIC_API_KEY || '').trim(),
  model: process.env.ASSISTANT_MODEL || 'claude-haiku-5-5',
  base: (process.env.ASSISTANT_API_BASE || 'https://api.anthropic.com').replace(/\/+$/, ''),
  maxTokens: Math.floor(num(process.env.ASSISTANT_MAX_TOKENS, 600)),
  timeoutMs: num(process.env.ASSISTANT_TIMEOUT_MS, 25000),
  dailyLimit: (() => { const n = Number(process.env.ASSISTANT_DAILY_LIMIT); return Number.isFinite(n) && n >= 0 && process.env.ASSISTANT_DAILY_LIMIT !== '' && process.env.ASSISTANT_DAILY_LIMIT !== undefined ? Math.floor(n) : 30; })(),
});
const isConfigured = () => !!config().key;

class UpstreamError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

async function complete({ system, messages }) {
  const c = config();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), c.timeoutMs);
  let res;
  try {
    res = await fetch(`${c.base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': c.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: c.model, max_tokens: c.maxTokens, system, messages }),
      signal: ctl.signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') throw new UpstreamError(504, 'The assistant took too long to answer. Please try again.', 'timeout');
    console.error('[assistant] upstream unreachable:', e?.cause?.code || e?.message);
    throw new UpstreamError(502, 'The assistant service is unreachable right now. Please try again later.', 'unreachable');
  } finally { clearTimeout(timer); }

  if (!res.ok) {
    let type = ''; try { type = (await res.json())?.error?.type || ''; } catch { /* not JSON */ }
    console.error(`[assistant] upstream error HTTP ${res.status} ${type}`);
    if (res.status === 401 || res.status === 403) throw new UpstreamError(502, 'The assistant service rejected the server credentials. Please contact the administrator.', 'upstream_auth');
    if (res.status === 429 || res.status === 529) throw new UpstreamError(502, 'The assistant service is busy. Please try again in a moment.', 'upstream_busy');
    throw new UpstreamError(502, 'The assistant service returned an error. Please try again later.', 'upstream_error');
  }
  let json;
  try { json = await res.json(); } catch { throw new UpstreamError(502, 'The assistant service returned an unreadable answer.', 'bad_response'); }
  const text = (Array.isArray(json?.content) ? json.content : []).filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim();
  if (!text) throw new UpstreamError(502, 'The assistant returned an empty answer. Please rephrase your question.', 'empty');
  const tokens = (Number(json?.usage?.input_tokens) || 0) + (Number(json?.usage?.output_tokens) || 0);
  return { text: text.slice(0, 8000), tokens };
}

module.exports = { config, isConfigured, complete, UpstreamError };
