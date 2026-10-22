// Careers & alumni: job board (postings + applications), alumni profiles / directory / register, tracer statistics.
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { audit } = require('../academics/registration');
const { notifyUsers, safe } = require('../utils/notify');
const { clean, url, email, dateStr, today, paging, csvCell, isStaff, actorOf, bad } = require('../careers/util');

router.use(authenticate);
const manage = authorize('super_admin', 'academic_officer');
const viewers = (req, res, next) => (isStaff(req.user) || ['student', 'teacher'].includes(req.user.role) ? next() : res.status(403).json({ error: 'Forbidden' }));
const studentOnly = (req, res, next) => (req.user.role === 'student' && req.user.student_id ? next() : res.status(403).json({ error: 'Only students can do this' }));
const aud = (req, action, type, id, extra) => audit(req.db, actorOf(req.user), action, type, id, extra);
const KINDS = ['job', 'internship', 'volunteering'];
const JOB_STATUS = ['open', 'closed', 'draft'];
const APP_DECISIONS = ['shortlisted', 'rejected', 'hired'];
const studentUserIds = async (db, studentId) => (await db.user.findMany({ where: { student_id: studentId }, select: { id: true } })).map(u => u.id);
const isOpenNow = j => j.status === 'open' && (!j.deadline || j.deadline >= today());

// ── Job postings ─────────────────────────────────────────────────────────────────
const jobView = (j, extra = {}) => ({
  id: j.id, title: j.title, company: j.company, kind: j.kind, location: j.location, description: j.description, apply_url: j.apply_url,
  contact_email: j.contact_email, deadline: j.deadline, status: j.status, posted_by_name: j.posted_by_name, created_at: j.created_at, is_open: isOpenNow(j), ...extra,
});
function jobData(b, partial) {
  const d = {};
  const set = (k, v) => { if (v !== undefined) d[k] = v; };
  if (!partial || b.title !== undefined) { const v = clean(b.title, 160); if (!v) throw bad('title is required'); d.title = v; }
  if (!partial || b.company !== undefined) { const v = clean(b.company, 120); if (!v) throw bad('company is required'); d.company = v; }
  if (!partial || b.description !== undefined) { const v = clean(b.description, 5000, { multiline: true }); if (!v) throw bad('description is required'); d.description = v; }
  if (b.kind !== undefined) { if (!KINDS.includes(b.kind)) throw bad(`kind must be one of ${KINDS.join(', ')}`); d.kind = b.kind; }
  if (b.status !== undefined) { if (!JOB_STATUS.includes(b.status)) throw bad(`status must be one of ${JOB_STATUS.join(', ')}`); d.status = b.status; }
  set('location', clean(b.location, 120)); set('apply_url', url(b.apply_url, 'apply_url')); set('contact_email', email(b.contact_email, 'contact_email'));
  set('deadline', dateStr(b.deadline, 'deadline'));
  return d;
}

router.get('/jobs', viewers, async (req, res) => {
  const staff = isStaff(req.user);
  const where = {};
  const and = [];
  if (staff) { if (req.query.status && JOB_STATUS.includes(req.query.status)) where.status = req.query.status; }
  else { where.status = 'open'; and.push({ OR: [{ deadline: null }, { deadline: { gte: today() } }] }); }
  if (KINDS.includes(req.query.kind)) where.kind = req.query.kind;
  const q = clean(req.query.q ?? '', 100);
  if (q) and.push({ OR: ['title', 'company', 'location', 'description'].map(f => ({ [f]: { contains: q, mode: 'insensitive' } })) });
  if (and.length) where.AND = and;
  const { limit, page, skip } = paging(req.query);
  const [total, rows] = await Promise.all([
    req.db.jobPosting.count({ where }),
    req.db.jobPosting.findMany({ where, orderBy: { created_at: 'desc' }, skip, take: limit, ...(staff ? { include: { _count: { select: { applications: true } } } } : {}) }),
  ]);
  let mine = {};
  if (req.user.role === 'student' && req.user.student_id && rows.length) {
    const apps = await req.db.jobApplication.findMany({ where: { student_id: req.user.student_id, job_id: { in: rows.map(r => r.id) } }, select: { job_id: true, status: true } });
    mine = Object.fromEntries(apps.map(a => [a.job_id, a.status]));
  }
  res.json({ total, page, limit, items: rows.map(j => jobView(j, staff ? { applicant_count: j._count.applications } : { my_application: mine[j.id] ?? null })) });
});

router.get('/jobs/:id', viewers, async (req, res) => {
  const j = await req.db.jobPosting.findUnique({ where: { id: req.params.id } });
  if (!j || (!isStaff(req.user) && j.status !== 'open')) return res.status(404).json({ error: 'Posting not found' });
  let extra = {};
  if (req.user.role === 'student' && req.user.student_id) {
    const a = await req.db.jobApplication.findUnique({ where: { job_id_student_id: { job_id: j.id, student_id: req.user.student_id } } });
    extra = { my_application: a?.status ?? null };
  }
  res.json(jobView(j, extra));
});

router.post('/jobs', manage, async (req, res) => {
  const d = jobData(req.body, false);
  const row = await req.db.jobPosting.create({ data: { id: uuid(), kind: 'job', status: 'open', ...d, posted_by: req.user.id, posted_by_name: req.user.name } });
  await aud(req, 'job.create', 'job_posting', row.id, { after: { title: row.title, company: row.company, kind: row.kind } });
  res.status(201).json(jobView(row));
});
router.put('/jobs/:id', manage, async (req, res) => {
  const j = await req.db.jobPosting.findUnique({ where: { id: req.params.id } });
  if (!j) return res.status(404).json({ error: 'Posting not found' });
  const row = await req.db.jobPosting.update({ where: { id: j.id }, data: jobData(req.body, true) });
  await aud(req, 'job.update', 'job_posting', j.id, { before: { title: j.title, status: j.status, deadline: j.deadline }, after: { title: row.title, status: row.status, deadline: row.deadline } });
  res.json(jobView(row));
});
router.post('/jobs/:id/close', manage, async (req, res) => {
  const r = await req.db.jobPosting.updateMany({ where: { id: req.params.id, status: { not: 'closed' } }, data: { status: 'closed' } });
  if (!r.count) return res.status(await req.db.jobPosting.count({ where: { id: req.params.id } }) ? 409 : 404).json({ error: 'Posting not found or already closed' });
  await aud(req, 'job.close', 'job_posting', req.params.id, { after: { status: 'closed' } });
  res.json({ ok: true });
});
router.post('/jobs/:id/reopen', manage, async (req, res) => {
  const r = await req.db.jobPosting.updateMany({ where: { id: req.params.id, status: { not: 'open' } }, data: { status: 'open' } });
  if (!r.count) return res.status(await req.db.jobPosting.count({ where: { id: req.params.id } }) ? 409 : 404).json({ error: 'Posting not found or already open' });
  await aud(req, 'job.reopen', 'job_posting', req.params.id, { after: { status: 'open' } });
  res.json({ ok: true });
});
router.delete('/jobs/:id', manage, async (req, res) => {
  const r = await req.db.jobPosting.deleteMany({ where: { id: req.params.id } });
  if (!r.count) return res.status(404).json({ error: 'Posting not found' });
  await aud(req, 'job.delete', 'job_posting', req.params.id);
  res.status(204).end();
});

// ── Applications ─────────────────────────────────────────────────────────────────
const appView = a => ({ id: a.id, job_id: a.job_id, status: a.status, cover_note: a.cover_note, created_at: a.created_at });
router.post('/jobs/:id/apply', studentOnly, async (req, res) => {
  const s = await req.db.student.findUnique({ where: { id: req.user.student_id } });
  if (!s || !['active', 'graduated'].includes(s.academic_status)) return res.status(403).json({ error: 'Your student status does not allow applying' });
  const j = await req.db.jobPosting.findUnique({ where: { id: req.params.id } });
  if (!j || j.status === 'draft') return res.status(404).json({ error: 'Posting not found' });
  if (!isOpenNow(j)) return res.status(409).json({ error: 'This posting is closed' });
  const note = clean(req.body.cover_note, 2000, { multiline: true });
  try {
    const row = await req.db.jobApplication.create({ data: { id: uuid(), job_id: j.id, student_id: s.id, cover_note: note } });
    return res.status(201).json(appView(row));
  } catch (e) {
    if (e.code !== 'P2002') throw e;
    // a withdrawn application may be re-submitted; anything else is a duplicate
    const r = await req.db.jobApplication.updateMany({ where: { job_id: j.id, student_id: s.id, status: 'withdrawn' }, data: { status: 'submitted', cover_note: note, created_at: new Date() } });
    if (!r.count) return res.status(409).json({ error: 'You have already applied to this posting' });
    return res.status(201).json(appView(await req.db.jobApplication.findUnique({ where: { job_id_student_id: { job_id: j.id, student_id: s.id } } })));
  }
});
router.post('/applications/:id/withdraw', studentOnly, async (req, res) => {
  const a = await req.db.jobApplication.findUnique({ where: { id: req.params.id } });
  if (!a || a.student_id !== req.user.student_id) return res.status(404).json({ error: 'Application not found' });
  const r = await req.db.jobApplication.updateMany({ where: { id: a.id, status: { in: ['submitted', 'shortlisted'] } }, data: { status: 'withdrawn' } });
  if (!r.count) return res.status(409).json({ error: `An application that is ${a.status} cannot be withdrawn` });
  res.json({ ok: true });
});
router.get('/my-applications', studentOnly, async (req, res) => {
  const rows = await req.db.jobApplication.findMany({ where: { student_id: req.user.student_id }, orderBy: { created_at: 'desc' }, include: { job: true } });
  res.json(rows.map(a => ({ ...appView(a), job: { id: a.job.id, title: a.job.title, company: a.job.company, kind: a.job.kind, deadline: a.job.deadline, status: a.job.status } })));
});
router.get('/jobs/:id/applications', manage, async (req, res) => {
  const j = await req.db.jobPosting.findUnique({ where: { id: req.params.id } });
  if (!j) return res.status(404).json({ error: 'Posting not found' });
  const rows = await req.db.jobApplication.findMany({ where: { job_id: j.id }, orderBy: { created_at: 'asc' }, include: { student: { include: { class: { include: { programme: true } }, alumni_profile: true } } } });
  res.json(rows.map(a => ({
    ...appView(a), student_id: a.student_id, student_name: `${a.student.first_name} ${a.student.last_name}`, matricule: a.student.student_number,
    programme: a.student.class?.programme?.name ?? a.student.alumni_profile?.programme_name ?? null, academic_status: a.student.academic_status,
  })));
});
router.put('/applications/:id/status', manage, async (req, res) => {
  const status = req.body.status;
  if (!APP_DECISIONS.includes(status)) return res.status(422).json({ error: `status must be one of ${APP_DECISIONS.join(', ')}` });
  const a = await req.db.jobApplication.findUnique({ where: { id: req.params.id }, include: { job: true } });
  if (!a) return res.status(404).json({ error: 'Application not found' });
  const r = await req.db.jobApplication.updateMany({ where: { id: a.id, status: { not: 'withdrawn' } }, data: { status } });
  if (!r.count) return res.status(409).json({ error: 'The student withdrew this application' });
  await aud(req, 'job.application_status', 'job_application', a.id, { before: { status: a.status }, after: { status } });
  const label = { shortlisted: 'shortlisted', rejected: 'not retained', hired: 'accepted — congratulations' }[status];
  await safe(async () => notifyUsers(req.db, await studentUserIds(req.db, a.student_id), { type: 'careers', title: `Application update: ${a.job.title}`, body: `Your application to ${a.job.company} is ${label}.`, link: '/student/careers' }));
  res.json({ ok: true, status });
});

// ── Alumni profiles ──────────────────────────────────────────────────────────────
// Choice: ANY student may maintain their own profile (so it can be prepared before graduation); the directory
// shows only is_public profiles, which are private by default.
const profileView = p => ({ id: p.id, graduation_year: p.graduation_year, programme_name: p.programme_name, employer: p.employer, position: p.position, city: p.city, bio: p.bio, linkedin_url: p.linkedin_url, contact_email: p.contact_email, is_public: p.is_public, updated_at: p.updated_at });
const nameOf = s => `${s.first_name} ${s.last_name}`;
function profileData(b) {
  const d = {};
  if (b.graduation_year !== undefined) {
    if (b.graduation_year === null || b.graduation_year === '') d.graduation_year = null;
    else { const y = Number(b.graduation_year); if (!Number.isInteger(y) || y < 1950 || y > new Date().getFullYear() + 8) throw bad('graduation_year is not a valid year'); d.graduation_year = y; }
  }
  for (const [k, m] of [['programme_name', 160], ['employer', 160], ['position', 160], ['city', 100]]) if (b[k] !== undefined) d[k] = clean(b[k], m);
  if (b.bio !== undefined) d.bio = clean(b.bio, 2000, { multiline: true });
  if (b.linkedin_url !== undefined) d.linkedin_url = url(b.linkedin_url, 'linkedin_url');
  if (b.contact_email !== undefined) d.contact_email = email(b.contact_email, 'contact_email');
  if (b.is_public !== undefined) { if (typeof b.is_public !== 'boolean') throw bad('is_public must be true or false'); d.is_public = b.is_public; }
  return d;
}
const programmeOf = s => s.class?.programme?.name ?? null;

router.get('/alumni/me', studentOnly, async (req, res) => {
  const s = await req.db.student.findUnique({ where: { id: req.user.student_id }, include: { alumni_profile: true, class: { include: { programme: true } } } });
  if (!s) return res.status(404).json({ error: 'Student not found' });
  const p = s.alumni_profile;
  res.json({
    exists: !!p, academic_status: s.academic_status, name: nameOf(s),
    profile: p ? profileView(p) : { id: null, graduation_year: null, programme_name: programmeOf(s), employer: null, position: null, city: null, bio: null, linkedin_url: null, contact_email: null, is_public: false },
  });
});
router.put('/alumni/me', studentOnly, async (req, res) => {
  const s = await req.db.student.findUnique({ where: { id: req.user.student_id }, include: { class: { include: { programme: true } } } });
  if (!s) return res.status(404).json({ error: 'Student not found' });
  const d = profileData(req.body);
  const row = await req.db.alumniProfile.upsert({
    where: { student_id: s.id },
    create: { id: uuid(), student_id: s.id, programme_name: programmeOf(s), ...d },
    update: { ...d, updated_at: new Date() },
  });
  res.json({ exists: true, profile: profileView(row) });
});

// Directory: only consenting (is_public) profiles and only the fields they chose to fill in. Never matricule/phone/etc.
const publicView = p => ({ id: p.id, name: nameOf(p.student), graduation_year: p.graduation_year, programme_name: p.programme_name, employer: p.employer, position: p.position, city: p.city, bio: p.bio, linkedin_url: p.linkedin_url, contact_email: p.contact_email });
function alumniWhere(q, { publicOnly }) {
  const where = {}; const and = [];
  if (publicOnly) where.is_public = true;
  const like = f => { const v = clean(q[f] ?? '', 100); if (v) where[f] = { contains: v, mode: 'insensitive' }; };
  like('programme_name'); like('employer'); like('city');
  if (q.programme && !q.programme_name) { const v = clean(q.programme, 100); if (v) where.programme_name = { contains: v, mode: 'insensitive' }; }
  if (q.year) { const y = parseInt(q.year, 10); if (!Number.isInteger(y)) throw bad('year must be a number'); where.graduation_year = y; }
  const s = clean(q.q ?? '', 100);
  if (s) and.push({ OR: [{ employer: { contains: s, mode: 'insensitive' } }, { position: { contains: s, mode: 'insensitive' } }, { city: { contains: s, mode: 'insensitive' } }, { student: { OR: [{ first_name: { contains: s, mode: 'insensitive' } }, { last_name: { contains: s, mode: 'insensitive' } }] } }] });
  if (and.length) where.AND = and;
  return where;
}
router.get('/alumni', viewers, async (req, res) => {
  const where = alumniWhere(req.query, { publicOnly: true });
  const { limit, page, skip } = paging(req.query);
  const [total, rows] = await Promise.all([
    req.db.alumniProfile.count({ where }),
    req.db.alumniProfile.findMany({ where, include: { student: { select: { first_name: true, last_name: true } } }, orderBy: [{ graduation_year: 'desc' }, { updated_at: 'desc' }], skip, take: limit }),
  ]);
  res.json({ total, page, limit, items: rows.map(publicView) });
});
router.get('/alumni/filters', viewers, async (req, res) => {
  const rows = await req.db.alumniProfile.findMany({ where: { is_public: true }, select: { programme_name: true, graduation_year: true } });
  res.json({ programmes: [...new Set(rows.map(r => r.programme_name).filter(Boolean))].sort(), years: [...new Set(rows.map(r => r.graduation_year).filter(Boolean))].sort((a, b) => b - a) });
});

// ── Staff: register, export, invitations, bulk creation, statistics ───────────────
const registerRow = p => ({ ...profileView(p), student_id: p.student_id, name: nameOf(p.student), matricule: p.student.student_number, academic_status: p.student.academic_status });
router.get('/alumni/register', manage, async (req, res) => {
  const where = alumniWhere(req.query, { publicOnly: false });
  if (req.query.public === 'true') where.is_public = true; else if (req.query.public === 'false') where.is_public = false;
  const { limit, page, skip } = paging(req.query);
  const [total, rows] = await Promise.all([
    req.db.alumniProfile.count({ where }),
    req.db.alumniProfile.findMany({ where, include: { student: { select: { first_name: true, last_name: true, student_number: true, academic_status: true } } }, orderBy: [{ graduation_year: 'desc' }, { updated_at: 'desc' }], skip, take: limit }),
  ]);
  const missing = await req.db.student.count({ where: { academic_status: 'graduated', alumni_profile: null } });
  res.json({ total, page, limit, graduated_without_profile: missing, items: rows.map(registerRow) });
});
router.get('/alumni/export.csv', manage, async (req, res) => {
  const rows = await req.db.alumniProfile.findMany({ where: alumniWhere(req.query, { publicOnly: false }), include: { student: { select: { first_name: true, last_name: true, student_number: true, academic_status: true } } }, orderBy: [{ graduation_year: 'desc' }, { updated_at: 'desc' }], take: 20000 });
  const head = ['name', 'matricule', 'academic_status', 'graduation_year', 'programme', 'employer', 'position', 'city', 'contact_email', 'linkedin_url', 'public'];
  const lines = [head.join(',')].concat(rows.map(p => [nameOf(p.student), p.student.student_number, p.student.academic_status, p.graduation_year, p.programme_name, p.employer, p.position, p.city, p.contact_email, p.linkedin_url, p.is_public ? 'yes' : 'no'].map(csvCell).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="alumni.csv"');
  await aud(req, 'alumni.export', 'alumni_profile', 'all', { after: { rows: rows.length } });
  res.send('﻿' + lines.join('\r\n'));
});
router.post('/alumni/invite', manage, async (req, res) => {
  // graduated students whose profile is missing or still empty (no employer/position) are invited to complete it
  const ids = Array.isArray(req.body.student_ids) ? req.body.student_ids.filter(x => typeof x === 'string').slice(0, 2000) : null;
  const where = { academic_status: 'graduated', ...(ids ? { id: { in: ids } } : {}), OR: [{ alumni_profile: null }, { alumni_profile: { employer: null, position: null } }] };
  const students = await req.db.student.findMany({ where, select: { id: true } });
  const users = await req.db.user.findMany({ where: { student_id: { in: students.map(s => s.id) } }, select: { id: true } });
  const sent = await notifyUsers(req.db, users.map(u => u.id), { type: 'careers', title: 'Complete your alumni profile', body: 'Share where you are now and (optionally) join the alumni directory.', link: '/student/careers' });
  await aud(req, 'alumni.invite', 'alumni_profile', 'bulk', { after: { students: students.length, notified: sent } });
  res.json({ students: students.length, notified: sent });
});
router.post('/alumni/bulk-create', manage, async (req, res) => {
  const students = await req.db.student.findMany({ where: { academic_status: 'graduated', alumni_profile: null }, include: { class: { include: { programme: true } } } });
  let created = 0;
  for (const s of students) {
    try {
      await req.db.alumniProfile.create({ data: { id: uuid(), student_id: s.id, programme_name: programmeOf(s), graduation_year: (s.updated_at ?? new Date()).getFullYear(), is_public: false } });
      created++;
    } catch (e) { if (e.code !== 'P2002') throw e; }
  }
  await aud(req, 'alumni.bulk_create', 'alumni_profile', 'bulk', { after: { created } });
  res.json({ created, graduated_total: students.length });
});
router.get('/alumni/stats', manage, async (req, res) => {
  const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).slice(0, n);
  const [profiles, graduated, base] = await Promise.all([
    req.db.alumniProfile.findMany({ select: { graduation_year: true, programme_name: true, employer: true, position: true, is_public: true } }),
    req.db.student.count({ where: { academic_status: 'graduated' } }),
    req.db.student.count({ where: { OR: [{ academic_status: 'graduated' }, { alumni_profile: { isNot: null } }] } }),
  ]);
  const responded = profiles.filter(p => p.employer || p.position);
  const employed = profiles.filter(p => p.employer);
  const group = (key, fn = x => x) => { const m = new Map(); for (const p of employed) { const k = p[key]; if (k) m.set(fn(k), (m.get(fn(k)) ?? 0) + 1); } return m; };
  const byEmp = new Map(); for (const p of employed) { const k = p.employer.trim(); const kk = k.toLowerCase(); const cur = byEmp.get(kk) ?? { name: k, count: 0 }; cur.count++; byEmp.set(kk, cur); }
  const progTotals = new Map(); for (const p of profiles) if (p.programme_name) progTotals.set(p.programme_name, (progTotals.get(p.programme_name) ?? 0) + 1);
  const yearTotals = new Map(); for (const p of profiles) if (p.graduation_year) yearTotals.set(p.graduation_year, (yearTotals.get(p.graduation_year) ?? 0) + 1);
  const n = Math.min(20, Math.max(1, parseInt(req.query.top, 10) || 5));
  res.json({
    graduated, alumni_base: base, profiles: profiles.length, public_profiles: profiles.filter(p => p.is_public).length, responded: responded.length, employed: employed.length,
    response_rate: base ? +(responded.length / base).toFixed(4) : null, employed_share: responded.length ? +(employed.length / responded.length).toFixed(4) : null,
    by_programme: top(progTotals, 50).map(([name, total]) => ({ name, total, employed: group('programme_name').get(name) ?? 0 })),
    by_year: [...yearTotals.entries()].sort((a, b) => b[0] - a[0]).map(([year, total]) => ({ year, total, employed: group('graduation_year').get(year) ?? 0 })),
    top_employers: [...byEmp.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, n),
  });
});
router.put('/alumni/:studentId', manage, async (req, res) => {   // staff correction of a register entry (e.g. graduation year)
  const s = await req.db.student.findUnique({ where: { id: req.params.studentId }, include: { class: { include: { programme: true } } } });
  if (!s) return res.status(404).json({ error: 'Student not found' });
  const d = profileData({ ...req.body, is_public: undefined });   // consent can only be changed by the alumnus
  const row = await req.db.alumniProfile.upsert({ where: { student_id: s.id }, create: { id: uuid(), student_id: s.id, programme_name: programmeOf(s), ...d }, update: { ...d, updated_at: new Date() } });
  await aud(req, 'alumni.update', 'alumni_profile', row.id, { after: d });
  res.json(profileView(row));
});

module.exports = router;
