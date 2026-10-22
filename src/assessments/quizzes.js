// Quizzes: lecturer builds, students attempt under a server-enforced window/deadline. Mounted at /api/assessments/quizzes.
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const { notifyUsers, safe } = require('../utils/notify');
const { audit } = require('../academics/registration');
const C = require('./common');
const Q = require('./quiz');
const { AErr, isStaff, actorOf, str } = C;

const quizView = (q, extra = {}) => ({ id: q.id, offering_id: q.offering_id, title: q.title, instructions: q.instructions, opens_at: q.opens_at, closes_at: q.closes_at, duration_minutes: q.duration_minutes, max_attempts: q.max_attempts, shuffle: q.shuffle, show_answers: q.show_answers, weight: q.weight, status: q.status, created_at: q.created_at, updated_at: q.updated_at, ...extra });

function parse(b, existing) {
  const d = {};
  if (!existing || b.title !== undefined) { d.title = str(b.title); if (!d.title) throw new AErr('Title is required'); if (d.title.length > 200) throw new AErr('Title is too long (max 200)'); }
  if (b.instructions !== undefined) d.instructions = str(b.instructions) || null;
  if (b.opens_at !== undefined) d.opens_at = C.parseDate(b.opens_at, 'Opening date');
  if (b.closes_at !== undefined) d.closes_at = C.parseDate(b.closes_at, 'Closing date');
  const opens = d.opens_at !== undefined ? d.opens_at : existing?.opens_at, closes = d.closes_at !== undefined ? d.closes_at : existing?.closes_at;
  if (opens && closes && closes <= opens) throw new AErr('The quiz must close after it opens');
  if (b.duration_minutes !== undefined) {
    if (b.duration_minutes === null || b.duration_minutes === '') d.duration_minutes = null;
    else { const n = Number(b.duration_minutes); if (!Number.isInteger(n) || n < 1 || n > 600) throw new AErr('Duration must be a whole number of minutes between 1 and 600'); d.duration_minutes = n; }
  }
  if (b.max_attempts !== undefined || !existing) { const n = b.max_attempts === undefined ? 1 : Number(b.max_attempts); if (!Number.isInteger(n) || n < 1 || n > 20) throw new AErr('Attempts must be a whole number between 1 and 20'); d.max_attempts = n; }
  if (b.weight !== undefined || !existing) d.weight = b.weight === undefined ? 1 : C.num(b.weight, 'Weight', { min: 0, exclusiveMin: true, max: 1000 });
  for (const k of ['shuffle', 'show_answers']) if (b[k] !== undefined) d[k] = !!b[k];
  return d;
}

async function load(req, id) {
  const q = await req.db.quiz.findUnique({ where: { id: String(id) } });
  if (!q) throw new AErr('Quiz not found', 404);
  return q;
}
async function access(req, q, { manage = false } = {}) {
  const o = await C.getOffering(req.db, q.offering_id);
  if (req.user.role === 'student') {
    if (manage) throw new AErr('Forbidden', 403);
    if (!(await C.onRoster(req.db, req.user.student_id, o.id))) throw new AErr('You are not registered for this course', 403);
    if (q.status === 'draft') throw new AErr('Quiz not found', 404);
    return { role: 'student', offering: o };
  }
  return { role: C.manageAccess(req.user, o), offering: o };
}
const ownerOnly = (role, what = 'edit quizzes') => { if (role !== 'owner') throw new AErr(`Only the course lecturer can ${what}`, 403); };
const questionsOf = (db, quizId) => db.quizQuestion.findMany({ where: { quiz_id: quizId }, orderBy: [{ position: 'asc' }, { id: 'asc' }] });
const hasAttempts = (db, quizId) => db.quizAttempt.count({ where: { quiz_id: quizId } });

/** Auto-submit every in-progress attempt whose server deadline has passed (cheap; run on access). */
async function sweep(db, quiz, where = {}) {
  const now = new Date();
  const stale = await db.quizAttempt.findMany({ where: { quiz_id: quiz.id, status: 'in_progress', deadline_at: { lte: now }, ...where } });
  if (!stale.length) return;
  const qs = await questionsOf(db, quiz.id);
  for (const a of stale) await Q.finalizeAttempt(db, quiz, a, qs, { now, auto: true });
}

// ── list ───────────────────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { offering_id, term_id } = req.query;
  const where = {};
  if (offering_id) where.offering_id = String(offering_id);
  if (term_id) where.offering = { term_id: String(term_id) };
  if (req.user.role === 'student') {
    const mine = await C.offeringIdsOfStudent(req.db, req.user.student_id);
    where.offering_id = offering_id ? (mine.includes(String(offering_id)) ? String(offering_id) : '-') : { in: mine };
    where.status = { in: ['published', 'closed'] };
    const rows = await req.db.quiz.findMany({ where, orderBy: { created_at: 'desc' }, include: { offering: { include: C.offeringInclude }, _count: { select: { questions: true } } } });
    for (const q of rows) await sweep(req.db, q, { student_id: req.user.student_id });
    const atts = await req.db.quizAttempt.findMany({ where: { student_id: req.user.student_id, quiz_id: { in: rows.map(r => r.id) } }, orderBy: { attempt_no: 'asc' } });
    return res.json(rows.map(q => quizView(q, { offering: C.offeringInfo(q.offering), question_count: q._count.questions, attempts: atts.filter(a => a.quiz_id === q.id).map(Q.attemptSummary) })));
  }
  if (req.user.role === 'teacher') { if (!req.user.teacher_id) throw new AErr('Forbidden', 403); where.offering = { ...(where.offering ?? {}), teacher_id: req.user.teacher_id }; }
  else if (!isStaff(req.user)) throw new AErr('Forbidden', 403);
  const rows = await req.db.quiz.findMany({ where, orderBy: { created_at: 'desc' }, include: { offering: { include: C.offeringInclude }, _count: { select: { questions: true, attempts: true } } } });
  res.json(rows.map(q => quizView(q, { offering: C.offeringInfo(q.offering), question_count: q._count.questions, attempt_count: q._count.attempts })));
});

router.post('/', async (req, res) => {
  const o = await C.getOffering(req.db, req.body.offering_id);
  if (req.user.role !== 'teacher') throw new AErr('Only the course lecturer can create quizzes', 403);
  C.manageAccess(req.user, o);
  const d = parse(req.body);
  const row = await req.db.quiz.create({ data: { id: uuid(), offering_id: o.id, ...d, status: 'draft', created_by: req.user.id } });
  await audit(req.db, actorOf(req.user), 'quiz.create', 'quiz', row.id, { after: { title: row.title, offering_id: o.id } });
  res.status(201).json(quizView(row));
});

router.get('/:id', async (req, res) => {
  const q = await load(req, req.params.id);
  const { role, offering } = await access(req, q);
  if (role === 'student') {
    await sweep(req.db, q, { student_id: req.user.student_id });
    const [atts, n] = await Promise.all([req.db.quizAttempt.findMany({ where: { quiz_id: q.id, student_id: req.user.student_id }, orderBy: { attempt_no: 'asc' } }), req.db.quizQuestion.count({ where: { quiz_id: q.id } })]);
    const now = new Date();
    return res.json(quizView(q, { offering: C.offeringInfo(offering), question_count: n, attempts: atts.map(Q.attemptSummary), now, answers_visible: Q.canReveal(q, now) && atts.some(Q.isFinished) }));
  }
  const qs = await questionsOf(req.db, q.id);
  res.json(quizView(q, { offering: C.offeringInfo(offering), questions: qs.map(x => ({ id: x.id, position: x.position, type: x.type, text: x.text, options: x.options, answer: x.answer, points: x.points, explanation: x.explanation })), attempt_count: await hasAttempts(req.db, q.id) }));
});

router.put('/:id', async (req, res) => {
  const q = await load(req, req.params.id);
  ownerOnly((await access(req, q, { manage: true })).role);
  const d = parse(req.body, q);
  const row = await req.db.quiz.update({ where: { id: q.id }, data: { ...d, updated_at: new Date() } });
  // a closing time moved earlier also ends attempts already running
  if (row.closes_at) await req.db.quizAttempt.updateMany({ where: { quiz_id: q.id, status: 'in_progress', OR: [{ deadline_at: null }, { deadline_at: { gt: row.closes_at } }] }, data: { deadline_at: row.closes_at } });
  await audit(req.db, actorOf(req.user), 'quiz.update', 'quiz', q.id, { before: { title: q.title, opens_at: q.opens_at, closes_at: q.closes_at, max_attempts: q.max_attempts }, after: { title: row.title, opens_at: row.opens_at, closes_at: row.closes_at, max_attempts: row.max_attempts } });
  res.json(quizView(row));
});

router.delete('/:id', async (req, res) => {
  const q = await load(req, req.params.id);
  ownerOnly((await access(req, q, { manage: true })).role, 'delete quizzes');
  const n = await hasAttempts(req.db, q.id);
  if (n) throw new AErr(`Students have already made ${n} attempt(s). Close the quiz instead of deleting it.`, 409, 'has_attempts');
  await req.db.quiz.deleteMany({ where: { id: q.id } });
  await audit(req.db, actorOf(req.user), 'quiz.delete', 'quiz', q.id, { before: { title: q.title } });
  res.status(204).end();
});

const FLOW = { draft: ['published'], published: ['closed', 'draft'], closed: ['published'] };
router.post('/:id/status', async (req, res) => {
  const q = await load(req, req.params.id);
  const { role, offering } = await access(req, q, { manage: true });
  ownerOnly(role, 'change the status');
  const to = req.body.status;
  if (!['draft', 'published', 'closed'].includes(to)) throw new AErr('status must be draft, published or closed');
  if (!FLOW[q.status].includes(to)) throw new AErr(`Cannot go from ${q.status} to ${to}`, 409);
  if (to === 'published' && !(await req.db.quizQuestion.count({ where: { quiz_id: q.id } }))) throw new AErr('Add at least one question before publishing', 422, 'no_questions');
  if (to === 'draft' && (await hasAttempts(req.db, q.id))) throw new AErr('Students have already made attempts: close the quiz instead', 409, 'has_attempts');
  const upd = await req.db.quiz.updateMany({ where: { id: q.id, status: q.status }, data: { status: to, updated_at: new Date() } });
  if (!upd.count) throw new AErr('The quiz was changed by someone else, reload and retry', 409);
  if (to === 'closed') await req.db.quizAttempt.updateMany({ where: { quiz_id: q.id, status: 'in_progress', OR: [{ deadline_at: null }, { deadline_at: { gt: new Date() } }] }, data: { deadline_at: new Date() } });
  await audit(req.db, actorOf(req.user), `quiz.${to}`, 'quiz', q.id, { before: { status: q.status }, after: { status: to } });
  if (to === 'published' && q.status === 'draft') {
    await safe(async () => notifyUsers(req.db, await C.studentUserIds(req.db, await C.rosterStudentIds(req.db, q.offering_id)), { type: 'quiz_published', title: `New quiz: ${q.title}`, body: `${offering.subject.name}${q.closes_at ? ` — closes ${q.closes_at.toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}`, link: '/student/assessments' }));
  }
  res.json(quizView(await req.db.quiz.findUnique({ where: { id: q.id } })));
});

// ── questions (lecturer) ───────────────────────────────────────────────────────────
async function editableQuiz(req) {
  const q = await load(req, req.params.id);
  ownerOnly((await access(req, q, { manage: true })).role);
  if (await hasAttempts(req.db, q.id)) throw new AErr('Students have already attempted this quiz: its questions can no longer change', 409, 'has_attempts');
  return q;
}
router.post('/:id/questions', async (req, res) => {
  const q = await editableQuiz(req);
  const d = Q.validateQuestion(req.body);
  const last = await req.db.quizQuestion.aggregate({ where: { quiz_id: q.id }, _max: { position: true }, _count: true });
  if (last._count >= 200) throw new AErr('A quiz is limited to 200 questions');
  const row = await req.db.quizQuestion.create({ data: { id: uuid(), quiz_id: q.id, position: (last._max.position ?? -1) + 1, ...d } });
  res.status(201).json(row);
});
router.put('/:id/questions/reorder', async (req, res) => {
  const q = await load(req, req.params.id);
  ownerOnly((await access(req, q, { manage: true })).role);
  const qs = await questionsOf(req.db, q.id);
  const ids = req.body.ids;
  if (!Array.isArray(ids) || ids.length !== qs.length || new Set(ids).size !== ids.length || ids.some(i => !qs.find(x => x.id === i))) throw new AErr('ids must list every question of the quiz exactly once');
  await req.db.$transaction(ids.map((id, i) => req.db.quizQuestion.update({ where: { id }, data: { position: i } })));
  res.json(await questionsOf(req.db, q.id));
});
router.put('/:id/questions/:qid', async (req, res) => {
  const q = await editableQuiz(req);
  const cur = await req.db.quizQuestion.findFirst({ where: { id: req.params.qid, quiz_id: q.id } });
  if (!cur) throw new AErr('Question not found', 404);
  const d = Q.validateQuestion({ type: cur.type, ...req.body });
  res.json(await req.db.quizQuestion.update({ where: { id: cur.id }, data: d }));
});
router.delete('/:id/questions/:qid', async (req, res) => {
  const q = await editableQuiz(req);
  const r = await req.db.quizQuestion.deleteMany({ where: { id: req.params.qid, quiz_id: q.id } });
  if (!r.count) throw new AErr('Question not found', 404);
  if (q.status === 'published' && !(await req.db.quizQuestion.count({ where: { quiz_id: q.id } }))) await req.db.quiz.update({ where: { id: q.id }, data: { status: 'draft' } });
  res.status(204).end();
});

// ── attempts: student ──────────────────────────────────────────────────────────────
function studentAttemptView(quiz, attempt, questions, now = new Date()) {
  const base = { ...Q.attemptSummary(attempt), server_now: now, quiz: { id: quiz.id, title: quiz.title, instructions: quiz.instructions, duration_minutes: quiz.duration_minutes, closes_at: quiz.closes_at, show_answers: quiz.show_answers } };
  if (attempt.status === 'in_progress') {
    const order = Array.isArray(attempt.question_order) ? attempt.question_order : questions.map(q => q.id);
    const by = new Map(questions.map(q => [q.id, q]));
    return { ...base, questions: order.map(id => by.get(id)).filter(Boolean).map(Q.publicQuestion), responses: attempt.answers?.responses ?? {} };
  }
  const reveal = Q.canReveal(quiz, now);
  const order = Array.isArray(attempt.question_order) ? attempt.question_order : questions.map(q => q.id);
  const by = new Map(questions.map(q => [q.id, q]));
  const ordered = order.map(id => by.get(id)).filter(Boolean);
  const responses = attempt.answers?.responses ?? {};
  return {
    ...base, answers_visible: reveal, responses,
    questions: ordered.map(q => reveal ? { ...Q.reviewQuestion(q), correct: !!attempt.answers?.graded?.[q.id]?.correct, awarded: attempt.answers?.graded?.[q.id]?.points ?? 0 } : Q.publicQuestion(q)),
    override_note: attempt.answers?.override?.note ?? null,
  };
}

async function loadAttempt(req, quiz) {
  const a = await req.db.quizAttempt.findFirst({ where: { id: req.params.aid, quiz_id: quiz.id, student_id: req.user.student_id } });
  if (!a) throw new AErr('Attempt not found', 404);
  return a;
}
const studentOnly = req => { if (req.user.role !== 'student' || !req.user.student_id) throw new AErr('Only students take quizzes', 403); };

router.post('/:id/attempts', async (req, res) => {
  studentOnly(req);
  const q = await load(req, req.params.id);
  await access(req, q);
  const sid = req.user.student_id;
  await sweep(req.db, q, { student_id: sid });
  if (q.status !== 'published') throw new AErr('This quiz is not open', 409, 'closed');
  const now = new Date();
  if (q.opens_at && now < q.opens_at) throw new AErr('This quiz has not opened yet', 409, 'not_open');
  if (q.closes_at && now >= q.closes_at) throw new AErr('This quiz has closed', 409, 'closed');
  const questions = await questionsOf(req.db, q.id);
  if (!questions.length) throw new AErr('This quiz has no questions', 409);
  let attempt = null, resumed = false;
  for (let i = 0; i < 4 && !attempt; i++) {
    const existing = await req.db.quizAttempt.findMany({ where: { quiz_id: q.id, student_id: sid }, orderBy: { attempt_no: 'desc' } });
    const open = existing.find(a => a.status === 'in_progress');
    if (open) { attempt = open; resumed = true; break; }
    if (existing.length >= q.max_attempts) throw new AErr(`You have used all ${q.max_attempts} attempt(s)`, 409, 'no_attempts_left');
    const deadline = [q.duration_minutes ? new Date(now.getTime() + q.duration_minutes * 60000) : null, q.closes_at].filter(Boolean).sort((a, b) => a - b)[0] ?? null;
    const order = q.shuffle ? Q.shuffled(questions.map(x => x.id)) : questions.map(x => x.id);
    try {
      // (quiz_id, student_id, attempt_no) is unique: of two concurrent starts exactly one insert wins, the other re-reads and resumes it.
      attempt = await req.db.quizAttempt.create({ data: { id: uuid(), quiz_id: q.id, student_id: sid, attempt_no: (existing[0]?.attempt_no ?? 0) + 1, started_at: now, deadline_at: deadline, status: 'in_progress', answers: { responses: {}, saved_at: null }, question_order: order } });
    } catch (e) { if (e.code !== 'P2002') throw e; }
  }
  if (!attempt) throw new AErr('Could not start the attempt, please retry', 409);
  res.status(resumed ? 200 : 201).json(studentAttemptView(q, attempt, questions, now));
});

router.get('/:id/attempts/mine', async (req, res) => {
  studentOnly(req);
  const q = await load(req, req.params.id);
  await access(req, q);
  await sweep(req.db, q, { student_id: req.user.student_id });
  res.json((await req.db.quizAttempt.findMany({ where: { quiz_id: q.id, student_id: req.user.student_id }, orderBy: { attempt_no: 'asc' } })).map(Q.attemptSummary));
});

router.get('/:id/attempts/:aid', async (req, res) => {
  const q = await load(req, req.params.id);
  if (req.user.role !== 'student') {
    ownerOrStaff(req);
    return teacherAttemptView(req, res, q);
  }
  await access(req, q);
  let a = await loadAttempt(req, q);
  const questions = await questionsOf(req.db, q.id);
  if (Q.expired(a)) a = await Q.finalizeAttempt(req.db, q, a, questions, { auto: true });
  res.json(studentAttemptView(q, a, questions));
});

router.put('/:id/attempts/:aid/answers', async (req, res) => {
  studentOnly(req);
  const q = await load(req, req.params.id);
  await access(req, q);
  let a = await loadAttempt(req, q);
  const questions = await questionsOf(req.db, q.id);
  if (Q.expired(a)) { await Q.finalizeAttempt(req.db, q, a, questions, { auto: true }); throw new AErr('Time is up: your saved answers were submitted', 409, 'expired'); }
  if (a.status !== 'in_progress') throw new AErr('This attempt is already submitted', 409, 'submitted');
  const incoming = req.body.responses;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new AErr('responses must be an object {questionId: answer}');
  const by = new Map(questions.map(x => [x.id, x]));
  const clean = {};
  for (const [qid, v] of Object.entries(incoming)) { const qq = by.get(qid); if (!qq) throw new AErr('Unknown question'); clean[qid] = Q.cleanResponse(qq, v); }
  // merge under a compare-and-set on status so a concurrent submit is never overwritten
  const now = new Date();
  const cur = await req.db.quizAttempt.findUnique({ where: { id: a.id } });
  if (cur.status !== 'in_progress') throw new AErr('This attempt is already submitted', 409, 'submitted');
  const answers = { ...(cur.answers ?? {}), responses: { ...(cur.answers?.responses ?? {}), ...clean }, saved_at: now };
  for (const k of Object.keys(answers.responses)) if (answers.responses[k] === null) delete answers.responses[k];
  const upd = await req.db.quizAttempt.updateMany({ where: { id: a.id, status: 'in_progress', OR: [{ deadline_at: null }, { deadline_at: { gt: now } }] }, data: { answers } });
  if (!upd.count) { a = await req.db.quizAttempt.findUnique({ where: { id: a.id } }); if (Q.expired(a)) await Q.finalizeAttempt(req.db, q, a, questions, { auto: true }); throw new AErr('Time is up or the attempt was submitted', 409, 'expired'); }
  res.json({ saved_at: now, server_now: now, deadline_at: a.deadline_at });
});

router.post('/:id/attempts/:aid/submit', async (req, res) => {
  studentOnly(req);
  const q = await load(req, req.params.id);
  await access(req, q);
  const a = await loadAttempt(req, q);
  const questions = await questionsOf(req.db, q.id);
  let fr = req.body?.responses;
  if (fr && (typeof fr !== 'object' || Array.isArray(fr))) throw new AErr('responses must be an object {questionId: answer}');
  if (a.status !== 'in_progress') return res.json(studentAttemptView(q, a, questions));
  const done = await Q.finalizeAttempt(req.db, q, a, questions, { finalResponses: fr });
  await audit(req.db, { id: req.user.id, name: req.user.name, role: 'student' }, 'quiz.attempt_submit', 'quiz_attempt', a.id, { after: { score: done.score, max_score: done.max_score, auto_submitted: !!done.answers?.auto_submitted } });
  res.json(studentAttemptView(q, done, questions));
});

// ── attempts: lecturer / staff ─────────────────────────────────────────────────────
function ownerOrStaff(req) { if (req.user.role !== 'teacher' && !isStaff(req.user)) throw new AErr('Forbidden', 403); }
async function teacherAttemptView(req, res, q) {
  await access(req, q, { manage: true });
  await sweep(req.db, q);
  const a = await req.db.quizAttempt.findFirst({ where: { id: req.params.aid, quiz_id: q.id }, include: { student: true } });
  if (!a) throw new AErr('Attempt not found', 404);
  const questions = await questionsOf(req.db, q.id);
  const order = Array.isArray(a.question_order) ? a.question_order : questions.map(x => x.id);
  const by = new Map(questions.map(x => [x.id, x]));
  res.json({ ...Q.attemptSummary(a), student: C.sName(a.student), matricule: a.student.student_number, auto_score: a.answers?.auto_score ?? null, override: a.answers?.override ?? null, responses: a.answers?.responses ?? {},
    questions: order.map(id => by.get(id)).filter(Boolean).map(x => ({ ...Q.reviewQuestion(x), correct: !!a.answers?.graded?.[x.id]?.correct, awarded: a.answers?.graded?.[x.id]?.points ?? 0 })) });
}

router.get('/:id/attempts', async (req, res) => {
  const q = await load(req, req.params.id);
  if (req.user.role === 'student') throw new AErr('Forbidden', 403);
  await access(req, q, { manage: true });
  await sweep(req.db, q);
  const [roster, atts] = await Promise.all([C.rosterStudents(req.db, q.offering_id), req.db.quizAttempt.findMany({ where: { quiz_id: q.id }, orderBy: [{ student_id: 'asc' }, { attempt_no: 'asc' }] })]);
  const by = new Map();
  for (const a of atts) by.set(a.student_id, [...(by.get(a.student_id) ?? []), Q.attemptSummary(a)]);
  const list = roster.map(s => ({ student_id: s.id, name: C.sName(s), matricule: s.student_number, attempts: by.get(s.id) ?? [] }));
  const known = new Set(roster.map(r => r.id));
  const others = [...by.keys()].filter(k => !known.has(k));
  if (others.length) for (const s of await req.db.student.findMany({ where: { id: { in: others } } })) list.push({ student_id: s.id, name: `${C.sName(s)} (not on roster)`, matricule: s.student_number, attempts: by.get(s.id) });
  res.json({ quiz: quizView(q), students: list });
});

router.post('/:id/attempts/:aid/override', async (req, res) => {
  const q = await load(req, req.params.id);
  if (req.user.role === 'student') throw new AErr('Forbidden', 403);
  const { offering } = await access(req, q, { manage: true });
  const a = await req.db.quizAttempt.findFirst({ where: { id: req.params.aid, quiz_id: q.id } });
  if (!a) throw new AErr('Attempt not found', 404);
  if (a.status === 'in_progress') throw new AErr('The attempt is still in progress', 409);
  const score = C.num(req.body.score, 'Score', { min: 0, max: a.max_score ?? 0 });
  const note = str(req.body.note);
  if (!note) throw new AErr('A note explaining the change is required');
  if (note.length > 2000) throw new AErr('Note is too long');
  const actor = actorOf(req.user);
  const answers = { ...(a.answers ?? {}), override: { score, note, by: actor.name, by_id: actor.id, at: new Date(), previous: a.score } };
  await req.db.quizAttempt.update({ where: { id: a.id }, data: { score, answers } });
  await audit(req.db, actor, 'quiz.override', 'quiz_attempt', a.id, { reason: note, before: { score: a.score }, after: { score } });
  await safe(async () => notifyUsers(req.db, await C.studentUserIds(req.db, [a.student_id]), { type: 'quiz_graded', title: `Score updated: ${q.title}`, body: `${offering.subject.name} — ${score}/${a.max_score}`, link: '/student/assessments' }));
  res.json(Q.attemptSummary(await req.db.quizAttempt.findUnique({ where: { id: a.id } })));
});

router.get('/:id/stats', async (req, res) => {
  const q = await load(req, req.params.id);
  if (req.user.role === 'student') throw new AErr('Forbidden', 403);
  await access(req, q, { manage: true });
  await sweep(req.db, q);
  const [questions, atts] = await Promise.all([questionsOf(req.db, q.id), req.db.quizAttempt.findMany({ where: { quiz_id: q.id, status: { not: 'in_progress' } } })]);
  const scores = atts.filter(a => a.max_score > 0).map(a => a.score / a.max_score * 100);
  const avg = arr => (arr.length ? C.round2(arr.reduce((x, y) => x + y, 0) / arr.length) : null);
  res.json({
    attempts: atts.length, students: new Set(atts.map(a => a.student_id)).size, average_pct: avg(scores), highest_pct: scores.length ? C.round2(Math.max(...scores)) : null, lowest_pct: scores.length ? C.round2(Math.min(...scores)) : null,
    questions: questions.map(x => {
      const answered = atts.filter(a => a.answers?.responses?.[x.id] !== undefined && a.answers?.responses?.[x.id] !== null);
      const correct = atts.filter(a => a.answers?.graded?.[x.id]?.correct).length;
      const choices = {};
      if (x.options) for (const o of x.options) choices[o.id] = { text: o.text, count: 0, correct: Array.isArray(x.answer) ? x.answer.includes(o.id) : x.answer === o.id };
      if (x.type === 'true_false') { choices.true = { text: 'True', count: 0, correct: x.answer === true }; choices.false = { text: 'False', count: 0, correct: x.answer === false }; }
      for (const a of answered) { const r = a.answers.responses[x.id]; for (const k of Array.isArray(r) ? r : [String(r)]) if (choices[k]) choices[k].count++; }
      return { id: x.id, position: x.position, type: x.type, text: x.text, points: x.points, answered: answered.length, correct, correct_pct: atts.length ? C.round2(correct / atts.length * 100) : null, choices: x.type === 'short' ? null : choices };
    }),
  });
});

module.exports = router;
