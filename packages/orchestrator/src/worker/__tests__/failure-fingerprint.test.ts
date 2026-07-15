import { describe, it, expect } from 'vitest';
import {
  computeFailureFingerprint,
  parseFailureAlertMarker,
  REPEAT_FAILURE_THRESHOLD,
  FINGERPRINT_HEX_LENGTH,
} from '../failure-fingerprint.js';
import type { CommandExitEvidence } from '../types.js';

const BASE_EVIDENCE: CommandExitEvidence = {
  command: 'implement',
  exitDescriptor: 'failed post-exit: no-product-code-changes (process exit 0)',
  outputTail: '(no output on either stream)',
  reason:
    'Phase "implement" produced no product-code changes — all changed files are under excluded prefixes [specs/]. Implement must modify at least one non-excluded file.',
};

describe('computeFailureFingerprint', () => {
  it('INV-1 — determinism: structurally equal inputs produce byte-identical output', () => {
    const a = computeFailureFingerprint({ phase: 'implement', evidence: { ...BASE_EVIDENCE } });
    const b = computeFailureFingerprint({ phase: 'implement', evidence: { ...BASE_EVIDENCE } });
    expect(a).toBe(b);
  });

  it('INV-1 — result is lowercase 16-char hex', () => {
    const fp = computeFailureFingerprint({ phase: 'implement', evidence: BASE_EVIDENCE });
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp.length).toBe(FINGERPRINT_HEX_LENGTH);
  });

  it('INV-2 — runId is not part of the fingerprint (runId-agnostic by construction)', () => {
    // computeFailureFingerprint takes { phase, evidence } — no runId field at all.
    // This test is a compile-time-plus-runtime tautology: two invocations at
    // different runIds MUST collapse because runId is not passed.
    const a = computeFailureFingerprint({ phase: 'implement', evidence: BASE_EVIDENCE });
    const b = computeFailureFingerprint({ phase: 'implement', evidence: BASE_EVIDENCE });
    expect(a).toBe(b);
  });

  it('INV-3 — classifier-sensitive: no-product-code-changes vs product-diff-error differ', () => {
    const a = computeFailureFingerprint({
      phase: 'implement',
      evidence: {
        ...BASE_EVIDENCE,
        exitDescriptor: 'failed post-exit: no-product-code-changes (process exit 0)',
      },
    });
    const b = computeFailureFingerprint({
      phase: 'implement',
      evidence: {
        ...BASE_EVIDENCE,
        exitDescriptor: 'failed post-exit: product-diff-error (process exit 0)',
      },
    });
    expect(a).not.toBe(b);
  });

  it('INV-4 — phase-sensitive: same classifier at implement vs tasks differ', () => {
    const a = computeFailureFingerprint({ phase: 'implement', evidence: BASE_EVIDENCE });
    const b = computeFailureFingerprint({ phase: 'tasks', evidence: BASE_EVIDENCE });
    expect(a).not.toBe(b);
  });

  it('INV-5 — reason-text-sensitive: two different reasons within same classifier differ', () => {
    const a = computeFailureFingerprint({
      phase: 'implement',
      evidence: { ...BASE_EVIDENCE, reason: 'reason A' },
    });
    const b = computeFailureFingerprint({
      phase: 'implement',
      evidence: { ...BASE_EVIDENCE, reason: 'reason B' },
    });
    expect(a).not.toBe(b);
  });

  it('INV-6 — outputTail-neutral (Q1→B): different outputTail w/ same reason collapses', () => {
    // When reason is set (classifier-driven synthetic failure), outputTail is
    // NOT part of the fingerprint.
    const a = computeFailureFingerprint({
      phase: 'implement',
      evidence: { ...BASE_EVIDENCE, outputTail: 'first tail' },
    });
    const b = computeFailureFingerprint({
      phase: 'implement',
      evidence: { ...BASE_EVIDENCE, outputTail: 'second tail' },
    });
    expect(a).toBe(b);
  });

  it('falls back to outputTail when reason is undefined (real non-zero exit path)', () => {
    // Real non-zero exit: no `reason`, so outputTail becomes the diagnostic surface.
    const evidence: CommandExitEvidence = {
      command: 'pnpm test',
      exitDescriptor: 'exit 1',
      outputTail: 'npm error Missing script: "test"',
    };
    const a = computeFailureFingerprint({ phase: 'validate', evidence });
    const b = computeFailureFingerprint({ phase: 'validate', evidence });
    expect(a).toBe(b);
    // And two different outputTails DO differ when reason is absent:
    const c = computeFailureFingerprint({
      phase: 'validate',
      evidence: { ...evidence, outputTail: 'a different tail' },
    });
    expect(a).not.toBe(c);
  });

  describe('classifier extraction', () => {
    const evidenceWith = (exitDescriptor: string): CommandExitEvidence => ({
      command: 'x',
      exitDescriptor,
      outputTail: 'tail',
    });

    it('extracts classifier from `failed post-exit: <cls> (process exit N)`', () => {
      const a = computeFailureFingerprint({
        phase: 'implement',
        evidence: evidenceWith('failed post-exit: spawn-error (process exit 137)'),
      });
      const b = computeFailureFingerprint({
        phase: 'implement',
        evidence: evidenceWith('failed post-exit: spawn-error (process exit 42)'),
      });
      // Same classifier, different exit code → same classifier substring
      // extracted; whole exitDescriptor differs but that difference is squashed.
      expect(a).toBe(b);
    });

    it('maps `killed (SIGTERM) after Nms` to classifier `timeout`', () => {
      const a = computeFailureFingerprint({
        phase: 'implement',
        evidence: evidenceWith('killed (SIGTERM) after 300000ms'),
      });
      const b = computeFailureFingerprint({
        phase: 'implement',
        evidence: evidenceWith('killed (SIGTERM) after 500ms'),
      });
      expect(a).toBe(b);
    });

    it('maps `aborted` to classifier `aborted`', () => {
      const a = computeFailureFingerprint({
        phase: 'implement',
        evidence: evidenceWith('aborted'),
      });
      const b = computeFailureFingerprint({
        phase: 'implement',
        evidence: evidenceWith('aborted'),
      });
      expect(a).toBe(b);
    });

    it('maps `exit N` to classifier `exit-N` (distinct across N)', () => {
      const a = computeFailureFingerprint({
        phase: 'validate',
        evidence: evidenceWith('exit 1'),
      });
      const b = computeFailureFingerprint({
        phase: 'validate',
        evidence: evidenceWith('exit 2'),
      });
      expect(a).not.toBe(b);
    });

    it('falls through to literal exitDescriptor for defensive unknown shape', () => {
      // Non-matching shape → deterministic, no throw.
      const a = computeFailureFingerprint({
        phase: 'implement',
        evidence: evidenceWith('some unexpected shape'),
      });
      expect(a).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  describe('snappoll#8 replay', () => {
    // Three verbatim `no-product-code-changes` failures at different runIds
    // must collapse to one fingerprint.
    const snappollEvidence: CommandExitEvidence = {
      command: 'implement (no-progress guard)',
      exitDescriptor: 'failed post-exit: no-product-code-changes (process exit 0)',
      outputTail: '(no output on either stream)',
      reason:
        'Phase "implement" produced no product-code changes — all changed files are under excluded prefixes [specs/]. Implement must modify at least one non-excluded file.',
    };

    it('three inputs collapse to one fingerprint', () => {
      const first = computeFailureFingerprint({ phase: 'implement', evidence: snappollEvidence });
      const second = computeFailureFingerprint({ phase: 'implement', evidence: snappollEvidence });
      const third = computeFailureFingerprint({ phase: 'implement', evidence: snappollEvidence });
      expect(first).toBe(second);
      expect(second).toBe(third);
    });
  });
});

describe('parseFailureAlertMarker', () => {
  it('INV-M1 — v1 marker (pre-#942) returns null', () => {
    const body = '<!-- generacy:failure-alert:implementation:9e5c8a0d-755e-40b3-b0c3-43e849f0bb90 -->\n❌ **implement failed** — foo.';
    expect(parseFailureAlertMarker(body)).toBeNull();
  });

  it('INV-M2 — v2 marker after runId marker parses successfully', () => {
    const body =
      '<!-- generacy:failure-alert:implementation:9e5c8a0d-755e-40b3-b0c3-43e849f0bb90 --> <!-- fp:9c4d3e2a1b0f8a7b:2 -->\n❌ **implement failed**';
    const parsed = parseFailureAlertMarker(body);
    expect(parsed).toEqual({ fingerprint: '9c4d3e2a1b0f8a7b', occurrence: 2 });
  });

  it('INV-M2 — v2 marker positioned before v1 marker also parses', () => {
    // Contract: order-independent; scan whole line 1.
    const body = '<!-- fp:abcdef0123456789:5 --> <!-- generacy:failure-alert:implementation:xyz -->\nbody';
    const parsed = parseFailureAlertMarker(body);
    expect(parsed).toEqual({ fingerprint: 'abcdef0123456789', occurrence: 5 });
  });

  it('INV-M3 — non-hex fingerprint returns null', () => {
    const body = '<!-- generacy:failure-alert:implementation:xyz --> <!-- fp:XYZ0000000000000:1 -->\nbody';
    expect(parseFailureAlertMarker(body)).toBeNull();
  });

  it('INV-M3 — non-numeric occurrence returns null', () => {
    const body = '<!-- generacy:failure-alert:implementation:xyz --> <!-- fp:9c4d3e2a1b0f8a7b:x -->\nbody';
    expect(parseFailureAlertMarker(body)).toBeNull();
  });

  it('INV-M3 — short fingerprint returns null', () => {
    const body = '<!-- generacy:failure-alert:implementation:xyz --> <!-- fp:abc:1 -->\nbody';
    expect(parseFailureAlertMarker(body)).toBeNull();
  });

  it('INV-M4 — multiple v2 markers on line 1: parses first, ignores rest', () => {
    const body =
      '<!-- generacy:failure-alert:implementation:xyz --> <!-- fp:1111111111111111:1 --> <!-- fp:2222222222222222:2 -->\nbody';
    const parsed = parseFailureAlertMarker(body);
    expect(parsed).toEqual({ fingerprint: '1111111111111111', occurrence: 1 });
  });

  it('never throws on garbage input', () => {
    expect(() => parseFailureAlertMarker('')).not.toThrow();
    expect(parseFailureAlertMarker('')).toBeNull();
    expect(() => parseFailureAlertMarker('random\nlines\nno marker')).not.toThrow();
    expect(parseFailureAlertMarker('random\nlines\nno marker')).toBeNull();
  });

  it('marker on line 2 is ignored — only line 1 is scanned', () => {
    const body = 'line 1 nothing here\n<!-- fp:9c4d3e2a1b0f8a7b:2 -->';
    expect(parseFailureAlertMarker(body)).toBeNull();
  });
});

describe('constants', () => {
  it('REPEAT_FAILURE_THRESHOLD is 2 (Q3→A)', () => {
    expect(REPEAT_FAILURE_THRESHOLD).toBe(2);
  });

  it('FINGERPRINT_HEX_LENGTH is 16', () => {
    expect(FINGERPRINT_HEX_LENGTH).toBe(16);
  });
});
