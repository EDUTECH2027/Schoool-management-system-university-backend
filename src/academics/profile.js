// Unified student academic profile — one read model for the student's own dashboard and for administrators.
// Sensitive blocks are opt-in: the financial section is included only when the caller is entitled to see it.
const { loadStudent, studentView } = require('./registration');
const { getLiveGpaSummary } = require('../utils/transcriptMath');

async function currentTerm(db) {
  return (await db.term.findFirst({ where: { is_current: true }, include: { academic_year: true } }))
    ?? (await db.term.findFirst({ orderBy: { start_date: 'desc' }, include: { academic_year: true } }));
}

async function buildProfile(db, studentId, { includeFinance = false } = {}) {
  const s = await loadStudent(db, studentId);
  if (!s) return null;
  const term = await currentTerm(db);
  const [enrollments, gpa, attendance, history, documents, fees] = await Promise.all([
    term ? db.courseEnrollment.findMany({ where: { student_id: s.id, term_id: term.id, status: { in: ['registered', 'pending_approval'] } }, include: { offering: { include: { subject: true, teacher: { select: { first_name: true, last_name: true } } } } } }) : [],
    getLiveGpaSummary(db, { studentId: s.id }),
    db.attendanceRecord.groupBy({ by: ['status'], where: { student_id: s.id }, _count: { _all: true } }),
    db.studentEnrollmentHistory.findMany({ where: { student_id: s.id }, orderBy: { started_at: 'desc' } }),
    db.studentDocument.findMany({ where: { student_id: s.id }, select: { id: true, title: true, file_url: true, created_at: true } }),
    includeFinance ? db.feeRecord.findMany({ where: { student_id: s.id, status: { not: 'waived' } }, select: { amount_due: true, amount_paid: true, balance: true, status: true, due_date: true, currency: true } }) : null,
  ]);
  const att = Object.fromEntries(attendance.map(a => [a.status, a._count._all]));
  const attTotal = Object.values(att).reduce((x, y) => x + y, 0);
  const sumBy = k => (fees ?? []).reduce((x, f) => x + f[k], 0);
  return {
    student: {
      ...studentView(s), first_name: s.first_name, middle_name: s.middle_name, last_name: s.last_name, gender: s.gender, date_of_birth: s.date_of_birth, photo_url: s.photo_url,
      mobile_number: s.mobile_number, address: s.address, city: s.city, guardian_name: s.guardian_name, guardian_phone: s.guardian_phone, admission_date: s.admission_date,
    },
    term: term && { id: term.id, name: term.name, academic_year: term.academic_year?.label ?? null },
    registered_courses: enrollments.map(e => ({ id: e.id, status: e.status, course: e.offering.subject.name, code: e.offering.subject.code, credits: e.credits, section: e.offering.section, lecturer: e.offering.teacher ? `${e.offering.teacher.first_name} ${e.offering.teacher.last_name}` : null })),
    credits_registered: enrollments.filter(e => e.status === 'registered').reduce((x, e) => x + e.credits, 0),
    performance: { cumulative: gpa.cumulative, by_term: gpa.byTerm.map(t => ({ term_id: t.termId, term: t.termName, academic_year: t.academicYear, gpa: t.termGpa, credits: t.termCreditHours, courses: t.courses.length })) },
    attendance: { present: att.present ?? 0, absent: att.absent ?? 0, late: att.late ?? 0, excused: att.excused ?? 0, total: attTotal, rate: attTotal ? Math.round(((att.present ?? 0) + (att.late ?? 0)) / attTotal * 1000) / 10 : null },
    enrollment_history: history,
    documents,
    ...(includeFinance && { finance: { due: sumBy('amount_due'), paid: sumBy('amount_paid'), balance: sumBy('balance') } }),
  };
}

module.exports = { buildProfile, currentTerm };
