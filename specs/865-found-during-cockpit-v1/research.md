# Research: Failure-alert bottom-of-thread comment (#865)

## Problem Restatement

`#847` shipped the failure-evidence block — failing command, exit descriptor, and bounded stderr tail — inside the canonical stage comment on every `status: 'error'` transition. The rendering works. **The visibility does not.**

`StageCommentManager.updateStageComment` finds the existing stage comment (posted hours earlier at workflow start) and writes the new body via `github.updateComment` — an in-place edit. GitHub does not notify subscribers on comment edits, and the edited comment does not resurface at the bottom of the thread. On `christrudelpw/sniplink#3` (2026-07-08T20:59Z), the fully-rendered evidence block sat eleven comments up-thread. The on-call developer, watching the issue live, went to container logs to figure out why validate failed — the answer had been on the issue the whole time. **Shipped-but-buried is operationally the same as missing.**

## Evidence

### Observed failure (2026-07-08T20:59Z, `christrudelpw/sniplink#3`)

- Workflow started at 02:27Z. Stage comment posted at 02:27Z, twelve comments up-thread by the time validate failed.
- Validate failed at 20:59Z. `StageCommentManager` correctly wrote the evidence block into the existing stage comment via `github.updateComment` (from `#847`).
- The developer watching the issue subscribed via the GitHub UI. They received **no notification** for the edit.
- Developer's conclusion (verbatim from cockpit smoke test #29): *"validate failed and I'm not sure why."* Went to `docker exec` for container logs. The answer was already on the issue.

### Source verification (2026-07-08)

- **Root cause**: `packages/orchestrator/src/worker/stage-comment-manager.ts:99–114` — `updateStageComment` calls `github.updateComment`, which is a `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}` under the hood. GitHub's own docs confirm: **comment edits do not trigger notifications or activity feed entries.** The stage comment is byte-updated correctly; nobody sees it.
- **`buildErrorEvidence` producer**: `packages/orchestrator/src/worker/phase-loop.ts:607–621` — pure function on `PhaseLoop`, produces `{ command, exitDescriptor, stderrTail }`. Called at every terminal-error site *except* the no-progress site at line 278 (verified by grep for `errorEvidence:` inside `phase-loop.ts`; the line 278 `updateStageComment({ status: 'error', ..., prUrl: context.prUrl })` call has no `errorEvidence` argument).
- **Terminal-vs-intermediate branching**: `phase-loop.ts:331–351` — the intermediate `implement`-retry branch calls `updateStageComment({ status: 'in_progress', ... })`. The main terminal-error branch at line ~354 calls `updateStageComment({ status: 'error', ... })`. Alert gating on `status: 'error'` naturally excludes intermediate retries.
- **Existing dedup pattern**: `stage-comment-manager.ts:53–91` — `findOrCreateStageComment` reads `getIssueComments`, iterates the list, matches on `comment.body.includes(marker)`. This is the pattern Q2/A mirrors for the alert dedup.
- **`GitHubClient.addIssueComment`**: creates a new comment, returns `{ id }`. This is the API that fires the GitHub notification and puts the alert at the bottom of the thread. Confirmed by reading `stage-comment-manager.ts:78–83` (existing use).

## Decisions

### D1: Alert-comment posting mechanism

**Decision**: `stageCommentManager.postFailureAlert(...)` calls `github.addIssueComment` (NOT `github.updateComment`). This creates a fresh comment at the bottom of the thread, fires the GitHub notification, and populates the timeline preview.

**Rationale**: This is the *entire point of the fix*. Comment-edits are silent by design at GitHub. Any implementation that reuses the existing `updateStageComment` code path would produce a byte-correct render with zero notification — i.e., the exact bug this spec fixes.

**Rejected alternatives**:
- **Delete-and-repost the stage comment**: would notify, but destroys the canonical state table (FR-008 mandates preserving it) and breaks any external tooling that has cached the stage comment's ID.
- **Add an emoji reaction to trigger notification**: reactions do not notify all subscribers reliably (client-dependent), and the payload is invisible in the notification preview.

### D2: Occurrence granularity (Q1)

**Decision**: One alert per `runPhaseLoop` invocation that reaches a terminal-failure site. Multi-phase failures within one invocation share a single alert.

**Rationale**: The phase loop stops at the first phase failure in practice, so per-invocation and per-phase-within-invocation coincide today. Per-invocation is the simpler bright line, and it correctly matches "a re-trigger after resume is a new occurrence" — the developer must act again, so a fresh alert is right.

**Rejected alternatives**:
- Per phase name within an invocation (Q1 option B): would produce duplicate alerts only if the loop swallowed an error and continued to a second failing phase, which the current loop does not do.
- Per `updateStageComment({ status: 'error' })` call (Q1 option C): trivially wrong — the same error transition can produce multiple polls; this option would spam the thread and shift the entire dedup burden to the marker search.

### D3: De-duplication mechanism (Q2)

**Decision**: GitHub marker search. One `getIssueComments` call per error transition; state lives on the comment marker itself.

**Rationale**: (a) Parity with the existing `findOrCreateStageComment` pattern (same API, same match logic — reviewers already understand this shape). (b) Survives worker restarts mid-run — after restart, the scan finds the earlier alert (if any) and suppresses the duplicate. (c) No new infrastructure — no Redis key, no schema, no relay.

**Rejected alternatives**:
- **In-process `Set`** (Q2 option B): zero API cost, but does not survive worker restart mid-run. A restart during the error path could re-post the alert. Acceptable per Q4/A's restart semantics, but adds an unnecessary state divergence between "same run, no restart" and "same run, with restart" — both should behave identically from the developer's perspective, and marker search delivers that.
- **Redis `phase-tracker`-style key** (Q2 option C): explicitly rejected. `#862` is moving the orchestrator *away* from history-keyed `phase-tracker:*` dedupe keys. Adding a new one here would be immediate technical debt. The `#862` clarification body notes: *"paired-clear runs at pause start; residual keys are gone by resume"* — the same logic would need to be replicated here, doubling the surface. Not worth it when GitHub markers do the job.

### D4: Alert-comment content (Q3)

**Decision**: Short summary line naming failing phase + failing command + exit descriptor, followed by a collapsible `<details>` block containing the verbatim `buildErrorEvidence` output from `#847`.

**Rationale**: The summary line is the payload GitHub shows in email/mobile notification previews. It must be self-contained: the developer's first read is the notification preview, and the fix's goal is *zero clicks to diagnose*. The `<details>` block keeps the timeline compact (the alert doesn't dominate the visual thread) and provides the full evidence when the developer expands it. This is what the issue body's proposed rendering showed.

**Rejected alternatives**:
- **Full failing-command / exit-descriptor / stderr-tail block, top-level** (Q3 option A): the full block eats vertical space in the timeline, especially on mobile. `<details>` gives the same information with a less-visually-noisy default state.
- **One-line pointer to the stage comment** (Q3 option B): requires a click to see the diagnostic, and comment anchors on edited comments are fiddly on mobile/email. The whole point of the fix is *no click*.

### D5: Marker format (Q4)

**Decision**: `<!-- generacy:failure-alert:<stage>:<runId> -->` where `<runId>` is a stable per-`runPhaseLoop`-invocation token.

**Rationale**: (a) The `<runId>` provides the per-occurrence uniqueness the dedup requires. (b) A stable per-invocation token means multi-phase failures within one invocation share one marker → dedup suppresses the second post. (c) A worker restart mints a new `runId` → possible second alert after restart, which is acceptable (the phase genuinely re-ran). (d) The marker is future-consumable by cockpit for surfacing alert history without extra derivation.

**Rejected alternatives**:
- **`<!-- generacy:failure-alert:<stage> -->` (per stage)** (Q4 option B): the next occurrence would need to *edit* the existing marker-bearing comment to update its content, which defeats the fix (edits are silent).
- **`<!-- generacy:failure-alert:<stage>:<iso-timestamp> -->` (per-post timestamp)** (Q4 option C): a timestamp generated at post time is *not* stable across repeated polls within the same run — two polls hitting the error path would produce distinct markers and duplicate alerts. A stable-per-occurrence token is exactly the `runId`; option C done right *is* option A.

### D6: Intermediate-retry gating (Q5)

**Decision**: Only terminal failures alert. Intermediate implement retries stay silent. The `phase-loop.ts:~278` no-progress site gets an evidence block in the same PR so terminal alerts from that site always carry a diagnostic in their `<details>`.

**Rationale**: Intermediate retries are not actionable for the developer — the worker will self-heal within `maxImplementRetries`. Alerting on them creates thread noise and trains the developer to ignore notifications. Terminal failures are actionable (workflow parks in `waiting-for:developer`) — that is exactly where a notification pays off. The no-progress site is currently missing evidence; without the FR-007 fix, a terminal alert from that path fires with an empty `<details>`, which is the shipped-but-useless variant of the bug this issue fixes.

**Rejected alternatives**:
- Every failure occurrence alerts (Q5 option B): louder and strictly accurate, but the failure surface is reserved for actionable diagnoses. Cockpit ergonomics dominate strict accuracy here.
- Terminal-only without the no-progress evidence fix (Q5 option A): leaves a partial-fix gap. The no-progress path is a real terminal-failure site with a nonzero occurrence rate in the `#847` smoke test data. Fixing it here in the same PR is a ~15-line change (synthesize an `error` payload before evidence derivation) and closes the gap in one review.

### D7: `runId` scope and threading

**Decision**: `runId` is a `PhaseLoop.executeLoop`-local `string`, minted via `crypto.randomUUID()` at entry. Passed to error-site call sites via closure (no formal parameter changes on `postFailureAlert`'s callers upstream of `PhaseLoop`).

**Rationale**: (a) `runId` is a *display concern*, not a *state concern* — it lives only long enough to construct the marker string. Putting it on `WorkerContext` would leak it into contexts that don't need it (checkout, sibling fanout, etc.) and force wider type changes for no benefit. (b) `crypto.randomUUID()` is a Node ≥19 built-in — no new dependency, cryptographically strong, thread-safe (worker is single-threaded per issue anyway). (c) The value never escapes `executeLoop` — no need for a formal wrapper type.

**Rejected alternatives**:
- **Reuse the workflow-run correlation ID** from `#516` or an existing job UUID: viable in principle, but couples `#865`'s dedup logic to whichever ID lives closest, which is fragile as the orchestrator evolves. The Assumptions section calls this out as acceptable but not required. A fresh UUID at `executeLoop` entry is simpler and self-contained.
- **Add `runId` to `WorkerContext`**: over-scopes the identifier. `WorkerContext` is the cross-method state bundle; `runId` never crosses a method boundary outside `PhaseLoop`.

### D8: No-progress site error synthesis (FR-007)

**Decision**: At `phase-loop.ts:~278`, set `result.error = { message, stderr, phase }` *before* the `updateStageComment({ status: 'error', ... })` call, where `stderr` is a short synthesized diagnostic like `` `no progress: tasks_remaining stayed at ${tasksRemaining} across two increments` ``. Then reuse `buildErrorEvidence(phase, result)` to derive evidence and pass it to both `updateStageComment` (canonical) and `postFailureAlert` (notification).

**Rationale**: (a) Reuses the existing evidence derivation — no new code path for the no-progress case. (b) The synthesized stderr is well under 30 lines / 4 KiB, so `boundStderrTail` returns it unchanged, so the `<details>` block shows the diagnostic verbatim. (c) The name of the guard (`no-progress`) plus the observation (`tasks_remaining stuck`) is exactly what the developer needs to diagnose without container logs.

**Rejected alternatives**:
- **Add a dedicated `noProgressResult` type**: over-abstracts a single call site. `PhaseResult` already has the `error` field for this.
- **Skip evidence at this site and let the alert render with empty `<details>`**: strictly what Q5/A would allow, but it's the shipped-but-useless variant of the bug. Q5/C explicitly closes this gap.

## Non-decisions (deliberate)

- **Cockpit UI for consuming `generacy:failure-alert:*` markers**: out of scope. The marker is defined here for future consumption; adding UI to surface alert history is a separate cockpit issue.
- **Alerts for successful phase completions or gate transitions**: explicit non-goal. The failure surface is not a general "workflow event log" surface.
- **Migrating existing `phase-tracker:*` Redis dedupe keys**: `#862` owns that migration. This spec does not add new `phase-tracker:*` keys and does not touch existing ones.
- **Backwards-compat for the marker format**: not applicable. No prior consumer of this marker exists; the format is introduced fresh here.

## Sources

- `packages/orchestrator/src/worker/stage-comment-manager.ts` (`findOrCreateStageComment`, `updateStageComment`, `renderStageComment`, `appendEvidenceBlock`)
- `packages/orchestrator/src/worker/phase-loop.ts` (`executeLoop`, `buildErrorEvidence`, all four `updateStageComment({ status: 'error' })` call sites)
- `packages/orchestrator/src/worker/types.ts` (`StageCommentData`, `STAGE_MARKERS`)
- `specs/847-found-during-cockpit-v1/plan.md`, `data-model.md`, `contracts/failure-evidence-block.md` (upstream evidence-block contract)
- Cockpit v1 integration smoke test finding #29 (2026-07-08, `christrudelpw/sniplink#3`)
- GitHub Docs: [Notifications for editing an issue comment](https://docs.github.com/en/account-and-profile/managing-subscriptions-and-notifications-on-github) — confirms edits do not notify subscribers.
