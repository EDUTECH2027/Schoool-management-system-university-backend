// Token invalidation after a password change.
// users.password_changed_at is the cut-off: a JWT issued before it is rejected. Reading it on every request would
// cost a query, so it is cached per user for AUTH_USER_CACHE_SEC and EXPLICITLY refreshed in-process whenever a
// password is changed here (another API process would notice within the TTL).
// The session that performed a self-service change keeps working: its exact token is remembered (hash only) until
// it expires — and the response of the change also carries a fresh token the client may adopt.
const crypto = require('crypto');
const cfg = require('./config');

const cache = new Map();   // `${school}:${user}` → { at, changedAt(ms|0) }
const keep = new Map();    // same key → Map(tokenHash → expiresAtMs)
const k = (school, user) => `${school}:${user}`;
const hash = t => crypto.createHash('sha256').update(t).digest('hex');

async function changedAt(db, payload) {
  const key = k(payload.school_id, payload.id);
  const hit = cache.get(key);
  const ttl = cfg.authCacheMs();
  if (hit && Date.now() - hit.at < ttl) return hit.changedAt;
  const u = await db.user.findUnique({ where: { id: payload.id }, select: { password_changed_at: true } });
  const v = u?.password_changed_at ? new Date(u.password_changed_at).getTime() : 0;
  if (cache.size > 20000) cache.clear();
  cache.set(key, { at: Date.now(), changedAt: v });
  return v;
}

function accepts(payload, token, changed) {
  if (!changed) return true;
  if ((payload.iat || 0) >= Math.floor(changed / 1000)) return true;
  const kept = keep.get(k(payload.school_id, payload.id))?.get(hash(token));
  return !!kept && kept > Date.now();
}

/** Call right after writing password_changed_at. `currentToken` (+its payload.exp) is spared for self-service changes. */
function markChanged(schoolId, userId, at = new Date(), spare) {
  const key = k(schoolId, userId);
  cache.set(key, { at: Date.now(), changedAt: at.getTime() });
  keep.delete(key);
  if (spare?.token) {
    const exp = (spare.exp ? spare.exp * 1000 : Date.now() + 86_400_000);
    keep.set(key, new Map([[hash(spare.token), exp]]));
  }
}
const forget = (schoolId, userId) => cache.delete(k(schoolId, userId));

module.exports = { changedAt, accepts, markChanged, forget };
