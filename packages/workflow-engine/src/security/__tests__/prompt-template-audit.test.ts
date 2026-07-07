import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * SC-006: every prompt template that ingests issue/PR-thread content must
 * route through `wrapUntrustedData`. A simple source-grep audit — this
 * flags regressions if someone adds a new ingesting template but forgets
 * the fence.
 *
 * If you add a new site that ingests comment/thread content into a prompt,
 * add its file path to `INGESTING_SITES` below AND ensure it imports and
 * calls `wrapUntrustedData(...)`.
 */
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');

const INGESTING_SITES: string[] = [
  // workflow-engine: clarify resume-prompt builder ingests issue comments
  join(REPO_ROOT, 'packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts'),
  // orchestrator: pr-feedback handler builds an address-feedback prompt from PR review comments
  join(REPO_ROOT, 'packages/orchestrator/src/worker/pr-feedback-handler.ts'),
];

describe('Prompt-template author-trust fence audit (SC-006)', () => {
  it.each(INGESTING_SITES)('%s routes ingested thread content through wrapUntrustedData', (path) => {
    const source = readFileSync(path, 'utf-8');
    expect(source).toContain('wrapUntrustedData');
  });

  it('workflow-engine clarify.ts no longer instructs the agent to run `gh issue view --comments`', () => {
    const clarifyPath = join(
      REPO_ROOT,
      'packages/workflow-engine/src/actions/builtin/speckit/operations/clarify.ts',
    );
    const source = readFileSync(clarifyPath, 'utf-8');
    // The raw pass-through instruction from the pre-#842 prompt must be gone.
    // The `Run \`gh issue view <n> --comments\`` line was the vector.
    expect(source).not.toMatch(/Run\s+`gh issue view.*--comments`/);
  });
});
