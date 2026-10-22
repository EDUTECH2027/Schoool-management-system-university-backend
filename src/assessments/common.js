// Shared helpers for the assessments module: roles, offering access, small validators.
const STAFF = new Set(['super_admin', 'head_teacher', 'academic_officer']);

class AErr extends Error {
  constructor(message, status = 422, code) { super(message); this.status = status; this.code = code; }
}
const isStaff = u => STAFF.has(u?.role);
const actorOf = u => ({ id: u?.id ?? null, name: u?.name ?? null, role: u?.role === 'head_teacher' ? 'super_admin' : u?.role ?? null });

/** Express error middleware for AErr (everything else falls through to the app's handler). */
function errorHandler(err, _req, res, next) {
  if (err instanceof AErr) return res.status(err.status).json({ error: err.message, ...(err.code && { code: err.code }) });
  if (err?.code === 'P2002') return res.status(409).json({ error: 'Conflict: this record already exists' });
  return next(err);
}

const offeringInclude = { subject: { select: { name: true, code: true } }, term: { select: { name: true, academic_year: { select: { label: true } } } }, teacher: { select: { first_name: true, last_name: true } } };

const offeringInfo = o => ({
  id: o.id, course: o.subject?.name, code: o.subject?.code, section: o.section, term_id: o.term_id, term: o.term?.name, academic_year: o.term?.academic_year?.label,
  teacher_id: o.teacher_id, lecturer: o.teacher ? `${o.teacher.first_name} ${o.teacher.last_name}` : null,
});

async function getOffering(db, id) {
  const o = typeof id === 'string' && id ? await db.courseOffering.findUnique({ where: { id }, include: offeringInclude }) : null;
  if (!o) throw new AErr('Course offering not found', 404);
  return o;
}

/** Lecturer who owns the offering, or an administrator / academic officer. mode 'write' = owner only (staff cannot build content). */
function manageAccess(user, offering, { staffOk = true } = {}) {
  if (user.role === 'teacher') {
    if (!user.teacher_id || offering.teacher_id !== user.teacher_id) throw new AErr('This is not your course', 403);
    return 'owner';
  }
  if (isStaff(user)) { if (!staffOk) throw new AErr('Only the course lecturer can do this', 403); return 'staff'; }
  throw new AErr('Forbidden', 403);
}

async function onRoster(db, studentId, offeringId) {
  if (!studentId) return false;
  return !!(await db.courseEnrollment.findFirst({ where: { student_id: studentId, offering_id: offeringId, status: 'registered' }, select: { id: true } }));
}
async function rosterStudentIds(db, offeringId) {
  return (await db.courseEnrollment.findMany({ where: { offering_id: offeringId, status: 'registered' }, select: { student_id: true } })).map(e => e.student_id);
}
async function rosterStudents(db, offeringId) {
  const rows = await db.courseEnrollment.findMany({ where: { offering_id: offeringId, status: 'registered' }, include: { student: true }, orderBy: [{ student: { last_name: 'asc' } }, { student: { first_name: 'asc' } }] });
  return rows.map(e => e.student);
}
async function offeringIdsOfStudent(db, studentId) {
  if (!studentId) return [];
  return (await db.courseEnrollment.findMany({ where: { student_id: studentId, status: 'registered' }, select: { offering_id: true } })).map(e => e.offering_id);
}
const studentUserIds = async (db, studentIds) => studentIds.length ? (await db.user.findMany({ where: { student_id: { in: studentIds } }, select: { id: true } })).map(u => u.id) : [];
const teacherUsers = async (db, teacherId) => teacherId ? (await db.user.findMany({ where: { teacher_id: teacherId }, select: { id: true } })).map(u => u.id) : [];

const sName = s => `${s.first_name} ${s.last_name}`;
const str = v => (typeof v === 'string' ? v.trim() : v);
const round2 = n => Math.round(n * 100) / 100;

function parseDate(v, label, { required = false } = {}) {
  if (v === undefined || v === null || v === '') { if (required) throw new AErr(`${label} is required`); return null; }
  const d = new Date(v);
  if (isNaN(d)) throw new AErr(`${label} is not a valid date`);
  return d;
}
function num(v, label, { min = 0, max = 1000, exclusiveMin = false } = {}) {
  const n = Number(v);
  if (v === '' || v === null || !Number.isFinite(n) || (exclusiveMin ? n <= min : n < min) || n > max) throw new AErr(`${label} must be a number ${exclusiveMin ? 'greater than' : 'between'} ${min}${exclusiveMin ? ` and at most ${max}` : ` and ${max}`}`);
  return n;
}

module.exports = { STAFF, AErr, isStaff, actorOf, errorHandler, offeringInclude, offeringInfo, getOffering, manageAccess, onRoster, rosterStudentIds, rosterStudents, offeringIdsOfStudent, studentUserIds, teacherUsers, sName, str, round2, parseDate, num };
