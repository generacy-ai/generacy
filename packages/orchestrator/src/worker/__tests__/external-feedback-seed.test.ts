import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearExternalFeedbackSeed,
  getExternalFeedbackSeedPath,
  readExternalFeedbackSeed,
  writeExternalFeedbackSeed,
  type ExternalFeedbackSeed,
} from '../external-feedback-seed.js';

const WORKFLOW_ID = 'acme/widgets#42';

function seed(overrides: Partial<ExternalFeedbackSeed> = {}): ExternalFeedbackSeed {
  return {
    version: 1,
    prNumber: 99,
    seededAt: '2026-08-20T00:00:00.000Z',
    findings: [
      { id: 'c1', body: 'Fix the null deref', author: 'octocat', path: 'src/a.ts', line: 12 },
      { id: 'c2', body: 'review body (no file anchor):\n\nDo X', author: 'octocat' },
    ],
    ...overrides,
  };
}

describe('external-feedback-seed', () => {
  let checkoutPath: string;

  beforeEach(async () => {
    checkoutPath = await fs.mkdtemp(path.join(os.tmpdir(), 'efs-test-'));
  });

  afterEach(async () => {
    await fs.rm(checkoutPath, { recursive: true, force: true });
  });

  it('round-trips write → read', async () => {
    await writeExternalFeedbackSeed(checkoutPath, WORKFLOW_ID, seed());
    const read = await readExternalFeedbackSeed(checkoutPath, WORKFLOW_ID);
    expect(read).toEqual(seed());
  });

  it('sanitizes the workflowId in the path', () => {
    const p = getExternalFeedbackSeedPath('/co', 'acme/widgets#42');
    expect(p).toBe('/co/.generacy/external-feedback-acme_widgets_42.json');
  });

  it('returns null when the seed file is missing', async () => {
    expect(await readExternalFeedbackSeed(checkoutPath, WORKFLOW_ID)).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    const p = getExternalFeedbackSeedPath(checkoutPath, WORKFLOW_ID);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, '{ not json', 'utf-8');
    expect(await readExternalFeedbackSeed(checkoutPath, WORKFLOW_ID)).toBeNull();
  });

  it('returns null on unknown version', async () => {
    const p = getExternalFeedbackSeedPath(checkoutPath, WORKFLOW_ID);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify({ ...seed(), version: 2 }), 'utf-8');
    expect(await readExternalFeedbackSeed(checkoutPath, WORKFLOW_ID)).toBeNull();
  });

  it('refuses to write an empty findings seed (invariant findings.length >= 1)', async () => {
    await expect(
      writeExternalFeedbackSeed(checkoutPath, WORKFLOW_ID, seed({ findings: [] })),
    ).rejects.toThrow();
    // No file left behind.
    expect(await readExternalFeedbackSeed(checkoutPath, WORKFLOW_ID)).toBeNull();
  });

  it('clear removes an existing seed', async () => {
    await writeExternalFeedbackSeed(checkoutPath, WORKFLOW_ID, seed());
    await clearExternalFeedbackSeed(checkoutPath, WORKFLOW_ID);
    expect(await readExternalFeedbackSeed(checkoutPath, WORKFLOW_ID)).toBeNull();
  });

  it('clear is a no-op when the seed is absent', async () => {
    await expect(clearExternalFeedbackSeed(checkoutPath, WORKFLOW_ID)).resolves.toBeUndefined();
  });
});
