# Research: cockpit status renders phase grouping for epic children

**Issue**: [#828](https://github.com/generacy-ai/generacy/issues/828)
**Branch**: `828-found-during-cockpit-v1`

## Technology Decisions

### D1: Consume `parsed.phases`, not just `parsed.allRefs`

**Decision**: `status.ts` iterates `resolved.parsed.phases` to build row groups; `allRefs` is used only to build the batched `gh issue list` query and to seed the "no phase" trailing group.

**Rationale**: The parser already emits per-phase `refs` in body order and does the (repo, number) dedupe globally in `allRefs`. Consuming `phases` gives us free (a) body ordering per phase, (b) per-heading membership for cross-phase duplicates, and (c) label-vs-token metadata for the header.

**Alternatives considered**:
- Re-parse the epic body inside `status.ts`. Rejected: violates FR-007 (no scope creep), duplicates parser logic already tested in `parse-epic-body.test.ts`.
- Introduce a new helper `phaseMembership(parsed): Map<key, string[]>` in `@generacy-ai/cockpit`. Rejected: premature abstraction — only one consumer today. Inline the Map in `status.ts`.

### D2: Header format — full heading with token fallback (Q1 = B)

**Decision**: `— <heading> —` when `heading !== token`, `— <TOKEN-UPPER> —` when equal.

**Rationale**: Locked in clarification Q1. Mirrors the epic body's `### <phase>` structure exactly, which is the whole point of grouping. Fallback covers label-less phases (`### P1` with no `— Foundation`) without emitting `— p1 —` (lowercased token would look like a bug).

**Alternatives**: token-only (rejected, drops information); full heading unconditional (rejected, ambiguous fallback for label-less phases).

### D3: Row order = body order in both surfaces (Q2 = A)

**Decision**: Within a phase, rows appear in `ParsedPhase.refs` order — same in table and `--json`.

**Rationale**: Locked in clarification Q2. The epic body IS the queue-round manifest; sorting by `(repo, number)` scrambles the developer's intended order. One order across both surfaces avoids a table/JSON split (Q2 option C).

### D4: Cross-phase duplicate → per-membership rows (Q3 = A)

**Decision**: Ref under N phases → N table rows (one per group) AND N JSON rows (each with `phase` as a single-string token).

**Rationale**: Locked in clarification Q3. Mirrors `queue <phase>` semantics from #806 Q2: membership is per-heading, and `queue p2` will enqueue the ref if it appears under `### P2` at all. Showing it only under its first phase would misrepresent what queueing will do.

**Implementation implication**: `rows.length >= allRefs.length`. Distinct-issue count is `allRefs.length`; JSON contract explicitly documents this (see `contracts/status-envelope.json`).

**Alternatives**: single-string `phase` from first membership (rejected, hides real membership); array `phases: string[]` (rejected, larger schema change; harder to filter in `jq`).

### D5: `— (no phase) —` header used everywhere (Q4 = B)

**Decision**: Both the trailing implicit group (FR-004) AND the phase-less epic fallback (FR-008) use the header `— (no phase) —`.

**Rationale**: Locked in clarification Q4. One label with one meaning. The `epic <owner/repo>#N` line above the table keeps the epic ref visible either way, so we don't lose the epic identity by removing it from the group header. It also quietly nudges toward the documented `### <phase>` format.

**Alternatives**: preserve today's `epic <owner/repo>#N` header (rejected, two different phrasings for one concept); hybrid label (rejected, cluttered).

## Implementation Patterns

### P1: Row emission — one row per (issue × phase) membership

The current loop does `for repo in batches → for issue in issues → rows.push(row)`. New shape:

```
membershipByKey = new Map<string, string[]>();
for phase in parsed.phases:
  for ref in phase.refs:
    key = `${ref.repo}#${ref.number}`
    memberships = membershipByKey.get(key) ?? []
    memberships.push(phase.token)
    membershipByKey.set(key, memberships)

for repo, query in repoBatches:
  issues = listAllIssues(gh, query)
  for issue in issues:
    key = `${repo}#${issue.number}`
    phases = membershipByKey.get(key) ?? [null]  // ← [null] for "no phase" case
    for phaseToken of phases:
      rows.push(buildStatusRow(..., phaseToken))
```

The `[null]` sentinel treats the "no phase" case symmetrically — every issue emits at least one row.

### P2: Grouping — bucket then iterate `parsed.phases`

```
groupRows(rows, phases, epicOwnerRepo):
  buckets = new Map<string | null, StatusRow[]>();
  for row of rows:
    (buckets.get(row.phase) ?? buckets.set(row.phase, []).get(row.phase)!).push(row)

  groups: RowGroup[] = []
  for phase of phases:
    bucket = buckets.get(phase.token) ?? []
    // sort bucket by ParsedPhase.refs order:
    order = new Map(phase.refs.map((ref, i) => [`${ref.repo}#${ref.number}`, i]))
    bucket.sort((a, b) => (order.get(key(a)) ?? 0) - (order.get(key(b)) ?? 0))
    groups.push({ header: fmtHeader(phase), rows: bucket })

  none = buckets.get(null) ?? []
  if none.length > 0 || phases.length === 0:
    groups.push({ header: '— (no phase) —', rows: none })

  return groups
```

The `(none.length > 0 || phases.length === 0)` predicate collapses FR-004 and FR-008 into a single branch.

### P3: JSON envelope — free extension

`StatusEnvelope.rows: StatusRow[]` is already the payload. Adding `phase` to `StatusRow` means the JSON output automatically carries it — no envelope schema change. Consumers that don't read `phase` are unaffected (FR-005 backward-compat clause).

Row order in the JSON envelope is guaranteed by construction order: `status.ts` emits rows in outer-loop-by-phase order because we iterate `parsed.phases` first. But: `status.ts`'s repo-batching loop groups by repo, not by phase. So we need to sort/regroup rows in JSON emission order (phase body order, then `ParsedPhase.refs` order, then `phase: null` last).

Two options:
- **A**: Call `groupRows()` on the JSON path too, then flatten in group order. Cleanest — one source of truth for order.
- **B**: Build a separate ordering pass in `render-table.ts`. Duplicates the ordering logic.

Choose **A**: the JSON path becomes `renderJsonEnvelope({...}, groupRows(rows, phases, ...).flatMap(g => g.rows))`. Zero new logic.

### P4: Header rendering — `heading === token` fallback check

`ParsedPhase.token` is lowercased (`firstToken` in `heading-match.ts`). `ParsedPhase.heading` is the trimmed raw heading text. Comparison: `heading.toLowerCase() === token` — because a label-less phase like `### P1` has heading `'P1'` and token `'p1'`. Uppercase the token for the fallback header: `— ${token.toUpperCase()} —`.

## Key Sources / References

- Spec: `specs/828-found-during-cockpit-v1/spec.md`
- Clarifications: `specs/828-found-during-cockpit-v1/clarifications.md`
- Parser: `packages/cockpit/src/resolver/parse-epic-body.ts`
- Types: `packages/cockpit/src/resolver/types.ts:11-27`
- Current status impl: `packages/generacy/src/cli/commands/cockpit/status.ts:74`
- Current grouping: `packages/generacy/src/cli/commands/cockpit/status/group.ts:12`
- Related decision: `#806` Q2 — per-heading `queue <phase>` membership semantics.
- Catalog: `docs/epic-cockpit-plan.md` in `tetrad-development` (Command catalog, `status` row).
- Repro: `christrudelpw/sniplink#1`.
