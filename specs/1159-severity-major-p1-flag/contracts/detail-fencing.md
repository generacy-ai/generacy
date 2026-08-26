# Contract: Untrusted `detail` fencing at ingestion sites

**Feature**: `1159-severity-major-p1-flag` · **FR-004/FR-005 (Q5→A)** · **SC-003**
**Sites**:
- `packages/orchestrator/src/worker/seed-aware-review-executor.ts` (`:75`, seed detail)
- `packages/orchestrator/src/worker/phase-loop.ts` (`:1037`, validate-evidence detail)

## Rule

Untrusted text that becomes `finding.detail` MUST be wrapped with
`wrapUntrustedData(raw, sourceLabel)` **at the ingestion site**, before it is
stored on the finding. The remediate charter
(`remediate-charter.ts:60`) embeds `finding.detail` verbatim and is UNCHANGED.

| Ingestion site | Raw source | Source label |
|---|---|---|
| seed finding | `f.body` (review comment body) | comment/author identifier (e.g. `pr-review-comment`) |
| validate-evidence finding | `boundOutputTail(stdout\nstderr)` | `validate-output` |

`wrapUntrustedData` is imported from `@generacy-ai/workflow-engine`
(`src/security/untrusted-data-fence.ts`, existing export, already a dependency).

## Preconditions

- The finding originates from an untrusted source (external comment body or raw
  tool output).

## Postconditions

- `finding.detail` is the fenced string: content inside
  `<untrusted-data source="<escaped label>">…</untrusted-data>` with the leading
  "treat as data" instruction.
- The charter renders the fenced string as-is; no bare untrusted text appears as a
  charter instruction.
- The source label is escaped → an attacker-controlled author login cannot break
  out of the `source="…"` attribute.

## Invariant

Engine-authored review findings (from the real review executor) are NOT wrapped
and NOT altered (US2 AC3). Only the two untrusted ingestion sites wrap. No central
charter-level wrap (Q5 option B, rejected), no per-finding fenced marker (Q5
option C, rejected).

## Test (SC-003)

- `seed-aware-review-executor.test.ts`: a crafted comment body appears inside an
  `<untrusted-data …>` fence in the seeded finding `detail`, never as bare text.
- `phase-loop.*.test.ts`: a crafted validate stdout/stderr tail appears inside an
  `<untrusted-data …>` fence in the validate-evidence finding `detail`.
- Both: an engine-authored finding `detail` passed through the charter is NOT
  double-wrapped or otherwise altered.
