// In-app notifications. Email/SMS/WhatsApp are NOT wired for e-learning: the project
// has no SMTP configuration, so nothing here pretends to send email.
const { v4: uuid } = require('uuid');

async function notifyUsers(db, userIds, { type, title, body, link }) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return 0;
  const res = await db.notification.createMany({
    data: ids.map(user_id => ({ id: uuid(), user_id, type, title, body: body ?? null, link: link ?? null })),
  });
  return res.count;
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

module.exports = { notifyUsers, classStudentUserIds, teacherUserIds, safe };
