# Implementation Plan: Sweep #808 residue (release metadata, docs, test surface)

**Feature**: Delete stale changesets, prune orchestrator/journal residue from cockpit docs + entry point, and add a legacy-config tolerance test that locks Zod strip mode against a future `.strict()` regression
**Branch**: `810-epic-generacy-ai-tetrad`
**Date**: 2026-07-06
**Status**: Complete
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md)

## Summary

PR #808 (G-S1, merged) deleted the cockpit orchestrator client, journal-liveness, `appendChildIssue`, `stuck`/`recovered` watch events, and `orchestrator.*`/`stuckThresholdMinutes` config keys. The code deletion was complete (no dangling imports), but three surfaces still advertise the removed subsystems: pending changesets from the two features (`792`, `793`), README/package.json/index-comment references, and a not-yet-existing legacy-config test. This PR closes those gaps.

Scope, after clarifications:

1. **Release metadata (FR-001, FR-002)**. Delete `.changeset/792-cockpit-orchestrator-status.md` and `.changeset/793-cockpit-journal-stuck-detection.md`. Keep `.changeset/805-cockpit-delete-orchestrator-journal.md` as authoritative at **MINOR** bump (pre-1.0 convention, precedent set by #801/#802). Append one line to `805-*.md` covering the `STALE` status column and the stuck fields the current body omits. No second changeset (Q1).
2. **Docs / entry point (FR-003, FR-004, FR-005)**. Remove the last orchestrator reference from `packages/cockpit/README.md` line 5 (Q2), drop "and orchestrator client" from `packages/cockpit/package.json` `description`, and delete `orchestrator/http` / `orchestrator/stub` from the `packages/cockpit/src/index.ts` header comment.
3. **Legacy-config tolerance test (FR-006)**. Add a fixture that nests removed keys under `cockpit:` (only nested placement exercises strip mode — the loader passes only `doc['cockpit']` to the schema) and a Vitest case asserting (1) no throw, (2) `parsed.orchestrator === undefined`, (3) `parsed.stuckThresholdMinutes === undefined` (Q3).
4. **FR-009 tombstone replacement**. Verified moot on inspection: `packages/generacy/src/cli/commands/cockpit/__tests__/status.render.test.ts` already asserts positive on load-bearing envelope keys (`parsed.scope`, `parsed.rows`) and contains no `expect(parsed.orchestrator).toBeUndefined()` line. No edit required.
5. **Skipped**. FR-007 (moot — `shared.scoping.test.ts` was deleted by #806 with the manifest scoping it tested). FR-008 (owned by in-flight #807 — verify orchestrator-mock removal at #807's implementation review instead, per Q4).

Non-goals: no code-path changes to the cockpit library or CLI, no schema evolution, no follow-up issue.

## Technical Context

**Language/Version**: TypeScript 5.x, ESM, Node >=22.
**Primary Dependencies**: no new runtime deps. Test uses existing Vitest, `yaml`, and `@generacy-ai/config` (already loader deps).
**Storage**: none (touch is release-metadata files, docs, one test fixture).
**Testing**: Vitest, colocated `__tests__/` under `packages/cockpit/src/`. One new `it()` block in `config-loader.test.ts`, one new fixture under `packages/cockpit/src/__tests__/fixtures/config-samples/`.
**Target Platform**: repo-side release automation (`changeset version`) and package doc surface. Not a runtime code change.
**Project Type**: single-package doc + test surface inside pnpm workspace.
**Performance Goals**: n/a.
**Constraints**:
- Isolation ("Owns" clause in spec): `.changeset/**`; `packages/cockpit/{README.md,package.json,src/index.ts,src/__tests__/**}`.
- The four CLI test files listed in FR-008 (`state.test.ts`, `advance.test.ts`, `clarify-context.test.ts`, `queue.test.ts`) are owned by in-flight #807; do not edit them here (Q4).
- Zod strip mode must remain the observable behavior of `CockpitConfigSchema`; the new test locks it in.
**Scale/Scope**: 2 changeset deletions, 1 changeset append, 3 doc/entry-point edits, 1 test + 1 fixture. Zero net-new modules.

## Constitution Check

No `.specify/memory/constitution.md` file exists in this repo. The controlling principle here is the R4 promise carried over from the source spec (Zod schemas run in *strip* mode; unknown keys are silently dropped rather than rejected). The new legacy-config test locks that promise into an executable assertion, satisfying the "guards against a future `.strict()`" line in FR-006.

## Project Structure

### Documentation (this feature)

```text
specs/810-epic-generacy-ai-tetrad/
├── spec.md                       # feature spec (read-only)
├── clarifications.md             # Q1–Q5 answers
├── plan.md                       # this file
├── research.md                   # decision log (Q1–Q5 rationale)
├── data-model.md                 # CockpitConfigSchema strip-mode contract
├── quickstart.md                 # SC-001 verification walkthrough
├── contracts/
│   └── cleanup-map.md            # FR → file map, expected post-state
├── conversation-log.jsonl
└── checklists/
```

### Source Code (repository root)

Files deleted:

```text
.changeset/792-cockpit-orchestrator-status.md   # DELETE — feature never shipped (superseded by #808 removal)
.changeset/793-cockpit-journal-stuck-detection.md   # DELETE — same
```

Files modified:

```text
.changeset/805-cockpit-delete-orchestrator-journal.md   # APPEND ONE LINE — cover STALE status column + stuck fields omitted from current enumeration
packages/cockpit/README.md                              # LINE 5 — remove "without depending on the orchestrator runtime" trailing clause (or entire sentence if it becomes vestigial)
packages/cockpit/package.json                           # description — strip ", and orchestrator client"
packages/cockpit/src/index.ts                           # LINES 1-3 — remove "orchestrator/http, orchestrator/stub" from the "Internal modules … are NOT exported" comment
```

Files created:

```text
packages/cockpit/src/__tests__/fixtures/config-samples/legacy-orchestrator-keys.yaml   # NEW — nested legacy keys under cockpit:
```

Files modified (test):

```text
packages/cockpit/src/__tests__/config-loader.test.ts    # NEW it() — "strips legacy orchestrator/stuckThresholdMinutes keys nested under cockpit:"
```

Files NOT touched (per Q4):

```text
packages/generacy/src/cli/commands/cockpit/__tests__/status.render.test.ts   # already positive on parsed.scope + parsed.rows; no tombstone present
packages/generacy/src/cli/commands/cockpit/__tests__/state.test.ts           # owned by in-flight #807
packages/generacy/src/cli/commands/cockpit/__tests__/advance.test.ts         # owned by in-flight #807
packages/generacy/src/cli/commands/cockpit/__tests__/clarify-context.test.ts # owned by in-flight #807
packages/generacy/src/cli/commands/cockpit/__tests__/queue.test.ts           # owned by in-flight #807
```

## Implementation Notes

### Order of operations

The five edits are independent; any order works. Recommended:

1. Delete `792-*.md` and `793-*.md` first (they misrepresent the release channel if `changeset version` runs mid-PR).
2. Append the one-line `STALE` addendum to `805-*.md`.
3. `README.md` line 5, `package.json` description, `index.ts` header comment (three trivial edits).
4. New fixture + new test case last; run `pnpm --filter @generacy-ai/cockpit test` to lock in strip-mode behavior.

### FR-006 test shape (Q3)

Fixture YAML nests the removed keys under `cockpit:`:

```yaml
cockpit:
  owner: alice
  orchestrator:
    url: https://example.invalid
  stuckThresholdMinutes: 30
```

The test writes this fixture into a temp workspace (existing `writeConfig()` helper in `config-loader.test.ts` already does exactly this pattern), calls `loadCockpitConfig({ cwd, whoami: async () => null })`, and asserts:

1. No throw (implied by `await` succeeding).
2. `result.config.owner === 'alice'` (positive proof the parse ran).
3. `(result.config as unknown as { orchestrator?: unknown }).orchestrator === undefined`.
4. `(result.config as unknown as { stuckThresholdMinutes?: unknown }).stuckThresholdMinutes === undefined`.

Assertion (3) and (4) are the load-bearing pair: they fail under `.strict()` (which would throw before parsing) but pass under `strip` (which drops the extras from the output object). Cast is intentional — the `CockpitConfig` type has no such fields, and the cast is what makes the assertion compile at type level.

### FR-009 (Q5) — verified moot on inspection

The current `status.render.test.ts` contains no `expect(parsed.orchestrator).toBeUndefined()`; it already asserts positive on `parsed.scope` and `parsed.rows`, which are exactly the "load-bearing keys" Q5 specifies. Plan skips FR-009 rather than edit a test that already conforms.

### FR-002 addendum wording

The existing `805-*.md` body enumerates: orchestrator client, health/jobs/workers types, journal liveness, `readJournalLiveness`, `StuckReason`, `JournalLivenessResult`, `appendChildIssue`, watch `stuck`/`recovered`, `CockpitEventSchema` fix, `orchestrator.*` / `stuckThresholdMinutes` config. It does NOT mention (a) the `STALE` status column removal from the status table renderer and (b) the specific stuck fields (`stuckAt`, `lastJournalAt`) that vanished from `StatusRow`. Append one line covering both.

### SC-001 verification

After all edits, `grep -RIn "orchestrator\|ORCHESTRATOR_\|stuckThresholdMinutes\|StuckReason\|readJournalLiveness\|appendChildIssue" packages/cockpit/README.md packages/cockpit/package.json packages/cockpit/src/index.ts .changeset/` should return zero hits **for the deleted subsystems** (excluding the changeset entries that describe their removal — i.e., `805-*.md` legitimately mentions them). The quickstart walks through the expected greps.

## Risks

- **`changeset version` timing.** If `changeset version` runs against `main` while this PR is still open, `792-*.md` and `793-*.md` will consume version bumps and ship changelog entries for features that don't exist. Mitigation: keep the delete-changesets step first in the diff and land this PR before the next release train.
- **Silent `.strict()` regression.** Nothing outside the new test guards against a schema author switching `CockpitConfigSchema` from `z.object(...)` (strip mode default) to `z.object(...).strict()`. The test breaks loudly if that switch happens — but only if the test is run. CI already runs `pnpm test` on every PR, so this is covered.
- **README line-5 rewrite risk.** The current sentence — *"a set of pure, testable primitives any cockpit consumer (UI, CLI, or service) can import without depending on the orchestrator runtime"* — the "without depending on the orchestrator runtime" clause is still accurate framing even after removal (the primitives never depended on it anyway). Q2 says "remove if stale, keep only if it legitimately describes the generacy orchestrator context." Judgement call at edit time; default to remove for a clean grep result.
