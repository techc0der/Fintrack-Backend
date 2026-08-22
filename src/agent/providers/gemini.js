import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';

export const id = 'gemini';
export const label = 'Gemini';

/**
 * flash-lite, chosen for quota rather than quality: on the free tier it allows
 * 15 requests/minute, where gemini-3.7-flash is capped at 20 requests per *day*
 * — roughly eight chat messages before it stops answering.
 *
 * flash-lite did originally misread figures out of tool results (it would
 * receive borrowed=35000 and answer "50,000"), which looked like a model-size
 * problem. It was a prompting problem: the "quote every figure exactly" rule in
 * system.js fixed it — 6/6 correct on questions that previously failed about
 * half the time. Keep that rule if you rewrite the prompt.
 */
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const MAX_STEPS = 8;
const AUTO_RETRY_CEILING_MS = 12000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Free-tier 429s carry a server-computed retryDelay — pull it out if present. */
function retryDelayMs(err) {
  const seconds = String(err?.message || '').match(/"retryDelay":\s*"(\d+)s"/)?.[1];
  return seconds ? Number(seconds) * 1000 : null;
}

const isRateLimit = (err) =>
  (err?.status ?? err?.code) === 429 || /RESOURCE_EXHAUSTED/i.test(String(err?.message || ''));

/** Capacity blips, not quota — worth one quick retry. */
const isTransient = (err) =>
  (err?.status ?? err?.code) === 503 || /UNAVAILABLE|high demand/i.test(String(err?.message || ''));

export const model = () => process.env.GEMINI_MODEL || DEFAULT_MODEL;
export const isConfigured = () => Boolean(process.env.GEMINI_API_KEY);

let client = null;
const getClient = () => (client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }));

/**
 * Gemini takes plain JSON Schema via `parametersJsonSchema`. A tool with no
 * parameters must omit the field entirely — an empty object is rejected.
 */
function declare(tool) {
  const schema = z.toJSONSchema(tool.schema, { io: 'input' });
  const declaration = { name: tool.name, description: tool.description };
  if (schema.properties && Object.keys(schema.properties).length > 0) {
    declaration.parametersJsonSchema = schema;
  }
  return declaration;
}

const toContents = (history) =>
  history.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

export async function streamTurn({ history, instructions, context, tools, onText }) {
  const ai = getClient();
  const byName = new Map(tools.map((t) => [t.name, t]));
  const contents = toContents(history);

  const config = {
    systemInstruction: `${instructions}\n\n${context}`,
    tools: [{ functionDeclarations: tools.map(declare) }],
    maxOutputTokens: 8192,
  };

  let answer = '';

  // Retries once on a short rate-limit window; a long one is reported instead
  // of silently stalling the chat panel for a minute.
  const openStream = async () => {
    try {
      return await ai.models.generateContentStream({ model: model(), contents, config });
    } catch (err) {
      if (isTransient(err)) {
        await sleep(2000);
        return ai.models.generateContentStream({ model: model(), contents, config });
      }
      const wait = isRateLimit(err) ? retryDelayMs(err) : null;
      if (wait === null || wait > AUTO_RETRY_CEILING_MS) throw err;
      await sleep(wait + 500);
      return ai.models.generateContentStream({ model: model(), contents, config });
    }
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    const stream = await openStream();

    // Collect the model's parts verbatim. Gemini 3.x attaches a thoughtSignature
    // to functionCall parts and rejects the next turn if it is not echoed back,
    // so these parts must be replayed as-is rather than rebuilt from .functionCalls.
    const parts = [];
    for await (const chunk of stream) {
      const chunkParts = chunk.candidates?.[0]?.content?.parts;
      if (!chunkParts) continue;
      for (const part of chunkParts) {
        parts.push(part);
        if (part.text && !part.thought) {
          answer += part.text;
          onText(part.text);
        }
      }
    }

    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    if (!calls.length) return answer;

    contents.push({ role: 'model', parts });

    const results = await Promise.all(
      calls.map(async (call) => {
        const tool = byName.get(call.name);
        const output = tool
          ? await tool.run(call.args || {})
          : JSON.stringify({ error: `Unknown tool ${call.name}` });
        return {
          functionResponse: {
            id: call.id,
            name: call.name,
            // The SDK requires an object here, so the tool's JSON string is nested.
            response: { output },
          },
        };
      })
    );

    contents.push({ role: 'user', parts: results });
  }

  return answer || 'I got stuck working through that one — could you rephrase it?';
}

export function describeError(err) {
  const status = err?.status ?? err?.code;
  const text = String(err?.message || '');

  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(text)) {
    return 'Gemini rejected the API key. Check GEMINI_API_KEY in server/.env.';
  }
  if (isRateLimit(err)) {
    const wait = retryDelayMs(err);
    const limit = text.match(/limit:\s*(\d+)/)?.[1];
    // The payload's quotaId says which window was hit — a daily cap and a
    // per-minute burst need very different advice.
    const perDay = /PerDay/i.test(text);
    return [
      `Gemini free-tier quota reached${limit ? ` (${limit} requests ${perDay ? 'per day' : 'per minute'} on ${model()})` : ''}.`,
      perDay
        ? 'That resets tomorrow. GEMINI_MODEL=gemini-3.1-flash-lite has a far higher daily allowance.'
        : wait
          ? `Try again in ~${Math.ceil(wait / 1000)}s.`
          : 'Try again shortly.',
    ]
      .filter(Boolean)
      .join(' ');
  }
  if (isTransient(err)) {
    return 'Gemini is briefly overloaded. Try that again in a moment.';
  }
  if (status === 404) {
    return `Model "${model()}" is not available to this key. Try GEMINI_MODEL=gemini-2.5-flash.`;
  }
  return null;
}
