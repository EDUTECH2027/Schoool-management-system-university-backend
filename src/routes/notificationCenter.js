// Notification centre: own notifications, preferences, broadcasts and the e-mail outbox (see docs/NOTIFICATIONS.md).
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { audit } = require('../academics/registration');
const { actorOf } = require('../academics/results');
const { notifyDetailed, CRITICAL_TYPES, EMAIL_TYPES } = require('../utils/notify');
const mailer = require('../utils/mailer');
const mailWorker = require('../services/mailWorker');
const audienceSvc = require('../services/audience');

mailWorker.start();   // in-process outbox delivery (MAIL_WORKER=off disables)

const staff = [authenticate, authorize('super_admin', 'academic_officer')];
const dto = n => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, read_at: n.read_at, created_at: n.created_at });
const bad = (res, msg, code = 422) => res.status(code).json({ error: msg });

const TYPE_LABELS = {
  security: ['Security alerts', 'Alertes de sécurité'], must_read: ['Must-read announcements', 'Annonces obligatoires'], broadcast: ['Announcements', 'Annonces'],
  service_update: ['Service request updates', 'Mises à jour de vos demandes'], service_request: ['Service desk activity', 'Activité du guichet'],
  results_published: ['Results published', 'Résultats publiés'], registration_decision: ['Registration decisions', "Décisions d'inscription"], appeal_decision: ['Appeal decisions', "Décisions d'appel"],
  exam_rescheduled: ['Exam changes', "Changements d'examen"], class_reminder: ['Class reminders', 'Rappels de cours'],
};

// ── own notifications ────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const where = { user_id: req.user.id };
  if (req.query.unread === '1' || req.query.unread === 'true') where.read_at = null;
  if (req.query.type) where.type = String(req.query.type).slice(0, 60);
  const [total, unread, rows] = await Promise.all([
    req.db.notification.count({ where }),
    req.db.notification.count({ where: { user_id: req.user.id, read_at: null } }),
    req.db.notification.findMany({ where, orderBy: { created_at: 'desc' }, skip: (page - 1) * limit, take: limit }),
  ]);
  res.json({ total, unread, page, limit, items: rows.map(dto) });
});

router.get('/unread-count', authenticate, async (req, res) => {
  res.json({ unread: await req.db.notification.count({ where: { user_id: req.user.id, read_at: null } }) });
});

router.post('/read', authenticate, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(x => typeof x === 'string').slice(0, 500) : null;
  const r = await req.db.notification.updateMany({ where: { user_id: req.user.id, read_at: null, ...(ids && { id: { in: ids } }) }, data: { read_at: new Date() } });
  res.json({ ok: true, updated: r.count });
});

router.post('/:id/read', authenticate, async (req, res) => {
  const r = await req.db.notification.updateMany({ where: { id: req.params.id, user_id: req.user.id, read_at: null }, data: { read_at: new Date() } });
  if (r.count === 0 && !(await req.db.notification.findFirst({ where: { id: req.params.id, user_id: req.user.id } }))) return bad(res, 'Notification not found', 404);
  res.json({ ok: true });
});

// ── preferences ──────────────────────────────────────────────────────────────
const prefDto = (p, configured) => ({ in_app: p?.in_app ?? true, email: p?.email ?? true, muted_types: Array.isArray(p?.muted_types) ? p.muted_types : [], always_delivered: [...CRITICAL_TYPES], email_configured: configured });

router.get('/preferences', authenticate, async (req, res) => {
  const p = await req.db.notificationPreference.findUnique({ where: { user_id: req.user.id } });
  res.json({ ...prefDto(p, mailer.isConfigured()), types: Object.entries(TYPE_LABELS).map(([type, [en, fr]]) => ({ type, label_en: en, label_fr: fr, critical: CRITICAL_TYPES.has(type), email: EMAIL_TYPES.has(type) })) });
});

router.put('/preferences', authenticate, async (req, res) => {
  const b = req.body || {};
  const data = {};
  for (const k of ['in_app', 'email']) if (b[k] !== undefined) { if (typeof b[k] !== 'boolean') return bad(res, `${k} must be true or false.`); data[k] = b[k]; }
  if (b.muted_types !== undefined) {
    if (!Array.isArray(b.muted_types) || b.muted_types.length > 30 || b.muted_types.some(t => typeof t !== 'string' || !t || t.length > 60)) return bad(res, 'muted_types must be a list of up to 30 type names.');
    const crit = b.muted_types.filter(t => CRITICAL_TYPES.has(t));
    if (crit.length) return bad(res, `These notifications cannot be muted: ${crit.join(', ')}.`);
    data.muted_types = [...new Set(b.muted_types)];
  }
  const p = await req.db.notificationPreference.upsert({ where: { user_id: req.user.id }, create: { id: uuid(), user_id: req.user.id, ...data }, update: { ...data, updated_at: new Date() } });
  res.json(prefDto(p, mailer.isConfigured()));
});

// Public to any logged-in user so the UI can say honestly whether e-mail can be delivered.
router.get('/email-status', authenticate, (req, res) => res.json({ configured: mailer.isConfigured() }));

// ── broadcasts (staff) ───────────────────────────────────────────────────────
router.get('/broadcasts/options', ...staff, async (req, res) => {
  const [programmes, classes, offerings] = await Promise.all([
    req.db.programme.findMany({ where: { is_active: true }, select: { id: true, name: true, code: true }, orderBy: { name: 'asc' } }),
    req.db.class.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    req.db.courseOffering.findMany({ where: { term: { is_current: true } }, select: { id: true, section: true, subject: { select: { name: true, code: true } } }, take: 300 }),
  ]);
  res.json({ roles: audienceSvc.ROLES, programmes, classes, offerings: offerings.map(o => ({ id: o.id, name: `${o.subject.code} ${o.subject.name} (${o.section})` })), max_recipients: audienceSvc.MAX_RECIPIENTS, email_configured: mailer.isConfigured() });
});

async function resolveOr422(req, res) {
  try { return await audienceSvc.resolve(req.db, req.body?.audience); } catch (e) { if (e instanceof audienceSvc.AudienceError) { bad(res, e.message, e.status); return null; } throw e; }
}

router.post('/broadcasts/preview', ...staff, async (req, res) => {
  const r = await resolveOr422(req, res); if (!r) return;
  const emails = r.userIds.length ? await req.db.user.count({ where: { id: { in: r.userIds }, email: { not: '' } } }) : 0;
  res.json({ recipients: r.userIds.length, with_email: emails, breakdown: r.breakdown, audience: r.audience, max_recipients: audienceSvc.MAX_RECIPIENTS });
});

router.post('/broadcasts', ...staff, async (req, res) => {
  const title = typeof req.body.title === 'string' ? req.body.title.trim() : '', body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
  if (title.length < 3 || title.length > 150) return bad(res, 'The title must be 3–150 characters.');
  if (body.length < 1 || body.length > 5000) return bad(res, 'The message must be 1–5000 characters.');
  const channels = Array.isArray(req.body.channels) ? [...new Set(req.body.channels)] : [];
  if (!channels.length || channels.some(c => !['in_app', 'email'].includes(c))) return bad(res, 'Choose at least one channel: in_app and/or email.');
  const mustRead = req.body.must_read === true;
  if (channels.length === 1 && channels[0] === 'email' && !mailer.isConfigured()) return bad(res, 'E-mail is not configured on this server (no SMTP settings), so an e-mail-only broadcast cannot be delivered. Add the in-app channel or configure SMTP.', 409);
  const r = await resolveOr422(req, res); if (!r) return;
  if (!r.userIds.length) return bad(res, 'This audience has no recipients.');
  const stats = await notifyDetailed(req.db, r.userIds, { type: mustRead ? 'must_read' : 'broadcast', title, body, channels }).catch(() => null);
  if (!stats) return bad(res, 'The broadcast could not be sent.', 500);
  const actor = actorOf(req.user);
  const row = await req.db.broadcast.create({ data: { id: uuid(), title, body, audience: { ...r.audience, must_read: mustRead, breakdown: r.breakdown, delivered: stats }, channels, recipients: r.userIds.length, created_by: actor.id, created_by_name: actor.name } });
  await audit(req.db, actor, 'broadcast.send', 'broadcast', row.id, { after: { title, channels, recipients: r.userIds.length, must_read: mustRead } });
  res.status(201).json({ ...bdto(row), email_configured: mailer.isConfigured(), warning: stats.email && !mailer.isConfigured() ? 'E-mail is not configured: the e-mails are queued and will be marked as skipped, not sent.' : undefined });
});

const bdto = b => ({ id: b.id, title: b.title, body: b.body, channels: b.channels, recipients: b.recipients, created_by_name: b.created_by_name, created_at: b.created_at, must_read: !!b.audience?.must_read, audience: { roles: b.audience?.roles ?? [], programme_ids: b.audience?.programme_ids ?? [], class_ids: b.audience?.class_ids ?? [], offering_ids: b.audience?.offering_ids ?? [] }, delivered: b.audience?.delivered ?? null });

router.get('/broadcasts', ...staff, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const [total, rows] = await Promise.all([req.db.broadcast.count(), req.db.broadcast.findMany({ orderBy: { created_at: 'desc' }, skip: (page - 1) * limit, take: limit })]);
  res.json({ total, page, limit, items: rows.map(bdto) });
});

// ── e-mail outbox (staff) ────────────────────────────────────────────────────
router.get('/outbox', ...staff, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const where = {}; if (['queued', 'sent', 'failed', 'skipped'].includes(req.query.status)) where.status = req.query.status;
  const [grouped, total, rows] = await Promise.all([
    req.db.emailOutbox.groupBy({ by: ['status'], _count: { _all: true } }),
    req.db.emailOutbox.count({ where }),
    req.db.emailOutbox.findMany({ where, orderBy: { created_at: 'desc' }, skip: (page - 1) * limit, take: limit }),
  ]);
  const counts = { queued: 0, sent: 0, failed: 0, skipped: 0, ...Object.fromEntries(grouped.map(g => [g.status, g._count._all])) };
  const st = mailer.status();
  res.json({ smtp: { configured: st.configured, host: st.host, port: st.port, from: st.from, worker: st.worker }, max_attempts: mailWorker.MAX_ATTEMPTS, counts, total, page, limit, items: rows.map(m => ({ id: m.id, to_email: m.to_email, subject: m.subject, type: m.type, status: m.status, attempts: m.attempts, error: m.error, created_at: m.created_at, sent_at: m.sent_at })) });
});

// Runs the worker for this school right now (also useful when MAIL_WORKER=off).
router.post('/outbox/process', ...staff, async (req, res) => res.json({ configured: mailer.isConfigured(), ...(await mailWorker.runOnce(req.db)) }));

// Puts failed / skipped mails back in the queue (fresh attempt counter).
router.post('/outbox/retry', ...staff, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(x => typeof x === 'string').slice(0, 500) : null;
  const r = await req.db.emailOutbox.updateMany({ where: { status: { in: ['failed', 'skipped'] }, ...(ids && { id: { in: ids } }) }, data: { status: 'queued', attempts: 0, error: null } });
  res.json({ requeued: r.count });
});

// ── delete own (keep last: /:id) ─────────────────────────────────────────────
router.delete('/:id', authenticate, async (req, res) => {
  const r = await req.db.notification.deleteMany({ where: { id: req.params.id, user_id: req.user.id } });
  if (r.count === 0) return bad(res, 'Notification not found', 404);
  res.json({ ok: true });
});

module.exports = router;
