import { describe, it, expect } from 'vitest';
import type { CredentialEntry } from '../schemas/credentials.js';
import { mergeCredentialOverlay } from '../config/overlay.js';

function entry(id: string, overrides?: Partial<CredentialEntry>): CredentialEntry {
  return { id, type: 'token', backend: 'vault', backendKey: `keys/${id}`, ...overrides };
}

describe('mergeCredentialOverlay', () => {
  it('overrides a committed entry by id (full replacement)', () => {
    const committed = [entry('a'), entry('b')];
    const overlay = [entry('a', { type: 'pat', backend: 'env', backendKey: 'ENV_A' })];

    const { merged } = mergeCredentialOverlay(committed, overlay);

    const a = merged.find((e) => e.id === 'a')!;
    expect(a.type).toBe('pat');
    expect(a.backend).toBe('env');
    expect(a.backendKey).toBe('ENV_A');
  });

  it('adds new ids from overlay', () => {
    const committed = [entry('a')];
    const overlay = [entry('c'), entry('d')];

    const { merged } = mergeCredentialOverlay(committed, overlay);

    expect(merged).toHaveLength(3);
    expect(merged.map((e) => e.id)).toEqual(['a', 'c', 'd']);
  });

  it('returns committed unchanged when overlay is empty', () => {
    const committed = [entry('a'), entry('b')];

    const { merged } = mergeCredentialOverlay(committed, []);

    expect(merged).toEqual(committed);
  });

  it('returns empty when both committed and overlay are empty', () => {
    const { merged, overlayIds } = mergeCredentialOverlay([], []);

    expect(merged).toEqual([]);
    expect(overlayIds).toEqual([]);
  });

  it('tracks overlay ids exactly', () => {
    const committed = [entry('a'), entry('b')];
    const overlay = [entry('b', { type: 'pat' }), entry('c')];

    const { overlayIds } = mergeCredentialOverlay(committed, overlay);

    expect(overlayIds).toEqual(['b', 'c']);
  });

  it('preserves committed order with overrides in place and appends new entries', () => {
    const committed = [entry('x'), entry('y'), entry('z')];
    const overlay = [entry('y', { type: 'replaced' }), entry('w')];

    const { merged } = mergeCredentialOverlay(committed, overlay);

    expect(merged.map((e) => e.id)).toEqual(['x', 'y', 'z', 'w']);
    expect(merged[1]!.type).toBe('replaced');
  });
});
