import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, RelayConfigSchema } from '../src/config.js';

const ENV_KEYS = [
  'GENERACY_API_KEY',
  'RELAY_URL',
  'ORCHESTRATOR_URL',
  'ORCHESTRATOR_API_KEY',
  'REQUEST_TIMEOUT_MS',
  'HEARTBEAT_INTERVAL_MS',
  'BASE_RECONNECT_DELAY_MS',
  'MAX_RECONNECT_DELAY_MS',
] as const;

describe('config', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  describe('loadConfig with defaults', () => {
    it('returns all default values when only apiKey is provided', () => {
      const config = loadConfig({ apiKey: 'test-key' });

      expect(config).toEqual({
        apiKey: 'test-key',
        relayUrl: 'wss://api.generacy.ai/relay',
        orchestratorUrl: 'http://localhost:3000',
        requestTimeoutMs: 30000,
        heartbeatIntervalMs: 30000,
        baseReconnectDelayMs: 5000,
        maxReconnectDelayMs: 300000,
      });
    });
  });

  describe('env var overrides', () => {
    it('reads apiKey from GENERACY_API_KEY', () => {
      process.env['GENERACY_API_KEY'] = 'env-api-key';
      const config = loadConfig();
      expect(config.apiKey).toBe('env-api-key');
    });

    it('reads relayUrl from RELAY_URL', () => {
      process.env['GENERACY_API_KEY'] = 'key';
      process.env['RELAY_URL'] = 'wss://custom.relay/path';
      const config = loadConfig();
      expect(config.relayUrl).toBe('wss://custom.relay/path');
    });

    it('reads orchestratorUrl from ORCHESTRATOR_URL', () => {
      process.env['GENERACY_API_KEY'] = 'key';
      process.env['ORCHESTRATOR_URL'] = 'http://orchestrator:4000';
      const config = loadConfig();
      expect(config.orchestratorUrl).toBe('http://orchestrator:4000');
    });

    it('reads orchestratorApiKey from ORCHESTRATOR_API_KEY', () => {
      process.env['GENERACY_API_KEY'] = 'key';
      process.env['ORCHESTRATOR_API_KEY'] = 'orch-secret';
      const config = loadConfig();
      expect(config.orchestratorApiKey).toBe('orch-secret');
    });

    it('reads requestTimeoutMs from REQUEST_TIMEOUT_MS', () => {
      process.env['GENERACY_API_KEY'] = 'key';
      process.env['REQUEST_TIMEOUT_MS'] = '60000';
      const config = loadConfig();
      expect(config.requestTimeoutMs).toBe(60000);
    });

    it('reads heartbeatIntervalMs from HEARTBEAT_INTERVAL_MS', () => {
      process.env['GENERACY_API_KEY'] = 'key';
      process.env['HEARTBEAT_INTERVAL_MS'] = '15000';
      const config = loadConfig();
      expect(config.heartbeatIntervalMs).toBe(15000);
    });

    it('reads baseReconnectDelayMs from BASE_RECONNECT_DELAY_MS', () => {
      process.env['GENERACY_API_KEY'] = 'key';
      process.env['BASE_RECONNECT_DELAY_MS'] = '2000';
      const config = loadConfig();
      expect(config.baseReconnectDelayMs).toBe(2000);
    });

    it('reads maxReconnectDelayMs from MAX_RECONNECT_DELAY_MS', () => {
      process.env['GENERACY_API_KEY'] = 'key';
      process.env['MAX_RECONNECT_DELAY_MS'] = '600000';
      const config = loadConfig();
      expect(config.maxReconnectDelayMs).toBe(600000);
    });
  });

  describe('constructor overrides take precedence over env vars', () => {
    it('override apiKey wins over env var', () => {
      process.env['GENERACY_API_KEY'] = 'env-key';
      const config = loadConfig({ apiKey: 'override-key' });
      expect(config.apiKey).toBe('override-key');
    });

    it('override relayUrl wins over env var', () => {
      process.env['GENERACY_API_KEY'] = 'key';
      process.env['RELAY_URL'] = 'wss://env.relay/path';
      const config = loadConfig({ relayUrl: 'wss://override.relay/path' });
      expect(config.relayUrl).toBe('wss://override.relay/path');
    });

    it('override orchestratorUrl wins over env var', () => {
      process.env['GENERACY_API_KEY'] = 'key';
      process.env['ORCHESTRATOR_URL'] = 'http://env:4000';
      const config = loadConfig({ orchestratorUrl: 'http://override:5000' });
      expect(config.orchestratorUrl).toBe('http://override:5000');
    });

    it('override numeric fields win over env vars', () => {
      process.env['GENERACY_API_KEY'] = 'key';
      process.env['REQUEST_TIMEOUT_MS'] = '10000';
      process.env['HEARTBEAT_INTERVAL_MS'] = '10000';
      process.env['BASE_RECONNECT_DELAY_MS'] = '10000';
      process.env['MAX_RECONNECT_DELAY_MS'] = '10000';

      const config = loadConfig({
        requestTimeoutMs: 99000,
        heartbeatIntervalMs: 88000,
        baseReconnectDelayMs: 77000,
        maxReconnectDelayMs: 66000,
      });

      expect(config.requestTimeoutMs).toBe(99000);
      expect(config.heartbeatIntervalMs).toBe(88000);
      expect(config.baseReconnectDelayMs).toBe(77000);
      expect(config.maxReconnectDelayMs).toBe(66000);
    });
  });

  describe('validation errors', () => {
    it('throws when apiKey is missing', () => {
      expect(() => loadConfig()).toThrow();
    });

    it('throws when apiKey is an empty string', () => {
      expect(() => loadConfig({ apiKey: '' })).toThrow();
    });

    it('throws when GENERACY_API_KEY env var is empty', () => {
      process.env['GENERACY_API_KEY'] = '';
      expect(() => loadConfig()).toThrow();
    });
  });

  describe('default values', () => {
    it('relayUrl defaults to wss://api.generacy.ai/relay', () => {
      const config = loadConfig({ apiKey: 'key' });
      expect(config.relayUrl).toBe('wss://api.generacy.ai/relay');
    });

    it('orchestratorUrl defaults to http://localhost:3000', () => {
      const config = loadConfig({ apiKey: 'key' });
      expect(config.orchestratorUrl).toBe('http://localhost:3000');
    });

    it('requestTimeoutMs defaults to 30000', () => {
      const config = loadConfig({ apiKey: 'key' });
      expect(config.requestTimeoutMs).toBe(30000);
    });

    it('heartbeatIntervalMs defaults to 30000', () => {
      const config = loadConfig({ apiKey: 'key' });
      expect(config.heartbeatIntervalMs).toBe(30000);
    });

    it('baseReconnectDelayMs defaults to 5000', () => {
      const config = loadConfig({ apiKey: 'key' });
      expect(config.baseReconnectDelayMs).toBe(5000);
    });

    it('maxReconnectDelayMs defaults to 300000', () => {
      const config = loadConfig({ apiKey: 'key' });
      expect(config.maxReconnectDelayMs).toBe(300000);
    });

    it('orchestratorApiKey is undefined by default', () => {
      const config = loadConfig({ apiKey: 'key' });
      expect(config.orchestratorApiKey).toBeUndefined();
    });
  });

  describe('RelayConfigSchema', () => {
    it('is exported and usable for direct parsing', () => {
      const result = RelayConfigSchema.safeParse({ apiKey: 'key' });
      expect(result.success).toBe(true);
    });

    it('rejects invalid data', () => {
      const result = RelayConfigSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });
});
