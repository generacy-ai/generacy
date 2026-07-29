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

describe('FR-012 production-code boundary', () => {
  it('no SIMULATE_PHASE_* identifiers in shipped code', () => {
    // `|| true` prevents grep's exit-1 (no match) from failing execSync.
    const cmd = [
      "grep -rE 'SIMULATE_PHASE_[A-Z]+'",
      '  packages/orchestrator/src',
      '  packages/control-plane/src',
      '  packages/cluster-relay/src',
      '  packages/generacy/src/cli/commands/cockpit',
      '  packages/cockpit/src',
      '  --exclude-dir=__tests__',
      '  --exclude-dir=tests',
      "  --exclude='*.test.ts'",
      "  --exclude='*.spec.ts'",
      '  || true',
    ].join(' ');
    const output = execSync(cmd, {
      cwd: '/workspaces/generacy',
      encoding: 'utf-8',
    }).trim();
    expect(output).toBe('');
  });
});
