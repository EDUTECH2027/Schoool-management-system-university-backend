// Student services: requests with a workflow (see docs/SERVICES.md).
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { audit } = require('../academics/registration');
const { actorOf } = require('../academics/results');
const { notifyUsers, safe } = require('../utils/notify');
const R = require('../services/requests');

const staff = [authenticate, authorize('super_admin', 'academic_officer')];
const student = [authenticate, authorize('student')];
const STAFF_ROLES = ['super_admin', 'head_teacher', 'academic_officer'];

const fail = (res, e) => {
  if (e instanceof R.ServiceError) return res.status(e.status).json({ error: e.message });
  throw e;
};
const wrap = fn => async (req, res) => { try { await fn(req, res); } catch (e) { fail(res, e); } };

const staffUserIds = (db) => db.user.findMany({ where: { role: { in: STAFF_ROLES } }, select: { id: true } }).then(u => u.map(x => x.id));
const studentUserIds = (db, studentId) => db.user.findMany({ where: { student_id: studentId }, select: { id: true } }).then(u => u.map(x => x.id));
const label = r => `${r.reference} — ${r.subject}`;

// ── shared ───────────────────────────────────────────────────────────────────
router.get('/meta', authenticate, (req, res) => res.json({ types: R.TYPES, statuses: R.STATUSES, flow: R.FLOW, sla_days: R.SLA_DAYS, max_open: R.MAX_OPEN_PER_STUDENT, limits: R.LIMITS }));

// ── student side ─────────────────────────────────────────────────────────────
router.post('/', ...student, wrap(async (req, res) => {
  const sid = req.user.student_id;
  if (!sid) return res.status(403).json({ error: 'Your account is not linked to a student record.' });
  const { type } = req.body;
  if (!R.TYPES.includes(type)) return res.status(422).json({ error: `type must be one of ${R.TYPES.join(', ')}` });
  const subject = R.validateText('The subject', req.body.subject, R.LIMITS.subject);
  const description = R.validateText('The description', req.body.description ?? '', R.LIMITS.description);
  if ((type === 'complaint' || type === 'other' || type === 'correction') && description.length < 10) return res.status(422).json({ error: 'Please describe your request (at least 10 characters).' });
  const payload = R.cleanPayload(type, req.body.payload);
  const open = await req.db.serviceRequest.count({ where: { student_id: sid, status: { in: R.OPEN } } });
  if (open >= R.MAX_OPEN_PER_STUDENT) return res.status(429).json({ error: `You already have ${open} open requests (maximum ${R.MAX_OPEN_PER_STUDENT}). Wait for some to be processed or cancel one.` });
  let row;
  for (let i = 0; i < 5 && !row; i++) {
    try { row = await req.db.serviceRequest.create({ data: { id: uuid(), reference: R.newReference(), student_id: sid, type, subject, description: description || null, payload } }); }
    catch (e) { if (e.code !== 'P2002') throw e; }
  }
  if (!row) return res.status(500).json({ error: 'Could not allocate a reference, try again.' });
  await R.addEvent(req.db, row.id, actorOf(req.user), { kind: 'status', to: 'submitted', body: 'Request submitted' });
  await safe(async () => notifyUsers(req.db, await staffUserIds(req.db), { type: 'service_request', title: 'New student request', body: `${label(row)} (${type})`, link: `/academics/services?id=${row.id}` }));
  res.status(201).json(R.studentDto(row));
}));

router.get('/mine', ...student, async (req, res) => {
  if (!req.user.student_id) return res.json([]);
  const rows = await req.db.serviceRequest.findMany({ where: { student_id: req.user.student_id }, orderBy: { created_at: 'desc' }, take: 200 });
  res.json(rows.map(R.studentDto));
});

async function ownRequest(req, res) {
  const r = req.user.student_id && await req.db.serviceRequest.findFirst({ where: { id: req.params.id, student_id: req.user.student_id } });
  if (!r) { res.status(404).json({ error: 'Request not found' }); return null; }
  return r;
}

router.get('/mine/:id', ...student, async (req, res) => {
  const r = await ownRequest(req, res); if (!r) return;
  const events = await req.db.serviceRequestEvent.findMany({ where: { request_id: r.id, internal: false }, orderBy: { created_at: 'asc' } });
  res.json({ ...R.studentDto(r), events: events.map(R.eventDto) });
});

router.post('/mine/:id/comments', ...student, wrap(async (req, res) => {
  const r = await ownRequest(req, res); if (!r) return;
  if (!R.OPEN.includes(r.status)) return res.status(409).json({ error: 'This request is closed; open a new one if needed.' });
  const body = R.validateText('The comment', req.body.body, R.LIMITS.comment);
  const actor = actorOf(req.user);
  const ev = await R.addEvent(req.db, r.id, actor, { kind: 'comment', body });
  let current = r;
  if (r.status === 'awaiting_info') {   // the student answered: back to staff
    const t = await R.transition(req.db, r, 'in_review', { note: 'Information provided by the student', user: req.user, byStudent: true });
    current = t.request;
  } else await req.db.serviceRequest.update({ where: { id: r.id }, data: { updated_at: new Date() } });
  await safe(async () => notifyUsers(req.db, r.assigned_to ? [r.assigned_to] : await staffUserIds(req.db), { type: 'service_request', title: 'Student replied to a request', body: label(r), link: `/academics/services?id=${r.id}` }));
  res.status(201).json({ event: R.eventDto(ev), status: current.status });
}));

router.post('/mine/:id/cancel', ...student, wrap(async (req, res) => {
  const r = await ownRequest(req, res); if (!r) return;
  if (!R.CANCELLABLE.includes(r.status)) return res.status(409).json({ error: `A request that is ${r.status.replace('_', ' ')} can no longer be cancelled.` });
  const { request } = await R.transition(req.db, r, 'cancelled', { note: req.body.note || 'Cancelled by the student', user: req.user, byStudent: true });
  await safe(async () => notifyUsers(req.db, r.assigned_to ? [r.assigned_to] : await staffUserIds(req.db), { type: 'service_request', title: 'A student cancelled a request', body: label(r), link: `/academics/services?id=${r.id}` }));
  res.json(R.studentDto(request));
}));

// ── staff side ───────────────────────────────────────────────────────────────
router.get('/staff-users', ...staff, async (req, res) => {
  const users = await req.db.user.findMany({ where: { role: { in: STAFF_ROLES } }, select: { id: true, name: true, role: true }, orderBy: { name: 'asc' } });
  res.json(users);
});

router.get('/', ...staff, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
  const where = {};
  const statuses = String(req.query.status || '').split(',').filter(s => R.STATUSES.includes(s));
  if (req.query.status === 'open') where.status = { in: R.OPEN };
  else if (statuses.length) where.status = { in: statuses };
  if (R.TYPES.includes(req.query.type)) where.type = req.query.type;
  if (req.query.assignee === 'me') where.assigned_to = req.user.id;
  else if (req.query.assignee === 'none') where.assigned_to = null;
  else if (req.query.assignee) where.assigned_to = String(req.query.assignee);
  if (req.query.overdue === '1') { where.status = { in: R.SLA_STATUSES }; where.created_at = { lt: new Date(Date.now() - R.SLA_DAYS * 86_400_000) }; }
  const q = String(req.query.search || '').trim();
  if (q) where.OR = [{ reference: { contains: q, mode: 'insensitive' } }, { subject: { contains: q, mode: 'insensitive' } }, { student: { OR: [{ first_name: { contains: q, mode: 'insensitive' } }, { last_name: { contains: q, mode: 'insensitive' } }, { student_number: { contains: q, mode: 'insensitive' } }] } }];
  const [total, rows, grouped] = await Promise.all([
    req.db.serviceRequest.count({ where }),
    req.db.serviceRequest.findMany({ where, orderBy: [{ created_at: 'desc' }], skip: (page - 1) * limit, take: limit, include: { student: true } }),
    req.db.serviceRequest.groupBy({ by: ['status'], _count: { _all: true } }),
  ]);
  const ids = [...new Set(rows.map(r => r.assigned_to).filter(Boolean))];
  const users = ids.length ? await req.db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  const nameOf = Object.fromEntries(users.map(u => [u.id, u.name]));
  res.json({ total, page, limit, sla_days: R.SLA_DAYS, counts: Object.fromEntries(grouped.map(g => [g.status, g._count._all])), items: rows.map(r => R.staffDto(r, nameOf[r.assigned_to])) });
});

async function loadStaff(req, res) {
  const r = await req.db.serviceRequest.findUnique({ where: { id: req.params.id }, include: { student: true } });
  if (!r) { res.status(404).json({ error: 'Request not found' }); return null; }
  return r;
}

router.get('/:id', ...staff, async (req, res) => {
  const r = await loadStaff(req, res); if (!r) return;
  const [events, assignee] = await Promise.all([
    req.db.serviceRequestEvent.findMany({ where: { request_id: r.id }, orderBy: { created_at: 'asc' } }),
    r.assigned_to ? req.db.user.findUnique({ where: { id: r.assigned_to }, select: { name: true } }) : null,
  ]);
  res.json({ ...R.staffDto(r, assignee?.name), events: events.map(R.eventDto) });
});

router.post('/:id/assign', ...staff, wrap(async (req, res) => {
  const r = await loadStaff(req, res); if (!r) return;
  const to = req.body.user_id || null;
  let assignee = null;
  if (to) {
    assignee = await req.db.user.findFirst({ where: { id: String(to), role: { in: STAFF_ROLES } }, select: { id: true, name: true } });
    if (!assignee) return res.status(422).json({ error: 'The assignee must be an administrator or academic officer.' });
  }
  if (!R.OPEN.includes(r.status)) return res.status(409).json({ error: 'A closed request cannot be assigned.' });
  const actor = actorOf(req.user);
  await req.db.serviceRequest.update({ where: { id: r.id }, data: { assigned_to: assignee?.id ?? null, updated_at: new Date() } });
  await R.addEvent(req.db, r.id, actor, { kind: 'assignment', body: assignee ? `Assigned to ${assignee.name}` : 'Unassigned', internal: true });
  await audit(req.db, actor, 'service.assign', 'service_request', r.id, { before: { assigned_to: r.assigned_to }, after: { assigned_to: assignee?.id ?? null } });
  if (assignee && assignee.id !== req.user.id) await safe(() => notifyUsers(req.db, [assignee.id], { type: 'service_request', title: 'A request was assigned to you', body: label(r), link: `/academics/services?id=${r.id}` }));
  res.json({ ok: true, assigned_to: assignee?.id ?? null, assignee_name: assignee?.name ?? null });
}));

router.post('/:id/notes', ...staff, wrap(async (req, res) => {
  const r = await loadStaff(req, res); if (!r) return;
  const body = R.validateText('The note', req.body.body, R.LIMITS.comment);
  const ev = await R.addEvent(req.db, r.id, actorOf(req.user), { kind: 'comment', body, internal: true });
  res.status(201).json(R.eventDto(ev));
}));

// A public reply visible to the student (notifies them).
router.post('/:id/comments', ...staff, wrap(async (req, res) => {
  const r = await loadStaff(req, res); if (!r) return;
  if (!R.OPEN.includes(r.status)) return res.status(409).json({ error: 'This request is closed.' });
  const body = R.validateText('The message', req.body.body, R.LIMITS.comment);
  const ev = await R.addEvent(req.db, r.id, actorOf(req.user), { kind: 'comment', body });
  await req.db.serviceRequest.update({ where: { id: r.id }, data: { updated_at: new Date() } });
  await safe(async () => notifyUsers(req.db, await studentUserIds(req.db, r.student_id), { type: 'service_update', title: 'New message on your request', body: label(r), link: `/student/services?id=${r.id}` }));
  res.status(201).json(R.eventDto(ev));
}));

router.post('/:id/status', ...staff, wrap(async (req, res) => {
  const r = await loadStaff(req, res); if (!r) return;
  const { request, document } = await R.transition(req.db, r, String(req.body.to || ''), { note: req.body.note, user: req.user });
  const msg = { in_review: 'is being reviewed', awaiting_info: 'needs more information from you', approved: 'was approved', rejected: 'was declined', completed: 'is completed', cancelled: 'was cancelled' }[request.status];
  await safe(async () => notifyUsers(req.db, await studentUserIds(req.db, r.student_id), { type: 'service_update', title: `Your request ${msg}`, body: `${label(r)}${req.body.note ? ` — ${String(req.body.note).trim().slice(0, 200)}` : ''}`, link: `/student/services?id=${r.id}` }));
  res.json({ ...R.staffDto(request), document: document ? { id: document.id, code: document.code, type: document.type } : null });
}));

module.exports = router;
