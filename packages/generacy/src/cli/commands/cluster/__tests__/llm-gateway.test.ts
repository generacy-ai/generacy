import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveLlmGatewayToggle,
  generateGatewayToken,
  readExistingGatewayToken,
  scaffoldLlmGatewayFiles,
} from '../llm-gateway.js';
import { scaffoldDockerCompose, scaffoldEnvFile } from '../scaffolder.js';

const TOKEN_RE = /^sk-bf-[0-9a-f]{48}$/;

describe('resolveLlmGatewayToggle', () => {
  it('explicit flag wins over everything', () => {
    expect(resolveLlmGatewayToggle({ flag: true, env: 'true', persisted: false })).toBe(true);
    expect(resolveLlmGatewayToggle({ flag: false, env: 'true', persisted: true })).toBe(false);
  });

  it('env=true is honored when flag is absent', () => {
    expect(resolveLlmGatewayToggle({ env: 'true' })).toBe(true);
    expect(resolveLlmGatewayToggle({ env: 'true', persisted: false })).toBe(true);
  });

  it('a non-"true" env value does not enable', () => {
    expect(resolveLlmGatewayToggle({ env: '1' })).toBe(false);
    expect(resolveLlmGatewayToggle({ env: 'yes' })).toBe(false);
    expect(resolveLlmGatewayToggle({ env: '' })).toBe(false);
  });

  it('persisted value is used when flag and env are absent', () => {
    expect(resolveLlmGatewayToggle({ persisted: true })).toBe(true);
    expect(resolveLlmGatewayToggle({ persisted: false })).toBe(false);
  });

  it('defaults to false when nothing is provided', () => {
    expect(resolveLlmGatewayToggle({})).toBe(false);
  });
});

describe('generateGatewayToken', () => {
  it('produces an sk-bf- prefixed 48-hex token', () => {
    const token = generateGatewayToken();
    expect(token).toMatch(TOKEN_RE);
  });

  it('produces a distinct token each call', () => {
    expect(generateGatewayToken()).not.toBe(generateGatewayToken());
  });
});

describe('readExistingGatewayToken', () => {
  it('extracts the token value from .env content', () => {
    const env = 'FOO=bar\nGENERACY_LLM_GATEWAY_TOKEN=sk-bf-abc123\nBAZ=qux\n';
    expect(readExistingGatewayToken(env)).toBe('sk-bf-abc123');
  });

  it('returns undefined when the line is absent', () => {
    expect(readExistingGatewayToken('FOO=bar\n')).toBeUndefined();
  });

  it('returns undefined when the value is empty', () => {
    expect(readExistingGatewayToken('GENERACY_LLM_GATEWAY_TOKEN=\n')).toBeUndefined();
  });
});

describe('scaffoldEnvFile token lifecycle', () => {
  let dir: string;

  const baseEnv = {
    clusterId: 'c1',
    projectId: 'p1',
    orgId: 'o1',
    cloudUrl: 'https://api.generacy.ai',
    projectName: 'test',
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'llm-gateway-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('generates an sk-bf- token when enabled and absent', () => {
    scaffoldEnvFile(dir, { ...baseEnv, llmGateway: true });
    const token = readExistingGatewayToken(readFileSync(join(dir, '.env'), 'utf-8'));
    expect(token).toMatch(TOKEN_RE);
  });

  it('reuses the existing token on re-scaffold (generate-once)', () => {
    scaffoldEnvFile(dir, { ...baseEnv, llmGateway: true });
    const first = readExistingGatewayToken(readFileSync(join(dir, '.env'), 'utf-8'));
    scaffoldEnvFile(dir, { ...baseEnv, llmGateway: true });
    const second = readExistingGatewayToken(readFileSync(join(dir, '.env'), 'utf-8'));
    expect(second).toBe(first);
  });

  it('preserves an existing token on a disabled re-scaffold (FR-008)', () => {
    scaffoldEnvFile(dir, { ...baseEnv, llmGateway: true });
    const first = readExistingGatewayToken(readFileSync(join(dir, '.env'), 'utf-8'));
    scaffoldEnvFile(dir, { ...baseEnv, llmGateway: false });
    const content = readFileSync(join(dir, '.env'), 'utf-8');
    expect(readExistingGatewayToken(content)).toBe(first);
  });

  it('emits no token line when disabled and absent', () => {
    scaffoldEnvFile(dir, { ...baseEnv, llmGateway: false });
    const content = readFileSync(join(dir, '.env'), 'utf-8');
    expect(content).not.toContain('GENERACY_LLM_GATEWAY_TOKEN');
  });
});

describe('scaffoldLlmGatewayFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'llm-gateway-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes config.example.json, config.json, .gitignore, and .env.local', () => {
    scaffoldLlmGatewayFiles(dir);
    expect(existsSync(join(dir, 'llm-gateway', 'config.example.json'))).toBe(true);
    expect(existsSync(join(dir, 'llm-gateway', 'config.json'))).toBe(true);
    expect(existsSync(join(dir, 'llm-gateway', '.gitignore'))).toBe(true);
    expect(existsSync(join(dir, '.env.local'))).toBe(true);
  });

  it('config.example.json references the token by env, never a literal secret', () => {
    scaffoldLlmGatewayFiles(dir);
    const example = readFileSync(join(dir, 'llm-gateway', 'config.example.json'), 'utf-8');
    const parsed = JSON.parse(example);
    expect(parsed.governance.virtual_keys[0].value).toBe('env.GENERACY_LLM_GATEWAY_TOKEN');
    expect(example).not.toMatch(/sk-bf-[0-9a-f]{48}/);
  });

  it('featherless is a custom OpenAI-compatible provider with a /v1-less base URL', () => {
    scaffoldLlmGatewayFiles(dir);
    const parsed = JSON.parse(readFileSync(join(dir, 'llm-gateway', 'config.example.json'), 'utf-8'));
    const featherless = parsed.providers.featherless;
    expect(featherless.network_config.base_url).toBe('https://api.featherless.ai');
    expect(featherless.custom_provider_config.base_provider_type).toBe('openai');
    expect(featherless.custom_provider_config.allowed_requests).toEqual({
      list_models: false,
      chat_completion: true,
      chat_completion_stream: true,
    });
  });

  it('.gitignore ignores config.json', () => {
    scaffoldLlmGatewayFiles(dir);
    expect(readFileSync(join(dir, 'llm-gateway', '.gitignore'), 'utf-8')).toBe('config.json\n');
  });

  it('creates config.json from the example once and never overwrites it', () => {
    scaffoldLlmGatewayFiles(dir);
    const configPath = join(dir, 'llm-gateway', 'config.json');
    const handEdited = '{"hand":"edited"}\n';
    writeFileSync(configPath, handEdited, 'utf-8');

    scaffoldLlmGatewayFiles(dir);
    expect(readFileSync(configPath, 'utf-8')).toBe(handEdited);
  });

  it('regenerates config.example.json every scaffold', () => {
    scaffoldLlmGatewayFiles(dir);
    const examplePath = join(dir, 'llm-gateway', 'config.example.json');
    writeFileSync(examplePath, 'stale', 'utf-8');

    scaffoldLlmGatewayFiles(dir);
    expect(readFileSync(examplePath, 'utf-8')).not.toBe('stale');
  });

  it('never overwrites an existing .env.local', () => {
    const envLocalPath = join(dir, '.env.local');
    const operatorContent = 'OPENROUTER_API_KEY=sk-real-key\n';
    writeFileSync(envLocalPath, operatorContent, 'utf-8');

    scaffoldLlmGatewayFiles(dir);
    expect(readFileSync(envLocalPath, 'utf-8')).toBe(operatorContent);
  });
});

describe('scaffoldDockerCompose gateway files (disabled path)', () => {
  let dir: string;

  const baseInput = {
    imageTag: 'ghcr.io/generacy-ai/cluster-base:1.5.0',
    clusterId: 'clust_abc',
    projectId: 'proj_def',
    projectName: 'todo-list-example',
    cloudUrl: 'https://api.generacy.ai',
    variant: 'cluster-base' as const,
    orgId: 'org_xyz',
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'llm-gateway-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits no llm-gateway/ dir or .env.local when disabled (FR-008)', () => {
    scaffoldDockerCompose(dir, { ...baseInput, llmGateway: false });
    expect(existsSync(join(dir, 'llm-gateway'))).toBe(false);
    expect(existsSync(join(dir, '.env.local'))).toBe(false);
  });

  it('emits gateway files when enabled', () => {
    scaffoldDockerCompose(dir, { ...baseInput, llmGateway: true });
    expect(existsSync(join(dir, 'llm-gateway', 'config.json'))).toBe(true);
    expect(existsSync(join(dir, '.env.local'))).toBe(true);
  });
});
