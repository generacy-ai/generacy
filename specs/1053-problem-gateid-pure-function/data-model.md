# Data Model: Gate IDs must not collide across runs

**Feature**: #1053 — per-run discriminator on `gateKey`
**Branch**: `1053-problem-gateid-pure-function`

## Overview

Two additive schema/type changes; two new in-process caches. No wire-schema field additions or removals; no new persistence surface.

## E-1: `deriveGateKey` signature — extended (this PR)

**Before** (canonical: `packages/cockpit/src/gates/schema.ts:116-122`; mirror: `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts:67-73`):

```ts
export function deriveGateKey(
  issueRef: string,
  gateType: GateType,
  generation: string | number,
): string {
  return `${issueRef}:${gateType}:${String(generation)}`;
}
```

**After**:

```ts
export function deriveGateKey(
  issueRef: string,
  gateType: GateType,
  generation: string | number,
  runId?: string,
): string {
  const base = `${issueRef}:${gateType}:${String(generation)}`;
  return runId === undefined ? base : `${base}:${runId}`;
}
```

**Type surface**:

- Optional fourth parameter — additive, backwards-compatible for existing callers that pass three arguments.
- When `runId === undefined`: output matches the pre-fix format exactly (`${issueRef}:${gateType}:${generation}`). Existing test vectors continue to pass.
- When `runId` is a non-empty string: output is `${issueRef}:${gateType}:${generation}:${runId}`. Colons inside `runId` are permitted and unambiguous — the cloud treats `gateKey` as an opaque hashed string, does not parse it.

**Validation rules**:

- `runId` is not validated at the derivation layer (the derivation is a pure `string` composition). Validation belongs at the MCP boundary — see E-2.
- No transformation on `runId` — no case-folding, no trimming, no encoding. Callers pass the exact string they want appended.

**`deriveGateId` unchanged** (FR-009):

```ts
export function deriveGateId(gateKey: string): string {
  return createHash('sha256').update(gateKey, 'utf8').digest('hex').slice(0, 24);
}
```

The output remains a 24-character lowercase hex prefix of a sha256 digest. All existing `GateOpenWireSchema.gateId.length(24)` assertions continue to hold.

## E-2: `GateOpenInputSchema` / `GateAckInputSchema` — extended (this PR)

**Location**: `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts` (input schemas re-exported through `packages/generacy/src/cli/commands/cockpit/mcp/schemas.ts` as `CockpitGateOpenInputSchema` / `CockpitGateAckInputSchema`).

**Both schemas use `.strict()`** — unknown fields are rejected at the MCP boundary. Adding `runId` as an optional field is the minimal change that keeps auto-loop-shaped callers accepted on both tools.

**Additions**:

```ts
// On GateOpenInputSchema:
runId: z.string().min(1).optional(),

// On GateAckInputSchema:
runId: z.string().min(1).optional(),
```

**Validation rules**:

- `runId` is a non-empty string when present. Empty strings are rejected as `invalid-args` at the boundary (`z.string().min(1)`).
- No format constraint beyond non-empty. Shape is opaque to the tool — the tool composes it into `gateKey` without inspection.
- No default. When absent, the tool's fallback logic runs (see E-3); Zod does not pre-fill it (`.optional()`, not `.default(...)`).

**Semantics**:

- **On `GateOpenInputSchema`**: threaded into `deriveGateKey(s.issueRef, s.gateType, s.generation, effectiveRunId)`. `effectiveRunId` is `s.runId ?? mintFallback()`.
- **On `GateAckInputSchema`**: accepted but ignored. The ack path targets an existing `gateId` (already computed elsewhere) — no derivation happens in `cockpit_gate_ack`. The field is accepted only to keep the auto-loop's envelope shape acceptable on both tools; adding it here costs one line and buys envelope symmetry.

**Backwards compatibility**:

- Callers omitting `runId` see identical behaviour on `GateAckInputSchema` (schema still accepts, tool still targets `gateId`).
- Callers omitting `runId` on `GateOpenInputSchema` invoke the fallback path (E-3) — the resulting `gateId` is stable across retries within an MCP-server process but differs from the pre-fix output because the fallback appends a suffix. **This is a behaviour change for non-auto callers** — flagged in the changeset as the minor bump rationale on `@generacy-ai/generacy`.

## E-3: Fallback `runId` mint

**Location**: `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.ts`.

**Source**: Module-level `INSTANCE_NONCE` from `../event-bus.js` (`packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts:72`). Shape: 16 lowercase hex chars from `crypto.randomBytes(8).toString('hex')`, initialized once at module load, immutable for the process lifetime.

**Composition**:

```ts
const effectiveRunId = s.runId ?? INSTANCE_NONCE;
const runIdSource: 'explicit' | 'fallback-instance-nonce' =
  s.runId !== undefined ? 'explicit' : 'fallback-instance-nonce';
```

**Log line** (once per `cockpit_gate_open` call, `info` level):

```ts
logger.info({
  event: 'cockpit_gate_open.runid-source',
  runIdSource,
  gateId,             // the DERIVED id, useful for correlation
  gateType: s.gateType,
  issueRef: s.issueRef,
}, `gate-open runId source: ${runIdSource}`);
```

`gateId` is logged (24 hex chars, opaque). `runId` itself is not logged for privacy (auto-run ids embed cluster/repo/issue/timestamp, which is not secret but is unnecessary noise).

## E-4: Per-`gateId` `askedAt` cache

**Location**: `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.ts` — module-level.

**Shape**:

```ts
const askedAtCache: Map<string, string> = new Map();

function getOrMintAskedAt(gateId: string, provided?: string): string {
  const cached = askedAtCache.get(gateId);
  if (cached !== undefined) return cached;
  const value = provided ?? new Date().toISOString();
  askedAtCache.set(gateId, value);
  return value;
}
```

**Semantics**:

- Keyed by the DERIVED `gateId` (which already encodes `runId` via `gateKey`). Different runs → different `gateId`s → different cache slots — no cross-run leakage.
- When `s.askedAt` is provided by the caller, it is honoured on the FIRST call for a given `gateId` and cached; subsequent calls for the same `gateId` return the cached value even if the caller passes a different `askedAt`. This preserves within-run idempotency deterministically — retried frames are byte-identical.
- No eviction, no TTL, no LRU cap. Memory footprint is O(natural gates in this MCP-server's lifetime) ≈ 10s to low 100s of entries. Bounded by process lifetime.
- Not thread-safe (Node.js single-threaded execution model). No mutex needed.

**Rationale for unbounded**: An LRU eviction would re-open the exact bug Q4-A closes — a late retry after eviction would get a fresh `askedAt`, cease to be byte-identical, and US2 correctness would depend on cloud dedup. See plan D-2.

## E-5: `GateOpenWireSchema` / `GateOutcomeWireSchema` — unchanged (this PR)

**Location**: `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts:115-133` and canonical `packages/cockpit/src/gates/schema.ts:53-84`.

**Explicitly no changes**:

- No new field for `runId` (Q3 → A: fold into `gateKey` pre-image only).
- No changed field names.
- No changed field types.
- `gateKey: z.string().min(1)` — the string content is longer post-fix, but the type is unchanged and any non-empty string is valid.
- `gateId: z.string().length(24)` — the input to sha256 is longer, but the 24-char hex prefix output shape is stable.
- `askedAt: z.string().datetime()` — content will be identical across within-run retries (per E-4), but the type and constraint are unchanged.

**Cloud parser (`services/api/src/services/relay/message-handler.ts` `gateOpenPayloadSchema`)** needs no update. It hashes what the cluster sends and stores the `gateKey` verbatim on the doc; the longer suffix is transparent to it.

## E-6: `ErrorClass` — extended (follow-up PR only, not this PR)

**Location**: `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts:22-35`.

**Before**:

```ts
export type ErrorClass =
  | 'invalid-args'
  | 'wrong-kind'
  | 'unknown-gate'
  | 'not-an-epic'
  | 'gate-refusal'
  | 'transport'
  | 'query-unreachable'
  | 'invalid-cursor'
  | 'not-worker'
  | 'contended'
  | 'claim-conflict'
  | 'scope-not-found'
  | 'internal';
```

**After (follow-up PR, gated on generacy-cloud#887)**:

```ts
export type ErrorClass =
  | 'invalid-args'
  | 'wrong-kind'
  | 'unknown-gate'
  | 'not-an-epic'
  | 'gate-refusal'
  | 'transport'
  | 'query-unreachable'
  | 'invalid-cursor'
  | 'not-worker'
  | 'contended'
  | 'claim-conflict'
  | 'terminal-collision'    // NEW — follow-up PR (FR-005)
  | 'scope-not-found'
  | 'internal';
```

**Cross-repo cost**: adding this union value will break exhaustive `switch (result.class)` statements in #1015, #1020, and #1024 consumers. The compiler catches it — treated as a coordination cost, not a reason to switch to Q5-B's stringly-typed code-in-detail pattern.

Not part of this PR. Captured here as a forward reference so the FR-005 follow-up PR reviewer can validate the shape without re-deriving it.

## Relationships

```
GateOpenInputSchema.runId (optional)
    │
    │  ── if undefined ──▶  INSTANCE_NONCE   ─────┐
    │                                             │
    ▼                                             ▼
        effectiveRunId  ──▶  deriveGateKey(issueRef, gateType, generation, effectiveRunId)
                                                  │
                                                  ▼
                                          deriveGateId(gateKey) ──▶  24-hex gateId
                                                                          │
                                                                          ▼
                                                          askedAtCache: Map<gateId, iso>
                                                                          │
                                                                          ▼
                                                          GateOpenWire { gateId, gateKey, askedAt, ...s }
```

- `runId` is consumed by `deriveGateKey`; not on the wire (E-5).
- `gateId` is the join key for the `askedAt` cache (E-4).
- The wire record's `gateKey` field contains the runId suffix (transparent to the cloud parser).

## Validation-error mapping

- Missing required field (any of `issueRef`, `gateType`, `generation`, `epicRef`, `issueTitle`, `issueUrl`, `title`, `body`, `sessionId`) → `invalid-args`. Unchanged.
- Empty `runId` (`""`) → `invalid-args` at Zod validation. New.
- Non-string `runId` (e.g. `123` passed as number) → `invalid-args`. New.
- `runId` present but too long (no upper bound in schema) → accepted; the resulting `gateKey` is longer but the derivation and wire types tolerate arbitrary lengths.
