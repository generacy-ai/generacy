import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { readManifest, type Issue } from '@generacy-ai/cockpit';
import { runInit, runSync } from '../manifest.js';
import { isCockpitExit } from '../exit.js';
import { FakeGh, makeIssue } from './helpers/fake-gh.js';
import Ajv from 'ajv';

const here = fileURLToPath(new URL('.', import.meta.url));
const FIXTURE_BODY = await readFile(join(here, 'fixtures', 'epic-cockpit-body.md'), 'utf-8');
const FIXTURE_EXPECTED = await readFile(
  join(here, 'fixtures', 'epic-cockpit-expected.yaml'),
  'utf-8',
);

const EPIC_REF = 'generacy-ai/tetrad-development#85';

function buildEpicIssue(overrides: Partial<Issue> = {}): Issue {
  return makeIssue({
    number: 85,
    title: 'Epic: Cockpit',
    body: FIXTURE_BODY,
    url: 'https://github.com/generacy-ai/tetrad-development/issues/85',
    ...overrides,
  });
}

function ghReturning(issues: Issue[]): FakeGh {
  return new FakeGh({
    issuesByQuery: () => issues,
  });
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'cockpit-manifest-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('cockpit manifest init', () => {
  it('happy path: writes the manifest and prints summary (T018)', async () => {
    const gh = ghReturning([buildEpicIssue()]);
    const out: string[] = [];
    await runInit(EPIC_REF, { manifestRoot: tmpRoot }, { gh, stdout: (l) => out.push(l) });

    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/wrote .*cockpit\.yaml \(3 phases, 5 issues\)/);

    const writtenPath = join(tmpRoot, 'cockpit.yaml');
    expect(existsSync(writtenPath)).toBe(true);
    const got = await readManifest(writtenPath);
    const expected = parseYaml(FIXTURE_EXPECTED);
    expect(got).toEqual(expected);
  });

  it('slug collision without --force exits 1 and preserves the original file (T019)', async () => {
    const targetPath = join(tmpRoot, 'cockpit.yaml');
    await writeFile(targetPath, 'placeholder: original\n', 'utf-8');

    const gh = ghReturning([buildEpicIssue()]);
    let caught: unknown;
    try {
      await runInit(EPIC_REF, { manifestRoot: tmpRoot }, { gh, stdout: () => {} });
    } catch (err) {
      caught = err;
    }
    expect(isCockpitExit(caught)).toBe(true);
    const e = caught as Error & { code: number };
    expect(e.code).toBe(1);
    expect(e.message).toMatch(/already exists/);

    const after = await readFile(targetPath, 'utf-8');
    expect(after).toBe('placeholder: original\n');
  });

  it('--force overwrites an existing file (T019)', async () => {
    const targetPath = join(tmpRoot, 'cockpit.yaml');
    await writeFile(targetPath, 'placeholder: original\n', 'utf-8');

    const gh = ghReturning([buildEpicIssue()]);
    const out: string[] = [];
    await runInit(EPIC_REF, { manifestRoot: tmpRoot, force: true }, { gh, stdout: (l) => out.push(l) });

    const got = await readManifest(targetPath);
    expect(got?.epic.slug).toBe('cockpit');
  });

  it('--slug other writes a different filename and leaves cockpit.yaml untouched (T019)', async () => {
    const cockpitPath = join(tmpRoot, 'cockpit.yaml');
    await writeFile(cockpitPath, 'placeholder: original\n', 'utf-8');

    const gh = ghReturning([buildEpicIssue()]);
    await runInit(
      EPIC_REF,
      { manifestRoot: tmpRoot, slug: 'other' },
      { gh, stdout: () => {} },
    );
    expect(existsSync(join(tmpRoot, 'other.yaml'))).toBe(true);
    const original = await readFile(cockpitPath, 'utf-8');
    expect(original).toBe('placeholder: original\n');
  });

  it('missing Plan: line exits 2 without writing (T020)', async () => {
    const body = '## P1 — Foo\n- owner/repo#1\n';
    const gh = ghReturning([buildEpicIssue({ body })]);
    let caught: unknown;
    try {
      await runInit(EPIC_REF, { manifestRoot: tmpRoot }, { gh, stdout: () => {} });
    } catch (err) {
      caught = err;
    }
    expect(isCockpitExit(caught)).toBe(true);
    const e = caught as Error & { code: number };
    expect(e.code).toBe(2);
    expect(e.message).toMatch(/no "Plan:" line/);
    expect(existsSync(join(tmpRoot, 'cockpit.yaml'))).toBe(false);
  });

  it('invalid epic ref exits 2 without calling gh (T020a)', async () => {
    const gh = new FakeGh({ issuesByQuery: () => [] });
    let caught: unknown;
    try {
      await runInit('85', { manifestRoot: tmpRoot }, { gh, stdout: () => {} });
    } catch (err) {
      caught = err;
    }
    expect(isCockpitExit(caught)).toBe(true);
    const e = caught as Error & { code: number };
    expect(e.code).toBe(2);
    expect(e.message).toMatch(/invalid epic ref/);
    expect(gh.calls.length).toBe(0);
    expect(existsSync(join(tmpRoot, 'cockpit.yaml'))).toBe(false);
  });
});

describe('cockpit manifest sync', () => {
  async function seedFromExpected(extra: { autonomy?: Record<string, unknown> } = {}): Promise<string> {
    const path = join(tmpRoot, 'cockpit.yaml');
    const obj = parseYaml(FIXTURE_EXPECTED) as Record<string, unknown>;
    if (extra.autonomy != null) obj.autonomy = extra.autonomy;
    await writeFile(path, FIXTURE_EXPECTED, 'utf-8');
    if (extra.autonomy != null) {
      const { stringify } = await import('yaml');
      await writeFile(path, stringify(obj), 'utf-8');
    }
    return path;
  }

  it('updates on first run then is idempotent (T021)', async () => {
    const seededPath = await seedFromExpected({ autonomy: { gate: 'human' } });

    const editedBody = FIXTURE_BODY
      .replace('### P3 — Manifest → v2', '### P3 — Manifest Verb → v2')
      .replace(
        '- [ ] generacy-ai/generacy#791 — `cockpit queue <phase>`',
        '- [ ] generacy-ai/generacy#791 — `cockpit queue <phase>`\n- [ ] generacy-ai/generacy#888 — new ref',
      );
    const gh = ghReturning([buildEpicIssue({ body: editedBody })]);

    const out: string[] = [];
    await runSync({ manifestRoot: tmpRoot }, { gh, stdout: (l) => out.push(l) });
    expect(out[0]).toMatch(/synced .* \+0 phases, -0 phases, \+1 issue, -0 issues/);

    const afterFirst = await readManifest(seededPath);
    expect(afterFirst?.autonomy).toEqual({ gate: 'human' });
    const p3 = afterFirst?.phases.find((p) => p.name.startsWith('P3'));
    expect(p3?.name).toBe('P3 — Manifest Verb');
    expect(p3?.issues).toContain('generacy-ai/generacy#888');

    const before = await stat(seededPath);
    const beforeBytes = await readFile(seededPath, 'utf-8');

    // Second run with same body: no changes.
    const gh2 = ghReturning([buildEpicIssue({ body: editedBody })]);
    const out2: string[] = [];
    await runSync({ manifestRoot: tmpRoot }, { gh: gh2, stdout: (l) => out2.push(l) });
    expect(out2).toContain('no changes');

    const afterBytes = await readFile(seededPath, 'utf-8');
    expect(afterBytes).toBe(beforeBytes);
    const after = await stat(seededPath);
    expect(after.size).toBe(before.size);
  });

  it('no manifest in dir → exit 2 (T022)', async () => {
    const gh = ghReturning([buildEpicIssue()]);
    let caught: unknown;
    try {
      await runSync({ manifestRoot: tmpRoot }, { gh, stdout: () => {} });
    } catch (err) {
      caught = err;
    }
    expect(isCockpitExit(caught)).toBe(true);
    const e = caught as Error & { code: number };
    expect(e.code).toBe(2);
    expect(e.message).toMatch(/no manifest found/);
  });

  it('multiple manifests in dir without --epic → exit 2 (T022)', async () => {
    await writeFile(join(tmpRoot, 'a.yaml'), 'x', 'utf-8');
    await writeFile(join(tmpRoot, 'b.yaml'), 'x', 'utf-8');
    const gh = ghReturning([buildEpicIssue()]);
    let caught: unknown;
    try {
      await runSync({ manifestRoot: tmpRoot }, { gh, stdout: () => {} });
    } catch (err) {
      caught = err;
    }
    expect(isCockpitExit(caught)).toBe(true);
    const e = caught as Error & { code: number };
    expect(e.code).toBe(2);
    expect(e.message).toMatch(/multiple manifests found.*a\.yaml.*b\.yaml/);
  });

  it('--epic <missing> → exit 2 (T022)', async () => {
    const gh = ghReturning([buildEpicIssue()]);
    let caught: unknown;
    try {
      await runSync({ manifestRoot: tmpRoot, epic: 'missing' }, { gh, stdout: () => {} });
    } catch (err) {
      caught = err;
    }
    expect(isCockpitExit(caught)).toBe(true);
    const e = caught as Error & { code: number };
    expect(e.code).toBe(2);
    expect(e.message).toMatch(/no manifest found/);
  });
});

const SCHEMA = {
  title: 'CockpitManifestVerbResult',
  type: 'object',
  required: ['verb', 'path', 'epic', 'wrote', 'changes'],
  additionalProperties: false,
  properties: {
    verb: { enum: ['init', 'sync'] },
    path: { type: 'string', minLength: 1 },
    epic: { type: 'string', pattern: '^[^/]+/[^/]+#\\d+$' },
    wrote: { type: 'boolean' },
    changes: {
      type: 'object',
      required: ['phasesAdded', 'phasesRemoved', 'phasesRenamed', 'issuesAdded', 'issuesRemoved'],
      additionalProperties: false,
      properties: {
        phasesAdded: { type: 'array', items: { type: 'string', minLength: 1 } },
        phasesRemoved: { type: 'array', items: { type: 'string', minLength: 1 } },
        phasesRenamed: {
          type: 'array',
          items: {
            type: 'object',
            required: ['from', 'to'],
            additionalProperties: false,
            properties: {
              from: { type: 'string', minLength: 1 },
              to: { type: 'string', minLength: 1 },
            },
          },
        },
        issuesAdded: {
          type: 'object',
          additionalProperties: {
            type: 'array',
            items: { type: 'string', pattern: '^[^/]+/[^/]+#\\d+$' },
          },
        },
        issuesRemoved: {
          type: 'object',
          additionalProperties: {
            type: 'array',
            items: { type: 'string', pattern: '^[^/]+/[^/]+#\\d+$' },
          },
        },
        planChanged: {
          type: 'object',
          required: ['from', 'to'],
          additionalProperties: false,
          properties: {
            from: { type: 'string', minLength: 1 },
            to: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  },
};

describe('--json output schema (T023)', () => {
  const ajv = new Ajv({ strict: false });
  const validate = ajv.compile(SCHEMA);

  it('init --json prints a single JSON line matching the schema', async () => {
    const gh = ghReturning([buildEpicIssue()]);
    const out: string[] = [];
    await runInit(
      EPIC_REF,
      { manifestRoot: tmpRoot, json: true },
      { gh, stdout: (l) => out.push(l) },
    );
    expect(out).toHaveLength(1);
    const obj = JSON.parse(out[0]!);
    expect(validate(obj)).toBe(true);
    expect(obj.verb).toBe('init');
    expect(obj.wrote).toBe(true);
    expect(obj.epic).toBe('generacy-ai/tetrad-development#85');
    expect(obj.changes.planChanged).toBeUndefined();
  });

  it('sync --json idempotent: wrote=false, all changes empty, planChanged omitted', async () => {
    const cockpitPath = join(tmpRoot, 'cockpit.yaml');
    await writeFile(cockpitPath, FIXTURE_EXPECTED, 'utf-8');

    const gh = ghReturning([buildEpicIssue()]);
    const out: string[] = [];
    await runSync(
      { manifestRoot: tmpRoot, json: true },
      { gh, stdout: (l) => out.push(l) },
    );
    expect(out).toHaveLength(1);
    const obj = JSON.parse(out[0]!);
    expect(validate(obj)).toBe(true);
    expect(obj.wrote).toBe(false);
    expect(obj.changes.phasesAdded).toEqual([]);
    expect(obj.changes.issuesAdded).toEqual({});
    expect(obj.changes.planChanged).toBeUndefined();
  });

  it('sync --json mutating: validates schema and populates planChanged when changed', async () => {
    const cockpitPath = join(tmpRoot, 'cockpit.yaml');
    await writeFile(cockpitPath, FIXTURE_EXPECTED, 'utf-8');

    const editedBody = FIXTURE_BODY.replace(
      'Plan: docs/epic-cockpit-plan.md',
      'Plan: docs/epic-cockpit-plan-v2.md',
    );
    const gh = ghReturning([buildEpicIssue({ body: editedBody })]);
    const out: string[] = [];
    await runSync(
      { manifestRoot: tmpRoot, json: true },
      { gh, stdout: (l) => out.push(l) },
    );
    expect(out).toHaveLength(1);
    const obj = JSON.parse(out[0]!);
    expect(validate(obj)).toBe(true);
    expect(obj.wrote).toBe(true);
    expect(obj.changes.planChanged).toEqual({
      from: 'docs/epic-cockpit-plan.md',
      to: 'docs/epic-cockpit-plan-v2.md',
    });
  });
});

describe('golden test (T024)', () => {
  it('init produces a manifest that deep-equals the fixture YAML', async () => {
    const gh = ghReturning([buildEpicIssue()]);
    await runInit(EPIC_REF, { manifestRoot: tmpRoot }, { gh, stdout: () => {} });
    const got = await readManifest(join(tmpRoot, 'cockpit.yaml'));
    const expected = parseYaml(FIXTURE_EXPECTED);
    expect(got).toEqual(expected);
  });
});
