// Small in-memory sliding-window rate limiter (single process, like routes/documents.js). No dependency.
// A hit is recorded with hit(key); the window slides continuously, so there is no burst at a window boundary.
const registry = new Set();

class SlidingWindow {
  constructor() { this.map = new Map(); registry.add(this); }
  /** Records one hit and returns { allowed, count, retryAfterMs }. */
  hit(key, max, windowMs, now = Date.now()) {
    const arr = (this.map.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= max) { this.map.set(key, arr); return { allowed: false, count: arr.length, retryAfterMs: Math.max(1, windowMs - (now - arr[0])) }; }
    arr.push(now); this.map.set(key, arr);
    return { allowed: true, count: arr.length, retryAfterMs: 0 };
  }
  /** Peek without recording. */
  count(key, windowMs, now = Date.now()) { return (this.map.get(key) || []).filter(t => now - t < windowMs).length; }
  reset(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
  sweep(maxAgeMs, now = Date.now()) {
    for (const [k, arr] of this.map) { if (!arr.length || now - arr[arr.length - 1] > maxAgeMs) this.map.delete(k); }
  }
}

const timer = setInterval(() => { for (const w of registry) w.sweep(3_600_000); }, 60_000);
timer.unref?.();

module.exports = { SlidingWindow };
