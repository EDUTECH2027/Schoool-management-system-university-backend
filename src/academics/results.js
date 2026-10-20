// Results workflow. EVERY write to a mark goes through here so that
//   • totals/grades always come from the university's configured grading scheme,
//   • lecturers can only produce DRAFT marks and cannot touch marks already submitted/approved/published,
//   • approvers (administrators / academic officers) validate and publish,
//   • every change and every approval step is recorded in mark_history (nothing is silently overwritten),
//   • students and parents only ever see PUBLISHED marks.
//
//   draft ──submit──▶ submitted ──approve──▶ approved ──publish──▶ published
//     ▲                   │ reject (reason)                              │ reopen (reason)
//     └───────────────────┴──────────────────────────────────────────────┘
const { v4: uuid } = require('uuid');
const { notifyUsers, safe } = require('../utils/notify');

const APPROVER_ROLES = new Set(['super_admin', 'head_teacher', 'academic_officer']);
const isApprover = user => APPROVER_ROLES.has(user?.role);
const actorOf = user => ({ id: user?.id ?? null, name: user?.name ?? null, role: user?.role === 'head_teacher' ? 'super_admin' : user?.role ?? null });

class ResultsError extends Error {
  constructor(message, status = 422, code) { super(message); this.status = status; this.code = code; }
}
const LOCKED = new Set(['submitted', 'approved', 'published']);

const snap = m => m && ({
  ca_score: m.ca_score, exam_score: m.exam_score, total_score: m.total_score, grade: m.grade, remark: m.remark,
  resit_score: m.resit_score, resit_grade: m.resit_grade, exam_absent: m.exam_absent, status: m.status,
});

async function addHistory(client, markId, { action, from, to, before, after, reason, actor }) {
  await client.markHistory.create({
    data: {
      id: uuid(), mark_id: markId, action, from_status: from ?? null, to_status: to ?? null,
      before: before ?? undefined, after: after ?? undefined, reason: reason ?? null,
      actor_id: actor?.id ?? null, actor_name: actor?.name ?? null, actor_role: actor?.role ?? null,
    },
  });
}

/**
 * Create/update one mark. `input` is the camelCase shape the existing endpoints already receive.
 * Returns { mark, created, changed }. Throws ResultsError('locked') for a lecturer touching a locked mark.
 */
async function saveMark(db, scheme, input, user, { reason } = {}) {
  const actor = actorOf(user);
  const approver = isApprover(user);
  const ca = Math.min(100, Math.max(0, Number(input.caScore) || 0));
  const absent = !!input.examAbsent;
  const exam = absent ? 0 : Math.min(100, Math.max(0, Number(input.examScore) || 0));
  const total = scheme.totalFor(ca, exam);
  const auto = scheme.gradeFor(total);
  const hasResit = !(input.resitScore === undefined || input.resitScore === null || input.resitScore === '');
  const resit = hasResit ? Math.min(100, Math.max(0, Number(input.resitScore) || 0)) : null;
  // A manual grade/remark override is honoured (as before) — but only for approvers; the history records it.
  const grade = approver && input.grade ? input.grade : auto.grade;
  const remark = approver && input.remark ? input.remark : (absent ? 'Absent' : auto.remark);
  const resitGrade = resit === null ? null : scheme.gradeFor(scheme.resitTotal(resit)).grade;

  return db.$transaction(async tx => {
    const existing = await tx.mark.findUnique({
      where: { marks_student_subject_term: { student_id: input.studentId, subject_id: input.subjectId, term_id: input.termId } },
    });
    if (existing && LOCKED.has(existing.status) && !approver) {
      throw new ResultsError(`This mark is ${existing.status} and can only be changed by an academic administrator.`, 403, 'locked');
    }
    const now = new Date();
    const data = {
      ca_score: ca, exam_score: exam, total_score: total, grade, remark, resit_score: resit, resit_grade: resitGrade,
      exam_absent: absent, updated_at: now,
    };
    if (input.offeringId) data.offering_id = input.offeringId;
    // status: approvers' direct entries are authoritative → published; lecturers' stay draft.
    let status = existing?.status ?? 'draft';
    if (approver) status = 'published';
    else if (!existing) status = 'draft';
    const stamp = approver && status === 'published' && existing?.status !== 'published'
      ? { published_at: now, published_by: actor.id, approved_at: existing?.approved_at ?? now, approved_by: existing?.approved_by ?? actor.id } : {};

    if (!existing) {
      const created = await tx.mark.create({
        data: {
          id: input.id || uuid(), student_id: input.studentId, student_name: input.studentName || null, student_number: input.studentNumber || null,
          subject_id: input.subjectId, subject_name: input.subjectName || null, term_id: input.termId, class_id: input.classId || null,
          ...data, status, entered_by: actor.id, ...stamp,
        },
      });
      await addHistory(tx, created.id, { action: 'save', to: status, after: snap(created), reason: reason || 'Created', actor });
      return { mark: created, created: true, changed: true };
    }
    const next = { ...existing, ...data, status };
    const changed = JSON.stringify(snap(existing)) !== JSON.stringify(snap(next));
    if (!changed) return { mark: existing, created: false, changed: false };
    const updated = await tx.mark.update({ where: { id: existing.id }, data: { ...data, status, ...stamp, entered_by: existing.entered_by ?? actor.id } });
    await addHistory(tx, existing.id, {
      action: 'save', from: existing.status, to: status, before: snap(existing), after: snap(updated),
      reason: reason || (existing.status === 'published' ? 'Edited by an administrator' : null), actor,
    });
    return { mark: updated, created: false, changed: true };
  }, { timeout: 15000 });
}

/** Save many; one failure never aborts the rest (same contract the old endpoints had). */
async function saveMarks(db, scheme, records, user, opts = {}) {
  let saved = 0; const errors = [];
  for (const r of records) {
    if (!r.studentId || !r.subjectId || !r.termId) continue;
    try { await saveMark(db, scheme, r, user, opts); saved++; }
    catch (e) {
      if (!(e instanceof ResultsError)) console.error('[results] record skipped:', e.message);
      errors.push({ studentId: r.studentId, subjectId: r.subjectId, error: e.message, code: e.code });
    }
  }
  return { saved, errors };
}

const TRANSITIONS = {
  submit:  { from: ['draft'],              to: 'submitted', who: 'lecturer' },
  approve: { from: ['submitted'],          to: 'approved',  who: 'approver' },
  reject:  { from: ['submitted', 'approved'], to: 'draft',  who: 'approver', needsReason: true },
  publish: { from: ['approved'],           to: 'published', who: 'approver' },
  reopen:  { from: ['published'],          to: 'draft',     who: 'approver', needsReason: true },
};

/**
 * Move a batch of marks through the workflow.
 *   scope: { markIds } or { subjectId, termId, classId?, offeringId? }
 * Lecturers may only submit, and only their own drafts (`ownsScope(mark)` is supplied by the caller).
 */
async function transition(db, action, scope, user, { reason, ownsMark } = {}) {
  const rule = TRANSITIONS[action];
  if (!rule) throw new ResultsError('Unknown action');
  const approver = isApprover(user);
  if (rule.who === 'approver' && !approver) throw new ResultsError('Only an academic administrator can do this.', 403);
  if (rule.needsReason && !(reason && reason.trim())) throw new ResultsError('A reason is required.');
  const actor = actorOf(user);

  const where = scope.markIds ? { id: { in: scope.markIds } } : { subject_id: scope.subjectId, term_id: scope.termId, ...(scope.classId && { class_id: scope.classId }), ...(scope.offeringId && { offering_id: scope.offeringId }) };
  if (!scope.markIds && (!scope.subjectId || !scope.termId)) throw new ResultsError('subjectId and termId are required');
  const marks = await db.mark.findMany({ where });
  const moved = []; const skipped = [];
  for (const m of marks) {
    if (!rule.from.includes(m.status)) { skipped.push({ id: m.id, reason: `already ${m.status}` }); continue; }
    if (rule.who === 'lecturer' && !approver && ownsMark && !(await ownsMark(m))) { skipped.push({ id: m.id, reason: 'not your course' }); continue; }
    moved.push(m);
  }
  const now = new Date();
  for (const m of moved) {
    const data = { status: rule.to, updated_at: now };
    if (action === 'submit') Object.assign(data, { submitted_at: now, submitted_by: actor.id });
    if (action === 'approve') Object.assign(data, { approved_at: now, approved_by: actor.id });
    if (action === 'publish') Object.assign(data, { published_at: now, published_by: actor.id });
    if (action === 'reject' || action === 'reopen') Object.assign(data, { submitted_at: null, approved_at: null, published_at: null });
    await db.$transaction(async tx => {
      const upd = await tx.mark.updateMany({ where: { id: m.id, status: m.status }, data });   // compare-and-set
      if (upd.count === 1) await addHistory(tx, m.id, { action, from: m.status, to: rule.to, reason, actor });
    });
  }
  if (action === 'publish' && moved.length) await safe(() => announcePublished(db, moved));
  return { moved: moved.length, skipped };
}

// Tell each student (in-app) that results were published — one notification per student per publish call.
async function announcePublished(db, marks) {
  const byStudent = new Map();
  for (const m of marks) byStudent.set(m.student_id, [...(byStudent.get(m.student_id) ?? []), m.subject_name || 'a course']);
  const users = await db.user.findMany({ where: { student_id: { in: [...byStudent.keys()] } }, select: { id: true, student_id: true } });
  for (const u of users) {
    const names = [...new Set(byStudent.get(u.student_id))];
    await notifyUsers(db, [u.id], { type: 'results_published', title: 'New results published', body: names.slice(0, 4).join(', ') + (names.length > 4 ? '…' : ''), link: '/student/marks' });
  }
}

module.exports = { saveMark, saveMarks, transition, addHistory, snap, isApprover, actorOf, ResultsError, APPROVER_ROLES, LOCKED };
