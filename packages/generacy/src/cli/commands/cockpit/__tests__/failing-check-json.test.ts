import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  buildFailingCheckPayload,
  serializeFailingCheckJson,
} from '../shared/failing-check-json.js';

const schemaPath = resolve(
  __dirname,
  '../../../../../../../specs/789-epic-generacy-ai-tetrad/contracts/failing-check.schema.json',
);
const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);

describe('buildFailingCheckPayload', () => {
  it('builds unresolved payload with null pr and empty failingChecks', () => {
    const payload = buildFailingCheckPayload({
      reason: 'unresolved',
      pr: null,
    });
    expect(payload).toEqual({
      status: 'red',
      reason: 'unresolved',
      pr: null,
      failingChecks: [],
    });
    expect(validate(payload)).toBe(true);
  });

  it('builds unresolved payload with pr ref (issue had a PR but it was not OPEN)', () => {
    const payload = buildFailingCheckPayload({
      reason: 'unresolved',
      pr: { number: 5, url: 'https://github.com/o/r/pull/5' },
    });
    expect(validate(payload)).toBe(true);
  });

  it('builds missing-label payload with pr ref and empty failingChecks', () => {
    const payload = buildFailingCheckPayload({
      reason: 'missing-label',
      pr: { number: 7, url: 'https://github.com/o/r/pull/7' },
    });
    expect(payload).toEqual({
      status: 'red',
      reason: 'missing-label',
      pr: { number: 7, url: 'https://github.com/o/r/pull/7' },
      failingChecks: [],
    });
    expect(validate(payload)).toBe(true);
  });

  it('builds checks-failing payload with non-empty failingChecks', () => {
    const payload = buildFailingCheckPayload({
      reason: 'checks-failing',
      pr: { number: 9, url: 'https://github.com/o/r/pull/9' },
      failingChecks: [
        { name: 'ci/test', state: 'FAILURE', url: 'https://x/run/1' },
        { name: 'ci/missing', state: 'MISSING' },
      ],
    });
    expect(payload.failingChecks).toHaveLength(2);
    expect(validate(payload)).toBe(true);
  });

  it('throws when missing-label is called with null pr', () => {
    expect(() =>
      buildFailingCheckPayload({ reason: 'missing-label', pr: null }),
    ).toThrow(/missing-label.*non-null pr/);
  });

  it('throws when checks-failing is called with null pr', () => {
    expect(() =>
      buildFailingCheckPayload({
        reason: 'checks-failing',
        pr: null,
        failingChecks: [{ name: 'ci/test', state: 'FAILURE' }],
      }),
    ).toThrow(/checks-failing.*non-null pr/);
  });

  it('throws when checks-failing is called with empty failingChecks', () => {
    expect(() =>
      buildFailingCheckPayload({
        reason: 'checks-failing',
        pr: { number: 1, url: 'https://github.com/o/r/pull/1' },
        failingChecks: [],
      }),
    ).toThrow(/checks-failing.*non-empty failingChecks/);
  });

  it('throws when unresolved is called with non-empty failingChecks', () => {
    expect(() =>
      buildFailingCheckPayload({
        reason: 'unresolved',
        pr: null,
        failingChecks: [{ name: 'x', state: 'FAILURE' }],
      }),
    ).toThrow(/unresolved.*empty failingChecks/);
  });

  it('throws when missing-label is called with non-empty failingChecks', () => {
    expect(() =>
      buildFailingCheckPayload({
        reason: 'missing-label',
        pr: { number: 1, url: 'https://github.com/o/r/pull/1' },
        failingChecks: [{ name: 'x', state: 'FAILURE' }],
      }),
    ).toThrow(/missing-label.*empty failingChecks/);
  });
});

describe('serializeFailingCheckJson', () => {
  it('returns JSON.stringify output with trailing newline', () => {
    const payload = buildFailingCheckPayload({
      reason: 'unresolved',
      pr: null,
    });
    const out = serializeFailingCheckJson(payload);
    expect(out.endsWith('\n')).toBe(true);
    expect(JSON.parse(out.trim())).toEqual(payload);
  });
});
