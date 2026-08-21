# Implementation Plan: Resume label-strip makes the remediation-limit and on-ci-green approval gates un-answerable

**Feature**: Preserve human-answer gate completions across the resume label-strip so the remediation-limit and on-ci-green implementation-review gates become answerable
**Branch**: `1154-severity-critical-p0-both`
**Status**: Complete
**Issue**: [generacy-ai/generacy#1154](https://github.com/generacy-ai/generacy/issues/1154) | **Epic**: [#1153](https://github.com/generacy-ai/generacy/issues/1153) (follow-up to [#1120](https://github.com/generacy-ai/generacy/issues/1120))

## Summary

`LabelManager.onResumeStart()` runs on every `continue` command before the phase loop and strips `completed:<X>` for every co-present `waiting-for:<X>` gate. Pre-epic gates survived because their `GATE_MAPPING` resume phase is *past* the gate, so the phase loop never re-checked the stripped label. The two new epic gates (`remediation-limit`, on-ci-green `implementation-review`) re-evaluate **at the resumed phase** and depend on the surviving `completed:<X>` label — so the strip silently discards the operator's answer and the workflow re-parks.

The fix is a small, targeted set of changes that reuse machinery already present in the codebase:

1. **FR-001** — Guard the completed-strip in `onResumeStart()` with the existing `isHumanGateCompletion()` predicate so human-answer gate completions survive; stale `waiting-for:*` and `agent:paused` removals are unchanged.
2. **FR-004** — Add `ci` to `GATE_MAPPING` as `{ phase: 'validate', resumeFrom: 'validate' }`, which auto-includes it in the derived `HUMAN_GATE_SUFFIXES` and gives `completed:ci` a defined resume phase (no more full-revalidate fallback).
3. **FR-002 / FR-003** — No logic change: the remediation-limit reset+re-arm branch and the CI-merge terminal no-op short-circuit both become reachable once FR-001 preserves the labels they read.
4. **FR-005** — Add a hidden marker + `listPrCommentBodies` grep dedupe to the "Remediation limit reached" gate-body comment so a resume/re-pause cycle does not post duplicates.
5. **FR-006** — Add a defensive clear of `completed:remediation-limit` on any clean pass through the `review` phase so a lingering answer cannot silently pre-satisfy a future cap pause.
6. **FR-007** — Add an integration test that drives a resume through the **real** `onResumeStart()` strip for both P0 gates (existing unit tests bypass it, which is why this bug class was never caught).

Both P0 fixes sit behind the epic's existing feature flags (`reviewPhaseEnabled`, `ciMergeGateEnabled`); a flag-OFF cluster is unaffected.

## Technical Context

- **Language / runtime**: TypeScript (ESM), Node >= 22
- **Monorepo**: pnpm workspaces; primary package touched is `@generacy-ai/orchestrator`
- **Test framework**: Vitest
- **Key modules**:
  - `packages/orchestrator/src/worker/label-manager.ts` — owns `onResumeStart()`, `isHumanGateCompletion()`, `HUMAN_GATE_SUFFIXES`
  - `packages/orchestrator/src/worker/phase-resolver.ts` — owns `GATE_MAPPING` (the source `HUMAN_GATE_SUFFIXES` derives from)
  - `packages/orchestrator/src/worker/phase-loop.ts` — owns the terminal no-op short-circuit, the remediation-limit gate body + reset branch, and the clean-review side-effect block
  - `packages/orchestrator/src/worker/claude-cli-worker.ts` — call site for `onResumeStart()` on `continue`
- **GitHub client**: `context.github` is `GhCliGitHubClient` (`gh` / `gh api` shell-out); `addIssueComment` (`interface.ts:133`) and `listPrCommentBodies` (`interface.ts:313`) are the comment helpers used by FR-005.
- **Feature flags**: `reviewPhaseEnabled` / `WORKER_REVIEW_PHASE_ENABLED`; `ciMergeGateEnabled` / `WORKER_CI_MERGE_GATE_ENABLED`. Both default OFF.
- **Line references**: pinned at develop `155b3464` per the spec; the branch has diverged slightly (phase-loop offsets shifted), so implement against the *symbols* named here, not the raw line numbers.

## Project Structure

```
specs/1154-severity-critical-p0-both/
  spec.md                 # (read-only) authoritative requirements
  clarifications.md        # (read-only) Q1→A, Q2→A, Q3→B
  plan.md                  # this file
  research.md              # decisions + alternatives
  data-model.md            # label lifecycle + HUMAN_GATE_SUFFIXES membership
  quickstart.md            # how to run/verify
  contracts/
    onresumestart-strip.md # resume-strip behavior contract
    gate-mapping-ci.md     # GATE_MAPPING ci entry contract

packages/orchestrator/src/worker/
  label-manager.ts         # FR-001: guard completed-strip with isHumanGateCompletion()
  phase-resolver.ts        # FR-004: add ci to GATE_MAPPING
  phase-loop.ts            # FR-005: marker-dedupe gate comment; FR-006: defensive clear
  __tests__/
    label-manager.onresumestart.test.ts   # SC-003 (unit): human-gate completions retained
    phase-loop.resume-gates.integration.test.ts  # SC-001/SC-002 (FR-007): resume through real strip
    phase-resolver.ci-gate.test.ts          # SC-005: ci resolves + in HUMAN_GATE_SUFFIXES
    phase-loop.remediation-comment-dedupe.test.ts # SC-004: marker suppresses duplicate

.changeset/
  1154-resume-gate-strip.md  # @generacy-ai/orchestrator patch
```

## Change Detail

### FR-001 — `onResumeStart()` completed-strip guard (`label-manager.ts`)

In the completed-strip loop, guard the `labelsToRemove.push(completedLabel)` with `!this.isHumanGateCompletion(completedLabel)`:

```ts
for (const suffix of gateSuffixes) {
  const completedLabel = `completed:${suffix}`;
  if (
    currentLabels.includes(completedLabel) &&
    !labelsToRemove.includes(completedLabel) &&
    !this.isHumanGateCompletion(completedLabel)   // FR-001
  ) {
    labelsToRemove.push(completedLabel);
  }
}
```

Chosen over the FR-001 alternative (a pre-strip label snapshot threaded through the phase loop) — see research.md Decision 1. Stale `waiting-for:*` and `agent:paused` removals are untouched.

### FR-004 — add `ci` to `GATE_MAPPING` (`phase-resolver.ts`)

Add one entry after `remediation-limit`:

```ts
'ci': { phase: 'validate', resumeFrom: 'validate' },
```

`HUMAN_GATE_SUFFIXES` derives from `Object.keys(GATE_MAPPING)`, so `ci` becomes exempt from the FR-001 strip for free, and `completed:ci` now resolves a defined resume phase instead of relying on the full-revalidate fallback (Q2→A: re-run `validate` to re-verify CI green on the new head).

### FR-002 / FR-003 — no logic change

The remediation-limit reset+re-arm branch (`resetRemediationCount` + `removeLabels(['completed:remediation-limit'])`) and the terminal no-op short-circuit (requires both `completed:validate` and `completed:implementation-review`) already exist and are correct. They only fire once FR-001 stops the strip from removing the label they gate on.

### FR-005 — dedupe the remediation-limit gate comment (`phase-loop.ts`)

Prepend a hidden marker to the "Remediation limit reached" comment body and, before posting, grep existing PR comments for the marker:

```ts
const REMEDIATION_LIMIT_MARKER = '<!-- generacy-remediation-limit -->';
const body = `${REMEDIATION_LIMIT_MARKER}\n## Remediation limit reached\n...`;
const existing = await context.github.listPrCommentBodies(owner, repo, prNumber);
if (!existing.some((b) => b.includes(REMEDIATION_LIMIT_MARKER))) {
  await context.github.addIssueComment(owner, repo, issueNumber, body);
}
```

Same pattern as other engine-authored markers (`maybePostUntrustedNotice`). A second comment appears only for a genuinely new cap pause after the marker is cleared by a real resume cycle — see research.md Decision 3 for how "new pause" is distinguished.

### FR-006 — defensive clear on clean review pass (`phase-loop.ts`)

In the clean-review side-effect block (`phase === 'review' && result.success`), when the review verdict is `clean`, best-effort remove a lingering `completed:remediation-limit`:

```ts
if (artifact.verdict === 'clean') {
  await prManager.markReadyForReview(...);
  // FR-006: a consumed/lingering remediation-limit answer must not pre-satisfy a future cap pause
  try {
    const labels = await context.github.getIssueLabels(owner, repo, issueNumber);
    if (labels.includes('completed:remediation-limit')) {
      await context.github.removeLabels(owner, repo, issueNumber, ['completed:remediation-limit']);
    }
  } catch (err) {
    logger.warn({ err }, 'FR-006 defensive remediation-limit clear failed (non-fatal)');
  }
}
```

Distinct from and additional to FR-002's reset-branch removal (Q3→B).

### FR-007 — integration test through the real strip

New integration test constructs a `PhaseLoop` with real `LabelManager` + `onResumeStart()` and a fake `GitHubClient` that models label state, then:
- **SC-001**: adds `completed:remediation-limit` + `waiting-for:remediation-limit`, resumes, asserts the answer survives `onResumeStart`, the counter resets, the gate label is cleared, and the loop proceeds (no immediate re-pause on the same count).
- **SC-002**: adds `completed:implementation-review` with `completed:validate` present (ciMergeGate ON), resumes, asserts the terminal no-op short-circuit is taken and `validate` does not re-run.

## Constitution Check

No `.specify/memory/constitution.md` exists in this repository — constitution check skipped.

## Changeset

`.changeset/1154-resume-gate-strip.md` — `@generacy-ai/orchestrator` **patch**. All source changes (`label-manager.ts`, `phase-resolver.ts`, `phase-loop.ts`) are in the orchestrator package and add no new public exports. No new label vocabulary is introduced (`waiting-for:ci` / `completed:ci` already ship from #1133), so no `@generacy-ai/workflow-engine` bump. Verify at implement time with `pnpm changeset status`.

## Next Step

`/speckit:tasks` to generate the task breakdown.
