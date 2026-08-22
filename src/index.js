import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import api from './routes/api.js';
import chat from './routes/chat.js';
import { providerStatus } from './agent/providers/index.js';
import { connect, backfillDebtCategories } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 4000;

app.use(cors({ origin: process.env.CLIENT_ORIGIN || true, credentials: true }));
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
