# Data Model: Case-insensitive gateKey/epicRef repo-scope filter (#1106)

This bugfix introduces **no new entities, types, or wire-format changes**. It
alters the comparison semantics of one existing predicate. The relevant existing
shapes are documented here for reference.

## Existing types (unchanged)

### `EpicScope` — `answers-file-source.ts:95-99`

```ts
interface EpicScope {
  owner: string;   // as captured from epicRef, raw casing
  repo: string;    // as captured from epicRef, raw casing
  number: number;
}
```

Built once in the constructor via `parseEpicRef(options.epicRef)`
(`:227`). `parseEpicRef` matches `^([^/]+)\/([^/]+)#(\d+)$` and returns the raw
captured owner/repo (no normalization).

### Parsed gate scope — `parseIssueRefFromGateKey` return, `:175-182`

```ts
{ owner: string; repo: string; number: number } | null
```

Parsed from the issue-ref portion of `gateKey`
(`<owner>/<repo>#<issue>:<gateType>:<generation>`, substring up to the first `:`).
Returns `null` for a non-issue target (filing / scope-drained tracking ref), in
which case the scope filter is skipped and the line is emitted.

## Comparison rule (the change)

The repo-scope filter predicate (`processLine`, `answers-file-source.ts:646-655`):

**Before**

```
drop  ⟺  gateScope != null
        ∧ ( gateScope.owner !== epicScope.owner
          ∨ gateScope.repo  !== epicScope.repo )
```

**After** (FR-001, FR-002, FR-005)

```
drop  ⟺  gateScope != null
        ∧ ( lower(gateScope.owner) !== lower(epicScope.owner)
          ∨ lower(gateScope.repo)  !== lower(epicScope.repo) )
```

where `lower(x) = x.toLowerCase()`.

### Invariants

- **Case-insensitive owner/repo** (GitHub semantics): two refs differing only in
  letter case denote the same repo → NOT dropped.
- **Issue number untouched** (FR-005): the `number` field participates in neither
  the before nor after predicate; it is only used for the log line and downstream
  `gateId` matching.
- **Foreign-repo disposition preserved** (FR-003): a `gateScope` whose folded
  owner or repo genuinely differs is still dropped and logged at `info` with the
  original observed casing (`scope=…`, `boundEpic=…`).
- **Null gate scope preserved**: non-issue targets still skip the filter and emit.
- **Producer-casing independence** (FR-006): the predicate result does not depend
  on which producer (epic-level / primary-repo / secondary-repo) wrote the casing.

## Validation rules (unchanged)

- `epicRef` must match `owner/repo#number` (`EPIC_REF_REGEX`, constructor guard).
- `gateKey` issue-ref must match `^([^/]+)\/([^/]+)#(\d+)$` to yield a scope;
  otherwise `null` → emit.
- Answer lines still pass JSON parse + `GateAnswerLineSchema` before reaching the
  filter.
