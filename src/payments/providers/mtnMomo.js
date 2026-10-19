// MTN Mobile Money — Collection API ("RequestToPay"): the payer gets a USSD/PIN prompt on their phone.
//   POST {base}/collection/token/                      (Basic apiUser:apiKey + Ocp-Apim-Subscription-Key) → access_token
//   POST {base}/collection/v1_0/requesttopay           (Bearer, X-Reference-Id, X-Target-Environment)      → 202
//   GET  {base}/collection/v1_0/requesttopay/{refId}   → { status: PENDING | SUCCESSFUL | FAILED, ... }
// The callback MTN sends is NOT signed, so it is only used as a hint to re-query the status above.
// Request/response shapes follow MTN's public MoMo Developer docs and must be confirmed in your MTN
// sandbox / merchant onboarding before go-live (see docs/PAYMENTS.md).
const { v4: uuid } = require('uuid');
const { call, ProviderError } = require('../http');
const cfg = require('../config');

const env = process.env;
const base = () => (env.MTN_MOMO_API_BASE || 'https://proxy.momoapi.mtn.com').replace(/\/$/, '');
const currency = () => (env.MTN_MOMO_CURRENCY || cfg.currency()).toUpperCase();
const targetEnv = () => env.MTN_MOMO_TARGET_ENV || 'mtncameroon';
const REQUIRED = ['MTN_MOMO_SUBSCRIPTION_KEY', 'MTN_MOMO_API_USER', 'MTN_MOMO_API_KEY'];

let tokenCache = { token: null, exp: 0 };
async function token() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 30_000) return tokenCache.token;
  const basic = Buffer.from(`${env.MTN_MOMO_API_USER}:${env.MTN_MOMO_API_KEY}`).toString('base64');
  const r = await call(`${base()}/collection/token/`, {
    method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Ocp-Apim-Subscription-Key': env.MTN_MOMO_SUBSCRIPTION_KEY },
  }, 2);
  if (!r.body?.access_token) throw new ProviderError('MTN token response had no access_token', { body: r.body });
  tokenCache = { token: r.body.access_token, exp: Date.now() + (Number(r.body.expires_in) || 3600) * 1000 };
  return tokenCache.token;
}
const authHeaders = async () => ({
  Authorization: `Bearer ${await token()}`,
  'X-Target-Environment': targetEnv(),
  'Ocp-Apim-Subscription-Key': env.MTN_MOMO_SUBSCRIPTION_KEY,
});

// Cameroon MSISDN: digits only, 237 + 9 digits.
function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (/^237[26]\d{8}$/.test(d)) return d;
  if (/^[26]\d{8}$/.test(d)) return `237${d}`;
  return null;
}

module.exports = {
  id: 'mtn_momo',
  label: 'MTN Mobile Money',
  flow: 'push',
  requiresPhone: true,
  currency,
  normalizePhone,
  missing: () => REQUIRED.filter(k => !env[k]),
  isConfigured() { return this.missing().length === 0; },

  async initiate(tx, { callbackUrl }) {
    const phone = normalizePhone(tx.payer_phone);
    if (!phone) throw new ProviderError('Enter a valid MTN Mobile Money number (e.g. 6 7X XX XX XX).');
    const referenceId = uuid();
    const headers = { ...(await authHeaders()), 'X-Reference-Id': referenceId };
    if (callbackUrl) headers['X-Callback-Url'] = callbackUrl;
    await call(`${base()}/collection/v1_0/requesttopay`, {
      method: 'POST', headers,
      body: {
        amount: String(tx.amount), currency: currency(), externalId: tx.reference,
        payer: { partyIdType: 'MSISDN', partyId: phone },
        payerMessage: `School fees ${tx.reference}`.slice(0, 160), payeeNote: tx.reference,
      },
    }, 0);                                     // never retry a charge creation
    return { providerRef: referenceId, status: 'pending' };
  },

  async verify(tx) {
    if (!tx.provider_ref) return { status: 'pending' };
    const r = await call(`${base()}/collection/v1_0/requesttopay/${tx.provider_ref}`, { headers: await authHeaders() }, 2);
    const b = r.body || {};
    const map = { SUCCESSFUL: 'successful', FAILED: 'failed', PENDING: 'pending', REJECTED: 'failed', TIMEOUT: 'expired' };
    const status = map[String(b.status).toUpperCase()] || 'pending';
    return {
      status, providerTxnId: b.financialTransactionId ? String(b.financialTransactionId) : undefined,
      amount: b.amount !== undefined ? Number(b.amount) : undefined, currency: b.currency, reason: b.reason?.message || b.reason, raw: b,
    };
  },
};
