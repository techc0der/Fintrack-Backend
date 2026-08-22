import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';

export const id = 'anthropic';
export const label = 'Claude';

const DEFAULT_MODEL = 'claude-opus-5';

export const model = () => process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
export const isConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client = null;
const getClient = () => (client ??= new Anthropic());

/**
 * Adaptive thinking and `output_config.effort` exist only on Claude 4.6 and
 * later. Sending either to Haiku 4.5 or Sonnet 4.5 is a 400, so the model id
 * decides which params go on the request.
 */
function modernParams(id) {
  const modern = /^claude-(opus-(5|4-[678])|sonnet-(5|4-6)|fable-5|mythos-5)/.test(id);
  return modern
    ? { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'medium' } }
    : {};
}

export async function streamTurn({ history, instructions, context, tools, onText, onThinking }) {
  const runner = getClient().beta.messages.toolRunner({
    model: model(),
    max_tokens: 64000,
    ...modernParams(model()),
    system: [
      // Stable prefix first so the cache breakpoint covers tools + instructions.
      { type: 'text', text: instructions, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: context },
    ],
    tools: tools.map((t) =>
      betaZodTool({ name: t.name, description: t.description, inputSchema: t.schema, run: t.run })
    ),
    messages: history,
    stream: true,
  });

  let answer = '';
  for await (const stream of runner) {
    for await (const event of stream) {
      if (event.type !== 'content_block_delta') continue;
      if (event.delta.type === 'text_delta') {
        answer += event.delta.text;
        onText(event.delta.text);
      } else if (event.delta.type === 'thinking_delta') {
        onThinking?.(event.delta.thinking);
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === 'pause_turn') {
      runner.pushMessages({ role: 'assistant', content: final.content });
    }
    if (final.stop_reason === 'refusal') {
      throw new Error('Claude declined to answer that one. Try rephrasing.');
    }
  }

  return answer;
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Claude rejected the API key. Check ANTHROPIC_API_KEY in server/.env.';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Rate limited by the Claude API — wait a moment and try again.';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Could not reach the Claude API. Check your connection.';
  }
  return null;
}
