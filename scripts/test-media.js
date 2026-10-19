// Tests for the performance-related backend pieces: thumbnails, upload caching, compression, forum pagination /
// media gallery API, DB indexes. Same setup as test-elearning.js / test-payments.js (local scratch Postgres + live API).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { v4: uuid } = require('uuid');
const { Client } = require('pg');

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL || '')) { console.error('Refusing to run: DATABASE_URL must be a local scratch database.'); process.exit(2); }
const platformClient = require('../src/db/platformClient');
const tenantPool = require('../src/db/tenantPool');
const { provisionTenantSchema } = require('../src/db/provisionTenant');

const BASE = process.env.API_URL || 'http://127.0.0.1:3099';
const SECRET = process.env.JWT_SECRET || 'dev_secret';
let pass = 0, fail = 0;
const check = (l, c, d) => { if (c) { pass++; console.log(`  [OK]   ${l}`); } else { fail++; console.error(`  [FAIL] ${l}${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 300) : ''}`); } };
const section = t => console.log(`\n── ${t}`);
const rawGet = (url, headers) => new Promise((resolve, reject) => http.get(`${BASE}${url}`, { headers }, res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) })); }).on('error', reject));
const api = async (url, { token, headers = {}, raw } = {}) => { const r = await fetch(`${BASE}${url}`, { headers: { ...(token && { Authorization: `Bearer ${token}` }), ...headers } }); if (raw) return r; let b = null; const t = await r.text(); try { b = JSON.parse(t); } catch { b = t; } return { status: r.status, body: b, headers: r.headers }; };

(async () => {
  const schoolId = uuid();
  await platformClient.school.create({ data: { id: schoolId, name: 'Media', email: `${schoolId}@t.local`, admin_name: 'A', admin_email: `a-${schoolId}@t.local`, status: 'active' } });
  await provisionTenantSchema(schoolId);
  const db = tenantPool.getOrOpen(schoolId);
  const admin = await db.user.create({ data: { id: uuid(), name: 'Admin', email: `adm-${schoolId}@t.local`, password_hash: 'x', role: 'super_admin', initials: 'AD' } });
  const token = jwt.sign({ id: admin.id, email: admin.email, role: 'super_admin', name: 'Admin', initials: 'AD', school_id: schoolId, scope: 'tenant', teacher_id: null, student_id: null, parent_id: null, must_change_password: false }, SECRET, { expiresIn: '1h' });

  const root = path.join(__dirname, '..', 'uploads', schoolId, 'forums');
  fs.mkdirSync(root, { recursive: true });
  const big = path.join(root, `${uuid()}.jpg`);
  await sharp({ create: { width: 2400, height: 1800, channels: 3, noise: { type: 'gaussian', mean: 120, sigma: 40 } } }).jpeg({ quality: 88 }).toFile(big);
  const bigRel = `${schoolId}/forums/${path.basename(big)}`;
  const origSize = fs.statSync(big).size;
  fs.writeFileSync(path.join(root, 'notes.txt'), 'plain text, not an image');

  section('Thumbnails');
  let r = await api(`/uploads/_t/256/${bigRel}`, { raw: true });
  const buf = Buffer.from(await r.arrayBuffer());
  check('thumbnail served as WebP', r.status === 200 && r.headers.get('content-type') === 'image/webp' && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP');
  check('thumbnail is dramatically smaller than the original', buf.length < origSize / 15, [buf.length, origSize]);
  const meta = await sharp(buf).metadata();
  check('resized to the requested width, aspect ratio kept', meta.width === 256 && Math.abs(meta.height - 192) <= 1, [meta.width, meta.height]);
  check('1-year immutable cache header', /max-age=31536000/.test(r.headers.get('cache-control')) && /immutable/.test(r.headers.get('cache-control')));
  const t0 = Date.now(); const again = await api(`/uploads/_t/256/${bigRel}`, { raw: true }); await again.arrayBuffer();
  check('second request is served from the disk cache (fast)', again.status === 200 && Date.now() - t0 < 300, Date.now() - t0);
  const cacheDir = path.join(__dirname, '..', '.cache', 'thumbs', '256');
  check('cached thumbnail exists on disk exactly once', fs.readdirSync(cacheDir).filter(f => f.includes(path.basename(big))).length === 1);
  const burst = await Promise.all(Array.from({ length: 20 }, () => api(`/uploads/_t/128/${bigRel}`, { raw: true }).then(x => x.arrayBuffer().then(() => x.status))));
  check('20 simultaneous first requests for one thumbnail all succeed (de-duplicated generation)', burst.every(s => s === 200), burst);
  check('1024 px thumbnail does not enlarge beyond the original and is capped', (await sharp(Buffer.from(await (await api(`/uploads/_t/1024/${bigRel}`, { raw: true })).arrayBuffer())).metadata()).width === 1024);
  const small = path.join(root, `${uuid()}.png`); await sharp({ create: { width: 40, height: 40, channels: 3, background: '#c00' } }).png().toFile(small);
  check('a small image is never up-scaled', (await sharp(Buffer.from(await (await api(`/uploads/_t/512/${schoolId}/forums/${path.basename(small)}`, { raw: true })).arrayBuffer())).metadata()).width === 40);
  check('unsupported width → 400', (await api(`/uploads/_t/100/${bigRel}`)).status === 400);
  check('width "abc" → 400', (await api(`/uploads/_t/abc/${bigRel}`)).status === 400);
  check('missing file → 404', (await api(`/uploads/_t/64/${schoolId}/forums/nope.jpg`)).status === 404);
  check('non-image file (txt) → 404', (await api(`/uploads/_t/64/${schoolId}/forums/notes.txt`)).status === 404);
  check('path traversal (..%2f) → 404', (await api(`/uploads/_t/64/${schoolId}/forums/..%2f..%2f..%2f.env`)).status === 404);
  check('path traversal (raw ..) cannot reach .env', (await api(`/uploads/_t/64/../../../.env`)).status === 404);
  check('thumbnail cache directory is not served by the static route', (await api(`/uploads/.thumbs/256/${bigRel.replace(/\//g, '__')}.webp`)).status === 404);
  fs.writeFileSync(path.join(root, 'corrupt.jpg'), 'this is not a jpeg');
  check('corrupt image → clean 404 (client falls back to placeholder), server stays up', (await api(`/uploads/_t/64/${schoolId}/forums/corrupt.jpg`)).status === 404 && (await api('/api/health')).status === 200);

  section('Originals & caching');
  r = await api(`/uploads/${bigRel}`, { raw: true });
  check('original still downloadable at full size', r.status === 200 && Number(r.headers.get('content-length')) === origSize);
  check('originals carry long-lived immutable caching', /immutable/.test(r.headers.get('cache-control')) && /max-age=31536000/.test(r.headers.get('cache-control')));
  const etag = r.headers.get('etag'); await r.arrayBuffer();
  const cond = await rawGet(`/uploads/${bigRel}`, { 'If-None-Match': etag });
  check('conditional GET → 304 Not Modified', !!etag && cond.status === 304, [etag, cond.status]);

  section('Compression');
  const th = await db.forumThread.create({ data: { id: uuid(), title: 'Gallery', tag: 'general', author: 'Admin', author_id: admin.id } });
  const ids = [];
  for (let i = 0; i < 60; i++) {
    const f = `${uuid()}.jpg`; fs.copyFileSync(big, path.join(root, f));
    const m = await db.forumMessage.create({ data: { id: uuid(), thread_id: th.id, author: 'Admin', author_id: admin.id, type: i % 10 === 0 ? 'video' : 'image', image_url: i % 10 === 0 ? null : `/uploads/${schoolId}/forums/${f}`, video_url: i % 10 === 0 ? `/uploads/${schoolId}/forums/${f}` : null, created_at: new Date(Date.now() - (60 - i) * 60_000) } });
    ids.push(m.id);
  }
  const gzRes = await rawGet(`/api/forums/threads/${th.id}/messages`, { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip' });
  const plainRes = await rawGet(`/api/forums/threads/${th.id}/messages`, { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'identity' });
  check('large JSON is gzip-compressed on the wire', gzRes.headers['content-encoding'] === 'gzip' && JSON.parse(zlib.gunzipSync(gzRes.body)).length === 60, gzRes.headers['content-encoding']);
  check('compression shrinks the payload substantially', gzRes.body.length < plainRes.body.length / 3, [gzRes.body.length, plainRes.body.length]);
  const imgRes = await rawGet(`/uploads/_t/256/${bigRel}`, { 'Accept-Encoding': 'gzip' });
  check('images are not re-compressed', !imgRes.headers['content-encoding']);

  section('Forum messages: pagination (backward compatible)');
  r = await api(`/api/forums/threads/${th.id}/messages`, { token });
  check('legacy call (no limit) still returns the whole thread, oldest first', r.body.length === 60 && r.body[0].id === ids[0] && r.body[59].id === ids[59]);
  r = await api(`/api/forums/threads/${th.id}/messages?limit=25`, { token });
  check('limit=25 → newest 25, oldest→newest, X-Has-More: 1', r.body.length === 25 && r.body[0].id === ids[35] && r.body[24].id === ids[59] && r.headers.get('x-has-more') === '1', [r.body.length, r.headers.get('x-has-more')]);
  r = await api(`/api/forums/threads/${th.id}/messages?limit=25&before=${ids[35]}`, { token });
  check('before=<oldest loaded> → the 25 preceding messages, no overlap', r.body.length === 25 && r.body[0].id === ids[10] && r.body[24].id === ids[34] && r.headers.get('x-has-more') === '1');
  r = await api(`/api/forums/threads/${th.id}/messages?limit=25&before=${ids[10]}`, { token });
  check('last page → 10 messages and X-Has-More: 0', r.body.length === 10 && r.body[0].id === ids[0] && r.headers.get('x-has-more') === '0');
  check('limit is capped (limit=9999 → ≤200)', (await api(`/api/forums/threads/${th.id}/messages?limit=9999`, { token })).body.length === 60);
  check('X-Has-More is exposed to browsers via CORS', /x-has-more/i.test((await api(`/api/health`, { headers: { Origin: 'http://example.test' }, raw: true })).headers.get('access-control-expose-headers') || ''));

  section('Forum media gallery API');
  r = await api(`/api/forums/threads/${th.id}/media?limit=24`, { token });
  check('media: newest first, 24 per page, cursor for the next page', r.status === 200 && r.body.items.length === 24 && !!r.body.next && r.body.items[0].id === ids[59]);
  check('media items carry kind + original url + author', r.body.items.every(i => ['image', 'video'].includes(i.kind) && i.url.startsWith('/uploads/') && i.author === 'Admin'));
  const seen = new Set(r.body.items.map(i => i.id)); let cursor = r.body.next, pages = 1, dupes = 0;
  while (cursor) { const p = await api(`/api/forums/threads/${th.id}/media?limit=24&cursor=${cursor}`, { token }); p.body.items.forEach(i => { if (seen.has(i.id)) dupes++; seen.add(i.id); }); cursor = p.body.next; pages++; }
  check('paging by cursor visits all 60 items exactly once (3 pages)', seen.size === 60 && dupes === 0 && pages === 3, [seen.size, dupes, pages]);
  r = await api(`/api/forums/threads/${th.id}/media?kind=video&limit=60`, { token });
  check('kind=video filter → only the 6 videos', r.body.items.length === 6 && r.body.items.every(i => i.kind === 'video'), r.body.items.length);
  r = await api(`/api/forums/threads/${th.id}/media?kind=image&limit=60`, { token });
  check('kind=image filter → only the 54 images', r.body.items.length === 54 && r.body.items.every(i => i.kind === 'image'));
  check('media endpoint requires auth → 401', (await api(`/api/forums/threads/${th.id}/media`)).status === 401);

  section('Database indexes');
  const pg = new Client({ connectionString: process.env.DATABASE_URL }); await pg.connect();
  const schema = `tenant_${schoolId.replace(/-/g, '')}`;
  const idx = (await pg.query('select indexname from pg_indexes where schemaname=$1', [schema])).rows.map(x => x.indexname);
  for (const name of ['fee_records_status_idx', 'fee_records_class_id_idx', 'fee_records_academic_year_idx', 'students_is_active_idx', 'forum_messages_thread_id_created_at_idx', 'payments_fee_record_id_idx', 'payment_transactions_status_created_at_idx']) check(`index ${name} exists`, idx.includes(name));
  await pg.end();

  console.log(`\n${pass} passed, ${fail} failed`);
  await platformClient.$disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('TEST CRASHED:', e); process.exit(1); });
