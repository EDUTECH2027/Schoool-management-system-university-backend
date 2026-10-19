// Provider → EduTech notifications. These endpoints are unauthenticated by nature, so they NEVER move money
// on the strength of what the request says:
//   • Stripe: the signature is verified, then the checkout session is re-retrieved from Stripe.
//   • MTN / Orange: the URL carries an HMAC token we issued, Orange's notif_token must match the one stored at
//     initiation, and the result is always confirmed by a server-to-server status call.
// Every delivery is recorded (unique per provider + event id) so replays and late/duplicate notifications are harmless.
const crypto = require('crypto');
const express = require('express');
const { v4: uuid } = require('uuid');
const platformClient = require('../db/platformClient');
const tenantPool = require('../db/tenantPool');
const providers = require('../payments/providers');
const svc = require('../payments/service');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');

async function tenantFor(schoolId) {
  const school = await platformClient.school.findUnique({ where: { id: String(schoolId) }, select: { id: true } });
  return school ? tenantPool.getOrOpen(school.id) : null;
}

// Returns false when this exact delivery has been seen before.
async function recordDelivery(db, provider, eventId, payload) {
  try { await db.paymentWebhookEvent.create({ data: { id: uuid(), provider, event_id: eventId, payload } }); return true; }
  catch (e) { if (e.code === 'P2002') return false; throw e; }
}
const finish = (db, provider, eventId, outcome) =>
  db.paymentWebhookEvent.updateMany({ where: { provider, event_id: eventId }, data: { outcome, processed_at: new Date() } }).catch(() => {});

function mount(app) {
  // Stripe needs the exact raw bytes for signature verification → mounted BEFORE express.json().
  app.post('/api/payments/webhooks/stripe', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const stripe = providers.get('stripe');
    if (!stripe.isConfigured()) return res.status(503).json({ error: 'Stripe is not configured' });
    let evt;
    try { evt = stripe.parseWebhook(req.body, req.headers['stripe-signature']); }
    catch { return res.status(400).json({ error: 'Invalid signature' }); }
    if (!evt.transactionId || !evt.schoolId) return res.json({ received: true, ignored: 'no transaction metadata' });
    const db = await tenantFor(evt.schoolId);
    if (!db) return res.json({ received: true, ignored: 'unknown school' });
    const fresh = await recordDelivery(db, 'stripe', evt.eventId, { type: evt.type, sessionId: evt.sessionId });
    try {
      const tx = await db.paymentTransaction.findUnique({ where: { id: evt.transactionId } });
      if (!tx || tx.provider !== 'stripe') { await finish(db, 'stripe', evt.eventId, 'unknown_transaction'); return res.json({ received: true }); }
      const relevant = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired'];
      if (!relevant.includes(evt.type)) { await finish(db, 'stripe', evt.eventId, 'ignored_type'); return res.json({ received: true }); }
      // Re-delivery is cheap and idempotent: always re-verify (also covers an earlier attempt that crashed mid-way).
      const r = await svc.verifyAndApply(db, tx, 'provider_webhook');
      if (r.error) return res.status(500).json({ error: 'Verification failed, retry later' });   // makes Stripe retry
      await finish(db, 'stripe', evt.eventId, r.changed ? `applied:${r.tx.status}` : (fresh ? 'no_change' : 'duplicate'));
      res.json({ received: true });
    } catch (e) { console.error('[stripe webhook]', e.message); res.status(500).json({ error: 'Processing failed' }); }
  });

  const json = express.json({ limit: '100kb' });
  // MTN: PUT/POST callback with an UNSIGNED body → only a trigger to re-query. Orange: POST {status, notif_token, txnid}.
  app.all('/api/payments/webhooks/:provider(mtn_momo|orange_money)/:schoolId/:reference', json, async (req, res) => {
    const { provider, schoolId, reference } = req.params;
    if (!svc.checkCallbackToken(reference, req.query.t)) return res.status(401).json({ error: 'Bad token' });
    try {
      const db = await tenantFor(schoolId);
      if (!db) return res.json({ received: true });
      const tx = await db.paymentTransaction.findUnique({ where: { reference } });
      if (!tx || tx.provider !== provider) return res.json({ received: true });
      if (provider === 'orange_money' && req.method === 'POST' && tx.provider_secret && req.body?.notif_token !== tx.provider_secret) {
        return res.status(401).json({ error: 'Bad notification token' });
      }
      const eventId = sha(`${reference}|${req.method}|${JSON.stringify(req.body ?? {})}`);
      const fresh = await recordDelivery(db, provider, eventId, req.body ?? null);
      const r = await svc.verifyAndApply(db, tx, 'provider_webhook');
      await finish(db, provider, eventId, r.changed ? `applied:${r.tx.status}` : (fresh ? 'no_change' : 'duplicate'));
      res.json({ received: true });
    } catch (e) { console.error(`[${provider} webhook]`, e.message); res.status(500).json({ error: 'Processing failed' }); }
  });
}

module.exports = { mount };
