// A compact snapshot of the CALLER'S OWN data, built server-side from the database (never from the request body).
//   student  → own programme/level, registered courses, published GPA, upcoming exams, open service requests, fee balance
//   teacher  → own course offerings and the state of their marks
//   others   → nothing personal (no student data for staff)
// Text that originated in the database (course names, titles…) is sanitised: single line, no markup characters, capped.
const { getLiveGpaSummary } = require('../utils/transcriptMath');
const { currentTerm } = require('../academics/profile');

const clean = (s, n = 80) => (s == null ? null : String(s).replace(/[\u0000-\u001f\u007f<>`{}]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n));
const round2 = n => Math.round(n * 100) / 100;

async function studentContext(db, user) {
  if (!user.student_id) return null;
  const s = await db.student.findUnique({ where: { id: user.student_id }, include: { class: { include: { grade_level: true, programme: true } } } });
  if (!s) return null;
  const term = await currentTerm(db);
  const today = new Date().toISOString().slice(0, 10);
  const [enrollments, gpa, exams, requests, fees] = await Promise.all([
    term ? db.courseEnrollment.findMany({ where: { student_id: s.id, term_id: term.id, status: { in: ['registered', 'pending_approval'] } }, include: { offering: { include: { subject: true } } }, take: 30 }) : [],
    getLiveGpaSummary(db, { studentId: s.id }),
    db.examCandidate.findMany({ where: { student_id: s.id, exam: { date: { gte: today }, status: 'scheduled' } }, include: { exam: { include: { subject: true } } }, take: 15 }),
    db.serviceRequest.findMany({ where: { student_id: s.id, status: { in: ['submitted', 'in_review', 'awaiting_info'] } }, orderBy: { created_at: 'desc' }, take: 10, select: { reference: true, type: true, subject: true, status: true } }),
    db.feeRecord.findMany({ where: { student_id: s.id, status: { not: 'waived' } }, select: { fee_name: true, amount_due: true, amount_paid: true, balance: true, status: true, due_date: true, currency: true }, take: 30 }),
  ]);
  const balance = fees.reduce((x, f) => x + f.balance, 0);
  const overdue = fees.filter(f => f.balance > 0 && (f.status === 'overdue' || (f.due_date && f.due_date < today))).reduce((x, f) => x + f.balance, 0);
  return {
    student: { name: clean(`${s.first_name} ${s.last_name}`), matricule: clean(s.student_number), programme: clean(s.class?.programme?.name), level: clean(s.class?.grade_level?.name ?? s.grade_level_name), cohort: clean(s.class?.name ?? s.class_name), academic_status: s.academic_status },
    current_semester: term ? { name: clean(term.name), academic_year: clean(term.academic_year?.label) } : null,
    registered_courses: enrollments.map(e => ({ code: clean(e.offering.subject.code, 20), name: clean(e.offering.subject.name), credits: e.credits, status: e.status })),
    published_gpa: gpa.cumulative.courseCount ? { cumulative: gpa.cumulative.gpa, credits: gpa.cumulative.totalCreditHours, courses: gpa.cumulative.courseCount, by_semester: gpa.byTerm.map(t => ({ semester: `${clean(t.academicYear, 20)} ${clean(t.termName, 20)}`, gpa: t.termGpa })) } : { note: 'No published results yet' },
    upcoming_exams: exams.map(c => ({ course: clean(`${c.exam.subject.code} ${c.exam.subject.name}`), date: c.exam.date, time: `${c.exam.start_time}-${c.exam.end_time}`, room: clean(c.exam.room, 40), eligible: c.eligible, reasons: c.eligible ? undefined : (Array.isArray(c.ineligible_reasons) ? c.ineligible_reasons.map(r => clean(r?.message, 100)) : undefined) })),
    open_service_requests: requests.map(r => ({ reference: r.reference, type: r.type, subject: clean(r.subject, 80), status: r.status })),
    fees: { currency: fees[0]?.currency ?? 'XAF', total_balance: round2(balance), overdue_balance: round2(overdue), records: fees.length },
  };
}

async function teacherContext(db, user) {
  if (!user.teacher_id) return null;
  const t = await db.teacher.findUnique({ where: { id: user.teacher_id }, select: { first_name: true, last_name: true } });
  const term = await currentTerm(db);
  const offerings = term ? await db.courseOffering.findMany({ where: { teacher_id: user.teacher_id, term_id: term.id }, include: { subject: true, _count: { select: { enrollments: { where: { status: 'registered' } } } } } }) : [];
  const marks = offerings.length ? await db.mark.groupBy({ by: ['offering_id', 'status'], where: { offering_id: { in: offerings.map(o => o.id) } }, _count: { _all: true } }) : [];
  const m = {};
  for (const r of marks) (m[r.offering_id] ??= {})[r.status] = r._count._all;
  return {
    lecturer: t ? clean(`${t.first_name} ${t.last_name}`) : null,
    current_semester: term ? { name: clean(term.name), academic_year: clean(term.academic_year?.label) } : null,
    my_courses: offerings.map(o => {
      const x = m[o.id] || {}, enrolled = o._count.enrollments;
      return { code: clean(o.subject.code, 20), name: clean(o.subject.name), section: clean(o.section, 10), registered_students: enrolled, marks: { draft: x.draft ?? 0, submitted: x.submitted ?? 0, approved: x.approved ?? 0, published: x.published ?? 0, not_entered: Math.max(0, enrolled - Object.values(x).reduce((a, b) => a + b, 0)) } };
    }),
  };
}

/** → { label, data|null } — `data` is a plain JSON-able object for the system prompt. */
async function buildContext(db, user) {
  const role = user.role === 'head_teacher' ? 'super_admin' : user.role;
  try {
    if (role === 'student') return await studentContext(db, user);
    if (role === 'teacher') return await teacherContext(db, user);
  } catch (e) { console.error('[assistant] context failed:', e.message); }
  return null;
}

module.exports = { buildContext, clean };
