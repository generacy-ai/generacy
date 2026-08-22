// #1165 Corner 3 (FR-005 / FR-006) — speckit-bugfix `implementation-review`
// gate under `ciMergeGateEnabled`.
//
// The #1133 relocation transform (`config.ts:229-247`) matches uniformly on
// `gateLabel === 'waiting-for:implementation-review'`, so speckit-bugfix is
// rewritten by the same rule as speckit-feature. Flag OFF (default) is a no-op
// keeping the gate byte-identical to today; flag ON moves the gate off
// `implement` onto `validate` completion, firing only once CI is green
// (`on-ci-green`). Test-only — pins the existing transform, no production change.
//
// See `contracts/bugfix-ci-gate.md`.
import { describe, it, expect } from 'vitest';
import { WorkerConfigSchema } from '../config.js';
import type { GateDefinition } from '../types.js';

function bugfixGates(ciMergeGateEnabled: boolean): GateDefinition[] {
  const cfg = WorkerConfigSchema.parse({ ciMergeGateEnabled });
  return cfg.gates['speckit-bugfix']!;
}

function implementationReviewGate(gates: GateDefinition[]): GateDefinition | undefined {
  return gates.find((g) => g.gateLabel === 'waiting-for:implementation-review');
}

describe('speckit-bugfix implementation-review gate under ciMergeGateEnabled (#1165 Corner 3)', () => {
  it('INV-2: flag OFF (default) ⇒ gate stays on implement/on-request (byte-identical)', () => {
    const gate = implementationReviewGate(bugfixGates(false));
    expect(gate).toEqual({
      phase: 'implement',
      gateLabel: 'waiting-for:implementation-review',
      condition: 'on-request',
    });
  });

  it('INV-1: flag ON ⇒ gate relocates to validate/on-ci-green', () => {
    const gate = implementationReviewGate(bugfixGates(true));
    expect(gate).toEqual({
      phase: 'validate',
      gateLabel: 'waiting-for:implementation-review',
      condition: 'on-ci-green',
    });
  });

  it('INV-3: other speckit-bugfix gates are unaffected by the flag', () => {
    const off = bugfixGates(false);
    const on = bugfixGates(true);

    const others = (gates: GateDefinition[]) =>
      gates.filter((g) => g.gateLabel !== 'waiting-for:implementation-review');

    // clarification, merge-conflicts (x2), remediation-limit — identical either way.
    expect(others(on)).toEqual(others(off));

    // Spot-check the specific gates the contract names (INV-3).
    expect(off).toContainEqual({
      phase: 'clarify',
      gateLabel: 'waiting-for:clarification',
      condition: 'on-questions',
    });
    expect(off).toContainEqual({
      phase: 'implement',
      gateLabel: 'waiting-for:merge-conflicts',
      condition: 'on-merge-conflict',
    });
    expect(off).toContainEqual({
      phase: 'review',
      gateLabel: 'waiting-for:remediation-limit',
      condition: 'on-remediation-limit',
    });
  });
});
