// In-app AI help assistant (providers: Qoder Cloud Agents or Anthropic Messages API, see assistant/llm.js). Read-only: it answers questions, it never changes data.
// No conversation content is stored: only a per-user daily request/token counter (assistant_usage). See docs/ASSISTANT.md.
const router = require('express').Router();
const authenticate = require('../middleware/auth');
const { SlidingWindow } = require('../security/limiter');
const llm = require('../assistant/llm');
const quota = require('../assistant/quota');
const { buildContext } = require('../assistant/context');
const { buildSystemPrompt } = require('../assistant/prompt');

router.use(authenticate);

const envInt = (name, d, min = 1) => { const n = parseInt(process.env[name], 10); return Number.isFinite(n) && n >= min ? n : d; };
const burst = new SlidingWindow();

// GET /api/assistant/status → { configured, daily_limit, used_today }
router.get('/status', async (req, res) => {
  res.json({ configured: llm.isConfigured(), provider: llm.name(), daily_limit: llm.dailyLimit(), used_today: await quota.usedToday(req.db, req.user.id) });
});

// Turns the client history into a clean, alternating user/assistant list that ends with the new message.
function buildMessages(history, message) {
  const maxMsgs = envInt('ASSISTANT_HISTORY_MESSAGES', 12), maxChars = envInt('ASSISTANT_MAX_MESSAGE_CHARS', 2000);
  const turns = (Array.isArray(history) ? history : [])
    .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim())
    .map(h => ({ role: h.role, content: h.content.trim().slice(0, maxChars) }))
    .slice(-maxMsgs);
  turns.push({ role: 'user', content: message });
  const out = [];
  for (const t of turns) {
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.content += `\n\n${t.content}`;
    else out.push({ ...t });
  }
  while (out.length > 1 && out[0].role !== 'user') out.shift();
  return out;
}

// POST /api/assistant/chat { message, history? } → { reply, used_today, daily_limit, remaining }
router.post('/chat', async (req, res) => {
  const c = { dailyLimit: llm.dailyLimit() };
  if (!llm.isConfigured()) return res.status(503).json({ error: 'The assistant is not configured on this server.', code: 'not_configured' });

  const maxChars = envInt('ASSISTANT_MAX_MESSAGE_CHARS', 2000);
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(422).json({ error: 'message is required' });
  if (message.length > maxChars) return res.status(422).json({ error: `message is too long (maximum ${maxChars} characters)` });
  if (req.body.history !== undefined && !Array.isArray(req.body.history)) return res.status(422).json({ error: 'history must be an array' });

  const perMin = envInt('ASSISTANT_BURST_PER_MIN', 6);
  const b = burst.hit(`${req.user.school_id}:${req.user.id}`, perMin, 60_000);
  if (!b.allowed) {
    const secs = Math.ceil(b.retryAfterMs / 1000);
    res.set('Retry-After', String(secs));
    return res.status(429).json({ error: `You are sending messages too quickly. Please wait ${secs} second(s).`, code: 'burst_limit', retry_after_seconds: secs });
  }

  const q = await quota.consume(req.db, req.user.id, c.dailyLimit);
  if (!q.ok) return res.status(429).json({ error: `You have used your ${c.dailyLimit} assistant questions for today. The quota resets at midnight UTC.`, code: 'daily_limit', daily_limit: c.dailyLimit, used_today: q.used, remaining: 0 });

  try {
    const [school, data] = await Promise.all([req.db.school.findFirst({ select: { name: true } }), buildContext(req.db, req.user)]);
    const system = buildSystemPrompt({ user: req.user, schoolName: school?.name, data });
    const { text, tokens } = await llm.complete({ system, messages: buildMessages(req.body.history, message) });
    await quota.addTokens(req.db, req.user.id, q.day, tokens).catch(() => {});
    res.json({ reply: text, used_today: q.used, daily_limit: c.dailyLimit, remaining: Math.max(0, c.dailyLimit - q.used) });
  } catch (e) {
    await quota.refund(req.db, req.user.id, q.day).catch(() => {});   // a failed call does not cost the user a question
    if (e instanceof llm.UpstreamError) return res.status(e.status).json({ error: e.message, code: e.code });
    throw e;
  }
});

module.exports = router;
