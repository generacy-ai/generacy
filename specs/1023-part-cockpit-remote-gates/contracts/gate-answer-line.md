# Contract: Answer NDJSON line — wire shape

**Feature**: #1023 | **Authoritative source**: [`cockpit-remote-gates-plan.md`](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md) §"Answer NDJSON line"

## Scope of this document

The **wire shape** of a single line of `/workspaces/.generacy/cockpit/answers.ndjson` is authoritatively specified in the epic-plan doc linked above (spec §Summary: "Implement against the contracts as written; propose contract changes on the epic before diverging").

This document captures the **minimum subset** the tailer parses locally to satisfy this feature's requirements:

- Fields required for scope filtering (Q1).
- Fields required for cross-epic drop logging (Q1).
- Fields required for `GateAnswerEvent` derivation (data-model §E-2).

All other fields flow through the `GateAnswerLine.line` payload via Zod `.passthrough()` and reach downstream (D.12 dispatch) unchanged. This feature does not need to know them.

## Required fields (tailer-side)

| Field | Type | Consumer inside this feature |
|---|---|---|
| `gateId` | `string`, `min(1)` | Cross-epic drop info log; hoisted onto `GateAnswerEvent.gateId` for consumer convenience. |
| `deliveryId` | `string`, `min(1)` | Hoisted onto `GateAnswerEvent.deliveryId`. Deduplication is the session's concern, not the tailer's. |
| `scope` | `{ owner: string; repo: string; number: number (int, positive) }` | Compared against the bound `epicRef` (parsed as `owner/repo#number`). Cross-scope lines dropped + logged. |
| `answer` | `unknown` | Opaque pass-through — the operator's payload; validated by the gate record, not the tailer. |
| `answeredAt` | `string` (ISO 8601 datetime) | Opaque pass-through — used downstream for gate-currency checks. |

## Optional fields (tailer-side)

| Field | Type | Consumer inside this feature |
|---|---|---|
| `answeredBy` | `string` | Pass-through. |
| `generation` | `number` (int, ≥ 0) | Pass-through. Required if the epic-plan doc's generation rules apply — the tailer neither enforces nor interprets. |

## Unknown fields

Zod `.passthrough()` on `GateAnswerLineSchema` keeps unknown properties on the object. They are:

1. Included when the tailer emits the `GateAnswerEvent` (as `event.line[unknownField]`).
2. Included when `subscribeAndEmit` writes the stdout NDJSON line (`JSON.stringify` preserves all own-properties).
3. Returned by `cockpit_await_events` as part of the event payload.

This lets the epic-plan doc iterate on field shape without a schema bump in this repo, per R-8 in `research.md`.

## Divergence policy

If the epic-plan doc's wire shape diverges from `GateAnswerLineSchema` in a way that breaks the required-field subset above, **stop and propose a contract change on the epic issue** (spec §Summary). Do not silently loosen the schema in this repo — a loose schema here means malformed lines flow into consumers as valid events, poisoning the D.12 dispatch downstream.

## Test cases (conformance)

The tailer's line-validation contract is exercised in `answers-file-source.unit.test.ts`:

1. **Happy path**: a line matching the required-field set parses and emits.
2. **Missing `gateId`**: skipped with `warn`.
3. **Missing `scope.number`**: skipped with `warn`.
4. **Malformed JSON**: skipped with `warn`; byte-offset field present.
5. **Extra unknown fields**: preserved on `line.*` via `.passthrough()`.
6. **`scope.number` type mismatch (string instead of int)**: skipped with `warn`.
7. **Empty string `gateId`**: skipped with `warn` (`min(1)` violation).
