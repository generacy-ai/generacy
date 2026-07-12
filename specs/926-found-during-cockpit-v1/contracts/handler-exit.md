# Contract — `PrFeedbackHandler` Terminal Exit Behavior

**Surface**: `packages/orchestrator/src/worker/pr-feedback-handler.ts` — `PrFeedbackHandler.handle(item, checkoutPath): Promise<void>`.

## Post-change contract

After `handle()` returns via **any** terminal path, the linked issue's label set MUST satisfy:

| Exit path | Original return site (pre-change) | Labels REMOVED by handler | Labels PRESENT after return | Labels ABSENT after return |
|---|---|---|---|---|
| Case A — no unresolved threads | line 222 | `waiting-for:address-pr-feedback`, `agent:in-progress` | (depends on prior state; typically `waiting-for:implementation-review`, `agent:paused`) | `agent:in-progress` |
| Case B — all unresolved comments untrusted | line 232 | `agent:in-progress` (only) | `waiting-for:address-pr-feedback` (retained by design, FR-002), whatever was previously present | `agent:in-progress` |
| Blocked-stuck — CLI failed or no diff | line 302 | `agent:in-progress` (only) | `waiting-for:address-pr-feedback` (retained by design), `blocked:stuck-feedback-loop` (added by handler), whatever was previously present | `agent:in-progress` |
| Blocked-stuck — zero resolve successes | line 337 | `agent:in-progress` (only) | `waiting-for:address-pr-feedback` (retained by design), `blocked:stuck-feedback-loop` (added by handler), whatever was previously present | `agent:in-progress` |
| Happy path | line 357 | `waiting-for:address-pr-feedback`, `agent:in-progress` — **in a single `removeLabels(['waiting-for:address-pr-feedback', 'agent:in-progress'])` client invocation** (FR-006 / Q3→A) | `waiting-for:implementation-review`, `agent:paused` (fresh D.3-ready gate) | `agent:in-progress`, `waiting-for:address-pr-feedback` |

**Every one of the five terminal paths above MUST leave `agent:in-progress` absent.** SC-004.

## Structural requirement

- The `agent:in-progress` clear MUST be implemented **once**, in a single shared exit path (e.g. `try/finally`), not per-site at each of the four (five including the second blocked-stuck) return sites. SC-005 / FR-005.
- The string literal `'agent:in-progress'` MUST appear at exactly one **code** site inside `pr-feedback-handler.ts` (the coalesced happy-path `removeLabels` call or the shared exit-path clear, but not both scattered per-site).
- On the happy path, `waiting-for:address-pr-feedback` and `agent:in-progress` MUST be removed by a **single `removeLabels(labels: string[])` client invocation** — one client-side call, both labels named in the array (FR-006 / Q3→A). Not two sequential single-label calls.

## Non-goals / non-changes

- **No change to Case B's retained `waiting-for:address-pr-feedback`.** The gate is intentionally kept.
- **No change to blocked-stuck's `blocked:stuck-feedback-loop` addition or `waiting-for:address-pr-feedback` retention.** Both are intentional.
- **No change to `resolveReviewThread` retry semantics** or the strict-decrease success test (#883 FR-006 / FR-010) — orthogonal to this fix.
- **No new `GitHubClient` API** — `addLabels` / `removeLabels` (both `labels: string[]`) already support the coalesced call.

## Failure modes

- Handler returns via any terminal path and `agent:in-progress` is still present on the issue → SC-004 test fails.
- Grep of `pr-feedback-handler.ts` for `'agent:in-progress'` returns more than one code-site match → SC-005 violation.
- Happy path decomposes the coalesced call into two sequential `removeLabels(['x'])` invocations → FR-006 violation.
