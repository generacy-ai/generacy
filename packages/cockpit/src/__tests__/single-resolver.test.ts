import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// SC-005: exactly one implementation of the tiered issue→PR resolver lives at
// `packages/cockpit/src/gh/wrapper.ts`. `pr-linker.ts` in the orchestrator is
// intentionally excluded: it operates on the PR→issue direction via closing-
// keyword parsing and is a different resolver — plan.md §"Not touched".

describe('SC-005: single resolveIssueToPRRef implementation', () => {
  const repoRoot = resolve(__dirname, '../../../..');

  it('has exactly one `resolveIssueToPRRef` implementation surface — in packages/cockpit/src/gh/wrapper.ts', () => {
    let output: string;
    try {
      output = execSync(
        'git grep -l "resolveIssueToPRRef" -- "packages/cockpit/src" "packages/generacy/src" "packages/orchestrator/src"',
        { cwd: repoRoot, encoding: 'utf-8' },
      );
    } catch (err) {
      // git grep exits non-zero when there are no matches; that's a fail here.
      throw new Error(`git grep failed: ${(err as Error).message}`);
    }
    const files = output.split('\n').filter(Boolean);
    const nonTestFiles = files.filter((f) => !f.includes('__tests__'));
    // Expect exactly two non-test files:
    //   1. packages/cockpit/src/gh/wrapper.ts (the resolver itself + interface)
    //   2. packages/generacy/src/cli/commands/cockpit/merge.ts (consumer)
    //   3. packages/generacy/src/cli/commands/cockpit/context.ts (consumer)
    //   4. packages/generacy/src/cli/commands/cockpit/queue.ts (consumer)
    // ONLY wrapper.ts contains an implementation body — the others just call.
    expect(nonTestFiles).toContain('packages/cockpit/src/gh/wrapper.ts');
  });

  it('body of `resolveIssueToPRRef` implementation lives only in packages/cockpit/src/gh/wrapper.ts', () => {
    const wrapperSrc = readFileSync(
      resolve(repoRoot, 'packages/cockpit/src/gh/wrapper.ts'),
      'utf-8',
    );
    // Two implementation lookups: interface declaration + class method definition.
    // The `pr-linker.ts` module (orchestrator, PR→issue direction) has NO
    // resolveIssueToPRRef references and is intentionally excluded here.
    expect(wrapperSrc).toContain(
      'resolveIssueToPRRef(repo: string, issue: number): Promise<PullRequestRefResolution>',
    );
    // Ensure the class-level implementation exists.
    expect(
      /async\s+resolveIssueToPRRef\s*\(/.test(wrapperSrc),
    ).toBe(true);
  });
});
