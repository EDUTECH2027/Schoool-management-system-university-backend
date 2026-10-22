// Thesis / final-year project workflow: the state machine and the shared helpers around it.
//
//   proposed → supervisor_accepted → approved → in_progress → submitted → defence_scheduled → defended → completed
//   plus rejected (officer) and withdrawn (student) as terminal exits.
const { v4: uuid } = require('uuid');
const { audit } = require('../academics/registration');
const { notifyUsers, safe, teacherUserIds } = require('../utils/notify');

const STATUSES = ['proposed', 'supervisor_accepted', 'approved', 'in_progress', 'submitted', 'defence_scheduled', 'defended', 'completed', 'rejected', 'withdrawn'];
const TERMINAL = ['completed', 'rejected', 'withdrawn'];
const OPEN = STATUSES.filter(s => !TERMINAL.includes(s));
// statuses in which a supervisor is "carrying" the student (counts against the cap)
const LOADED = ['supervisor_accepted', 'approved', 'in_progress', 'submitted', 'defence_scheduled', 'defended'];

// action → { from: [...], to, by: [roles] }.  `by` roles: student | supervisor | officer
const TRANSITIONS = {
  accept: { from: ['proposed'], to: 'supervisor_accepted', by: ['supervisor'] },
  decline: { from: ['proposed'], to: 'proposed', by: ['supervisor'] },       // supervisor cleared; stays open for re-assignment
  approve: { from: ['supervisor_accepted'], to: 'approved', by: ['officer'] },
  reject: { from: ['proposed', 'supervisor_accepted', 'approved'], to: 'rejected', by: ['officer'] },
  start: { from: ['approved'], to: 'in_progress', by: ['supervisor', 'officer'] },
  submit_final: { from: ['in_progress'], to: 'submitted', by: ['student'] },
  schedule_defence: { from: ['submitted', 'defence_scheduled'], to: 'defence_scheduled', by: ['officer'] },
  defended: { from: ['defence_scheduled'], to: 'defended', by: ['officer'] },
  result: { from: ['defended'], to: 'completed', by: ['officer'] },
  withdraw: { from: ['proposed', 'supervisor_accepted', 'approved', 'in_progress'], to: 'withdrawn', by: ['student'] },
};

class ThesisError extends Error {
  constructor(message, status = 409, code) { super(message); this.status = status; this.code = code; }
}
const maxSupervisees = () => Math.max(1, parseInt(process.env.THESIS_MAX_SUPERVISEES, 10) || 8);

/** Role of the caller relative to a thesis: staff are "officer", the assigned teacher "supervisor"/"co_supervisor", the owner "student". */
function relation(user, t, juryTeacherIds = []) {
  const rel = new Set();
  if (['super_admin', 'head_teacher', 'academic_officer'].includes(user.role)) rel.add('officer');
  if (user.role === 'student' && user.student_id && user.student_id === t.student_id) rel.add('student');
  if (user.role === 'teacher' && user.teacher_id) {
    if (user.teacher_id === t.supervisor_id) rel.add('supervisor');
    if (user.teacher_id === t.co_supervisor_id) rel.add('co_supervisor');
    if (juryTeacherIds.includes(user.teacher_id)) rel.add('jury');
  }
  return rel;
}
const juryTeachers = t => (Array.isArray(t.jury) ? t.jury : []).map(j => j?.teacher_id).filter(Boolean);

/** Transaction-scoped advisory lock on an arbitrary key (serialises racing requests for the same student/supervisor/thesis). */
async function lockKey(tx, key) {
  await tx.$queryRaw`SELECT 1 AS ok FROM (SELECT pg_advisory_xact_lock(hashtext(${key}))) t`;
}
const lockSupervisor = (tx, teacherId) => lockKey(tx, 'thesis-sup:' + teacherId);
async function supervisorLoad(db, teacherId, excludeThesisId) {
  return db.thesis.count({ where: { supervisor_id: teacherId, status: { in: LOADED }, ...(excludeThesisId ? { id: { not: excludeThesisId } } : {}) } });
}
async function assertCapacity(tx, teacherId, excludeThesisId) {
  const load = await supervisorLoad(tx, teacherId, excludeThesisId);
  if (load >= maxSupervisees()) throw new ThesisError(`This supervisor already supervises the maximum of ${maxSupervisees()} students`, 409, 'supervisor_full');
}

async function addEvent(db, t, { kind = 'status', from, to, body, user }) {
  await db.thesisEvent.create({
    data: { id: uuid(), thesis_id: t.id, kind, from_status: from ?? null, to_status: to ?? null, body: body ?? null, author_id: user?.id ?? null, author_name: user?.name ?? null, author_role: user?.role === 'head_teacher' ? 'super_admin' : user?.role ?? null },
  });
}
const actorOf = u => ({ id: u.id, name: u.name, role: u.role === 'head_teacher' ? 'super_admin' : u.role });

/**
 * Atomic compare-and-set transition: only succeeds if the thesis is still in one of the allowed source states, so two
 * concurrent requests cannot both apply. Appends the ThesisEvent and the academic_audit row in the same transaction.
 */
async function transition(db, user, thesisId, action, { data = {}, note, before = {}, guard } = {}) {
  const def = TRANSITIONS[action];
  return db.$transaction(async tx => {
    const cur = await tx.thesis.findUnique({ where: { id: thesisId } });
    if (!cur) throw new ThesisError('Thesis not found', 404);
    if (!def.from.includes(cur.status)) throw new ThesisError(`Not allowed: a thesis that is "${cur.status}" cannot be ${action.replace('_', ' ')}ed`, 409, 'illegal_transition');
    if (guard) await guard(tx, cur);
    const r = await tx.thesis.updateMany({ where: { id: thesisId, status: cur.status }, data: { ...data, status: def.to, updated_at: new Date() } });
    if (!r.count) throw new ThesisError('The thesis was changed by someone else — reload and retry', 409, 'conflict');
    await addEvent(tx, cur, { kind: action === 'schedule_defence' ? 'defence' : 'status', from: cur.status, to: def.to, body: note, user });
    await audit(tx, actorOf(user), `thesis.${action}`, 'thesis', thesisId, { reason: note, before: { status: cur.status, ...before }, after: { status: def.to, ...data } });
    return { before: cur, after: await tx.thesis.findUnique({ where: { id: thesisId } }) };
  });
}

const studentUserIds = async (db, studentId) => (await db.user.findMany({ where: { student_id: studentId }, select: { id: true } })).map(u => u.id);
/** Notify the student and/or the supervisors (+ jury teachers) of a thesis. Never throws. */
async function notifyThesis(db, t, who, { title, body }) {
  return safe(async () => {
    const tIds = [];
    if (who.includes('supervisor') && t.supervisor_id) tIds.push(...await teacherUserIds(db, t.supervisor_id));
    if (who.includes('co_supervisor') && t.co_supervisor_id) tIds.push(...await teacherUserIds(db, t.co_supervisor_id));
    if (who.includes('jury')) for (const id of juryTeachers(t)) tIds.push(...await teacherUserIds(db, id));
    const msg = { type: 'thesis', title, body };
    let n = 0;
    if (who.includes('student')) n += await notifyUsers(db, await studentUserIds(db, t.student_id), { ...msg, link: '/student/thesis' });
    n += await notifyUsers(db, tIds, { ...msg, link: '/teacher/thesis' });
    if (who.includes('officers')) n += await notifyUsers(db, (await db.user.findMany({ where: { role: { in: ['academic_officer', 'super_admin'] } }, select: { id: true } })).map(u => u.id), { ...msg, link: '/academics/thesis' });
    return n;
  });
}

module.exports = { STATUSES, TERMINAL, OPEN, LOADED, TRANSITIONS, ThesisError, maxSupervisees, relation, juryTeachers, lockKey, lockSupervisor, supervisorLoad, assertCapacity, addEvent, transition, notifyThesis, studentUserIds, actorOf };
