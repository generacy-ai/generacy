# Research: Repeat-Identical Phase Failure Detection (#942)

## R1. Where terminal-failure alerts are posted today

`packages/orchestrator/src/worker/phase-loop.ts` posts a bottom-of-thread `failure-alert` comment via `StageCommentManager.postFailureAlert()` at **six** distinct sites (line numbers approximate):

| # | Site | Classifier |
|---|------|------------|
| 1 | pre-validate install failure (~332) | shell-command exit |
| 2 | unexpected spawn error (~443) | `spawn-error` |
| 3 | post-phase failure (~502) | classifier from CLI or shell exit |
| 4 | phase-command real failure (~626) | shell-command exit / CLI failure |
| 5 | product-diff detection failure (~678) | `product-diff-error` |
| 6 | no-product-code-changes guard (~710) | `no-product-code-changes` |

Site #6 is the exact one that fired identically 3× on snappoll#8.

Each site follows the same shape:
```ts
await labelManager.onError(phase);
const evidence = this.buildErrorEvidence(...);
await stageCommentManager.updateStageComment({ ..., errorEvidence: evidence });
await stageCommentManager.postFailureAlert({ stage, runId, phase, evidence });
return { results, completed: false, lastPhase: phase, gateHit: false };
```

**Decision**: extract the 4-line pattern into a private `escalateAndAlert()` helper so the fingerprint+count wiring lands in one place. Alternative (inline at each site) rejected — 6× duplication is a known future-drift trap; the current site-by-site inline is already a code-smell.

## R2. Failure alert comment marker format (v1, byte-preserved)

From `stage-comment-manager.ts:338`:
```
<!-- generacy:failure-alert:${data.stage}:${data.runId} -->
```

Dedup at `stage-comment-manager.ts:346` uses `comments.find((c) => c.body.includes(marker))` — a substring match on the *runId-terminated* marker. Any format bump that keeps this substring intact preserves the existing dedup behavior on re-fired same-`runId` alerts.

**Decision**: append a second `<!-- fp:HEX:N -->` HTML comment on the **same first line, space-separated**, rather than replacing the marker. This preserves the `runId` substring dedup and is trivially detectable by `parseFailureAlertMarker()` with a bounded regex. Alternative (multi-line marker with fingerprint on line 2) rejected — `getIssueComments` returns full body strings, so line 1 vs line 2 is cosmetic, but keeping everything on line 1 makes the invariant "marker is a prefix of line 1" grep-friendly for operators.

## R3. Fingerprint tuple options (Q1)

| Option | Tuple | Snappoll#8 collapses? | False-positive risk |
|--------|-------|------------------------|---------------------|
| A | `{ phase, classifier }` | ✅ | Two genuinely-different `no-product-code-changes` root causes (e.g. different repos, different missing files) collapse to one fingerprint → could escalate on genuinely distinct failures |
| B (**default**) | `{ phase, classifier, sha256(reason_text) }` | ✅ | Distinct reason texts inside one classifier → distinct fingerprints. Balanced. |
| C | `{ phase, classifier, sha256(reason_text + last_N_lines_of_output) }` | ✅ (if output is deterministic) | Under-matches when timestamps / PIDs / paths vary run-to-run in outputTail |

**Decision**: default to **B**. `evidence.reason` is populated for classifier-driven synthetic failures (`buildErrorEvidence` sets `reason: message` when `classifier` is passed), and the classifier itself is byte-stable. The choice is confined to `computeFailureFingerprint()` — swapping to A or C is a 3-line diff.

## R4. Fingerprint history persistence (Q2)

| Option | Mechanism | Pros | Cons |
|--------|-----------|------|------|
| A (**default**) | Scan GitHub `failure-alert` comment thread | Zero new state; tamper-visible audit; survives cluster rebuilds; matches `cockpit status` scan pattern | 1 extra `getIssueComments()` API call per failure (rate-limit budget: comfortable, already used) |
| B | Redis keyspace `failure-fp:<owner>:<repo>:<issue>:<fp>` → count | Sub-millisecond lookup; already-established `PhaseTrackerService` pattern | Lost on Redis restart / cluster rebuild → snappoll#8-shape defect could recur; requires availability-check + degrade-gracefully |
| C | Both (Redis fast path, GitHub audit backstop) | Best-of-both durability + speed | 2 write paths, coherence complexity |

**Decision**: default to **A**. The failure-alert path is already O(1) `postFailureAlert()` per failure (~seconds apart at the fastest — retry delay + queue latency) and rate-limit-wise the comment fetch is <100 comments per issue in the pathological case. Redis coupling adds a boot-order concern (fingerprint-tracker constructor must run *after* Redis client is ready) that A avoids entirely.

## R5. Threshold N (Q3→A: N=2)

Answered in `clarifications.md` Q3. Evidence: snappoll#8's three failures were byte-identical; escalating on the second saves one full wasted retry (~10 min) with zero information loss. N=1 would over-fire (single flake immediately escalates); N=3+ wastes retries the current bug is explicitly about.

**No open questions**.

## R6. Escalation label spelling (Q3→A)

Answered: `failed:<phase>-repeated`, SUPPLEMENTS `failed:<phase>` (both present).

Consumers to audit:
- `packages/orchestrator/src/worker/label-manager.ts` — `KNOWN_LABEL_PREFIXES` (if a whitelist exists) may need `failed:*-repeated`. Check `ensureRepoLabelsExist`.
- `packages/generacy/src/cli/commands/cockpit/status.ts` (or classifier) — the cockpit's error-tier already reacts to `failed:*` prefix; `-repeated` inherits the classification. Verify no exact-match `failed:<phase>` comparison exists.
- `packages/generacy/src/cli/commands/cockpit/resume.ts` — extended in this feature (per Q4→B).

## R7. Reversal via `cockpit resume` (Q4→B)

Answered: extend the existing `cockpit resume` (#891) label-removal list. Location per plan #891 §"Implementation Sequence" step 2: `labelsToRemove` array in `runResume()`. Add `failed:${phase}-repeated`. Idempotent — `gh label remove` no-ops if the label isn't present.

**No new cockpit verb**. Discoverability handled by extending the README's `### cockpit resume` block documented in plan #891.

## R8. Count-reset semantics (Q5→B)

Answered: resume the prior count. Fingerprint history lives in the GitHub comment thread (option A) — `cockpit resume` does **not** delete prior failure-alert comments, so the count naturally resumes on the next scan. Under option B/C, the tracker would need an explicit "do not clear the Redis counter on resume" note; under A it's zero-code.

## R9. Related prior art in the codebase

- `packages/orchestrator/src/services/phase-tracker-service.ts` — Redis-backed dedup with `Raw` key variants. Directly reusable for Q2→B.
- `packages/orchestrator/src/worker/stage-comment-manager.ts` — already scans issue comments for marker-based dedup. `postFailureAlert` at line 337 is the pattern to mirror for the fingerprint scan.
- `packages/orchestrator/src/worker/label-manager.ts` — `retryWithBackoff` wrapper around all label ops. Wrap `onRepeatedError` the same way; use site `error-repeated`.
- `specs/849-…/plan.md` — `PhaseTrackerService.clear` extension for pause-paired dedup clearing. Confirms the raw-key pattern is stable.
- `specs/891-…/plan.md` — `cockpit resume` design. The extension point (`labelsToRemove` array) is explicit in its step 2.
- `specs/865-…/contracts/failure-alert-comment.md` — the v1 marker contract. Format bump documented in this feature's `contracts/failure-alert-marker-v2.md`.

## R10. Sources

- Issue: https://github.com/generacy-ai/generacy/issues/942
- Evidence issue: `christrudelpw/snappoll#8` (three identical failure-alert comments at 23:30:57, 23:43:34, 00:02:30 UTC).
- Spec `specs/942-summary-when-phase-fails/spec.md`.
- Clarifications `specs/942-summary-when-phase-fails/clarifications.md`.
