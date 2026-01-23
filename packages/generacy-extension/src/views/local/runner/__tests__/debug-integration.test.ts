/**
 * Tests for debug integration hooks
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DebugHooks,
  getDebugHooks,
  resetDebugHooks,
  type Breakpoint,
  type StepState,
} from '../debug-integration';

describe('DebugHooks', () => {
  let hooks: DebugHooks;

  beforeEach(() => {
    hooks = new DebugHooks();
  });

  describe('enable/disable', () => {
    it('should start disabled', () => {
      expect(hooks.isEnabled()).toBe(false);
    });

    it('should enable and disable', () => {
      hooks.enable();
      expect(hooks.isEnabled()).toBe(true);

      hooks.disable();
      expect(hooks.isEnabled()).toBe(false);
    });
  });

  describe('breakpoints', () => {
    it('should add and get breakpoints', () => {
      const bp: Breakpoint = {
        id: 'bp1',
        stepName: 'step1',
        enabled: true,
      };

      hooks.addBreakpoint(bp);
      const breakpoints = hooks.getBreakpoints();

      expect(breakpoints).toHaveLength(1);
      expect(breakpoints[0]?.id).toBe('bp1');
    });

    it('should remove breakpoints', () => {
      hooks.addBreakpoint({ id: 'bp1', stepName: 'step1', enabled: true });
      hooks.addBreakpoint({ id: 'bp2', stepName: 'step2', enabled: true });

      hooks.removeBreakpoint('bp1');

      expect(hooks.getBreakpoints()).toHaveLength(1);
      expect(hooks.getBreakpoints()[0]?.id).toBe('bp2');
    });

    it('should enable/disable breakpoints', () => {
      hooks.addBreakpoint({ id: 'bp1', stepName: 'step1', enabled: true });

      hooks.setBreakpointEnabled('bp1', false);

      expect(hooks.getBreakpoints()[0]?.enabled).toBe(false);
    });

    it('should clear all breakpoints', () => {
      hooks.addBreakpoint({ id: 'bp1', stepName: 'step1', enabled: true });
      hooks.addBreakpoint({ id: 'bp2', stepName: 'step2', enabled: true });

      hooks.clearBreakpoints();

      expect(hooks.getBreakpoints()).toHaveLength(0);
    });
  });

  describe('beforeStep hook', () => {
    it('should not pause when disabled', async () => {
      hooks.addBreakpoint({ id: 'bp1', stepName: 'step1', enabled: true });

      const state = DebugHooks.createStepState(
        { name: 'step1', action: 'test' },
        'phase1',
        0
      );

      await hooks.beforeStep(state);

      expect(state.isPaused).toBe(false);
    });

    it('should pause when enabled and breakpoint matches', async () => {
      const onPause = vi.fn();
      hooks.setCallbacks({ onPause });
      hooks.enable();
      hooks.addBreakpoint({ id: 'bp1', stepName: 'step1', enabled: true });

      const state = DebugHooks.createStepState(
        { name: 'step1', action: 'test' },
        'phase1',
        0
      );

      // Start beforeStep in background (it will pause)
      const beforeStepPromise = hooks.beforeStep(state);

      // Give it time to pause
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(onPause).toHaveBeenCalled();
      expect(hooks.getIsPaused()).toBe(true);

      // Resume to complete the test
      hooks.resume();
      await beforeStepPromise;

      expect(hooks.getIsPaused()).toBe(false);
    });

    it('should not pause for disabled breakpoints', async () => {
      hooks.enable();
      hooks.addBreakpoint({ id: 'bp1', stepName: 'step1', enabled: false });

      const state = DebugHooks.createStepState(
        { name: 'step1', action: 'test' },
        'phase1',
        0
      );

      await hooks.beforeStep(state);

      expect(state.isPaused).toBe(false);
    });

    it('should not pause for non-matching step names', async () => {
      hooks.enable();
      hooks.addBreakpoint({ id: 'bp1', stepName: 'other-step', enabled: true });

      const state = DebugHooks.createStepState(
        { name: 'step1', action: 'test' },
        'phase1',
        0
      );

      await hooks.beforeStep(state);

      expect(state.isPaused).toBe(false);
    });

    it('should respect phase-specific breakpoints', async () => {
      const onPause = vi.fn();
      hooks.setCallbacks({ onPause });
      hooks.enable();
      hooks.addBreakpoint({
        id: 'bp1',
        stepName: 'step1',
        phaseName: 'phase2', // Breakpoint for phase2
        enabled: true,
      });

      // State is in phase1, should not pause
      const state = DebugHooks.createStepState(
        { name: 'step1', action: 'test' },
        'phase1',
        0
      );

      await hooks.beforeStep(state);

      expect(onPause).not.toHaveBeenCalled();
    });

    it('should respect hit count', async () => {
      const onPause = vi.fn();
      hooks.setCallbacks({ onPause });
      hooks.enable();
      hooks.addBreakpoint({
        id: 'bp1',
        stepName: 'step1',
        enabled: true,
        hitCount: 3, // Only pause on 3rd hit
      });

      const state = DebugHooks.createStepState(
        { name: 'step1', action: 'test' },
        'phase1',
        0
      );

      // First two hits should not pause
      await hooks.beforeStep(state);
      expect(onPause).not.toHaveBeenCalled();

      await hooks.beforeStep(state);
      expect(onPause).not.toHaveBeenCalled();

      // Third hit should pause
      const thirdPromise = hooks.beforeStep(state);
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(onPause).toHaveBeenCalled();

      // Cleanup
      hooks.resume();
      await thirdPromise;
    });
  });

  describe('afterStep hook', () => {
    it('should call callback when enabled', () => {
      const onAfterStep = vi.fn();
      hooks.setCallbacks({ onAfterStep });
      hooks.enable();

      const state = DebugHooks.createStepState(
        { name: 'step1', action: 'test' },
        'phase1',
        0
      );

      hooks.afterStep(state, {
        stepName: 'step1',
        phaseName: 'phase1',
        status: 'completed',
        startTime: Date.now(),
      });

      expect(onAfterStep).toHaveBeenCalled();
      expect(onAfterStep).toHaveBeenCalledWith(
        expect.objectContaining({
          result: expect.objectContaining({ status: 'completed' }),
        })
      );
    });

    it('should not call callback when disabled', () => {
      const onAfterStep = vi.fn();
      hooks.setCallbacks({ onAfterStep });

      const state = DebugHooks.createStepState(
        { name: 'step1', action: 'test' },
        'phase1',
        0
      );

      hooks.afterStep(state, {
        stepName: 'step1',
        phaseName: 'phase1',
        status: 'completed',
        startTime: Date.now(),
      });

      expect(onAfterStep).not.toHaveBeenCalled();
    });
  });

  describe('onError hook', () => {
    it('should call callback when enabled', () => {
      const onError = vi.fn();
      hooks.setCallbacks({ onError });
      hooks.enable();

      const state = DebugHooks.createStepState(
        { name: 'step1', action: 'test' },
        'phase1',
        0
      );

      const error = new Error('Test error');
      hooks.onError(state, error);

      expect(onError).toHaveBeenCalledWith(state, error);
    });
  });

  describe('resume', () => {
    it('should resume paused execution', async () => {
      hooks.enable();
      hooks.addBreakpoint({ id: 'bp1', stepName: 'step1', enabled: true });

      const state = DebugHooks.createStepState(
        { name: 'step1', action: 'test' },
        'phase1',
        0
      );

      // Start pausing
      const beforeStepPromise = hooks.beforeStep(state);

      await new Promise(resolve => setTimeout(resolve, 10));
      expect(hooks.getIsPaused()).toBe(true);

      // Resume
      hooks.resume();

      await beforeStepPromise;
      expect(hooks.getIsPaused()).toBe(false);
    });

    it('should be safe to call when not paused', () => {
      expect(() => hooks.resume()).not.toThrow();
    });
  });

  describe('getCurrentState', () => {
    it('should return current state when paused', async () => {
      hooks.enable();
      hooks.addBreakpoint({ id: 'bp1', stepName: 'step1', enabled: true });

      const state = DebugHooks.createStepState(
        { name: 'step1', action: 'test' },
        'phase1',
        0
      );

      const beforeStepPromise = hooks.beforeStep(state);

      await new Promise(resolve => setTimeout(resolve, 10));

      const currentState = hooks.getCurrentState();
      expect(currentState?.step.name).toBe('step1');

      hooks.resume();
      await beforeStepPromise;
    });

    it('should return null initially', () => {
      expect(hooks.getCurrentState()).toBe(null);
    });
  });
});

describe('Global Debug Hooks', () => {
  beforeEach(() => {
    resetDebugHooks();
  });

  it('should return singleton instance', () => {
    const hooks1 = getDebugHooks();
    const hooks2 = getDebugHooks();
    expect(hooks1).toBe(hooks2);
  });

  it('should reset instance', () => {
    const hooks1 = getDebugHooks();
    hooks1.enable();
    hooks1.addBreakpoint({ id: 'bp1', stepName: 'step1', enabled: true });

    resetDebugHooks();

    const hooks2 = getDebugHooks();
    expect(hooks2.isEnabled()).toBe(false);
    expect(hooks2.getBreakpoints()).toHaveLength(0);
  });
});
