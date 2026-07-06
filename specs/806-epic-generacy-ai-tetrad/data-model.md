# Data Model: Single-source epic discovery (G-S2)

All types live in `packages/cockpit/src/resolver/` and are pure — no I/O.

## `IssueRef`

Reused (already exported from `@generacy-ai/cockpit`).

```ts
export interface IssueRef {
  repo: string;   // 'owner/repo'
  number: number; // positive integer
}
```

**Equality/dedup**: tuple `(repo, number)`.
**Sort**: ascending `repo`, then ascending `number`.

## `ParsedPhase`

Represents one `### <phase>` heading and the refs beneath it.

```ts
export interface ParsedPhase {
  heading: string;   // full trimmed heading text after '### '
  token: string;     // FR-005 first-token key, lower-cased (e.g. 's2')
  refs: IssueRef[];  // in first-appearance order; deduped within the phase
}
```

**Validation**:

- `heading` is non-empty after trimming.
- `token` is derived by `heading.split(/[\s—\-:,.\/]/)[0].toLowerCase()`; non-empty.
- `refs` are deduped by `(repo, number)`; within-phase collisions collapse (Q2 A).

## `ParsedEpicBody`

Output of `parseEpicBody(body: string)` — pure function over the issue body text.

```ts
export interface ParsedEpicBody {
  phases: ParsedPhase[];   // in body order
  allRefs: IssueRef[];     // deduped union across phases, sorted
  warnings: string[];      // ref-shaped lines that couldn't be resolved (FR-003)
}
```

**Validation**:

- `phases.length > 0` — else the caller throws `LoudResolverError` (FR-006).
- At least one `ParsedPhase.refs.length > 0` — else `LoudResolverError`.
- `allRefs` is `phases.flatMap(p => p.refs)` de-duped and sorted.
- `warnings` is emitted to stderr by the caller; the parser stays pure (no side-effects).

## `ResolvedEpic`

Output of the top-level `resolveEpic()`.

```ts
export interface ResolvedEpic {
  epic: IssueRef;               // the epic itself (from the input --epic arg)
  parsed: ParsedEpicBody;       // the parsed body
  repos: string[];              // unique repo set from parsed.allRefs, sorted
  bodyHash: string;             // sha256 of the raw body; nice-to-have for logging
}
```

**Relationships**:

- `epic` — always resolved from the CLI `--epic owner/repo#N` argument via the existing `EPIC_REGEX`.
- `parsed.allRefs` may contain `epic` if the epic body self-references — the caller filters it out from watch/status result sets.
- `repos = uniq(parsed.allRefs.map(r => r.repo)).sort()`.

## `ResolveEpicOptions`

Input dependencies for `resolveEpic`.

```ts
export interface ResolveEpicOptions {
  epicRef: string;               // 'owner/repo#N'
  gh: GhWrapper;                 // existing seam
  logger?: { warn: (m: string) => void };  // stderr sink for FR-003 warnings
  now?: () => Date;              // testability seam
}
```

## `LoudResolverError`

Sentinel error for the CLI to translate to `process.exit(2)` with an FR-006-shaped message.

```ts
export class LoudResolverError extends Error {
  readonly code:
    | 'INVALID_EPIC_REF'
    | 'GH_FETCH_FAILED'
    | 'NO_PHASE_HEADINGS'
    | 'NO_REFS'
    | 'AMBIGUOUS_PHASE_TOKEN'
    | 'PHASE_NOT_FOUND';
  readonly details?: unknown;    // e.g. { candidateHeadings: string[] } for AMBIGUOUS_PHASE_TOKEN
}
```

**Contract**: every code carries an operator-facing message that names the expected body format ("### <phase>" headings + `- [ ] owner/repo#N` bullets). SC-003's regression test asserts one representative message for each code.

## Deleted types (from `packages/cockpit/src/index.ts` re-exports)

- `EpicManifestSchema`, `EpicManifest`, `EpicEntry`, `PhaseEntry`, `PhaseEntrySchema`, `EpicEntrySchema`
- `readManifest`, `writeManifest`
- `resolveEpicIssues`, `ResolveEpicIssuesOptions`
- `CockpitConfigSchema.repos` (field), `CockpitConfigSource`'s `'monitored-repos-env'` variant
