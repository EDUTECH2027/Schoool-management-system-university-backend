// Thesis / final-year project supervision: proposal → supervisor → approval → milestones & submissions → defence → result.
// The state machine lives in src/thesis/engine.js; every transition appends a ThesisEvent and an academic_audit row.
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { audit } = require('../academics/registration');
const { uploadSingle, TYPES, INLINE_OK, extOf } = require('../utils/elearningUploads');
const { clean, dateStr, today, paging, isStaff, bad } = require('../careers/util');
const E = require('../thesis/engine');

router.use(authenticate);
const officer = authorize('super_admin', 'academic_officer');
const KINDS = ['thesis', 'project', 'internship_report'];
const aud = (req, action, id, extra) => audit(req.db, E.actorOf(req.user), action, 'thesis', id, extra);
const fail = (res, status, error) => res.status(status).json({ error });
const nameOf = p => (p ? `${p.first_name} ${p.last_name}` : null);
const INCLUDE = { student: { include: { class: { include: { programme: true } } } }, supervisor: true, co_supervisor: true };

const view = t => ({
  id: t.id, title: t.title, abstract: t.abstract, keywords: t.keywords, kind: t.kind, status: t.status,
  student: t.student ? { id: t.student.id, name: nameOf(t.student), matricule: t.student.student_number, programme: t.student.class?.programme?.name ?? null, programme_id: t.student.class?.programme_id ?? null } : undefined,
  supervisor: t.supervisor ? { id: t.supervisor.id, name: nameOf(t.supervisor) } : null,
  co_supervisor: t.co_supervisor ? { id: t.co_supervisor.id, name: nameOf(t.co_supervisor) } : null,
  defence: t.defence_date ? { date: t.defence_date, time: t.defence_time, room: t.defence_room, jury: t.jury ?? [] } : null,
  final_score: t.final_score, final_grade: t.final_grade, decision_note: t.decision_note, created_at: t.created_at, updated_at: t.updated_at,
});
const subView = s => ({ id: s.id, thesis_id: s.thesis_id, milestone_id: s.milestone_id, version: s.version, note: s.note, file_name: s.file_name, file_size: s.file_size, feedback: s.feedback, reviewed_by: s.reviewed_by, reviewed_at: s.reviewed_at, created_at: s.created_at });
const msView = m => ({ id: m.id, title: m.title, due_date: m.due_date, status: m.status, feedback: m.feedback, position: m.position });
const SUB_SELECT = { id: true, thesis_id: true, milestone_id: true, version: true, note: true, file_name: true, file_size: true, feedback: true, reviewed_by: true, reviewed_at: true, created_at: true };

async function loadFull(db, id) {
  const t = await db.thesis.findUnique({ where: { id }, include: INCLUDE });
  if (!t) return null;
  const [milestones, submissions, events] = await Promise.all([
    db.thesisMilestone.findMany({ where: { thesis_id: id }, orderBy: [{ position: 'asc' }, { due_date: 'asc' }] }),
    db.thesisSubmission.findMany({ where: { thesis_id: id }, select: SUB_SELECT, orderBy: { created_at: 'desc' } }),
    db.thesisEvent.findMany({ where: { thesis_id: id }, orderBy: { created_at: 'asc' } }),
  ]);
  return { ...view(t), milestones: milestones.map(msView), submissions: submissions.map(subView), events: events.map(e => ({ id: e.id, kind: e.kind, from_status: e.from_status, to_status: e.to_status, body: e.body, author_name: e.author_name, author_role: e.author_role, created_at: e.created_at })) };
}
/** Load a thesis for the caller and require one of the relations (or throw 404/403). Returns { t, rel }. */
async function access(req, res, id, allowed) {
  const t = await req.db.thesis.findUnique({ where: { id }, include: INCLUDE });
  if (!t) { fail(res, 404, 'Thesis not found'); return null; }
  const rel = E.relation(req.user, t, E.juryTeachers(t));
  const ok = allowed.some(a => rel.has(a));
  if (!ok) { fail(res, rel.size ? 403 : 404, rel.size ? 'You are not allowed to do this on this thesis' : 'Thesis not found'); return null; }
  return { t, rel };
}
const teacherRow = async (db, id) => (id ? db.teacher.findFirst({ where: { id, is_active: true } }) : null);

// ── Lists & dashboards ───────────────────────────────────────────────────────────
router.get('/supervisors', async (req, res) => {   // picker: lecturers with their current load (any signed-in student/teacher/staff)
  if (!isStaff(req.user) && !['student', 'teacher'].includes(req.user.role)) return fail(res, 403, 'Forbidden');
  const teachers = await req.db.teacher.findMany({ where: { is_active: true }, orderBy: [{ last_name: 'asc' }, { first_name: 'asc' }], select: { id: true, first_name: true, last_name: true } });
  const loads = await req.db.thesis.groupBy({ by: ['supervisor_id'], where: { status: { in: E.LOADED }, supervisor_id: { not: null } }, _count: { _all: true } });
  const m = Object.fromEntries(loads.map(l => [l.supervisor_id, l._count._all]));
  const max = E.maxSupervisees();
  res.json({ max, items: teachers.map(t => ({ id: t.id, name: nameOf(t), load: m[t.id] ?? 0, max, available: (m[t.id] ?? 0) < max })) });
});

router.get('/mine', async (req, res) => {
  if (req.user.role !== 'student' || !req.user.student_id) return fail(res, 403, 'Only students have a thesis of their own');
  const all = await req.db.thesis.findMany({ where: { student_id: req.user.student_id }, orderBy: { created_at: 'desc' }, select: { id: true, status: true } });
  const cur = all.find(t => E.OPEN.includes(t.status)) ?? all[0] ?? null;
  const s = await req.db.student.findUnique({ where: { id: req.user.student_id }, select: { academic_status: true, is_active: true } });
  res.json({
    can_propose: !!s && s.is_active && s.academic_status === 'active' && !all.some(t => E.OPEN.includes(t.status)),
    thesis: cur ? await loadFull(req.db, cur.id) : null,
    past: all.filter(t => t.id !== cur?.id).map(t => ({ id: t.id, status: t.status })),
  });
});

router.get('/supervision', async (req, res) => {
  if (req.user.role !== 'teacher' || !req.user.teacher_id) return fail(res, 403, 'Only lecturers supervise theses');
  const me = req.user.teacher_id; const day = today();
  const rows = await req.db.thesis.findMany({
    where: { OR: [{ supervisor_id: me }, { co_supervisor_id: me }] }, include: { ...INCLUDE, milestones: true }, orderBy: { updated_at: 'desc' },
  });
  const unreviewed = await req.db.thesisSubmission.groupBy({ by: ['thesis_id'], where: { reviewed_at: null, thesis: { OR: [{ supervisor_id: me }, { co_supervisor_id: me }] } }, _count: { _all: true } });
  const pending = Object.fromEntries(unreviewed.map(u => [u.thesis_id, u._count._all]));
  const summary = t => {
    const due = t.milestones.filter(m => ['pending', 'revision_requested'].includes(m.status) && m.due_date).map(m => m.due_date).sort();
    return { ...view(t), role: t.supervisor_id === me ? 'supervisor' : 'co_supervisor', next_deadline: due[0] ?? null, overdue: !!due[0] && due[0] < day, milestones_done: t.milestones.filter(m => m.status === 'accepted').length, milestones_total: t.milestones.length, awaiting_review: pending[t.id] ?? 0 };
  };
  const load = await E.supervisorLoad(req.db, me);
  res.json({
    max: E.maxSupervisees(), load,
    requests: rows.filter(t => t.supervisor_id === me && t.status === 'proposed').map(summary),
    supervisees: rows.filter(t => !(t.supervisor_id === me && t.status === 'proposed')).map(summary),
  });
});

router.get('/dashboard', officer, async (req, res) => {
  const day = today(); const max = E.maxSupervisees();
  const [byStatus, loads, upcoming, teachers, awaiting] = await Promise.all([
    req.db.thesis.groupBy({ by: ['status'], _count: { _all: true } }),
    req.db.thesis.groupBy({ by: ['supervisor_id', 'status'], where: { supervisor_id: { not: null } }, _count: { _all: true } }),
    req.db.thesis.findMany({ where: { status: 'defence_scheduled', defence_date: { gte: day } }, include: INCLUDE, orderBy: [{ defence_date: 'asc' }, { defence_time: 'asc' }], take: 50 }),
    req.db.teacher.findMany({ where: { is_active: true }, select: { id: true, first_name: true, last_name: true } }),
    req.db.thesis.count({ where: { status: 'supervisor_accepted' } }),
  ]);
  const tname = Object.fromEntries(teachers.map(t => [t.id, nameOf(t)]));
  const workload = {};
  for (const l of loads) { const w = workload[l.supervisor_id] ??= { supervisor_id: l.supervisor_id, name: tname[l.supervisor_id] ?? '—', load: 0, completed: 0, max }; if (E.LOADED.includes(l.status)) w.load += l._count._all; if (l.status === 'completed') w.completed += l._count._all; }
  for (const t of teachers) workload[t.id] ??= { supervisor_id: t.id, name: nameOf(t), load: 0, completed: 0, max };
  res.json({
    status_counts: Object.fromEntries(E.STATUSES.map(s => [s, byStatus.find(b => b.status === s)?._count._all ?? 0])), awaiting_approval: awaiting,
    workload: Object.values(workload).sort((a, b) => b.load - a.load || a.name.localeCompare(b.name)),
    upcoming_defences: upcoming.map(view),
  });
});

router.get('/', officer, async (req, res) => {
  const where = {};
  if (E.STATUSES.includes(req.query.status)) where.status = req.query.status;
  if (req.query.supervisor_id) where.supervisor_id = String(req.query.supervisor_id);
  if (req.query.programme_id) where.student = { class: { programme_id: String(req.query.programme_id) } };
  const q = clean(req.query.q ?? '', 100);
  if (q) where.OR = [{ title: { contains: q, mode: 'insensitive' } }, { student: { OR: [{ first_name: { contains: q, mode: 'insensitive' } }, { last_name: { contains: q, mode: 'insensitive' } }, { student_number: { contains: q, mode: 'insensitive' } }] } }];
  const { limit, page, skip } = paging(req.query);
  const [total, rows] = await Promise.all([req.db.thesis.count({ where }), req.db.thesis.findMany({ where, include: INCLUDE, orderBy: { updated_at: 'desc' }, skip, take: limit })]);
  res.json({ total, page, limit, items: rows.map(view) });
});

// ── Proposal ─────────────────────────────────────────────────────────────────────
function proposalData(b) {
  const d = {};
  if (b.title !== undefined) { const v = clean(b.title, 200); if (!v) throw bad('title is required'); d.title = v; }
  if (b.abstract !== undefined) d.abstract = clean(b.abstract, 5000, { multiline: true });
  if (b.keywords !== undefined) d.keywords = clean(b.keywords, 300);
  if (b.kind !== undefined) { if (!KINDS.includes(b.kind)) throw bad(`kind must be one of ${KINDS.join(', ')}`); d.kind = b.kind; }
  return d;
}
router.post('/', authorize('student'), async (req, res) => {
  if (!req.user.student_id) return fail(res, 403, 'No student record');
  const s = await req.db.student.findUnique({ where: { id: req.user.student_id } });
  if (!s || !s.is_active || s.academic_status !== 'active') return fail(res, 403, 'Only active students can propose a thesis');
  const d = proposalData({ kind: 'thesis', ...req.body });
  if (!d.title) return fail(res, 422, 'title is required');
  const sup = req.body.supervisor_id ? await teacherRow(req.db, req.body.supervisor_id) : null;
  if (req.body.supervisor_id && !sup) return fail(res, 422, 'Unknown supervisor');
  const row = await req.db.$transaction(async tx => {
    await E.lockKey(tx, 'thesis-stu:' + s.id);
    if (await tx.thesis.count({ where: { student_id: s.id, status: { in: E.OPEN } } })) throw new E.ThesisError('You already have an open thesis — withdraw it before proposing another', 409, 'already_open');
    const t = await tx.thesis.create({ data: { id: uuid(), student_id: s.id, supervisor_id: sup?.id ?? null, status: 'proposed', ...d } });
    await E.addEvent(tx, t, { to: 'proposed', body: 'Proposal submitted', user: req.user });
    await audit(tx, E.actorOf(req.user), 'thesis.propose', 'thesis', t.id, { after: { title: t.title, supervisor_id: t.supervisor_id } });
    return t;
  });
  if (sup) await E.notifyThesis(req.db, row, ['supervisor'], { title: 'New thesis supervision request', body: `${nameOf(s)}: ${row.title}` });
  await E.notifyThesis(req.db, row, ['officers'], { title: 'New thesis proposal', body: `${nameOf(s)}: ${row.title}` });
  res.status(201).json(await loadFull(req.db, row.id));
});

router.get('/submissions/:sid/file', async (req, res) => {
  const sub = await req.db.thesisSubmission.findUnique({ where: { id: req.params.sid } });
  if (!sub || !sub.file_data) return fail(res, 404, 'File not found');
  const a = await access(req, res, sub.thesis_id, ['student', 'supervisor', 'co_supervisor', 'officer', 'jury']);
  if (!a) return;
  if (a.rel.size === 1 && a.rel.has('jury') && !['defence_scheduled', 'defended', 'completed'].includes(a.t.status)) return fail(res, 403, 'Jury members can open the files once the defence is scheduled');
  const ext = extOf(sub.file_name || '');
  const inline = req.query.inline === '1' && INLINE_OK.has(ext);
  res.setHeader('Content-Type', TYPES[ext] || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; media-src 'self'; img-src 'self' data:");
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(sub.file_name || 'file')}`);
  res.setHeader('Content-Length', sub.file_data.length);
  res.end(Buffer.from(sub.file_data));
});

router.put('/submissions/:sid/review', authorize('teacher'), async (req, res) => {
  const sub = await req.db.thesisSubmission.findUnique({ where: { id: req.params.sid } });
  if (!sub) return fail(res, 404, 'Submission not found');
  const a = await access(req, res, sub.thesis_id, ['supervisor', 'co_supervisor']);
  if (!a) return;
  if (a.t.status !== 'in_progress') return fail(res, 409, 'Submissions can only be reviewed while the thesis is in progress');
  const decision = req.body.decision; const feedback = clean(req.body.feedback, 3000, { multiline: true });
  if (sub.milestone_id) {
    if (!['accepted', 'revision_requested'].includes(decision)) return fail(res, 422, 'decision must be accepted or revision_requested');
    if (decision === 'revision_requested' && !feedback) return fail(res, 422, 'Feedback is required when requesting a revision');
  } else if (decision !== undefined) return fail(res, 422, 'Only milestone submissions can be accepted or sent back');
  if (!feedback && !decision) return fail(res, 422, 'feedback is required');
  const out = await req.db.$transaction(async tx => {
    if (sub.milestone_id) {
      const latest = await tx.thesisSubmission.findFirst({ where: { thesis_id: sub.thesis_id, milestone_id: sub.milestone_id }, orderBy: { version: 'desc' } });
      if (latest.id !== sub.id) throw new E.ThesisError('A newer version of this deliverable exists — review that one', 409);
      const r = await tx.thesisMilestone.updateMany({ where: { id: sub.milestone_id, status: 'submitted' }, data: { status: decision, feedback: feedback ?? undefined, updated_at: new Date() } });
      if (!r.count) throw new E.ThesisError('This deliverable has already been reviewed', 409);
    }
    const row = await tx.thesisSubmission.update({ where: { id: sub.id }, data: { feedback, reviewed_by: req.user.name, reviewed_at: new Date() }, select: SUB_SELECT });
    await E.addEvent(tx, a.t, { kind: 'comment', body: `Review of v${sub.version}${decision ? ` — ${decision.replace('_', ' ')}` : ''}${feedback ? `: ${feedback.slice(0, 200)}` : ''}`, user: req.user });
    await audit(tx, E.actorOf(req.user), 'thesis.review', 'thesis', sub.thesis_id, { reason: feedback, after: { submission: sub.id, version: sub.version, decision } });
    return row;
  });
  await E.notifyThesis(req.db, a.t, ['student'], { title: 'Your supervisor reviewed your submission', body: `${a.t.title}${decision ? ` — ${decision.replace('_', ' ')}` : ''}` });
  res.json(subView(out));
});

router.put('/milestones/:mid', authorize('teacher', 'super_admin', 'academic_officer'), async (req, res) => {
  const m = await req.db.thesisMilestone.findUnique({ where: { id: req.params.mid } });
  if (!m) return fail(res, 404, 'Milestone not found');
  const a = await access(req, res, m.thesis_id, ['supervisor', 'co_supervisor', 'officer']);
  if (!a) return;
  if (!['approved', 'in_progress'].includes(a.t.status)) return fail(res, 409, 'Milestones can only be edited while the thesis is approved or in progress');
  const d = {};
  if (req.body.title !== undefined) { const v = clean(req.body.title, 200); if (!v) return fail(res, 422, 'title is required'); d.title = v; }
  if (req.body.due_date !== undefined) d.due_date = dateStr(req.body.due_date, 'due_date');
  if (req.body.position !== undefined) { const n = Number(req.body.position); if (!Number.isInteger(n) || n < 0 || n > 1000) return fail(res, 422, 'position must be a whole number'); d.position = n; }
  if (req.body.feedback !== undefined) d.feedback = clean(req.body.feedback, 3000, { multiline: true });
  const row = await req.db.thesisMilestone.update({ where: { id: m.id }, data: { ...d, updated_at: new Date() } });
  res.json(msView(row));
});
router.delete('/milestones/:mid', authorize('teacher', 'super_admin', 'academic_officer'), async (req, res) => {
  const m = await req.db.thesisMilestone.findUnique({ where: { id: req.params.mid } });
  if (!m) return fail(res, 404, 'Milestone not found');
  const a = await access(req, res, m.thesis_id, ['supervisor', 'co_supervisor', 'officer']);
  if (!a) return;
  if (!['approved', 'in_progress'].includes(a.t.status)) return fail(res, 409, 'Milestones can only be edited while the thesis is approved or in progress');
  if (await req.db.thesisSubmission.count({ where: { milestone_id: m.id } })) return fail(res, 409, 'This milestone already has submissions and cannot be deleted');
  await req.db.thesisMilestone.delete({ where: { id: m.id } });
  res.status(204).end();
});

// ── One thesis ───────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const a = await access(req, res, req.params.id, ['student', 'supervisor', 'co_supervisor', 'officer', 'jury']);
  if (!a) return;
  res.json(await loadFull(req.db, a.t.id));
});

router.put('/:id', authorize('student'), async (req, res) => {   // the student may refine the proposal until a supervisor has accepted it
  const a = await access(req, res, req.params.id, ['student']);
  if (!a) return;
  if (a.t.status !== 'proposed') return fail(res, 409, 'The proposal can only be edited while it is still "proposed"');
  const d = proposalData(req.body);
  if (req.body.supervisor_id !== undefined) {
    if (req.body.supervisor_id === null || req.body.supervisor_id === '') d.supervisor_id = null;
    else { const sup = await teacherRow(req.db, req.body.supervisor_id); if (!sup) return fail(res, 422, 'Unknown supervisor'); d.supervisor_id = sup.id; }
  }
  const r = await req.db.thesis.updateMany({ where: { id: a.t.id, status: 'proposed' }, data: { ...d, updated_at: new Date() } });
  if (!r.count) return fail(res, 409, 'The proposal can only be edited while it is still "proposed"');
  await E.addEvent(req.db, a.t, { kind: 'comment', body: 'Proposal edited', user: req.user });
  await aud(req, 'thesis.edit', a.t.id, { before: { title: a.t.title, supervisor_id: a.t.supervisor_id }, after: d });
  if (d.supervisor_id && d.supervisor_id !== a.t.supervisor_id) await E.notifyThesis(req.db, { ...a.t, supervisor_id: d.supervisor_id }, ['supervisor'], { title: 'New thesis supervision request', body: `${nameOf(a.t.student)}: ${d.title ?? a.t.title}` });
  res.json(await loadFull(req.db, a.t.id));
});

const done = async (req, res, t) => res.json(await loadFull(req.db, t.id));
const wrap = e => { if (e instanceof E.ThesisError) return e; throw e; };

router.post('/:id/accept', authorize('teacher'), async (req, res) => {
  const a = await access(req, res, req.params.id, ['supervisor']);
  if (!a) return;
  try {
    const { after } = await E.transition(req.db, req.user, a.t.id, 'accept', { note: clean(req.body.note, 1000), guard: async (tx, cur) => { await E.lockSupervisor(tx, req.user.teacher_id); await E.assertCapacity(tx, req.user.teacher_id, cur.id); } });
    await E.notifyThesis(req.db, after, ['student', 'officers'], { title: 'Supervisor accepted your thesis proposal', body: `${after.title}` });
    await done(req, res, after);
  } catch (e) { const x = wrap(e); fail(res, x.status, x.message); }
});
router.post('/:id/decline', authorize('teacher'), async (req, res) => {
  const a = await access(req, res, req.params.id, ['supervisor']);
  if (!a) return;
  const reason = clean(req.body.reason, 1000, { multiline: true });
  if (!reason) return fail(res, 422, 'A reason is required to decline');
  try {
    const { after } = await E.transition(req.db, req.user, a.t.id, 'decline', { note: reason, data: { supervisor_id: null }, before: { supervisor_id: a.t.supervisor_id } });
    await E.notifyThesis(req.db, after, ['student', 'officers'], { title: 'Supervisor declined your thesis proposal', body: `${after.title} — ${reason.slice(0, 200)}. Choose another supervisor.` });
    await done(req, res, after);
  } catch (e) { const x = wrap(e); fail(res, x.status, x.message); }
});
router.post('/:id/approve', officer, async (req, res) => {
  try {
    const { after } = await E.transition(req.db, req.user, req.params.id, 'approve', { note: clean(req.body.note, 1000, { multiline: true }), data: { decision_note: clean(req.body.note, 1000, { multiline: true }) } });
    await E.notifyThesis(req.db, after, ['student', 'supervisor', 'co_supervisor'], { title: 'Thesis topic approved', body: after.title });
    await done(req, res, after);
  } catch (e) { const x = wrap(e); fail(res, x.status, x.message); }
});
router.post('/:id/reject', officer, async (req, res) => {
  const note = clean(req.body.note, 1000, { multiline: true });
  if (!note) return fail(res, 422, 'A note is required to reject a proposal');
  try {
    const { after } = await E.transition(req.db, req.user, req.params.id, 'reject', { note, data: { decision_note: note } });
    await E.notifyThesis(req.db, after, ['student', 'supervisor'], { title: 'Thesis proposal rejected', body: `${after.title} — ${note.slice(0, 200)}` });
    await done(req, res, after);
  } catch (e) { const x = wrap(e); fail(res, x.status, x.message); }
});
router.post('/:id/start', authorize('teacher', 'super_admin', 'academic_officer'), async (req, res) => {
  const a = await access(req, res, req.params.id, ['supervisor', 'officer']);
  if (!a) return;
  try {
    const { after } = await E.transition(req.db, req.user, a.t.id, 'start');
    await E.notifyThesis(req.db, after, ['student'], { title: 'Your thesis work has started', body: after.title });
    await done(req, res, after);
  } catch (e) { const x = wrap(e); fail(res, x.status, x.message); }
});
router.post('/:id/withdraw', authorize('student'), async (req, res) => {
  const a = await access(req, res, req.params.id, ['student']);
  if (!a) return;
  try {
    const { after } = await E.transition(req.db, req.user, a.t.id, 'withdraw', { note: clean(req.body.reason, 1000, { multiline: true }) });
    await E.notifyThesis(req.db, after, ['supervisor', 'co_supervisor', 'officers'], { title: 'A thesis was withdrawn by the student', body: after.title });
    await done(req, res, after);
  } catch (e) { const x = wrap(e); fail(res, x.status, x.message); }
});
router.post('/:id/submit-final', authorize('student'), async (req, res) => {
  const a = await access(req, res, req.params.id, ['student']);
  if (!a) return;
  try {
    const { after } = await E.transition(req.db, req.user, a.t.id, 'submit_final', {
      note: clean(req.body.note, 1000, { multiline: true }),
      guard: async (tx, cur) => {
        const open = await tx.thesisMilestone.count({ where: { thesis_id: cur.id, status: { not: 'accepted' } } });
        if (open) throw new E.ThesisError(`${open} milestone(s) are not accepted yet — the final version can only be submitted once every milestone is accepted`, 409, 'milestones_open');
        if (!(await tx.thesisSubmission.count({ where: { thesis_id: cur.id } }))) throw new E.ThesisError('Upload your work before submitting the final version', 409, 'no_submission');
      },
    });
    await E.notifyThesis(req.db, after, ['supervisor', 'co_supervisor', 'officers'], { title: 'Final version submitted', body: after.title });
    await done(req, res, after);
  } catch (e) { const x = wrap(e); fail(res, x.status, x.message); }
});

router.post('/:id/assign', officer, async (req, res) => {
  const t = await req.db.thesis.findUnique({ where: { id: req.params.id } });
  if (!t) return fail(res, 404, 'Thesis not found');
  if (!E.OPEN.includes(t.status)) return fail(res, 409, `A ${t.status} thesis cannot be reassigned`);
  const b = req.body; const data = {};
  if (b.supervisor_id !== undefined) { const s = await teacherRow(req.db, b.supervisor_id); if (!s) return fail(res, 422, 'Unknown supervisor'); data.supervisor_id = s.id; }
  if (b.co_supervisor_id !== undefined) {
    if (b.co_supervisor_id === null || b.co_supervisor_id === '') data.co_supervisor_id = null;
    else { const s = await teacherRow(req.db, b.co_supervisor_id); if (!s) return fail(res, 422, 'Unknown co-supervisor'); data.co_supervisor_id = s.id; }
  }
  if (!Object.keys(data).length) return fail(res, 422, 'supervisor_id or co_supervisor_id is required');
  const sup = data.supervisor_id ?? t.supervisor_id, co = data.co_supervisor_id !== undefined ? data.co_supervisor_id : t.co_supervisor_id;
  if (sup && co && sup === co) return fail(res, 422, 'The supervisor and co-supervisor must be different lecturers');
  const note = clean(b.note, 1000, { multiline: true });
  const supChanged = data.supervisor_id && data.supervisor_id !== t.supervisor_id;
  try {
    const after = await req.db.$transaction(async tx => {
      if (supChanged) { await E.lockSupervisor(tx, data.supervisor_id); if (E.LOADED.includes(t.status)) await E.assertCapacity(tx, data.supervisor_id, t.id); }
      // a new supervisor must still accept a thesis that was only accepted by the previous one
      const to = supChanged && t.status === 'supervisor_accepted' ? 'proposed' : t.status;
      const r = await tx.thesis.updateMany({ where: { id: t.id, status: t.status }, data: { ...data, status: to, updated_at: new Date() } });
      if (!r.count) throw new E.ThesisError('The thesis was changed by someone else — reload and retry', 409);
      await E.addEvent(tx, t, { kind: 'assignment', from: t.status, to, body: note ?? 'Supervision changed', user: req.user });
      await audit(tx, E.actorOf(req.user), 'thesis.assign', 'thesis', t.id, { reason: note, before: { supervisor_id: t.supervisor_id, co_supervisor_id: t.co_supervisor_id, status: t.status }, after: { ...data, status: to } });
      return tx.thesis.findUnique({ where: { id: t.id } });
    });
    await E.notifyThesis(req.db, after, ['student', 'supervisor', 'co_supervisor'], { title: 'Thesis supervision updated', body: after.title });
    await done(req, res, after);
  } catch (e) { const x = wrap(e); fail(res, x.status, x.message); }
});

router.post('/:id/schedule-defence', officer, async (req, res) => {
  const b = req.body;
  let date, time, room, jury;
  try {
    date = dateStr(b.date, 'date'); if (!date) throw bad('date is required');
    if (date < today()) throw bad('The defence date cannot be in the past');
    time = clean(b.time, 5); if (!time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw bad('time must be HH:MM');
    room = clean(b.room, 100); if (!room) throw bad('room is required');
    if (b.jury !== undefined && !Array.isArray(b.jury)) throw bad('jury must be a list');
    jury = [];
    for (const j of (b.jury ?? []).slice(0, 12)) {
      const entry = { name: clean(j?.name, 120), role: clean(j?.role, 60) ?? 'member' };
      if (j?.teacher_id) { const tr = await teacherRow(req.db, j.teacher_id); if (!tr) throw bad('Unknown jury lecturer'); entry.teacher_id = tr.id; entry.name = entry.name ?? nameOf(tr); }
      if (!entry.name) throw bad('Each jury member needs a name');
      jury.push(entry);
    }
  } catch (e) { return fail(res, e.status || 422, e.message); }
  try {
    const { after } = await E.transition(req.db, req.user, req.params.id, 'schedule_defence', { data: { defence_date: date, defence_time: time, defence_room: room, jury }, note: `Defence ${date} ${time}, ${room}` });
    await E.notifyThesis(req.db, after, ['student', 'supervisor', 'co_supervisor', 'jury'], { title: 'Thesis defence scheduled', body: `${after.title} — ${date} ${time}, ${room}` });
    await done(req, res, after);
  } catch (e) { const x = wrap(e); fail(res, x.status, x.message); }
});
router.post('/:id/defended', officer, async (req, res) => {
  try {
    const { after } = await E.transition(req.db, req.user, req.params.id, 'defended', { note: clean(req.body.note, 1000, { multiline: true }) });
    await done(req, res, after);
  } catch (e) { const x = wrap(e); fail(res, x.status, x.message); }
});
router.post('/:id/result', officer, async (req, res) => {
  const score = Number(req.body.score); const grade = clean(req.body.grade, 10); const note = clean(req.body.note, 2000, { multiline: true });
  if (req.body.score === undefined || req.body.score === null || req.body.score === '' || !Number.isFinite(score) || score < 0 || score > 100) return fail(res, 422, 'score must be a number between 0 and 100');
  if (!grade) return fail(res, 422, 'grade is required');
  try {
    // the result may be recorded straight after a scheduled defence: pass through "defended" so history stays complete
    const cur = await req.db.thesis.findUnique({ where: { id: req.params.id } });
    if (cur?.status === 'defence_scheduled') await E.transition(req.db, req.user, cur.id, 'defended', { note: 'Defence held' });
    const { after } = await E.transition(req.db, req.user, req.params.id, 'result', { data: { final_score: score, final_grade: grade, decision_note: note }, note: `Result: ${score} (${grade})${note ? ` — ${note}` : ''}` });
    await E.notifyThesis(req.db, after, ['student', 'supervisor', 'co_supervisor'], { title: 'Thesis result recorded', body: `${after.title} — ${score} (${grade})` });
    await done(req, res, after);
  } catch (e) { const x = wrap(e); fail(res, x.status, x.message); }
});

router.post('/:id/comments', async (req, res) => {
  const a = await access(req, res, req.params.id, ['student', 'supervisor', 'co_supervisor', 'officer']);
  if (!a) return;
  const body = clean(req.body.body, 2000, { multiline: true });
  if (!body) return fail(res, 422, 'body is required');
  await E.addEvent(req.db, a.t, { kind: 'comment', body, user: req.user });
  const who = a.rel.has('student') ? ['supervisor', 'co_supervisor'] : ['student'];
  await E.notifyThesis(req.db, a.t, who, { title: 'New thesis comment', body: `${a.t.title}: ${body.slice(0, 150)}` });
  res.status(201).json({ ok: true });
});

// ── Milestones & submissions ─────────────────────────────────────────────────────
router.post('/:id/milestones', authorize('teacher', 'super_admin', 'academic_officer'), async (req, res) => {
  const a = await access(req, res, req.params.id, ['supervisor', 'co_supervisor', 'officer']);
  if (!a) return;
  if (!['approved', 'in_progress'].includes(a.t.status)) return fail(res, 409, 'Milestones can only be defined once the topic is approved and before the final submission');
  const title = clean(req.body.title, 200);
  if (!title) return fail(res, 422, 'title is required');
  const due = dateStr(req.body.due_date, 'due_date') ?? null;
  let position = req.body.position;
  if (position === undefined) position = ((await req.db.thesisMilestone.aggregate({ where: { thesis_id: a.t.id }, _max: { position: true } }))._max.position ?? 0) + 1;
  position = Number(position);
  if (!Number.isInteger(position) || position < 0 || position > 1000) return fail(res, 422, 'position must be a whole number');
  const m = await req.db.thesisMilestone.create({ data: { id: uuid(), thesis_id: a.t.id, title, due_date: due, position } });
  await E.notifyThesis(req.db, a.t, ['student'], { title: 'New thesis milestone', body: `${title}${due ? ` — due ${due}` : ''}` });
  res.status(201).json(msView(m));
});

router.post('/:id/submissions', authorize('student'), uploadSingle('file'), async (req, res) => {
  const a = await access(req, res, req.params.id, ['student']);
  if (!a) return;
  if (a.t.status !== 'in_progress') return fail(res, 409, 'You can upload work only while the thesis is in progress');
  if (!req.file) return fail(res, 422, 'A file is required');
  const note = clean(req.body.note, 2000, { multiline: true });
  const mid = req.body.milestone_id ? String(req.body.milestone_id) : null;
  const ext = extOf(req.file.originalname);
  try {
    const row = await req.db.$transaction(async tx => {
      await E.lockKey(tx, 'thesis-up:' + a.t.id);
      if (mid) {
        const m = await tx.thesisMilestone.findFirst({ where: { id: mid, thesis_id: a.t.id } });
        if (!m) throw new E.ThesisError('Unknown milestone for this thesis', 422);
        if (m.status === 'accepted') throw new E.ThesisError('This milestone is already accepted', 409);
        await tx.thesisMilestone.update({ where: { id: m.id }, data: { status: 'submitted', updated_at: new Date() } });
      }
      const last = await tx.thesisSubmission.aggregate({ where: { thesis_id: a.t.id, milestone_id: mid }, _max: { version: true } });
      const s = await tx.thesisSubmission.create({
        data: { id: uuid(), thesis_id: a.t.id, milestone_id: mid, version: (last._max.version ?? 0) + 1, note, file_name: req.file.originalname.replace(/[\u0000-\u001F\\/]/g, '_').slice(0, 200), file_mime: TYPES[ext] ?? 'application/octet-stream', file_size: req.file.size, file_data: req.file.buffer },
        select: SUB_SELECT,
      });
      await E.addEvent(tx, a.t, { kind: 'comment', body: `Uploaded ${s.file_name} (v${s.version})`, user: req.user });
      return s;
    });
    await E.notifyThesis(req.db, a.t, ['supervisor', 'co_supervisor'], { title: 'New thesis submission to review', body: `${a.t.title} — ${row.file_name} (v${row.version})` });
    res.status(201).json(subView(row));
  } catch (e) { const x = wrap(e); fail(res, x.status, x.message); }
});

module.exports = router;
