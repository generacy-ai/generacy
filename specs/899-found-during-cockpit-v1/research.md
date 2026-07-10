# Research: plan phase writes per-feature managed files

**Feature Branch**: `899-found-during-cockpit-v1`
**Issue**: [generacy-ai/generacy#899](https://github.com/generacy-ai/generacy/issues/899)
**Date**: 2026-07-10

## Decision log

### D1 — Managed-file path (Q1→A)

**Decision**: Per-feature managed file lives at `specs/<feature>/stack.md`.

**Rationale**: The feature branch already owns `specs/<feature>/` exclusively (this is the invariant every previous spec relies on for spec.md/plan.md/tasks.md disjointness). Reusing that ownership boundary for the managed technology file is zero net conceptual load — the same discoverability rule ("look in `specs/<feature>/`") already applies for spec and plan. Humans and agents already `ls specs/<feature>/` when investigating a branch; the file will surface naturally.

**Rejected alternative — `.specify/managed/<feature>.md` (Option B)**: Mints a second managed root under `.specify/` for no gain. `.specify/` today holds *templates* (`.specify/templates/`) and *memory* (`.specify/memory/constitution.md`); it is scaffolder-managed state, not feature-branch-managed state. Adding `.specify/managed/` blurs that line, and worse, `.specify/` is checked in but not part of `specs/<feature>/` — future automation may accidentally treat it as global (repo-wide) again, re-manufacturing the shared-file problem one directory over.

**Rejected alternative — leave `CLAUDE.md` as the write target with `merge=union` in `.gitattributes` (Proposal (b))**: Union merge is line-based; it will silently interleave unrelated edits from two sibling branches and can "resolve" genuinely conflicting shared prose to whichever line came first alphabetically. Weaker guarantee than per-feature ownership, and forces every human/agent reading `CLAUDE.md` to reason about merge semantics.

### D2 — Migration policy for existing legacy sections (Q2→A)

**Decision**: Leave-alone. `/plan` post-fix simply stops appending; existing `<!-- speckit:managed -->` regions or `## <Feature Name> (#NNN)` sections in `CLAUDE.md` on in-flight branches are not touched by tooling.

**Rationale**: Legacy sections drain out ambiently as branches merge. The `CLAUDE.md` on `develop` will still accumulate whatever's already there; a quiet-moment manual cleanup pass, off the critical path, handles that residue. The alternative fixes both *recreate* the disease during migration:

- **Rejected — Strip-on-next-plan (Option B)**: Two in-flight sibling branches each stripping the legacy region are two branches editing `CLAUDE.md` again. Conflicting strips. The migration re-produces the exact merge-conflict class it's meant to escape.
- **Rejected — One-time migration commit on base (Option C)**: Base-side strip converts every in-flight branch's next base-merge into a delete-vs-modify conflict on the region we're escaping. Worst possible outcome — the fix creates conflicts on the very phase (base merge) where they hurt most (waiting-for:merge-conflicts stalls).

**Corollary**: This PR itself does not strip existing sections from `CLAUDE.md`. The plan-phase edit is *additive only* (adds the pointer block); the accumulated `## <feature>` sections stay in place until a manual cleanup, if ever.

### D3 — Scope: this repo vs upstream (Q3→A, verified)

**Decision**: Companion issue in `generacy-ai/agency` (owner of `@generacy-ai/agency-plugin-spec-kit`). This repo ships only the pointer + regression test + companion-issue reference. **No local override shim** of the `/plan` skill or of `plan.ts`'s prompt.

**Verification transcript** (Q3's clarification answer required verifying Assumption 2 before choosing):

```text
$ ls packages/workflow-engine/src/actions/builtin/speckit/operations/
plan.ts  # exists in this repo (Q3 pointed here as precedent)

$ grep -n "CLAUDE.md\|update_agent" packages/workflow-engine/src/actions/builtin/speckit/operations/plan.ts
(zero hits — plan.ts prompt does not instruct writing CLAUDE.md)

$ cat packages/workflow-engine/src/actions/builtin/speckit/operations/plan.ts | grep -A 3 "Instructions:"
1. Analyze the specification and clarifications
2. Determine the technical approach and architecture
3. Identify required technologies and dependencies
4. Break down the implementation into phases
5. Create supporting artifacts as needed
   (no step 5 "call update_agent" — this repo's prompt does not mention it)

$ cat ~/.claude/commands/plan.md | grep -A 2 "update_agent"
5. **Update agent context files** by calling the `update_agent` MCP tool:
   - Updates CLAUDE.md (and other existing agent files) with new technology info
   (write instruction lives in the upstream skill, not in this repo's plan.ts)

$ find /workspaces -name "update-agent.ts" -not -path "*/node_modules/*"
/workspaces/agency/packages/agency-plugin-spec-kit/src/tools/update-agent.ts
(implementation lives in generacy-ai/agency, not in generacy-ai/generacy)
```

Conclusion: the write path is fully upstream. Assumption 2 in spec.md ("plan is implemented by an upstream speckit skill, not by code in this repo") is *correct* for the CLAUDE.md write specifically, even though other speckit operations (clarify, specify) have local wrapper code here. Q3→A applies unmodified.

**Rejected alternative — Local override of `/plan` skill (Option B or C)**: Q3's answer directly rules this out: "no local-override shims — that's drift machinery bridging a gap measured in days on our own pipeline." An override in `.claude/commands/plan.md` (repo-local skill) or a `plan.ts` prompt patch would work for one week, then drift when upstream ships something slightly different (renamed field, moved section, changed marker), and would need to be manually cleaned up. The gap between "PR merges here" and "PR merges upstream" is small enough to not warrant that machinery. SC-002 (in-repo merge-tree invariant) protects against the *class* of bug immediately regardless of upstream timing; SC-001 (end-to-end proof) is the last cell to clear once upstream lands.

### D4 — Idempotency mechanism inside stack.md (Q4→A)

**Decision** (documents the upstream contract, since the write lives upstream): whole-file overwrite. `/plan` owns `specs/<feature>/stack.md` exclusively; each `/plan` invocation rewrites it from scratch with a header naming `/plan` as owner ("Generated by /plan for feature NNN — do not hand-edit").

**Rationale**: The file exists solely as `/plan`'s output. Full ownership with an honest generator-header is simpler than any marker-region ceremony inside the file. Humans who want durable per-feature notes have `spec.md` and `plan.md` an inch away, both branch-owned and both human-writable end-to-end. Layering a "hand-editable slot" inside a generator-owned file mixes two things that are simpler kept apart.

**Rejected alternative — Marker-delimited managed region (Option B)**: The exact ceremony the current `<!-- speckit:managed --><!-- /speckit:managed -->` in `CLAUDE.md` uses. Duplicates the responsibility split across two files (spec.md/plan.md are human-owned; stack.md would be split-ownership) and creates a new class of "did the human edit inside or outside the markers?" ambiguity. Not worth it.

**Rejected alternative — Structured sections by heading (Option C)**: Same objection as (B), one abstraction layer higher (regeneration keys off heading match instead of comment markers). Adds fragility around heading text changes and offers no compensating gain over whole-file overwrite.

**Consequence for this PR**: Whole-file overwrite is the *upstream* target. This repo's PR does not implement the write; the `contracts/companion-issue.md` captures the contract that `generacy-ai/agency`'s update PR must satisfy.

### D5 — Regression test locale and form (Q5→A, reframed)

**Decision**: Automated in-repo vitest test at the deterministic layer, in two layers:

1. **Static-grep layer**: read `packages/workflow-engine/src/actions/builtin/speckit/operations/plan.ts` source, assert zero occurrences of `CLAUDE.md` or `update_agent` in the prompt-building code. Prevents future local-shim regressions in this repo (SC-003).
2. **Simulated merge-tree layer**: in `os.tmpdir()`, `git init`, commit an empty `CLAUDE.md`, branch to `feature-a`, write `specs/feature-a/stack.md`, commit; back to base, branch to `feature-b`, write `specs/feature-b/stack.md`, commit; run `git merge-tree <base> feature-a feature-b`; assert no conflict lines printed. Proves the invariant (SC-002).

**Rationale for reframe**: The literal Q5 spec — "run each through `/plan`" — needs a full agent-driven `/plan` invocation, which is:
- **Expensive**: two `claude` subprocess runs per CI job.
- **Flaky**: agent behavior is non-deterministic; a spec-conforming implementation can occasionally regenerate `plan.md` with a slightly different phase count or wording.
- **Redundant**: the T-S4 cockpit-v1.5 integration test already runs `/plan` end-to-end across sibling branches for free. Doing it twice buys nothing.

The two vitest layers together catch (a) local drift and (b) invariant violation without paying the agent-driven cost. Full agent-driven `/plan` stays a T-S* smoke-test checklist item.

**Rejected alternative — Upstream-only test (Option B)**: This repo trusts upstream to keep the test green. But we lose the drift detector for this repo (someone re-adds a local `CLAUDE.md` write path here; upstream's test wouldn't catch it). Layer 1 explicitly guards this.

**Rejected alternative — Manual runbook only (Option C)**: No CI enforcement. First engineer to add a local write-shim ships it. Not aligned with the "loud failures, no silent guesses" invariant.

**Rejected alternative — Mirrored automated test in both places (Option D)**: Redundant. The test's *invariant* (branches don't conflict on CLAUDE.md) is repo-neutral; the *drift check* is per-repo. Layer 1 (this repo) + upstream's own regression test (upstream) cover the space without duplicating the merge-tree simulation.

## Verification of spec Assumption 2

Recap for future readers who look at spec.md line 4 ("assumes /plan is implemented by an upstream speckit skill"):

- ✅ The write to `<repoRoot>/CLAUDE.md` originates upstream (verified via `update_agent` MCP tool source at `/workspaces/agency/packages/agency-plugin-spec-kit/src/tools/update-agent.ts` — `writeFile(agentPath, updatedContent)` where `agentPath = join(repoRoot, config.filePath)` and `config.filePath = 'CLAUDE.md'`).
- ✅ The `/plan` skill file (`~/.claude/commands/plan.md`) is shipped by `@generacy-ai/agency-plugin-spec-kit` (verified via `setup-speckit.sh`: `npm install -g @generacy-ai/agency-plugin-spec-kit@${CHANNEL}`).
- ⚠️ *Partially wrong context*: `packages/workflow-engine/src/actions/builtin/speckit/operations/plan.ts` *does* exist in this repo, but it is a **delegating wrapper** — it spawns `claude` with a prompt that does not itself instruct `CLAUDE.md` writes. The `update_agent` invocation happens because the agent, executing the spawned Claude, reads the /plan skill from `~/.claude/commands/plan.md` (upstream) and follows step 5.

Assumption 2 is therefore *correct* for the CLAUDE.md write specifically, and Q3→A path is correct.

## Implementation patterns

### Vitest merge-tree test pattern

Prior art in this repo:
- `packages/orchestrator/src/worker/__tests__/base-merge.test.ts` — uses temp git repos to test merge behavior.
- `packages/orchestrator/src/worker/__tests__/merge-conflict-evidence-block.test.ts` — same shape.
- `packages/orchestrator/src/worker/__tests__/phase-loop.merge.test.ts` — similar temp-repo pattern.

New test follows the same shape:

```typescript
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8' }).trim();
}

describe('managed-file disjointness (issue #899)', () => {
  it('two sibling branches writing per-feature stack.md do not conflict on CLAUDE.md', () => {
    const repo = mkdtempSync(join(tmpdir(), 'speckit-managed-'));
    git(repo, 'init -q -b main');
    git(repo, 'config user.email test@test');
    git(repo, 'config user.name test');
    writeFileSync(join(repo, 'CLAUDE.md'), '# Shared CLAUDE.md\n');
    git(repo, 'add -A && git commit -q -m base');
    const base = git(repo, 'rev-parse HEAD');

    // Sibling A
    git(repo, 'checkout -q -b feature-a');
    mkdirSync(join(repo, 'specs', 'feature-a'), { recursive: true });
    writeFileSync(join(repo, 'specs', 'feature-a', 'stack.md'), '# stack A\n');
    git(repo, 'add -A && git commit -q -m a');
    const shaA = git(repo, 'rev-parse HEAD');

    // Sibling B
    git(repo, 'checkout -q main');
    git(repo, 'checkout -q -b feature-b');
    mkdirSync(join(repo, 'specs', 'feature-b'), { recursive: true });
    writeFileSync(join(repo, 'specs', 'feature-b', 'stack.md'), '# stack B\n');
    git(repo, 'add -A && git commit -q -m b');
    const shaB = git(repo, 'rev-parse HEAD');

    // Merge-tree — port matches whichever `git merge-tree` variant is available
    const mergeOutput = execSync(
      `git merge-tree --write-tree -z ${base} ${shaA} ${shaB}`,
      { cwd: repo, encoding: 'utf-8' }
    );
    // Zero-conflict output is a single tree SHA line; conflicts append "CONFLICT" markers
    expect(mergeOutput).not.toMatch(/CONFLICT/);
    expect(mergeOutput).not.toMatch(/CLAUDE\.md/);
  });

  it('plan.ts prompt does not mention CLAUDE.md or update_agent (drift guard)', async () => {
    const planTs = await import('node:fs/promises').then(fs =>
      fs.readFile(
        join(process.cwd(), 'packages/workflow-engine/src/actions/builtin/speckit/operations/plan.ts'),
        'utf-8'
      )
    );
    // Only inspect the prompt-building code region
    const buildPromptFn = planTs.match(/function buildPlanPrompt[\s\S]+?^}/m)?.[0] ?? '';
    expect(buildPromptFn).not.toMatch(/CLAUDE\.md/i);
    expect(buildPromptFn).not.toMatch(/update_agent/i);
  });
});
```

## Key sources / references

- Spec: [spec.md](./spec.md) — issue description, proposal (a), regression test paragraph.
- Clarifications: [clarifications.md](./clarifications.md) — Q1–Q5 with rationales.
- Upstream `update_agent` implementation: `/workspaces/agency/packages/agency-plugin-spec-kit/src/tools/update-agent.ts` (installed via `@generacy-ai/agency-plugin-spec-kit`).
- Upstream `/plan` skill: `/home/node/.claude/commands/plan.md` (installed via `@generacy-ai/agency-plugin-spec-kit`).
- This-repo `/plan` operation wrapper: `packages/workflow-engine/src/actions/builtin/speckit/operations/plan.ts` (verified: no CLAUDE.md write).
- This-repo template flow: `packages/workflow-engine/src/actions/builtin/speckit/lib/templates.ts` (verified: `agent-file` template writes to `feature_dir/CLAUDE.md`, disjoint by branch ownership).
- T-S2/T-S4 evidence: cockpit-v1.5 smoke-test findings #40, #44, #46 (referenced by spec).
- Precedent for local speckit operation edits: PR #842 (clarify.ts modification — cited in Q3 as evidence *that* speckit operations *can* live here; the /plan case is different because the write doesn't originate here).
- Similar merge-tree test patterns: `packages/orchestrator/src/worker/__tests__/base-merge.test.ts`, `merge-conflict-evidence-block.test.ts`, `phase-loop.merge.test.ts`.

---

*Generated by /plan for issue #899.*
