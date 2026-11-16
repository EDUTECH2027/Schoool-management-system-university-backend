// Executive analytics. Read-only; see docs/ANALYTICS.md.
//   academic/operational endpoints: super_admin + academic_officer      finance: super_admin + finance_officer
const router = require('express').Router();
const authenticate = require('../middleware/auth');
const authorize = require('../middleware/authorize');
const engine = require('../analytics/engine');
const cache = require('../analytics/cache');
const { sendCsv } = require('../analytics/csv');
const { schemaNameFor } = require('../db/tenantSchema');

const academic = [authenticate, authorize('super_admin', 'academic_officer')];
const money = [authenticate, authorize('super_admin', 'finance_officer')];

// Runs `compute` (cached per school + endpoint + filters, TTL ANALYTICS_CACHE_TTL_SEC; ?refresh=1 recomputes and
// drops every cached entry of the school) and answers JSON, or CSV with ?format=csv[&table=<name>].
function endpoint(name, compute, paramNames = []) {
  return async (req, res) => {
    let f;
    try { f = await engine.resolveFilters(req.db, req.query); } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); throw e; }
    const extra = Object.fromEntries(paramNames.filter(p => req.query[p] !== undefined).map(p => [p, req.query[p]]));
    const key = `${name}|${JSON.stringify([f.echo, extra])}`;
    if (req.query.refresh === '1') cache.clearSchool(req.user.school_id);
    let hit = cache.get(req.user.school_id, key);
    if (!hit) {
      const t0 = process.hrtime.bigint();
      // The engine uses raw SQL with unqualified table names, but the pooled connection's search_path is `public`
      // (Prisma's ?schema= only qualifies ORM queries). Pin the tenant schema for the duration of one transaction.
      const schema = schemaNameFor(req.user.school_id);
      const data = await req.db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}", public`);
        return compute(tx, f, extra);
      }, { timeout: 60000, maxWait: 10000 });
      hit = cache.set(req.user.school_id, key, { filters: f.echo, ...data, generated_at: new Date().toISOString(), compute_ms: Number(process.hrtime.bigint() - t0) / 1e6 | 0 });
      res.set('X-Cache', 'miss');
    } else res.set('X-Cache', 'hit');
    if (req.query.format === 'csv') {
      const tables = engine.TABLES[name];
      if (!tables) return res.status(422).json({ error: 'This endpoint has no tabular export' });
      const t = req.query.table || Object.keys(tables)[0];
      if (!tables[t]) return res.status(422).json({ error: `table must be one of ${Object.keys(tables).join(', ')}` });
      return sendCsv(res, `analytics-${name}-${t}-${new Date().toISOString().slice(0, 10)}.csv`, tables[t](hit.value));
    }
    res.json({ ...hit.value, cached: hit.cached, cache_age_seconds: hit.age });
  };
}

// Filter bar options: any analytics reader (finance officers need the year list too).
router.get('/filters', authenticate, authorize('super_admin', 'academic_officer', 'finance_officer'), async (req, res) => res.json(await engine.filterOptions(req.db)));

router.get('/overview', ...academic, endpoint('overview', (db, f) => engine.overview(db, f)));
router.get('/academics', ...academic, endpoint('academics', (db, f, x) => engine.academics(db, f, x), ['min_sample']));
router.get('/attendance', ...academic, endpoint('attendance', (db, f, x) => engine.attendance(db, f, x), ['threshold', 'min_records']));
router.get('/exams', ...academic, endpoint('exams', (db, f) => engine.exams(db, f)));
router.get('/trends', ...academic, endpoint('trends', (db, f) => engine.trends(db, f)));
router.get('/finance', ...money, endpoint('finance', (db, f) => engine.finance(db, f)));

module.exports = router;
