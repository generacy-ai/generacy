import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { createWizardCredsTokenProvider } from '../../../src/services/wizard-creds-token-provider.js';

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

describe('createWizardCredsTokenProvider', () => {
  let tmpDir: string;
  let envFilePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wizard-creds-test-'));
    envFilePath = join(tmpDir, 'wizard-credentials.env');
  });

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns undefined when file is missing', async () => {
    const logger = createMockLogger();
    const provider = createWizardCredsTokenProvider(envFilePath, logger);

    const result = await provider();

    expect(result).toBeUndefined();
  });

  it('returns undefined when GH_TOKEN is absent from file', async () => {
    const logger = createMockLogger();
    writeFileSync(envFilePath, 'SOME_OTHER_VAR=hello\nANOTHER=world\n');
    const provider = createWizardCredsTokenProvider(envFilePath, logger);

    const result = await provider();

    expect(result).toBeUndefined();
  });

  it('returns undefined when GH_TOKEN has empty value', async () => {
    const logger = createMockLogger();
    writeFileSync(envFilePath, 'GH_TOKEN=\n');
    const provider = createWizardCredsTokenProvider(envFilePath, logger);

    const result = await provider();

    expect(result).toBeUndefined();
  });

  it('returns token when GH_TOKEN is present', async () => {
    const logger = createMockLogger();
    writeFileSync(envFilePath, 'GH_TOKEN=abc123\n');
    const provider = createWizardCredsTokenProvider(envFilePath, logger);

    const result = await provider();

    expect(result).toBe('abc123');
  });

  it('uses stat-based cache and does not re-read unchanged file', async () => {
    const logger = createMockLogger();
    writeFileSync(envFilePath, 'GH_TOKEN=cached-value\n');
    const provider = createWizardCredsTokenProvider(envFilePath, logger);

    const first = await provider();
    const second = await provider();

    expect(first).toBe('cached-value');
    expect(second).toBe('cached-value');
  });

  it('picks up new value when file is updated', async () => {
    const logger = createMockLogger();
    writeFileSync(envFilePath, 'GH_TOKEN=old-value\n');
    const provider = createWizardCredsTokenProvider(envFilePath, logger);

    const first = await provider();
    expect(first).toBe('old-value');

    // Write new content and bump mtime to ensure stat detects the change
    writeFileSync(envFilePath, 'GH_TOKEN=new-value\n');
    const future = new Date(Date.now() + 2000);
    utimesSync(envFilePath, future, future);

    const second = await provider();
    expect(second).toBe('new-value');
  });

  it('logs warn once on first failure, not on subsequent failures', async () => {
    const logger = createMockLogger();
    // File does not exist — each call should fail
    const provider = createWizardCredsTokenProvider(envFilePath, logger);

    await provider();
    await provider();
    await provider();

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('logs info once on recovery after failure', async () => {
    const logger = createMockLogger();
    // Start with no file (failure state)
    const provider = createWizardCredsTokenProvider(envFilePath, logger);

    await provider();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // Create the file with a valid token (recovery)
    writeFileSync(envFilePath, 'GH_TOKEN=recovered\n');

    const result = await provider();
    expect(result).toBe('recovered');
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      { envFilePath },
      'GitHub token resolution resumed',
    );

    // Call again — should not log info a second time
    await provider();
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('handles export prefix: export GH_TOKEN=abc123', async () => {
    const logger = createMockLogger();
    writeFileSync(envFilePath, 'export GH_TOKEN=abc123\n');
    const provider = createWizardCredsTokenProvider(envFilePath, logger);

    const result = await provider();

    expect(result).toBe('abc123');
  });

  it('handles comments and empty lines', async () => {
    const logger = createMockLogger();
    writeFileSync(
      envFilePath,
      [
        '# This is a comment',
        '',
        '   ',
        'SOME_VAR=foo',
        '# Another comment',
        'GH_TOKEN=from-comments-file',
        '',
      ].join('\n'),
    );
    const provider = createWizardCredsTokenProvider(envFilePath, logger);

    const result = await provider();

    expect(result).toBe('from-comments-file');
  });
});
