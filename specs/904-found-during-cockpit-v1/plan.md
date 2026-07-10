# Implementation Plan: Deterministic issue→PR resolver with loud ambiguity + draft rejection

**Feature**: Fix `resolveIssueToPRRef` so `cockpit merge` never silently targets a draft sibling or a coincidentally-mentioned PR — resolve via closing-refs → branch-name → pr-body tiers, exclude drafts from being chosen, and refuse loudly on ambiguity. Every merge attempt logs `resolved PR #N via <linkMethod>` before invoking `gh pr merge`.
**Branch**: `904-found-during-cockpit-v1`
**Issue**: [generacy-ai/generacy#904](https://github.com/generacy-ai/generacy/issues/904)
**Date**: 2026-07-10
**Status**: Complete

## Summary

Root cause of the sniplink P3 incident: `resolveIssueToPRRef` in `packages/cockpit/src/gh/wrapper.ts` runs a single `gh pr list --search linked:<issue> --limit 1` query, which returns whichever PR GitHub's search happens to rank first — including drafts that mention the issue in their body ("depends on #9"). `--limit 1` erases the ambiguity signal; `gh pr merge` then fails with `GraphQL: Pull Request is still a draft` and prints no PR number, forcing the operator to reverse-engineer the target.

Fix (per clarifications Q1..Q5-B):

1. Replace the single search with a **three-tier deterministic resolver** in `resolveIssueToPRRef`:
   - **Tier 1 — closing-refs**: `gh issue view --json closingIssuesReferences,…` returns GitHub's authoritative Development link. Filter to open non-drafts.
   - **Tier 2 — branch-name**: `gh pr list --search head:<issue>-` scans open PRs whose head branch begins with `<issue>-`. Filter to open non-drafts.
   - **Tier 3 — pr-body**: `gh pr list --search <issue> in:body` scans open PRs whose body mentions the issue. Filter to open non-drafts.
   - Per-tier decision (identical shape at every tier): exactly-one non-draft → `resolved`; ≥2 non-drafts → `ambiguous` (no fall-through); zero non-drafts + ≥1 drafts → `pr-is-draft` (no fall-through); zero PRs at that tier → fall through to next tier. Zero at all three → `unresolved`.
2. **Retire `PullRequestRef | null`** — the return type becomes a discriminated union `PullRequestRefResolution`:
   ```ts
   | { kind: 'resolved';    ref: PullRequestRef;         linkMethod: LinkMethod }
   | { kind: 'ambiguous';   candidates: PullRequestRef[]; linkMethod: LinkMethod }
   | { kind: 'pr-is-draft'; candidates: PullRequestRef[]; linkMethod: LinkMethod }
   | { kind: 'unresolved' }
   ```
   `linkMethod` is `'closing-refs' | 'branch-name' | 'pr-body'` on all non-`unresolved` kinds and names the tier that produced the result.
3. **Update `runMerge`** to switch on `.kind` and route:
   - `resolved` → emit `resolved PR #N via <linkMethod>` log line (FR-004 — lands **before** `gh pr merge` so a subsequent failure never erases the evidence), then continue existing gate checks.
   - `pr-is-draft` → emit failing-check payload with `reason: 'pr-is-draft'`, do NOT call `gh pr merge`.
   - `ambiguous` → emit failing-check payload with `reason: 'ambiguous-resolution'`, do NOT call `gh pr merge`.
   - `unresolved` → existing `reason: 'unresolved'` path preserved.
4. **Extend `FailingCheckPayload`** (per clarification Q4-D):
   - Single-PR outcomes (`unresolved`, `missing-label`, `checks-failing`, single-candidate `pr-is-draft`): `pr: { number, url, linkMethod } | null` — same key name, extra optional field.
   - Multi-candidate outcomes (`ambiguous`, multi-`pr-is-draft`): `pr: null`, plus `candidates: [{ number, url, isDraft, headRefName }]` and top-level `linkMethod`.
   - Two new `reason` enum values: `'pr-is-draft'` and `'ambiguous-resolution'`. Existing three (`checks-failing`, `missing-label`, `unresolved`) unchanged.
5. **Update all `resolveIssueToPRRef` call sites** to the new discriminated union: `runMerge` (`merge.ts:85`), `context.ts:266` (implementation-review bundle), test fakes (`packages/generacy/src/cli/commands/cockpit/__tests__/helpers/fake-gh.ts`, `packages/generacy/src/cli/commands/cockpit/__tests__/merge.test.ts`, `packages/generacy/src/cli/commands/cockpit/__tests__/queue.dependency-warnings.test.ts`, `packages/cockpit/src/resolver/__tests__/resolve.test.ts`), and the JSON schema in `specs/789-epic-generacy-ai-tetrad/contracts/failing-check.schema.json`.

Non-goals (out of scope per spec §Out of Scope): the retry/escalation policy in tetrad-development's auto-mode; changes to `gh pr merge` itself; new link tiers beyond the three; cross-repo issue→PR resolution.

## Technical Context

**Language / Runtime**: TypeScript 5.x, ESM, Node ≥22.
**Test framework**: Vitest.
**Key packages touched**:
- `packages/cockpit/` — the shared resolver lives here (`src/gh/wrapper.ts`). Exports the `GhWrapper` interface and `GhCliWrapper` class consumed cross-package.
- `packages/generacy/src/cli/commands/cockpit/` — `merge.ts`, `context.ts`, `shared/failing-check-json.ts`, plus test doubles.
- `specs/789-epic-generacy-ai-tetrad/contracts/failing-check.schema.json` — the FailingCheckPayload JSON Schema referenced from `merge.test.ts:21`.

**External dependencies**: `gh` CLI. Existing subcommands (all documented, no new capabilities required):
- `gh issue view <n> --json closingIssuesReferences` (Tier 1 — already used by the current fallback branch of `resolveIssueToPRRef`).
- `gh pr list --repo <r> --search "head:<issue>-" --state open --json number,url,state,isDraft,headRefName` (Tier 2 — extends the existing `gh pr list --search linked:<n>` pattern with a different qualifier).
- `gh pr list --repo <r> --search "<issue> in:body" --state open --json …` (Tier 3 — same shape, body-mention qualifier).

**Assumptions carried from spec**:
- `gh pr view --json closingIssuesReferences` remains the canonical Development-link surface.
- `isDraft` is always populated on returned PR objects.
- The three tiers are exhaustive for v1.
- Callers other than `runMerge` adopt the discriminated-union shape as part of the same PR.
- Adding `'pr-is-draft'` and `'ambiguous-resolution'` to the reason enum is additive — existing consumers of `'unresolved' | 'missing-label' | 'checks-failing'` do not break.

## Project Structure

**Modified — the shared resolver + its type surface**:
- `packages/cockpit/src/gh/wrapper.ts` — replace `resolveIssueToPRRef(...)` implementation with three-tier logic. Change return type of `GhWrapper.resolveIssueToPRRef` (interface at line 128) from `Promise<PullRequestRef | null>` to `Promise<PullRequestRefResolution>`. Export new `PullRequestRefResolution`, `LinkMethod`, `PullRequestRefKind` types.

**Modified — merge command**:
- `packages/generacy/src/cli/commands/cockpit/merge.ts` — `runMerge` switches on the new union. Emits `resolved PR #N via <linkMethod>` log line **before** `gh pr merge`. New handling branches for `'pr-is-draft'` and `'ambiguous'` kinds emit failing-check payloads and exit non-zero without calling `gh pr merge`.
- `packages/generacy/src/cli/commands/cockpit/shared/failing-check-json.ts` — extend `RedReason` union with `'pr-is-draft' | 'ambiguous-resolution'`. Extend `pr` field to `{ number, url, linkMethod } | null`. Add optional `candidates: PrCandidate[]` and optional top-level `linkMethod` for the multi-candidate reasons. Add corresponding invariants to `buildFailingCheckPayload`.

**Modified — non-merge consumer of resolveIssueToPRRef**:
- `packages/generacy/src/cli/commands/cockpit/context.ts` (line 266, inside `buildImplementationReviewBundle`) — replace `if (prRef == null)` with a `switch` on `.kind`. `resolved` → happy path (extract `.ref`). `pr-is-draft` / `ambiguous` / `unresolved` → `throw new CockpitExit(3, …)` with a copy that names the issue, tier, and candidate PR numbers when available. Preserves existing exit-code semantics (3 = gate refusal) for the review-context UX.

**Modified — JSON schema**:
- `specs/789-epic-generacy-ai-tetrad/contracts/failing-check.schema.json` — extend the `reason` enum to include `'pr-is-draft'` and `'ambiguous-resolution'`. Add optional `linkMethod` to `pr` object. Add optional top-level `linkMethod` string and `candidates` array. Extend the `allOf` if/then block for the two new reasons.

**Modified — tests (all existing)**:
- `packages/cockpit/src/__tests__/gh-wrapper.test.ts` — rewrite the four `resolveIssueToPRRef` cases (lines 481-573) around the discriminated union. Add new coverage per SC-001..SC-004: sniplink-shape fixture, draft-only fixture, multi-non-draft ambiguity at each tier, fall-through between tiers.
- `packages/cockpit/src/resolver/__tests__/resolve.test.ts` — update the `MockGhWrapper.resolveIssueToPRRef` stub (line 39-41) to return the new union shape (`{ kind: 'unresolved' }` for existing behavior).
- `packages/generacy/src/cli/commands/cockpit/__tests__/merge.test.ts` — update the `FakeOverrides.resolveIssueToPR` shape and fake at lines 29 + 64-68 to the new union. Add cases: draft-sibling sniplink fixture, ambiguous body-mentions, `resolved PR #N via <linkMethod>` log-line snapshot on the green path, single-candidate `pr-is-draft` and multi-candidate `pr-is-draft`, ambiguous at each tier.
- `packages/generacy/src/cli/commands/cockpit/__tests__/queue.dependency-warnings.test.ts` + `packages/generacy/src/cli/commands/cockpit/__tests__/helpers/fake-gh.ts` — update fake stub return shape.
- `packages/generacy/src/cli/commands/cockpit/__tests__/context.implementation-review.test.ts` — add cases for `pr-is-draft`, `ambiguous`, `unresolved` under the review-context bundle (each → `CockpitExit(3, …)` with the tier + candidates in the message).

**Not touched (intentional)**:
- `packages/orchestrator/src/worker/pr-linker.ts` — the PR→issue direction resolver used by `PrFeedbackMonitorService`. Spec §Observed and SC-005 nod at "shared code path", but PrLinker operates on PR-body closing-keyword parsing (`\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\s#(\d+)`) — a different query direction that doesn't produce the multi-candidate ambiguity `resolveIssueToPRRef` does. Reconciling PrLinker with the tiered resolver is a separate refactor and not required by any FR-001..FR-009 (which are all scoped to `resolveIssueToPRRef` and its callers).
- `packages/cockpit/src/resolver/resolve.ts` — the epic-body parser. Unrelated to issue→PR resolution.
- `GhWrapper.resolveIssueToPR(repo, issueNumber): Promise<number | null>` — the older number-only surface. Used by `status.ts` and several context tests. Kept as-is; the discriminated-union upgrade is scoped to `resolveIssueToPRRef` per FR-009. Cross-referenced in `research.md` §"Why not fold `resolveIssueToPR` into the union too?".

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo. Constitution check is trivially satisfied.

**Cross-cutting invariants observed anyway**:
- **No exceptions-as-control-flow** (per Q5 rejection of Option C) — the resolver returns a discriminated result, callers `switch` on `.kind`. No new typed throws.
- **No TOCTOU re-derivation** (per Q5 rejection of Option A/D) — the union carries the candidate evidence from the single resolution pass. `runMerge` never re-queries `gh` to render an ambiguity payload.
- **Loud failure on ambiguity** — merge is the one irreversible cockpit verb (spec §Fix, item 3). No warning-and-guess coin flip anywhere in the resolver.
- **Additive enum change** — the two new `reason` values append to the union; existing consumers of the three existing values keep working.

## Data & Contract Artifacts

- `research.md` — technology decisions (why `gh issue view --json closingIssuesReferences` for Tier 1, why `head:<issue>-` for Tier 2, why `<issue> in:body` for Tier 3, why a discriminated union over sentinel `null`, why extend the existing `pr` key instead of renaming to `resolvedPr`).
- `data-model.md` — full type definitions for `PullRequestRefResolution`, `LinkMethod`, `PrCandidate`, `FailingCheckPayload` (post-change), plus the per-tier decision matrix and validation invariants.
- `contracts/resolver.md` — pre/post conditions on `resolveIssueToPRRef`. Input/output tables for the four `kind` values. Ordering guarantees (`closing-refs` runs before `branch-name` runs before `pr-body`, exactly once).
- `contracts/failing-check-payload.md` — the extended failing-check payload shape. Covers all five reasons + the multi-candidate branches.
- `contracts/failing-check.schema.json` update sketch — additive JSON Schema changes so the ajv validator in `merge.test.ts:26-27` keeps accepting new reasons + fields.
- `quickstart.md` — repro the sniplink incident locally (fixture + expected log lines + expected JSON payload), plus a code-search command that proves SC-005 (only one resolver).

## Next Step

Run `/speckit:tasks` to generate the dependency-ordered task list.
