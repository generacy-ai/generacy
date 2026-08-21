# Data Model: Add `remediation-limit` + `ci` to the cockpit gate wire schema

Issue: generacy-ai/generacy#1163

This change adds **two enum members** to a wire-contract vocabulary. There are no new entities,
tables, or interfaces — only two new legal values for an existing field.

## `GateType` (the widened enum)

`GateType = z.infer<typeof GateTypeSchema>`. Defined identically in two mirrors:

- `packages/generacy/src/cli/commands/cockpit/mcp/gates/schemas.ts`
- `packages/cockpit/src/gates/schema.ts`

| # | Member | Status | Source | Gate label (worker) |
|---|--------|--------|--------|---------------------|
| 1 | `clarification` | existing | — | — |
| 2 | `artifact-review` | existing | — | — |
| 3 | `implementation-review` | existing | — | `waiting-for:implementation-review` |
| 4 | `manual-validation` | existing | — | — |
| 5 | `escalation` | existing | — | — |
| 6 | `phase-queue` | existing | — | — |
| 7 | `filing` | existing | — | — |
| 8 | `scope-drained` | existing | — | — |
| 9 | **`remediation-limit`** | **new** | #1120 | `waiting-for:remediation-limit` + `agent:paused` |
| 10 | **`ci`** | **new** | #1133 | `waiting-for:ci` + `agent:paused` |

Ordering invariant (FR-004): members 1–8 keep their exact order and names; 9–10 are appended.

## Generation discriminator (fixtures only)

The `gateKey` is `${issueRef}:${gateType}:${generation}` and `gateId = sha256(gateKey)[:24]`. The
derivation is gate-type-agnostic and **unchanged**. Fixtures supply a representative `generation`
string per type:

| Member | Fixture generation | Meaning | Helper? |
|--------|--------------------|---------|---------|
| `remediation-limit` | `'1'` | remediation cap-round counter | no (plain string) |
| `ci` | `'abc1234'` | PR head SHA at the CI-wait pause | no (plain string) |

No `derive…Generation` helper is added in `generation.ts` (spec Assumption / Out of Scope). The two
engine-side gates compute their real discriminators upstream (remediation counter, CI head SHA);
fixtures only need a valid string.

## Wire shapes (unchanged, now accept the new `gateType`)

- **Shape 1 — gate-open** (`GateOpenInputSchema` semantic input, `GateOpenWireSchema` outbound
  self-check in the MCP mirror; `GateOpenSchema` at the route): `gateType` field now accepts
  `remediation-limit` / `ci`.
- **Shape 2 — gate-outcome (ACK)** (`GateOutcomeWireSchema` / `GateOutcomeSchema`): unchanged;
  targets an existing `gateId`, carries no `gateType`.
- **Shape 3 — gate-answer** (`GateAnswerSchema`, canonical only): unchanged shape; a
  `VALID_ANSWER_FIXTURES` entry is added per new type for `it.each` coverage.

## Fixture record map (canonical `fixtures.ts`)

Four exhaustive `Record<GateType, …>` maps each gain a `remediation-limit` and `ci` entry:

| Map | New entry shape |
|-----|-----------------|
| `GENERATIONS: Record<GateType, string>` | plain string (`'1'`, `'abc1234'`) |
| `VALID_FIXTURES: Record<GateType, GateOpen>` | `buildRecord('remediation-limit' \| 'ci')` |
| `ANSWER_SPECS: Record<GateType, AnswerSpec>` | option-or-freetext (e.g. resume / redirect) |
| `VALID_ANSWER_FIXTURES: Record<GateType, GateAnswer>` | `buildAnswer('remediation-limit' \| 'ci')` |

Both new types resolve to the default `ISSUE_REF_STR` via `issueRefFor()` (only `phase-queue` is the
epic-ref exception — unchanged).

## Validation rules (unchanged)

- `.strict()` on `GateOpenInputSchema` still rejects unknown keys (surfaces caller typos as
  `invalid-args`).
- `gateId` pinned to length 24; `allowFreeText` required boolean; `issueUrl` a valid URL; timestamps
  ISO-8601. None change — only the `gateType` value set widens.
