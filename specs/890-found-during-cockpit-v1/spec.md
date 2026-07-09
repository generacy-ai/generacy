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

Capture bounded tails of **both** streams in `buildErrorEvidence` — ideally a combined chronological tail (last N lines of interleaved output), else a stdout tail alongside the stderr tail, rendering whichever is non-empty first. Keep the #847 byte bound for the total.

## Regression tests

- Fixture command failing with stdout-only output → evidence contains the stdout tail; stderr section absent or marked empty.
- Both-stream failure → both tails present within the size bound.
- The rendered alert never reads "(empty)" when the process produced any output on either stream.


## User Stories

### US1: Operator triaging a failed validate/build phase from the alert

**As an** operator watching an auto-mode session,
**I want** the failure alert's evidence block to contain the actual error text that the failing command produced,
**So that** I can diagnose the failure from the alert alone without cloning the branch and re-running the command locally.

**Acceptance Criteria**:
- [ ] When the failing command writes its error only to stdout (Next.js `next build` type errors, `vitest` assertion failures, `npm` install errors), the alert's evidence block contains the tail of that stdout output.
- [ ] When the failing command writes to both streams, the evidence block contains tails of both, within the same total byte bound established in #847.
- [ ] The rendered alert never displays a literal `(empty)` (or equivalent) marker as its sole evidence when the process produced any output on either stream.

### US2: Post-hoc diagnosis of a resolved-but-unexplained failure

**As an** engineer reviewing a past workflow run whose failing branch tip now passes,
**I want** the stored evidence block from the original alert to describe what the command actually said,
**So that** I can understand what broke without needing to reproduce the environment.

**Acceptance Criteria**:
- [ ] The evidence surface persisted at the time of failure captures the same output the operator would see running the command locally at that moment (subject to the byte bound).

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `buildErrorEvidence` MUST capture bounded tails of both stdout and stderr from the failed phase result. | P1 | Today it reads only `result.error.stderr`. |
| FR-002 | The total byte size of the combined evidence MUST stay within the #847 byte bound (currently 4 KiB after last-30-lines slicing). | P1 | Preserve the alert-size guarantee. |
| FR-003 | When only one stream produced output, the block MUST render that stream's tail; the empty stream MUST NOT be rendered as a bare `(empty)` line that competes for reader attention. | P1 | Fixes the observed "stderr: (empty)" failure mode. |
| FR-004 | When both streams produced output, the block MUST render both tails in a form that keeps the byte bound. Preferred: a single chronologically-interleaved tail. Fallback: separately-labeled stdout and stderr tails. | P1 | Interleave-vs-split is a design choice for /clarify or /plan. |
| FR-005 | The `PhaseResult.error` (or equivalent carrier) MUST expose captured stdout alongside stderr so `buildErrorEvidence` has something to bound. | P1 | Requires plumbing at the spawn/pipe layer, not just the evidence builder. |
| FR-006 | Existing `CommandExitEvidence` consumers (stage comment renderer, failure-alert composer #865) MUST render the new shape without regressing their current output on stderr-only failures. | P1 | Backwards-compatible on the happy path. |
| FR-007 | Empty-both-streams case MUST still render a single, unambiguous empty marker rather than two separate `(empty)` lines. | P2 | Cosmetic but reader-visible. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Alerts for stdout-only failures contain the actual error text. | 100% of stdout-only fixture failures. | Regression test: `next build` type-error fixture → evidence block contains the offending `Type error:` line. |
| SC-002 | Evidence block total size stays within the #847 bound. | ≤ 4 KiB (or whatever #847 sets) for all fixture cases including both-stream large-output. | Byte-length assertion in tests. |
| SC-003 | No alert reads `(empty)` when the process produced output on either stream. | 0 occurrences across the fixture matrix. | Regression test scans the rendered alert text. |
| SC-004 | Retroactively, re-running the christrudelpw/sniplink#6 scenario against the fixed builder yields an alert containing `Cannot find module '@/components/CopyButton'`. | Present in evidence. | Reproduction fixture (canned stdout capture) fed through `buildErrorEvidence`. |

## Assumptions

- The spawn layer already captures stdout somewhere (chunks are stored in `PhaseResult.output`); this feature makes that capture visible to `buildErrorEvidence`, or extends `error` with a stdout tail alongside `stderr`.
- The #847 byte bound and last-30-lines slicing policy remain the intended shape; this feature broadens what is bounded, not how.
- Downstream renderers (`StageCommentManager.renderStageComment`, failure-alert composer) live in this repo and can be updated in the same change.

## Out of Scope

- Changing the byte-bound established in #847.
- Structured output parsing (e.g., extracting the `Type error:` line specifically) — this feature just widens capture, not intelligence.
- Streaming/live-tail of output — evidence is a post-hoc tail.
- Non-command-exit failure paths (merge-conflict variant, no-progress guard beyond its current stderr synthesis) unless FR-005 requires touching them.
- Cross-tool normalization (Next.js vs. vitest vs. npm output formatting).

---

*Generated by speckit*
