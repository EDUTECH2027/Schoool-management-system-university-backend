// Course-material uploads. Files are kept IN THE DATABASE (elearning_resources.file_data),
// not on disk: hosts with an ephemeral filesystem (Render free plan) wipe local files on every
// deploy/restart. They are served only through an authorised route.
const multer = require('multer');

const MAX_MB = Number(process.env.ELEARNING_MAX_UPLOAD_MB || 10);

// extension -> content type we serve it as (never trust the client's mimetype)
const TYPES = {
  '.pdf': 'application/pdf',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.zip': 'application/zip',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
};
// only these may be rendered in the browser; everything else is forced to download
const INLINE_OK = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.mp4', '.webm', '.mp3', '.txt']);

const extOf = name => { const i = String(name).lastIndexOf('.'); return i < 0 ? '' : String(name).slice(i).toLowerCase(); };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 },
  fileFilter(_req, file, cb) {
    const ext = extOf(file.originalname);
    if (TYPES[ext]) return cb(null, true);
    const err = new Error(`File type "${ext || 'unknown'}" is not allowed. Allowed: ${Object.keys(TYPES).join(' ')}`);
    err.status = 422;
    cb(err);
  },
});

// Wrap multer so size/type problems come back as clean 4xx JSON.
function uploadSingle(field) {
  return (req, res, next) => upload.single(field)(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: `File too large (max ${MAX_MB} MB)` });
    return res.status(err.status || 400).json({ error: err.message });
  });
}

module.exports = { uploadSingle, TYPES, INLINE_OK, MAX_MB, extOf };
