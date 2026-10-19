// Orange Money — Web Payment ("WebPay"): the payer is redirected to Orange's hosted page and approves there.
//   POST {base}/oauth/v3/token                                     (Basic <consumer key:secret>) grant_type=client_credentials
//   POST {base}/orange-money-webpay/{country}/v1/webpayment        → { pay_token, payment_url, notif_token }
//   POST {base}/orange-money-webpay/{country}/v1/transactionstatus → { status: INITIATED|PENDING|SUCCESS|FAILED|EXPIRED, txnid }
// The notification Orange posts to notif_url carries a notif_token we stored at initiation; it is a hint only —
// the result is always confirmed with transactionstatus. Shapes follow Orange's public WebPay docs and must be
// confirmed in the Orange Developer sandbox / merchant onboarding before go-live (see docs/PAYMENTS.md).
const { call, ProviderError } = require('../http');
const cfg = require('../config');

const env = process.env;
const base = () => (env.ORANGE_MONEY_API_BASE || 'https://api.orange.com').replace(/\/$/, '');
const country = () => (env.ORANGE_MONEY_COUNTRY || 'cm').toLowerCase();                 // 'dev' for the Orange sandbox
const currency = () => (env.ORANGE_MONEY_CURRENCY || cfg.currency()).toUpperCase();      // sandbox uses OUV
const REQUIRED = ['ORANGE_MONEY_CONSUMER_AUTH', 'ORANGE_MONEY_MERCHANT_KEY', 'API_PUBLIC_URL'];   // Orange needs a public notif_url

let tokenCache = { token: null, exp: 0 };
async function token() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 30_000) return tokenCache.token;
  const r = await call(`${base()}/oauth/v3/token`, {
    method: 'POST', headers: { Authorization: `Basic ${env.ORANGE_MONEY_CONSUMER_AUTH}` }, form: { grant_type: 'client_credentials' },
  }, 2);
  if (!r.body?.access_token) throw new ProviderError('Orange token response had no access_token', { body: r.body });
  tokenCache = { token: r.body.access_token, exp: Date.now() + (Number(r.body.expires_in) || 3600) * 1000 };
  return tokenCache.token;
}
const url = path => `${base()}/orange-money-webpay/${country()}/v1/${path}`;

module.exports = {
  id: 'orange_money',
  label: 'Orange Money',
  flow: 'redirect',
  requiresPhone: false,
  currency,
  missing: () => REQUIRED.filter(k => !env[k]),
  isConfigured() { return this.missing().length === 0; },

  async initiate(tx, { returnUrl, cancelUrl, callbackUrl, lang }) {
    const r = await call(url('webpayment'), {
      method: 'POST', headers: { Authorization: `Bearer ${await token()}` },
      body: {
        merchant_key: env.ORANGE_MONEY_MERCHANT_KEY, currency: currency(), order_id: tx.reference, amount: tx.amount,
        return_url: returnUrl, cancel_url: cancelUrl, notif_url: callbackUrl, lang: lang === 'fr' ? 'fr' : 'en', reference: tx.reference,
      },
    }, 0);                                     // never retry a charge creation
    const b = r.body || {};
    if (!b.payment_url || !b.pay_token) throw new ProviderError('Orange Money did not return a payment link', { body: b });
    return { providerRef: b.pay_token, providerSecret: b.notif_token, checkoutUrl: b.payment_url, status: 'pending' };
  },

  async verify(tx) {
    if (!tx.provider_ref) return { status: 'pending' };
    const r = await call(url('transactionstatus'), {
      method: 'POST', headers: { Authorization: `Bearer ${await token()}` },
      body: { order_id: tx.reference, amount: tx.amount, pay_token: tx.provider_ref },
    }, 2);
    const b = r.body || {};
    const map = { SUCCESS: 'successful', SUCCESSFUL: 'successful', FAILED: 'failed', EXPIRED: 'expired', PENDING: 'pending', INITIATED: 'pending' };
    const status = map[String(b.status).toUpperCase()] || 'pending';
    // Orange's status call confirms success for the (order_id, amount, pay_token) we sent — i.e. the amount matches.
    return {
      status, providerTxnId: b.txnid ? String(b.txnid) : undefined,
      amount: status === 'successful' ? tx.amount : undefined, currency: status === 'successful' ? currency() : undefined,
      reason: b.message, raw: b,
    };
  },
};
