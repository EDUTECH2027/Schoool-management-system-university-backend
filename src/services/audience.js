// Resolves a broadcast audience ({roles, programme_ids, class_ids, offering_ids}; union of all criteria) to distinct user ids.
const ROLES = ['super_admin', 'academic_officer', 'finance_officer', 'librarian', 'teacher', 'student', 'parent'];
const MAX_RECIPIENTS = Number(process.env.BROADCAST_MAX_RECIPIENTS) || 5000;
const MAX_IDS = 50;

class AudienceError extends Error { constructor(message, status = 422) { super(message); this.status = status; } }

function clean(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AudienceError('audience must be an object.');
  const list = (k, check) => {
    const v = raw[k] ?? [];
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x)) throw new AudienceError(`audience.${k} must be a list of ids.`);
    const u = [...new Set(v)];
    if (u.length > MAX_IDS) throw new AudienceError(`audience.${k} accepts at most ${MAX_IDS} entries.`);
    if (check) for (const x of u) if (!check(x)) throw new AudienceError(`Unknown ${k.replace(/s$/, '')}: ${x}`);
    return u;
  };
  const roles = list('roles', r => ROLES.includes(r) || r === 'head_teacher');
  const a = { roles: roles.includes('super_admin') ? [...new Set([...roles, 'head_teacher'])] : roles, programme_ids: list('programme_ids'), class_ids: list('class_ids'), offering_ids: list('offering_ids') };
  if (!a.roles.length && !a.programme_ids.length && !a.class_ids.length && !a.offering_ids.length) throw new AudienceError('Choose at least one audience: a role, programme, class or course offering.');
  return a;
}

/** → { audience, userIds, breakdown:{roles,programmes,classes,offerings} }. Throws AudienceError for unknown ids / too many recipients. */
async function resolve(db, rawAudience) {
  const a = clean(rawAudience);
  const [progs, classes, offs] = await Promise.all([
    a.programme_ids.length ? db.programme.findMany({ where: { id: { in: a.programme_ids } }, select: { id: true } }) : [],
    a.class_ids.length ? db.class.findMany({ where: { id: { in: a.class_ids } }, select: { id: true } }) : [],
    a.offering_ids.length ? db.courseOffering.findMany({ where: { id: { in: a.offering_ids } }, select: { id: true } }) : [],
  ]);
  for (const [key, ids, found] of [['programme', a.programme_ids, progs], ['class', a.class_ids, classes], ['offering', a.offering_ids, offs]]) {
    const have = new Set(found.map(x => x.id)); const miss = ids.find(i => !have.has(i));
    if (miss) throw new AudienceError(`Unknown ${key}: ${miss}`);
  }
  const sets = { roles: [], programmes: [], classes: [], offerings: [] };
  const ids = u => u.map(x => x.id);
  if (a.roles.length) sets.roles = ids(await db.user.findMany({ where: { OR: [{ role: { in: a.roles.filter(r => r !== 'student') } }, ...(a.roles.includes('student') ? [{ role: 'student', student: { is_active: true } }] : [])] }, select: { id: true } }));
  if (a.programme_ids.length) sets.programmes = ids(await db.user.findMany({ where: { role: 'student', student: { is_active: true, class: { programme_id: { in: a.programme_ids } } } }, select: { id: true } }));
  if (a.class_ids.length) sets.classes = ids(await db.user.findMany({ where: { role: 'student', student: { is_active: true, class_id: { in: a.class_ids } } }, select: { id: true } }));
  if (a.offering_ids.length) sets.offerings = ids(await db.user.findMany({ where: { role: 'student', student: { is_active: true, enrollments: { some: { offering_id: { in: a.offering_ids }, status: 'registered' } } } }, select: { id: true } }));
  const userIds = [...new Set(Object.values(sets).flat())];
  if (userIds.length > MAX_RECIPIENTS) throw new AudienceError(`This audience has ${userIds.length} recipients; the limit is ${MAX_RECIPIENTS}. Narrow it down.`);
  return { audience: a, userIds, breakdown: Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, new Set(v).size])) };
}

module.exports = { resolve, clean, AudienceError, ROLES, MAX_RECIPIENTS };
