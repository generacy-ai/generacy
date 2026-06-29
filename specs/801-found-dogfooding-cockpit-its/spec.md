# Feature Specification: Found by dogfooding the cockpit on its own epic (`generacy-ai/tetrad-development#85`) after #800

**Branch**: `801-found-dogfooding-cockpit-its` | **Date**: 2026-06-29 | **Status**: Draft

## Summary

Found by dogfooding the cockpit on its own epic (`generacy-ai/tetrad-development#85`) after #800.

## Symptom

`generacy cockpit status --epic generacy-ai/tetrad-development#85` returns unrelated tetrad-development issues (Latency migration, dev-container refactor, Stripe, …) instead of the epic's actual children, which live in `generacy-ai/generacy` (#786–793) and `generacy-ai/agency` (#350–360).

## Root cause (two layers)

1. **Manifest rejected → fallback fires.** When the manifest can't be read, `resolveEpicIssues` falls back to a `gh search` label query scoped to the epic's **own** repo (`repo:<epicRepo> is:issue label:epic-child …`). For a cross-repo epic, that repo holds *other* epics' children, so the wrong issues come back.

2. **Cross-repo refs are dropped even with a valid manifest.** In `packages/cockpit/src/manifest/scoping.ts`, `resolveEpicIssues` keeps only refs where `parseIssueRefNumber(ref, ownerRepo)` succeeds — i.e. refs whose repo equals the epic's repo. Cross-repo refs like `generacy-ai/generacy#786` (from a `generacy-ai/tetrad-development` epic) are filtered out, and the function returns a bare `number[]` that cannot carry each child's repo. So a cross-repo epic resolves to an empty/incorrect set.

The manifest schema explicitly supports cross-repo children (`phases[].issues` is `owner/repo#n`; `phases[].repos` is `owner/repo`), so honoring cross-repo refs is the intended contract.

## Expected

- `resolveEpicIssues` returns **repo-qualified** child refs (e.g. `{ repo, number }[]` or `owner/repo#n[]`), preserving each child's repo, including cross-repo entries from the manifest.
- `status` / `watch` fetch + classify each child **in its own repo**.
- The label-graph fallback searches the configured `cockpit.repos` for `epic-parent` body references (cross-repo), not just the epic's own repo.

## Repro

1. Ensure a valid manifest exists for the epic.
2. `generacy cockpit status --epic generacy-ai/tetrad-development#85`
3. Observe it does **not** list `generacy-ai/generacy#786–793` / `generacy-ai/agency#350–360`.

## Notes

- Companion data fix (separate, in tetrad-development): the committed `.generacy/epics/epic-cockpit.yaml` used bare repo names (`repos: [generacy]`) instead of `owner/repo`, which made the manifest invalid and triggered the fallback. Being corrected separately.
- The `gh search` quoting crash that previously masked this was fixed in #800.

Parent epic: generacy-ai/tetrad-development#85


## User Stories

### US1: Operator inspects a cross-repo epic with `status`

**As an** operator coordinating an epic whose children span multiple repos (e.g. epic in `tetrad-development`, children in `generacy` and `agency`),
**I want** `generacy cockpit status --epic <epic>` to list and classify the epic's actual children — each fetched from its own repo,
**So that** I can see the real state of the epic instead of unrelated issues from the epic's own repo.

**Acceptance Criteria**:
- [ ] Given a manifest at `.generacy/epics/<epic>.yaml` with `phases[].issues` containing cross-repo refs (`owner/repo#n`), `cockpit status --epic` lists every one of those issues regardless of which repo it lives in.
- [ ] Each issue row is rendered using metadata fetched from **its own** repo (title, labels, PR state), not the epic's repo.
- [ ] No unrelated issues from the epic's own repo appear in the output for a cross-repo epic.

### US2: Operator runs `watch` on a cross-repo epic

**As an** operator watching a cross-repo epic for state transitions,
**I want** `generacy cockpit watch --epic <epic>` to poll each child in its own repo,
**So that** transitions in cross-repo children produce events instead of being invisible.

**Acceptance Criteria**:
- [ ] `cockpit watch --epic` polls cross-repo children with `gh issue view --repo <child-repo>` (or equivalent).
- [ ] Events emitted include the full `owner/repo#n` identity of each child.

### US3: Fallback path searches configured repos, not just the epic's repo

**As an** operator whose epic has no manifest (or whose manifest is malformed),
**I want** the label-graph fallback to search across `cockpit.repos` (∪ the epic's own repo) for `epic-parent` body references,
**So that** I still get a useful, cross-repo-aware result instead of a bag of unrelated issues from the epic's own repo.

**Acceptance Criteria**:
- [ ] When no manifest matches, `resolveEpicIssues` searches each repo in the cockpit's configured `repos` list, unioned with the epic's own repo and deduped, for issues whose body references the epic (`owner/repo#NNN`) and/or carry the `epic-child` label.
- [ ] Results are repo-qualified and deduped across repos.
- [ ] If no configured `repos` list is available, the function falls back to the epic's own repo (today's behavior) but logs a structured warning naming the limitation.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `resolveEpicIssues` returns `Array<{ repo: string; number: number }>`, where `repo` is the full `owner/repo`, preserving each child's repo identity. | P1 | Q1 resolved to A. Breaking change to the function's public type; today's `number[]` return cannot carry repo. |
| FR-002 | When a matching manifest exists, every `owner/repo#n` entry in `phases[].issues` is included in the resolved set — including entries whose repo differs from the epic's repo. | P1 | Today's `parseIssueRefNumber(ref, epicOwnerRepo)` drops these. |
| FR-003 | `cockpit status --epic` and `cockpit watch --epic` fetch and classify each child issue **from its own repo**, using the `repo` carried in the resolved ref. | P1 | Downstream callers in `packages/generacy/src/cli/commands/cockpit/{status,watch}` and `shared/scoping.ts`'s `Scope.issues` must be updated to use the new shape. |
| FR-004 | The label-graph fallback (no manifest available) iterates `cockpit.repos ∪ the epic's own repo` (deduped) and, per repo R, runs **both** `repo:R is:issue label:epic-child <epicOwner/epicRepo>#<epicN>` and `repo:R is:issue <epicOwner/epicRepo>#<epicN> in:body`. Results are repo-qualified and deduped across queries. | P1 | Q3 resolved to A (∪ epic's own repo, deduped). Q4 resolved to A (both queries, fully-qualified epic ref). Full ref avoids matching unrelated `#N` in other repos. |
| FR-005 | When the fallback runs without an available `repos` configuration, the function logs a structured warning naming the limitation and falls back to the epic's own repo. | P2 | Graceful degradation when called outside the CLI's config-loaded scope. |
| FR-006 | The CLI emits a single human-readable warning (and a structured log entry) when a manifest file is rejected as malformed, naming the file path and reason. | P2 | Existing `logger.warn` is preserved; surface it in CLI stderr so users notice the fallback. |
| FR-007 | `@generacy-ai/cockpit` exports the new repo-qualified ref type so downstream callers can rely on a stable shape, and the package version is bumped **minor** (e.g. 0.1.0 → 0.2.0). | P1 | Q5 resolved to A. Pre-1.0 minor bump permitted for breaking change; all consumers updated in the same PR. |
| FR-008 | The existing test suite for `resolveEpicIssues` is extended with at least one test per acceptance criterion above (cross-repo manifest, cross-repo fallback with `cockpit.repos`, no-`repos`-configured fallback, malformed-manifest warning). | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `generacy cockpit status --epic generacy-ai/tetrad-development#85` lists the epic's real children. | All of `generacy-ai/generacy#786–793` and `generacy-ai/agency#350–360` appear; no unrelated `tetrad-development` issues. | Manual run against live data after merge. |
| SC-002 | Cross-repo children are rendered with metadata from their own repo. | Each child row's title/labels/PR state match `gh issue view --repo <child-repo> <n>`. | Manual verification on the same epic. |
| SC-003 | Fallback path (manifest absent) returns cross-repo-correct results. | For an epic with no manifest, results union across `cockpit.repos ∪ epic's own repo` and contain only issues that reference the epic via label or body. | New unit test in `packages/cockpit/__tests__/manifest/scoping.test.ts`. |
| SC-004 | No regression for single-repo epics. | Existing `resolveEpicIssues` tests pass unchanged (after shape migration). | CI green on the existing suite plus the new tests in FR-008. |

## Assumptions

- `cockpit.repos` is normalized to `owner/repo` strings before reaching `resolveEpicIssues` (already enforced upstream by config loading).
- `phases[].repos` in the manifest remains informational only (Q2 resolved to A); resolution is driven exclusively by `phases[].issues`.
- The companion data fix in `tetrad-development` (epic-cockpit.yaml using `owner/repo`) lands separately; this spec does not depend on it but benefits from it (manifest path takes precedence over fallback when both work).
- All downstream consumers of `resolveEpicIssues` (`status.ts`, `watch.ts`, `shared/scoping.ts`'s `Scope.issues`) are inside this repo and updated in the same PR; no out-of-repo consumers exist.

## Out of Scope

- Re-deriving `phases[].repos` from `phases[].issues` or otherwise giving `phases[].repos` an active role in resolution (Q2 resolved to A: stay informational).
- A major-version bump for `@generacy-ai/cockpit` (Q5 resolved to A: minor; pre-1.0 convention).
- Backfilling missing manifests for existing cross-repo epics; the fallback is the safety net for manifest-less epics.
- Changing the cross-repo body-reference label conventions (`epic-child`, `epic-parent`) or adding new disambiguation labels.

---

*Generated by speckit*
