import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { ClusterLocalBackend } from '@generacy-ai/credhelper';
import { setCredentialBackend } from '../../src/services/credential-writer.js';
import {
  idToEnvName,
  mapCredentialToEnvEntries,
  formatEnvFile,
  writeWizardEnvFile,
} from '../../src/services/wizard-env-writer.js';
import { setRelayPushEvent } from '../../src/relay-events.js';

describe('writeWizardEnvFile', () => {
  let tmpDir: string;
  let agencyDir: string;
  let envFilePath: string;
  let backend: ClusterLocalBackend;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wew-test-'));
    agencyDir = path.join(tmpDir, '.agency');
    envFilePath = path.join(tmpDir, 'wizard-credentials.env');
    await fs.mkdir(agencyDir, { recursive: true });

    backend = new ClusterLocalBackend({
      dataPath: path.join(tmpDir, 'credentials.dat'),
      keyPath: path.join(tmpDir, 'master.key'),
    });
    await backend.init();
    setCredentialBackend(backend);
  });

  afterEach(async () => {
    setRelayPushEvent(undefined as never);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('happy path: writes two credentials to env file', async () => {
    // Store secrets in backend (github-app value is JSON with token field)
    await backend.setSecret('github-main-org', '{"installationId":1,"token":"ghp_abc123"}');
    await backend.setSecret('anthropic-api-key', 'sk-ant-xyz789');

    // Write credentials.yaml
    const yamlContent = {
      credentials: {
        'github-main-org': {
          type: 'github-app',
          backend: 'cluster-local',
          status: 'active',
          updatedAt: '2026-05-12T10:00:00.000Z',
        },
        'anthropic-api-key': {
          type: 'api-key',
          backend: 'cluster-local',
          status: 'active',
          updatedAt: '2026-05-12T10:00:00.000Z',
        },
      },
    };
    await fs.writeFile(
      path.join(agencyDir, 'credentials.yaml'),
      YAML.stringify(yamlContent),
    );

    const result = await writeWizardEnvFile({ agencyDir, envFilePath });

    expect(result.written).toEqual(['github-main-org', 'anthropic-api-key']);
    expect(result.failed).toEqual([]);

    const envContent = await fs.readFile(envFilePath, 'utf8');
    expect(envContent).toContain('GH_TOKEN=ghp_abc123');
    expect(envContent).toContain('ANTHROPIC_API_KEY=sk-ant-xyz789');
  });

  it('empty credentials.yaml: writes empty env file', async () => {
    const yamlContent = { credentials: {} };
    await fs.writeFile(
      path.join(agencyDir, 'credentials.yaml'),
      YAML.stringify(yamlContent),
    );

    const result = await writeWizardEnvFile({ agencyDir, envFilePath });

    expect(result.written).toEqual([]);
    expect(result.failed).toEqual([]);

    const envContent = await fs.readFile(envFilePath, 'utf8');
    expect(envContent).toBe('');
  });

  it('missing credentials.yaml: returns empty result and writes empty env file', async () => {
    const result = await writeWizardEnvFile({ agencyDir, envFilePath });

    expect(result.written).toEqual([]);
    expect(result.failed).toEqual([]);

    const envContent = await fs.readFile(envFilePath, 'utf8');
    expect(envContent).toBe('');
  });

  it('partial unseal failure: writes partial file with failed entries', async () => {
    // Only store one secret — the other will fail to unseal
    await backend.setSecret('github-main-org', '{"installationId":1,"token":"ghp_abc123"}');

    const yamlContent = {
      credentials: {
        'github-main-org': {
          type: 'github-app',
          backend: 'cluster-local',
          status: 'active',
          updatedAt: '2026-05-12T10:00:00.000Z',
        },
        'missing-cred': {
          type: 'api-key',
          backend: 'cluster-local',
          status: 'active',
          updatedAt: '2026-05-12T10:00:00.000Z',
        },
      },
    };
    await fs.writeFile(
      path.join(agencyDir, 'credentials.yaml'),
      YAML.stringify(yamlContent),
    );

    const result = await writeWizardEnvFile({ agencyDir, envFilePath });

    expect(result.written).toEqual(['github-main-org']);
    expect(result.failed).toEqual(['missing-cred']);

    const envContent = await fs.readFile(envFilePath, 'utf8');
    expect(envContent).toContain('GH_TOKEN=ghp_abc123');
    expect(envContent).not.toContain('MISSING_CRED');
  });

  it('writes GH_TOKEN, GH_USERNAME, GH_EMAIL when accountLogin present in stored secret', async () => {
    await backend.setSecret(
      'github-main-org',
      '{"installationId":1,"token":"ghp_abc123","accountLogin":"alice"}',
    );

    const yamlContent = {
      credentials: {
        'github-main-org': {
          type: 'github-app',
          backend: 'cluster-local',
          status: 'active',
          updatedAt: '2026-05-12T10:00:00.000Z',
        },
      },
    };
    await fs.writeFile(
      path.join(agencyDir, 'credentials.yaml'),
      YAML.stringify(yamlContent),
    );

    const result = await writeWizardEnvFile({ agencyDir, envFilePath });

    expect(result.written).toEqual(['github-main-org']);
    expect(result.failed).toEqual([]);

    const envContent = await fs.readFile(envFilePath, 'utf8');
    expect(envContent).toContain('GH_TOKEN=ghp_abc123');
    expect(envContent).toContain('GH_USERNAME=alice');
    expect(envContent).toContain('GH_EMAIL=alice@users.noreply.github.com');
  });

  it('writes env file with mode 0600', async () => {
    await backend.setSecret('github-main-org', '{"installationId":1,"token":"ghp_abc123"}');

    const yamlContent = {
      credentials: {
        'github-main-org': {
          type: 'github-app',
          backend: 'cluster-local',
          status: 'active',
          updatedAt: '2026-05-12T10:00:00.000Z',
        },
      },
    };
    await fs.writeFile(
      path.join(agencyDir, 'credentials.yaml'),
      YAML.stringify(yamlContent),
    );

    await writeWizardEnvFile({ agencyDir, envFilePath });

    const stat = await fs.stat(envFilePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe('mapCredentialToEnvEntries', () => {
  it('maps github-app type to GH_TOKEN by extracting token from JSON', () => {
    const entries = mapCredentialToEnvEntries(
      'github-main-org',
      'github-app',
      '{"installationId":1,"token":"ghs_abc"}',
    );
    expect(entries).toEqual([{ key: 'GH_TOKEN', value: 'ghs_abc' }]);
  });

  it('github-app with accountLogin returns GH_TOKEN + GH_USERNAME + GH_EMAIL', () => {
    const entries = mapCredentialToEnvEntries(
      'github-main-org',
      'github-app',
      '{"installationId":1,"token":"ghs_abc","accountLogin":"alice"}',
    );
    expect(entries).toEqual([
      { key: 'GH_TOKEN', value: 'ghs_abc' },
      { key: 'GH_USERNAME', value: 'alice' },
      { key: 'GH_EMAIL', value: 'alice@users.noreply.github.com' },
    ]);
  });

  it('github-app without accountLogin returns GH_TOKEN only', () => {
    const entries = mapCredentialToEnvEntries(
      'github-main-org',
      'github-app',
      '{"installationId":1,"token":"ghs_abc"}',
    );
    expect(entries).toEqual([{ key: 'GH_TOKEN', value: 'ghs_abc' }]);
  });

  it('github-app with empty string accountLogin returns GH_TOKEN only', () => {
    const entries = mapCredentialToEnvEntries(
      'github-main-org',
      'github-app',
      '{"installationId":1,"token":"ghs_abc","accountLogin":""}',
    );
    expect(entries).toEqual([{ key: 'GH_TOKEN', value: 'ghs_abc' }]);
  });

  it('github-app with missing token field returns empty', () => {
    const entries = mapCredentialToEnvEntries(
      'github-main-org',
      'github-app',
      '{"installationId":1}',
    );
    expect(entries).toEqual([]);
  });

  it('github-app with unparseable value returns empty', () => {
    const entries = mapCredentialToEnvEntries(
      'github-main-org',
      'github-app',
      'not-json',
    );
    expect(entries).toEqual([]);
  });

  it('maps github-pat type to GH_TOKEN', () => {
    const entries = mapCredentialToEnvEntries('my-pat', 'github-pat', 'ghp_pat123');
    expect(entries).toEqual([{ key: 'GH_TOKEN', value: 'ghp_pat123' }]);
  });

  it('maps anthropic-api-key with type api-key to ANTHROPIC_API_KEY', () => {
    const entries = mapCredentialToEnvEntries('anthropic-api-key', 'api-key', 'sk-ant-xyz');
    expect(entries).toEqual([{ key: 'ANTHROPIC_API_KEY', value: 'sk-ant-xyz' }]);
  });

  it('maps generic api-key to UPPER_SNAKE of id', () => {
    const entries = mapCredentialToEnvEntries('stripe-key', 'api-key', 'sk_live_xxx');
    expect(entries).toEqual([{ key: 'STRIPE_KEY', value: 'sk_live_xxx' }]);
  });
});

describe('idToEnvName', () => {
  it('converts kebab-case to UPPER_SNAKE_CASE', () => {
    expect(idToEnvName('my-api-key')).toBe('MY_API_KEY');
  });

  it('converts single word to uppercase', () => {
    expect(idToEnvName('simple')).toBe('SIMPLE');
  });
});

describe('formatEnvFile', () => {
  it('returns empty string for empty array', () => {
    expect(formatEnvFile([])).toBe('');
  });

  it('formats two entries as KEY=value lines', () => {
    const result = formatEnvFile([
      { key: 'KEY1', value: 'val1' },
      { key: 'KEY2', value: 'val2' },
    ]);
    expect(result).toBe('KEY1=val1\nKEY2=val2');
  });
});
