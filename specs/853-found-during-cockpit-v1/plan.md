# Implementation Plan: `cockpit merge` reads `completed:validate` from the linked issue and blocks CLOSED issues

**Feature**: Move the `completed:validate` label check in `runMerge` from the PR to the linked issue, additively include the issue ref in every red-outcome payload, and refuse to merge when the linked issue is `CLOSED`.
**Branch**: `853-found-during-cockpit-v1`
**Date**: 2026-07-08
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md)
**Status**: Complete

## Summary

Root cause: `runMerge` (`packages/generacy/src/cli/commands/cockpit/merge.ts:56`) reads `completed:validate` from `pr.labels`. Under the #807-Q2 label protocol, workflow labels (`waiting-for:*`, `completed:*`) are **issue-scoped** — the orchestrator writes them on the issue, and nothing syncs them to the PR. Result: every real epic hits the `missing-label` branch on `cockpit merge`, and the verb has never worked outside unit tests that (as with #800/#826/#836) labeled the PR fixture directly.

Fix (three coordinated changes on the CLI side, all local to the `generacy` package plus one shared schema file):

1. **Label source swap** — after `getPullRequestDetail` returns (Q1→B; PR resolution stays first to preserve the `missing-label` non-null `pr` invariant), fetch the *issue's* labels via `gh.fetchIssueState(nwo, issueNumber)` and check for `completed:validate` there. Delete the `pr.labels` check.
2. **CLOSED-issue guard** — the same `fetchIssueState` call surfaces `state` and `stateReason`; refuse to merge (mirrors the existing PR-OPEN guard) when `state === 'CLOSED'` regardless of `stateReason` (Q3→A). Red payload names the issue state and `stateReason` on both stdout JSON and the stderr line.
3. **Payload extension** — every red-outcome payload additively carries `issue: {owner, repo, number}` (and, on the CLOSED-issue branch, `state` + `stateReason`). Existing `pr` field is untouched — non-null on `missing-label`/`checks-failing`, nullable only on `unresolved` as before. The single `runMerge`-scoped try/catch wraps the new `fetchIssueState` call: any thrown error (404, repo mismatch, gh network/auth, malformed JSON) becomes `{status:'red', reason:'unresolved', pr:null, issue:{...}}` with the raw gh error on stderr (Q2→B — reuse `unresolved`, do not extend the `RedReason` enum).

Everything downstream of the label check (`getRequiredCheckNames` → `getPullRequestCheckRuns` → `classifyChecks` → squash-merge / `checks-failing`) is untouched — the fix is strictly scoped to the label source and the two new guard branches.

Companion change to `IssueStateResult` (in `packages/cockpit`): add `stateReason: string | null` to the interface and raw schema. `fetchIssueState` already runs a single `gh issue view --json state,closedAt,labels,assignees,title` call; extending it to also request `stateReason` is one word in the `--json` argument and one field in the Zod schema. This is the only cross-package change.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js ≥22 (per `packages/generacy/package.json` and root `package.json`).
**Primary Dependencies**: `commander`, `@generacy-ai/cockpit` (`GhWrapper`, `GhCliWrapper`, `fetchIssueState`), `pino`, `zod` (for `IssueStateRawSchema` update); `vitest` + `ajv/ajv-formats` for tests.
**Storage**: N/A — this is a CLI behavior fix. Labels live on the GitHub issue.
**Testing**: `vitest`. Test file: `packages/generacy/src/cli/commands/cockpit/__tests__/merge.test.ts`. JSON-Schema validation via `ajv` against `specs/789-epic-generacy-ai-tetrad/contracts/failing-check.schema.json` (schema is extended in this PR — see contracts/).
**Target Platform**: Node CLI (`generacy cockpit merge`) executed on operator workstations and inside cluster orchestrator processes.
**Project Type**: Monorepo package (`packages/generacy`) with a single cross-package touch (`packages/cockpit/src/gh/wrapper.ts`) to expose `stateReason` on `IssueStateResult`.
**Performance Goals**: N/A. Adds exactly one `gh issue view` call on the success path (a call that already happens on many other cockpit verbs; the smoke-test repro loop is one PR).
**Constraints**:
- **Additive payload contract.** The shared `FailingCheckPayload` schema (`specs/789-epic-generacy-ai-tetrad/contracts/failing-check.schema.json`) MUST be relaxed to permit an optional `issue` object and, on the CLOSED-issue red branch, optional `state` / `stateReason` on that object. Existing consumers (cockpit plugin `merge.md` decision table) MUST continue to parse the old shape unchanged. Non-null `pr` invariant on `missing-label` and `checks-failing` is preserved.
- **No new `RedReason` enum value** (Q2→B). The `unresolved` reason absorbs issue-fetch failures.
- **PR-scoped decision tree unchanged.** Required checks are still fetched from the PR; the squash-merge and `checks-failing` branches are byte-stable.
- **`IssueStateResult.stateReason` is optional-nullable.** Existing consumers of `fetchIssueState` (searchable) MUST NOT be affected — the field defaults to `null` in the Zod schema when absent.
- **Idempotence.** The CLOSED-issue guard runs before required-checks resolution, so a red payload is emitted without triggering any `mergePullRequest` side effect.
**Scale/Scope**: 2 source files modified (`merge.ts`, `wrapper.ts`), 1 shared type file modified (`failing-check-json.ts`), 1 schema file relaxed (`failing-check.schema.json`), 1 test file modified/extended (`merge.test.ts`). ~40 LOC production change, ~80 LOC test change (three new regression cases per FR-007).

## Constitution Check

*GATE: no constitution file at `.specify/memory/constitution.md`. Repository-wide invariants from `CLAUDE.md`, prior cockpit fixes (#800/#826/#836/#845), and this spec's clarifications:*

| Gate | Result | Note |
|------|--------|------|
| No new backwards-compat shims for removed code | PASS | The `pr.labels` check is deleted outright; nothing preserves the old (broken) behavior behind a flag. |
| Change matches the spec's Q&A intent, not just the letter | PASS | Q1→B (order preserved, `pr` invariant intact), Q2→B (reuse `unresolved`, no enum extension), Q3→A (CLOSED-issue blocks; no `stateReason` discrimination) are all honored — not the narrower alternatives. |
| Tests hit real behavior, not mocks-of-mocks | PASS | Regression tests assert on the `fakeGh` call log (the same surface as existing merge tests) and against the `ajv`-compiled JSON-Schema — no schema-parsing indirection. |
| Counterexample fixture for the tests-encode-the-bug pattern (#800/#826/#836) | PASS | FR-007 mandates: (a) issue-labeled + PR-unlabeled merges succeed, (b) issue-unlabeled + PR-labeled returns `missing-label` with the ISSUE ref, (c) CLOSED-issue blocks. |
| Structured logging conventions | PASS | New `logger.error({ issue, state, stateReason }, 'Issue is CLOSED')` and `logger.error({ issue, missingLabel }, 'Issue missing completed:validate label')` lines follow the existing pino key/value pattern; no free-form strings interpolated. |
| Zero new dependencies | PASS | Uses existing `@generacy-ai/cockpit` (`fetchIssueState`), existing zod schema surface, existing ajv test rig. |

Post-Phase-1 re-check: no violations introduced.

## Project Structure

### Documentation (this feature)

```text
specs/853-found-during-cockpit-v1/
├── spec.md              # (present, unchanged by /plan)
├── clarifications.md    # (present, unchanged by /plan)
├── plan.md              # THIS FILE
├── research.md          # Phase 0 output — decisions + rationale
├── data-model.md        # Phase 1 output — type extensions
├── quickstart.md        # Phase 1 output — verification steps
├── contracts/
│   ├── merge-command.md            # Behavioral contract for `runMerge` after fix
│   └── failing-check-payload.md    # Schema delta (issue field + state/stateReason)
└── checklists/          # (empty)
```

### Source Code (repository root)

```text
packages/generacy/src/cli/commands/cockpit/
├── merge.ts                                # MODIFIED — swap label source; add CLOSED-issue guard; wrap fetchIssueState in try/catch; extend all red payloads with issue ref
├── shared/
│   └── failing-check-json.ts               # MODIFIED — extend FailingCheckPayload + BuildFailingCheckInput with optional issue{owner,repo,number,state?,stateReason?}
└── __tests__/
    └── merge.test.ts                       # MODIFIED — fixture `greenPr` no longer sets `labels: ['completed:validate']`; new `fakeGh.fetchIssueState` seam; add SC-001/SC-002/SC-003 regression tests per FR-007a/b/c; add SC-004 grep-style guard test

packages/cockpit/src/gh/
└── wrapper.ts                              # MODIFIED — IssueStateResult gains `stateReason: string | null`; IssueStateRawSchema gains `.stateReason.nullable().optional()`; fetchIssueState `--json` arg gains `stateReason`

specs/789-epic-generacy-ai-tetrad/contracts/
└── failing-check.schema.json               # MODIFIED — additionalProperties: false → allow `issue`; add optional `issue` object schema with owner/repo/number (+ optional state/stateReason); no changes to `pr`/`reason`/`failingChecks` shape
```

External (out-of-repo, tracked for closure but NOT changed by this PR):

```text
tetrad-development/docs/label-protocol.md   # #807-Q2 canonical source ("orchestrator writes waiting-for/completed on issues"). Reference-only.
generacy-ai/cockpit (plugin repo) merge.md  # Decision table doc. Additive-only on our side; plugin picks up `issue` field when it opts in. Reference-only.
christrudelpw/sniplink#2                    # Live repro target for SC-001 smoke test. Reference-only.
```

**Structure Decision**: Single-package fix in `packages/generacy` (the CLI verb) with one downstream extension in `packages/cockpit` (add `stateReason` to `IssueStateResult`) and one shared-schema relaxation (`failing-check.schema.json` — additive properties only). The orchestrator side (`label-monitor-service.ts`, worker) is untouched — this fix conforms the CLI to the already-canonical issue-scoped label protocol.

## Design Overview

### Behavioral change — `runMerge` decision tree

Before (`merge.ts:26–104`):

```
1. resolveIssueToPRRef(repo, issue)           → prRef | null      (→ unresolved, pr:null)
2. prRef.state !== 'OPEN'                                          (→ unresolved, pr:{...})
3. getPullRequestDetail(repo, prRef.number)   → pr
4. pr.labels.includes('completed:validate') ← REMOVED               (→ missing-label, pr:{...})
5. getRequiredCheckNames + getPullRequestCheckRuns → classifyChecks (→ checks-failing, pr:{...})
6. mergePullRequest({squash: true})                                 → exitCode 0
```

After:

```
1. resolveIssueToPRRef(repo, issue)           → prRef | null      (→ unresolved, pr:null, issue:{owner,repo,number})
2. prRef.state !== 'OPEN'                                          (→ unresolved, pr:{...}, issue:{owner,repo,number})
3. getPullRequestDetail(repo, prRef.number)   → pr
4. try { issueState = fetchIssueState(nwo, issueNumber) }
   catch (err)                                                     (→ unresolved, pr:null,     issue:{owner,repo,number}; stderr: raw gh error)
5. issueState.state === 'CLOSED'                                   (→ unresolved, pr:{...},    issue:{owner,repo,number,state,stateReason}) ← NEW GUARD (Q3→A)
6. issueState.labels.includes('completed:validate') ← ISSUE-SCOPED  (→ missing-label, pr:{...}, issue:{owner,repo,number})
7. getRequiredCheckNames + getPullRequestCheckRuns → classifyChecks (→ checks-failing, pr:{...}, issue:{owner,repo,number})
8. mergePullRequest({squash: true})                                 → exitCode 0
```

Notes:
- Steps 1–3 keep their existing order (Q1→B). Step 5 (CLOSED-issue) runs *before* step 6 (label check) because CLOSED is a stronger predicate than "unlabeled": a CLOSED-and-unlabeled issue should surface as `unresolved (state=CLOSED)`, not `missing-label`.
- On step 5 the payload uses `reason: 'unresolved'` — the same reason as the PR-OPEN mirror guard at step 2. This keeps the `RedReason` enum closed (Q2→B, extended to Q3 by design consistency).
- Step 4's try/catch is the ONLY new `runMerge`-scoped try/catch. `getPullRequestDetail` (step 3) still bubbles on gh failure — a general gh-error taxonomy is out-of-scope (spec Out-of-Scope bullet).
- `issue: {owner, repo, number}` is threaded through every red payload from step 1 onward (`runMerge` already receives `issue` and `repo` in its `RunMergeInput`; the `owner/repo` split comes from splitting `repo` on `/`).

### Payload shape (post-fix)

`FailingCheckPayload` gains one optional field:

```ts
export interface FailingCheckPayload {
  status: 'red';
  reason: RedReason;                              // unchanged: 'checks-failing' | 'missing-label' | 'unresolved'
  pr: { number: number; url: string } | null;    // unchanged
  failingChecks: FailingCheck[];                  // unchanged
  issue?: {
    owner: string;
    repo: string;
    number: number;
    state?: 'OPEN' | 'CLOSED';                   // present only on CLOSED-issue red branch
    stateReason?: string | null;                 // present only on CLOSED-issue red branch
  };
}
```

Invariants (enforced by `buildFailingCheckPayload`):
- `issue` is present on **every red payload emitted by `runMerge` after this PR** — including the PR-not-found `unresolved` case where `pr: null`.
- `issue.state` and `issue.stateReason` are present ONLY when the red branch is the CLOSED-issue guard (step 5). Other branches include only `{owner, repo, number}`.
- Existing `pr` invariants (non-null on `missing-label`/`checks-failing`, nullable on `unresolved`) are preserved.
- The schema (`failing-check.schema.json`) is relaxed to permit these new optional fields; `additionalProperties: false` becomes `additionalProperties: false` on a wider property set (adds `issue`).

### Stderr line (per FR-003, FR-005)

- Existing `logger.error({ issue, repo }, 'No PR resolved for issue')` — unchanged.
- Existing `logger.error({ issue, repo, pr, state }, 'PR is not OPEN')` — unchanged.
- New `logger.error({ issue, repo, state, stateReason }, 'Issue is CLOSED')` — on step 5.
- New `logger.error({ issue, repo, missingLabel: 'completed:validate' }, 'Issue missing completed:validate label')` — on step 6, replaces the old `PR missing …` line.
- New `logger.error({ issue, repo, err }, 'Failed to fetch issue state')` — on step 4 catch; the raw gh error text also goes to stderr via the existing pino serializer.

### `packages/cockpit/src/gh/wrapper.ts` extension

```ts
// Before:
export interface IssueStateResult {
  state: 'OPEN' | 'CLOSED';
  closedAt: string | null;
  labels: string[];
  assignees: string[];
  title: string;
}

// After:
export interface IssueStateResult {
  state: 'OPEN' | 'CLOSED';
  stateReason: string | null;   // ← NEW; null when gh doesn't surface a reason (open issues, some legacy closes)
  closedAt: string | null;
  labels: string[];
  assignees: string[];
  title: string;
}

// IssueStateRawSchema gains:
//   stateReason: z.string().nullable().optional(),   // Zod default → undefined; wrapper maps undefined → null
// fetchIssueState's gh args gain 'stateReason' in the --json comma-list.
```

Existing callers of `fetchIssueState` (search: `grep -r fetchIssueState packages/`) do not read `stateReason` and continue to work unchanged.

### Test changes (`merge.test.ts`)

**Fixture updates** (SC-004: no test asserts `completed:validate` on a PR fixture as a merge precondition):
- `greenPr` fixture no longer sets `labels: ['completed:validate']` — set it to `[]` (or drop the field, since `PullRequestDetail.labels` is not read by post-fix `runMerge`).
- `fakeGh` factory gains an `overrides.fetchIssueState?: IssueStateResult` seam, defaulting to `{state:'OPEN', stateReason:null, closedAt:null, labels:['completed:validate'], assignees:[], title:''}` — the default that keeps the happy path green under the new behavior.

**Test updates** (existing cases):
- `SC-001: green + completed:validate → merge` — passes without change once fixtures are updated (default `fetchIssueState` supplies the label).
- `SC-002 missing-label: PR without completed:validate` — retitled to `SC-002 missing-label: ISSUE without completed:validate`; the override becomes `fetchIssueState: { …, labels: [] }`; assert `payload.issue` equals `{owner:'o', repo:'r', number:7}`; assert `payload.pr` remains non-null; assert `mergePullRequest` not called.
- `SC-002 unresolved` cases — extend to also assert `payload.issue` is present with `{owner, repo, number}`.
- `SC-002 checks-failing` cases — extend to also assert `payload.issue` is present.
- `short-circuits: missing-label is reported before checks are fetched` — retained; the check-runs spy MUST still not be called on the label-missing branch (order: label check runs before `getRequiredCheckNames`/`getPullRequestCheckRuns`).

**New tests** (regression per FR-007):
- **FR-007a**: issue labeled `completed:validate` + PR unlabeled (`labels: []`) + PR checks green → `mergePullRequest` called, exit 0. Counterexample to the tests-encode-the-bug pattern.
- **FR-007b**: issue unlabeled + PR fixture would-be-labeled → `missing-label` with `payload.issue: {owner:'o', repo:'r', number:7}` and non-null `payload.pr`. Deleting the fix (reverting to `pr.labels.includes(...)`) makes this test fail.
- **FR-007c**: `fetchIssueState` returns `{state:'CLOSED', stateReason:'completed', ...}` + everything else green → red with `payload.reason: 'unresolved'`, `payload.issue.state: 'CLOSED'`, `payload.issue.stateReason: 'completed'`, `mergePullRequest` not called.
- **Q2→B path**: `fetchIssueState` throws → payload is `{status:'red', reason:'unresolved', pr:null, issue:{owner,repo,number}, failingChecks:[]}`; assert the raw error goes to stderr (or is logged via pino).
- **SC-004 guard**: grep-style assertion that no test in the file sets `labels: ['completed:validate']` on a `PullRequestDetail` fixture as a merge precondition. (Implemented as a one-line meta-test on `greenPr.labels` and any `getPullRequest` override: `expect(fixture.labels ?? []).not.toContain('completed:validate')` in a `describe.each` over the module's exported fixtures.)

### Non-changes (deliberate)

- **`packages/cockpit/src/gh/wrapper.ts::fetchIssueLabels`** — retained but no longer called by `runMerge`. `fetchIssueState` is preferred because it already returns `state` (needed by the CLOSED-issue guard) alongside labels in one `gh issue view` call. Deleting `fetchIssueLabels` is out of scope (other callers may depend on it; a grep confirms; keeping the API surface unchanged is cheaper than the audit).
- **`RedReason` enum** — no new value. `unresolved` covers both step-1/2 PR-side and step-4/5 issue-side reasons (Q2→B; Q3→A implicit).
- **Cockpit plugin `merge.md`** — reads the new `issue` field additively when it opts in; no coordinated cross-repo change required for the JSON payload to remain valid against the (relaxed) schema.
- **Worker / orchestrator label writers** — the `#807-Q2` protocol is already what this fix conforms to. No orchestrator changes.
- **CLI flag surface** — no `--force` / `--allow-closed-issue` (spec Out-of-Scope). Operator override is `gh issue reopen`.

## Complexity Tracking

*Constitution Check passed; no violations.*

The only mildly non-trivial choice is the shared-schema relaxation. The alternative — a local per-command schema — would duplicate the existing schema for one additive field. Rejected: the schema is already-cross-repo authoritative (cockpit plugin reads it), and additive changes to `additionalProperties: false` schemas are the intended forward-compat mechanism. See `contracts/failing-check-payload.md` for the exact diff.

## Risk / Rollback

- **Risk**: a downstream cockpit-plugin consumer that parses the payload with a stricter validator than ours (or with `additionalProperties: false` locally) breaks on the new `issue` field. Mitigation: additive-field convention is the documented forward-compat plan; existing plugin surface is grep-verified not to enable a stricter validator; spec's Assumption bullet #4 explicitly names this as an accepted risk. If discovered post-merge, the mitigation is a one-line schema update in the plugin repo — no re-release of the CLI.
- **Risk**: `fetchIssueState` currently doesn't request `stateReason` from `gh`; if the gh CLI version pinned in cluster containers is old enough to reject the field, the fetch fails. Mitigation: `stateReason` has been in `gh issue view --json` since Feb 2023 (per `gh` release notes for v2.24+); `packages/generacy/package.json` and cluster-base pin ≥v2.40. If a repro emerges, the fallback is to omit `stateReason` from the `--json` arg and default the field to `null` — one-line change.
- **Rollback**: revert the two source-file changes (`merge.ts`, `wrapper.ts`), the shared type extension (`failing-check-json.ts`), the schema relaxation (`failing-check.schema.json`), and the test file. No data migration, no relay-payload change. Downstream consumers that adopted the `issue` field must ignore it (they already do, per additive convention).
