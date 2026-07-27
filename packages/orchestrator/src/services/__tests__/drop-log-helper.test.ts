import { describe, it, expect, vi } from 'vitest';
import {
  classifyDropSeverity,
  emitDropLog,
  type DropTransitionState,
} from '../drop-log-helper.js';

/**
 * Pure-function tests for #1054 `classifyDropSeverity` + `emitDropLog`.
 * All `it()` names carry FR-006/FR-007/SC-003 markers per the FR-tagged
 * convention already used in `redis-queue-adapter.enqueueIfAbsent.test.ts`.
 */

const ITEM_KEY_A = 'test-org/test-repo#1054';
const ITEM_KEY_B = 'test-org/test-repo#2000';
const THRESHOLD = 1_800_000; // 30 min — default

describe('classifyDropSeverity', () => {
  describe('below threshold (healthy age)', () => {
    it('FR-006: fresh entry below threshold → info, no transition edge', () => {
      const state = new Map<string, DropTransitionState>();

      const decision = classifyDropSeverity(ITEM_KEY_A, 1_000, THRESHOLD, state);

      expect(decision.severity).toBe('info');
      expect(decision.isTransitionEdge).toBe(false);
      expect(decision.stateAfter.lastSeverity).toBe('info');
    });

    it('FR-006: second call still below threshold → info, no transition edge', () => {
      const state = new Map<string, DropTransitionState>();

      classifyDropSeverity(ITEM_KEY_A, 1_000, THRESHOLD, state);
      const decision = classifyDropSeverity(ITEM_KEY_A, 2_000, THRESHOLD, state);

      expect(decision.severity).toBe('info');
      expect(decision.isTransitionEdge).toBe(false);
    });
  });

  describe('crossing threshold upward', () => {
    it('FR-006: crossing threshold upward → warn with isTransitionEdge=true', () => {
      const state = new Map<string, DropTransitionState>();

      // Start below threshold to establish an 'info' state.
      classifyDropSeverity(ITEM_KEY_A, 1_000, THRESHOLD, state);
      // Now cross over.
      const decision = classifyDropSeverity(
        ITEM_KEY_A,
        THRESHOLD + 1,
        THRESHOLD,
        state,
      );

      expect(decision.severity).toBe('warn');
      expect(decision.isTransitionEdge).toBe(true);
      expect(decision.stateAfter.lastSeverity).toBe('warn');
      // State Map carries `lastSeverity: 'warn'` after the first edge.
      expect(state.get(ITEM_KEY_A)?.lastSeverity).toBe('warn');
    });

    it('SC-003: second call at same warn state → warn severity, no transition edge (anti-spam)', () => {
      // Per FR-006 between-transitions cycles must NOT emit repeated `warn`s.
      // The severity stays `warn` between edges but callers use
      // `isTransitionEdge` to decide whether to emit at all.
      const state = new Map<string, DropTransitionState>();

      classifyDropSeverity(ITEM_KEY_A, 1_000, THRESHOLD, state); // info
      classifyDropSeverity(ITEM_KEY_A, THRESHOLD + 1, THRESHOLD, state); // warn edge
      const decision = classifyDropSeverity(
        ITEM_KEY_A,
        THRESHOLD + 100,
        THRESHOLD,
        state,
      );

      expect(decision.severity).toBe('warn');
      expect(decision.isTransitionEdge).toBe(false);
      expect(state.get(ITEM_KEY_A)?.lastSeverity).toBe('warn');
    });
  });

  describe('falling back below threshold', () => {
    it('FR-006: transition down from warn to info emits transition-edge info', () => {
      const state = new Map<string, DropTransitionState>();

      classifyDropSeverity(ITEM_KEY_A, THRESHOLD + 1, THRESHOLD, state); // warn (edge)
      const decision = classifyDropSeverity(ITEM_KEY_A, 500, THRESHOLD, state);

      expect(decision.severity).toBe('info');
      expect(decision.isTransitionEdge).toBe(true);
      expect(decision.stateAfter.lastSeverity).toBe('info');
    });
  });

  describe('fail-safe: null ageMs', () => {
    it('FR-007: null ageMs → info fail-safe, no state mutation', () => {
      const state = new Map<string, DropTransitionState>();
      state.set(ITEM_KEY_A, { lastSeverity: 'warn' });

      const decision = classifyDropSeverity(ITEM_KEY_A, null, THRESHOLD, state);

      expect(decision.severity).toBe('info');
      expect(decision.isTransitionEdge).toBe(false);
      // Pre-existing state must be preserved (no mutation).
      expect(state.get(ITEM_KEY_A)?.lastSeverity).toBe('warn');
    });

    it('FR-007: null ageMs with no prior state → info fail-safe, still no state mutation', () => {
      const state = new Map<string, DropTransitionState>();

      const decision = classifyDropSeverity(ITEM_KEY_A, null, THRESHOLD, state);

      expect(decision.severity).toBe('info');
      expect(decision.isTransitionEdge).toBe(false);
      // No prior state → no new state written.
      expect(state.has(ITEM_KEY_A)).toBe(false);
    });
  });

  describe('state isolation across itemKeys', () => {
    it('SC-004: two different itemKeys have independent state (no cross-contamination via shared Map)', () => {
      const state = new Map<string, DropTransitionState>();

      // itemKey A crosses threshold; itemKey B does not.
      classifyDropSeverity(ITEM_KEY_A, THRESHOLD + 1, THRESHOLD, state);

      const decisionForB = classifyDropSeverity(
        ITEM_KEY_B,
        1_000,
        THRESHOLD,
        state,
      );

      expect(decisionForB.severity).toBe('info');
      expect(decisionForB.isTransitionEdge).toBe(false);
      // A stays warn; B stays info.
      expect(state.get(ITEM_KEY_A)?.lastSeverity).toBe('warn');
      expect(state.get(ITEM_KEY_B)?.lastSeverity).toBe('info');
    });
  });

  describe('threshold boundary', () => {
    it('FR-006: ageMs === thresholdMs is not yet warn (strict >)', () => {
      const state = new Map<string, DropTransitionState>();

      const decision = classifyDropSeverity(
        ITEM_KEY_A,
        THRESHOLD,
        THRESHOLD,
        state,
      );

      expect(decision.severity).toBe('info');
      expect(decision.isTransitionEdge).toBe(false);
    });

    it('FR-006: ageMs === thresholdMs + 1 is warn (strict >)', () => {
      const state = new Map<string, DropTransitionState>();

      const decision = classifyDropSeverity(
        ITEM_KEY_A,
        THRESHOLD + 1,
        THRESHOLD,
        state,
      );

      expect(decision.severity).toBe('warn');
      expect(decision.isTransitionEdge).toBe(true);
    });
  });
});

describe('emitDropLog', () => {
  it('dispatches to logger.info when severity=info', () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const decision = {
      severity: 'info' as const,
      isTransitionEdge: false,
      stateAfter: { lastSeverity: 'info' as const },
    };

    emitDropLog(logger, decision, { itemKey: 'a', reason: 'in-flight' }, 'msg');

    expect(logger.info).toHaveBeenCalledWith(
      { itemKey: 'a', reason: 'in-flight' },
      'msg',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('dispatches to logger.warn when severity=warn AND isTransitionEdge=true (first-alert)', () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const decision = {
      severity: 'warn' as const,
      isTransitionEdge: true,
      stateAfter: { lastSeverity: 'warn' as const },
    };

    emitDropLog(logger, decision, { itemKey: 'a', reason: 'in-flight' }, 'msg');

    expect(logger.warn).toHaveBeenCalledWith(
      { itemKey: 'a', reason: 'in-flight' },
      'msg',
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('FR-006 anti-spam: dispatches to logger.info when severity=warn AND isTransitionEdge=false (repeat)', () => {
    // Per contract table row 5: subsequent drops for a wedged itemKey emit
    // at info, not warn. Only the first crossing of the threshold produces
    // a `warn` line (SC-003).
    const logger = { info: vi.fn(), warn: vi.fn() };
    const decision = {
      severity: 'warn' as const,
      isTransitionEdge: false,
      stateAfter: { lastSeverity: 'warn' as const },
    };

    emitDropLog(logger, decision, { itemKey: 'a', reason: 'in-flight' }, 'msg');

    expect(logger.info).toHaveBeenCalledWith(
      { itemKey: 'a', reason: 'in-flight' },
      'msg',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('FR-006 transition-down: dispatches to logger.info when severity=info AND isTransitionEdge=true (clear)', () => {
    // The transition down (wedge cleared) emits at info — the wedge-cleared
    // event is not alarm-worthy; only the wedge-detected event is.
    const logger = { info: vi.fn(), warn: vi.fn() };
    const decision = {
      severity: 'info' as const,
      isTransitionEdge: true,
      stateAfter: { lastSeverity: 'info' as const },
    };

    emitDropLog(logger, decision, { itemKey: 'a', reason: 'in-flight' }, 'msg');

    expect(logger.info).toHaveBeenCalledWith(
      { itemKey: 'a', reason: 'in-flight' },
      'msg',
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
