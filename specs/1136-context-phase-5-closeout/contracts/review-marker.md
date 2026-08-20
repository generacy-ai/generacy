# Contract: Engine-authored review marker (documented shape)

**Source of truth**: `packages/orchestrator/src/worker/review-poster.ts` (#1125). Verified on this branch: `REVIEW_BODY_MARKER_PREFIX = 'generacy-engine-review'` and the inline `<!-- generacy-finding:` marker. Docs mirror this; shipped code wins on divergence (FR-008).

## Markers

| Location | Format | Prefix / key |
|----------|--------|--------------|
| Review body | `<!-- generacy-engine-review round=<N> -->` | `generacy-engine-review` |
| Per-finding inline comment | `<!-- generacy-finding:<marker> -->` | `generacy-finding:` |

`<N>` is the review round; `<marker>` is the per-finding identifier.

## Semantics to document

- Engine review submissions are posted as **COMMENT**-event reviews carrying the body marker so downstream tooling and the PR-feedback monitor can recognize and **exclude** engine-authored reviews — this prevents the engine from racing its own review⇄remediate loop.
- The **contract-name key** the generacy-cloud mirror matches on is the marker string itself: `generacy-engine-review` (body) / `generacy-finding:` (inline). Document these verbatim so the mirror can grep for them.

## Documentation style (Q4→C)

Inline the two marker formats in `reference/review-artifacts.md` AND link to `review-poster.ts` as authoritative. Call out the contract-name key explicitly for the generacy-cloud mirror.
