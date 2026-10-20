// Course registration rules. One place decides whether a student may register for an offering, so the
// student portal, the administrator "register on behalf" tool and the approval queue can never disagree.
//
//   BLOCKERS  — cannot be requested at all (period closed, course full, timetable clash, credit ceiling…).
//   APPROVALS — allowed only as an *exception request* a reviewer must approve (missing prerequisite,
//               course outside the student's programme, course already passed). Only when the open
//               registration period has allow_exceptions = true; otherwise they are blockers too.
const { v4: uuid } = require('uuid');
const { getScheme } = require('./gradingScheme');
const { notifyUsers, safe } = require('../utils/notify');

class RegistrationError extends Error {
  constructor(message, status = 422, code, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
const ACTIVE = ['registered', 'pending_approval'];
const sum = (rows, f) => rows.reduce((s, r) => s + f(r), 0);

async function loadStudent(db, studentId) {
  const s = await db.student.findUnique({
    where: { id: studentId },
    include: { class: { include: { grade_level: true, programme: { include: { department: { include: { faculty: true } } } } } } },
  });
  return s;
}
const studentView = s => ({
  id: s.id, name: `${s.first_name} ${s.last_name}`, matricule: s.student_number, class_id: s.class_id, class_name: s.class?.name ?? s.class_name ?? null,
  level_id: s.class?.grade_level_id ?? null, level: s.class?.grade_level?.name ?? null,
  programme_id: s.class?.programme_id ?? null, programme: s.class?.programme?.name ?? null,
  department: s.class?.programme?.department?.name ?? null, faculty: s.class?.programme?.department?.faculty?.name ?? null,
  academic_status: s.academic_status, is_active: s.is_active,
});

/** The registration period that applies to this student for a term (most specific wins), with its open/closed state. */
async function periodFor(db, student, termId, now = new Date()) {
  const periods = await db.registrationPeriod.findMany({ where: { term_id: termId } });
  const prog = student.class?.programme_id ?? null, level = student.class?.grade_level_id ?? null;
  const matching = periods
    .filter(p => (!p.programme_id || p.programme_id === prog) && (!p.level_id || p.level_id === level))
    .sort((a, b) => (Number(!!b.programme_id) * 2 + Number(!!b.level_id)) - (Number(!!a.programme_id) * 2 + Number(!!a.level_id)) || +b.opens_at - +a.opens_at);
  // prefer one that is open right now, else the most specific
  const open = matching.find(p => p.opens_at <= now && now <= p.closes_at);
  const p = open ?? matching[0] ?? null;
  if (!p) return null;
  const dropUntil = p.add_drop_until ?? p.closes_at;
  return { ...p, is_open: p.opens_at <= now && now <= p.closes_at, can_drop: p.opens_at <= now && now <= dropUntil, drop_until: dropUntil };
}

/** Everything needed to evaluate many offerings for one student/term without re-querying per offering. */
async function buildContext(db, student, termId, now = new Date()) {
  const scheme = await getScheme(db);
  const [period, enrollments, marks, curriculum, prereqs] = await Promise.all([
    periodFor(db, student, termId, now),
    db.courseEnrollment.findMany({ where: { student_id: student.id, term_id: termId, status: { in: ACTIVE } }, include: { offering: { include: { slots: true, subject: true } } } }),
    db.mark.findMany({ where: { student_id: student.id, status: 'published' } }),
    student.class?.programme_id ? db.programmeCourse.findMany({ where: { programme_id: student.class.programme_id } }) : [],
    db.coursePrerequisite.findMany({ include: { prerequisite: { select: { id: true, name: true, code: true } } } }),
  ]);
  const passed = new Set(marks.filter(m => scheme.markPassed(m)).map(m => m.subject_id));
  const attempted = new Set(marks.map(m => m.subject_id));
  const prereqBySubject = new Map();
  for (const p of prereqs) prereqBySubject.set(p.subject_id, [...(prereqBySubject.get(p.subject_id) ?? []), p.prerequisite]);
  return {
    now, scheme, student, termId, period, enrollments, passed, attempted,
    curriculumIds: new Set(curriculum.map(c => c.subject_id)), hasCurriculum: curriculum.length > 0,
    prereqBySubject, registeredCredits: sum(enrollments, e => e.credits),
  };
}

const slotKey = s => `${s.day}|${s.period_key}`;

/** Pure rule check of one offering against a prepared context. */
function check(ctx, offering, { seatsTaken = 0, exclude } = {}) {
  const blockers = [], approvals = [];
  const b = (code, message, extra) => blockers.push({ code, message, ...extra });
  const a = (code, message, extra) => approvals.push({ code, message, ...extra });
  const { student, period } = ctx;

  if (!student.is_active || student.academic_status !== 'active') b('inactive_student', 'Your account is not active for registration.');
  if (!offering.is_open || offering.subject?.is_active === false) b('offering_closed', 'This course is not open for registration.');
  if (!period) b('no_period', 'No registration period has been set up for your programme and level this semester.');
  else if (!period.is_open) b('period_closed', ctx.now < period.opens_at ? `Registration opens on ${period.opens_at.toISOString().slice(0, 10)}.` : 'The registration period has closed.');

  const mine = ctx.enrollments.filter(e => e.id !== exclude);
  if (mine.some(e => e.offering_id === offering.id)) b('already_registered', 'You are already registered for this course.');
  if (mine.some(e => e.offering.subject_id === offering.subject_id && e.offering_id !== offering.id)) b('same_course_other_section', 'You are already registered for another section of this course.');

  if (offering.capacity != null && seatsTaken >= offering.capacity) b('full', `This course is full (${offering.capacity} seats).`);

  if (period && ctx.registeredCredits + offering.subject.credit_hours > period.max_credits + 1e-9) {
    b('max_credits', `This would take you to ${ctx.registeredCredits + offering.subject.credit_hours} credits; the limit is ${period.max_credits}.`);
  }

  // timetable clash with courses already registered
  const mySlots = new Map();
  for (const e of mine) for (const s of e.offering.slots) mySlots.set(slotKey(s), e.offering.subject.name);
  const clashes = (offering.slots ?? []).filter(s => mySlots.has(slotKey(s))).map(s => ({ day: s.day, period: s.period_key, with: mySlots.get(slotKey(s)) }));
  if (clashes.length) b('timetable_conflict', `Clashes with ${[...new Set(clashes.map(c => c.with))].join(', ')} (${clashes.map(c => `${c.day} ${c.period}`).join(', ')}).`, { clashes });

  // rules a reviewer may waive
  const missing = (ctx.prereqBySubject.get(offering.subject_id) ?? []).filter(p => !ctx.passed.has(p.id));
  if (missing.length) a('prerequisites_missing', `Prerequisite not passed: ${missing.map(m => `${m.name} (${m.code})`).join(', ')}.`, { missing });
  if (ctx.hasCurriculum && !ctx.curriculumIds.has(offering.subject_id)) a('not_in_curriculum', 'This course is not part of your programme.');
  if (ctx.passed.has(offering.subject_id)) a('already_passed', 'You have already passed this course.');

  const allowEx = !!period?.allow_exceptions;
  const hardBlockers = allowEx ? blockers : [...blockers, ...approvals.map(x => ({ ...x }))];
  const needsApproval = allowEx && approvals.length > 0 && blockers.length === 0;
  return { can_register: hardBlockers.length === 0 && !needsApproval, needs_approval: needsApproval, blockers: hardBlockers, approvals: allowEx ? approvals : [] };
}

const seatsTaken = async (db, offeringId) => db.courseEnrollment.count({ where: { offering_id: offeringId, status: { in: ACTIVE } } });

/**
 * Register a student. Re-validates INSIDE a transaction holding a lock on the offering row so two students
 * can't both take the last seat. `override` (administrators only) skips blockers/approvals but is recorded.
 */
async function enroll(db, student, offeringId, { actor, exceptionReason, override } = {}) {
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM course_offerings WHERE id = ${offeringId} FOR UPDATE`;
    const offering = await tx.courseOffering.findUnique({ where: { id: offeringId }, include: { subject: true, slots: true } });
    if (!offering) throw new RegistrationError('Course offering not found', 404);
    const ctx = await buildContext(tx, student, offering.term_id);
    const verdict = check(ctx, offering, { seatsTaken: await seatsTaken(tx, offeringId) });

    if (!override) {
      if (verdict.blockers.length) throw new RegistrationError(verdict.blockers[0].message, 422, verdict.blockers[0].code, verdict);
      if (verdict.needs_approval && !(exceptionReason && exceptionReason.trim())) {
        throw new RegistrationError(`${verdict.approvals.map(x => x.message).join(' ')} Give a reason to request an exception.`, 422, 'exception_reason_required', verdict);
      }
    } else if (verdict.blockers.some(x => ['already_registered', 'same_course_other_section'].includes(x.code))) {
      throw new RegistrationError(verdict.blockers.find(x => ['already_registered', 'same_course_other_section'].includes(x.code)).message, 409, 'already_registered');
    }
    const asException = !override && verdict.needs_approval;
    const status = asException ? 'pending_approval' : 'registered';
    const kind = asException ? 'exception' : ctx.attempted.has(offering.subject_id) && !ctx.passed.has(offering.subject_id) ? 'retake' : 'regular';
    const existing = await tx.courseEnrollment.findUnique({ where: { student_id_offering_id: { student_id: student.id, offering_id: offeringId } } });
    const data = {
      status, kind, credits: offering.subject.credit_hours, exception_reason: asException ? exceptionReason.trim() : (override ? `Registered by ${actor?.name ?? 'an administrator'}: ${exceptionReason || 'override'}` : null),
      registered_at: new Date(), dropped_at: null, decision_by: override ? actor?.id ?? null : null, decision_at: override ? new Date() : null, decision_note: null, created_by: actor?.id ?? null,
    };
    const row = existing
      ? await tx.courseEnrollment.update({ where: { id: existing.id }, data })
      : await tx.courseEnrollment.create({ data: { id: uuid(), student_id: student.id, offering_id: offeringId, term_id: offering.term_id, ...data } });
    await audit(tx, actor, override ? 'registration.override' : asException ? 'registration.exception_requested' : 'registration.add', 'course_enrollment', row.id, {
      reason: exceptionReason, after: { student_id: student.id, offering_id: offeringId, status, course: offering.subject.code },
    });
    return { enrollment: row, verdict, offering };
  }, { timeout: 20000 });
}

async function drop(db, student, enrollmentId, { actor, override, reason } = {}) {
  const e = await db.courseEnrollment.findUnique({ where: { id: enrollmentId }, include: { offering: { include: { subject: true } } } });
  if (!e || e.student_id !== student.id) throw new RegistrationError('Registration not found', 404);
  if (!ACTIVE.includes(e.status)) throw new RegistrationError('This registration is already inactive.', 409);
  if (!override) {
    const period = await periodFor(db, student, e.term_id);
    if (!period || !period.can_drop) throw new RegistrationError('The add/drop period has ended. Contact the registry to drop this course.', 422, 'drop_closed');
  }
  const updated = await db.courseEnrollment.update({ where: { id: e.id }, data: { status: 'dropped', dropped_at: new Date() } });
  await audit(db, actor, override ? 'registration.drop_override' : 'registration.drop', 'course_enrollment', e.id, { reason, before: { status: e.status, course: e.offering.subject.code } });
  return updated;
}

/** Reviewer decision on an exception request. */
async function decide(db, enrollmentId, { decision, note, actor }) {
  return db.$transaction(async tx => {
    const e0 = await tx.courseEnrollment.findUnique({ where: { id: enrollmentId } });
    if (!e0) throw new RegistrationError('Registration not found', 404);
    await tx.$queryRaw`SELECT id FROM course_offerings WHERE id = ${e0.offering_id} FOR UPDATE`;
    const e = await tx.courseEnrollment.findUnique({ where: { id: enrollmentId }, include: { offering: { include: { subject: true } } } });
    if (e.status !== 'pending_approval') throw new RegistrationError(`This request is already ${e.status}.`, 409);
    if (decision === 'reject' && !(note && note.trim())) throw new RegistrationError('Give a reason for rejecting this request.');
    if (decision === 'approve' && e.offering.capacity != null) {
      const taken = await tx.courseEnrollment.count({ where: { offering_id: e.offering_id, status: 'registered' } });
      if (taken >= e.offering.capacity) throw new RegistrationError('The course is full: increase its capacity first.', 422, 'full');
    }
    const status = decision === 'approve' ? 'registered' : 'rejected';
    const row = await tx.courseEnrollment.update({ where: { id: e.id }, data: { status, decision_by: actor?.id ?? null, decision_at: new Date(), decision_note: note?.trim() || null } });
    await audit(tx, actor, `registration.${decision}`, 'course_enrollment', e.id, { reason: note, before: { status: 'pending_approval' }, after: { status, course: e.offering.subject.code } });
    return { row, e };
  }, { timeout: 20000 }).then(async ({ row, e }) => {
    await safe(async () => {
      const users = await db.user.findMany({ where: { student_id: e.student_id }, select: { id: true } });
      await notifyUsers(db, users.map(u => u.id), {
        type: 'registration_decision', title: decision === 'approve' ? 'Course registration approved' : 'Course registration rejected',
        body: `${e.offering.subject.name}${note ? ` — ${note}` : ''}`, link: '/student/registration',
      });
    });
    return row;
  });
}

async function audit(client, actor, action, targetType, targetId, { reason, before, after } = {}) {
  await client.academicAudit.create({
    data: {
      id: uuid(), actor_id: actor?.id ?? null, actor_name: actor?.name ?? null, actor_role: actor?.role ?? null, action,
      target_type: targetType, target_id: targetId, reason: reason ?? null, before: before ?? undefined, after: after ?? undefined,
    },
  });
}

/** Student-facing overview for a term: period, credits, registered list and the open catalogue with per-course verdicts. */
async function overview(db, student, termId) {
  const term = await db.term.findUnique({ where: { id: termId }, include: { academic_year: true } });
  if (!term) throw new RegistrationError('Semester not found', 404);
  const ctx = await buildContext(db, student, termId);
  const offerings = await db.courseOffering.findMany({
    where: { term_id: termId }, include: { subject: { include: { department: true, level: true } }, slots: true, teacher: { select: { first_name: true, last_name: true } } },
    orderBy: { subject: { name: 'asc' } },
  });
  const taken = await db.courseEnrollment.groupBy({ by: ['offering_id'], where: { term_id: termId, status: { in: ACTIVE } }, _count: { _all: true } });
  const takenBy = Object.fromEntries(taken.map(t => [t.offering_id, t._count._all]));
  const mine = await db.courseEnrollment.findMany({ where: { student_id: student.id, term_id: termId, status: { not: 'dropped' } }, include: { offering: { include: { subject: true, slots: true, teacher: { select: { first_name: true, last_name: true } } } } }, orderBy: { registered_at: 'asc' } });
  const registered = mine.filter(e => e.status === 'registered');
  const pending = mine.filter(e => e.status === 'pending_approval');
  const credits = sum(registered, e => e.credits), pendingCredits = sum(pending, e => e.credits);
  const prereqNames = id => (ctx.prereqBySubject.get(id) ?? []).map(p => ({ id: p.id, name: p.name, code: p.code, passed: ctx.passed.has(p.id) }));
  const teacherName = t => (t ? `${t.first_name} ${t.last_name}` : null);
  return {
    student: studentView(student),
    term: { id: term.id, name: term.name, academic_year: term.academic_year?.label ?? null },
    period: ctx.period && { id: ctx.period.id, name: ctx.period.name, opens_at: ctx.period.opens_at, closes_at: ctx.period.closes_at, drop_until: ctx.period.drop_until, is_open: ctx.period.is_open, can_drop: ctx.period.can_drop, min_credits: ctx.period.min_credits, max_credits: ctx.period.max_credits, allow_exceptions: ctx.period.allow_exceptions },
    credits: { registered: credits, pending: pendingCredits, min: ctx.period?.min_credits ?? null, max: ctx.period?.max_credits ?? null, below_minimum: ctx.period ? credits < ctx.period.min_credits : false },
    registered: mine.map(e => ({
      id: e.id, status: e.status, kind: e.kind, credits: e.credits, exception_reason: e.exception_reason, decision_note: e.decision_note, registered_at: e.registered_at,
      offering_id: e.offering_id, course: e.offering.subject.name, code: e.offering.subject.code, section: e.offering.section, lecturer: teacherName(e.offering.teacher),
      slots: e.offering.slots.map(s => ({ day: s.day, period: s.period_key, room: s.room })),
    })),
    offerings: offerings.map(o => {
      const verdict = check(ctx, o, { seatsTaken: takenBy[o.id] ?? 0 });
      const already = mine.find(e => e.offering_id === o.id && e.status !== 'rejected');
      return {
        id: o.id, course_id: o.subject_id, course: o.subject.name, code: o.subject.code, credits: o.subject.credit_hours, section: o.section, description: o.subject.description,
        department: o.subject.department?.name ?? null, level: o.subject.level?.name ?? null, semester: o.subject.semester, lecturer: teacherName(o.teacher),
        capacity: o.capacity, seats_taken: takenBy[o.id] ?? 0, slots: o.slots.map(s => ({ day: s.day, period: s.period_key, room: s.room })),
        in_curriculum: !ctx.hasCurriculum || ctx.curriculumIds.has(o.subject_id), prerequisites: prereqNames(o.subject_id),
        registration: already ? already.status : null, ...verdict,
      };
    }),
  };
}

module.exports = { RegistrationError, loadStudent, studentView, periodFor, buildContext, check, enroll, drop, decide, overview, audit, ACTIVE };
