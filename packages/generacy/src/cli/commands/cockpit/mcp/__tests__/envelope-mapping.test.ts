/**
 * #928 — Direct unit tests over `toMcpResult()`.
 *
 * This test guards the transport contract table in data-model.md §toMcpResult.
 * A novel `reason` string on exit=2 MUST fall through to `invalid-args` (not
 * silently to `gate-refusal`) so introducing a new failure mode without a
 * mapping-table entry is loud.
 */
import { describe, expect, it } from 'vitest';
import { toMcpResult } from '../errors.js';

function jsonBody(obj: unknown): string {
  return JSON.stringify(obj) + '\n';
}

describe('toMcpResult — exit code table', () => {
  it('exit=0 → ok with parsed data', () => {
    const result = toMcpResult<{ x: number }>(jsonBody({ x: 42 }), 0);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data).toEqual({ x: 42 });
  });

  it('exit=0 with empty stdout → ok with data === null', () => {
    const result = toMcpResult<unknown>('', 0);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data).toBeNull();
  });

  it('exit=0 with non-JSON stdout → internal (loud diagnostic)', () => {
    const result = toMcpResult('not json', 0);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
  });

  it('exit=2 + reason="pr-number" → wrong-kind with hint', () => {
    const result = toMcpResult(
      jsonBody({
        reason: 'pr-number',
        hint: '#15 is a pull request; pass the issue number',
      }),
      2,
    );
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('wrong-kind');
    expect(result.hint).toBe('#15 is a pull request; pass the issue number');
  });

  it('exit=2 + reason="unresolved" → gate-refusal', () => {
    const result = toMcpResult(jsonBody({ reason: 'unresolved' }), 2);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('gate-refusal');
  });

  it('exit=2 + reason="ambiguous-resolution" → gate-refusal', () => {
    const result = toMcpResult(jsonBody({ reason: 'ambiguous-resolution' }), 2);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('gate-refusal');
  });

  it('exit=2 + reason="pr-is-draft" → gate-refusal', () => {
    const result = toMcpResult(jsonBody({ reason: 'pr-is-draft' }), 2);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('gate-refusal');
  });

  it('exit=2 + reason="checks-failing" → gate-refusal', () => {
    const result = toMcpResult(jsonBody({ reason: 'checks-failing' }), 2);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('gate-refusal');
  });

  it('exit=2 + novel reason → invalid-args (NOT silently gate-refusal)', () => {
    const result = toMcpResult(jsonBody({ reason: 'brand-new-reason-2027' }), 2);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
  });

  it('exit=2 + missing reason → invalid-args', () => {
    const result = toMcpResult(jsonBody({ status: 'red' }), 2);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('invalid-args');
  });

  it('exit=2 + non-JSON stdout → internal', () => {
    const result = toMcpResult('boom', 2);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
  });

  it('exit=3 → gate-refusal', () => {
    const result = toMcpResult(jsonBody({ reason: 'pr-flag-linkage-refused' }), 3);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('gate-refusal');
  });

  it('exit=3 + non-JSON stdout → gate-refusal (bare-line fallback)', () => {
    const result = toMcpResult('merge refused\n', 3);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('gate-refusal');
    expect(result.detail).toBe('merge refused');
  });

  it('exit=1 (non-JSON stdout) → transport', () => {
    const result = toMcpResult('gh boom\n', 1);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('transport');
    expect(result.detail).toBe('gh boom');
  });

  it('exit=1 + known refusal reason → gate-refusal (legacy runMerge exit code)', () => {
    // runMerge historically uses exit-1 for resolver-driven gate refusals
    // (unresolved / ambiguous / pr-is-draft / checks-failing). The envelope
    // helper honors the reason field over the raw exit code.
    const result = toMcpResult(jsonBody({ reason: 'ambiguous-resolution' }), 1);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('gate-refusal');
  });

  it('exit=1 + unknown reason → transport', () => {
    const result = toMcpResult(jsonBody({ reason: 'brand-new-reason-2027' }), 1);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('transport');
  });

  it('exit=4 → internal', () => {
    const result = toMcpResult('unknown crash\n', 4);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
  });

  it('exit=99 → internal', () => {
    const result = toMcpResult('unknown crash\n', 99);
    expect(result.status).toBe('error');
    if (result.status !== 'error') return;
    expect(result.class).toBe('internal');
  });
});
