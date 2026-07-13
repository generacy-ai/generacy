import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../../types/logger.js';
import { tryLoadCommentTrustConfig } from '../comment-trust-config.js';

function makeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('tryLoadCommentTrustConfig', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'comment-trust-'));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  function writeConfig(contents: string) {
    const dir = join(workspaceDir, '.agency');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'comment-trust.yaml'), contents);
  }

  it('returns undefined when file is missing, no warn', () => {
    const logger = makeLogger();
    const result = tryLoadCommentTrustConfig(workspaceDir, logger);
    expect(result).toBeUndefined();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns undefined for malformed YAML with one warn', () => {
    writeConfig(':: not: valid ][ yaml');
    const logger = makeLogger();
    const result = tryLoadCommentTrustConfig(workspaceDir, logger);
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatch(/malformed YAML/i);
  });

  it('returns undefined for schema violation (tiers not an array) with warn naming field', () => {
    writeConfig(`widen:\n  tiers: not-an-array\n`);
    const logger = makeLogger();
    const result = tryLoadCommentTrustConfig(workspaceDir, logger);
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const meta = logger.warn.mock.calls[0]![1] as { failedField: string };
    expect(meta.failedField).toContain('tiers');
  });

  it('returns undefined for extra top-level key via .strict()', () => {
    writeConfig(`wide:\n  tiers: [CONTRIBUTOR]\n`);
    const logger = makeLogger();
    const result = tryLoadCommentTrustConfig(workspaceDir, logger);
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('parses empty {} as default posture', () => {
    writeConfig('{}');
    const logger = makeLogger();
    const result = tryLoadCommentTrustConfig(workspaceDir, logger);
    expect(result).toEqual({ widen: { tiers: [], logins: [] } });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('parses valid config with widen.tiers and widen.logins', () => {
    writeConfig(`widen:\n  tiers:\n    - CONTRIBUTOR\n  logins:\n    - alice\n    - bob\n`);
    const logger = makeLogger();
    const result = tryLoadCommentTrustConfig(workspaceDir, logger);
    expect(result).toEqual({
      widen: { tiers: ['CONTRIBUTOR'], logins: ['alice', 'bob'] },
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('parses partial widen config (tiers only) with default logins', () => {
    writeConfig(`widen:\n  tiers:\n    - CONTRIBUTOR\n`);
    const logger = makeLogger();
    const result = tryLoadCommentTrustConfig(workspaceDir, logger);
    expect(result).toEqual({
      widen: { tiers: ['CONTRIBUTOR'], logins: [] },
    });
  });

  it('returns undefined for extra nested key inside widen', () => {
    writeConfig(`widen:\n  tiers: [CONTRIBUTOR]\n  extra: value\n`);
    const logger = makeLogger();
    const result = tryLoadCommentTrustConfig(workspaceDir, logger);
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
