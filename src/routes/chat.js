import { Router } from 'express';
import { col, nextId } from '../db.js';
import { requireAuth } from '../auth.js';
import { buildTools } from '../agent/tools.js';
import { AGENT_INSTRUCTIONS, contextBlock } from '../agent/system.js';
import { activeProvider, providerStatus } from '../agent/providers/index.js';

const router = Router();
const HISTORY_TURNS = 20;

async function history(userId) {
  const rows = await col.chat_messages
    .find({ user_id: userId }, { projection: { role: 1, content: 1 } })
    .sort({ _id: -1 })
    .limit(HISTORY_TURNS)
    .toArray();
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }));
}

async function save(userId, role, content) {
  await col.chat_messages.insertOne({
    _id: await nextId('chat_messages'),
    user_id: userId,
    role,
    content,
    created_at: new Date().toISOString(),
  });
}

router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const docs = await col.chat_messages
      .find({ user_id: req.user.id })
      .sort({ _id: 1 })
      .limit(200)
      .toArray();
    const messages = docs.map(({ _id, role, content, created_at }) => ({ id: _id, role, content, created_at }));
    res.json({ messages, ...providerStatus() });
  } catch (err) {
    next(err);
  }
});

router.delete('/history', requireAuth, async (req, res, next) => {
  try {
    await col.chat_messages.deleteMany({ user_id: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Streams one agent turn as Server-Sent Events.
 *
 * The browser sends the message as a query param so it can use EventSource:
 *   GET /api/chat/stream?message=...&token=...
 *
 * Events: `text` (delta), `thinking` (delta), `tool` (a tool the agent ran),
 * `done` (final text), `error`.
 */
router.get('/stream', requireAuth, async (req, res) => {
  const message = String(req.query.message || '').trim();
  if (!message) return res.status(400).json({ error: 'message is required' });

  const provider = activeProvider();
  if (!provider) {
    return res.status(503).json({
      error:
        'No AI provider configured. Add GEMINI_API_KEY (free tier) or ANTHROPIC_API_KEY to server/.env and restart.',
    });
  }
  if (!provider.isConfigured()) {
    return res.status(503).json({
      error: `AI_PROVIDER is set to "${provider.id}" but its API key is missing from server/.env.`,
    });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  let closed = false;
  req.on('close', () => { closed = true; });

  const turn = [...(await history(req.user.id)), { role: 'user', content: message }];
  await save(req.user.id, 'user', message);

  let answer = '';

  try {
    answer = await provider.streamTurn({
      history: turn,
      instructions: AGENT_INSTRUCTIONS,
      context: await contextBlock(req.user),
      tools: buildTools(req.user.id, (event) => !closed && send('tool', event)),
      onText: (delta) => {
        if (!closed) send('text', { delta });
      },
      onThinking: (delta) => {
        if (!closed) send('thinking', { delta });
      },
    });

    if (answer.trim()) await save(req.user.id, 'assistant', answer.trim());
    send('done', { text: answer.trim() });
  } catch (err) {
    console.error(`[chat:${provider.id}]`, err);
    send('error', {
      message: provider.describeError(err) || err.message || 'The assistant hit an unexpected error.',
    });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

export default router;
