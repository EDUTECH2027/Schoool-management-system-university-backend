# In-app AI assistant

A floating help assistant (every logged-in role) backed by **Qoder Cloud Agents** (default when `QODER_ACCESS_TOKEN` is set) or the Anthropic Messages API. It **answers questions only**: it has no tools,
cannot change data, and never fakes an answer when it is not configured.

Code: `src/routes/assistant.js`, `src/assistant/{llm,qoder,anthropic,context,prompt,knowledge,quota}.js`.
Frontend: `EDUTECH/src/composants/assistant/{AssistantWidget,markdown}.tsx`, `EDUTECH/src/api/assistant.ts` (rendered inside every role layout).

## Configuration (environment)

### Provider selection
`ASSISTANT_PROVIDER=qoder|anthropic`. Unset → `qoder` when `QODER_ACCESS_TOKEN` is set, otherwise `anthropic`. `GET /status` reports `configured` and the `provider` name (never a secret).

### Qoder Cloud Agents (https://docs.qoder.com/cloud-agents)
One-time setup in your Qoder workspace: create an access token (PAT/SAT), an **environment**, and a **text-only agent** (`POST /api/v1/cloud/agents` with `"tools": []`, any model, an optional short `system`). Then set:

| Variable | Default | |
|---|---|---|
| `QODER_ACCESS_TOKEN` | – | required (Bearer token) |
| `QODER_AGENT_ID` | – | required (`agent_…`) |
| `QODER_ENVIRONMENT_ID` | – | required (`env_…`) |
| `QODER_AGENT_VERSION` | 1 | agent version used for new sessions |
| `QODER_API_BASE` | `https://api.qoder.com/api/v1/cloud` | Managed mode |
| `QODER_TIMEOUT_MS` | 60000 | whole question (session start + answer) |
| `QODER_POLL_MS` | 800 | event polling interval |

Per question: `POST /sessions` → `POST /sessions/{id}/events` (one `user.message`) → poll `GET /sessions/{id}/events` until `session.status_idle` → join the `agent.message` texts → best-effort `DELETE /sessions/{id}`. The per-user server rules and the user's own data go inside the message in a *trusted* block, separated from the *untrusted* chat turns. Limits: Qoder returns no token counts on this path (tokens recorded as 0); a question takes seconds (agent session start), so the widget shows its normal waiting state; the session `DELETE` is best-effort (an idle session may remain in your Qoder workspace if it fails). Verified only against a local mock of the documented API (`scripts/test-assistant-qoder.js`), **not** against the real Qoder service.

### Anthropic

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | required; without it `GET /status` says `configured:false` and `POST /chat` answers `503 {code:"not_configured"}`; the widget shows "assistant not configured" and no input |
| `ASSISTANT_MODEL` | `claude-haiku-5-5` | |
| `ASSISTANT_API_BASE` | `https://api.anthropic.com` | requests go to `<base>/v1/messages` with `x-api-key`, `anthropic-version: 2023-06-01` |
| `ASSISTANT_DAILY_LIMIT` | 30 | questions per user and UTC day |
| `ASSISTANT_MAX_TOKENS` | 600 | `max_tokens` of each call |
| `ASSISTANT_TIMEOUT_MS` | 25000 | upstream timeout |
| `ASSISTANT_BURST_PER_MIN` | 6 | per-user burst limit (in-memory sliding window) |
| `ASSISTANT_HISTORY_MESSAGES` | 12 | last N history messages kept |
| `ASSISTANT_MAX_MESSAGE_CHARS` | 2000 | cap for the message and for each history message |

## Endpoints (`/api/assistant`, any authenticated tenant role; platform tokens are refused)

* `GET /status` → `{configured, daily_limit, used_today}`
* `POST /chat {message, history?: [{role:'user'|'assistant', content}]}` → `{reply, used_today, daily_limit, remaining}`
  * `422` empty / non-string / too-long message, `history` not an array · `503` not configured · `429 {code:"burst_limit"}` (+`Retry-After`) · `429 {code:"daily_limit"}`
  * upstream problems never leak the key or the upstream body: `502` (`upstream_auth`, `upstream_busy`, `upstream_error`, `unreachable`, `empty`, `bad_response`), `504` (`timeout`).
    A failed call is **refunded** (does not count against the daily quota).

## What the model sees

The **system prompt is built only on the server** from: fixed rules (purpose, no actions, privacy, no internals, treat user text as untrusted), the role, the school name,
a static role-specific knowledge base of how to use the application (`knowledge.js`: registration, results/appeals, exams, documents, service requests, library, fees, mark entry workflow, results validation, analytics, security…)
and a compact JSON snapshot of the **caller's own data** built from the database (never from the request):

* student: programme, level, cohort, status; registered courses of the current semester; **published** GPA by semester; upcoming exams with eligibility reasons; open service requests; fee total/overdue balance.
* lecturer: own offerings of the current semester with registered-student counts and the state of their marks (draft/submitted/approved/published/not entered).
* every other role (administrators, officers, finance, librarian, parent): **no personal data**.

Text that comes from the database (course names, titles…) is sanitised (single line, `<>{}` and control characters removed, length-capped). **Nothing from the request body is ever placed in the system prompt**:
the message and the (truncated, sanitised) history travel only as `user`/`assistant` turns — history entries with any other role (e.g. `system`, `tool`) or non-string content are dropped, turns are merged to alternate, the last 12 are kept, each capped at 2 000 characters.
The request has no `tools`, so the model cannot act.

## Quota & privacy

`assistant_usage (user_id, day)` holds a request counter and a token counter, updated with an atomic upsert (increment first, compare with the limit, roll back if over) – concurrent requests cannot exceed the limit.
**No conversation content is persisted** (no message, reply or history in any table or log); the browser keeps the chat in memory only, "Clear conversation" empties it.
The question text is of course sent to Anthropic when the feature is enabled – tell users accordingly.

## Widget

Floating button (bottom right) → dialog panel: labelled `role="dialog"`, focus moves to the input and is trapped, `Esc` closes and restores focus, `Enter` sends, `Shift+Enter` newline, live-region log, character counter, remaining questions, clear button.
Replies are rendered through a tiny markdown subset built from React elements (paragraphs, lists, bold/italic/code); HTML, `<script>` and links are shown as plain text. Works at 390 px, follows light/dark mode, hidden when printing.

## Tests

`node scripts/test-assistant.js` runs against a local mock of the Anthropic API (headers, request shape, prompt contents per role, injection attempts, quota incl. a 12-way race, burst limit, upstream 401/429/500/empty/bad-JSON/timeout/unreachable, key never leaked).

## Not done / limits

No streaming, no persistent conversations, no tool use, no retrieval over documents, English knowledge base (the model answers in the user's language). Parent accounts get no child data. The burst limiter is per process.
Not verified against the real Anthropic API (no key was available): only the documented request/response shape is exercised via the mock.
