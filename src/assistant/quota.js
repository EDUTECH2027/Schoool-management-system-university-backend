// Per-user daily quota in assistant_usage (one row per user and UTC day). The counter is incremented FIRST with an
// atomic upsert and the result compared with the limit, so concurrent requests can never exceed it.
const { v4: uuid } = require('uuid');

const today = () => new Date().toISOString().slice(0, 10);
const key = (user_id, day) => ({ user_id_day: { user_id, day } });

async function bump(db, user_id, day) {
  const args = { where: key(user_id, day), create: { id: uuid(), user_id, day, requests: 1 }, update: { requests: { increment: 1 } }, select: { requests: true } };
  try { return await db.assistantUsage.upsert(args); }
  catch (e) { if (e.code === 'P2002') return db.assistantUsage.upsert({ ...args, create: { ...args.create, id: uuid() } }); throw e; }
}

/** Takes one request from today's quota. → { ok, used } (used = requests counted today including this one when ok). */
async function consume(db, user_id, limit) {
  const day = today();
  const row = await bump(db, user_id, day);
  if (row.requests > limit) { await refund(db, user_id, day); return { ok: false, used: Math.min(limit, row.requests - 1), day }; }
  return { ok: true, used: row.requests, day };
}
const refund = (db, user_id, day = today()) => db.assistantUsage.updateMany({ where: { user_id, day, requests: { gt: 0 } }, data: { requests: { decrement: 1 } } });
const addTokens = (db, user_id, day, tokens) => (tokens > 0 ? db.assistantUsage.updateMany({ where: { user_id, day }, data: { tokens: { increment: tokens } } }) : Promise.resolve(null));
async function usedToday(db, user_id) { return (await db.assistantUsage.findUnique({ where: key(user_id, today()), select: { requests: true } }))?.requests ?? 0; }

module.exports = { consume, refund, addTokens, usedToday, today };
