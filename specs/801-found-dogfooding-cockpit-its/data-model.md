# Phase 1 Data Model: Cockpit cross-repo refs

**Feature**: #801 — Cross-repo epic children honored by `resolveEpicIssues`
**Date**: 2026-06-29

This is a behavioral fix, not a data-model expansion. The schema for manifests and config is unchanged. The only new type lives at the function boundary that returns resolved children.

## New Type: `IssueRef`

The repo-qualified shape returned by `resolveEpicIssues` and consumed by every downstream `gh` call.

```ts
/**
 * A repo-qualified reference to a GitHub issue or PR.
 * `repo` is the full `owner/repo` form (e.g. `"generacy-ai/generacy"`),
 * matching the value `gh` accepts via `--repo`.
 */
export interface IssueRef {
  repo: string;
  number: number;
}
```

**Validation rules**:
- `repo` must match the existing `OWNER_REPO_REGEX = /^[^/]+\/[^/]+$/` used by `EpicEntrySchema` and `CockpitConfigSchema`. Enforcement happens upstream — `resolveEpicIssues` itself trusts its inputs (manifest is already validated by Zod; fallback synthesizes `repo` from a vetted source).
- `number` is `> 0`.
- Equality and dedup is by tuple `(repo, number)`; ordering for output stability is lexicographic by `repo` then ascending by `number`.

**Where it appears in the public API** (`@generacy-ai/cockpit`):
- Returned by `resolveEpicIssues(...)`.
- Re-exported as a named type alongside `ResolveEpicIssuesOptions` from `packages/cockpit/src/index.ts`.

## Updated Type: `ResolveEpicIssuesOptions`

```ts
export interface ResolveEpicIssuesOptions {
  manifestRoot?: string;
  gh?: GhWrapper;
  cwd?: string;
  logger?: { warn: (msg: string) => void };
  /**
   * NEW. Repos to iterate in the no-manifest fallback. Caller is expected to
   * pass `CockpitConfig.repos`. The function unions this with the epic's own
   * repo and deduplicates.
   *
   * When omitted (library used outside the CLI), the function searches only
   * the epic's own repo AND emits a structured warning via `logger.warn`
   * naming the limitation (FR-005).
   */
  repos?: string[];
}
```

Other fields are unchanged.

## Updated Type: `Scope` (CLI internal, `packages/generacy/src/cli/commands/cockpit/shared/scoping.ts`)

The CLI's local `Scope` discriminated union changes its `issues` field shape only.

```ts
// Before
export type Scope =
  | { kind: 'epic'; owner: string; repo: string; ownerRepo: string; issues: number[] }
  | { kind: 'repos'; repos: string[] };

// After
import type { IssueRef } from '@generacy-ai/cockpit';

export type Scope =
  | { kind: 'epic'; owner: string; repo: string; ownerRepo: string; issues: IssueRef[] }
  | { kind: 'repos'; repos: string[] };
```

`owner`, `repo`, and `ownerRepo` remain on the `epic` branch to identify the epic itself (not its children). They no longer constrain the children's repos.

## Unchanged Schemas

- `EpicManifestSchema`, `PhaseEntrySchema`, `EpicEntrySchema` — already accept `owner/repo` and `owner/repo#n`; no migration needed.
- `CockpitConfigSchema` — `repos: string[]` of `owner/repo`, already correct.
- `IssueRawSchema` / `Issue` (`gh` wrapper) — unchanged; per-issue repo identity is carried by the new `IssueRef`, not by `Issue`.

## Relationships

```
EpicManifest.phases[].issues  ──parse──▶  IssueRef
                                              │
CockpitConfig.repos ──union──▶ fallback ──▶  IssueRef
                                              │
                                              ▼
                                         Scope.issues
                                              │
                                              ▼
                              status.ts / watch.ts iterate
                                              │
                                              ▼
                              gh.{listIssues,addLabels,…}(repo, n)
```

## Migration Notes

- No file-on-disk migration. Existing `.generacy/epics/*.yaml` already supply `phases[].issues` as `owner/repo#n` strings.
- Existing single-repo epics flow through the new code unchanged because every child's parsed `repo` equals the epic's `repo`.
- Existing tests that assert `number[]` shape are migrated to `IssueRef[]` in the same PR (FR-008).
