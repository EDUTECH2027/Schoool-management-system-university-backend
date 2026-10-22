// Never leaks internals: 5xx messages are generic in production (the real error is logged server-side only),
// body-parser failures get a clean 4xx. Stack traces are never sent.
module.exports = function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  let status = err.status || err.statusCode || 500;
  let message = err.message;
  if (err.type === 'entity.parse.failed') { status = 400; message = 'Malformed JSON body'; }
  else if (err.type === 'entity.too.large') { status = 413; message = 'Request body too large'; }
  else if (err.type === 'charset.unsupported' || err.type === 'encoding.unsupported') { status = 415; message = 'Unsupported content encoding'; }
  if (status >= 500) {
    console.error(err);
    if (process.env.NODE_ENV === 'production') message = 'Internal server error';
  }
  res.status(status).json({ error: message || 'Internal server error' });
};
