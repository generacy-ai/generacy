/**
 * FR-012 production-code boundary (#1068).
 *
 * Static grep: no `SIMULATE_PHASE_[A-Z]+` identifiers may appear in shipped
 * code paths. Fault-injection logic must live in `__tests__/` only. Runs in
 * the same test suite so a rogue phase-simulation env var introduced in the
 * same PR trips this immediately.
 *
 * See specs/1068-problem-gate-identity-work/contracts/production-code-boundary.md.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// .../packages/orchestrator/src/__tests__/cockpit-gates → repo root (5 up)
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');

const TARGET_DIRS = [
  'packages/orchestrator/src',
  'packages/control-plane/src',
  'packages/cluster-relay/src',
  'packages/generacy/src',
  'packages/cockpit/src',
];

describe('FR-012 production-code boundary', () => {
  it('no SIMULATE_PHASE_* identifiers in shipped code', () => {
    // Guard against the vacuous pass: `|| true` swallows grep's "no such file"
    // exit, and execSync captures only stdout — so a wrong root or a renamed
    // package would make this assert `'' === ''` while grepping nothing.
    for (const dir of TARGET_DIRS) {
      expect(existsSync(resolve(REPO_ROOT, dir)), `grep target missing: ${dir}`).toBe(true);
    }
    // `|| true` prevents grep's exit-1 (no match) from failing execSync.
    const cmd = [
      "grep -rE 'SIMULATE_PHASE_[A-Z]+'",
      ...TARGET_DIRS,
      "--exclude-dir=__tests__ --exclude-dir=tests --exclude='*.test.ts' --exclude='*.spec.ts'",
      '|| true',
    ].join(' ');
    const output = execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf-8' }).trim();
    expect(output).toBe('');
  });
});
