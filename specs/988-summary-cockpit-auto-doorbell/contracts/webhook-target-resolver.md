# Contract: `webhook-target-resolver.ts` (FR-003, FR-008)

**Module**: `packages/generacy/src/cli/commands/cockpit/doorbell/webhook-target-resolver.ts` — NEW.

## Public API

```ts
import type { GhWrapper } from '@generacy-ai/cockpit';

export interface ResolveWebhookTargetsInput {
  epicRef: string;
  gh: GhWrapper;
  logger?: { warn: (msg: string) => void };
}

export async function resolveWebhookTargets(
  input: ResolveWebhookTargetsInput,
): Promise<Array<{ owner: string; repo: string }>>;
```

## Behavior

1. Call `resolveEpic({ epicRef, gh, logger })` from `@generacy-ai/cockpit`.
2. On success (`ResolvedEpic`):
   - Start the output array with `[resolved.epic.repo]` (primary-first invariant per FR-008).
   - Append `resolved.repos.filter(r => r !== resolved.epic.repo)` (dedup, preserves the resolver's sorted order).
   - Split each `"owner/repo"` string on `/`. Each split MUST yield exactly two non-empty segments; malformed entries are **skipped** with a warn line: `cockpit doorbell: webhook-target: skipping malformed repo "<value>"`.
   - Return the resulting `Array<{owner, repo}>`.
3. On any thrown error (including `LoudResolverError` variants `INVALID_EPIC_REF`, `NO_REFS`, `GH_FETCH_FAILED`):
   - Log one warn line: `cockpit doorbell: webhook-target resolution failed: <message>`.
   - Return `[]`.

**Never throws.** All failure modes fold into `[]`.

## Invariants

- **Primary-first**: `output[0].repo === resolvedEpic.epic.repo.split('/')[1]` when the output is non-empty.
- **Dedup**: no two output entries have the same `(owner, repo)` pair.
- **Order-stable**: repeated calls with the same epic body produce the same array.

## Test scaffolding

Vitest specs in `__tests__/webhook-target-resolver.test.ts`. Four cases:

1. **T1 — single-repo epic**: stub a `GhWrapper` whose `getIssue` returns a body with one ref matching the epic repo; expect `[{ owner, repo }]` (length 1).
2. **T2 — multi-repo epic dedup + primary-first**: epic `acme/coord#5`, body contains refs from `acme/coord`, `acme/foo`, `acme/bar`; expect `[{ owner:'acme', repo:'coord' }, { owner:'acme', repo:'foo' }, { owner:'acme', repo:'bar' }]` (dedup, primary first).
3. **T3 — epic ref malformed**: `epicRef = 'not-a-ref'`; `resolveEpic` throws `INVALID_EPIC_REF`; expect `[]` + one warn.
4. **T4 — `resolveEpic` throws `NO_REFS`**: expect `[]` + one warn.

## Dependencies

- `@generacy-ai/cockpit` — `resolveEpic`, `GhWrapper`, `ResolvedEpic`, `LoudResolverError` (already exported).
- No other new imports.

## Non-goals

- Ref-set expansion beyond what `resolveEpic` returns (no sub-issue traversal beyond the parser's contract).
- Cross-org repo validation.
- Caching (`resolveEpic` is called once per doorbell startup; cost is one `gh api` roundtrip on an epic body that is typically <10 KB).
