// Stripe Checkout (hosted page). Credentials: STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET.
// ELIGIBILITY: Stripe only opens accounts for businesses in its supported countries; Cameroon is not on that
// list (stripe.com/global). The adapter is complete, but stays "not configured" until the university holds a
// Stripe account through an eligible legal entity — see docs/PAYMENTS.md. Allowed currencies must be listed
// explicitly in STRIPE_CURRENCIES (comma-separated); the adapter never assumes XAF is enabled.
const cfg = require('../config');
const { ProviderError } = require('../http');

const env = process.env;
const REQUIRED = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_CURRENCIES'];
let client = null;
function stripe() {
  if (client) return client;
  const Stripe = require('stripe');
  const opts = { maxNetworkRetries: 0, timeout: cfg.providerTimeoutMs() };
  // Test hook only: point the SDK at a local mock server.
  if (env.STRIPE_API_HOST) Object.assign(opts, { host: env.STRIPE_API_HOST, port: env.STRIPE_API_PORT, protocol: env.STRIPE_API_PROTOCOL || 'http' });
  client = new Stripe(env.STRIPE_SECRET_KEY, opts);
  return client;
}
const currencies = () => (env.STRIPE_CURRENCIES || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const toMinor = (amount, cur) => (cfg.isZeroDecimal(cur) ? Math.round(amount) : Math.round(amount * 100));
const fromMinor = (minor, cur) => (cfg.isZeroDecimal(cur) ? minor : minor / 100);

module.exports = {
  id: 'stripe',
  label: 'Card payment (Stripe)',
  flow: 'redirect',
  requiresPhone: false,
  currency: () => (currencies().includes(cfg.currency()) ? cfg.currency() : currencies()[0] || cfg.currency()),
  supportsCurrency: c => currencies().includes(String(c).toUpperCase()),
  missing: () => REQUIRED.filter(k => !env[k]),
  isConfigured() { return this.missing().length === 0; },
  toMinor, fromMinor,

  async initiate(tx, { returnUrl, cancelUrl, schoolId, studentName, feeName }) {
    const cur = tx.currency.toLowerCase();
    const session = await stripe().checkout.sessions.create({
      mode: 'payment',
      client_reference_id: tx.reference,
      line_items: [{ quantity: 1, price_data: { currency: cur, unit_amount: toMinor(tx.amount, tx.currency), product_data: { name: `${feeName} — ${studentName}`.slice(0, 120) } } }],
      metadata: { transaction_id: tx.id, reference: tx.reference, school_id: schoolId },
      payment_intent_data: { metadata: { transaction_id: tx.id, reference: tx.reference, school_id: schoolId } },
      success_url: returnUrl, cancel_url: cancelUrl,
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,     // Stripe's minimum is 30 min
    }, { idempotencyKey: `edutech-${tx.id}` });
    return { providerRef: session.id, checkoutUrl: session.url, status: 'pending' };
  },

  // Authoritative state: always retrieve the session from Stripe rather than trusting a webhook payload / redirect.
  async verify(tx) {
    if (!tx.provider_ref) return { status: 'pending' };
    const s = await stripe().checkout.sessions.retrieve(tx.provider_ref);
    const cur = String(s.currency || tx.currency).toUpperCase();
    if (s.payment_status === 'paid') {
      return {
        status: 'successful', providerTxnId: typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id,
        amount: fromMinor(s.amount_total, cur), currency: cur, raw: { id: s.id, payment_status: s.payment_status },
      };
    }
    if (s.status === 'expired') return { status: 'expired', raw: { id: s.id, status: s.status } };
    if (s.status === 'complete') return { status: 'processing', raw: { id: s.id, status: s.status, payment_status: s.payment_status } };   // async method still settling
    return { status: 'pending', raw: { id: s.id, status: s.status } };
  },

  async cancel(tx) {
    if (!tx.provider_ref) return;
    try { await stripe().checkout.sessions.expire(tx.provider_ref); } catch { /* already expired/complete — verify() decides */ }
  },

  // Throws if the signature is invalid. Returns the normalised event.
  parseWebhook(rawBody, signature) {
    let event;
    try { event = stripe().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET); }
    catch (e) { throw new ProviderError(`Invalid Stripe signature: ${e.message}`); }
    const obj = event.data?.object || {};
    return {
      eventId: event.id, type: event.type, sessionId: obj.object === 'checkout.session' ? obj.id : undefined,
      transactionId: obj.metadata?.transaction_id, schoolId: obj.metadata?.school_id, reference: obj.metadata?.reference || obj.client_reference_id,
    };
  },

  async refund(tx, amount) {
    const s = await stripe().checkout.sessions.retrieve(tx.provider_ref);
    const pi = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent?.id;
    if (!pi) throw new ProviderError('No Stripe payment to refund');
    const minor = toMinor(amount, tx.currency);
    const r = await stripe().refunds.create({ payment_intent: pi, amount: minor }, { idempotencyKey: `edutech-refund-${tx.id}-${minor}-${Math.round(tx.refunded_amount)}` });
    return { providerRefundId: r.id, status: r.status };
  },
};
