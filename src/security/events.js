// SecurityEvent writer. Best-effort: a failure to log must never break (or slow) the request that triggered it.
// Never pass passwords, tokens or request bodies in `detail`.
const { v4: uuid } = require('uuid');
const jwt = require('jsonwebtoken');
const platformClient = require('../db/platformClient');
const tenantPool = require('../db/tenantPool');
const { SlidingWindow } = require('./limiter');

const clip = (s, n) => (s == null ? null : String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n));
const clientIp = req => clip((req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, ''), 64);
const clientUa = req => clip(req.headers?.['user-agent'], 200);

async function logEvent(db, { type, user_id, email, req, ip, user_agent, detail }) {
  try {
    await db.securityEvent.create({
      data: {
        id: uuid(), type, user_id: user_id ?? null, email: clip(email, 200),
        ip: ip ?? (req ? clientIp(req) : null), user_agent: user_agent ?? (req ? clientUa(req) : null),
        detail: detail && Object.keys(detail).length ? detail : undefined,
      },
    });
  } catch (e) { console.error('[security] could not log event:', e.message); }
}

// Same-key events are collapsed so a flood (forbidden polling, a hammering client) cannot fill the table.
const throttle = new SlidingWindow();
const once = (key, windowMs) => throttle.hit(key, 1, windowMs).allowed;

/** permission_denied from authorize(): needs an authenticated tenant request. Fire-and-forget. */
const denyCap = new SlidingWindow();
function logDenied(req) {
  if (!req.db || !req.user?.id || process.env.SECURITY_LOG_DENIED === 'off') return;
  const path = String(req.originalUrl || req.url || '').split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id').replace(/\/\d{3,}/g, '/:n').slice(0, 120);
  const route = `${req.method} ${path}`;
  if (!once(`deny|${req.user.id}|${route}`, 60_000)) return;
  if (!denyCap.hit(`${req.user.school_id}|${req.user.id}`, 30, 3_600_000).allowed) return;   // at most 30 per user per hour
  logEvent(req.db, { type: 'permission_denied', user_id: req.user.id, email: req.user.email, req, detail: { route, role: req.user.role } });
}

/** rate_limited: the school is unknown at this point, so derive it from a valid token or from the login e-mail. */
async function logRateLimited(req, scope) {
  try {
    if (!once(`rl|${clientIp(req)}|${scope}`, 60_000)) return;
    let schoolId = null, userId = null, email = null;
    const h = req.headers?.authorization;
    if (h && h.startsWith('Bearer ')) {
      try { const p = jwt.verify(h.slice(7), process.env.JWT_SECRET || 'dev_secret'); if (p.scope !== 'platform') { schoolId = p.school_id; userId = p.id; email = p.email; } } catch { /* anonymous */ }
    }
    if (!schoolId && typeof req.body?.email === 'string') {
      email = req.body.email;
      const d = await platformClient.userDirectory.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: { school_id: true } });
      schoolId = d?.school_id ?? null;
    }
    if (!schoolId) return;
    await logEvent(tenantPool.getOrOpen(schoolId), { type: 'rate_limited', user_id: userId, email, req, detail: { scope, path: clip(req.originalUrl?.split('?')[0], 120) } });
  } catch (e) { console.error('[security] rate-limit log failed:', e.message); }
}

module.exports = { logEvent, logDenied, logRateLimited, clientIp, clientUa, clip };
