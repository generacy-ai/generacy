# Clarifications

## Batch 1 — 2026-07-12

### Q1: `waiting-for:address-pr-feedback` insertion position in `WAITING_PIPELINE_ORDER`
**Context**: FR-001 says rank `waiting-for:address-pr-feedback` "ahead of `waiting-for:implementation-review`" — any index between `blocked:stuck-feedback-loop` (index 0) and `waiting-for:implementation-review` (currently index 5) satisfies that literal wording, but the exact index changes co-occurrence behavior with the other listed gates. `packages/cockpit/src/state/precedence.ts:26-36` currently orders: `blocked:stuck-feedback-loop`, `spec-review`, `clarification`, `plan-review`, `tasks-review`, `implementation-review`, `manual-validation`. #883 chose index 1 (right after `blocked:*`, ahead of every `waiting-for:*`) on the "surface the more-specific active state first when both coexist" principle the spec explicitly invokes. Alternative: place it directly before `implementation-review` (index 5), which is the minimum change needed for the observed engage/complete edge symptom but leaves `address-pr-feedback` outranked by every other `waiting-for:*` in the (rare) hypothetical where both a spec-review or plan-review gate coexists with an active PR-feedback cycle on the same issue.
**Question**: At what index should `waiting-for:address-pr-feedback` sit in `WAITING_PIPELINE_ORDER`?
**Options**:
- A: Index 1 — immediately after `blocked:stuck-feedback-loop`, ahead of every `waiting-for:*` gate. Matches #883's precedent verbatim: "surface the more-specific active state first when both coexist." Robust against any hypothetical co-occurrence.
- B: Index 5 — immediately before `waiting-for:implementation-review` (its documented co-occurrent). Minimum-diff literal reading of FR-001; unchanged ordering for the other 4 gates.
- C: Something else (please specify).

**Answer**: *Pending*

### Q2: Which handler exit paths clear `agent:in-progress`?
**Context**: `pr-feedback-handler.ts` has multiple exit points that interact differently with the terminal label set:
- **Line 222** (Case A): no unresolved threads at all → `removeFeedbackLabel` → return. Terminal successful exit.
- **Line 232** (Case B): unresolved threads exist but every comment is untrusted → **retains** `waiting-for:address-pr-feedback` → return. Handler is done, but the gate is intentionally kept.
- **Line 302 / 337** (`blocked:stuck-feedback-loop` disposition): CLI didn't complete OR no diff OR zero resolve successes → `addBlockedStuckFeedbackLoopLabel` → return. `waiting-for:address-pr-feedback` is deliberately retained; `blocked:stuck-feedback-loop` is added; handler is done.
- **Line 357** (happy path): success → `removeFeedbackLabel` → return.

FR-005 says "on cycle completion". The observed live-incident bug (`agent:in-progress` coexisting with `agent:paused` on snappoll-1#2 after the fix landed) came from the happy path (line 357). But the same under-cleaned-terminal-state failure mode arguably exists at every exit — the handler *is* done, so `agent:in-progress` is stale from any of them.
**Question**: Which handler exit paths should clear `agent:in-progress`?
**Options**:
- A: Only the two paths that already call `removeFeedbackLabel` — line 222 (Case A) and line 357 (happy path). "Cycle completion" = the handler removed its own gate. Case B and blocked-stuck retain the gate (not "completion") and are addressed in follow-up issues.
- B: Only line 357 (happy path). Narrowest literal reading of "successful cycle completion".
- C: All four exit paths — every terminal return from the handler clears `agent:in-progress` regardless of whether `waiting-for:address-pr-feedback` was removed. Widest reading; ensures `agent:in-progress` is never left stale by this handler under any disposition.

**Answer**: *Pending*

### Q3: Interpretation of "single combined label edit" (FR-005)
**Context**: FR-005 says "clear `agent:in-progress` alongside `waiting-for:address-pr-feedback` in a single combined label edit (add-before-remove / atomicity conventions)." But this exit path only removes labels (nothing is added), and `GitHubClient` (`packages/workflow-engine/src/actions/github/client/interface.ts:267-272`) exposes only `addLabels` / `removeLabels` — no truly atomic combined-edit method. The `add-before-remove` phrasing comes from `LabelManager` (e.g., `onGateHit`, `onError`) where a pause/error label pair is added and stale labels removed — but those sites use **two sequential HTTP calls** (`removeLabels(...)` then `applyLabels([...])`), not one. So "single combined edit" needs disambiguation.
**Question**: How is "single combined label edit" to be implemented for the removal-only case in `removeFeedbackLabel`?
**Options**:
- A: One `removeLabels(owner, repo, issueNumber, ['waiting-for:address-pr-feedback', 'agent:in-progress'])` call — one HTTP round-trip, both labels vanish together. The "single combined edit" wording maps to "one API call". `add-before-remove` is vacuous here because nothing is being added.
- B: Two sequential `removeLabels(...)` calls, one label each — matches the existing `LabelManager` idiom of "one call per direction" (add-direction call + remove-direction call), even though both directions here happen to be removes. Preserves per-label failure isolation.
- C: Something else (please specify).

**Answer**: *Pending*

### Q4: Scope — do other unlisted `waiting-for:*` gates get promoted in this change?
**Context**: The docstring at `packages/cockpit/src/state/precedence.ts:22-24` notes that `waiting-for:pr-feedback`, `waiting-for:clarification-review`, `waiting-for:sibling-review`, `waiting-for:children-complete`, `waiting-for:epic-approval`, and `waiting-for:dependencies` are also currently absent from `WAITING_PIPELINE_ORDER` and fall back to `WORKFLOW_LABELS` index. Any of these coexisting with `waiting-for:implementation-review` (or with a listed gate) would exhibit the same "no transition" failure mode this spec fixes for `address-pr-feedback` — the spec does not say whether that generalisation is in-scope.
**Question**: Should this issue also add any of the other unlisted `waiting-for:*` gates to `WAITING_PIPELINE_ORDER`, or is that out of scope?
**Options**:
- A: Only `waiting-for:address-pr-feedback` is added in this issue. Every other unlisted gate stays as-is; if the same failure mode is observed on one of them, file a follow-up issue. Preserves the "one-line ordering change" property the spec claims for the fix.
- B: Add `waiting-for:address-pr-feedback` **and** `waiting-for:pr-feedback` (its adjacent sibling that appears alongside it in the docstring's list) — treat the pair as a single semantic group. Every other unlisted gate stays as-is.
- C: Enumerate all listed unlisted gates in `WAITING_PIPELINE_ORDER` in this issue at defensible positions (pipeline-order-consistent). Widest scope.

**Answer**: *Pending*
