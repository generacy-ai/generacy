# Clarifications — #916

## Batch 1 — 2026-07-11

### Q1: LabelSyncService classification (FR-004)
**Context**: The spec explicitly flags FR-004 as "Clarification needed." `LabelSyncService.syncRepo` and `LabelManager.ensureRepoLabelsExist` are the two provisioning surfaces that both hit `createLabel` against `WORKFLOW_LABELS`. `LabelManager` gets a classification rewrite (FR-003); `LabelSyncService` currently has a top-level `try/catch` that marks the whole repo `success: false` on the first failure. The spec asks us to record a decision, not defer it.
**Question**: How should `LabelSyncService.syncRepo` handle `createLabel` failures relative to `LabelManager.ensureRepoLabelsExist`?
**Options**:
- A: Extract the classification into a shared helper (e.g. `classifyLabelProvisioningError` in `packages/workflow-engine/src/actions/github/`) and use it in both surfaces so `LabelSyncService` also distinguishes race vs error at the per-label loop and continues past races. `success: false` still returns on any classified error.
- B: Leave `LabelSyncService.syncRepo` as-is (top-level catch, `success: false` on first failure of any kind). Document in the spec that the two surfaces have different loudness contracts because `LabelSyncService` runs once at boot and its caller already treats `success: false` as loud enough.
- C: Migrate `LabelSyncService.syncRepo` to per-label try/catch with race classification only (continue on race, return `success: false` with a specific error field on non-race). No shared helper — inline check for the `already exists` substring in each surface.

**Answer**: A — shared `classifyLabelProvisioningError` helper used by both surfaces. Two surfaces classifying the same error family with independent inline substring checks (C) is a drift factory — this very bug is what provisioning-surface divergence looks like. B leaves the boot-time sync calling a healthy startup race `success: false`. One classification, one home, both consumers.

### Q2: Apply-time 404 lineage (FR-008)
**Context**: The spec explicitly flags FR-008 as "Clarification needed on scope." When `addLabels('blocked:stuck-*')` returns 404 later at apply time, the spec's minimum bar is that FR-003's error log lets an operator grep-trace it to the earlier provisioning failure. The higher bar is that the thrown `addLabels` error itself references the provisioning-failure lineage — requires tracking failed-labels state across ensure-pass → addLabels.
**Question**: Which lineage-tracking bar should FR-008 land at in this PR?
**Options**:
- A: **Log-only (minimum bar)**. FR-003's classified error log is the only lineage — `addLabels` throws the raw 404 with no additional context. Operator greps worker logs to correlate. FR-008 becomes a documentation note, not a code change.
- B: **In-memory lineage map**. `LabelManager` maintains a `Map<repoKey, Map<labelName, provisioningError>>` populated by the classified-error branch of `ensureRepoLabelsExist`. `addLabels` checks the map on 404 and enriches the thrown error's message with the provisioning-failure cause. Cleared alongside cache-invalidation (FR-005).
- C: **Structured error object**. Introduce a `ProvisioningFailedError` class thrown by `addLabels` when the target label is in `WORKFLOW_LABELS`, was previously classified as a non-race failure, and now returns 404. Callers (label-monitor, phase-loop) can pattern-match on the class for structured surfacing.

**Answer**: B — in-memory lineage map, with A as the implicit floor. The consumer is an operator (or auto session) reading an apply-time 404 — B puts the provisioning cause in the error message right where they're looking, at the cost of a map keyed alongside the existing caches and cleared with FR-005 invalidation. Cross-process gaps (the ensure-pass ran in a different process) degrade gracefully to the raw 404 plus FR-003's log — A's floor is always there. C mints a typed error class no caller pattern-matches on today; speculative typing.

### Q3: In-flight cache and concurrent callers (FR-005)
**Context**: `ensureRepoLabelsExist` has two static caches: `ensuredRepos` (Set of repos where the pass completed) and `ensureInFlight` (Map of shared Promises for concurrent callers). FR-005 says the repo should stay unmarked in `ensuredRepos` if any label failed non-race, so the next call re-attempts. What's unstated: how should the shared in-flight Promise resolve for concurrent callers awaiting it?
**Question**: When the ensure-pass classifies at least one non-race failure, how should the shared in-flight Promise resolve for concurrent callers?
**Options**:
- A: **Resolve normally (no signal)**. Concurrent callers await success just like today — the pass didn't throw, so the shared Promise resolves. `ensuredRepos` stays unmarked, so the next non-concurrent caller re-attempts. Concurrent callers get no direct signal but pick up the next attempt on their next phase completion.
- B: **Reject with a summary error**. The shared Promise rejects if any label failed non-race, propagating the classified error(s) to every concurrent awaiter. Each awaiter then decides whether to retry or bail (matches "fail loud" ethos in the spec's US1 rationale).
- C: **Resolve with a failure signal**. Change the ensure-pass return type to `Promise<{ ok: boolean; failedLabels: string[] }>` so concurrent callers can inspect. Callers currently ignore the return value; this option changes the ensure-pass API.

**Answer**: A — resolve normally; the unmarked repo drives the retry. B is fail-loud applied to the wrong channel: rejecting the shared promise converts one optional label's 422 into failures for every concurrent phase run — phases that likely never touch `blocked:stuck-*` — which is a worse outage than the bug (the observed incident ran a whole epic to completion with these labels missing). Loudness belongs in the FR-003 error log and the Q2 lineage, not in control flow. C changes an API so that ignored return values can keep being ignored.

### Q4: Shortened description content (FR-001)
**Context**: FR-001 requires shortening `blocked:stuck-feedback-loop` (118→≤100), `blocked:stuck-validate-fix` (172→≤100), and `blocked:stuck-merge-conflicts` (174→≤100). The spec says "preserve `#892`/`#898` refs where possible, drop the 'Remove this label to permit another attempt' boilerplate in favor of a compact directive," but doesn't specify the actual replacement text. Descriptions are informational-only (no code parses them).
**Question**: What content shape should the shortened descriptions take?
**Options**:
- A: **Terse cause only, no directive, keep issue ref**. Examples (each ≤100):
  - `blocked:stuck-feedback-loop`: `PR-feedback loop paused: last cycle could not advance the trigger. Remove to retry.`
  - `blocked:stuck-validate-fix`: `Validate-fix paused (#892): duplicate evidence, no-diff, or sibling overlap. Remove to retry.`
  - `blocked:stuck-merge-conflicts`: `Merge-conflict resolver (#898) exhausted its one autonomous attempt. Remove to retry.`
- B: **Cause only, no "remove to retry" directive, keep issue ref**. Slightly terser, relies on the label name itself to imply remedy. Example: `Validate-fix paused (#892): duplicate evidence, no-diff, or sibling overlap.`
- C: **Cause + issue ref only, drop everything else and lean on stage comment**. Very short, e.g. `Validate-fix stuck (#892). See stage comment.` Matches `waiting-for:merge-conflicts`' existing pattern (`Base-merge conflict. See stage comment for the manual remedy.`).

**Answer**: A — terse cause + "Remove to retry" directive + issue ref. The description is the one place the remedy can live inline where an operator actually encounters the label (the GitHub UI), and "remove this label to retry" is the entire operational contract of a `blocked:*` label. B makes the remedy implicit; C adds an indirection hop to the stage comment for exactly the reader least likely to know where that is.

### Q5: Log level for race path
**Context**: FR-003 and FR-007 refer to the race path as "warn/debug" interchangeably. Current code uses `warn` (`label-manager.ts:336`). SC-004 says "warn/debug log on `already exists`." A choice matters because operators may filter on warn but not debug, and healthy repos routinely race on first phase-loop startup — a persistent warn is noise-tier signal.
**Question**: What log level should the race (`already exists`) path use after the classification rewrite?
**Options**:
- A: **Warn (preserve current)**. Zero change to visibility; operators who already tolerate today's race noise see identical output. The visible signal delta is: the wrong-cause message text is corrected to acknowledge it's a race, not the same swallowed-422.
- B: **Debug**. Healthy race is not operator-actionable; move it below the default filter. Non-race errors are the only thing at warn+ from this catch. Reduces log volume on healthy clusters running many workers per repo.
- C: **Warn with sampling / once-per-repo**. Log warn on the first race per (owner, repo) in a process, then debug for subsequent races within that repo. Preserves discoverability without the noise.

**Answer**: B — debug. A healthy multi-worker startup races by design; a signal that fires on every healthy boot is noise-tier by definition and trains operators to ignore warns. Post-rewrite, the only warn+ emission from this catch is a real classified failure — that is the visibility improvement. C builds sampling machinery for an event with no operator action attached.
