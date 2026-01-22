import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock vscode
vi.mock('vscode', () => ({
  EventEmitter: class<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => this.listeners.splice(this.listeners.indexOf(listener), 1) };
    };
    fire(data: T) {
      this.listeners.forEach((l) => l(data));
    }
    dispose() {
      this.listeners = [];
    }
  },
  Uri: {
    file: (path: string) => ({ fsPath: path, toString: () => `file://${path}` }),
  },
  Disposable: class {
    constructor(private fn: () => void) {}
    dispose() {
      this.fn();
    }
  },
}));

// Mock logger
vi.mock('../../../../utils', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { BreakpointManager, getBreakpointManager } from '../breakpoints';
import type { BreakpointLocation } from '../breakpoints';

describe('BreakpointManager', () => {
  let manager: BreakpointManager;
  const mockUri = { fsPath: '/test/workflow.yaml', toString: () => 'file:///test/workflow.yaml' };

  beforeEach(() => {
    BreakpointManager.resetInstance();
    manager = getBreakpointManager();
  });

  afterEach(() => {
    BreakpointManager.resetInstance();
  });

  describe('addBreakpoint', () => {
    it('should add a phase breakpoint', () => {
      const location: BreakpointLocation = {
        type: 'phase',
        phaseName: 'build',
        line: 10,
      };

      const bp = manager.addBreakpoint(mockUri as any, location);

      expect(bp.id).toBeDefined();
      expect(bp.enabled).toBe(true);
      expect(bp.verified).toBe(false);
      expect(bp.location.type).toBe('phase');
      expect(bp.location.phaseName).toBe('build');
    });

    it('should add a step breakpoint', () => {
      const location: BreakpointLocation = {
        type: 'step',
        phaseName: 'build',
        stepName: 'compile',
        line: 15,
      };

      const bp = manager.addBreakpoint(mockUri as any, location);

      expect(bp.location.type).toBe('step');
      expect(bp.location.stepName).toBe('compile');
    });

    it('should add a conditional breakpoint', () => {
      const location: BreakpointLocation = {
        type: 'step',
        phaseName: 'test',
        stepName: 'unit',
        line: 20,
      };

      const bp = manager.addBreakpoint(mockUri as any, location, {
        condition: 'env.DEBUG === true',
      });

      expect(bp.condition).toBe('env.DEBUG === true');
    });

    it('should add a hit conditional breakpoint', () => {
      const location: BreakpointLocation = {
        type: 'step',
        phaseName: 'test',
        stepName: 'unit',
        line: 20,
      };

      const bp = manager.addBreakpoint(mockUri as any, location, {
        hitCondition: '>=3',
      });

      expect(bp.hitCondition).toBe('>=3');
    });

    it('should add a logpoint', () => {
      const location: BreakpointLocation = {
        type: 'step',
        phaseName: 'test',
        stepName: 'unit',
        line: 20,
      };

      const bp = manager.addBreakpoint(mockUri as any, location, {
        logMessage: 'Step {name} executing',
      });

      expect(bp.logMessage).toBe('Step {name} executing');
    });

    it('should emit added event', () => {
      const listener = vi.fn();
      manager.addEventListener(listener);

      const location: BreakpointLocation = {
        type: 'phase',
        phaseName: 'build',
        line: 10,
      };

      manager.addBreakpoint(mockUri as any, location);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'added' })
      );
    });
  });

  describe('removeBreakpoint', () => {
    it('should remove a breakpoint by ID', () => {
      const location: BreakpointLocation = {
        type: 'phase',
        phaseName: 'build',
        line: 10,
      };

      const bp = manager.addBreakpoint(mockUri as any, location);
      const result = manager.removeBreakpoint(bp.id);

      expect(result).toBe(true);
      expect(manager.getBreakpoint(bp.id)).toBeUndefined();
    });

    it('should return false for non-existent breakpoint', () => {
      const result = manager.removeBreakpoint(999);
      expect(result).toBe(false);
    });

    it('should emit removed event', () => {
      const listener = vi.fn();

      const location: BreakpointLocation = {
        type: 'phase',
        phaseName: 'build',
        line: 10,
      };

      const bp = manager.addBreakpoint(mockUri as any, location);
      manager.addEventListener(listener);
      manager.removeBreakpoint(bp.id);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'removed' })
      );
    });
  });

  describe('getBreakpointsForUri', () => {
    it('should return breakpoints for a specific URI', () => {
      const location1: BreakpointLocation = { type: 'phase', phaseName: 'build', line: 10 };
      const location2: BreakpointLocation = { type: 'step', phaseName: 'build', stepName: 'compile', line: 15 };
      const otherUri = { fsPath: '/other/workflow.yaml', toString: () => 'file:///other/workflow.yaml' };

      manager.addBreakpoint(mockUri as any, location1);
      manager.addBreakpoint(mockUri as any, location2);
      manager.addBreakpoint(otherUri as any, { type: 'phase', phaseName: 'test', line: 5 });

      const breakpoints = manager.getBreakpointsForUri(mockUri as any);

      expect(breakpoints).toHaveLength(2);
      expect(breakpoints.every(bp => bp.uri.toString() === mockUri.toString())).toBe(true);
    });
  });

  describe('setBreakpointsForUri', () => {
    it('should replace existing breakpoints', () => {
      const location: BreakpointLocation = { type: 'phase', phaseName: 'old', line: 5 };
      manager.addBreakpoint(mockUri as any, location);

      const newBreakpoints = [
        { line: 10, condition: 'x > 5' },
        { line: 20 },
      ];

      const resolver = (line: number): BreakpointLocation => ({
        type: 'step',
        phaseName: 'test',
        stepName: `step-${line}`,
        line,
      });

      const result = manager.setBreakpointsForUri(mockUri as any, newBreakpoints, resolver);

      expect(result).toHaveLength(2);
      expect(manager.getBreakpointsForUri(mockUri as any)).toHaveLength(2);
    });
  });

  describe('shouldStopAt', () => {
    it('should stop at an enabled phase breakpoint', () => {
      const location: BreakpointLocation = {
        type: 'phase',
        phaseName: 'build',
        line: 10,
      };

      manager.addBreakpoint(mockUri as any, location);

      const result = manager.shouldStopAt(mockUri as any, 'build');

      expect(result).toBeDefined();
      expect(result?.location.phaseName).toBe('build');
    });

    it('should stop at an enabled step breakpoint', () => {
      const location: BreakpointLocation = {
        type: 'step',
        phaseName: 'build',
        stepName: 'compile',
        line: 15,
      };

      manager.addBreakpoint(mockUri as any, location);

      const result = manager.shouldStopAt(mockUri as any, 'build', 'compile');

      expect(result).toBeDefined();
      expect(result?.location.stepName).toBe('compile');
    });

    it('should not stop at disabled breakpoint', () => {
      const location: BreakpointLocation = {
        type: 'phase',
        phaseName: 'build',
        line: 10,
      };

      const bp = manager.addBreakpoint(mockUri as any, location);
      manager.setBreakpointEnabled(bp.id, false);

      const result = manager.shouldStopAt(mockUri as any, 'build');

      expect(result).toBeUndefined();
    });

    it('should not stop when location does not match', () => {
      const location: BreakpointLocation = {
        type: 'phase',
        phaseName: 'build',
        line: 10,
      };

      manager.addBreakpoint(mockUri as any, location);

      const result = manager.shouldStopAt(mockUri as any, 'test');

      expect(result).toBeUndefined();
    });

    it('should respect hit condition', () => {
      const location: BreakpointLocation = {
        type: 'phase',
        phaseName: 'build',
        line: 10,
      };

      manager.addBreakpoint(mockUri as any, location, {
        hitCondition: '3',
      });

      // First two hits should not stop
      expect(manager.shouldStopAt(mockUri as any, 'build')).toBeUndefined();
      expect(manager.shouldStopAt(mockUri as any, 'build')).toBeUndefined();
      // Third hit should stop
      expect(manager.shouldStopAt(mockUri as any, 'build')).toBeDefined();
    });

    it('should respect conditional breakpoint with simple value comparison', () => {
      const location: BreakpointLocation = {
        type: 'step',
        phaseName: 'build',
        stepName: 'compile',
        line: 15,
      };

      // Use a simple truthy/falsy condition
      manager.addBreakpoint(mockUri as any, location, {
        condition: 'enabled',
      });

      // Should not stop when condition evaluates to false
      const result1 = manager.shouldStopAt(mockUri as any, 'build', 'compile', { enabled: false });
      expect(result1).toBeUndefined();

      // Reset hit count for next test
      manager.resetHitCounts();

      // Should stop when condition evaluates to true
      const result2 = manager.shouldStopAt(mockUri as any, 'build', 'compile', { enabled: true });
      expect(result2).toBeDefined();
    });
  });

  describe('setBreakpointEnabled', () => {
    it('should enable/disable a breakpoint', () => {
      const location: BreakpointLocation = {
        type: 'phase',
        phaseName: 'build',
        line: 10,
      };

      const bp = manager.addBreakpoint(mockUri as any, location);
      expect(bp.enabled).toBe(true);

      manager.setBreakpointEnabled(bp.id, false);
      expect(manager.getBreakpoint(bp.id)?.enabled).toBe(false);

      manager.setBreakpointEnabled(bp.id, true);
      expect(manager.getBreakpoint(bp.id)?.enabled).toBe(true);
    });
  });

  describe('clearAllBreakpoints', () => {
    it('should remove all breakpoints', () => {
      const location1: BreakpointLocation = { type: 'phase', phaseName: 'build', line: 10 };
      const location2: BreakpointLocation = { type: 'step', phaseName: 'test', stepName: 'unit', line: 20 };

      manager.addBreakpoint(mockUri as any, location1);
      manager.addBreakpoint(mockUri as any, location2);

      expect(manager.getAllBreakpoints()).toHaveLength(2);

      manager.clearAllBreakpoints();

      expect(manager.getAllBreakpoints()).toHaveLength(0);
    });
  });

  describe('resetHitCounts', () => {
    it('should reset all hit counts', () => {
      const location: BreakpointLocation = {
        type: 'phase',
        phaseName: 'build',
        line: 10,
      };

      const bp = manager.addBreakpoint(mockUri as any, location);

      // Hit the breakpoint a few times
      manager.shouldStopAt(mockUri as any, 'build');
      manager.shouldStopAt(mockUri as any, 'build');

      expect(manager.getBreakpoint(bp.id)?.hitCount).toBeGreaterThan(0);

      manager.resetHitCounts();

      expect(manager.getBreakpoint(bp.id)?.hitCount).toBe(0);
    });
  });
});
