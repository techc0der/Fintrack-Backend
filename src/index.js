import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import api from './routes/api.js';
import chat from './routes/chat.js';
import { providerStatus } from './agent/providers/index.js';
import { connect, backfillDebtCategories, backfillOwnership } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 4000;

/**
 * CLIENT_ORIGIN is a comma-separated allowlist, e.g.
 *   CLIENT_ORIGIN=http://localhost:5173,https://fintrack.vercel.app
 *
 * Leave it unset and any origin is reflected — fine locally, where Vite proxies
 * /api and the browser never actually makes a cross-origin call, but set it once
 * the frontend is deployed somewhere real.
 */
const allowedOrigins = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header: curl, health checks, same-origin navigation.
      if (!origin || allowedOrigins.length === 0) return callback(null, true);
      callback(null, allowedOrigins.includes(origin.replace(/\/+$/, '')));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true, ...providerStatus() }));

app.use('/api', api);
app.use('/api/chat', chat);

// In production the built SPA is served from the same origin.
const dist = path.join(__dirname, '..', '..', 'web', 'dist');
app.use(express.static(dist));
app.get(/^(?!\/api\/).*/, (_req, res, next) => {
  res.sendFile(path.join(dist, 'index.html'), (err) => (err ? next() : undefined));
});

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

try {
  await connect();
  await backfillDebtCategories();
  await backfillOwnership();
  console.log(`MongoDB connected (db "${process.env.MONGODB_DB || 'fintrack'}")`);
} catch (err) {
  console.error('\nCould not reach MongoDB:', err.message);
  console.error('Check MONGODB_URI in server/.env, and that your IP is allowed in Atlas → Network Access.\n');
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`FinTrack API listening on http://localhost:${PORT}`);
  const ai = providerStatus();
  console.log(
    ai.enabled
      ? `  AI assistant: ${ai.label} (${ai.model})`
      : '  AI assistant: disabled (set GEMINI_API_KEY or ANTHROPIC_API_KEY in server/.env)'
  );
});
