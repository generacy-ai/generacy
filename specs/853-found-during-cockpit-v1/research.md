# Research: `cockpit merge` reads `completed:validate` from the issue (#853)

## Problem Restatement

`runMerge` in `packages/generacy/src/cli/commands/cockpit/merge.ts:56` reads `completed:validate` from the **PR's** labels. The workflow-label protocol (issue-scoped per #807-Q2: "the orchestrator writes `waiting-for`/`completed` on issues") never syncs those labels to the PR. So every real epic hits the `missing-label` branch on `cockpit merge`, and the verb has never worked outside unit tests that pre-labeled the PR fixture — the same tests-encode-the-bug pattern as #800/#826/#836.

Live repro: `christrudelpw/sniplink#2` has `completed:validate` on the issue and green PR checks. `generacy cockpit merge christrudelpw/sniplink#2` returned `{"status":"red","reason":"missing-label"}`. Interim workaround applied: manually adding `completed:validate` to the PR (which satisfies the current code but is not the intended protocol).

## Evidence

### Root-cause site (source-verified 2026-07-08)

- `packages/generacy/src/cli/commands/cockpit/merge.ts:56` — `if (!pr.labels.includes(COMPLETED_VALIDATE_LABEL))`. The PR object comes from `getPullRequestDetail`, whose labels reflect the PR, not the linked issue.
- `packages/cockpit/src/gh/wrapper.ts:883–943` — `fetchIssueLabels` and `fetchIssueState` both exist and already power issue-scoped label reads in the orchestrator (`label-monitor-service.ts`). `fetchIssueState` additionally returns `state` — needed for the CLOSED-issue guard — in one gh call.
- `tetrad-development/docs/label-protocol.md` — canonical spec ("workflow labels live on the issue; the orchestrator watches for `completed:*` and emits `resume`; nothing syncs to the PR").

### Control case (positive) — where issue-scoped labels are correctly read

- `packages/orchestrator/src/services/label-monitor-service.ts` reads labels via `fetchIssueState(nwo, issueNumber)` on both webhook and poll paths. Its `if (issueLabels.includes(waitingLabel))` check is the reference implementation of the issue-scoped label protocol.
- `packages/generacy/src/cli/commands/cockpit/advance.ts` (post-#845 fix) already treats labels as issue-scoped: it writes to the issue, doesn't touch the PR.

## Decision 1 — Order of the issue-label check (Q1)

**Chosen**: **B** — issue-label check runs **after** PR resolution.

**Rationale**:
- Fail-fast (option A) saves one `gh` call on the failure path only — irrelevant to operator throughput; `cockpit merge` runs at most a handful of times per epic and always after the plan/tasks/implement/review phases have already made many gh calls.
- Option A also forces the `missing-label` payload's `pr` field to `null`, relaxing an invariant the cockpit plugin's `merge.md` decision table was written against. That converts a one-repo CLI fix into a cross-repo contract change with no operator benefit.
- Option B additively gains the issue ref in the payload — operators get both refs, which is what they actually want when diagnosing `missing-label`: "which issue, which PR?"

**Alternative rejected**: option A (fail-fast) for the reasons above; option C (parallel) adds complexity for no measurable benefit.

## Decision 2 — Behavior when the issue-label fetch fails (Q2)

**Chosen**: **B** — reuse `unresolved` with the issue ref included.

**Rationale**:
- `unresolved` already models "we couldn't get far enough to check" (that's exactly what it means for `resolveIssueToPRRef` returning `null`). The semantics extend cleanly to "we couldn't get far enough to check the issue's labels either."
- Option A (new `RedReason` value like `'issue-fetch-failed'` or `'unresolved-issue'`) forces the plugin's result × reason decision table to learn a new row for an edge that operators handle identically to `unresolved`. Cross-repo ripple for no operator benefit.
- Option C (let the exception bubble) matches today's accidental behavior for `getPullRequestDetail` failures, but making a *new* fetch structured while `getPullRequestDetail` still bubbles is fine — a full gh-error taxonomy for the verb is a separate cleanup (spec Out-of-Scope).

**Chosen shape**: `{status:'red', reason:'unresolved', pr:null, issue:{owner,repo,number}, failingChecks:[]}` — with the raw gh error text still written to stderr via pino.

## Decision 3 — Is issue state (OPEN/CLOSED) a merge blocker? (Q3)

**Chosen**: **A** — refuse to merge when the linked issue is `CLOSED`, regardless of `stateReason`.

**Rationale**:
- Cost asymmetry decides this: wrongly *blocking* costs the operator ~10 seconds (`gh issue reopen <ref>` — which doubles as the deliberate override), while wrongly *merging* is an irreversible squash to `develop` — the outward action this design treats as sacred.
- Option C (discriminate on `stateReason`) *almost* gets the semantics right, but it silently merges the closed-as-`completed`-but-PR-still-open anomaly. An anomaly at the merge gate must never be resolved silently in the direction of merging.
- Option B (ignore issue state entirely) misses the smoke-test failure mode: issues closed as duplicates, or auto-closed by an unrelated PR mentioning `closes #N`, will still have `completed:validate` from their prior workflow run — they'd merge without human review.

**Implementation**: mirror the existing PR-OPEN guard at `merge.ts:39–53`. The payload names `state` and `stateReason` so the operator knows why the block fired.

## Decision 4 — Payload extensibility mechanism

**Chosen**: additive `issue` field on `FailingCheckPayload`; relax the JSON-Schema's `additionalProperties: false` to permit it.

**Rationale**:
- The schema at `specs/789-epic-generacy-ai-tetrad/contracts/failing-check.schema.json` is the cross-repo contract. Additive optional fields are the intended forward-compat mechanism.
- Alternative: a new local schema (e.g., `specs/853-.../contracts/failing-check-v2.schema.json`) — rejected because it forks the shared contract and requires a plugin-side schema switch. The `additionalProperties` relaxation is the smaller change.
- Alternative: encode the issue ref into the existing `pr` field with a discriminator — rejected because it violates the `pr` field's typing (it's a PR ref) and breaks tools that parse `pr.number` as the PR number without checking.

## Decision 5 — `packages/cockpit` extension surface (`stateReason`)

**Chosen**: extend `IssueStateResult.stateReason: string | null` and add `stateReason` to `fetchIssueState`'s `--json` gh arg.

**Rationale**:
- `stateReason` has been in `gh issue view --json` since gh CLI v2.24 (Feb 2023). Cluster-base and CI images pin ≥v2.40.
- Alternative: a second `fetchIssueStateReason(nwo, n)` gh call — rejected because it doubles the network cost on the CLOSED-issue guard path and adds a new `GhWrapper` method for one field.
- Alternative: leave `stateReason` absent from the payload — rejected because the spec (FR-005 and Q3 answer) explicitly names it.

The field is nullable-optional in the Zod schema; existing `fetchIssueState` callers do not read `stateReason` and continue to work.

## Decision 6 — Test shape for the counterexample fixture (FR-007)

**Chosen**: three positive regression tests plus one meta-test that greps the fixtures.

**Rationale**:
- FR-007a (issue-labeled + PR-unlabeled → merge) is the primary counterexample: it fails against the pre-fix code (which reads `pr.labels`) and passes against the post-fix code. This is the fixture that would have caught #853 in review.
- FR-007b (issue-unlabeled + `missing-label` with ISSUE ref) locks in the payload shape — deleting the `issue` field breaks this.
- FR-007c (CLOSED-issue blocks) locks in the Q3→A guard — reverting to Q3→B (ignore state) makes this fail.
- The meta-test (SC-004) grep-style asserts that no `PullRequestDetail` fixture in `merge.test.ts` sets `labels: ['completed:validate']` as a merge precondition. This is the specific tests-encode-the-bug pattern (#800/#826/#836); a one-line `expect(fixture.labels).not.toContain('completed:validate')` guards against a well-meaning contributor accidentally re-encoding the bug in a future fixture.

## Decision 7 — Where NOT to fix

- **`label-monitor-service.ts`**: already correct — reads labels from the issue. No change.
- **Worker resume path**: unaffected — this fix does not change how labels are written by orchestrator/worker.
- **`fetchIssueLabels`**: kept as-is (out-of-scope callers may depend on it). `runMerge` uses `fetchIssueState` because it needs `state` and labels in one call.
- **`getPullRequestDetail` error path**: kept bubbling — a general gh-error taxonomy is a separate cleanup per spec's Out-of-Scope.

## References

- Spec: `specs/853-found-during-cockpit-v1/spec.md`
- Clarifications: `specs/853-found-during-cockpit-v1/clarifications.md`
- Sibling regressions (tests-encode-the-bug pattern): `specs/800-...`, `specs/826-...`, `specs/836-...`, `specs/845-...`
- Label protocol (out-of-repo, authoritative): `tetrad-development/docs/label-protocol.md`
- Live repro target: `christrudelpw/sniplink#2` (linked PR `#16`)
- Payload schema (relaxed by this PR): `specs/789-epic-generacy-ai-tetrad/contracts/failing-check.schema.json`
- Reference implementations of the issue-scoped label protocol:
  - `packages/orchestrator/src/services/label-monitor-service.ts` (reads labels via `fetchIssueState`)
  - `packages/generacy/src/cli/commands/cockpit/advance.ts` (post-#845; writes to issue only)
- Related incident logs: `generacy-ai/tetrad-development#88` (cockpit v1 smoke test, finding #19)
