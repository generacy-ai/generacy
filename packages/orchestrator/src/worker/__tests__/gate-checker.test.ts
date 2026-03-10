import { describe, it, expect } from 'vitest';
import { GateChecker } from '../gate-checker.js';
import type { Logger } from '../types.js';
import type { WorkerConfig } from '../config.js';

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => mockLogger,
} as unknown as Logger;

function makeConfig(gates: WorkerConfig['gates']): WorkerConfig {
  return {
    phaseTimeoutMs: 600_000,
    workspaceDir: '/tmp/orchestrator-workspaces',
    shutdownGracePeriodMs: 5000,
    validateCommand: 'pnpm test && pnpm build',
    gates,
  };
}

describe('GateChecker', () => {
  const checker = new GateChecker(mockLogger);

  const defaultGates: WorkerConfig['gates'] = {
    'speckit-feature': [
      { phase: 'clarify', gateLabel: 'waiting-for:clarification', condition: 'always' },
    ],
    'speckit-bugfix': [
      { phase: 'clarify', gateLabel: 'waiting-for:clarification', condition: 'always' },
    ],
  };

  it('returns gate definition for speckit-feature workflow, clarify phase (condition: always)', () => {
    const config = makeConfig(defaultGates);
    const result = checker.checkGate('clarify', 'speckit-feature', config);

    expect(result).toEqual({
      phase: 'clarify',
      gateLabel: 'waiting-for:clarification',
      condition: 'always',
    });
  });

  it('returns null for speckit-feature workflow, specify phase (no gate for this phase)', () => {
    const config = makeConfig(defaultGates);
    const result = checker.checkGate('specify', 'speckit-feature', config);

    expect(result).toBeNull();
  });

  it('returns gate definition for speckit-bugfix workflow, clarify phase (condition: always)', () => {
    const config = makeConfig(defaultGates);
    const result = checker.checkGate('clarify', 'speckit-bugfix', config);

    expect(result).toEqual({
      phase: 'clarify',
      gateLabel: 'waiting-for:clarification',
      condition: 'always',
    });
  });

  it('returns null for unknown workflow name', () => {
    const config = makeConfig(defaultGates);
    const result = checker.checkGate('clarify', 'unknown-workflow', config);

    expect(result).toBeNull();
  });

  it('returns gate with on-questions condition for custom gate config', () => {
    const config = makeConfig({
      'custom-workflow': [
        { phase: 'plan', gateLabel: 'waiting-for:answers', condition: 'on-questions' },
      ],
    });
    const result = checker.checkGate('plan', 'custom-workflow', config);

    expect(result).toEqual({
      phase: 'plan',
      gateLabel: 'waiting-for:answers',
      condition: 'on-questions',
    });
  });

  it('returns correct gate when multiple gates exist for same workflow', () => {
    const config = makeConfig({
      'multi-gate-workflow': [
        { phase: 'clarify', gateLabel: 'waiting-for:clarification', condition: 'always' },
        { phase: 'plan', gateLabel: 'waiting-for:plan-review', condition: 'on-questions' },
        { phase: 'validate', gateLabel: 'waiting-for:validation', condition: 'on-failure' },
      ],
    });

    const clarifyResult = checker.checkGate('clarify', 'multi-gate-workflow', config);
    expect(clarifyResult).toEqual({
      phase: 'clarify',
      gateLabel: 'waiting-for:clarification',
      condition: 'always',
    });

    const planResult = checker.checkGate('plan', 'multi-gate-workflow', config);
    expect(planResult).toEqual({
      phase: 'plan',
      gateLabel: 'waiting-for:plan-review',
      condition: 'on-questions',
    });

    const validateResult = checker.checkGate('validate', 'multi-gate-workflow', config);
    expect(validateResult).toEqual({
      phase: 'validate',
      gateLabel: 'waiting-for:validation',
      condition: 'on-failure',
    });

    // Phase with no gate in this workflow
    const specifyResult = checker.checkGate('specify', 'multi-gate-workflow', config);
    expect(specifyResult).toBeNull();
  });
});
