# Feature Specification: Failure alerts drop the post-exit classifier's reason

**Branch**: `915-found-during-cockpit-v1` | **Date**: 2026-07-11 | **Status**: Draft

## Summary

Found during the cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92), finding #55 — snappoll full-epic run. Same evidence family as #890 (stderr-only evidence).

## Observed

snappoll#3's implement phase was failed twice by the specs/820 **no-product-code-changes guard** — correctly: both runs changed only `specs/003-*/**` artifacts (`plan.md`, `tasks.md`, `contracts/*`, …; worker log: `changedFiles: [specs/... ×10] excluded: ['specs/']`). But the posted failure alert said only:

> ❌ implement failed — `implement` exit 0. (no output on either stream)

The guard's explanation exists — `result.error.message` = "Phase \"implement\" produced no product-code changes — all changed files are under excluded prefixes [specs/]…" — but `buildErrorEvidence` (phase-loop.ts:989–1011) returns `{command, exitDescriptor, outputTail}` and uses `error.message` **only** to sniff timeout/abort wording; the message itself is dropped. With `error.output` empty on this synthetic path, the alert renders the "(no output on either stream)" literal.

Cost in the live run: the operator and auto session read "exit 0, no output" as a transient anomaly → requeue → identical failure → second escalation gate → operator time burned, and the actual signal ("the implement agent wrote only spec artifacts") was never surfaced. Two aggravations:

- **`exit 0` in a failure alert is a lying label** — the process exited 0 and was failed post-exit by a classifier; the alert should say which check failed it, not present a success code as the failure descriptor.
- Every synthetic-PhaseResult path (product-diff guard, no-progress guard, catch-block) shares this: the one line that explains the failure is the one line the alert cannot carry.

## Fix

Include the classifier message in the evidence: add a `reason` field to `CommandExitEvidence` populated from `result.error.message`, rendered above the output tail in both the stage comment and the failure alert. When the failure comes from a post-exit classifier rather than the process, the exit descriptor should name it (`failed post-exit: no-product-code-changes (process exit 0)`).

## Regression tests

- Product-diff guard failure → alert body contains the excluded-prefixes message and names the guard; never renders "(no output on either stream)" as the only evidence.
- No-progress guard and catch-block synthetic results → same.
- Process-failure path (real non-zero exit) → unchanged shape plus empty/absent reason.


## User Stories

### US1: Post-exit classifier failures render their reason in the failure alert

**As an** auto-mode operator (or auto session) reading a failure alert,
**I want** the alert to name the classifier that failed the phase and quote its reason (the excluded-prefixes list, the no-progress guard's counter, the catch-block's exception message),
**So that** I don't misread a post-exit classifier failure as a transient "exit 0, no output" anomaly, requeue it, and burn an escalation gate — the fix should be visible in the first alert, not the third.

**Acceptance Criteria**:
- [ ] For a product-diff guard failure, the alert body contains `"produced no product-code changes"` and lists the excluded prefixes verbatim from `result.error.message`.
- [ ] The alert's summary line (`❌ <phase> failed — …`) reports `failed post-exit: <classifier-name> (process exit 0)` instead of a bare `exit 0`, so the exit descriptor never presents a success code as the failure descriptor.
- [ ] The no-progress guard's failure alert names the guard (`implement (no-progress guard)`) and carries its counter message (`tasks_remaining stayed at N across two increments`).
- [ ] The catch-block synthetic failure carries the thrown error's `.message` in the same `reason` slot.
- [ ] No synthetic-PhaseResult path renders `(no output on either stream)` as the sole evidence when a `result.error.message` was set.

### US2: Real-process failures remain unaffected

**As a** worker log reader triaging a genuine non-zero-exit shell failure (validate, pre-validate install),
**I want** the alert shape to be identical to today's — `exit <N>` descriptor plus the ring-buffer tail — with no phantom `reason` line injected from the shell's own output,
**So that** the fix for the synthetic-path variant doesn't change the surface I already read fluently.

**Acceptance Criteria**:
- [ ] Process-failure path (`result.error.output` non-empty, exit code non-zero) renders with no `reason` line and the existing `exit <N>` descriptor.
- [ ] Existing snapshot fixtures for shell-path failures pass unchanged.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `CommandExitEvidence` MUST gain an optional `reason?: string` field populated from `result.error.message` when the phase was failed post-exit by a classifier (product-diff guard, no-progress guard, catch-block). | P1 | Optional, so the shell/CLI process-failure path stays unchanged when the message is only used for timeout/abort sniffing. |
| FR-002 | `buildErrorEvidence` MUST distinguish "process-failure" from "synthetic post-exit failure" using the same signal it already uses (`result.error.output.length === 0` on the synthetic path — populated by the shell/CLI callers). On the synthetic path, `reason` is set from `result.error.message`; on the process path, `reason` is undefined. | P1 | Keeps the classification centralized in `buildErrorEvidence`; callers don't gain a new obligation. |
| FR-003 | `exitDescriptor` MUST name the classifier on the synthetic path: `failed post-exit: <classifier-name> (process exit <N>)`. Classifier name comes from an explicit parameter passed by the caller (already known at the callsite: `'no-product-code-changes'`, `'no-progress'`, `'catch-block'`). | P1 | Never presents a success code as the failure descriptor. Passed through `buildErrorEvidence`'s existing `command` slot or a new sibling parameter — implementation detail resolved at plan time. |
| FR-004 | The stage-comment `appendEvidenceBlock` renderer MUST render `reason` above the `output (last N lines)` details block, formatted as `**Reason**: <reason>` on its own line, when present. Absent `reason` → block renders identically to today. | P1 | Rendered in both the paused-stage comment and the failure-alert comment. |
| FR-005 | The failure-alert `renderFailureAlert` renderer MUST render the same `**Reason**: <reason>` line above the output details in the alert body when `reason` is present. Summary line uses the new `failed post-exit: <classifier> (process exit N)` descriptor. | P1 | Same rendering rule as FR-004, applied to the alert-comment marker. |
| FR-006 | Every `buildErrorEvidence` callsite that constructs a synthetic `PhaseResult` (no-progress guard at phase-loop.ts:429, product-diff guard at :599 and :630, catch-block sites at :294, :373, :548) MUST pass a classifier name so FR-003 can render it. | P1 | Enumeration derived from `Grep buildErrorEvidence` on phase-loop.ts (six callsites, three are shell/CLI process paths and three are synthetic). Plan phase resolves the exact three-vs-six split by re-reading each callsite's construction of `result.error`. |
| FR-007 | The `reason` field MUST NOT double-render when the shell/CLI process path also happens to populate `result.error.message` for timeout/abort sniffing (existing behavior at phase-loop.ts:995–1000). Timeout/abort wording continues to feed only `exitDescriptor`, never `reason`. | P1 | Preserves the shell-path snapshot fixtures. |
| FR-008 | Regression suite MUST add three synthetic-path fixtures (product-diff, no-progress, catch-block) asserting the rendered stage comment and failure alert contain the reason string, the classifier-named exit descriptor, and never contain the literal `"(no output on either stream)"` as the sole evidence line. | P1 | Tests-encode-assumptions rule (specs/902 §"nine occurrences"): the existing tests passed because they never exercised a synthetic path against the renderer. Fixture must drive `buildErrorEvidence` from a real synthetic `result.error` shape, not a hand-built `CommandExitEvidence`. |
| FR-009 | Regression suite MUST add one process-failure fixture (shell path with non-zero exit and non-empty `result.error.output`) asserting the rendered stage comment and failure alert render identically to today (no `reason` line, bare `exit <N>` descriptor). | P1 | Guardrail against regressing US2. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Synthetic-PhaseResult failure alerts carry the classifier reason | 100% of the three synthetic paths (product-diff, no-progress, catch-block) render `**Reason**: …` above the output tail | Regression fixture assertions (FR-008). |
| SC-002 | Failure-alert summary line correctness on synthetic paths | 0 occurrences of `exit 0` as the failure descriptor across the three synthetic-path fixtures; 100% use `failed post-exit: <classifier> (process exit 0)` | Regression fixture assertions (FR-008 second criterion). |
| SC-003 | No regression on the process-failure path | Existing shell-path snapshot fixtures pass unchanged; new process-failure fixture (FR-009) renders with no `reason` line and bare `exit <N>` descriptor | Snapshot diff + fixture assertion. |
| SC-004 | Operator/auto-session misread rate on synthetic-path failures | 0 requeues driven by "exit 0, no output" reading in the smoke-test replay of snappoll#3's scenario | Manual replay against fixture; auto-session log inspection. |

## Assumptions

- The three synthetic-PhaseResult callsites (no-progress guard, product-diff guard's two callsites at :599 and :630, catch-block) all populate `result.error.message` with the human-readable failure reason. Verified for the no-progress guard (phase-loop.ts:426) and product-diff guard (phase-loop.ts:624–626); catch-block sites verified at plan time.
- `result.error.output === ''` is a reliable discriminator for the synthetic path today. The shell/CLI process paths always populate `output` (ring-buffer tail or synthesized text-chunk tail) on failure; the three synthetic paths always leave it empty. If a future synthetic path populates `output` non-empty, FR-002's discriminator holds because `reason` and `outputTail` can coexist.
- The classifier name is a compile-time constant at each synthetic callsite (`'no-product-code-changes'`, `'no-progress'`, `'catch-block'`), so FR-006 is a mechanical parameter-threading change, not a runtime lookup.
- The failure-alert marker's dedup key (`runId` per specs/865) is unaffected — the alert-comment identity is unchanged; only its body content changes.

## Out of Scope

- Any change to the `waiting-for:*` / `agent:paused` / `failed:*` label protocol.
- Any change to the classifier logic itself (product-diff exclusion prefixes, no-progress counter thresholds, catch-block scope).
- Retrofitting `reason` onto the merge-conflict variant of `errorEvidence` (specs/864/#898) — that variant has its own dedicated renderer (`appendMergeConflictBlock`) and is out of scope for this issue.
- A broader "human-readable reason for every failure" pass — this issue is scoped to the three synthetic-PhaseResult paths named in the observation.
- Cross-issue evidence aggregation or history (e.g., "this is the second time this classifier fired on this issue") — the fix is per-alert, not cross-alert.

---

*Generated by speckit*
