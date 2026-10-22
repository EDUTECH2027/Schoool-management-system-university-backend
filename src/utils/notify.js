// In-app notifications + optional e-mail. In-app rows are always real; e-mail is only QUEUED here (EmailOutbox) for the
// types in EMAIL_TYPES, for users who have an address and have not switched e-mail off. The outbox worker
// (src/services/mailWorker.js) delivers through SMTP; when SMTP is not configured the row is recorded as `skipped` with the reason.
// Preferences (NotificationPreference): in_app=false / muted_types suppress NON-critical types; `security` and
// `must_read` can never be suppressed. Callers keep the original contract: notifyUsers(db, ids, {type,title,body,link}).
const { v4: uuid } = require('uuid');
const mailer = require('./mailer');

const CRITICAL_TYPES = new Set(['security', 'must_read']);
const EMAIL_TYPES = new Set(['broadcast', 'must_read', 'service_update', 'results_published', 'registration_decision', 'appeal_decision', 'exam_rescheduled']);

const absLink = link => (link ? `${(process.env.FRONTEND_URL || '').replace(/\/$/, '')}${link.startsWith('/') ? link : `/${link}`}` : '');

/** Preferences for a set of users → Map(user_id → {in_app,email,muted:Set}). Users without a row use the defaults. */
async function loadPrefs(db, ids) {
  const rows = await db.notificationPreference.findMany({ where: { user_id: { in: ids } } });
  return new Map(rows.map(r => [r.user_id, { in_app: r.in_app, email: r.email, muted: new Set(Array.isArray(r.muted_types) ? r.muted_types : []) }]));
}

/** Creates in-app rows and queues e-mails; returns { in_app, email } counts. `channels` (optional) restricts to ['in_app'] / ['email'] / both. */
async function notifyDetailed(db, userIds, { type, title, body, link, channels }) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  const out = { in_app: 0, email: 0 };
  if (!ids.length) return out;
  const critical = CRITICAL_TYPES.has(type);
  const wantInApp = !channels || channels.includes('in_app');
  const wantEmail = channels ? channels.includes('email') : EMAIL_TYPES.has(type);
  let inAppIds = wantInApp ? ids : [], emailIds = [];
  let prefs = new Map();
  try { prefs = await loadPrefs(db, ids); } catch (e) { console.error('[notify] prefs lookup failed:', e.message); }
  const pref = id => prefs.get(id);
  if (!critical) {
    inAppIds = inAppIds.filter(id => { const p = pref(id); return !p || (p.in_app && !p.muted.has(type)); });
  }
  if (wantEmail) emailIds = ids.filter(id => { const p = pref(id); return critical || !p || (p.email && !p.muted.has(type)); });
  if (inAppIds.length) {
    const res = await db.notification.createMany({ data: inAppIds.map(user_id => ({ id: uuid(), user_id, type, title, body: body ?? null, link: link ?? null })) });
    out.in_app = res.count;
  }
  if (emailIds.length) {
    try {
      const users = await db.user.findMany({ where: { id: { in: emailIds } }, select: { id: true, email: true } });
      // Without SMTP nothing could ever be sent: record that honestly right away instead of leaving rows 'queued'.
      const status = mailer.isConfigured() ? {} : { status: 'skipped', error: 'SMTP is not configured (set SMTP_HOST and SMTP_FROM)' };
      const text = [body, link && absLink(link)].filter(Boolean).join('\n\n');
      const rows = users.filter(u => u.email && /^\S+@\S+$/.test(u.email)).map(u => ({ id: uuid(), user_id: u.id, to_email: u.email, subject: String(title).slice(0, 200), body: text || String(title), type, ...status }));
      if (rows.length) out.email = (await db.emailOutbox.createMany({ data: rows })).count;
    } catch (e) { console.error('[notify] email queue failed:', e.message); }
  }
  return out;
}

async function notifyUsers(db, userIds, input) {
  return (await notifyDetailed(db, userIds, input)).in_app;
}

async function classStudentUserIds(db, classId) {
  const users = await db.user.findMany({
    where: { role: 'student', student: { class_id: classId, is_active: true } }, select: { id: true },
  });
  return users.map(u => u.id);
}

async function teacherUserIds(db, teacherId) {
  const users = await db.user.findMany({ where: { teacher_id: teacherId }, select: { id: true } });
  return users.map(u => u.id);
}

// Never let a notification failure break the action that triggered it.
async function safe(fn) {
  try { return await fn(); } catch (e) { console.error('[notify] failed:', e.message); return 0; }
}

module.exports = { notifyUsers, notifyDetailed, classStudentUserIds, teacherUserIds, safe, CRITICAL_TYPES, EMAIL_TYPES };
