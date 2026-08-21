import { readdir, readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deriveFindingId,
  getReviewArtifactPath,
  readReviewArtifact,
} from '../review-artifact.js';

const WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      files.push(...(await collectSourceFiles(full)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

async function countMatches(pattern: RegExp): Promise<{ total: number; files: string[] }> {
  const files = await collectSourceFiles(WORKER_DIR);
  const hits: string[] = [];
  let total = 0;
  for (const file of files) {
    const src = await readFile(file, 'utf-8');
    const matches = src.match(pattern);
    if (matches) {
      total += matches.length;
      hits.push(path.relative(WORKER_DIR, file));
    }
  }
  return { total, files: hits };
}

describe('#1161 findings-schema single-source audit (SC-001 / SC-002 / SC-003)', () => {
  it('defines exactly one SEVERITY_RANK table under worker/', async () => {
    const { total, files } = await countMatches(/(?:export\s+)?const SEVERITY_RANK\b/g);
    expect(total, `SEVERITY_RANK defined in: ${files.join(', ')}`).toBe(1);
  });

  it('defines exactly one computeVerdict function under worker/', async () => {
    const { total, files } = await countMatches(/(?:export\s+)?function computeVerdict\b/g);
    expect(total, `computeVerdict defined in: ${files.join(', ')}`).toBe(1);
  });

  it('defines exactly one ReviewFindingSchema and one ReviewArtifactSchema under worker/', async () => {
    const finding = await countMatches(/ReviewFindingSchema\s*=\s*z\./g);
    expect(finding.total, `ReviewFindingSchema defined in: ${finding.files.join(', ')}`).toBe(1);

    const artifact = await countMatches(/ReviewArtifactSchema\s*=\s*z\./g);
    expect(artifact.total, `ReviewArtifactSchema defined in: ${artifact.files.join(', ')}`).toBe(1);
  });
});

describe('#1161 back-compat id fill (INV-4 / INV-5)', () => {
  let checkoutPath: string;
  const workflowId = 'owner/repo#1161';

  beforeEach(async () => {
    checkoutPath = await mkdtemp(path.join(tmpdir(), 'review-audit-'));
  });

  afterEach(async () => {
    await rm(checkoutPath, { recursive: true, force: true });
  });

  it('parses a pre-#1161 sidecar without per-finding id and default-fills the deterministic id', async () => {
    const legacy = {
      findings: [
        {
          // no `id` — written by a pre-#1161 engine build
          severity: 'critical',
          file: 'src/a.ts',
          title: 'Missing null check',
          detail: 'Dereference without guard.',
          round: 1,
          status: 'open',
        },
      ],
      verdict: 'changes-required',
      round: 1,
      lastReviewedCommitSha: 'abc123',
      remediationCount: 0,
    };
    const filePath = getReviewArtifactPath(checkoutPath, workflowId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(legacy), 'utf-8');

    const parsed = await readReviewArtifact(checkoutPath, workflowId);

    expect(parsed).not.toBeNull();
    expect(parsed!.findings[0]!.id).toBe(deriveFindingId('src/a.ts', 'Missing null check'));
  });

  it('parses a pre-#1161 sidecar with round:0 findings and normalizes round to 1', async () => {
    // The pre-#1161 SeedAwareReviewExecutor persisted external-feedback findings
    // with `round: 0`. `ReviewFindingSchema.round` is now `positive()`, so the
    // backfill pass must normalize 0 -> 1 or the whole artifact is rejected and
    // all prior review state is silently discarded on a mid-issue upgrade.
    const legacy = {
      findings: [
        {
          id: 'existing-id',
          severity: 'critical',
          file: 'src/a.ts',
          title: 'External reviewer finding',
          detail: 'Seeded from a human PR comment.',
          round: 0,
          status: 'open',
        },
      ],
      verdict: 'changes-required',
      round: 1,
      lastReviewedCommitSha: 'abc123',
      remediationCount: 0,
    };
    const filePath = getReviewArtifactPath(checkoutPath, workflowId);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(legacy), 'utf-8');

    const parsed = await readReviewArtifact(checkoutPath, workflowId);

    expect(parsed).not.toBeNull();
    expect(parsed!.findings[0]!.round).toBe(1);
    expect(parsed!.findings[0]!.status).toBe('open');
    expect(parsed!.lastReviewedCommitSha).toBe('abc123');
  });
});
