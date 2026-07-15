# Implementation Plan: Detect repeat-identical phase failures and escalate instead of retrying verbatim

**Feature**: Fingerprint terminal phase-failure alerts and, on the Nth same-fingerprint failure for a given issue, apply an escalation label instead of allowing the retry loop to re-run the exact same phase with the exact same defective inputs. Verifiable end-to-end on the snappoll#8 replay: two identical failure alerts → `failed:implement-repeated` applied → third retry never fires.
**Branch**: `942-summary-when-phase-fails`
**Status**: Complete (open clarifications flagged below)

## Summary

Today `phase-loop.ts` posts a fresh failure-alert comment on every terminal failure (`stage-comment-manager.ts:337`) and `label-manager.onError()` toggles `failed:<phase>` + `agent:error` (`label-manager.ts:185`). External requeue (`process:speckit-feature`) starts a brand-new worker invocation with a new `runId` — nothing correlates alert N-1 to alert N, so an identical defective artifact can spend an unbounded number of retries producing byte-identical `failure-alert` comments. Evidence: snappoll#8, three verbatim `no-product-code-changes` failures inside 32 minutes.

The fix adds a **failure fingerprint** — a stable derived string that matches across worker invocations for the same underlying defect (same phase + classifier + reason text) — and, at each of the six `postFailureAlert()` call sites in `phase-loop.ts`, checks how many prior alerts on this issue carry the same fingerprint. On the 2nd occurrence (per Q3→A), `LabelManager` applies `failed:<phase>-repeated` **in addition to** `failed:<phase>` before the alert comment is posted. The comment marker is extended to carry the fingerprint hex + occurrence counter so operators can see "attempt 3 of the same defect" without diffing bodies (spec §"Suggested fix" bullet 3).

Escalation is reversible via `cockpit resume <issue-ref>` (Q4→B): the existing verb's label-clearing step gains removal of `failed:<phase>-repeated` alongside its existing `failed:<phase>` clear. Count semantics on clear are "resume, do not reset" (Q5→B) — the very next same-fingerprint failure re-escalates immediately, since the operator's implicit contract when clearing is "I repaired the input; verify with one attempt."

**Scope**: fingerprint derivation, per-issue history lookup, `LabelManager` extension for the new label, marker format bump for the failure-alert comment, extension of `cockpit resume` to clear the new label. No changes to the retry/requeue mechanism itself, to the worker's phase resolver, to the `process:*` label protocol, or to the alert-body format outside the marker line.

## Open Clarifications (still `<your answer>` in `clarifications.md`)

Two decisions gate the exact shape of `computeFailureFingerprint()` and the storage-lookup code path. The plan below picks working defaults so `/tasks` can proceed, but these must be re-confirmed before implementation lands:

- **Q1 (fingerprint granularity)** — Default assumed: **B**, `{ phase, classifier, sha256(reason_text) }`. Justification: coarse enough to collapse snappoll#8's byte-identical failures into one fingerprint; fine enough that two genuinely different reasons inside one classifier (e.g. two distinct `no-product-code-changes` messages) don't false-positive. Option C (adds output tail) risks under-matching when a timestamp or PID slips into the tail. If the operator picks A or C, the only code delta is inside `computeFailureFingerprint()`; the storage/label/marker paths are unchanged.
- **Q2 (fingerprint history persistence)** — Default assumed: **A**, scan the issue's GitHub `failure-alert` comment thread and extract fingerprints from an extended marker. Justification: (1) the alerts are already the tamper-visible audit surface, (2) survives cluster rebuilds and issue requeues that reset Redis, (3) matches how `cockpit status` already reads state, (4) no new Redis keyspace or availability dependency. Downside: one extra `getIssueComments()` call per terminal failure (rate-limit budget already tolerates comment-scans in `stage-comment-manager.postFailureAlert`). If the operator picks B (Redis) or C (both), the delta is inside a new `FailureFingerprintTracker` service and its constructor wiring in `server.ts`; the fingerprint derivation and label-escalation paths are unchanged.

Both defaults are chosen so the *rest of the plan is stable* under either resolution — `/tasks` can be generated now and the two branches show up as at-most-2 tasks each in the T-numbered list.

## Technical Context

- **Language / runtime**: TypeScript, Node.js >=22, ESM. Packages `@generacy-ai/orchestrator` (`packages/orchestrator`), `@generacy-ai/generacy` (`packages/generacy`).
- **Failure-alert emitter**: `packages/orchestrator/src/worker/stage-comment-manager.ts` — `postFailureAlert(FailureAlertData)`. Marker prefix `FAILURE_ALERT_MARKER_PREFIX` at `packages/orchestrator/src/worker/types.ts:106`.
- **Failure-alert call sites** (six, all in `packages/orchestrator/src/worker/phase-loop.ts`): pre-validate install failure (~332), unexpected spawn error (~443), post-phase failure (~502), phase-command failure (~626), product-diff detection failure (~678), no-product-code-changes guard (~710).
- **Evidence shape**: `CommandExitEvidence = { command, exitDescriptor, outputTail, reason? }` (`packages/orchestrator/src/worker/types.ts:338`). `exitDescriptor` carries the classifier as `failed post-exit: <classifier> (process exit N)` (`phase-loop.ts:1065`); `reason` carries the classifier's human-readable message.
- **Label protocol**: `LabelManager.onError(phase)` adds `failed:<phase>` + `agent:error`, removes `phase:<phase>` + `agent:in-progress` (`label-manager.ts:185-201`). Retries with exponential backoff via `retryWithBackoff`.
- **Cockpit resume**: `packages/generacy/src/cli/commands/cockpit/resume.ts` (per plan #891). Extend its label-removal step; no new verb needed (Q4→B).
- **Comment API**: `github.getIssueComments(owner, repo, issue)` + `github.addIssueComment(...)` — already used by `stage-comment-manager.ts:340-361`.
- **Redis (contingency for Q2→B/C only)**: `PhaseTrackerService` pattern at `packages/orchestrator/src/services/phase-tracker-service.ts` — `raw`-key variants (`isDuplicateRaw` / `markProcessedRaw`) already support caller-owned keyspaces.
- **Test runner**: Vitest (`packages/orchestrator/vitest.config.ts`, `packages/generacy/vitest.config.ts`).
- **New dependencies**: none. `crypto.createHash('sha256')` is the only new primitive.

## Constitution Check

No `.specify/memory/constitution.md` exists — no project-level constitutional constraints to verify. The change respects standing generacy conventions:

- **Additive-only**: extends `FailureAlertData` and the marker line; existing consumers reading marker via `.includes(FAILURE_ALERT_MARKER_PREFIX + stage + ':' + runId)` remain byte-compatible (the extension is appended after the runId-terminated `-->` in a second HTML comment on the same first line, OR — chosen shape — on line 2 as a sibling marker; see Design §"Marker format").
- **No worker/resolver changes**: `PhaseResolver.resolveFromContinue` is untouched. The escalation label sits alongside `failed:<phase>`, so existing `failed:*` watchers (including cockpit's error-tier classifier) continue to fire (Q3→A).
- **Cross-package coupling only through exported symbols**: cockpit resume already imports from `@generacy-ai/orchestrator/worker/phase-resolver`; extending its label-clear list is a same-file edit.
- **Fail-forward**: fingerprint lookup failure (GitHub API 5xx, Redis unavailable) is logged and treated as "no prior alerts" — never blocks the alert-post path, never fails-closed into no-escalation-forever. The pre-existing retry loop remains the correctness backstop.
- **Loud on partial mutation**: if `LabelManager.applyLabels([failed:<phase>-repeated, ...])` succeeds but the subsequent `postFailureAlert` throws, the issue ends the invocation carrying the escalation label but no comment — recovered by the same `try/catch` shape `stage-comment-manager` uses today.

## Project Structure

```
packages/orchestrator/
├── src/
│   ├── worker/
│   │   ├── phase-loop.ts                                # MODIFIED — pass fingerprint into postFailureAlert at 6 sites; call new tracker before label-manager.onError
│   │   ├── stage-comment-manager.ts                     # MODIFIED — extended marker format; expose parseFailureAlertMarker for the tracker
│   │   ├── label-manager.ts                             # MODIFIED — new onRepeatedError(phase) that supplements failed:<phase> with failed:<phase>-repeated
│   │   ├── types.ts                                     # MODIFIED — FailureAlertData gains fingerprint: string, occurrence: number; FAILURE_ALERT_MARKER_V2 constant
│   │   ├── failure-fingerprint.ts                       # NEW — computeFailureFingerprint(evidence, phase): string (pure); parseFailureAlertMarker(commentBody): { fingerprint, occurrence } | null
│   │   └── __tests__/
│   │       ├── failure-fingerprint.test.ts              # NEW — tuple stability, classifier extraction from exitDescriptor, sha256 of reason
│   │       ├── phase-loop-repeat-failure.test.ts        # NEW — 2nd identical failure applies failed:<phase>-repeated, 3rd does NOT retry; different classifier resets
│   │       ├── stage-comment-manager.test.ts            # MODIFIED — extend BASE_ALERT with fingerprint fields; assert v2 marker shape
│   │       └── label-manager.test.ts                    # MODIFIED — new onRepeatedError() case
│   └── services/
│       └── failure-fingerprint-tracker.ts               # NEW (Q2→A default) — countPriorOccurrences(owner, repo, issue, fingerprint): Promise<number>, backed by github.getIssueComments
│                                                        # OR (Q2→B/C branch) — Redis-backed via PhaseTrackerService.isDuplicateRaw with key failure-fp:<owner>:<repo>:<issue>:<fp>

packages/generacy/
└── src/cli/commands/cockpit/
    └── resume.ts                                        # MODIFIED — extend label-removal list to include failed:<phase>-repeated; single-line docstring update
    └── __tests__/
        └── resume.test.ts                               # MODIFIED — new case: repeated-escalation label is cleared by resume
```

Full source-tree impact: **6 files touched in orchestrator, 2 in generacy, 4 new files**. No package.json changes. No new dependencies.

## Design

### Fingerprint derivation (`failure-fingerprint.ts`)

`computeFailureFingerprint({ phase, evidence }): string` — returns a lowercase hex sha256 digest.

Under Q1→B (default):
```
input = `${phase}${classifier}${reason_text}`
fingerprint = sha256(input).slice(0, 16)   // 16-char hex prefix — sufficient collision resistance for per-issue scan
```

`classifier` is extracted from `evidence.exitDescriptor`:
- `failed post-exit: <cls> (process exit N)` → `<cls>` (matches all 6 classifier sites: `no-product-code-changes`, `product-diff-error`, and pre-existing `spawn-error`, `no-progress`, others).
- `killed (SIGTERM) after Nms` → `timeout`.
- `aborted` → `aborted`.
- `exit N` → `exit-N`.

`reason_text` is `evidence.reason ?? evidence.outputTail` — `reason` is populated for classifier-driven synthetic failures (Q1→B safely ignores outputTail for those; and for real non-zero exits the outputTail is the diagnostic surface, so we do fall through to it). Timestamps / per-run tail noise are absorbed by the classifier bucket in the first tuple element.

Under Q1→A: drop the sha256 term entirely. Under Q1→C: append `${sha256(evidence.outputTail.split('\n').slice(-30).join('\n'))}`.

### Marker format bump (v2)

Existing v1 marker (byte-identical to snappoll#8):
```
<!-- generacy:failure-alert:implementation:64aabe7b-... -->
```

New v2 marker adds a second HTML comment on the same first line, so the *existing* runId-based dedup at `stage-comment-manager.ts:346` continues to match on `.includes(marker)` unchanged:
```
<!-- generacy:failure-alert:implementation:64aabe7b-... --> <!-- fp:9c4d3e2a1b0f8a7b:2 -->
```

The second marker carries `fp:<fingerprint-hex>:<occurrence-count>`. `parseFailureAlertMarker(commentBody)` scans line 1 with the regex `/<!-- fp:([0-9a-f]{16}):(\d+) -->/` and returns `null` when absent (all pre-#942 alerts).

### Tracker (Q2→A default)

`FailureFingerprintTracker.countPriorOccurrences(owner, repo, issue, fingerprint): Promise<number>`:

1. Call `github.getIssueComments(owner, repo, issue)`.
2. For each comment where body starts with `FAILURE_ALERT_MARKER_PREFIX`, run `parseFailureAlertMarker(body)`.
3. Return the count of matches on `fingerprint`.

Failure mode: any thrown error → log warn, return 0 (treated as "first occurrence, do not escalate"). Never propagates; the alert post still happens.

### Wiring (`phase-loop.ts`)

At each of the six failure sites, after `buildErrorEvidence()` but before `postFailureAlert()`:

```ts
const fingerprint = computeFailureFingerprint({ phase, evidence });
const priorCount = await tracker.countPriorOccurrences(item.owner, item.repo, item.issueNumber, fingerprint);
const occurrence = priorCount + 1;

await labelManager.onError(phase);
if (occurrence >= REPEAT_THRESHOLD) {   // REPEAT_THRESHOLD = 2 per Q3→A
  await labelManager.onRepeatedError(phase);
}
await stageCommentManager.postFailureAlert({ stage, runId, phase, evidence, fingerprint, occurrence });
```

The escalation label is applied *before* the alert is posted, so the operator sees a coherent post-mutation state on the issue.

**Note on retry loop interaction**: this plan does **not** modify the requeue path. The escalation label `failed:<phase>-repeated` is a signal to cockpit + operators, not a hard block. If external retry logic (`process:*` label re-application) is triggered again, the next failure will re-fingerprint, find `priorCount === 2`, and re-apply the escalation label idempotently (`applyLabels` de-dupes). Halting the auto-retry itself is out of scope for #942 and belongs to a cockpit-auto follow-up that observes the `failed:*-repeated` label.

### Cockpit resume extension

`packages/generacy/src/cli/commands/cockpit/resume.ts` — locate the `labelsToRemove` array (per plan #891 §"Implementation Sequence" step 2) and add:
```ts
`failed:${phase}-repeated`,
```
Cleanup is best-effort (label may not exist — `gh label remove` is idempotent). No behavioral change on happy path; the docstring mentions the additional removal.

## Implementation Sequence

1. **Fingerprint primitive first** — write `failure-fingerprint.ts` with `computeFailureFingerprint` + `parseFailureAlertMarker`. Full unit tests (Q1→B tuple stability, classifier extraction from all 4 exitDescriptor shapes, marker parse/round-trip). Zero external deps at this step.
2. **Marker v2 in stage-comment-manager** — extend `FailureAlertData` (types.ts), thread `fingerprint` + `occurrence` into `renderFailureAlert`. Add `FAILURE_ALERT_MARKER_V2_REGEX` to types.ts. Extend `stage-comment-manager.test.ts` BASE_ALERT with the new fields and assert the second marker appears exactly once on line 1.
3. **Tracker** — implement Q2→A default (`FailureFingerprintTracker` with `github.getIssueComments` scan). Unit tests: 0 prior → 1, 1 prior → 2, comment without v2 marker → skipped, throw → 0. If Q2→B/C is picked, swap the constructor for `PhaseTrackerService.isDuplicateRaw` + a `Map<fingerprint, count>`-side counter.
4. **LabelManager escalation** — add `onRepeatedError(phase)`: mirror `onError` but only adds `failed:<phase>-repeated`, does not remove anything. Guarded by `ensureRepoLabelsExist` (extend `KNOWN_LABEL_PREFIXES` if a whitelist gates it). `retryWithBackoff` wrapper with site `error-repeated`.
5. **phase-loop wiring** — at each of the 6 sites, insert the fingerprint+count+escalate block described above. Extract to a private helper `escalateAndAlert(phase, evidence, stage, runId)` so the six sites collapse to one call each.
6. **cockpit resume extension** — one-line change to `labelsToRemove` in `resume.ts`; one new test case in `resume.test.ts`.
7. **End-to-end regression** — `phase-loop-repeat-failure.test.ts`: stub `github.getIssueComments` to return 0, then 1, then 2 v2-marked comments in sequence; assert (a) no `failed:*-repeated` label on the first two calls, (b) label applied on the third call, (c) different classifier on the third call resets the count and does NOT escalate.

## Complexity Tracking

No constitutional violations. Sole complexity note: the marker-v2 sibling on line 1 is a deliberate byte-additive extension (not a replacement) so the existing `runId`-based dedup in `stage-comment-manager.postFailureAlert` (`stage-comment-manager.ts:346`) continues to match unchanged. The alternative — bumping the entire marker format — would break any historical-comment scan that hardcodes the v1 shape.
