// Small fetch wrapper for provider calls: hard timeout, JSON in/out, and optional retry for safe (idempotent) calls.
const { providerTimeoutMs } = require('./config');

class ProviderError extends Error {
  constructor(message, { status, body, retryable } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.body = body;
    this.retryable = !!retryable;
  }
}

async function once(url, { method = 'GET', headers = {}, body, form, timeoutMs = providerTimeoutMs() } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const h = { Accept: 'application/json', ...headers };
    let payload;
    if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(form).toString(); }
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(url, { method, headers: h, body: payload, signal: ctl.signal });
    const text = await res.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!res.ok) throw new ProviderError(`Provider responded ${res.status}`, { status: res.status, body: json ?? text, retryable: res.status >= 500 || res.status === 429 });
    return { status: res.status, body: json, headers: res.headers };
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError(e.name === 'AbortError' ? 'Provider timed out' : `Provider unreachable: ${e.message}`, { retryable: true });
  } finally { clearTimeout(timer); }
}

// retries: only pass > 0 for calls that are safe to repeat (status lookups, token fetches) — NEVER for charge creation.
async function call(url, opts = {}, retries = 0) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await once(url, opts); }
    catch (e) { last = e; if (!(e instanceof ProviderError) || !e.retryable || i === retries) throw e; await new Promise(r => setTimeout(r, 300 * 2 ** i)); }
  }
  throw last;
}

module.exports = { call, ProviderError };
