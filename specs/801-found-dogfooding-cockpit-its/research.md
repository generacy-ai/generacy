# Phase 0 Research: Cockpit `resolveEpicIssues` cross-repo support

**Feature**: #801 — Cross-repo epic children honored by `resolveEpicIssues`
**Date**: 2026-06-29

This phase pins the open architectural questions from `clarifications.md` to concrete implementation choices and rules out alternatives that surfaced during exploration.

## Decision Log

### D1. Return shape: `Array<{ repo: string; number: number }>`

**Decision**: `resolveEpicIssues` returns `Array<IssueRef>` where `IssueRef = { repo: string; number: number }` and `repo` is the full `owner/repo` form (not bare `repo`).

**Rationale** (Q1 = A):
- Maps 1:1 onto every downstream `gh` call: `gh issue view --repo owner/repo <n>`, `wrapper.addLabels(repo, n)`, `wrapper.getPullRequestCheckRuns(repo, n)`.
- Full `owner/repo` discipline is the exact thing whose absence triggered the bug (epic manifest used bare names, fell back, wrong issues returned).
- Typed object beats raw string parsing in every call-site (3 of 3 today: `status.ts`, `watch/poll-loop.ts`, `shared/scoping.ts`).

**Alternatives rejected**:
- `Array<string>` of `owner/repo#n` — forces every caller to re-parse on each iteration; manifest IO already uses strings, but at this boundary the typed shape wins.
- `Array<{ owner; repo; number }>` — splits a value that `gh` always wants joined; no caller benefits from the split.

### D2. Manifest-path resolution: `phases[].issues`-only

**Decision**: Manifest-path resolution stays driven by `phases[].issues`. `phases[].repos` remains informational.

**Rationale** (Q2 = A):
- `phases[].issues` is the explicit, authoritative child set.
- `phases[].repos` is human-readable documentation, derivable from `phases[].issues`.
- Unioning a repo-search (Q2-C) would pull in unlisted issues from the listed repos.
- Fallback-on-empty (Q2-B) would introduce a second source of truth that can disagree with `issues[]`.

**Alternatives rejected**: Q2-B, Q2-C.

### D3. Fallback scope: `cockpit.repos ∪ epic's own repo`, deduped

**Decision**: When no matching manifest exists, search every repo in `cockpit.repos`, unioned with the epic's own repo, deduplicated.

**Rationale** (Q3 = A):
- Defensive against under-configured cockpits that omitted the epic's home repo from `cockpit.repos`.
- In practice `cockpit.repos` already defaults to `MONITORED_REPOS` which includes the epic's home repo — so the union is a no-op safety net.
- `resolveEpicIssues` accepts a new optional `repos?: string[]` so the CLI can thread `cockpit.repos` through; when omitted (library used outside the CLI), the function falls back to `[epicOwnerRepo]` and logs a structured warning (FR-005).

**Alternatives rejected**: Q3-B (strict — risks zero hits when user forgot to list home repo), Q3-C (literal FR-005 wording — wins only when `cockpit.repos` is non-empty and home repo is missing; under-configured cockpits still get no help).

### D4. Per-repo query construction: both queries, fully-qualified epic ref

**Decision**: Per repo `R`, run **two** `gh search` queries:

- `repo:R is:issue label:epic-child <epicOwner/epicRepo>#<epicN>`
- `repo:R is:issue <epicOwner/epicRepo>#<epicN> in:body`

Results merged and deduped on `repo + number`.

**Rationale** (Q4 = A):
- Full epic ref (`owner/repo#N`) is the correctness fix: short-form `#N` would match unrelated `#N` references in other repos.
- Both queries maximize recall in this best-effort fallback. Today's behavior is "label-or-body" (union), and that property is preserved across repos.

**Alternatives rejected**:
- Q4-B (body-only) — drops the label signal that filed children carry; loses recall when authors add `epic-child` but omit a body ref.
- Q4-C (short form) — false positives across repos.

### D5. Semver bump: `0.1.0 → 0.2.0` (pre-1.0 minor)

**Decision**: Bump `@generacy-ai/cockpit` from `0.1.0` to `0.2.0` in the same PR that lands the change. All in-repo consumers are updated; no out-of-repo consumers exist.

**Rationale** (Q5 = A): Pre-1.0 convention permits breaking changes in a minor bump. FR-007 stays as written.

**Alternatives rejected**: B (major — overkill for a pre-1.0 lib with one in-repo consumer), C (patch — semantically misleading; this is a behavior + signature change).

## Implementation Patterns

### Pattern: Optional dependency injection on `resolveEpicIssues`

`ResolveEpicIssuesOptions` already takes `gh?: GhWrapper`, `cwd?: string`, `manifestRoot?: string`, `logger?`. The new fields fit the same shape:

```ts
interface ResolveEpicIssuesOptions {
  manifestRoot?: string;
  gh?: GhWrapper;
  cwd?: string;
  logger?: { warn: (msg: string) => void };
  repos?: string[];           // NEW — fallback scope (cockpit.repos)
}
```

Default behavior when `repos` is omitted: behave like today (search the epic's own repo only) but emit a structured warning (FR-005). This keeps the library usable outside the CLI and preserves the existing test fixtures.

### Pattern: Dedup key for fallback merge

Existing fallback merges by `Set<number>`. New behavior merges by `Set<string>` keyed on `${repo}#${number}` to keep cross-repo `#N` collisions distinct. Final output is sorted by `(repo, number)` for determinism (matches existing sort discipline at line `:75` and `:91`).

### Pattern: CLI threads `cockpit.repos` into `resolveScope`

`packages/generacy/src/cli/commands/cockpit/shared/scoping.ts` already loads `CockpitConfig`; threading `loaded.config.repos` into `resolveEpicIssues(…, { repos: loaded.config.repos, … })` is a one-line addition.

### Pattern: Consumer iteration change

`status.ts` currently builds one query per `scope.repos[]` and embeds `scope.issues` (numbers) as a token list. After the change, iterate `scope.issues` (now `IssueRef[]`) grouped by `repo` to keep the per-repo `gh search` batch optimization. `watch/poll-loop.ts:reposForScope` likewise derives repos from `scope.issues.map(r => r.repo)` (unique) for epic scope.

## Key Sources & References

- `packages/cockpit/src/manifest/scoping.ts` — current `resolveEpicIssues` (today's bug surface).
- `packages/cockpit/src/manifest/schema.ts` — `phases[].issues` already validated as `owner/repo#n`.
- `packages/cockpit/src/config/schema.ts` — `CockpitConfig.repos` already typed as `owner/repo`.
- `packages/generacy/src/cli/commands/cockpit/shared/scoping.ts` — `Scope` discriminated union and `resolveScope` (single consumer of the return type).
- `packages/generacy/src/cli/commands/cockpit/status.ts` and `watch.ts` — downstream consumers of `Scope.issues`.
- `packages/cockpit/src/__tests__/manifest-scoping.test.ts` — existing tests; will need shape migration + new cross-repo cases.
- Spec FR-001 through FR-008 — drive task generation.
- Clarifications Q1–Q5 — drive D1, D2, D3, D4, D5 respectively.
