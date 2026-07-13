# Contract: Engine Resolver

Package: `@generacy-ai/cockpit` (`packages/cockpit/src/resolver/`).

## `parseEpicBody(body: string): ParsedEpicBody`

**Purity**: no I/O, no `process.stderr` writes.

### Grammar

- **Heading line**: `^### \s*(?<heading>.+?)\s*$`
  - Only level-3 (`### `). `## ` and `#### ` are not phase headings.
- **Task-list item**: `^\s*-\s*\[[ xX]\]\s+(?<ref>.+?)\s*$`
  - The `[ ]` / `[x]` marker is required.
  - `<ref>` must match one of the ref shapes below (see `ref-shapes.ts`).
- Any other line: skipped.

### Ref shapes (all normalize to `IssueRef`)

1. Bare: `owner/repo#N` where `owner`, `repo` match `[A-Za-z0-9._-]+`.
2. Markdown-linked bare: `[owner/repo#N](anything)`.
3. Markdown-linked hash-N: `[#N](https://github.com/owner/repo/(issues|pull)/N)`.
4. Plain URL: `https://github.com/owner/repo/(issues|pull)/N`.

**Rejected shapes** (produce a `warnings[]` entry, not a throw):

- Bare `#N` shorthand.
- Non-integer or non-positive `N`.
- URL with a fragment/query that doesn't parse to `owner/repo/(issues|pull)/N`.

### Dedup and order

- Within a phase, duplicate refs collapse to first occurrence.
- Across phases, `allRefs` collapses duplicates globally (Q2 A) and is sorted by `(repo, number)`.

### Return

```ts
{
  phases: ParsedPhase[],   // body order
  allRefs: IssueRef[],     // deduped, sorted
  warnings: string[],      // e.g. "ignored ref-shaped line 42: '#8' (bare shorthand)"
}
```

### Preconditions the caller enforces (not the parser)

The parser is total — it never throws. `resolveEpic` (below) is where fail-loud lives.

## `resolveEpic(options: ResolveEpicOptions): Promise<ResolvedEpic>`

**Impurity**: one `gh` call via the injected `GhWrapper`.

### Steps

1. Parse `epicRef` via `EPIC_REGEX = /^([^/]+)\/([^/]+)#(\d+)$/`.
   - Fail → `LoudResolverError('INVALID_EPIC_REF')`.
2. Fetch the epic body via `gh.getIssue(repo, number)` (single JSON field: `body`).
   - Non-200 / not-found → `LoudResolverError('GH_FETCH_FAILED', { cause })`.
3. Call `parseEpicBody(body)`.
4. Emit each `warnings[]` entry via `options.logger?.warn`.
5. Enforce loud conditions:
   - `phases.length === 0` → `LoudResolverError('NO_PHASE_HEADINGS')`.
   - `allRefs.length === 0` → `LoudResolverError('NO_REFS')`.
6. Return `{ epic, parsed, repos, bodyHash }`.

### Error message shape (FR-006, SC-003)

Every `LoudResolverError` message includes:

- The code name.
- A human sentence naming what went wrong.
- The expected format: "epic body must contain `### <phase>` headings with `- [ ] owner/repo#N` task-list items".

Example:

```
Error: cockpit: epic body has no '### <phase>' headings.
Expected format: '### <phase>' headings with '- [ ] owner/repo#N' task-list items.
```

## `matchPhaseHeading(parsed: ParsedEpicBody, phaseArg: string): ParsedPhase | LoudResolverError`

Used by `queue`.

### Match rule (FR-005)

- Normalize both sides: `phaseArg.trim().toLowerCase()`.
- Compare against `ParsedPhase.token` (already lower-cased first-token).
- 0 matches → `LoudResolverError('PHASE_NOT_FOUND', { candidateHeadings })` where `candidateHeadings` is every phase heading.
- 1 match → return the phase.
- >1 matches → `LoudResolverError('AMBIGUOUS_PHASE_TOKEN', { candidateHeadings })`.

## Backwards compatibility

None retained. The following exports are removed from `@generacy-ai/cockpit`:

- `EpicManifestSchema`, `EpicManifest`, `EpicEntry`, `PhaseEntry`, `PhaseEntrySchema`, `EpicEntrySchema`
- `readManifest`, `writeManifest`
- `resolveEpicIssues`, `ResolveEpicIssuesOptions`

Consumers importing them will get a compile-time error, which is the desired signal (SC-005).
