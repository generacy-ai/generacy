import { describe, it, expect } from 'vitest';
import { AppConfigSchema, AppConfigEnvEntrySchema, AppConfigFileEntrySchema, ClusterYamlSchema } from '../context.js';

describe('AppConfigSchema', () => {
  it('parses a full appConfig example', () => {
    const input = {
      schemaVersion: '1',
      env: [
        { name: 'SERVICE_ANTHROPIC_API_KEY', secret: true, description: 'Anthropic API key' },
        { name: 'LIVEKIT_URL', secret: false },
        { name: 'TWILIO_AUTH_TOKEN', secret: true, required: true },
      ],
      files: [
        { id: 'gcp-sa-json', mountPath: '/home/node/.config/gcloud/secrets/sa.json' },
      ],
    };

    const result = AppConfigSchema.parse(input);

    expect(result.schemaVersion).toBe('1');
    expect(result.env).toHaveLength(3);
    expect(result.env[0]!.name).toBe('SERVICE_ANTHROPIC_API_KEY');
    expect(result.env[0]!.secret).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.id).toBe('gcp-sa-json');
    expect(result.files[0]!.mountPath).toBe('/home/node/.config/gcloud/secrets/sa.json');
  });

  it('applies defaults for optional fields', () => {
    const input = {
      schemaVersion: '1',
      env: [{ name: 'TEST_VAR' }],
      files: [{ id: 'test-file', mountPath: '/tmp/test' }],
    };

    const result = AppConfigSchema.parse(input);

    expect(result.env[0]!.secret).toBe(false);
    expect(result.env[0]!.required).toBe(true);
    expect(result.files[0]!.required).toBe(true);
  });

  it('defaults env and files to empty arrays', () => {
    const input = { schemaVersion: '1' };

    const result = AppConfigSchema.parse(input);

    expect(result.env).toEqual([]);
    expect(result.files).toEqual([]);
  });

  it('rejects invalid schemaVersion', () => {
    const input = { schemaVersion: '2', env: [], files: [] };

    expect(() => AppConfigSchema.parse(input)).toThrow();
  });
});

describe('ClusterYamlSchema with appConfig', () => {
  it('parses minimal cluster.yaml without appConfig', () => {
    const result = ClusterYamlSchema.parse({});

    expect(result.channel).toBe('stable');
    expect(result.workers).toBe(1);
    expect(result.variant).toBe('cluster-base');
    expect(result.appConfig).toBeUndefined();
  });

  it('parses cluster.yaml with appConfig', () => {
    const input = {
      channel: 'preview',
      workers: 2,
      variant: 'cluster-microservices',
      appConfig: {
        schemaVersion: '1',
        env: [{ name: 'MY_VAR', secret: true }],
        files: [],
      },
    };

    const result = ClusterYamlSchema.parse(input);

    expect(result.appConfig).toBeDefined();
    expect(result.appConfig!.env).toHaveLength(1);
    expect(result.appConfig!.env[0]!.name).toBe('MY_VAR');
  });
});

describe('AppConfigEnvEntrySchema', () => {
  it('requires name to be non-empty', () => {
    expect(() => AppConfigEnvEntrySchema.parse({ name: '' })).toThrow();
  });

  it('accepts all fields', () => {
    const result = AppConfigEnvEntrySchema.parse({
      name: 'TEST',
      description: 'A test var',
      secret: true,
      default: 'foo',
      required: false,
    });
    expect(result.name).toBe('TEST');
    expect(result.description).toBe('A test var');
    expect(result.secret).toBe(true);
    expect(result.default).toBe('foo');
    expect(result.required).toBe(false);
  });
});

describe('AppConfigFileEntrySchema', () => {
  it('requires id and mountPath to be non-empty', () => {
    expect(() => AppConfigFileEntrySchema.parse({ id: '', mountPath: '/tmp/test' })).toThrow();
    expect(() => AppConfigFileEntrySchema.parse({ id: 'test', mountPath: '' })).toThrow();
  });

  it('accepts valid file entry', () => {
    const result = AppConfigFileEntrySchema.parse({
      id: 'sa-key',
      description: 'Service account',
      mountPath: '/home/node/.config/sa.json',
      required: false,
    });
    expect(result.id).toBe('sa-key');
    expect(result.required).toBe(false);
  });
});
