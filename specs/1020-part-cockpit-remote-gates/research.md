# Research: Cockpit Remote Gates — Wire Contracts

**Feature**: `1020-part-cockpit-remote-gates`
**Purpose**: Record the technology + design decisions that inform the schemas + helpers, so downstream contributors and the generacy-cloud mirror can trace *why* the wire format looks the way it does. Every open question in the spec is either answered here or already answered in `clarifications.md` (Q1–Q5).

## 1. Validation library: Zod (locked in)

**Decision**: Use `zod` ^3.23.
**Rationale**:
- Already a direct dependency of `@generacy-ai/cockpit` (see `packages/cockpit/package.json:28`) — no new dep added.
- Every other schema in the package (`CockpitConfigSchema`, `WorkspaceConfig`, credhelper schemas, control-plane routes) is Zod — a second validator would fragment idioms.
- Emits both a runtime validator (`.parse` / `.safeParse`) and a static type (`z.infer<typeof …>`) from a single declaration — the wire contract mirrored by generacy-cloud can regenerate JSON Schema via `zod-to-json-schema` for the cloud's TypeScript-agnostic consumers.
**Alternatives considered**:
- `valibot` — smaller runtime but zero adoption in this repo.
- Hand-written `is<T>()` guards — no way to derive a JSON Schema mirror for cloud without doubling the surface.

## 2. Package export path: root only (`.`), no `./gates` subpath

**Decision**: Re-export from `packages/cockpit/src/index.ts`; do NOT touch `package.json` `exports`.
**Source**: Clarifications Q2 → A. Spec §Schema-level rules restates: `import { GateRecordSchema } from '@generacy-ai/cockpit'`.
**Rationale**:
- Spec's own acceptance criterion is verbatim "Schemas exported from the package root".
- Package currently exposes only `.` (see `package.json:8-13`); adding a subpath breaks convention for zero isolation benefit.
- Downstream `import { GateRecordSchema, deriveGateId } from '@generacy-ai/cockpit'` reads cleanly and matches how `GhCliWrapper`, `classify`, `loadCockpitConfig` all ship.
**Alternatives considered**: `./gates` subpath — rejected in Q2.

## 3. gateId derivation: `first 24 hex chars of sha256(gateKey)`

**Decision**: `deriveGateId(gateKey) = createHash('sha256').update(gateKey, 'utf8').digest('hex').slice(0, 24)`.
**Rationale**:
- Spec §Scope pins this format ("first 24 hex chars of sha256"). Callers upstream/downstream MUST agree byte-for-byte.
- 24 hex chars = 12 bytes = 96 bits of collision resistance — far more than the total gate population of any single cluster.
- `node:crypto` `createHash('sha256')` is a Node built-in; no dependency added; identical behavior on cloud (Node 20+) and cluster (Node 22+).
- Deterministic + one-shot: given the same `gateKey`, every process derives the same `gateId`. This is the load-bearing invariant for **restart / takeover idempotency** — a re-armed session that re-emits the same open-gate record must not create a duplicate inbox row.
**Alternatives considered**:
- Random UUID — breaks idempotency; a restart would produce a second inbox row for the same live gate.
- Full 64-char sha256 — wasteful in logs and URLs; no collision-resistance gain worth the ergonomic cost.
- Cryptographic HMAC — no secret to sign with; provides no benefit over plain sha256 for this identifier's role.

## 4. gateKey shape: `<owner>/<repo>#<issue>:<gateType>:<generation>`

**Decision**: Exactly the format quoted in the spec §Scope. Colon-delimited, three positional fields.
**Rationale**:
- The `owner/repo#N:` prefix guarantees no cross-issue collision even if two different issues happen to share the same `gateType` + `generation` string.
- Colon delimiter matches the `<generation>` compound-input convention (Q1 answer below), yielding a self-consistent grammar.
- Never parsed back — only hashed. So we optimize for **human readability in operator logs** over parse-robustness. (The `gateKey` shows up in error messages, telemetry, and clarification prompts — see `docs/cockpit-remote-gates-plan.md`.)
**Alternatives considered**: JSON canonicalization or CBOR encoding of a struct — rejected as unnecessary since the string is opaque to consumers.

## 5. Compound-input generation format: colon-joined lowercase

**Decision**: Q1 → A. Compound generation inputs are colon-joined lowercase:
- `artifact-review` → `"<kind>:<headSha>"` (e.g. `"spec-review:abc1234"`)
- `escalation` → `"<subtype>:<label-or-state>:<counter>"` (e.g. `"stalled:agent:error:3"`)
- `scope-drained` → `"<owner>/<repo>#<issue>:<counter>"` (e.g. `"generacy-ai/generacy#900:2"`)
**Rationale** (per Q1 clarification): `gateKey` is only ever hashed, so collision-avoidance (hyphen) and disambiguation (JSON/hash) buy nothing while colon-join keeps generations human-readable in operator logs. The fixed `owner/repo#N:gateType:` prefix rules out realistic cross-tuple collisions even where the compound field itself contains internal colons.
**Escalation note**: because the escalation compound is `<subtype>:<label>:<counter>`, and labels themselves contain colons (`agent:error`, `waiting-for:review`), the full generation string can legitimately contain 3+ colons. This is fine: `gateKey` is opaque, no code splits on colons, `deriveGateId` just hashes the string.

## 6. Per-gate-type generation helper API

**Decision**: One exported helper per gate type in `src/gates/generation.ts`. Callers cannot construct a `gateKey` by hand — they must call the right helper. Signature shape (final types in `data-model.md`):

```ts
export function deriveClarificationGeneration(input: { batchId: string }): string;
export function deriveArtifactReviewGeneration(input: { kind: ArtifactReviewKind; headSha: string }): string;
export function deriveImplementationReviewGeneration(input: { headSha: string }): string;
export function deriveManualValidationGeneration(input: { phaseNumber: number }): string;
export function deriveEscalationGeneration(input: { subtype: string; labelOrState: string; counter: number }): string;
export function derivePhaseQueueGeneration(input: { phaseNumber: number }): string;
export function deriveFilingGeneration(input: { draftHash: string }): string;
export function deriveScopeDrainedGeneration(input: { trackingIssueRef: string; counter: number }): string;
```

**Rationale**:
- Named helpers are self-documenting; a caller who sees `deriveArtifactReviewGeneration({ kind, headSha })` cannot forget an input or swap positional args.
- The `ArtifactReviewKind` type is a **closed local Zod enum** per Q5 clarification (`z.enum(['spec-review', 'plan-review', 'tasks-review', 'clarification-review'])`) → compile-time typo safety on the four stable speckit review stages.
- `implementation-review` is intentionally NOT in that enum — it is its own top-level `gateType`, not an artifact kind (spec §Schema-level rules).
- All helpers return a plain string. The `gateKey` assembly (adding `owner/repo#N:gateType:` prefix) happens inside `deriveGateKey(input)` in `gate-id.ts` — helpers only own the compound-string suffix.

## 7. `options[]` field constraints

**Decision**: Q3 → A. `description` required (non-empty string); `recommended` optional (undefined = not recommended, no `.default(false)` coercion); `options[]` `.min(0)` (may be empty).
**Rationale** (from Q3):
- `.min(0)` is required because pure free-text gates (empty `options[]` + `allowFreeText: true`) are legitimate — the free-text escape hatch provides the answerable path.
- No `.default(false)` on `recommended` because round-trip fidelity matters for fixtures: `parse(stringify(record))` must equal `record`. A `.default(false)` coercion would inject a synthetic `false` on any round-trip through JSON that omitted the field.
- `description` required → the cloud inbox UI can always render a per-option help string; no `?? label` fallback needed downstream.

## 8. `allowFreeText` invariant: literal true

**Decision**: Q4 → A. `allowFreeText: z.literal(true)`. Fixtures do NOT include an `allowFreeText: false` case (schema wouldn't accept it).
**Rationale** (from Q4):
- Plan doc annotates the field "every gate keeps an 'Other'-style escape hatch" as an invariant, not a per-gate choice.
- Encoding the invariant in the schema means a driving session physically cannot emit a gate that blocks with no answerable path (fail-loud at construction time).
- Simpler downstream: the inbox UI can hard-code the "Other" input rather than branching on `allowFreeText`.

## 9. Fixtures: valid + malformed per gate type

**Decision**: `src/gates/fixtures.ts` exports:
- `VALID_FIXTURES: Record<GateType, GateRecord>` — one canonical valid record per gate type (8 entries).
- `MALFORMED_FIXTURES: Record<string, unknown>` — one representative rejection case per constraint (missing `description`, `allowFreeText: false`, empty `gateId`, unknown `gateType`, non-hex `gateId` prefix, etc.). Each keyed by a stable name (e.g. `'missing-description'`) so downstream tests can name-reference.
- `VALID_ANSWER_FIXTURES: Record<GateType, GateAnswer>` — one canonical answer per gate type.
- `VALID_ACK_FIXTURES: Record<'applied' | 'superseded' | 'failed', GateOutcomeAck>` — one per outcome enum.
**Rationale**: spec §Scope explicitly calls out shared fixtures ("exported for reuse by the orchestrator/doorbell/MCP tests and mirrored by generacy-cloud"). Naming malformed fixtures (rather than a raw array) lets downstream tests document the specific rejection they exercise.

## 10. JSON Schema mirror for generacy-cloud

**Decision**: Ship JSON Schema files under `specs/1020-part-cockpit-remote-gates/contracts/` (one per Zod schema). These are the wire-contract source of truth for the **generacy-cloud mirror** (which is not this repo and may not consume `@generacy-ai/cockpit` directly).
**Rationale**:
- The spec says: "Shared test fixtures … mirrored by generacy-cloud." A checked-in JSON Schema keeps that mirror honest without forcing the cloud to depend on this npm package.
- Generation approach: run `zod-to-json-schema` locally against the schemas and check in the output. NOT wired into `pnpm build` — a manual regenerate step, since these change rarely and drift will be caught by cross-repo review.
**Alternatives considered**: `.d.ts` type export only (rejected — cloud's runtime validator is TypeScript-free in some code paths); OpenAPI (rejected — overkill for three record types).

## Key sources / references

- Spec: [`spec.md`](./spec.md)
- Clarifications: [`clarifications.md`](./clarifications.md) (Q1–Q5)
- Epic plan doc §Wire contracts: [`docs/cockpit-remote-gates-plan.md`](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md)
- Existing package export convention: [`packages/cockpit/package.json:8-13`](../../packages/cockpit/package.json)
- Existing schema idiom: [`packages/cockpit/src/config/schema.ts`](../../packages/cockpit/src/config/schema.ts)
- Existing test co-location: [`packages/cockpit/src/__tests__/`](../../packages/cockpit/src/__tests__)
