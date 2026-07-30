# Contract: Answer NDJSON line — wire shape

**Feature**: #1023 | **Authoritative source**: [`cockpit-remote-gates-plan.md`](https://github.com/generacy-ai/tetrad-development/blob/develop/docs/cockpit-remote-gates-plan.md) §"Answer NDJSON line"

## Scope of this document

The **wire shape** of a single line of `/workspaces/.generacy/cockpit/answers.ndjson` is authoritatively specified in the epic-plan doc linked above (spec §Summary: "Implement against the contracts as written; propose contract changes on the epic before diverging").

This document captures the **minimum subset** the tailer parses locally to satisfy this feature's requirements:

- Fields required for repo-scope filtering (Q1) — the `gateKey` issue-ref.
- Fields required for cross-epic drop logging (Q1).
- Fields required for `GateAnswerEvent` derivation (data-model §E-2).

All other fields flow through the `GateAnswerLine.line` payload via Zod `.passthrough()` and reach downstream (D.12 dispatch) unchanged. This feature does not need to know them.

The line is the FROZEN down-path Shape 3 (flat). There is **no** `scope`, nested `answer`, or top-level `generation` — `generation` is folded into `gateKey`.

## Required fields (tailer-side)

| Field | Type | Consumer inside this feature |
|---|---|---|
| `type` | `'gate-answer'` (literal) | Discriminator. A line lacking it (e.g. the old `kind`) fails schema and is dropped as malformed. |
| `gateId` | `string`, `min(1)` | Cross-epic drop info log; hoisted onto `GateAnswerEvent.gateId`. Format (24-hex) is validated upstream at `POST /cockpit/answers`. |
| `gateKey` | `string`, `min(1)` (`<owner>/<repo>#<issue>:<gateType>:<generation>`) | Repo-scope filter: owner/repo parsed from the issue-ref (up to first `:`) and compared to the bound `epicRef` on **owner/repo only** (child-issue numbers pass). Non-issue targets emit. |
| `optionId` | `string \| null` | Pass-through. `null` on a pure free-text answer. |
| `freeText` | `string \| null` | Pass-through. Present-and-`null` on an option-only answer — must be `.nullable()`, not `.optional()`. |
| `actor` | `{ userId: string; email: string \| null; displayName: string \| null }` | Pass-through. `email`/`displayName` nullable for anonymous / partial-profile actors. |
| `deliveryId` | `string`, `min(1)` | Hoisted onto `GateAnswerEvent.deliveryId`. Deduplication is the session's concern, not the tailer's. |
| `answeredAt` | `string` (ISO 8601 datetime) | Opaque pass-through — used downstream for gate-currency checks. |

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

1. **Happy path**: a valid frozen line matching the bound epic's owner/repo parses and emits one event with flat answer fields.
2. **Pure free-text answer** (`optionId: null`, `freeText` string) and **option-only answer** (`freeText: null`) both parse.
3. **Null-`email` / null-`displayName` actor** (anonymous / partial profile): parses (guards against tightening `actor` to non-null).
4. **Missing `type` discriminator** (e.g. the old `kind`): skipped with `warn` — guards the `kind`→`type` fix.
5. **Missing `gateId` / empty-string `gateId` / missing `gateKey` / missing `actor` / `optionId` wrong type**: skipped with `warn`.
6. **Malformed JSON**: skipped with `warn`; byte-offset named in the message.
7. **Extra unknown fields**: preserved on `line.*` via `.passthrough()`.
8. **Cross-repo line** (foreign owner/repo in `gateKey`): dropped with `info` naming gateId + scope + boundEpic. **Same-repo child-issue** (different issue number) and **non-issue `gateKey` target** (filing / scope-drained tracking ref): NOT dropped.
