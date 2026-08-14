/**
 * SC-005a: `loadConfigWithWarnings` emits a warning naming `effort` and the
 * provider when `effort` is set but the provider has no CLI mechanism.
 *
 * The probe (`effort-mechanism-probe.ts`) is stubbed to `false` so the
 * warning fires deterministically — under the currently-shipped plugin
 * (Claude CLI v2.1.150 exposes `--effort`), the warning is dead code.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Stub the probe BEFORE importing the loader (vi.mock hoists).
vi.mock('../effort-mechanism-probe.js', () => ({
  hasEffortMechanism: (_provider: string) => false,
}));

import { loadConfigWithWarnings } from '../loader.js';

describe('loadConfigWithWarnings — SC-005a warnings (issue #1095)', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'generacy-warnings-'));
    mkdirSync(join(testDir, '.generacy'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): void {
    writeFileSync(join(testDir, '.generacy', 'config.yaml'), yaml);
  }

  it('emits a warning naming effort and the provider claude-code when hasEffortMechanism returns false', () => {
    writeConfig(`
project:
  id: "proj_sc005a123"
  name: "SC-005a"
repos:
  primary: "github.com/test/repo"
defaults:
  agent: claude-code
orchestrator:
  agents:
    workflows:
      speckit-feature:
        phases:
          implement:
            model: opus-4-7
            effort: high
`);
    const { warnings } = loadConfigWithWarnings({ startDir: testDir });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('effort');
    expect(warnings[0]).toContain('claude-code');
    expect(warnings[0]).toContain('high');
    expect(warnings[0]).toContain('orchestrator.agents.workflows.speckit-feature.phases.implement');
  });

  it('emits zero warnings when no effort is set (even if probe would return false)', () => {
    writeConfig(`
project:
  id: "proj_noeffort123"
  name: "No effort"
repos:
  primary: "github.com/test/repo"
orchestrator:
  agents:
    workflows:
      speckit-feature:
        phases:
          implement:
            model: opus-4-7
`);
    const { warnings } = loadConfigWithWarnings({ startDir: testDir });
    expect(warnings).toEqual([]);
  });

  it('emits one warning per configured effort field across the block', () => {
    writeConfig(`
project:
  id: "proj_multieffort1"
  name: "Multi"
repos:
  primary: "github.com/test/repo"
orchestrator:
  agents:
    default:
      effort: max
    workflows:
      speckit-feature:
        default:
          effort: xhigh
        phases:
          plan:
            effort: high
`);
    const { warnings } = loadConfigWithWarnings({ startDir: testDir });
    expect(warnings.length).toBe(3);
    for (const w of warnings) {
      expect(w).toContain('effort');
    }
  });
});
