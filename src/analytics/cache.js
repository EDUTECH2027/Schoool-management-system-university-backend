// Tiny in-memory TTL cache, keyed per school. ANALYTICS_CACHE_TTL_SEC (default 60; 0 disables caching).
// Entries are immutable snapshots; ?refresh=1 on any analytics endpoint clears every entry of that school.
const MAX_ENTRIES = 400;
const store = new Map();   // `${school}|${key}` → { value, at }
const ttl = () => { const n = Number(process.env.ANALYTICS_CACHE_TTL_SEC); return (Number.isFinite(n) && process.env.ANALYTICS_CACHE_TTL_SEC !== '' && process.env.ANALYTICS_CACHE_TTL_SEC !== undefined ? n : 60) * 1000; };

function get(school, key) {
  const e = store.get(`${school}|${key}`);
  if (!e) return null;
  if (Date.now() - e.at >= ttl()) { store.delete(`${school}|${key}`); return null; }
  return { value: e.value, cached: true, age: Math.round((Date.now() - e.at) / 1000) };
}
function set(school, key, value) {
  if (ttl() > 0) {
    if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
    store.set(`${school}|${key}`, { value, at: Date.now() });
  }
  return { value, cached: false, age: 0 };
}
function clearSchool(school) { for (const k of store.keys()) if (k.startsWith(`${school}|`)) store.delete(k); }

module.exports = { get, set, clearSchool };
