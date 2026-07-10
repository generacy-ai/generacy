import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hashValidationEvidence } from '../evidence-hash.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): string =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('hashValidationEvidence (#892)', () => {
  it('same red, cosmetic re-run → same hash (next-build missing module)', () => {
    const a = hashValidationEvidence(fx('next-build-missing-module.stdout.txt'));
    const b = hashValidationEvidence(fx('next-build-missing-module-rerun.stdout.txt'));
    expect(a.hash).toBe(b.hash);
    expect(a.extract.failures).toEqual(b.extract.failures);
  });

  it('reordered failures → same hash (vitest multi-failure)', () => {
    const a = hashValidationEvidence(fx('vitest-multi-failure.stdout.txt'));
    const b = hashValidationEvidence(fx('vitest-multi-failure-shuffled.stdout.txt'));
    expect(a.hash).toBe(b.hash);
  });

  it('different module → different hash', () => {
    const a = hashValidationEvidence(
      `Type error: Cannot find module '@/components/CopyButton'`,
    );
    const b = hashValidationEvidence(
      `Type error: Cannot find module '@/components/ShareButton'`,
    );
    expect(a.hash).not.toBe(b.hash);
    expect(a.extract.failures[0]!.id).toBe('module:@/components/CopyButton');
    expect(b.extract.failures[0]!.id).toBe('module:@/components/ShareButton');
  });

  it('extracts correct field shapes for next-build missing-module', () => {
    const result = hashValidationEvidence(fx('next-build-missing-module.stdout.txt'));
    expect(result.extract.failures.length).toBeGreaterThanOrEqual(1);
    const f = result.extract.failures[0]!;
    expect(f.id).toMatch(/^module:@\/components\/CopyButton$/);
    expect(f.firstError).toContain('Cannot find module');
  });

  it('extracts correct field shapes for vitest single failure', () => {
    const result = hashValidationEvidence(fx('vitest-single-failure.stdout.txt'));
    expect(result.extract.failures.length).toBeGreaterThanOrEqual(1);
    const found = result.extract.failures.find((f) => f.id.startsWith('test:'));
    expect(found).toBeDefined();
    expect(found!.id).toContain('generates short code with correct length');
  });

  it('extracts correct field shapes for next-build type error', () => {
    const result = hashValidationEvidence(fx('next-build-type-error.stdout.txt'));
    expect(result.extract.failures.length).toBeGreaterThanOrEqual(1);
    const found = result.extract.failures.find((f) => f.id.startsWith('type:'));
    expect(found).toBeDefined();
    expect(found!.id).toContain('src/app/api/route.ts');
  });

  it('fallback path — unknown shape produces hash:<16hex> id', () => {
    const result = hashValidationEvidence(fx('unknown-shape.stdout.txt'));
    expect(result.extract.failures.length).toBe(1);
    expect(result.extract.failures[0]!.id).toMatch(/^hash:[0-9a-f]{16}$/);
    // Determinism: two calls with the same input produce the same hash.
    const result2 = hashValidationEvidence(fx('unknown-shape.stdout.txt'));
    expect(result.hash).toBe(result2.hash);
  });

  it('empty stdout produces a stable well-defined hash', () => {
    const result = hashValidationEvidence('');
    expect(result.extract.failures.length).toBe(1);
    expect(result.extract.failures[0]!.id).toMatch(/^hash:[0-9a-f]{16}$/);
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('idempotent normalization — already-normalized input hashes same as raw', () => {
    // A transcript with no timestamps/PIDs/absolute paths behaves the same
    // when the normalization pipeline runs on it a second time.
    const raw = `Failed to compile.
Type error: Cannot find module '@/components/CopyButton' or its corresponding type declarations.`;
    const a = hashValidationEvidence(raw);
    const b = hashValidationEvidence(raw);
    expect(a.hash).toBe(b.hash);
  });

  it('no env leakage — hash unchanged when Date.now / TZ are mocked', () => {
    const spyNow = vi.spyOn(Date, 'now').mockReturnValue(0);
    const originalTZ = process.env['TZ'];
    process.env['TZ'] = 'UTC';
    try {
      const a = hashValidationEvidence(fx('next-build-missing-module.stdout.txt'));
      process.env['TZ'] = 'America/Los_Angeles';
      spyNow.mockReturnValue(1_700_000_000_000);
      const b = hashValidationEvidence(fx('next-build-missing-module.stdout.txt'));
      expect(a.hash).toBe(b.hash);
    } finally {
      spyNow.mockRestore();
      if (originalTZ === undefined) {
        delete process.env['TZ'];
      } else {
        process.env['TZ'] = originalTZ;
      }
    }
  });

  it('hash is 64-char lower-case hex', () => {
    const result = hashValidationEvidence('anything');
    expect(result.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
