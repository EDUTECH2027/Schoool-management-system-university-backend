// Quiz engine: question validation, auto-grading, attempt lifecycle. Correct answers live ONLY in
// quiz_questions.answer; they are stripped by publicQuestion() and revealed by reviewQuestion() only when canReveal().
//
// quiz_attempts.answers (Json) = { responses: {questionId: value}, saved_at, graded: {questionId: {correct, points}},
//   auto_score, override?: {score, note, by, at}, auto_submitted? }   — override/graded live here because the table has no extra columns.
const { AErr, round2, str } = require('./common');

const TYPES = ['single', 'multiple', 'true_false', 'short'];
const norm = s => String(s ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Validate + normalise a question payload → data for quizQuestion.create/update. */
function validateQuestion(b, { partial = false } = {}) {
  const type = b.type;
  if (!TYPES.includes(type)) throw new AErr(`type must be one of ${TYPES.join(', ')}`);
  const text = str(b.text);
  if (!text) throw new AErr('Question text is required');
  if (text.length > 4000) throw new AErr('Question text is too long (max 4000 characters)');
  const points = b.points === undefined || b.points === '' ? 1 : Number(b.points);
  if (!Number.isFinite(points) || points <= 0 || points > 1000) throw new AErr('points must be greater than 0 and at most 1000');
  const explanation = str(b.explanation) || null;
  if (explanation && explanation.length > 4000) throw new AErr('Explanation is too long');
  let options = null, answer;
  if (type === 'single' || type === 'multiple') {
    if (!Array.isArray(b.options) || b.options.length < 2 || b.options.length > 12) throw new AErr('Provide between 2 and 12 options');
    const seen = new Set();
    options = b.options.map((o, i) => {
      const t = str(o?.text), id = String(o?.id ?? `o${i + 1}`);
      if (!t) throw new AErr(`Option ${i + 1} is empty`);
      if (t.length > 1000) throw new AErr(`Option ${i + 1} is too long`);
      if (!id || id.length > 40) throw new AErr('Invalid option id');
      if (seen.has(id)) throw new AErr('Option ids must be unique');
      seen.add(id);
      return { id, text: t };
    });
    if (new Set(options.map(o => norm(o.text))).size !== options.length) throw new AErr('Options must be different from each other');
    const ids = new Set(options.map(o => o.id));
    if (type === 'single') {
      if (typeof b.answer !== 'string' || !ids.has(b.answer)) throw new AErr('Choose the correct option');
      answer = b.answer;
    } else {
      if (!Array.isArray(b.answer) || !b.answer.length || b.answer.some(a => !ids.has(a))) throw new AErr('Choose at least one correct option');
      answer = [...new Set(b.answer)];
      if (answer.length === options.length) throw new AErr('Not every option can be correct');
    }
  } else if (type === 'true_false') {
    const a = b.answer === 'true' ? true : b.answer === 'false' ? false : b.answer;
    if (typeof a !== 'boolean') throw new AErr('answer must be true or false');
    answer = a;
  } else {
    const list = (Array.isArray(b.answer) ? b.answer : typeof b.answer === 'string' ? b.answer.split('\n') : []).map(a => String(a).trim()).filter(Boolean);
    if (!list.length) throw new AErr('Provide at least one accepted answer');
    if (list.some(a => a.length > 500)) throw new AErr('Accepted answers are limited to 500 characters');
    answer = [...new Map(list.map(a => [norm(a), a])).values()];
  }
  void partial;
  return { type, text, options, answer, points, explanation };
}

function isCorrect(q, r) {
  if (r === undefined || r === null) return false;
  switch (q.type) {
    case 'single': return typeof r === 'string' && r === q.answer;
    case 'multiple': {
      if (!Array.isArray(r)) return false;
      const got = new Set(r.map(String)), want = new Set(q.answer);
      return got.size === want.size && [...want].every(x => got.has(x));
    }
    case 'true_false': { const v = r === 'true' ? true : r === 'false' ? false : r; return typeof v === 'boolean' && v === q.answer; }
    case 'short': return typeof r === 'string' && q.answer.some(a => norm(a) === norm(r)) && norm(r) !== '';
    default: return false;
  }
}

/** Is a saved response structurally acceptable for this question? (never trusts the client) */
function cleanResponse(q, v) {
  if (v === null || v === undefined || v === '') return null;
  switch (q.type) {
    case 'single': { if (typeof v !== 'string') throw new AErr('Invalid answer'); if (!q.options.some(o => o.id === v)) throw new AErr('Unknown option'); return v; }
    case 'multiple': { if (!Array.isArray(v) || v.length > q.options.length) throw new AErr('Invalid answer'); const ids = new Set(q.options.map(o => o.id)); if (v.some(x => !ids.has(x))) throw new AErr('Unknown option'); return [...new Set(v)]; }
    case 'true_false': { if (v === 'true') return true; if (v === 'false') return false; if (typeof v !== 'boolean') throw new AErr('Invalid answer'); return v; }
    default: { if (typeof v !== 'string') throw new AErr('Invalid answer'); if (v.length > 1000) throw new AErr('Answer too long (max 1000 characters)'); return v; }
  }
}

function gradeAttempt(questions, responses) {
  const graded = {}; let score = 0, max = 0;
  for (const q of questions) {
    const ok = isCorrect(q, responses?.[q.id]);
    graded[q.id] = { correct: ok, points: ok ? q.points : 0 };
    score += ok ? q.points : 0; max += q.points;
  }
  return { graded, score: round2(score), max: round2(max) };
}

const publicQuestion = q => ({ id: q.id, type: q.type, text: q.text, options: q.options ?? null, points: q.points });
const reviewQuestion = q => ({ ...publicQuestion(q), answer: q.answer, explanation: q.explanation });

const canReveal = (quiz, now = new Date()) => !!quiz.show_answers && (quiz.status === 'closed' || (!!quiz.closes_at && quiz.closes_at <= now));
const isFinished = a => a.status !== 'in_progress';
const expired = (a, now = new Date()) => a.status === 'in_progress' && !!a.deadline_at && a.deadline_at <= now;

/**
 * Submit an attempt: compare-and-set from in_progress so concurrent submits grade once.
 * `finalResponses` is merged ONLY when the deadline has not passed (server clock decides).
 */
async function finalizeAttempt(db, quiz, attempt, questions, { finalResponses, now = new Date(), auto = false } = {}) {
  if (attempt.status !== 'in_progress') return attempt;
  const late = !!attempt.deadline_at && attempt.deadline_at <= now;
  const prev = attempt.answers ?? {};
  let responses = prev.responses ?? {};
  if (finalResponses && !late) {
    responses = { ...responses };
    const byId = Object.fromEntries(questions.map(q => [q.id, q]));
    for (const [qid, v] of Object.entries(finalResponses)) { if (byId[qid]) responses[qid] = cleanResponse(byId[qid], v); }
  }
  const { graded, score, max } = gradeAttempt(questions, responses);
  const answers = { ...prev, responses, saved_at: prev.saved_at ?? null, graded, auto_score: score, ...(auto || late ? { auto_submitted: true } : {}) };
  const submittedAt = late ? attempt.deadline_at : now;       // a late submission is stamped at the deadline, never later
  const upd = await db.quizAttempt.updateMany({ where: { id: attempt.id, status: 'in_progress' }, data: { status: 'graded', submitted_at: submittedAt, answers, score, max_score: max } });
  void quiz;
  return upd.count ? db.quizAttempt.findUnique({ where: { id: attempt.id } }) : db.quizAttempt.findUnique({ where: { id: attempt.id } });
}

/** Seeded-free Fisher–Yates on the server. */
function shuffled(ids) {
  const a = [...ids];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const attemptSummary = a => ({
  id: a.id, quiz_id: a.quiz_id, student_id: a.student_id, attempt_no: a.attempt_no, status: a.status, started_at: a.started_at, deadline_at: a.deadline_at, submitted_at: a.submitted_at,
  score: a.status === 'in_progress' ? null : a.score, max_score: a.status === 'in_progress' ? null : a.max_score,
  overridden: !!a.answers?.override, auto_submitted: !!a.answers?.auto_submitted,
});

module.exports = { TYPES, norm, validateQuestion, isCorrect, cleanResponse, gradeAttempt, publicQuestion, reviewQuestion, canReveal, isFinished, expired, finalizeAttempt, shuffled, attemptSummary };
