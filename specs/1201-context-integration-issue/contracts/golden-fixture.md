# Contract: Golden subscription-baseline fixture

**File**: `packages/orchestrator/src/launcher/__tests__/fixtures/subscription-baseline.json`
**Consumer**: `golden-subscription-spawns.test.ts` (FR-004/FR-005, SC-002)
**Provenance**: captured once from the pre-P1 merge-base commit (Q1=C); SHA recorded in
`fixtures/README.md`.

## Shape

```jsonc
{
  "capturedAt": "string (ISO 8601, informational — excluded from comparison)",
  "sourceSha": "string (40-hex, informational — excluded from comparison)",
  "spawns": {
    "<kind>": {
      "command": "string",
      "args": ["string", "..."],
      "env": { "KEY": "value" }   // keys sorted lexicographically
    }
  }
}
```

`<kind>` ∈ exactly `{ phase, pr-feedback, merge-conflict, review, remediate,
conversation-turn }`. No more, no fewer. `invoke` is deliberately excluded (spec
enumerates six).

## Invariants

1. **Byte identity per kind** (FR-005): with no gateway configured, a fully Anthropic
   config, and the fixed determinism inputs (Q2=A), the actual spawn triple serialized via
   sorted-key `stableStringify` MUST equal the fixture entry byte-for-byte.
2. **No `CLAUDE_CONFIG_DIR` anywhere** in any fixture `env` map — the fixture is the
   subscription baseline; presence of the key in the fixture would indicate a capture
   error.
3. **Sorted env keys**: env maps are serialized with lexicographically sorted keys, both
   at capture and at comparison. Insertion order never affects bytes.
4. **`capturedAt`/`sourceSha` are metadata only** — the comparison covers `spawns.*`.

## Regeneration protocol

Regeneration is legitimate only when a spawn *intentionally* changes (new arg, env var,
reorder). Procedure:

1. `GOLDEN_UPDATE=1 pnpm --filter @generacy-ai/orchestrator vitest run golden`
2. Commit the updated fixture in the same PR as the behavior change.
3. The PR description MUST include a justification naming the intentional change; the
   diff of the fixture is the review surface.

A fixture-only diff with no corresponding launch-path change is a red flag — reject in
review.
