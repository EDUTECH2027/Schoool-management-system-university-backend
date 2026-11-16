// Security centre (super_admin only): event log, summary, unlock, force password reset. See docs/SECURITY.md.
const router = require('express').Router();
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const cfg = require('../security/config');
const { logEvent } = require('../security/events');
const sessions = require('../security/sessions');
const { sendCsv } = require('../analytics/csv');
const { schemaNameFor } = require('../db/tenantSchema');

router.use(authenticate, authorize('super_admin'));

const TYPES = ['login_success', 'login_failed', 'account_locked', 'account_unlocked', 'password_changed', 'password_reset_forced', 'permission_denied', 'rate_limited'];
const parseDate = (s, endOfDay) => {
  if (!s) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T${endOfDay ? '23:59:59.999' : '00:00:00'}Z` : s);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

function eventFilter(q) {
  const where = {};
  if (q.type) { const t = String(q.type).split(',').filter(Boolean); if (t.some(x => !TYPES.includes(x))) return { error: `type must be among ${TYPES.join(', ')}` }; where.type = { in: t }; }
  if (q.email) where.email = { contains: String(q.email).slice(0, 100), mode: 'insensitive' };
  if (q.user_id) where.user_id = String(q.user_id);
  if (q.ip) where.ip = { contains: String(q.ip).slice(0, 64) };
  const from = parseDate(q.from, false), to = parseDate(q.to, true);
  if (from === undefined || to === undefined) return { error: 'from/to must be dates (YYYY-MM-DD or ISO)' };
  if (from || to) where.created_at = { ...(from && { gte: from }), ...(to && { lte: to }) };
  return { where };
}

// GET /api/security/config — effective thresholds (read-only; they come from the environment)
router.get('/config', (_req, res) => {
  res.json({
    login_max_failures: cfg.loginMaxFailures(), login_lock_minutes: cfg.loginLockMinutes(),
    login_ip: cfg.loginIp(), login_account: cfg.loginAccount(), reset_ip: cfg.resetIp(), reset_account: cfg.resetAccount(), global_api: cfg.globalApi(),
    password_min_length: require('../security/policy').MIN, mfa: false,
  });
});

// GET /api/security/events?type=&email=&user_id=&ip=&from=&to=&page=&limit=
router.get('/events', async (req, res) => {
  const f = eventFilter(req.query);
  if (f.error) return res.status(422).json({ error: f.error });
  const page = Math.max(1, parseInt(req.query.page, 10) || 1), limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const [total, items] = await Promise.all([
    req.db.securityEvent.count({ where: f.where }),
    req.db.securityEvent.findMany({ where: f.where, orderBy: { created_at: 'desc' }, skip: (page - 1) * limit, take: limit }),
  ]);
  res.json({ total, page, limit, items });
});

// GET /api/security/events/export — CSV (max 10 000 rows, same filters)
router.get('/events/export', async (req, res) => {
  const f = eventFilter(req.query);
  if (f.error) return res.status(422).json({ error: f.error });
  const rows = await req.db.securityEvent.findMany({ where: f.where, orderBy: { created_at: 'desc' }, take: 10000 });
  sendCsv(res, `security-events-${new Date().toISOString().slice(0, 10)}.csv`, rows.map(r => ({ time: r.created_at, type: r.type, email: r.email, user_id: r.user_id, ip: r.ip, user_agent: r.user_agent, detail: r.detail })), ['time', 'type', 'email', 'user_id', 'ip', 'user_agent', 'detail']);
});

// GET /api/security/summary?days=14
router.get('/summary', async (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 14));
  const since = new Date(Date.now() - days * 86_400_000);
  // Raw SQL uses unqualified table names; pin the tenant schema (the pooled connection's search_path is `public`).
  const rawRows = (build) => req.db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schemaNameFor(req.user.school_id)}", public`);
    return build(tx);
  });
  const [byDay, byType, topIps, locked, mustChange, failing] = await Promise.all([
    rawRows(tx => tx.$queryRaw`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, type, COUNT(*)::int AS n FROM security_events WHERE created_at >= ${since} GROUP BY 1, 2 ORDER BY 1`),
    req.db.securityEvent.groupBy({ by: ['type'], where: { created_at: { gte: since } }, _count: { _all: true } }),
    rawRows(tx => tx.$queryRaw`SELECT ip, COUNT(*)::int AS failures, COUNT(DISTINCT email)::int AS accounts, MAX(created_at) AS last_seen FROM security_events WHERE type = 'login_failed' AND created_at >= ${since} AND ip IS NOT NULL GROUP BY ip ORDER BY failures DESC, ip LIMIT 10`),
    req.db.user.findMany({ where: { locked_until: { gt: new Date() } }, select: { id: true, name: true, email: true, role: true, locked_until: true }, orderBy: { locked_until: 'desc' } }),
    req.db.user.count({ where: { must_change_password: true } }),
    req.db.user.count({ where: { failed_logins: { gt: 0 } } }),
  ]);
  const map = {};
  for (let i = days - 1; i >= 0; i--) { const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10); map[d] = { day: d, failed: 0, success: 0, locked: 0, denied: 0, rate_limited: 0 }; }
  const col = { login_failed: 'failed', login_success: 'success', account_locked: 'locked', permission_denied: 'denied', rate_limited: 'rate_limited' };
  for (const r of byDay) if (map[r.day] && col[r.type]) map[r.day][col[r.type]] += r.n;
  res.json({
    days, since,
    totals: Object.fromEntries(byType.map(t => [t.type, t._count._all])),
    by_day: Object.values(map),
    top_ips: topIps,
    locked_accounts: locked, must_change_password: mustChange, accounts_with_failures: failing,
  });
});

// POST /api/security/users/:id/unlock
router.post('/users/:id/unlock', async (req, res) => {
  const u = await req.db.user.findUnique({ where: { id: req.params.id }, select: { id: true, email: true, failed_logins: true, locked_until: true } });
  if (!u) return res.status(404).json({ error: 'User not found' });
  await req.db.user.update({ where: { id: u.id }, data: { failed_logins: 0, locked_until: null } });
  await logEvent(req.db, { type: 'account_unlocked', user_id: u.id, email: u.email, req, detail: { by: req.user.id, was_locked: !!u.locked_until && new Date(u.locked_until) > new Date() } });
  res.json({ message: 'Account unlocked', id: u.id });
});

// POST /api/security/users/:id/force-reset { revoke_sessions?: boolean (default true) }
router.post('/users/:id/force-reset', async (req, res) => {
  const u = await req.db.user.findUnique({ where: { id: req.params.id }, select: { id: true, email: true } });
  if (!u) return res.status(404).json({ error: 'User not found' });
  const revoke = req.body?.revoke_sessions !== false;
  const now = new Date();
  await req.db.user.update({ where: { id: u.id }, data: { must_change_password: true, ...(revoke && { password_changed_at: now }), updated_at: now } });
  if (revoke) sessions.markChanged(req.user.school_id, u.id, now, u.id === req.user.id ? { token: req.headers.authorization.slice(7), exp: req.user.exp } : undefined);
  await logEvent(req.db, { type: 'password_reset_forced', user_id: u.id, email: u.email, req, detail: { by: req.user.id, revoke_sessions: revoke } });
  res.json({ message: 'The user must choose a new password at next sign-in', id: u.id, revoked_sessions: revoke });
});

module.exports = router;
