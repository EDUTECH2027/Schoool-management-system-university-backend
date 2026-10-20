// Official documents: issue (academic officers/administrators), list, revoke, QR code — and the PUBLIC verifier.
const router = require('express').Router();
const QRCode = require('qrcode');
const { v4: uuid } = require('uuid');
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const platformClient = require('../db/platformClient');
const tenantPool = require('../db/tenantPool');
const docs = require('../academics/documents');
const { audit } = require('../academics/registration');
const { actorOf } = require('../academics/results');

const approvers = [authenticate, authorize('super_admin', 'academic_officer')];
const verifyUrl = code => `${(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '')}/verify/${code}`;
const dto = d => ({ id: d.id, code: d.code, type: d.type, student_id: d.student_id, status: d.status, issued_at: d.issued_at, issued_by_name: d.issued_by_name, revoked_at: d.revoked_at, revoked_reason: d.revoked_reason, verify_url: verifyUrl(d.code) });

// POST /api/documents/issue { student_id, type, term_id?, academic_year_id? }
router.post('/issue', ...approvers, async (req, res) => {
  const { student_id, type, term_id, academic_year_id } = req.body;
  if (!docs.TYPES.includes(type)) return res.status(422).json({ error: `type must be one of ${docs.TYPES.join(', ')}` });
  const student = await docs.loadStudent(req.db, student_id);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  const payload = await docs.buildPayload(req.db, type, student, { termId: term_id, academicYearId: academic_year_id });
  if (payload.error) return res.status(422).json({ error: payload.error });
  let doc;
  for (let i = 0; i < 3; i++) {
    try {
      doc = await req.db.officialDocument.create({ data: { id: uuid(), code: docs.newCode(req.user.school_id), type, student_id: student.id, term_id: term_id || null, academic_year_id: academic_year_id || null, payload, issued_by: req.user.id, issued_by_name: req.user.name } });
      break;
    } catch (e) { if (e.code !== 'P2002') throw e; }
  }
  if (!doc) return res.status(500).json({ error: 'Could not allocate a verification code, try again.' });
  await audit(req.db, actorOf(req.user), 'document.issue', 'official_document', doc.id, { after: { type, code: doc.code, student_id: student.id } });
  res.status(201).json({ ...dto(doc), payload: doc.payload, qr: await QRCode.toDataURL(verifyUrl(doc.code), { margin: 1, width: 240 }) });
});

router.get('/', ...approvers, async (req, res) => {
  const where = {};
  if (req.query.student_id) where.student_id = String(req.query.student_id);
  if (req.query.type) where.type = String(req.query.type);
  const rows = await req.db.officialDocument.findMany({ where, orderBy: { issued_at: 'desc' }, take: 200, include: { student: { select: { first_name: true, last_name: true, student_number: true } } } });
  res.json(rows.map(d => ({ ...dto(d), student: `${d.student.first_name} ${d.student.last_name}`, matricule: d.student.student_number })));
});

// A student's own issued documents (read-only)
router.get('/me', authenticate, authorize('student'), async (req, res) => {
  const rows = await req.db.officialDocument.findMany({ where: { student_id: req.user.student_id, status: 'issued' }, orderBy: { issued_at: 'desc' } });
  res.json(rows.map(dto));
});

router.get('/:id', authenticate, authorize('super_admin', 'academic_officer', 'student'), async (req, res) => {
  const d = await req.db.officialDocument.findUnique({ where: { id: req.params.id } });
  if (!d || (req.user.role === 'student' && (d.student_id !== req.user.student_id || d.status !== 'issued'))) return res.status(404).json({ error: 'Document not found' });
  res.json({ ...dto(d), payload: d.payload, qr: await QRCode.toDataURL(verifyUrl(d.code), { margin: 1, width: 240 }) });
});

router.post('/:id/revoke', ...approvers, async (req, res) => {
  if (!req.body.reason?.trim()) return res.status(422).json({ error: 'A reason is required.' });
  const d = await req.db.officialDocument.findUnique({ where: { id: req.params.id } });
  if (!d) return res.status(404).json({ error: 'Document not found' });
  if (d.status === 'revoked') return res.status(409).json({ error: 'Already revoked.' });
  await req.db.officialDocument.update({ where: { id: d.id }, data: { status: 'revoked', revoked_at: new Date(), revoked_reason: req.body.reason.trim() } });
  await audit(req.db, actorOf(req.user), 'document.revoke', 'official_document', d.id, { reason: req.body.reason });
  res.json({ ok: true });
});

// ── Public verification (no login) ────────────────────────────────────────────────
const hits = new Map();   // ip → [timestamps]; 30 checks / minute / address
function limited(ip) {
  const now = Date.now(); const arr = (hits.get(ip) ?? []).filter(t => now - t < 60_000);
  arr.push(now); hits.set(ip, arr); if (hits.size > 5000) hits.clear();
  return arr.length > 30;
}
const mask = m => (m ? `${'•'.repeat(Math.max(0, m.length - 3))}${m.slice(-3)}` : null);

const verifyRouter = require('express').Router();
verifyRouter.get('/:code', async (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'Too many checks. Try again in a minute.' });
  const parsed = docs.parseCode(req.params.code);
  if (!parsed) return res.status(404).json({ valid: false });
  const schools = await platformClient.school.findMany({ where: { id: { startsWith: parsed.prefix }, status: 'active' }, select: { id: true }, take: 5 });
  for (const s of schools) {
    const db = tenantPool.getOrOpen(s.id);
    const d = await db.officialDocument.findUnique({ where: { code: parsed.code }, include: { student: { include: { class: { include: { programme: true } } } } } });
    if (!d) continue;
    const school = await db.school.findFirst({ select: { name: true } });
    // Minimal disclosure: enough to confirm the document is genuine and who it was issued to — never grades.
    return res.json({
      valid: d.status === 'issued', status: d.status, type: d.type, code: d.code, issued_at: d.issued_at, school: school?.name ?? null,
      student: d.status === 'issued' ? { name: `${d.student.first_name} ${d.student.last_name}`, matricule: mask(d.student.student_number), programme: d.student.class?.programme?.name ?? null } : null,
    });
  }
  res.status(404).json({ valid: false });
});

module.exports = router;
module.exports.verifyRouter = verifyRouter;
