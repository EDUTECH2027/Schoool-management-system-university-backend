// In-process outbox worker: sends queued EmailOutbox rows through SMTP for every active tenant.
// - SMTP not configured → rows become `skipped` (reason stored) — nothing is pretended.
// - A failed attempt stores the error and keeps the row `queued` until MAX_ATTEMPTS, then `failed`.
// - Each row is claimed atomically (attempts bump guarded by the previous value), so two API instances cannot double-send.
// Disabled with MAIL_WORKER=off. Interval: MAIL_WORKER_INTERVAL_MS (default 30000).
const platformClient = require('../db/platformClient');
const tenantPool = require('../db/tenantPool');
const mailer = require('../utils/mailer');

const MAX_ATTEMPTS = 3;
const BATCH = 50;
const SKIP_REASON = 'SMTP is not configured (set SMTP_HOST and SMTP_FROM)';

async function runOnce(db, { send = mailer.send, configured = mailer.isConfigured } = {}) {
  const res = { sent: 0, failed: 0, retry: 0, skipped: 0 };
  if (!configured()) {
    const r = await db.emailOutbox.updateMany({ where: { status: 'queued' }, data: { status: 'skipped', error: SKIP_REASON } });
    res.skipped = r.count; return res;
  }
  const rows = await db.emailOutbox.findMany({ where: { status: 'queued', attempts: { lt: MAX_ATTEMPTS } }, orderBy: { created_at: 'asc' }, take: BATCH });
  for (const m of rows) {
    const claim = await db.emailOutbox.updateMany({ where: { id: m.id, status: 'queued', attempts: m.attempts }, data: { attempts: m.attempts + 1 } });
    if (claim.count === 0) continue;
    try {
      await send({ to: m.to_email, subject: m.subject, text: m.body });
      await db.emailOutbox.update({ where: { id: m.id }, data: { status: 'sent', sent_at: new Date(), error: null } }); res.sent++;
    } catch (e) {
      const last = m.attempts + 1 >= MAX_ATTEMPTS;
      await db.emailOutbox.update({ where: { id: m.id }, data: { status: last ? 'failed' : 'queued', error: String(e.message || e).slice(0, 500) } });
      last ? res.failed++ : res.retry++;
    }
  }
  return res;
}

let timer = null;
async function tick() {
  if (!mailer.isConfigured()) return;   // nothing can be sent: rows are recorded as skipped when queued; skip the per-tenant sweep
  try {
    const schools = await platformClient.school.findMany({ where: { status: 'active' }, select: { id: true } });
    for (const sc of schools) {
      try { await runOnce(tenantPool.getOrOpen(sc.id)); } catch (e) { console.error(`[mail] ${sc.id}:`, e.message); }
    }
  } catch (e) { console.error('[mail] tick failed:', e.message); }
}

function start(intervalMs = Number(process.env.MAIL_WORKER_INTERVAL_MS) || 30_000) {
  if (timer || String(process.env.MAIL_WORKER || 'on').toLowerCase() === 'off') return null;
  timer = setInterval(tick, intervalMs); timer.unref();
  return timer;
}

module.exports = { runOnce, start, tick, MAX_ATTEMPTS, SKIP_REASON };
