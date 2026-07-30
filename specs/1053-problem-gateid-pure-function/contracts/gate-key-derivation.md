# Contract: `deriveGateKey` — extended signature (this PR)

**Feature**: #1053
**Component**: `packages/cockpit/src/gates/schema.ts` (canonical), `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts` (mirror)
**Consumers**: `cockpit_gate_open` (`packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_open.ts`), test suites, doc mirrors.

## Signature

```ts
export function deriveGateKey(
  issueRef: string,
  gateType: GateType,
  generation: string | number,
  runId?: string,
): string;
```

## Behavioural contract

### When `runId === undefined`

Output MUST equal `${issueRef}:${gateType}:${String(generation)}`. Existing behaviour, byte-for-byte.

**Test vector** (regression guard — matches spec §Field instance):

```
input:   deriveGateKey('christrudelpw/snappoll#1', 'phase-queue', 'P2')
output:  'christrudelpw/snappoll#1:phase-queue:P2'
sha256:  075855bf0c3fef1b7f52ed3a...
```

### When `runId` is a non-empty string

Output MUST equal `${issueRef}:${gateType}:${String(generation)}:${runId}`. No transformation on `runId` (no case-fold, no trim, no encoding).

**Test vector**:

```
input:   deriveGateKey('christrudelpw/snappoll#1', 'phase-queue', 'P2', 'christrudelpw-snappoll-1-20260727-200458')
output:  'christrudelpw/snappoll#1:phase-queue:P2:christrudelpw-snappoll-1-20260727-200458'
sha256:  <MUST NOT equal 075855bf0c3fef1b7f52ed3a>
```

### When `runId === ''` (empty string)

This function DOES NOT validate `runId`. An empty string composes to `${base}:` (trailing colon). Validation belongs at the MCP boundary; see `contracts/mcp-tool-input.md`.

Callers that want empty-treated-as-missing MUST pass `undefined` explicitly, not `''`.

## Determinism

- Pure function of its inputs. No I/O, no `Date.now()`, no `crypto.randomBytes()`, no module-level mutable state.
- Idempotent: same inputs → same output, always.

## `deriveGateId` — unchanged

```ts
export function deriveGateId(gateKey: string): string {
  return createHash('sha256').update(gateKey, 'utf8').digest('hex').slice(0, 24);
}
```

- Output: 24 lowercase hex chars (12 bytes of sha256 prefix).
- FR-009: hash function, output length, encoding all stable.
- All existing `GateOpenWireSchema.gateId.length(24)` assertions continue to hold.

## Colon-safety of `runId`

The `gateKey` format is a joined-by-colon string. `runId` MAY contain colons (the current auto-run id shape `christrudelpw-snappoll-1-20260727-200458` does not, but takeover id shapes may). `deriveGateKey` treats the entire `${base}:${runId}` as an opaque hash input, so ambiguity is irrelevant — `deriveGateId(A)` and `deriveGateId(B)` collide iff `A === B` at the byte level. Callers do NOT need to escape colons in `runId`.

## Documentation mirror updates

- `tetrad-development/docs/cockpit-remote-gates-plan.md § Wire contracts` — update the `gateKey` shape example to `${issueRef}:${gateType}:${generation}:${runId}` (with a note that `:${runId}` is appended only when a run discriminator is available).
- `generacy-cloud/specs/843-part-cockpit-remote-gates/contracts/gates-wire.md` — same update. Cloud does not need to change parsing; the doc is descriptive.
- Neither doc update ships in this repo; they are companion PRs.
