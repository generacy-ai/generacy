# Feature Specification: Found during the cockpit v1

**Branch**: `890-found-during-cockpit-v1` | **Date**: 2026-07-09 | **Status**: Draft

## Summary

Found during the cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92), finding #41. Follow-up to #847/#865.

## Observed

christrudelpw/sniplink#6/#7/#8 all failed validate with alerts reading:

```
❌ validate failed — `npm test && npm run build` exit 1
stderr: (empty)
```

The real error was on **stdout**: `next build`'s type-check failure (`Type error: Cannot find module '@/components/CopyButton'`) — Next.js, vitest, and npm all write most failure detail to stdout. #847's evidence block captures a stderr tail only, so the alert carried nothing, the auto session's escalation gate presented "stderr: (empty)", and diagnosis required cloning the branch and re-running the command in a container. An evidence surface that misses the most common Node-toolchain failure channel fails its purpose on the most common failure.

Secondary consequence worth recording: #6's original failure is now **unreproducible** (both its branch tip and merge-preview pass today) and undiagnosable retroactively — precisely because the evidence didn't capture the output that existed at the time.

## Fix

Capture a bounded, chronologically-interleaved tail of **both** streams (arrival-order best-effort) in `buildErrorEvidence`, rendered as a single `output` block. Keep the #847 4 KiB byte bound. Rename the `stderrTail` field on `CommandExitEvidence` to `outputTail`.

## Clarifications

Session 2026-07-09 (see [clarifications.md](./clarifications.md)):

- **Rendering shape** (Q1 → A): Single interleaved tail. Spawn layer merges stdout+stderr chunks in arrival order into one buffer; `buildErrorEvidence` produces one `outputTail` rendered under one `<details><summary>output (last N lines)</summary>` block. `CommandExitEvidence.stderrTail` is renamed `outputTail` (internal type, no compat ceremony).
- **Empty rendering** (Q2 → A): Omit empty output entirely. With a single interleaved block this only reaches the both-empty case; that collapses to one shared header containing `(no output on either stream)`. No block, no `(empty)` marker, ever appears when either stream has content.
- **Spawn-layer scope** (Q3 → C): Shell paths (`runValidatePhase`, `runPreValidateInstall`) gain raw stdout+stderr capture into a **bounded ring buffer (~8 KiB)** attached inside `manageProcess` when `capture === undefined`. Claude-CLI phases synthesize the tail from the `type: 'text'` chunks that `OutputCapture` already retains in `PhaseResult.output` — no double-buffering of JSON transcripts. Memory cost is O(1) regardless of output volume.
- **Byte budget** (Q4 → N/A): One merged tail, one 4 KiB cap after last-30-lines slicing. No inter-stream allocation rule needed.
- **Ordering fidelity** (Q5 → A): Arrival-order best-effort. Chunks concatenated in the order Node's `data` events deliver them; no timestamps, no re-sort. Documented as approximate — pipe buffering may reorder near-simultaneous writes.

## Regression tests

- Fixture command failing with stdout-only output → evidence `output` block contains the stdout tail; no separate stderr section, no `(empty)` marker.
- Both-stream failure → single interleaved `output` block contains chunks from both streams within the 4 KiB bound.
- Empty-both-streams failure → single `output` block with body `(no output on either stream)`.
- The rendered alert never reads `(empty)` when the process produced any output on either stream.


## User Stories

### US1: Operator triaging a failed validate/build phase from the alert

**As an** operator watching an auto-mode session,
**I want** the failure alert's evidence block to contain the actual error text that the failing command produced,
**So that** I can diagnose the failure from the alert alone without cloning the branch and re-running the command locally.

**Acceptance Criteria**:
- [ ] When the failing command writes its error only to stdout (Next.js `next build` type errors, `vitest` assertion failures, `npm` install errors), the alert's evidence block contains the tail of that stdout output.
- [ ] When the failing command writes to both streams, the evidence block contains a single interleaved tail of both, within the #847 byte bound.
- [ ] The rendered alert never displays a literal `(empty)` (or equivalent) marker for a silent stream when the process produced any output on either stream.

### US2: Post-hoc diagnosis of a resolved-but-unexplained failure

**As an** engineer reviewing a past workflow run whose failing branch tip now passes,
**I want** the stored evidence block from the original alert to describe what the command actually said,
**So that** I can understand what broke without needing to reproduce the environment.

**Acceptance Criteria**:
- [ ] The evidence surface persisted at the time of failure captures the same output the operator would see running the command locally at that moment (subject to the byte bound).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `buildErrorEvidence` MUST produce a single `outputTail` derived from a merged stdout+stderr capture of the failed phase. | P1 | Field replaces today's `stderrTail`; internal type rename inside the discriminated union. |
| FR-002 | The `outputTail` MUST stay within the #847 byte bound (4 KiB) after last-30-lines slicing. One string, one cap — no per-stream allocation. | P1 | Preserves the alert-size guarantee. |
| FR-003 | When either stream produced output, the rendered block MUST contain that output and MUST NOT contain any `(empty)` (or equivalent) marker for the silent stream. | P1 | Fixes the observed "stderr: (empty)" failure mode. |
| FR-004 | When at least one stream produced output, the rendered block is a single `<details><summary>output (last N lines)</summary>` containing the interleaved tail in Node `data`-event arrival order (best-effort; documented as approximate). | P1 | Ordering fidelity: no chunk timestamps, no re-sort, no PTY. |
| FR-005 | Shell spawn paths (`runValidatePhase`, `runPreValidateInstall`) MUST buffer raw stdout+stderr into a bounded ring (~8 KiB, O(1) memory) inside `manageProcess` when `capture === undefined`, and populate `outputTail` from that ring at exit. Claude-CLI phases MUST synthesize `outputTail` from `type: 'text'` chunks in `PhaseResult.output` — no duplicate raw buffering. | P1 | Corrects the wrong assumption about existing capture; sets the plumbing scope. |
| FR-006 | Existing `CommandExitEvidence` consumers (stage comment renderer, failure-alert composer #865) MUST render the `outputTail` shape correctly; call sites reading `stderrTail` are updated in the same change. | P1 | Rename is a coordinated internal edit, not backwards-compatible aliasing. |
| FR-007 | Empty-both-streams case MUST render one shared `output` header with the body `(no output on either stream)` — a single marker, not two. | P2 | Cosmetic but reader-visible. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Alerts for stdout-only failures contain the actual error text. | 100% of stdout-only fixture failures. | Regression test: `next build` type-error fixture → evidence block contains the offending `Type error:` line. |
| SC-002 | Evidence block total size stays within the #847 bound. | ≤ 4 KiB (or whatever #847 sets) for all fixture cases including both-stream large-output. | Byte-length assertion in tests. |
| SC-003 | No alert reads `(empty)` when the process produced output on either stream. | 0 occurrences across the fixture matrix. | Regression test scans the rendered alert text. |
| SC-004 | Retroactively, re-running the christrudelpw/sniplink#6 scenario against the fixed builder yields an alert containing `Cannot find module '@/components/CopyButton'`. | Present in evidence. | Reproduction fixture (canned stdout capture) fed through `buildErrorEvidence`. |

## Assumptions

- Shell-path spawns (`runValidatePhase`, `runPreValidateInstall`) currently discard raw stdout at a no-op listener inside `manageProcess` (cli-spawner.ts:167); the fix adds a bounded ring buffer at that site (~8 KiB, O(1) memory).
- Claude-CLI phases already retain `type: 'text'` chunks in `PhaseResult.output` via `OutputCapture`; the fix reuses those chunks to synthesize `outputTail` — no duplicate raw buffering, no JSON-transcript RAM cost.
- The #847 byte bound and last-30-lines slicing policy remain the intended shape; this feature broadens what is bounded (one merged stream vs. stderr only), not how.
- Downstream renderers (`StageCommentManager.renderStageComment`, failure-alert composer #865) live in this repo and are updated in the same change as the `stderrTail` → `outputTail` rename.

## Out of Scope

- Changing the byte-bound established in #847.
- Structured output parsing (e.g., extracting the `Type error:` line specifically) — this feature just widens capture, not intelligence.
- Streaming/live-tail of output — evidence is a post-hoc tail.
- Non-command-exit failure paths (merge-conflict variant, no-progress guard beyond its current stderr synthesis) unless FR-005 requires touching them.
- Cross-tool normalization (Next.js vs. vitest vs. npm output formatting).

---

*Generated by speckit*
