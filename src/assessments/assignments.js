// Assignments: lecturer builds/grades, students on the roster submit. Mounted at /api/assessments/assignments.
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const { uploadSingle, TYPES, INLINE_OK, extOf } = require('../utils/elearningUploads');
const { notifyUsers, safe } = require('../utils/notify');
const { audit } = require('../academics/registration');
const C = require('./common');
const { AErr, isStaff, actorOf, str } = C;

const SUB_PUBLIC = { id: true, assignment_id: true, student_id: true, text: true, file_name: true, file_mime: true, file_size: true, submitted_at: true, is_late: true, status: true, score: true, feedback: true, graded_by: true, graded_at: true };
const MAX_TEXT = 20000;

const view = (a, extra = {}) => ({ id: a.id, offering_id: a.offering_id, title: a.title, instructions: a.instructions, due_at: a.due_at, max_score: a.max_score, weight: a.weight, allow_late: a.allow_late, allow_text: a.allow_text, allow_file: a.allow_file, status: a.status, created_at: a.created_at, updated_at: a.updated_at, ...extra });
const subView = s => ({ ...s, has_file: !!s.file_name });

function parse(b, existing) {
  const d = {};
  if (!existing || b.title !== undefined) { d.title = str(b.title); if (!d.title) throw new AErr('Title is required'); if (d.title.length > 200) throw new AErr('Title is too long (max 200)'); }
  if (b.instructions !== undefined) { d.instructions = str(b.instructions) || null; if (d.instructions && d.instructions.length > 10000) throw new AErr('Instructions are too long'); }
  if (!existing || b.due_at !== undefined) d.due_at = C.parseDate(b.due_at, 'Due date', { required: true });
  if (!existing || b.max_score !== undefined) d.max_score = b.max_score === undefined ? 20 : C.num(b.max_score, 'Maximum score', { min: 0, exclusiveMin: true, max: 1000 });
  if (!existing || b.weight !== undefined) d.weight = b.weight === undefined ? 1 : C.num(b.weight, 'Weight', { min: 0, exclusiveMin: true, max: 1000 });
  for (const k of ['allow_late', 'allow_text', 'allow_file']) if (b[k] !== undefined) d[k] = !!b[k];
  const text = d.allow_text ?? existing?.allow_text ?? true, file = d.allow_file ?? existing?.allow_file ?? true;
  if (!text && !file) throw new AErr('Allow at least one of text or file submission');
  return d;
}

async function load(req, id) {
  const a = await req.db.assignment.findUnique({ where: { id: String(id) } });
  if (!a) throw new AErr('Assignment not found', 404);
  return a;
}
/** Resolves who the caller is relative to the assignment: 'owner'|'staff'|'student'. Students must be on the roster and see only non-draft. */
async function access(req, a, { manage = false } = {}) {
  const o = await C.getOffering(req.db, a.offering_id);
  if (req.user.role === 'student') {
    if (manage) throw new AErr('Forbidden', 403);
    if (!(await C.onRoster(req.db, req.user.student_id, o.id))) throw new AErr('You are not registered for this course', 403);
    if (a.status === 'draft') throw new AErr('Assignment not found', 404);
    return { role: 'student', offering: o };
  }
  return { role: C.manageAccess(req.user, o), offering: o };
}

// ── list (role-aware) ──────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { offering_id, term_id } = req.query;
  const where = {};
  if (offering_id) where.offering_id = String(offering_id);
  if (term_id) where.offering = { term_id: String(term_id) };
  if (req.user.role === 'student') {
    const mine = await C.offeringIdsOfStudent(req.db, req.user.student_id);
    where.offering_id = offering_id ? (mine.includes(String(offering_id)) ? String(offering_id) : '-') : { in: mine };
    where.status = { in: ['published', 'closed'] };
    const rows = await req.db.assignment.findMany({ where, orderBy: { due_at: 'asc' }, include: { offering: { include: C.offeringInclude } } });
    const subs = await req.db.assignmentSubmission.findMany({ where: { student_id: req.user.student_id, assignment_id: { in: rows.map(r => r.id) } }, select: SUB_PUBLIC });
    const by = new Map(subs.map(s => [s.assignment_id, s]));
    return res.json(rows.map(a => view(a, { offering: C.offeringInfo(a.offering), submission: by.has(a.id) ? subView(by.get(a.id)) : null })));
  }
  if (req.user.role === 'teacher') { if (!req.user.teacher_id) throw new AErr('Forbidden', 403); where.offering = { ...(where.offering ?? {}), teacher_id: req.user.teacher_id }; }
  else if (!isStaff(req.user)) throw new AErr('Forbidden', 403);
  const rows = await req.db.assignment.findMany({ where, orderBy: [{ due_at: 'desc' }], include: { offering: { include: C.offeringInclude }, _count: { select: { submissions: true } } } });
  const graded = await req.db.assignmentSubmission.groupBy({ by: ['assignment_id'], where: { assignment_id: { in: rows.map(r => r.id) }, status: { in: ['graded', 'returned'] } }, _count: { _all: true } });
  const g = new Map(graded.map(x => [x.assignment_id, x._count._all]));
  res.json(rows.map(a => view(a, { offering: C.offeringInfo(a.offering), submission_count: a._count.submissions, graded_count: g.get(a.id) ?? 0 })));
});

router.post('/', async (req, res) => {
  const o = await C.getOffering(req.db, req.body.offering_id);
  if (req.user.role !== 'teacher') throw new AErr('Only the course lecturer can create assignments', 403);
  C.manageAccess(req.user, o);
  const d = parse(req.body);
  const row = await req.db.assignment.create({ data: { id: uuid(), offering_id: o.id, ...d, status: 'draft', created_by: req.user.id } });
  await audit(req.db, actorOf(req.user), 'assignment.create', 'assignment', row.id, { after: { title: row.title, offering_id: o.id } });
  res.status(201).json(view(row));
});

router.get('/:id', async (req, res) => {
  const a = await load(req, req.params.id);
  const { role, offering } = await access(req, a);
  if (role === 'student') {
    const s = await req.db.assignmentSubmission.findUnique({ where: { assignment_id_student_id: { assignment_id: a.id, student_id: req.user.student_id } }, select: SUB_PUBLIC });
    return res.json(view(a, { offering: C.offeringInfo(offering), submission: s ? subView(s) : null, now: new Date() }));
  }
  const [n, g] = await Promise.all([req.db.assignmentSubmission.count({ where: { assignment_id: a.id } }), req.db.assignmentSubmission.count({ where: { assignment_id: a.id, status: { in: ['graded', 'returned'] } } })]);
  res.json(view(a, { offering: C.offeringInfo(offering), submission_count: n, graded_count: g }));
});

router.put('/:id', async (req, res) => {
  const a = await load(req, req.params.id);
  const { role } = await access(req, a, { manage: true });
  if (role !== 'owner') throw new AErr('Only the course lecturer can edit assignments', 403);
  const d = parse(req.body, a);
  const [n, g] = await Promise.all([req.db.assignmentSubmission.count({ where: { assignment_id: a.id } }), req.db.assignmentSubmission.count({ where: { assignment_id: a.id, status: { in: ['graded', 'returned'] } } })]);
  if (g && d.max_score !== undefined && d.max_score !== a.max_score) throw new AErr('The maximum score cannot change once submissions have been graded', 409);
  if (n && ((d.allow_text !== undefined && d.allow_text !== a.allow_text) || (d.allow_file !== undefined && d.allow_file !== a.allow_file))) throw new AErr('Submission types cannot change once students have submitted', 409);
  const row = await req.db.assignment.update({ where: { id: a.id }, data: { ...d, updated_at: new Date() } });
  await audit(req.db, actorOf(req.user), 'assignment.update', 'assignment', a.id, { before: { title: a.title, due_at: a.due_at, max_score: a.max_score, weight: a.weight }, after: { title: row.title, due_at: row.due_at, max_score: row.max_score, weight: row.weight } });
  res.json(view(row));
});

router.delete('/:id', async (req, res) => {
  const a = await load(req, req.params.id);
  const { role } = await access(req, a, { manage: true });
  if (role !== 'owner') throw new AErr('Only the course lecturer can delete assignments', 403);
  const n = await req.db.assignmentSubmission.count({ where: { assignment_id: a.id } });
  if (n) throw new AErr(`This assignment already has ${n} submission(s). Close it instead of deleting it.`, 409, 'has_submissions');
  await req.db.assignment.deleteMany({ where: { id: a.id } });
  await audit(req.db, actorOf(req.user), 'assignment.delete', 'assignment', a.id, { before: { title: a.title } });
  res.status(204).end();
});

const FLOW = { draft: ['published'], published: ['closed', 'draft'], closed: ['published'] };
router.post('/:id/status', async (req, res) => {
  const a = await load(req, req.params.id);
  const { role, offering } = await access(req, a, { manage: true });
  if (role !== 'owner') throw new AErr('Only the course lecturer can change the status', 403);
  const to = req.body.status;
  if (!['draft', 'published', 'closed'].includes(to)) throw new AErr('status must be draft, published or closed');
  if (!FLOW[a.status].includes(to)) throw new AErr(`Cannot go from ${a.status} to ${to}`, 409);
  if (to === 'draft' && (await req.db.assignmentSubmission.count({ where: { assignment_id: a.id } }))) throw new AErr('Students have already submitted: close the assignment instead', 409, 'has_submissions');
  const upd = await req.db.assignment.updateMany({ where: { id: a.id, status: a.status }, data: { status: to, updated_at: new Date() } });
  if (!upd.count) throw new AErr('The assignment was changed by someone else, reload and retry', 409);
  await audit(req.db, actorOf(req.user), `assignment.${to}`, 'assignment', a.id, { before: { status: a.status }, after: { status: to } });
  if (to === 'published' && a.status === 'draft') {
    await safe(async () => notifyUsers(req.db, await C.studentUserIds(req.db, await C.rosterStudentIds(req.db, a.offering_id)), { type: 'assignment_published', title: `New assignment: ${a.title}`, body: `${offering.subject.name} — due ${a.due_at.toISOString().slice(0, 16).replace('T', ' ')} UTC`, link: '/student/assessments' }));
  }
  res.json(view(await req.db.assignment.findUnique({ where: { id: a.id } })));
});

// ── submissions: lecturer side ─────────────────────────────────────────────────────
router.get('/:id/submissions', async (req, res) => {
  const a = await load(req, req.params.id);
  await access(req, a, { manage: true });
  const [roster, subs] = await Promise.all([C.rosterStudents(req.db, a.offering_id), req.db.assignmentSubmission.findMany({ where: { assignment_id: a.id }, select: SUB_PUBLIC, orderBy: { submitted_at: 'asc' } })]);
  const by = new Map(subs.map(s => [s.student_id, s]));
  const students = roster.map(s => ({ student_id: s.id, name: C.sName(s), matricule: s.student_number, submission: by.has(s.id) ? subView(by.get(s.id)) : null }));
  // students who submitted then dropped the course stay visible to the lecturer
  const rosterIds = new Set(roster.map(r => r.id));
  const extra = subs.filter(s => !rosterIds.has(s.student_id));
  if (extra.length) {
    const st = await req.db.student.findMany({ where: { id: { in: extra.map(s => s.student_id) } } });
    for (const s of st) students.push({ student_id: s.id, name: `${C.sName(s)} (not on roster)`, matricule: s.student_number, submission: subView(by.get(s.id)) });
  }
  res.json({ assignment: view(a), students });
});

router.post('/:id/submissions/:sid/grade', async (req, res) => {
  const a = await load(req, req.params.id);
  const { role, offering } = await access(req, a, { manage: true });
  const sub = await req.db.assignmentSubmission.findFirst({ where: { id: req.params.sid, assignment_id: a.id }, select: SUB_PUBLIC });
  if (!sub) throw new AErr('Submission not found', 404);
  const score = C.num(req.body.score, 'Score', { min: 0, max: a.max_score });
  const status = req.body.status === undefined ? 'graded' : req.body.status;
  if (!['graded', 'returned'].includes(status)) throw new AErr('status must be graded or returned');
  const feedback = str(req.body.feedback) || null;
  if (feedback && feedback.length > 5000) throw new AErr('Feedback is too long');
  const actor = actorOf(req.user);
  await req.db.assignmentSubmission.update({ where: { id: sub.id }, data: { score, feedback, status, graded_by: actor.id, graded_at: new Date() } });
  await audit(req.db, actor, 'assignment.grade', 'assignment_submission', sub.id, { before: { score: sub.score, status: sub.status }, after: { score, status } });
  void role;
  const wasGraded = sub.status !== 'submitted';
  await safe(async () => notifyUsers(req.db, await C.studentUserIds(req.db, [sub.student_id]), { type: 'assignment_graded', title: `${status === 'returned' ? 'Returned' : 'Graded'}: ${a.title}`, body: `${offering.subject.name} — ${score}/${a.max_score}${wasGraded ? ' (updated)' : ''}`, link: '/student/assessments' }));
  res.json(subView(await req.db.assignmentSubmission.findUnique({ where: { id: sub.id }, select: SUB_PUBLIC })));
});

// ── submissions: student side ──────────────────────────────────────────────────────
router.post('/:id/submit', uploadSingle('file'), async (req, res) => {
  if (req.user.role !== 'student') throw new AErr('Only students can submit', 403);
  const a = await load(req, req.params.id);
  const { offering } = await access(req, a);
  if (a.status !== 'published') throw new AErr('This assignment is closed', 409, 'closed');
  const now = new Date();
  const late = now > a.due_at;
  if (late && !a.allow_late) throw new AErr('The deadline has passed and late submissions are not allowed', 409, 'past_due');
  const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
  const file = req.file;
  if (text && !a.allow_text) throw new AErr('Text answers are not accepted for this assignment');
  if (file && !a.allow_file) throw new AErr('File uploads are not accepted for this assignment');
  if (!text && !file) throw new AErr('Your submission is empty: write an answer or attach a file');
  if (text.length > MAX_TEXT) throw new AErr(`Text answer too long (max ${MAX_TEXT} characters)`);
  if (file && !file.size) throw new AErr('The uploaded file is empty');
  const ext = file ? extOf(file.originalname) : '';
  const data = {
    text: text || null, file_name: file ? file.originalname.slice(0, 200) : null, file_mime: file ? TYPES[ext] ?? 'application/octet-stream' : null, file_size: file ? file.size : null, file_data: file ? file.buffer : null,
    submitted_at: now, is_late: late,
  };
  const key = { assignment_id_student_id: { assignment_id: a.id, student_id: req.user.student_id } };
  let resubmitted = false;
  for (let i = 0; i < 3; i++) {
    const cur = await req.db.assignmentSubmission.findUnique({ where: key, select: { id: true, status: true } });
    if (cur) {
      if (cur.status !== 'submitted') throw new AErr('Your work has already been graded and can no longer be replaced', 409, 'already_graded');
      const upd = await req.db.assignmentSubmission.updateMany({ where: { id: cur.id, status: 'submitted' }, data });   // compare-and-set: a grade in between wins
      if (!upd.count) throw new AErr('Your work has already been graded and can no longer be replaced', 409, 'already_graded');
      resubmitted = true; break;
    }
    try { await req.db.assignmentSubmission.create({ data: { id: uuid(), assignment_id: a.id, student_id: req.user.student_id, ...data } }); break; }
    catch (e) { if (e.code !== 'P2002' || i === 2) throw e; }
  }
  await safe(async () => notifyUsers(req.db, await C.teacherUsers(req.db, offering.teacher_id), { type: 'assignment_submitted', title: `${resubmitted ? 'Resubmission' : 'New submission'}: ${a.title}`, body: `${req.user.name}${late ? ' (late)' : ''} — ${offering.subject.name}`, link: '/teacher/assessments' }));
  const s = await req.db.assignmentSubmission.findUnique({ where: key, select: SUB_PUBLIC });
  res.status(resubmitted ? 200 : 201).json(subView(s));
});

// ── files ──────────────────────────────────────────────────────────────────────────
router.get('/:id/submissions/:sid/file', async (req, res) => {
  const a = await load(req, req.params.id);
  const sub = await req.db.assignmentSubmission.findFirst({ where: { id: req.params.sid, assignment_id: a.id } });
  if (!sub || !sub.file_data) throw new AErr('File not found', 404);
  if (req.user.role === 'student') { if (sub.student_id !== req.user.student_id) throw new AErr('File not found', 404); } else await access(req, a, { manage: true });
  const ext = extOf(sub.file_name || '');
  const inline = req.query.inline === '1' && INLINE_OK.has(ext);
  res.setHeader('Content-Type', TYPES[ext] || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; media-src 'self'; img-src 'self' data:");
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(sub.file_name || 'submission')}`);
  res.setHeader('Content-Length', sub.file_data.length);
  res.end(Buffer.from(sub.file_data));
});

module.exports = router;
