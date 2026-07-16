# Data Model: #962 — content guard for `findClarificationComment`

This is a defect fix on a single function; there is no new persisted state, no new API shape, and no schema change. The "data model" here is the shape of the two module-scope constants added to `clarification-comment-finder.ts` and the (unchanged) `IssueComment` shape the guard reads.

## Module-scope constants (new)

Added to `packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts`.

### `STAGE_STATUS_REJECT_PREFIXES`

```ts
const STAGE_STATUS_REJECT_PREFIXES: readonly string[] = [
  '<!-- generacy-stage:planning',
  '<!-- generacy-stage:specification',
  '<!-- generacy-stage:implementation',
  '<!-- speckit-stage:planning',
  '<!-- speckit-stage:specification',
  '<!-- speckit-stage:implementation',
] as const;
```

**Semantics** (FR-002):
- Exactly six entries. Positive allow-list, not a wildcard. Adding a future stage marker (e.g., `<!-- generacy-stage:review`) requires editing this list explicitly.
- Prefix substring, case-sensitive ASCII.
- Match rule: column-0 line-anchored — `line.startsWith(prefix)` where `line` comes from `body.split('\n')`.
- Order within the array is not significant (the match returns `true` on any hit).
- **Duplication note:** these literals also appear in `packages/orchestrator/src/worker/types.ts`'s `STAGE_MARKERS` (three of them; the `speckit-stage:*` twins are archived-only and do not live in `STAGE_MARKERS`). Duplication is deliberate per Q1/B — see `research.md` §D2. The FR-006 regression test uses the exact literal `<!-- generacy-stage:planning -->` and will fail on drift.

**Validation rules:**
- Every entry starts with `<!-- generacy-stage:` or `<!-- speckit-stage:`.
- No entry ends with a `-->` closer — the guard matches on the prefix only, so the constants stop at the discriminator suffix (`:planning`, `:specification`, `:implementation`). This means the guard correctly matches both self-closing single-line comments (`<!-- generacy-stage:planning -->`) and multi-line comments (`<!-- generacy-stage:planning\n  status=... -->`).
- No entry is a prefix of another entry in the same list (verifiable by inspection).

### `CLARIFICATION_STAGE_OVERRIDE_PREFIXES`

```ts
const CLARIFICATION_STAGE_OVERRIDE_PREFIXES: readonly string[] = [
  '<!-- generacy-stage:clarification',
  '<!-- generacy-stage:clarification-batch-',
] as const;
```

**Semantics** (FR-003):
- Exactly two entries. First entry is a substring prefix of the second (both are hit by any `clarification-batch-N` body); the two-entry form is deliberate documentation (see `research.md` §D6).
- Same column-0 line-anchored rule as `STAGE_STATUS_REJECT_PREFIXES`.
- If any override entry matches, the candidate is ACCEPTED regardless of any reject entry present in the same body ("override-wins" — Q1/B).

**Validation rules:**
- Every entry starts with `<!-- generacy-stage:clarification`.
- No entry overlaps with any `STAGE_STATUS_REJECT_PREFIXES` entry — the discriminator suffix differs (`clarification*` vs. `planning`/`specification`/`implementation`), so `body.startsWith(rejectPrefix)` and `body.startsWith(overridePrefix)` cannot both be true for the same `line` (structurally impossible; also asserted by test).

## Private helper (new)

Added to `packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts`.

### `isStageStatusComment(body: string): boolean`

```ts
function isStageStatusComment(body: string): boolean {
  const lines = body.split('\n');
  // Override-first: presence of a clarification-stage marker vetoes any reject.
  for (const line of lines) {
    for (const prefix of CLARIFICATION_STAGE_OVERRIDE_PREFIXES) {
      if (line.startsWith(prefix)) return false;
    }
  }
  for (const line of lines) {
    for (const prefix of STAGE_STATUS_REJECT_PREFIXES) {
      if (line.startsWith(prefix)) return true;
    }
  }
  return false;
}
```

**Contract:**
- `true` iff the body carries at least one `STAGE_STATUS_REJECT_PREFIXES` entry at column 0 AND NO `CLARIFICATION_STAGE_OVERRIDE_PREFIXES` entry at column 0.
- Pure function. No I/O, no allocation beyond the `split`.
- Complexity: O(L × 8) where L is body-line count. Small comment bodies mean this is trivially fast; not on any hot path.
- Not exported. The finder is the only caller.

## Unchanged type: `IssueComment`

`@generacy-ai/cockpit` re-exports `IssueComment`; the finder reads `.body`, `.createdAt`, `.url`, `.author`. Shape (verbatim, unmodified):

```ts
interface IssueComment {
  body: string;
  author: string;
  createdAt: string;   // ISO 8601
  url: string;
}
```

No fields added, no fields removed. The guard consumes `body` only. `author` is deliberately NOT consulted (Q2/A — see `research.md` §D3).

## Unchanged function signature

`findClarificationComment` retains its current signature:

```ts
export async function findClarificationComment(
  gh: GhWrapper,
  repo: string,
  number: number,
): Promise<IssueComment | null>;
```

**Behavioural change** (spec §User Stories AC-2):
- **Before:** returns any at-or-after `IssueComment` regardless of body content.
- **After:** returns the earliest at-or-after `IssueComment` for which `isStageStatusComment(c.body) === false`, or `null` if every at-or-after candidate is rejected.

**Return-shape invariants preserved:**
- `null` is still the distinguishable-absent sentinel. Callers that treated `null` as "no clarification present" continue to work unchanged.
- Non-null returns are strictly a subset of what today's implementation would return. No caller starts receiving comments it did not receive before.

## Relationships

None. This is a single function's internal behaviour hardening; no cross-entity relationships change.

## Migration / compatibility

- **No runtime data migration.** No stored state; the guard operates on live GitHub timeline + comments.
- **No API caller migration.** Consumers of `findClarificationComment` (`cockpit_context` MCP tool + adjacent verbs) receive the same `Promise<IssueComment | null>` shape.
- **No prompt / skill migration.** The engine's clarification-post path is untouched; the cockpit-verb read path narrows only for stage-status false-positives.
