// Local MOCK servers that imitate the MTN MoMo, Orange Money and Stripe HTTP APIs, so the payment adapters
// and the settlement logic can be exercised end-to-end WITHOUT contacting (or pretending to be) a real provider.
// They implement the request/response shapes our adapters rely on; they prove OUR code's behaviour
// (verification, idempotency, mismatches, timeouts…) — they do not prove the real providers' sandboxes accept
// our requests. That still has to be confirmed with real sandbox credentials (see docs/PAYMENTS.md).
const http = require('http');
const { v4: uuid } = require('uuid');

function server(port, handler) {
  return new Promise(resolve => {
    const s = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      const send = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      try { await handler(req, raw, send, res); } catch (e) { send(500, { error: e.message }); }
    }).listen(port, '127.0.0.1', () => resolve(s));
  });
}
const json = raw => { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } };

// ── MTN MoMo ─────────────────────────────────────────────────────────────────
async function mtn(port = 4101) {
  const state = { requests: {}, calls: [] };
  const srv = await server(port, async (req, raw, send) => {
    const url = req.url.split('?')[0];
    state.calls.push(`${req.method} ${url}`);
    if (url === '/collection/token/' && req.method === 'POST') {
      if (!/^Basic /.test(req.headers.authorization || '') || !req.headers['ocp-apim-subscription-key']) return send(401, { error: 'bad credentials' });
      return send(200, { access_token: 'mtn-token', token_type: 'access_token', expires_in: 3600 });
    }
    if (!/^Bearer mtn-token$/.test(req.headers.authorization || '')) return send(401, { error: 'no token' });
    if (url === '/collection/v1_0/requesttopay' && req.method === 'POST') {
      const id = req.headers['x-reference-id'];
      if (!id || !req.headers['x-target-environment']) return send(400, { error: 'missing headers' });
      const b = json(raw);
      if (b.payer?.partyId === '237670000098') return send(500, { error: 'upstream failure' });
      if (b.payer?.partyId === '237670000099') await new Promise(r => setTimeout(r, 3500));   // slower than our timeout
      state.requests[id] = { id, body: b, status: 'PENDING', callback: req.headers['x-callback-url'] || null };
      return send(202);
    }
    const m = url.match(/^\/collection\/v1_0\/requesttopay\/([\w-]+)$/);
    if (m && req.method === 'GET') {
      const r = state.requests[m[1]];
      if (!r) return send(404, { code: 'RESOURCE_NOT_FOUND' });
      return send(200, { amount: r.amount ?? r.body.amount, currency: r.currency ?? r.body.currency, externalId: r.body.externalId, payer: r.body.payer, status: r.status, financialTransactionId: r.status === 'SUCCESSFUL' ? `fin-${r.id.slice(0, 8)}` : undefined, reason: r.reason });
    }
    send(404, { error: 'not found' });
  });
  const byExternal = ref => Object.values(state.requests).find(r => r.body.externalId === ref);
  return { srv, state, byExternal, set: (ref, patch) => Object.assign(byExternal(ref), patch), close: () => srv.close() };
}

// ── Orange Money WebPay ──────────────────────────────────────────────────────────
async function orange(port = 4102) {
  const state = { orders: {}, calls: [] };
  const srv = await server(port, async (req, raw, send) => {
    const url = req.url.split('?')[0];
    state.calls.push(`${req.method} ${url}`);
    if (url === '/oauth/v3/token') {
      if (!/^Basic /.test(req.headers.authorization || '') || !/grant_type=client_credentials/.test(raw)) return send(401, { error: 'bad credentials' });
      return send(200, { access_token: 'orange-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (req.headers.authorization !== 'Bearer orange-token') return send(401, { error: 'no token' });
    const b = json(raw);
    if (url === '/orange-money-webpay/cm/v1/webpayment') {
      if (!b.merchant_key || !b.order_id || !b.amount || !b.return_url || !b.notif_url) return send(400, { message: 'invalid payload' });
      const pay_token = `pt-${uuid().slice(0, 12)}`, notif_token = `nt-${uuid().slice(0, 12)}`;
      state.orders[b.order_id] = { ...b, pay_token, notif_token, status: 'INITIATED' };
      return send(200, { status: 201, message: 'OK', pay_token, payment_url: `http://127.0.0.1:${port}/pay/${pay_token}`, notif_token });
    }
    if (url === '/orange-money-webpay/cm/v1/transactionstatus') {
      const o = state.orders[b.order_id];
      if (!o || o.pay_token !== b.pay_token || Number(o.amount) !== Number(b.amount)) return send(404, { message: 'unknown transaction' });
      return send(200, { status: o.status, order_id: o.order_id, txnid: o.status === 'SUCCESS' ? `MP${o.pay_token.slice(3, 11)}` : undefined });
    }
    send(404, { error: 'not found' });
  });
  return { srv, state, set: (orderId, status) => { state.orders[orderId].status = status; }, close: () => srv.close() };
}

// ── Stripe (just the endpoints our adapter calls) ────────────────────────────────
function parseForm(raw) {
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) {
    const path = k.replace(/\]/g, '').split('[');
    let o = out;
    path.forEach((p, i) => { if (i === path.length - 1) o[p] = v; else o = (o[p] ??= {}); });
  }
  return out;
}
async function stripe(port = 4103) {
  const state = { sessions: {}, refunds: [], calls: [], idempotency: new Set() };
  const srv = await server(port, async (req, raw, send) => {
    const url = req.url.split('?')[0];
    state.calls.push(`${req.method} ${url}`);
    if (!/^Bearer sk_test_mock$/.test(req.headers.authorization || '')) return send(401, { error: { message: 'Invalid API Key' } });
    if (url === '/v1/checkout/sessions' && req.method === 'POST') {
      const f = parseForm(raw);
      const li = f.line_items?.['0'];
      const id = `cs_test_${uuid().replace(/-/g, '').slice(0, 20)}`;
      const s = {
        id, object: 'checkout.session', url: `https://checkout.stripe.test/c/pay/${id}`, mode: f.mode, status: 'open', payment_status: 'unpaid',
        amount_total: Number(li?.price_data?.unit_amount), currency: li?.price_data?.currency, client_reference_id: f.client_reference_id, metadata: f.metadata || {}, payment_intent: null,
      };
      state.sessions[id] = s;
      return send(200, s);
    }
    let m = url.match(/^\/v1\/checkout\/sessions\/(cs_test_\w+)(\/expire)?$/);
    if (m) {
      const s = state.sessions[m[1]];
      if (!s) return send(404, { error: { message: 'No such checkout.session' } });
      if (m[2]) { if (s.status === 'open') s.status = 'expired'; return send(200, s); }
      return send(200, s);
    }
    if (url === '/v1/refunds' && req.method === 'POST') {
      const f = parseForm(raw);
      const r = { id: `re_${uuid().slice(0, 12)}`, object: 'refund', status: 'succeeded', amount: Number(f.amount), payment_intent: f.payment_intent };
      state.refunds.push(r); return send(200, r);
    }
    send(404, { error: { message: 'not found' } });
  });
  return {
    srv, state, close: () => srv.close(),
    pay: (id, patch = {}) => Object.assign(state.sessions[id], { status: 'complete', payment_status: 'paid', payment_intent: `pi_${id.slice(8, 20)}` }, patch),
    set: (id, patch) => Object.assign(state.sessions[id], patch),
    byReference: ref => Object.values(state.sessions).find(s => s.client_reference_id === ref),
  };
}

module.exports = { mtn, orange, stripe };
