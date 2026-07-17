# Quickstart: Repeat-Identical Phase Failure Detection (#942)

## What this feature does

When a phase (`implement`, `tasks`, `validate`, …) fails inside the same issue **twice in a row with the same underlying defect**, the second failure applies a new label — `failed:<phase>-repeated` — alongside the existing `failed:<phase>`. Operators see a clear signal: "the retry loop won't help; repair the upstream artifact before requeuing."

Without this feature, an issue whose generated `tasks.md` is defective can spend an unbounded number of retries producing byte-identical failure-alert comments (evidence: snappoll#8, three identical `no-product-code-changes` failures in 32 minutes).

## Trigger conditions

The escalation label fires when **all** of these are true on the same issue:

1. A phase reaches one of the six terminal-failure sites in `phase-loop.ts`.
2. A prior failure-alert comment on the issue carries a matching **fingerprint** (same phase + classifier + reason text — the tuple is stable across worker requeues and cluster restarts).
3. The count of matching prior alerts is `≥ 1` (threshold N=2 — this failure is the 2nd).

## What the operator sees

### Labels

Before this feature:
```
agent:error
failed:implement
```

After this feature (on the 2nd identical failure):
```
agent:error
failed:implement
failed:implement-repeated   ← NEW
```

### Failure-alert comment marker

Line 1 of the failure-alert comment gains a fingerprint + occurrence counter:
```
<!-- generacy:failure-alert:implementation:5e6e1169-... --> <!-- fp:9c4d3e2a1b0f8a7b:2 -->
```

`:2` means "second failure with this fingerprint." An operator running `gh issue view` can grep for `<!-- fp:` and see the fingerprint history at a glance without diffing bodies.

## Reversal: `cockpit resume`

The existing `generacy cockpit resume <issue-ref>` (#891) is extended to clear the new label alongside its existing label cleanup. No new verb.

```
$ generacy cockpit resume owner/repo#123
Cleared: agent:error, failed:implement, failed:implement-repeated, phase:implement
Applied: waiting-for:tasks-review, completed:tasks-review, agent:paused
```

The next same-fingerprint failure re-escalates immediately (count "resumes" rather than "resets" — the operator's implicit contract on `resume` is "I repaired the input; verify with one attempt"). If the operator's fix worked, the fingerprint changes (or the phase passes) and the count never re-fires.

## Manual label removal (fallback if cockpit not available)

```
gh issue edit 123 --remove-label failed:implement-repeated
```

This clears the escalation signal only — the underlying `failed:implement` remains until a retry re-runs the phase. Combine with `--remove-label failed:implement` + `--add-label process:speckit-feature` to force a manual requeue.

## Where the code lives

| Concern | File |
|---------|------|
| Fingerprint derivation | `packages/orchestrator/src/worker/failure-fingerprint.ts` (new) |
| Fingerprint history lookup | `packages/orchestrator/src/services/failure-fingerprint-tracker.ts` (new) |
| Marker v2 render + parse | `packages/orchestrator/src/worker/stage-comment-manager.ts` (modified) |
| Label escalation | `packages/orchestrator/src/worker/label-manager.ts` — `onRepeatedError()` (new method) |
| Wire-up (six sites) | `packages/orchestrator/src/worker/phase-loop.ts` (modified) |
| Reversal | `packages/generacy/src/cli/commands/cockpit/resume.ts` (extend `labelsToRemove`) |

## Configuration

None. Threshold N=2 is hard-coded (`REPEAT_FAILURE_THRESHOLD` constant per Q3→A resolution — spec explicitly rules out per-workflow overrides for v1).

## Troubleshooting

### The escalation label doesn't apply on the 2nd failure

Check the failure-alert comments on the issue:
```
gh issue view 123 --comments | grep -E '<!-- generacy:failure-alert|<!-- fp:'
```

- If line 1 of each comment shows a `<!-- fp:HEX:N -->` marker, the tracker is working. Compare fingerprints: if they differ, the failures are not "identical" by the tuple `{ phase, classifier, reason_text }`.
- If line 1 has no `<!-- fp:` marker on any comment, the feature is not deployed in the running orchestrator. Redeploy.
- If line 1 has the fingerprint on comment 1 but is missing on comment 2, the `stage-comment-manager` render path didn't get the fingerprint threaded. Bug — check `phase-loop.ts` at the specific site that generated comment 2 (the six sites are enumerated in `research.md` R1).

### The escalation label applies but the retry still fires

Expected — the escalation label is a **signal**, not a hard block. The retry loop (`process:*` label re-application via cockpit-auto or manual `gh label add`) is not intercepted by this feature. Halting auto-retry on `failed:*-repeated` is a follow-up in cockpit-auto (`auto.md` D.7/D.8).

### Fingerprint differs between two visibly-identical failures

Two possible causes:
- **`reason` vs `outputTail`** — real non-zero exit failures use `outputTail` for the fingerprint's reason text; classifier-driven synthetic failures use `evidence.reason`. If two failures cross this boundary they will have different fingerprints. This is intended: a real exit and a synthetic guard are different root causes.
- **Timestamp / PID / path in reason text** — under Q1→B (default), any variance in the reason text produces a new fingerprint. If this bites, Q1→A (classifier-only) is the coarser knob; discuss before flipping.

## Running the tests

```
pnpm --filter @generacy-ai/orchestrator test failure-fingerprint
pnpm --filter @generacy-ai/orchestrator test phase-loop-repeat-failure
pnpm --filter @generacy-ai/generacy test resume
```
