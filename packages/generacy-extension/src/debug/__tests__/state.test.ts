/**
 * Tests for Debug Execution State
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock VS Code API
vi.mock('vscode', () => ({
  EventEmitter: vi.fn().mockImplementation(() => ({
    event: vi.fn(),
    fire: vi.fn(),
    dispose: vi.fn(),
  })),
}));

// Import after mocking
import {
  DebugExecutionState,
  getDebugExecutionState,
  resetDebugExecutionState,
} from '../state';

describe('DebugExecutionState', () => {
  let state: DebugExecutionState;

  beforeEach(() => {
    resetDebugExecutionState();
    state = getDebugExecutionState();
  });

  afterEach(() => {
    resetDebugExecutionState();
  });

  describe('initialize', () => {
    it('should initialize workflow state', () => {
      state.initialize('test-workflow', '/path/test.yaml', [
        { name: 'setup', steps: [{ name: 'step1' }, { name: 'step2' }] },
        { name: 'build', steps: [{ name: 'compile' }] },
      ]);

      const workflowState = state.getWorkflowState();
      expect(workflowState).toBeDefined();
      expect(workflowState?.name).toBe('test-workflow');
      expect(workflowState?.filePath).toBe('/path/test.yaml');
      expect(workflowState?.status).toBe('idle');
      expect(workflowState?.phases).toHaveLength(2);
    });

    it('should initialize with environment variables', () => {
      state.initialize(
        'test',
        '/path/test.yaml',
        [{ name: 'setup', steps: [{ name: 'step1' }] }],
        { NODE_ENV: 'test', DEBUG: 'true' }
      );

      const workflowState = state.getWorkflowState();
      expect(workflowState?.environment.get('NODE_ENV')).toBe('test');
      expect(workflowState?.environment.get('DEBUG')).toBe('true');
    });

    it('should clear previous state on re-initialize', () => {
      state.initialize('first', '/path/first.yaml', [
        { name: 'phase1', steps: [{ name: 's1' }] },
      ]);
      state.setVariable('workflow', 'var1', 'value1');

      state.initialize('second', '/path/second.yaml', [
        { name: 'phase2', steps: [{ name: 's2' }] },
      ]);

      const workflowState = state.getWorkflowState();
      expect(workflowState?.name).toBe('second');
      expect(workflowState?.variables.has('var1')).toBe(false);
    });
  });

  describe('getCurrentPhase', () => {
    beforeEach(() => {
      state.initialize('test', '/path/test.yaml', [
        { name: 'setup', steps: [{ name: 'step1' }] },
        { name: 'build', steps: [{ name: 'step2' }] },
      ]);
    });

    it('should return first phase initially', () => {
      const phase = state.getCurrentPhase();
      expect(phase?.name).toBe('setup');
    });

    it('should return undefined when not initialized', () => {
      resetDebugExecutionState();
      const newState = getDebugExecutionState();
      expect(newState.getCurrentPhase()).toBeUndefined();
    });
  });

  describe('getCurrentStep', () => {
    beforeEach(() => {
      state.initialize('test', '/path/test.yaml', [
        { name: 'setup', steps: [{ name: 'step1' }, { name: 'step2' }] },
      ]);
    });

    it('should return first step initially', () => {
      const step = state.getCurrentStep();
      expect(step?.name).toBe('step1');
    });

    it('should return undefined when not initialized', () => {
      resetDebugExecutionState();
      const newState = getDebugExecutionState();
      expect(newState.getCurrentStep()).toBeUndefined();
    });
  });

  describe('workflow lifecycle', () => {
    beforeEach(() => {
      state.initialize('test', '/path/test.yaml', [
        { name: 'setup', steps: [{ name: 'step1' }] },
      ]);
    });

    it('should start workflow', () => {
      state.startWorkflow();
      expect(state.getWorkflowState()?.status).toBe('running');
      expect(state.getWorkflowState()?.startTime).toBeDefined();
    });

    it('should complete workflow', () => {
      state.startWorkflow();
      state.complete();
      expect(state.getWorkflowState()?.status).toBe('completed');
      expect(state.getWorkflowState()?.endTime).toBeDefined();
    });

    it('should fail workflow', () => {
      state.startWorkflow();
      state.fail('Test error');
      expect(state.getWorkflowState()?.status).toBe('failed');
    });

    it('should cancel workflow', () => {
      state.startWorkflow();
      state.cancel();
      expect(state.getWorkflowState()?.status).toBe('cancelled');
    });

    it('should pause and resume workflow', () => {
      state.startWorkflow();
      state.pause();
      expect(state.getWorkflowState()?.status).toBe('paused');

      state.resume();
      expect(state.getWorkflowState()?.status).toBe('running');
    });
  });

  describe('phase lifecycle', () => {
    beforeEach(() => {
      state.initialize('test', '/path/test.yaml', [
        { name: 'setup', steps: [{ name: 'step1' }] },
        { name: 'build', steps: [{ name: 'step2' }] },
      ]);
    });

    it('should start phase', () => {
      state.startPhase('setup');
      const phase = state.getWorkflowState()?.phases.find(p => p.name === 'setup');
      expect(phase?.status).toBe('running');
    });

    it('should complete phase successfully', () => {
      state.startPhase('setup');
      state.completePhase('setup', true);
      const phase = state.getWorkflowState()?.phases.find(p => p.name === 'setup');
      expect(phase?.status).toBe('completed');
    });

    it('should fail phase', () => {
      state.startPhase('setup');
      state.completePhase('setup', false);
      const phase = state.getWorkflowState()?.phases.find(p => p.name === 'setup');
      expect(phase?.status).toBe('failed');
    });
  });

  describe('step lifecycle', () => {
    beforeEach(() => {
      state.initialize('test', '/path/test.yaml', [
        { name: 'setup', steps: [{ name: 'step1' }, { name: 'step2' }] },
      ]);
    });

    it('should start step', () => {
      state.startStep('setup', 'step1');
      const phase = state.getWorkflowState()?.phases.find(p => p.name === 'setup');
      const step = phase?.steps.find(s => s.name === 'step1');
      expect(step?.status).toBe('running');
      expect(step?.startTime).toBeDefined();
    });

    it('should complete step successfully', () => {
      state.startStep('setup', 'step1');
      state.completeStep('setup', 'step1', true, 'output', undefined, 0);
      const phase = state.getWorkflowState()?.phases.find(p => p.name === 'setup');
      const step = phase?.steps.find(s => s.name === 'step1');
      expect(step?.status).toBe('completed');
      expect(step?.output).toBe('output');
      expect(step?.exitCode).toBe(0);
    });

    it('should fail step', () => {
      state.startStep('setup', 'step1');
      state.completeStep('setup', 'step1', false, undefined, 'error message', 1);
      const phase = state.getWorkflowState()?.phases.find(p => p.name === 'setup');
      const step = phase?.steps.find(s => s.name === 'step1');
      expect(step?.status).toBe('failed');
      expect(step?.error).toBe('error message');
      expect(step?.exitCode).toBe(1);
    });

    it('should skip step', () => {
      state.skipStep('setup', 'step1', 'Condition not met');
      const phase = state.getWorkflowState()?.phases.find(p => p.name === 'setup');
      const step = phase?.steps.find(s => s.name === 'step1');
      expect(step?.status).toBe('skipped');
    });
  });

  describe('advanceStep', () => {
    beforeEach(() => {
      state.initialize('test', '/path/test.yaml', [
        { name: 'setup', steps: [{ name: 'step1' }, { name: 'step2' }] },
        { name: 'build', steps: [{ name: 'step3' }] },
      ]);
    });

    it('should advance to next step in phase', () => {
      state.startWorkflow();
      state.advanceStep();
      expect(state.getCurrentStep()?.name).toBe('step2');
    });

    it('should advance to next phase when phase is complete', () => {
      state.startWorkflow();
      state.advanceStep(); // step2
      state.advanceStep(); // next phase, step3
      expect(state.getCurrentPhase()?.name).toBe('build');
      expect(state.getCurrentStep()?.name).toBe('step3');
    });

    it('should complete workflow when all phases done', () => {
      state.startWorkflow();
      state.advanceStep(); // step2
      state.advanceStep(); // step3
      state.advanceStep(); // complete

      expect(state.getWorkflowState()?.status).toBe('completed');
    });

    it('should return false when workflow is complete', () => {
      state.startWorkflow();
      state.advanceStep();
      state.advanceStep();
      const result = state.advanceStep();
      expect(result).toBe(false);
    });
  });

  describe('setVariable', () => {
    beforeEach(() => {
      state.initialize('test', '/path/test.yaml', [
        { name: 'setup', steps: [{ name: 'step1' }] },
      ]);
    });

    it('should set workflow-scoped variable', () => {
      state.setVariable('workflow', 'myVar', 'myValue');
      expect(state.getWorkflowState()?.variables.get('myVar')).toBe('myValue');
    });

    it('should set environment variable', () => {
      state.setVariable('environment', 'MY_ENV', 'envValue');
      expect(state.getWorkflowState()?.environment.get('MY_ENV')).toBe('envValue');
    });

    it('should set phase-scoped variable', () => {
      state.setVariable('phase', 'phaseVar', 'phaseValue', 'setup');
      const phase = state.getWorkflowState()?.phases.find(p => p.name === 'setup');
      expect(phase?.variables.get('phaseVar')).toBe('phaseValue');
    });

    it('should set local (step) variable', () => {
      state.setVariable('local', 'localVar', 'localValue', 'setup', 'step1');
      const phase = state.getWorkflowState()?.phases.find(p => p.name === 'setup');
      const step = phase?.steps.find(s => s.name === 'step1');
      expect(step?.variables.get('localVar')).toBe('localValue');
    });
  });

  describe('setOutput', () => {
    beforeEach(() => {
      state.initialize('test', '/path/test.yaml', [
        { name: 'setup', steps: [{ name: 'step1' }] },
      ]);
    });

    it('should set output value', () => {
      state.setOutput('result', { success: true });
      expect(state.getWorkflowState()?.outputs.get('result')).toEqual({
        success: true,
      });
    });
  });

  describe('getScopes', () => {
    beforeEach(() => {
      state.initialize('test', '/path/test.yaml', [
        { name: 'setup', steps: [{ name: 'step1' }] },
      ]);
    });

    it('should return scopes for variables view', () => {
      const scopes = state.getScopes(1);
      expect(scopes.length).toBeGreaterThanOrEqual(4);

      const scopeNames = scopes.map(s => s.name);
      expect(scopeNames).toContain('Local');
      expect(scopeNames).toContain('Phase');
      expect(scopeNames).toContain('Workflow');
      expect(scopeNames).toContain('Environment');
    });

    it('should include Outputs scope when outputs exist', () => {
      state.setOutput('result', 'test');
      const scopes = state.getScopes(1);
      const scopeNames = scopes.map(s => s.name);
      expect(scopeNames).toContain('Outputs');
    });
  });

  describe('getVariables', () => {
    beforeEach(() => {
      state.initialize('test', '/path/test.yaml', [
        { name: 'setup', steps: [{ name: 'step1' }] },
      ]);
    });

    it('should return variables for valid reference', () => {
      state.setVariable('workflow', 'testVar', 'testValue');
      const scopes = state.getScopes(1);
      const workflowScope = scopes.find(s => s.name === 'Workflow');

      const variables = state.getVariables(workflowScope!.variablesReference);
      expect(variables.length).toBe(1);
      expect(variables[0]?.name).toBe('testVar');
      expect(variables[0]?.value).toBe('testValue');
    });

    it('should return empty for invalid reference', () => {
      const variables = state.getVariables(99999);
      expect(variables).toEqual([]);
    });
  });

  describe('getHistory', () => {
    beforeEach(() => {
      state.initialize('test', '/path/test.yaml', [
        { name: 'setup', steps: [{ name: 'step1' }] },
      ]);
    });

    it('should track history entries', () => {
      state.startWorkflow();
      state.startPhase('setup');
      state.startStep('setup', 'step1');
      state.setVariable('workflow', 'var1', 'value1');

      const history = state.getHistory();
      expect(history.length).toBeGreaterThan(0);
    });

    it('should include timestamp in history entries', () => {
      state.startWorkflow();
      const history = state.getHistory();
      expect(history[0]?.timestamp).toBeDefined();
      expect(history[0]?.timestamp).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('reset', () => {
    it('should reset all state', () => {
      state.initialize('test', '/path/test.yaml', [
        { name: 'setup', steps: [{ name: 'step1' }] },
      ]);
      state.startWorkflow();
      state.setVariable('workflow', 'var1', 'value1');

      state.reset();

      expect(state.getWorkflowState()).toBeUndefined();
      expect(state.getCurrentPhase()).toBeUndefined();
      expect(state.getCurrentStep()).toBeUndefined();
      expect(state.getHistory()).toHaveLength(0);
    });
  });

  describe('singleton', () => {
    it('should return same instance', () => {
      const instance1 = getDebugExecutionState();
      const instance2 = getDebugExecutionState();
      expect(instance1).toBe(instance2);
    });

    it('should reset singleton', () => {
      const instance1 = getDebugExecutionState();
      instance1.initialize('test', '/path/test.yaml', [
        { name: 'setup', steps: [{ name: 'step1' }] },
      ]);

      resetDebugExecutionState();
      const instance2 = getDebugExecutionState();

      expect(instance2.getWorkflowState()).toBeUndefined();
    });
  });
});

describe('Nested Variable Expansion', () => {
  let state: DebugExecutionState;

  beforeEach(() => {
    resetDebugExecutionState();
    state = getDebugExecutionState();
    state.initialize('test', '/path/test.yaml', [
      { name: 'setup', steps: [{ name: 'step1' }] },
    ]);
  });

  afterEach(() => {
    resetDebugExecutionState();
  });

  it('should create expandable reference for object variables', () => {
    state.setVariable('workflow', 'config', { host: 'localhost', port: 8080 });
    const scopes = state.getScopes(1);
    const workflowScope = scopes.find(s => s.name === 'Workflow');

    const variables = state.getVariables(workflowScope!.variablesReference);
    const configVar = variables.find(v => v.name === 'config');

    expect(configVar).toBeDefined();
    expect(configVar?.variablesReference).toBeGreaterThan(0);
  });

  it('should create expandable reference for array variables', () => {
    state.setVariable('workflow', 'items', ['a', 'b', 'c']);
    const scopes = state.getScopes(1);
    const workflowScope = scopes.find(s => s.name === 'Workflow');

    const variables = state.getVariables(workflowScope!.variablesReference);
    const itemsVar = variables.find(v => v.name === 'items');

    expect(itemsVar).toBeDefined();
    expect(itemsVar?.variablesReference).toBeGreaterThan(0);
  });

  it('should return nested object properties', () => {
    state.setVariable('workflow', 'config', { host: 'localhost', port: 8080 });
    const scopes = state.getScopes(1);
    const workflowScope = scopes.find(s => s.name === 'Workflow');

    const variables = state.getVariables(workflowScope!.variablesReference);
    const configVar = variables.find(v => v.name === 'config');

    // Get nested variables
    const nestedVars = state.getVariables(configVar!.variablesReference);

    expect(nestedVars).toHaveLength(2);
    expect(nestedVars.find(v => v.name === 'host')?.value).toBe('localhost');
    expect(nestedVars.find(v => v.name === 'port')?.value).toBe('8080');
  });

  it('should return array elements with indexed names', () => {
    state.setVariable('workflow', 'items', ['first', 'second', 'third']);
    const scopes = state.getScopes(1);
    const workflowScope = scopes.find(s => s.name === 'Workflow');

    const variables = state.getVariables(workflowScope!.variablesReference);
    const itemsVar = variables.find(v => v.name === 'items');

    // Get nested variables
    const nestedVars = state.getVariables(itemsVar!.variablesReference);

    expect(nestedVars).toHaveLength(3);
    expect(nestedVars[0]?.name).toBe('[0]');
    expect(nestedVars[0]?.value).toBe('first');
    expect(nestedVars[1]?.name).toBe('[1]');
    expect(nestedVars[1]?.value).toBe('second');
    expect(nestedVars[2]?.name).toBe('[2]');
    expect(nestedVars[2]?.value).toBe('third');
  });

  it('should not create references for primitive values', () => {
    state.setVariable('workflow', 'count', 42);
    state.setVariable('workflow', 'name', 'test');
    state.setVariable('workflow', 'active', true);

    const scopes = state.getScopes(1);
    const workflowScope = scopes.find(s => s.name === 'Workflow');

    const variables = state.getVariables(workflowScope!.variablesReference);

    for (const v of variables) {
      expect(v.variablesReference).toBe(0);
    }
  });

  it('should limit expansion to one level deep', () => {
    state.setVariable('workflow', 'nested', {
      level1: {
        level2: { level3: 'deep' },
      },
    });

    const scopes = state.getScopes(1);
    const workflowScope = scopes.find(s => s.name === 'Workflow');

    const variables = state.getVariables(workflowScope!.variablesReference);
    const nestedVar = variables.find(v => v.name === 'nested');

    // First level should be expandable
    expect(nestedVar?.variablesReference).toBeGreaterThan(0);

    // Get first level properties
    const level1Vars = state.getVariables(nestedVar!.variablesReference);
    const level1Prop = level1Vars.find(v => v.name === 'level1');

    // Second level should NOT be expandable (returns 0 reference)
    expect(level1Prop?.variablesReference).toBe(0);
  });

  it('should return empty array for invalid reference', () => {
    const variables = state.getVariables(99999);
    expect(variables).toEqual([]);
  });
});
