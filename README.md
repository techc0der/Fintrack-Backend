# FinTrack — backend

Express API for FinTrack, a personal expense, income and savings tracker, with an
AI agent that can read the user's data and record transactions on their behalf.

Frontend: **[Fintrack-frontend](https://github.com/techc0der/Fintrack-frontend)**.

## Stack

Node 22.5+, Express 5, MongoDB. The assistant runs on either Google Gemini or
Anthropic Claude, chosen at runtime.

## Setup

```bash
npm install
cp .env.example .env      # then fill it in
npm run dev               # http://localhost:4000
```

`.env` at minimum needs a Mongo connection string and a JWT secret:

```env
MONGODB_URI=mongodb+srv://<user>:<password>@<cluster-host>/?retryWrites=true&w=majority
MONGODB_DB=fintrack
JWT_SECRET=<a long random string>
```

Generate a secret with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

The server exits at boot if Mongo is unreachable and prints why. On Atlas that is
almost always **Network Access** — your public IP has to be on the allowlist.

The AI assistant is optional; everything else works without a key.

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=...        # free tier: https://aistudio.google.com/apikey
```

## Deploying

Build command `npm install`, start command `npm start`. The host supplies `PORT`;
the app reads it.

Required environment variables:

| Variable | Notes |
|---|---|
| `MONGODB_URI` | **Required.** The process exits at boot without a reachable database. A `127.0.0.1` URI refers to the *container's* localhost, not your machine — use Atlas. |
| `JWT_SECRET` | A long random string. Changing it signs everyone out. |
| `CLIENT_ORIGIN` | Comma-separated allowlist of frontend origins. Without it, any origin is reflected. |
| `GEMINI_API_KEY` | Optional; the assistant is disabled without it. |

Two things that bite on a first deploy:

- **Atlas Network Access.** Your host's outbound IP has to be allowlisted. Platforms
  with dynamic egress IPs need `0.0.0.0/0` there, which makes the database password
  the only thing protecting it — so make it a strong one.
- **A failed boot looks like a hang, not an error.** If Mongo is unreachable the
  process exits, the platform's router keeps accepting connections, and requests
  time out with no response. Check the deploy logs, not the URL.

Free tiers idle out, so the first request after a quiet period can take ~50 seconds
while the container wakes.

## Layout

```
src/
  index.js                 app entry, Mongo connect, serves ../web/dist in production
  db.js                    client, collections, indexes, counters, seed data
  finance.js               the whole data layer — every query lives here
  auth.js                  scrypt hashing, JWT, requireAuth
  migrate-from-sqlite.js   one-off importer for a pre-Mongo fintrack.db
  routes/
    api.js                 REST endpoints
    chat.js                SSE streaming endpoint for the agent
  agent/
    tools.js               13 provider-neutral tool definitions
    system.js              system prompt + per-request context
    providers/
      gemini.js            manual tool loop over generateContentStream
      anthropic.js         beta toolRunner
      index.js             picks the provider from AI_PROVIDER
```

## Data model

Four money flows, because a loan is not income:

| Flow | Direction | Counted as |
|---|---|---|
| `income` | in | income, and toward savings rate |
| `borrow` | in | **neither** — a credit you owe back |
| `expense` | out | expenses, and against budgets |
| `repay` | out | **neither** — it clears a liability |

`summary()` returns `income`, `expense`, `net` and `savingsRate` computed from the
first and third rows only, plus `borrowed`, `repaid`, `debtDelta`, and
`cashIn`/`cashOut` for true account movement.

Two implementation details worth knowing:

- **Ids are sequential numbers, not ObjectIds**, issued by a `counters` collection.
  The REST and agent contracts already spoke in numbers, and a short `7` is much
  easier for a model to read back into `delete_transaction` than 24 hex characters.
- **The flow-type enum is enforced by a `$jsonSchema` validator** on `transactions`
  and `categories`, standing in for the CHECK constraint the original SQL schema had.

### Importing an older SQLite database

```bash
node src/migrate-from-sqlite.js          # reads ./fintrack.db
node src/migrate-from-sqlite.js --wipe   # clear target collections first
```

Rows keep their ids and are upserted, so re-running overwrites rather than
duplicating. Counters are parked above the highest imported id.

## The agent

`GET /api/chat/stream` streams one turn as Server-Sent Events (`text`, `thinking`,
`tool`, `done`, `error`). Thirteen tools are bound to the authenticated user — every
`run` closes over their id, so the model cannot reach another account's rows even if
it invents one.

| Read | Write |
|---|---|
| `get_summary`, `spending_by_category`, `monthly_trend` | `add_transaction`, `update_transaction`, `delete_transaction` |
| `list_transactions`, `list_budgets`, `list_goals`, `list_categories` | `set_budget`, `create_goal`, `contribute_to_goal` |

### Two things not to undo

**Keep the "quote every figure exactly" rule in `agent/system.js`.** Without it,
`gemini-3.1-flash-lite` misread numbers out of tool results about half the time — it
would receive `borrowed: 35000` and answer "50,000". With the rule it scored 6/6 on
the same questions.

**Gemini 3.x function-call parts carry a `thoughtSignature` that must be echoed back
verbatim.** `providers/gemini.js` replays the model's own `parts` array rather than
rebuilding it from `.functionCalls`; rebuilding produces a 400 on the following turn.

### Free-tier quotas

| Model | Free limit |
|---|---|
| `gemini-3.1-flash-lite` | 15 requests/min — the default |
| `gemini-3.7-flash` | 5/min **and 20 per day** — roughly eight messages |

An agent turn costs 2–3 requests. Rate-limit errors surface in the chat with the
wait time, and short throttles retry automatically.

## Security

- Passwords hashed with `scrypt` + per-user salt, compared with `timingSafeEqual`.
- JWTs signed with `JWT_SECRET`, 30-day expiry.
- Every query is scoped by `user_id`, including the agent's tools.
- Provider API keys stay server-side; the browser never sees them.

Before deploying publicly: serve over HTTPS, move the JWT from `localStorage` into an
httpOnly cookie, and rate-limit `/api/auth/*` and `/api/chat/stream`.

**Never commit `.env`.** It holds the JWT signing secret, the database password and
your provider key. It is gitignored here — keep it that way.
