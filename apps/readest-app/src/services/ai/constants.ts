import type { AISettings } from './types';

// cheapest popular models as of 2025
export const GATEWAY_MODELS = {
  GEMINI_FLASH_LITE: 'google/gemini-2.5-flash-lite',
  GPT_5_NANO: 'openai/gpt-5-nano',
  LLAMA_4_SCOUT: 'meta/llama-4-scout',
  GROK_4_1_FAST: 'xai/grok-4.1-fast-reasoning',
  DEEPSEEK_V3_2: 'deepseek/deepseek-v3.2',
  QWEN_3_235B: 'alibaba/qwen-3-235b',
} as const;

export const MODEL_PRICING: Record<string, { input: string; output: string }> = {
  [GATEWAY_MODELS.GEMINI_FLASH_LITE]: { input: '0.1', output: '0.4' },
  [GATEWAY_MODELS.GPT_5_NANO]: { input: '0.05', output: '0.4' },
  [GATEWAY_MODELS.LLAMA_4_SCOUT]: { input: '0.08', output: '0.3' },
  [GATEWAY_MODELS.GROK_4_1_FAST]: { input: '0.2', output: '0.5' },
  [GATEWAY_MODELS.DEEPSEEK_V3_2]: { input: '0.27', output: '0.4' },
  [GATEWAY_MODELS.QWEN_3_235B]: { input: '0.07', output: '0.46' },
};

/**
 * A developer's own LLM endpoint, seeded from `.env.local` (that file names the
 * variables). Development builds only: a release build inlines `NODE_ENV` as
 * `production`, so the branch is dropped from the bundle and no key can end up
 * in a shipped client. Without it, or with nothing in the environment, this is
 * empty and the defaults below stand.
 */
const envAIProvider = (): Partial<AISettings> => {
  if (process.env.NODE_ENV !== 'development') return {};
  const apiKey = process.env['NEXT_PUBLIC_AI_API_KEY'];
  if (!apiKey) return {};
  const baseUrl = process.env['NEXT_PUBLIC_AI_BASE_URL'];
  const model = process.env['NEXT_PUBLIC_AI_MODEL'];
  const embeddingModel = process.env['NEXT_PUBLIC_AI_EMBEDDING_MODEL'];
  return {
    enabled: true,
    provider: 'openrouter',
    openrouterApiKey: apiKey,
    ...(baseUrl && { openrouterBaseUrl: baseUrl }),
    ...(model && { openrouterModel: model }),
    ...(embeddingModel && { openrouterEmbeddingModel: embeddingModel }),
  };
};

export const DEFAULT_AI_SETTINGS: AISettings = {
  enabled: false,
  provider: 'ollama',

  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'llama3.2',
  ollamaEmbeddingModel: 'nomic-embed-text',

  aiGatewayModel: 'google/gemini-2.5-flash-lite',
  aiGatewayEmbeddingModel: 'openai/text-embedding-3-small',

  openrouterBaseUrl: 'https://openrouter.ai/api/v1',
  openrouterModel: '',
  openrouterEmbeddingModel: '',

  // Last, so an endpoint in the build's environment replaces these.
  ...envAIProvider(),

  spoilerProtection: true,
  maxContextChunks: 10,
  indexingMode: 'on-demand',
  reedy: { enabled: false },
};
