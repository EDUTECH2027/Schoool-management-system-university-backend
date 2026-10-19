// On-demand image thumbnails for files under /uploads (student photos, forum images…).
//   GET /uploads/_t/<width>/<school>/<folder>/<file>   →  WebP, resized to <width> (never enlarged)
//
// Browsing a list of 100 avatars used to download 100 full-size photos (1–10 MB each). Thumbnails are
// generated once with sharp, cached on disk, and served with a 1-year immutable cache header (stored
// file names are random UUIDs, so a URL's content never changes). Originals stay reachable at /uploads/….
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

sharp.cache({ files: 0, items: 50, memory: 100 });   // keep sharp's memory use modest on small hosts
sharp.concurrency(2);

const UPLOADS_ROOT = path.join(__dirname, '..', '..', 'uploads');
// Generated thumbnails live OUTSIDE the public uploads tree (git-ignored, safe to delete: they are re-created on demand).
const CACHE_ROOT = path.join(__dirname, '..', '..', '.cache', 'thumbs');
const WIDTHS = new Set([64, 128, 256, 512, 1024]);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif']);
const inflight = new Map();   // dedupe concurrent requests for the same thumbnail

async function build(src, dest, width) {
  const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await sharp(src, { failOn: 'none' })
    .rotate()                                            // honour EXIF orientation
    .resize({ width, height: width * 4, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 76 })
    .toFile(tmp);
  fs.renameSync(tmp, dest);                              // atomic: readers never see a half-written file
}

async function handler(req, res) {
  const width = Number(req.params.width);
  if (!WIDTHS.has(width)) return res.status(400).json({ error: `width must be one of ${[...WIDTHS].join(', ')}` });
  const rel = req.params[0] || '';
  const src = path.resolve(UPLOADS_ROOT, rel);
  const ext = path.extname(src).toLowerCase();
  // path-traversal guard + only real image files outside the thumbnail cache itself
  if (!src.startsWith(UPLOADS_ROOT + path.sep) || !IMAGE_EXT.has(ext)) return res.status(404).end();
  if (!fs.existsSync(src)) return res.status(404).end();

  const dest = path.join(CACHE_ROOT, String(width), `${rel.replace(/[\\/]/g, '__')}.webp`);
  try {
    if (!fs.existsSync(dest)) {
      const key = dest;
      if (!inflight.has(key)) inflight.set(key, build(src, dest, width).finally(() => inflight.delete(key)));
      await inflight.get(key);
    }
  } catch (e) {
    console.error('[thumbnails]', rel, e.message);
    return res.status(404).end();   // unreadable/corrupt image: client falls back to its placeholder
  }
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Type', 'image/webp');
  res.sendFile(dest, { dotfiles: 'allow' });
}

module.exports = { handler, UPLOADS_ROOT };
