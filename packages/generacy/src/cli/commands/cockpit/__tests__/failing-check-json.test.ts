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

  it('builds missing-label payload with pr ref (with linkMethod) and empty failingChecks', () => {
    const payload = buildFailingCheckPayload({
      reason: 'missing-label',
      pr: {
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        linkMethod: 'closing-refs',
      },
    });
    expect(payload).toEqual({
      status: 'red',
      reason: 'missing-label',
      pr: {
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        linkMethod: 'closing-refs',
      },
      failingChecks: [],
    });
    expect(validate(payload)).toBe(true);
  });

  it('builds checks-failing payload with non-empty failingChecks', () => {
    const payload = buildFailingCheckPayload({
      reason: 'checks-failing',
      pr: {
        number: 9,
        url: 'https://github.com/o/r/pull/9',
        linkMethod: 'branch-name',
      },
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
        pr: {
          number: 1,
          url: 'https://github.com/o/r/pull/1',
          linkMethod: 'closing-refs',
        },
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
        pr: {
          number: 1,
          url: 'https://github.com/o/r/pull/1',
          linkMethod: 'closing-refs',
        },
        failingChecks: [{ name: 'x', state: 'FAILURE' }],
      }),
    ).toThrow(/missing-label.*empty failingChecks/);
  });
});

describe('buildFailingCheckPayload I-7..I-11 invariants', () => {
  it('I-7 happy path: pr-is-draft with 1 draft candidate', () => {
    const payload = buildFailingCheckPayload({
      reason: 'pr-is-draft',
      pr: null,
      candidates: [
        {
          number: 22,
          url: 'https://github.com/o/r/pull/22',
          isDraft: true,
          headRefName: '011-branch',
        },
      ],
      linkMethod: 'pr-body',
    });
    expect(payload).toEqual({
      status: 'red',
      reason: 'pr-is-draft',
      pr: null,
      candidates: [
        {
          number: 22,
          url: 'https://github.com/o/r/pull/22',
          isDraft: true,
          headRefName: '011-branch',
        },
      ],
      linkMethod: 'pr-body',
      failingChecks: [],
    });
    expect(validate(payload)).toBe(true);
  });

  it('I-7 throws when pr-is-draft has non-null pr', () => {
    expect(() =>
      buildFailingCheckPayload({
        reason: 'pr-is-draft',
        pr: {
          number: 1,
          url: 'https://github.com/o/r/pull/1',
          linkMethod: 'pr-body',
        },
        candidates: [
          {
            number: 1,
            url: 'https://github.com/o/r/pull/1',
            isDraft: true,
            headRefName: 'x',
          },
        ],
        linkMethod: 'pr-body',
      }),
    ).toThrow(/I-7.*pr === null/);
  });

  it('I-7 throws when pr-is-draft has zero candidates', () => {
    expect(() =>
      buildFailingCheckPayload({
        reason: 'pr-is-draft',
        pr: null,
        candidates: [],
        linkMethod: 'pr-body',
      }),
    ).toThrow(/I-7.*candidates.length >= 1/);
  });

  it('I-7 throws when pr-is-draft candidate has isDraft=false', () => {
    expect(() =>
      buildFailingCheckPayload({
        reason: 'pr-is-draft',
        pr: null,
        candidates: [
          {
            number: 1,
            url: 'https://github.com/o/r/pull/1',
            isDraft: false,
            headRefName: 'x',
          },
        ],
        linkMethod: 'pr-body',
      }),
    ).toThrow(/I-7.*isDraft === true/);
  });

  it('I-7 throws when pr-is-draft is missing linkMethod', () => {
    expect(() =>
      buildFailingCheckPayload({
        reason: 'pr-is-draft',
        pr: null,
        candidates: [
          {
            number: 1,
            url: 'https://github.com/o/r/pull/1',
            isDraft: true,
            headRefName: 'x',
          },
        ],
      }),
    ).toThrow(/I-7.*linkMethod/);
  });

  it('I-8 happy path: ambiguous-resolution with 2 non-draft candidates', () => {
    const payload = buildFailingCheckPayload({
      reason: 'ambiguous-resolution',
      pr: null,
      candidates: [
        {
          number: 42,
          url: 'https://github.com/o/r/pull/42',
          isDraft: false,
          headRefName: '9-first-try',
        },
        {
          number: 47,
          url: 'https://github.com/o/r/pull/47',
          isDraft: false,
          headRefName: '9-do-it-properly',
        },
      ],
      linkMethod: 'branch-name',
    });
    expect(payload.linkMethod).toBe('branch-name');
    expect(validate(payload)).toBe(true);
  });

  it('I-8 throws when ambiguous-resolution has fewer than 2 candidates', () => {
    expect(() =>
      buildFailingCheckPayload({
        reason: 'ambiguous-resolution',
        pr: null,
        candidates: [
          {
            number: 1,
            url: 'https://github.com/o/r/pull/1',
            isDraft: false,
            headRefName: 'x',
          },
        ],
        linkMethod: 'branch-name',
      }),
    ).toThrow(/I-8.*candidates.length >= 2/);
  });

  it('I-8 throws when ambiguous-resolution candidate has isDraft=true', () => {
    expect(() =>
      buildFailingCheckPayload({
        reason: 'ambiguous-resolution',
        pr: null,
        candidates: [
          {
            number: 1,
            url: 'https://github.com/o/r/pull/1',
            isDraft: false,
            headRefName: 'x',
          },
          {
            number: 2,
            url: 'https://github.com/o/r/pull/2',
            isDraft: true,
            headRefName: 'y',
          },
        ],
        linkMethod: 'branch-name',
      }),
    ).toThrow(/I-8.*isDraft === false/);
  });

  it('I-9 throws when missing-label has pr without linkMethod', () => {
    expect(() =>
      buildFailingCheckPayload({
        reason: 'missing-label',
        pr: { number: 1, url: 'https://github.com/o/r/pull/1' },
      }),
    ).toThrow(/I-9.*missing-label.*linkMethod/);
  });

  it('I-9 throws when checks-failing has pr without linkMethod', () => {
    expect(() =>
      buildFailingCheckPayload({
        reason: 'checks-failing',
        pr: { number: 1, url: 'https://github.com/o/r/pull/1' },
        failingChecks: [{ name: 'ci/test', state: 'FAILURE' }],
      }),
    ).toThrow(/I-9.*checks-failing.*linkMethod/);
  });

  it('I-10 throws when unresolved is called with candidates', () => {
    expect(() =>
      buildFailingCheckPayload({
        reason: 'unresolved',
        pr: null,
        candidates: [
          {
            number: 1,
            url: 'https://github.com/o/r/pull/1',
            isDraft: false,
            headRefName: 'x',
          },
        ],
      }),
    ).toThrow(/I-10.*candidates MUST NOT/);
  });

  it('I-11 throws when unresolved is called with top-level linkMethod', () => {
    expect(() =>
      buildFailingCheckPayload({
        reason: 'unresolved',
        pr: null,
        linkMethod: 'closing-refs',
      }),
    ).toThrow(/I-11.*linkMethod MUST NOT/);
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
