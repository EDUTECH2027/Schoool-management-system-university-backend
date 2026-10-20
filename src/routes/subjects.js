const router = require('express').Router();
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const { v4: uuid } = require('uuid');

// Courses ("subjects") are the university's course catalogue: everyone signed in may read it,
// only administrators / academic officers may change it.
const manage = [authenticate, authorize('super_admin', 'academic_officer')];

const SEMESTERS = ['first', 'second', 'third'];
const withPrereqs = s => { const { prerequisites, ...rest } = s; return { ...rest, prerequisite_ids: (prerequisites ?? []).map(p => p.prerequisite_id) }; };
const INCLUDE = { prerequisites: { select: { prerequisite_id: true } } };

// GET /api/subjects?departmentId=&levelId=&semester=&q=&activeOnly=true
router.get('/', authenticate, async (req, res) => {
  const { departmentId, levelId, semester, q, activeOnly } = req.query;
  const where = {};
  if (departmentId) where.department_id = departmentId;
  if (levelId) where.level_id = levelId;
  if (semester) where.semester = semester;
  if (activeOnly === 'true') where.is_active = true;
  if (q) where.OR = [{ name: { contains: String(q), mode: 'insensitive' } }, { code: { contains: String(q), mode: 'insensitive' } }];
  const rows = await req.db.subject.findMany({ where, orderBy: { name: 'asc' }, include: INCLUDE });
  res.json(rows.map(withPrereqs));
});

// A coefficient must be a positive number; anything else (missing, 0, negative,
// non-numeric) falls back to 1 so a bad value can't zero out or invert a
// subject's weight in the averaging math.
const parseCoefficient = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

// Same never-zero/never-negative fallback as coefficient, defaulting to the
// standard 3-credit-hour course instead of 1.
const parseCreditHours = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 3;
};

// Would making `prereqIds` prerequisites of `subjectId` create a loop (A needs B needs A)?
async function createsCycle(db, subjectId, prereqIds) {
  const seen = new Set();
  const stack = [...prereqIds];
  while (stack.length) {
    const id = stack.pop();
    if (id === subjectId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const next = await db.coursePrerequisite.findMany({ where: { subject_id: id }, select: { prerequisite_id: true } });
    stack.push(...next.map(n => n.prerequisite_id));
  }
  return false;
}

async function validateCatalogueFields(db, body) {
  if (body.semester && !SEMESTERS.includes(body.semester)) return `semester must be one of ${SEMESTERS.join(', ')}`;
  if (body.department_id && !(await db.department.findUnique({ where: { id: body.department_id } }))) return 'Unknown department';
  if (body.level_id && !(await db.gradeLevel.findUnique({ where: { id: body.level_id } }))) return 'Unknown level';
  return null;
}

async function setPrerequisites(db, subjectId, ids) {
  const clean = [...new Set((ids ?? []).filter(Boolean))];
  if (clean.includes(subjectId)) return 'A course cannot be its own prerequisite';
  const found = await db.subject.count({ where: { id: { in: clean } } });
  if (found !== clean.length) return 'Unknown prerequisite course';
  if (await createsCycle(db, subjectId, clean)) return 'These prerequisites would create a loop';
  await db.$transaction([
    db.coursePrerequisite.deleteMany({ where: { subject_id: subjectId } }),
    ...(clean.length ? [db.coursePrerequisite.createMany({ data: clean.map(p => ({ subject_id: subjectId, prerequisite_id: p })) })] : []),
  ]);
  return null;
}

router.post('/', ...manage, async (req, res) => {
  const { name, code, coefficient, credit_hours, department_id, level_id, semester, description, is_active, prerequisite_ids } = req.body;
  if (!name || !code) return res.status(422).json({ error: 'name and code required' });
  const bad = await validateCatalogueFields(req.db, req.body);
  if (bad) return res.status(422).json({ error: bad });
  const id = uuid();
  try {
    await req.db.subject.create({
      data: {
        id, name, code, coefficient: parseCoefficient(coefficient), credit_hours: parseCreditHours(credit_hours),
        department_id: department_id || null, level_id: level_id || null, semester: semester || null,
        description: description || null, is_active: is_active !== false,
      },
    });
  } catch (e) { if (e.code === 'P2002') return res.status(409).json({ error: 'A course with this name or code already exists' }); throw e; }
  if (prerequisite_ids?.length) {
    const err = await setPrerequisites(req.db, id, prerequisite_ids);
    if (err) { await req.db.subject.delete({ where: { id } }); return res.status(422).json({ error: err }); }
  }
  res.status(201).json(withPrereqs(await req.db.subject.findUnique({ where: { id }, include: INCLUDE })));
});

router.put('/:id', ...manage, async (req, res) => {
  const current = await req.db.subject.findUnique({ where: { id: req.params.id } });
  if (!current) return res.status(404).json({ error: 'Course not found' });
  const b = req.body;
  const bad = await validateCatalogueFields(req.db, b);
  if (bad) return res.status(422).json({ error: bad });
  if (Array.isArray(b.prerequisite_ids)) {
    const err = await setPrerequisites(req.db, current.id, b.prerequisite_ids);
    if (err) return res.status(422).json({ error: err });
  }
  // Only fields that were actually sent change (the old version reset coefficient/credits to defaults when omitted).
  const data = {};
  if (b.name !== undefined) data.name = b.name;
  if (b.code !== undefined) data.code = b.code;
  if (b.coefficient !== undefined) data.coefficient = parseCoefficient(b.coefficient);
  if (b.credit_hours !== undefined) data.credit_hours = parseCreditHours(b.credit_hours);
  if (b.department_id !== undefined) data.department_id = b.department_id || null;
  if (b.level_id !== undefined) data.level_id = b.level_id || null;
  if (b.semester !== undefined) data.semester = b.semester || null;
  if (b.description !== undefined) data.description = b.description || null;
  if (b.is_active !== undefined) data.is_active = !!b.is_active;
  try { await req.db.subject.update({ where: { id: current.id }, data }); }
  catch (e) { if (e.code === 'P2002') return res.status(409).json({ error: 'A course with this name or code already exists' }); throw e; }
  res.json(withPrereqs(await req.db.subject.findUnique({ where: { id: current.id }, include: INCLUDE })));
});

// Deleting a course would cascade-delete every mark ever recorded for it, so a course with history can only be archived.
router.delete('/:id', ...manage, async (req, res) => {
  const id = req.params.id;
  const [marks, offerings] = await Promise.all([req.db.mark.count({ where: { subject_id: id } }), req.db.courseOffering.count({ where: { subject_id: id } })]);
  if (marks || offerings) {
    return res.status(409).json({ error: `This course has ${marks} recorded mark(s) and ${offerings} offering(s). Archive it (set inactive) instead of deleting it so academic history is preserved.` });
  }
  await req.db.subject.deleteMany({ where: { id } });
  res.status(204).end();
});

module.exports = router;
