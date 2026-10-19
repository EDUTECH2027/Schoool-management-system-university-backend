// Background job: re-checks payments that are still open with their provider and expires the ones that never
// completed (also catches notifications that were lost). Safe to run in several instances: every state change
// is a compare-and-set in service.applyResult().
const platformClient = require('../db/platformClient');
const tenantPool = require('../db/tenantPool');
const svc = require('./service');

function start(intervalMs = 60_000) {
  const tick = async () => {
    try {
      const schools = await platformClient.school.findMany({ where: { status: 'active' }, select: { id: true } });
      for (const s of schools) {
        try { await svc.sweepOpen(tenantPool.getOrOpen(s.id)); } catch (e) { console.error(`[payments] sweep ${s.id}:`, e.message); }
      }
    } catch (e) { console.error('[payments] reconciler tick failed:', e.message); }
  };
  const t = setInterval(tick, intervalMs); t.unref(); return t;
}
module.exports = { start };
