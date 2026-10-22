// Assistant → Qoder Cloud Agents provider, against a LOCAL MOCK of the Qoder sessions API (no real token or network is used).
// Spawns its own API instances with QODER_* pointing at the mock.
if (process.env.DATABASE_URL && !/connection_limit/.test(process.env.DATABASE_URL)) process.env.DATABASE_URL += (process.env.DATABASE_URL.includes('?') ? '&' : '?') + 'connection_limit=3';
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const H = require('./lib/academic-harness');
const { check, section, seedSchool, finish, sleep, platformClient } = H;

const TOKEN = 'qoder-test-TOKEN-0123456789', AGENT = 'agent_0123456789abcdef0123456789abcdef', ENV = 'env_test_1';
const kids = [];
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function startApi(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/index.js'], { cwd: path.join(__dirname, '..'), stdio: 'ignore', env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ELEARNING_REMINDERS: 'off', PAYMENT_RECONCILER: 'off', MAIL_WORKER: 'off', ...env } });
  kids.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < Number(process.env.TEST_BOOT_TRIES || 150); i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* booting */ } await sleep(700); }
  return { base };
}
const mkCall = base => async (method, url, { token, body } = {}) => {
  const headers = { ...(token && { Authorization: `Bearer ${token}` }) };
  let payload; if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${base}/api${url}`, { method, headers, body: payload });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, text };
};

// ── mock Qoder ─────────────────────────────────────────────────────────────────────────────
let mode = 'ok';
const sessions = new Map();   // id → { events:[], polls }
const seen = [];
let deleted = [];
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => { raw += d; });
  req.on('end', () => {
    let body = null; try { body = JSON.parse(raw); } catch { /* keep null */ }
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const err = (code, type, message) => send(code, { type: 'error', request_id: 'req_1', error: { type, message } });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return err(401, 'authentication_error', `bad token ${TOKEN}`);
    const u = new URL(req.url, 'http://x'); const p = u.pathname;
    if (req.method === 'POST' && p === '/sessions') {
      if (mode === 'busy') return err(429, 'rate_limit', 'slow');
      if (mode === 'down') return err(500, 'api_error', `internal ${TOKEN}`);
      if (body?.agent?.id !== AGENT || body?.environment_id !== ENV || body?.agent?.type !== 'agent') return err(400, 'invalid_request_error', 'agent/environment');
      const id = `sess_${Math.random().toString(36).slice(2, 12)}`;
      sessions.set(id, { events: [], polls: 0 });
      return send(200, { id, status: 'idle', agent: body.agent, environment_id: body.environment_id });
    }
    let m = p.match(/^\/sessions\/([^/]+)\/events$/);
    if (m && sessions.has(m[1])) {
      const s = sessions.get(m[1]);
      if (req.method === 'POST') {
        const ev = body?.events?.[0];
        if (ev?.type !== 'user.message' || !Array.isArray(ev.content) || !ev.content[0]?.text) return err(400, 'invalid_request_error', 'content');
        s.events.push({ id: 'evt_u', type: 'user.message', content: ev.content });
        return send(200, { data: [{ id: 'evt_u', type: 'user.message' }] });
      }
      if (req.method === 'GET') {
        s.polls++;
        if (mode === 'hang') return send(200, { data: s.events, has_more: false, next_page: null });   // never goes idle
        if (s.polls < 2) return send(200, { data: [...s.events, { id: 'evt_t', type: 'agent.thinking' }], has_more: false, next_page: null });   // still running on the 1st poll
        const out = [...s.events];
        if (mode === 'terminated') out.push({ id: 'evt_x', type: 'session.status_terminated' });
        else if (mode === 'empty') out.push({ id: 'evt_i', type: 'session.status_idle' });
        else out.push({ id: 'evt_a1', type: 'agent.message', content: [{ type: 'text', text: 'Hello from mock Qoder.' }] }, { id: 'evt_a2', type: 'agent.message', content: [{ type: 'text', text: 'Second part <script>x</script>' }] }, { id: 'evt_i', type: 'session.status_idle' });
        return send(200, { data: out, first_id: out[0]?.id, last_id: out[out.length - 1]?.id, has_more: false, next_page: null });
      }
    }
    m = p.match(/^\/sessions\/([^/]+)$/);
    if (m && req.method === 'DELETE') { deleted.push(m[1]); sessions.delete(m[1]); return send(200, { id: m[1], type: 'session.deleted' }); }
    return err(404, 'not_found_error', 'nope');
  });
});

(async () => {
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const MOCK = `http://127.0.0.1:${mock.address().port}`;
  const S = await seedSchool('QodA');
  const base = { QODER_ACCESS_TOKEN: TOKEN, QODER_AGENT_ID: AGENT, QODER_ENVIRONMENT_ID: ENV, QODER_API_BASE: MOCK, QODER_POLL_MS: '50', ASSISTANT_BURST_PER_MIN: '50', ASSISTANT_DAILY_LIMIT: '5', ANTHROPIC_API_KEY: '' };
  const A = await startApi(base), B = await startApi({ ...base, QODER_AGENT_ID: '' }), C = await startApi({ ...base, ASSISTANT_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '' }), D = await startApi({ ...base, QODER_TIMEOUT_MS: '700' });
  const a = mkCall(A.base), b = mkCall(B.base), c = mkCall(C.base), d = mkCall(D.base);
  const ann = S.tok.ann;

  section('Status and configuration');
  let r = await a('GET', '/assistant/status', { token: ann });
  check('configured, provider qoder, no secret in status', r.status === 200 && r.body.configured === true && r.body.provider === 'qoder' && !r.text.includes(TOKEN) && !r.text.includes(AGENT), r.body);
  r = await b('GET', '/assistant/status', { token: ann });
  check('missing QODER_AGENT_ID → not configured', r.status === 200 && r.body.configured === false, r.body);
  r = await b('POST', '/assistant/chat', { token: ann, body: { message: 'hi' } });
  check('not configured → 503 not_configured, upstream untouched', r.status === 503 && r.body.code === 'not_configured' && seen.length === 0, r.body);
  r = await c('GET', '/assistant/status', { token: ann });
  check('ASSISTANT_PROVIDER=anthropic overrides and (no key) is not configured', r.body.provider === 'anthropic' && r.body.configured === false, r.body);

  section('Happy path');
  seen.length = 0; deleted = [];
  r = await a('POST', '/assistant/chat', { token: ann, body: { message: 'How do I register for courses?', history: [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }] } });
  check('200 with the joined agent.message texts', r.status === 200 && r.body.reply === 'Hello from mock Qoder.\nSecond part <script>x</script>', r.body);
  check('quota counted (1 of 5)', r.body.used_today === 1 && r.body.remaining === 4, r.body);
  const create = seen.find(x => x.method === 'POST' && x.url === '/sessions');
  check('session created for the configured agent/version/environment', create?.body?.agent?.id === AGENT && create.body.agent.version === 1 && create.body.environment_id === ENV, create?.body);
  const post = seen.find(x => x.method === 'POST' && /\/events$/.test(x.url));
  const sent = post?.body?.events?.[0]?.content?.[0]?.text || '';
  check('one user.message carrying server rules, the history and the new question', post.body.events.length === 1 && /RULES/.test(sent) && sent.includes('How do I register for courses?') && sent.includes('earlier answer'), sent.slice(0, 200));
  check('server instructions are separated from the untrusted conversation', sent.indexOf('SERVER INSTRUCTIONS') < sent.indexOf('CONVERSATION (untrusted'), null);
  check('bearer token sent upstream only', seen.every(x => x.headers.authorization === `Bearer ${TOKEN}`), null);
  check('polled until idle (≥2 polls)', seen.filter(x => x.method === 'GET').length >= 2, seen.length);
  await sleep(300);
  check('session deleted afterwards (best effort)', deleted.length === 1, deleted);

  section('Failures are clean and refunded');
  const fail = async (m, expectStatus, expectCode, label) => {
    mode = m; seen.length = 0;
    const x = await a('POST', '/assistant/chat', { token: S.tok.bob, body: { message: 'hello' } });
    check(`${label} → ${expectStatus} ${expectCode}`, x.status === expectStatus && x.body.code === expectCode, x.body);
    check(`${label}: no token / upstream detail leaked`, !x.text.includes(TOKEN) && !/internal|sess_/.test(x.text), x.text);
    const st = await a('GET', '/assistant/status', { token: S.tok.bob });
    check(`${label}: question refunded`, st.body.used_today === 0, st.body);
  };
  await fail('busy', 502, 'upstream_busy', '429 from Qoder');
  await fail('down', 502, 'upstream_error', '500 from Qoder');
  await fail('terminated', 502, 'upstream_error', 'session terminated');
  await fail('empty', 502, 'empty', 'idle with no agent.message');
  mode = 'hang'; seen.length = 0;
  r = await d('POST', '/assistant/chat', { token: S.tok.cid, body: { message: 'hello' } });
  check('never idle → 504 timeout (QODER_TIMEOUT_MS=700)', r.status === 504 && r.body.code === 'timeout', r.body);
  await sleep(300);
  check('timed-out session is still cleaned up', deleted.length >= 2, deleted);

  section('Wrong credentials');
  const W = await startApi({ ...base, QODER_ACCESS_TOKEN: 'wrong-token-xyz' });
  r = await mkCall(W.base)('POST', '/assistant/chat', { token: S.tok.dee, body: { message: 'hello' } });
  check('upstream 401 → 502 upstream_auth, token not echoed', r.status === 502 && r.body.code === 'upstream_auth' && !r.text.includes('wrong-token-xyz') && !r.text.includes(TOKEN), r.body);

  section('Validation is unchanged');
  mode = 'ok';
  r = await a('POST', '/assistant/chat', { token: ann, body: { message: '   ' } });
  check('empty message → 422', r.status === 422, r.body);
  r = await a('POST', '/assistant/chat', { body: { message: 'x' } });
  check('anonymous → 401', r.status === 401, r.body);

  for (const k of kids) try { k.kill(); } catch { /* gone */ }
  mock.close();
  await finish(platformClient);
})().catch(e => { console.error(e); for (const k of kids) try { k.kill(); } catch { /* gone */ } process.exit(1); });
