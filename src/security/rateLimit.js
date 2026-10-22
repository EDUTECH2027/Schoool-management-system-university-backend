// HTTP rate limiting on top of SlidingWindow: global API limiter, attempt limiters for the credential endpoints,
// and "failure gates" (login: only FAILED attempts count, so a school behind one NAT is not locked out by successes).
const { SlidingWindow } = require('./limiter');
const cfg = require('./config');
const { logRateLimited, clientIp } = require('./events');

function deny(req, res, scope, retryAfterMs, message) {
  const secs = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.set('Retry-After', String(secs));
  logRateLimited(req, scope);
  return res.status(429).json({ error: message || 'Too many requests. Please slow down and try again shortly.', code: 'rate_limited', retry_after_seconds: secs });
}

const globalWin = new SlidingWindow();
/** Generous per-IP limiter for the whole API. Health checks and provider webhooks are never limited. */
function globalLimiter(req, res, next) {
  if (req.path === '/health' || req.path.startsWith('/payments/webhooks')) return next();
  const { max, windowMs } = cfg.globalApi();
  const r = globalWin.hit(clientIp(req) || 'unknown', max, windowMs);
  if (!r.allowed) return deny(req, res, 'global', r.retryAfterMs);
  next();
}

const attemptWin = new SlidingWindow();
const emailKey = req => String(req.body?.email || req.body?.studentId || req.query?.email || '').trim().toLowerCase().slice(0, 200);
/** Counts every request. Two buckets: per IP and per account (e-mail / matricule in the body or query). */
function attemptLimiter(name, ipCfg, accCfg) {
  return (req, res, next) => {
    const ip = ipCfg(), acc = accCfg();
    const a = attemptWin.hit(`${name}|ip|${clientIp(req)}`, ip.max, ip.windowMs);
    if (!a.allowed) return deny(req, res, `${name}:ip`, a.retryAfterMs);
    const id = emailKey(req);
    if (id) {
      const b = attemptWin.hit(`${name}|acc|${id}`, acc.max, acc.windowMs);
      if (!b.allowed) return deny(req, res, `${name}:account`, b.retryAfterMs);
    }
    next();
  };
}

const failWin = new SlidingWindow();
/** Failure gate: blocked() before doing work, fail() after a failed attempt, ok() after success. */
const failGate = {
  blockedIp(req) { const c = cfg.loginIp(); const n = failWin.count(`ip|${clientIp(req)}`, c.windowMs); return n >= c.max ? failWin.hit(`ip|${clientIp(req)}`, c.max, c.windowMs) : null; },
  failIp(req) { const c = cfg.loginIp(); failWin.hit(`ip|${clientIp(req)}`, 1e9, c.windowMs); },
};

/** Identities without a tenant row (unknown e-mails, platform admins): same lockout behaviour as real accounts. */
const identityFails = new SlidingWindow();
const identity = {
  lockMs: () => cfg.loginLockMinutes() * 60_000,
  retryMs(key) { const w = identity.lockMs(); const n = identityFails.count(key, w); return n >= cfg.loginMaxFailures() ? w : 0; },
  fail(key) { identityFails.hit(key, 1e9, identity.lockMs()); },
  clear(key) { identityFails.reset(key); },
};

module.exports = { globalLimiter, attemptLimiter, failGate, identity, deny, globalWin, attemptWin, failWin, identityFails };
