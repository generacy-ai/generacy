# Feature Specification: Cockpit `resolveEpicIssues` honors cross-repo epic children

**Branch**: `801-found-dogfooding-cockpit-its` | **Date**: 2026-06-29 | **Status**: Draft
**GitHub Issue**: [generacy-ai/generacy#801](https://github.com/generacy-ai/generacy/issues/801)
**Parent Epic**: generacy-ai/tetrad-development#85

## Summary

`generacy cockpit status --epic owner/repo#N` and `generacy cockpit watch --epic owner/repo#N` silently return the **wrong issues** when the epic's children live in a repo other than the epic's own. Found by dogfooding cockpit on its own epic (`generacy-ai/tetrad-development#85`) — the command listed unrelated tetrad-development issues instead of the epic's actual children in `generacy-ai/generacy` and `generacy-ai/agency`.

The manifest schema explicitly supports cross-repo children (`phases[].issues: owner/repo#n`, `phases[].repos: owner/repo`), but two layers of `resolveEpicIssues` discard that information:

1. **Manifest path filters out cross-repo refs.** `parseIssueRefNumber(ref, ownerRepo)` only matches refs whose repo equals the epic's repo. Cross-repo refs like `generacy-ai/generacy#786` (from a `generacy-ai/tetrad-development` epic) are dropped. The function returns `number[]`, which cannot represent which repo each child lives in.
2. **Fallback path searches the wrong repo.** When the manifest is missing or rejected, `resolveEpicIssues` falls back to `gh search` scoped to the epic's **own** repo (`repo:<epicRepo> is:issue label:epic-child …`). For a cross-repo epic, that repo holds *other* epics' children, so the wrong issues come back.

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
**I want** the label-graph fallback to search across `cockpit.repos` for `epic-parent` body references,
**So that** I still get a useful, cross-repo-aware result instead of a bag of unrelated issues from the epic's own repo.

**Acceptance Criteria**:
- [ ] When no manifest matches, `resolveEpicIssues` searches each repo in the cockpit's configured `repos` list (not only the epic's repo) for issues whose body references the epic (`owner/repo#NNN`) and/or carry the `epic-child` label.
- [ ] Results are repo-qualified and deduped across repos.
- [ ] If no configured repos list is available, the function falls back to the epic's own repo (today's behavior) but logs a warning identifying the limitation.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `resolveEpicIssues` returns repo-qualified child refs (shape: `Array<{ repo: string; number: number }>` or equivalent `owner/repo#n` strings), preserving each child's repo identity. | P1 | Today's `number[]` return cannot carry repo. Breaking change to the function's public type. |
| FR-002 | When a matching manifest exists, every `owner/repo#n` entry in `phases[].issues` is included in the resolved set — including entries whose repo differs from the epic's repo. | P1 | Today's `parseIssueRefNumber(ref, epicOwnerRepo)` drops these. |
| FR-003 | `cockpit status --epic` and `cockpit watch --epic` fetch and classify each child issue **from its own repo**, using the repo carried in the resolved ref. | P1 | Downstream callers in `packages/generacy/src/cli/commands/cockpit/{status,watch}` must be updated to use the new shape. |
| FR-004 | The label-graph fallback (no manifest available) iterates the cockpit's configured `repos` list to search for `epic-child` label hits and body references to the epic, instead of only searching the epic's own repo. | P1 | New behavior; today's fallback uses `repo:<epicRepo>` only. |
| FR-005 | When the fallback runs without an available `repos` configuration, the function logs a structured warning naming the limitation and falls back to the epic's own repo. | P2 | Graceful degradation when called outside the CLI's config-loaded scope. |
| FR-006 | The CLI emits a single human-readable warning (and a structured log entry) when a manifest file is rejected as malformed, naming the file path and reason. | P2 | Existing `logger.warn` is preserved; surface it in CLI stderr so users notice the fallback. |
| FR-007 | `@generacy-ai/cockpit` package exports the new repo-qualified ref type so downstream callers can rely on a stable shape. | P1 | Public API change — bump cockpit package minor version. |
| FR-008 | The existing test suite for `resolveEpicIssues` is extended with at least one test per acceptance criterion above (cross-repo manifest, cross-repo fallback, no-repos-configured fallback, malformed-manifest warning). | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `generacy cockpit status --epic generacy-ai/tetrad-development#85` lists every child issue from the manifest (currently `generacy-ai/generacy#786–793` and `generacy-ai/agency#350–360`) and **no** unrelated issues from `generacy-ai/tetrad-development`. | 100% of manifested children listed; 0 unrelated rows. | Manual dogfood run after the fix, compared against the manifest. |
| SC-002 | Same command with the manifest file deleted (forcing the fallback) returns the same set of children, scoped from `cockpit.repos`. | ≥ 90% overlap with the manifest result (some label-based misses are acceptable). | Manual dogfood run with manifest file temporarily renamed. |
| SC-003 | Unit tests covering each FR pass in CI. | Green check on `pnpm --filter @generacy-ai/cockpit test`. | CI run. |
| SC-004 | No regression in same-repo epic resolution (the common case): `cockpit status --epic owner/repo#N` for an epic whose children live in the same repo continues to work identically to today. | Existing test suite stays green; one new test asserts same-repo behavior is preserved. | Test results. |

## Assumptions

- The manifest schema (`phases[].issues: owner/repo#n`, `phases[].repos: owner/repo`) is the source of truth and will not change as part of this fix.
- `gh` CLI is authenticated for every repo the cockpit needs to read from. Tokens that lack access to a cross-repo child produce an actionable per-issue error rather than silently dropping the issue.
- The companion tetrad-development data fix (correcting `repos: [generacy]` to `repos: [generacy-ai/generacy]` in `epic-cockpit.yaml`) lands separately and is not blocked by this work.
- The `gh search` quoting crash (#800) is already fixed and does not need to be re-addressed.
- Downstream callers of `resolveEpicIssues` outside the in-tree CLI are limited to documented uses; a breaking type change is acceptable with a package version bump.

## Out of Scope

- Discovery of epics whose manifest file is missing entirely (covered by the existing fallback, which is improved but not rebuilt).
- Changes to the manifest schema itself.
- Changes to how `cockpit.repos` is configured or loaded.
- The companion data fix to `epic-cockpit.yaml` in tetrad-development.
- Performance optimization of cross-repo `gh` calls (parallel fetching can be a follow-up if needed).
- UI changes to `status` / `watch` output beyond surfacing the repo qualifier where it is currently missing.

---

*Generated by speckit, enhanced from generacy-ai/generacy#801*
