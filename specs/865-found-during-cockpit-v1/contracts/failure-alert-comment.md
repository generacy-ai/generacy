# Contract: Failure-alert bottom-of-thread comment

**Scope**: FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007, FR-008. Rendering and posting contract for the alert comment created by `StageCommentManager.postFailureAlert` on terminal-failure occurrences.

## When the alert is posted

The alert MUST be posted iff, in one `PhaseLoop.executeLoop` invocation, execution reaches one of the four terminal-error sites in `phase-loop.ts`:

| Site | Line (approx.) | Failure condition |
|------|----------------|-------------------|
| Pre-validate install failure | `~168` | `runPreValidateInstall` returned `success: false` |
| Unexpected spawn error catch | `~217` | `try/catch` around `runValidatePhase` / `spawnPhase` caught an error |
| Post-phase failure | `~354` | `result.success === false` AND (phase ≠ `implement` OR `implementRetryCount >= maxImplementRetries`) |
| Product-diff detection / empty product diff | `~394`, `~416` | Product-diff computation threw, or `productFiles.length === 0` |
| No-progress guard | `~278` (FR-007) | `implement` increment made no progress across two consecutive polls |

The alert MUST NOT be posted:
- On `status: 'in_progress'` updates (successful phase, gate hit, implement-increment progress).
- On `status: 'complete'` updates (any phase-complete update).
- On intermediate `implement` retry failures inside `maxImplementRetries` — those flow through `updateStageComment({ status: 'in_progress' })` in the retry branch (`~342`), which is not adjacent to a `postFailureAlert` call.

## `runId` provenance and threading

- `runId` MUST be minted exactly once per `PhaseLoop.executeLoop` call via `crypto.randomUUID()`.
- `runId` MUST be a `string` matching the RFC 4122 v4 UUID shape (e.g., `9e5c8a0d-755e-40b3-b0c3-43e849f0bb90`).
- `runId` MUST NOT be persisted (no Redis, no workflow store, no `.agency/` file). It lives only in the closure of `executeLoop`.
- All four terminal-error sites within the same `executeLoop` invocation MUST use the same `runId`.
- Two separate `executeLoop` invocations (e.g., worker restart, re-trigger after resume) MUST use distinct `runId`s.

## Alert body layout

Byte-exact template for the comment body posted to `github.addIssueComment` (`<...>` = interpolation slots):

```markdown
<!-- generacy:failure-alert:<stage>:<runId> -->
❌ **<phase> failed** — `<command>` <exitDescriptor>.

<details><summary>stderr (last <N> lines)</summary>

```text
<stderrTail>
```

</details>
```

Interpolation rules:

| Slot | Source | Example |
|------|--------|---------|
| `<stage>` | `data.stage` (`StageType`) | `implementation` |
| `<runId>` | `data.runId` (UUID v4) | `9e5c8a0d-755e-40b3-b0c3-43e849f0bb90` |
| `<phase>` | `data.phase` (`WorkflowPhase`) | `validate` |
| `<command>` | `data.evidence.command` | `npm test && npm run build` |
| `<exitDescriptor>` | `data.evidence.exitDescriptor` | `exited 1` / `killed (SIGTERM) after 300000ms` / `aborted` |
| `<N>` | count of `\n`-separated lines in `data.evidence.stderrTail` | `30` |
| `<stderrTail>` | `data.evidence.stderrTail` after triple-backtick neutralization | `npm error Missing script: "test"` |

Formatting invariants:

1. **Line 1 is the marker.** MUST match `` /^<!-- generacy:failure-alert:(\w+):[0-9a-f-]{36} -->$/ ``. Machine-parseable by future cockpit tooling.
2. **Line 2 is the summary line.** Starts with `❌ **`, ends with `.` — GitHub's email/mobile notification previews show ~the first 120 bytes of the comment body, so the phase name lives in the leading bytes of line 2. The exit descriptor sits at the end so it's the first thing truncated if the preview cap hits.
3. **Line 3 is blank.**
4. **Line 4 is `<details>...`.** Opens the collapsible.
5. **Line 5 is blank.** (GitHub markdown requires a blank line before a fenced code block inside `<details>`.)
6. **Lines 6–8 are the fenced block.** Opening ` ```text `, then `<stderrTail>`, then closing ` ``` `.
7. **Line 9 is blank.** (Symmetric with line 5.)
8. **Line 10 is `</details>`.** Closes the collapsible.

### Backtick neutralization

Adversarial `<stderrTail>` may contain triple-backtick sequences (` ``` `). If injected verbatim, they would close the outer fenced block prematurely. The renderer MUST replace every ` ``` ` in `stderrTail` with `` `​`` `` (backtick, U+200B ZWSP, backtick, backtick) — the same substitution used by `StageCommentManager.appendEvidenceBlock` in `#847`. Test asserts this substitution.

### Summary-line examples

Given `phase='validate'`, `command='npm test && npm run build'`:

- `exitDescriptor='exit 1'` → `❌ **validate failed** — `npm test && npm run build` exit 1.`
- `exitDescriptor='killed (SIGTERM) after 300000ms'` → `❌ **validate failed** — `npm test && npm run build` killed (SIGTERM) after 300000ms.`
- `exitDescriptor='aborted'` → `❌ **validate failed** — `npm test && npm run build` aborted.`

Given `phase='implement'`, `command='implement (no-progress guard)'`, `exitDescriptor='exit 1'`:

- → `❌ **implement failed** — `implement (no-progress guard)` exit 1.`

## Dedup semantics

`postFailureAlert` implements FR-004 as follows:

1. Compose the full marker: `` `${FAILURE_ALERT_MARKER_PREFIX}${data.stage}:${data.runId} -->` ``.
2. Fetch existing issue comments via `github.getIssueComments(owner, repo, issueNumber)`.
3. If any returned comment's `body` includes the marker as a substring, log at `info` level and return WITHOUT posting. The returned promise resolves normally.
4. Otherwise, render the body and call `github.addIssueComment(owner, repo, issueNumber, body)`.

Marker match MUST be exact (`body.includes(marker)`). Partial-prefix match (e.g., matching just `<!-- generacy:failure-alert:validate:`) would spuriously suppress alerts across independent `runPhaseLoop` invocations that happen to share a stage — the whole point of the `<runId>` is per-invocation granularity.

Dedup is intentionally scoped to one `runId`. Independent invocations get independent markers → get independent alerts. Restart mid-invocation mints a new `runId` → a fresh alert. This matches Q4/A's restart semantics.

## Callsite integration

At each of the four (five, counting no-progress) terminal-error sites, `phase-loop.ts` MUST:

1. Ensure `errorEvidence` is derived via the existing `buildErrorEvidence` helper. Extract it into a `const evidence = this.buildErrorEvidence(...)` local so both `updateStageComment` and `postFailureAlert` share the object (FR-008, no re-derivation).
2. Call `stageCommentManager.updateStageComment({ status: 'error', ..., errorEvidence: evidence })` — unchanged from `#847` in shape.
3. Call `stageCommentManager.postFailureAlert({ stage, runId, phase, evidence })` — new.
4. Return `{ results, completed: false, lastPhase: phase, gateHit: false }`.

Ordering of steps 2 and 3 is deterministic: step 2 first (canonical state), step 3 second (notification). A failure in step 3 does not corrupt the canonical stage comment. Test asserts this order.

The no-progress site (FR-007) additionally requires setting `result.error = { message, stderr, phase }` before step 1 (evidence derivation), where `stderr` is a short synthesized diagnostic like `` `no progress: tasks_remaining stayed at ${tasksRemaining} across two increments` ``.

## Invariants

1. **`postFailureAlert` MUST fire `addIssueComment`, NEVER `updateComment`.** This is the notification-triggering distinction. Test asserts `addIssueComment` is called and `updateComment` is not (for the alert-posting path).
2. **`postFailureAlert` MUST NOT alter any bytes of the canonical stage comment.** The stage comment's body is written exclusively by `updateStageComment`. Test asserts that the stage comment's rendered body is byte-identical to `#847`'s output before and after `postFailureAlert` runs.
3. **The alert body MUST be ≤ 6 KiB** even under adversarial stderr (bounded by `#847`'s ≤ 4 KiB `boundStderrTail` + ~200 bytes prelude/marker/details wrapper). Test asserts on comment size for a 100 MB synthetic stderr input (SC-004 upstream from `#847`).
4. **`runId` MUST NOT appear in any log line outside of the two `postFailureAlert` log lines** (`Failure alert already exists ...` and `Posted failure alert comment`). Test asserts by inspecting `mockLogger.info` calls for `runId` field presence.
5. **The marker's `<stage>` component MUST be a `StageType`** (`specification` / `planning` / `implementation`), NOT a `WorkflowPhase`. The marker is per-stage-and-run, not per-phase-and-run — multi-phase failures within a stage share one marker (dedup within the invocation). This matches Q4's marker shape.

## Cockpit-side (future consumer)

The `FAILURE_ALERT_MARKER_PREFIX` constant is defined in `packages/orchestrator/src/worker/types.ts` for future cockpit consumption. Cockpit tooling MAY:

- Scan an issue's comments for `body.startsWith(FAILURE_ALERT_MARKER_PREFIX)` on any line to discover alert history.
- Parse `<stage>:<runId>` from the marker to correlate alerts with workflow runs.

Cockpit is NOT modified by this spec. Adding an alert-history UI, alert-count classifier, or notification-preference surface is a separate issue.

## Regression fixtures (`stage-comment-manager.test.ts`)

Minimum coverage for `postFailureAlert`:

1. **First-time post (numeric exit)**: no matching marker → `addIssueComment` called with body containing marker + summary line + `<details>` block. Assert exact body bytes.
2. **Dedup hit**: `getIssueComments` returns a comment with matching marker → `addIssueComment` NOT called. Assert log at `info` with `Failure alert already exists`.
3. **Timeout descriptor**: `evidence.exitDescriptor = 'killed (SIGTERM) after 300000ms'` → summary line contains the descriptor verbatim.
4. **Abort descriptor**: `evidence.exitDescriptor = 'aborted'`, `evidence.stderrTail = '(stderr empty)'` → `<details>` block contains `(stderr empty)` inside the fenced text block.
5. **Backtick-poisoned stderr**: `evidence.stderrTail` contains ` ``` ` → substitution keeps the outer fenced block closed by its own ` ``` `.
6. **Truncated stderr**: `evidence.stderrTail` starts with `… truncated (kept last 30 lines / 4096 bytes) …\n` → renders unchanged inside `<details>`.
7. **Marker shape**: assert body's first line matches the regex `/^<!-- generacy:failure-alert:(specification|planning|implementation):[0-9a-f-]{36} -->$/`.

## Regression fixtures (`phase-loop.test.ts`)

Minimum coverage for `PhaseLoop` integration:

1. **`runId` minting**: each `executeLoop` invocation mints a distinct `runId`; two invocations produce different UUIDs.
2. **`runId` stability**: within one invocation, if two hypothetical error sites fire, both use the same `runId`.
3. **Terminal-failure alert on pre-validate failure**: `runPreValidateInstall` returns failure → `postFailureAlert` called once with the correct `stage`, `phase`, `evidence.command = config.preValidateCommand`.
4. **Terminal-failure alert on post-phase failure**: `spawnPhase` returns failure for validate → `postFailureAlert` called once with `phase='validate'`, `evidence.command = config.validateCommand`.
5. **No alert on intermediate implement retry**: `spawnPhase` fails for implement with `implementRetryCount < maxImplementRetries` → `postFailureAlert` NOT called; retry proceeds; on the successful retry, `postFailureAlert` still NOT called.
6. **Terminal alert on implement retry exhaustion**: `spawnPhase` fails for implement with `implementRetryCount = maxImplementRetries` → `postFailureAlert` called exactly once.
7. **No-progress site emits evidence**: implement increment returns partial with `tasksRemaining` unchanged from previous poll → `updateStageComment({ status: 'error', ... })` called with a non-empty `errorEvidence` object AND `postFailureAlert` called with the same `evidence` object (referential identity).
8. **Multi-error-site dedup within one invocation**: hypothetical (constructed) two-error-site pass through one invocation → `postFailureAlert` called with the same `runId` at both sites; dedup happens via `getIssueComments` returning the first-posted comment on the second call.

## Non-goals

- No JSON-encoded alert payload (cockpit UI rendering is out of scope).
- No color-code or ANSI-escape stripping in `stderrTail` (out of scope; `#847`'s `boundStderrTail` is byte-transparent).
- No alert-comment editing to reflect subsequent state changes (edits are silent — the whole point of `#865` is to avoid them).
- No configuration surface (`.generacy/config.yaml` toggles for alert on/off, per-stage suppression, etc.). Failure alerts are always on.
