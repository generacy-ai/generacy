import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { isPostActivationSettledSync } from '../services/post-activation-settled-probe.js';

describe('isPostActivationSettledSync', () => {
  let tempDir: string;
  let keyFilePath: string;
  let markerPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'post-activation-settled-probe-'));
    keyFilePath = join(tempDir, 'cluster-api-key');
    markerPath = join(tempDir, 'post-activation-restart-done');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns true when neither key nor marker exist (local cluster)', () => {
    expect(isPostActivationSettledSync({ keyFilePath, markerPath })).toBe(true);
  });

  it('returns true when only marker exists (no key)', () => {
    writeFileSync(markerPath, '');
    expect(isPostActivationSettledSync({ keyFilePath, markerPath })).toBe(true);
  });

  it('returns false when key exists but marker is absent (wizard pre-restart)', () => {
    writeFileSync(keyFilePath, 'test-key');
    expect(isPostActivationSettledSync({ keyFilePath, markerPath })).toBe(false);
  });

  it('returns true when both key and marker exist (wizard post-restart)', () => {
    writeFileSync(keyFilePath, 'test-key');
    writeFileSync(markerPath, '');
    expect(isPostActivationSettledSync({ keyFilePath, markerPath })).toBe(true);
  });

  it('uses default paths when no options are provided', () => {
    // Defaults point at /var/lib/generacy/* which don't exist in tests —
    // that means `!activated || markerPresent` → `true` on this host.
    expect(isPostActivationSettledSync()).toBe(true);
  });

  // SC-004 regression guard: a local `generacy launch` cluster (which never
  // activates against the cloud and therefore has no cluster-api-key file)
  // must report `postActivationReady: true` immediately at boot. Otherwise
  // this fix would permanently gate the VS Code tunnel on every local run.
  it('SC-004: local cluster (no key file) is settled at boot — never gated', () => {
    // markerPath is absent; keyFilePath is absent → predicate === true.
    expect(isPostActivationSettledSync({ keyFilePath, markerPath })).toBe(true);
  });
});
