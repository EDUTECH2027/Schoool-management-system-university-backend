// Sends an in-app reminder ~15 minutes before a scheduled class (to its students and
// teacher). Runs inside the API process; each session is claimed atomically via
// reminder_sent_at so a restart or a second instance cannot double-send.
const platformClient = require('../db/platformClient');
const tenantPool = require('../db/tenantPool');
const { notifyUsers, classStudentUserIds, teacherUserIds, safe } = require('./notify');

const LEAD_MS = 15 * 60 * 1000;

async function runOnce(db, now = new Date()) {
  const due = await db.elearningSession.findMany({
    where: { status: 'scheduled', reminder_sent_at: null, starts_at: { lte: new Date(now.getTime() + LEAD_MS) }, ends_at: { gt: now } },
  });
  let sent = 0;
  for (const s of due) {
    const claim = await db.elearningSession.updateMany({ where: { id: s.id, reminder_sent_at: null }, data: { reminder_sent_at: now } });
    if (claim.count === 0) continue;
    const mins = Math.max(0, Math.round((s.starts_at - now) / 60000));
    const when = mins === 0 ? 'now' : `in ${mins} min`;
    await safe(async () => {
      await notifyUsers(db, await classStudentUserIds(db, s.class_id),
        { type: 'class_reminder', title: `Class starting ${when}`, body: `${s.title} (${s.subject_name})`, link: '/student/e-learning' });
      await notifyUsers(db, await teacherUserIds(db, s.teacher_id),
        { type: 'class_reminder', title: `Your class starts ${when}`, body: `${s.title} (${s.subject_name})`, link: '/teacher/e-learning' });
    });
    sent++;
  }
  return sent;
}

function start(intervalMs = 60_000) {
  const tick = async () => {
    try {
      const schools = await platformClient.school.findMany({ where: { status: 'active' }, select: { id: true } });
      for (const sc of schools) {
        try { await runOnce(tenantPool.getOrOpen(sc.id)); } catch (e) { console.error(`[reminders] ${sc.id}:`, e.message); }
      }
    } catch (e) { console.error('[reminders] tick failed:', e.message); }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return timer;
}

module.exports = { start, runOnce };
