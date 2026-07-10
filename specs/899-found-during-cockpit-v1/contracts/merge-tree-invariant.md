# Contract: merge-tree disjointness invariant

**Enforced by**: `packages/workflow-engine/src/actions/builtin/speckit/__tests__/managed-file-disjointness.test.ts`
**Runs on**: every `pnpm test` invocation (CI and local).

## The invariant

> For any two feature branches A and B forked from the same base commit `<base>`, each of which has run `/plan` at least once, `git merge-tree <base> <A> <B>` reports **zero conflicts** and produces a diff that touches **neither** `CLAUDE.md`.

This is the T-S4 regression scenario, inverted into a machine-checkable assertion.

## Layer 1: static-grep drift guard

**Purpose**: catch attempts to add a local shim in this repo that would re-manufacture the conflict class.

**Assertion**: `packages/workflow-engine/src/actions/builtin/speckit/operations/plan.ts` — specifically its `buildPlanPrompt()` function — contains **no** occurrence of the substrings `CLAUDE.md` or `update_agent` (case-insensitive).

**Rationale**: The write to `CLAUDE.md` originates upstream (verified in [research.md](../research.md) D3). If someone adds a step to this repo's `plan.ts` prompt that instructs a CLAUDE.md write, the fix regresses locally. Static grep is the cheapest possible detector.

**What this does NOT assert**: it does not assert anything about the upstream `/plan` skill (`~/.claude/commands/plan.md`) or the upstream `update_agent` tool. Those are covered by the companion PR's own tests (see [companion-issue.md](./companion-issue.md)).

## Layer 2: merge-tree simulation

**Purpose**: prove the invariant end-to-end without requiring an agent invocation.

**Setup**:
1. Create a fresh temp directory via `mkdtempSync(join(tmpdir(), 'speckit-managed-'))`.
2. `git init -q -b main`.
3. `git config user.email test@test && git config user.name test`.
4. Write a `CLAUDE.md` file with a single line of content.
5. Commit.
6. Record `<base>` = current HEAD SHA.

**Sibling A**:
1. `git checkout -b feature-a`.
2. `mkdir -p specs/feature-a && write specs/feature-a/stack.md`.
3. `git add -A && git commit -m a`.
4. Record `<shaA>` = new HEAD SHA.

**Sibling B**:
1. `git checkout main && git checkout -b feature-b`.
2. `mkdir -p specs/feature-b && write specs/feature-b/stack.md`.
3. `git add -A && git commit -m b`.
4. Record `<shaB>` = new HEAD SHA.

**Assertion**:
1. Run `git merge-tree --write-tree -z <base> <shaA> <shaB>` (or the older 3-arg form, whichever the git version supports).
2. Output MUST NOT contain the substring `CONFLICT`.
3. Output MUST NOT contain the substring `CLAUDE.md`.

**Rationale**:
- Assertion (2) proves the general disjointness invariant — the two branches merge cleanly.
- Assertion (3) proves the specific CLAUDE.md-touch invariant — neither branch wrote to CLAUDE.md, so it never appears in the merge-diff output. This is stronger than "no conflict on CLAUDE.md" — it catches a case where both branches happen to write identical CLAUDE.md content (no conflict, but the invariant is violated because they *did* both touch the shared file).

## What this contract does NOT test

- **Full `/plan` invocation**: expensive + flaky (see [research.md](../research.md) D5). Left to the T-S* smoke-test checklist and the upstream companion PR's own regression coverage.
- **Content of `stack.md`**: [stack-md-file.md](./stack-md-file.md) captures the target shape; this test uses arbitrary placeholder content because the invariant is about *paths*, not *contents*.
- **In-flight legacy sections**: Q2→A leave-alone. Not tested — pre-existing `## <feature>` sections in `CLAUDE.md` are left in place and settle ambiently as branches merge.
- **Upstream update_agent behavior**: not this repo's test. Upstream owns the write; upstream owns the test.

## Failure diagnosis

If Layer 1 fails:
- Someone added a `CLAUDE.md` or `update_agent` reference to `plan.ts`'s prompt code.
- Likely a well-meaning attempt to bridge the upstream gap manually (Q3→A explicitly rejects this).
- Fix: revert the `plan.ts` change; let upstream ship the real fix.

If Layer 2 fails with `CONFLICT` in the output:
- A path other than `specs/<feature>/` is being written by both branches.
- Investigate what path the setup added on both sides — likely a scaffolder or template change bled into the shared root.
- Fix: whatever added the shared write.

If Layer 2 fails with `CLAUDE.md` in the output but no `CONFLICT`:
- Both branches touched `CLAUDE.md` with content that didn't conflict.
- Still a violation — the invariant is that *neither* branch touches CLAUDE.md.
- Fix: locate the code path that wrote CLAUDE.md.

---

*Contract enforced by /plan for issue #899.*
