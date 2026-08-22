import * as anthropic from './anthropic.js';
import * as gemini from './gemini.js';

const PROVIDERS = { anthropic, gemini };

/**
 * Resolves the active provider. `AI_PROVIDER` wins when set; otherwise the first
 * provider with a key configured is used, preferring Gemini because its free
 * tier means it is usually the one deliberately set up.
 */
export function activeProvider() {
  const requested = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (requested && PROVIDERS[requested]) return PROVIDERS[requested];
  if (requested) return null;
  return [gemini, anthropic].find((p) => p.isConfigured()) || null;
}

/** What the UI needs to show the assistant's status. */
export function providerStatus() {
  const provider = activeProvider();
  if (!provider) {
    return { enabled: false, provider: null, model: null, reason: 'no-provider' };
  }
  if (!provider.isConfigured()) {
    return {
      enabled: false,
      provider: provider.id,
      model: provider.model(),
      reason: 'missing-key',
    };
  }
  return { enabled: true, provider: provider.id, label: provider.label, model: provider.model() };
}

export { PROVIDERS };
