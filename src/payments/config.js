// Payment configuration — everything comes from server-side environment variables; nothing here is
// ever sent to the browser except the non-secret "is this provider usable + how to pay" summary.
const env = process.env;

const currency = () => (env.PAYMENT_CURRENCY || 'XAF').toUpperCase();
// XAF/XOF/JPY… have no minor unit; everything else is 2-decimal.
const ZERO_DECIMAL = new Set(['XAF', 'XOF', 'JPY', 'KRW', 'UGX', 'RWF', 'GNF', 'VND', 'KMF', 'DJF', 'BIF', 'CLP', 'PYG', 'VUV', 'XPF']);
const isZeroDecimal = c => ZERO_DECIMAL.has(String(c).toUpperCase());

module.exports = {
  currency,
  isZeroDecimal,
  minAmount: () => Number(env.PAYMENT_MIN_AMOUNT || 500),
  allowPartial: () => env.PAYMENT_ALLOW_PARTIAL !== 'false',
  // Mobile-money/Stripe attempts older than this and still unresolved are expired (after a final provider check).
  pendingTtlMinutes: () => Number(env.PAYMENT_PENDING_TTL_MINUTES || 30),
  maxOpenPerInvoice: () => Number(env.PAYMENT_MAX_OPEN_PER_INVOICE || 3),
  // Public URL of THIS API as seen by the payment providers (webhook/callback target) and of the frontend.
  apiPublicUrl: () => (env.API_PUBLIC_URL || '').replace(/\/$/, ''),
  frontendUrl: () => (env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, ''),
  // Signing key for per-transaction callback tokens (falls back to JWT_SECRET so it works out of the box).
  webhookKey: () => env.PAYMENT_WEBHOOK_SECRET || env.JWT_SECRET || 'dev_secret',
  providerTimeoutMs: () => Number(env.PAYMENT_PROVIDER_TIMEOUT_MS || 15000),
  // Receipts show this; falls back to the school name.
  receiptFooter: () => env.PAYMENT_RECEIPT_FOOTER || '',
};
