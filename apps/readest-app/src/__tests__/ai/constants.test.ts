import { describe, test, expect, vi, afterEach } from 'vitest';

// mock stores and dependencies before imports
vi.mock('@/store/settingsStore', () => {
  const mockState = {
    settings: {
      aiSettings: {
        enabled: true,
        provider: 'ollama',
        ollamaBaseUrl: 'http://127.0.0.1:11434',
        ollamaModel: 'llama3.2',
        ollamaEmbeddingModel: 'nomic-embed-text',
        spoilerProtection: true,
        maxContextChunks: 5,
        indexingMode: 'on-demand',
      },
    },
    setSettings: vi.fn(),
    saveSettings: vi.fn(),
  };

  const fn = vi.fn(() => mockState) as unknown as {
    (): typeof mockState;
    getState: () => typeof mockState;
    setState: (partial: Partial<typeof mockState>) => void;
    subscribe: (listener: () => void) => () => void;
    destroy: () => void;
  };
  fn.getState = () => mockState;
  fn.setState = vi.fn();
  fn.subscribe = vi.fn();
  fn.destroy = vi.fn();

  return { useSettingsStore: fn };
});

import type { AISettings } from '@/services/ai/types';
import { DEFAULT_AI_SETTINGS, GATEWAY_MODELS } from '@/services/ai/constants';

describe('DEFAULT_AI_SETTINGS', () => {
  test('should have enabled set to false by default', () => {
    expect(DEFAULT_AI_SETTINGS.enabled).toBe(false);
  });

  test('should have ollama as default provider', () => {
    expect(DEFAULT_AI_SETTINGS.provider).toBe('ollama');
  });

  test('should have valid ollama defaults', () => {
    expect(DEFAULT_AI_SETTINGS.ollamaBaseUrl).toBe('http://127.0.0.1:11434');
    expect(DEFAULT_AI_SETTINGS.ollamaModel).toBe('llama3.2');
    expect(DEFAULT_AI_SETTINGS.ollamaEmbeddingModel).toBe('nomic-embed-text');
  });

  test('should have spoiler protection enabled by default', () => {
    expect(DEFAULT_AI_SETTINGS.spoilerProtection).toBe(true);
  });
});

// A development build can carry its own OpenAI-compatible endpoint
// (.env.local). The constant reads the environment at import time, so each case
// sets what it needs and re-imports the module.
describe('an endpoint seeded from .env.local in a development build', () => {
  const KEYS = [
    'NODE_ENV',
    'NEXT_PUBLIC_AI_API_KEY',
    'NEXT_PUBLIC_AI_BASE_URL',
    'NEXT_PUBLIC_AI_MODEL',
    'NEXT_PUBLIC_AI_EMBEDDING_MODEL',
  ];
  const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

  const importDefaults = async () => {
    vi.resetModules();
    return (await import('@/services/ai/constants')).DEFAULT_AI_SETTINGS;
  };

  const withEnv = (vars: Record<string, string | undefined>, mode = 'development') => {
    for (const key of KEYS) {
      const value = key === 'NODE_ENV' ? mode : vars[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  afterEach(() => {
    for (const key of KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key]!;
    }
    vi.resetModules();
  });

  test('a release build keeps the built-in defaults', async () => {
    withEnv(
      {
        NEXT_PUBLIC_AI_API_KEY: 'sk-local',
        NEXT_PUBLIC_AI_BASE_URL: 'https://api.example.com/v1',
        NEXT_PUBLIC_AI_MODEL: 'some-model',
      },
      'production',
    );
    const defaults = await importDefaults();
    expect(defaults.enabled).toBe(false);
    expect(defaults.provider).toBe('ollama');
    expect(defaults.openrouterApiKey).toBeUndefined();
  });

  test('a development build turns the provider on with what .env.local provided', async () => {
    withEnv({
      NODE_ENV: 'development',
      NEXT_PUBLIC_AI_API_KEY: 'sk-local',
      NEXT_PUBLIC_AI_BASE_URL: 'https://api.example.com/v1',
      NEXT_PUBLIC_AI_MODEL: 'some-model',
    });
    const defaults = await importDefaults();
    expect(defaults.enabled).toBe(true);
    expect(defaults.provider).toBe('openrouter');
    expect(defaults.openrouterApiKey).toBe('sk-local');
    expect(defaults.openrouterBaseUrl).toBe('https://api.example.com/v1');
    expect(defaults.openrouterModel).toBe('some-model');
  });

  test('an endpoint without embeddings leaves that field on its default', async () => {
    withEnv({ NEXT_PUBLIC_AI_API_KEY: 'sk-local' });
    const defaults = await importDefaults();
    expect(defaults.openrouterEmbeddingModel).toBe('');
  });

  test('an embedding model in .env.local replaces the default', async () => {
    withEnv({
      NEXT_PUBLIC_AI_API_KEY: 'sk-local',
      NEXT_PUBLIC_AI_EMBEDDING_MODEL: 'text-embedding-3-small',
    });
    const defaults = await importDefaults();
    expect(defaults.openrouterEmbeddingModel).toBe('text-embedding-3-small');
  });

  test('no key in .env.local leaves the built-in defaults alone', async () => {
    withEnv({});
    const defaults = await importDefaults();
    expect(defaults.enabled).toBe(false);
    expect(defaults.provider).toBe('ollama');
  });
});

describe('Model constants', () => {
  test('GATEWAY_MODELS should have expected models', () => {
    expect(GATEWAY_MODELS.GEMINI_FLASH_LITE).toBeDefined();
    expect(GATEWAY_MODELS.GPT_5_NANO).toBeDefined();
    expect(GATEWAY_MODELS.LLAMA_4_SCOUT).toBeDefined();
    expect(GATEWAY_MODELS.GROK_4_1_FAST).toBeDefined();
    expect(GATEWAY_MODELS.DEEPSEEK_V3_2).toBeDefined();
    expect(GATEWAY_MODELS.QWEN_3_235B).toBeDefined();
  });
});

describe('AISettings Type', () => {
  test('should allow creating valid settings object', () => {
    const settings: AISettings = {
      enabled: true,
      provider: 'ollama',
      ollamaBaseUrl: 'http://localhost:11434',
      ollamaModel: 'mistral',
      ollamaEmbeddingModel: 'nomic-embed-text',
      spoilerProtection: false,
      maxContextChunks: 10,
      indexingMode: 'background',
    };

    expect(settings.enabled).toBe(true);
    expect(settings.provider).toBe('ollama');
    expect(settings.indexingMode).toBe('background');
  });

  test('should support ai-gateway provider', () => {
    const settings: AISettings = {
      ...DEFAULT_AI_SETTINGS,
      enabled: true,
      provider: 'ai-gateway',
      aiGatewayApiKey: 'test-key',
      aiGatewayModel: 'openai/gpt-5.2',
      aiGatewayEmbeddingModel: 'openai/text-embedding-3-small',
    };

    expect(settings.provider).toBe('ai-gateway');
    expect(settings.aiGatewayApiKey).toBe('test-key');
  });
});
