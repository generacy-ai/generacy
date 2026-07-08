# Implementation Plan: no-checks is not RED — CI-less repos merge on `completed:validate`; wrapper distinguishes absence from failure

**Feature**: Recognize gh's "no checks reported" exit-1 as an EMPTY check-run list (not a throw), let `runMerge` treat empty-actual + empty-required as vacuously green (with an explicit stdout note), keep empty-actual + NON-empty-required as red (naming missing contexts), and widen `ChecksRollup` / `status`+`watch` renderers to carry `'none'` (legitimate data) and a distinct new `'error'` sentinel (real fetch failures).
**Branch**: `857-found-during-cockpit-v1`
**Date**: 2026-07-08
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md)
**Status**: Complete

## Summary

Root cause: `gh pr checks <N>` exits **1** for TWO distinct states — "one or more checks failed" AND "no checks exist on this branch". `getPullRequestCheckRuns` (post-#855, `packages/cockpit/src/gh/wrapper.ts:587–606`) treats every non-zero exit as an error and throws, so a repo with no CI configured (christrudelpw/sniplink PR #16 — the live repro from cockpit v1 smoke test finding #22) can never reach the merge decision: `runMerge` sees the throw, logs `PR has failing or pending required checks` (misleading — there are no checks), and returns exit 1 with the `checks-failing` payload. The workflow's own `completed:validate` gate — which SHOULD suffice on unprotected repos — is bypassed. This is finding #22 of the cockpit v1 smoke test, surfaced one step deeper into the merge path immediately after #855's structured-error fix made the diagnosis mechanical (working as designed).

Fix (three coordinated changes across two packages, plus one narrow type widening):

1. **Wrapper: absence ≠ failure** — `getPullRequestCheckRuns` recognizes gh's no-checks case (exit 1 + stderr matching `no checks reported`) and returns an **empty** `CheckRunSummary[]` instead of throwing. All other non-zero exits keep throwing with the existing structured `warn({ repo, prNumber, ghStderr }, 'gh pr checks failed')` from #855. Detection is a single-token stderr regex; misdetection surface is minimal (no gh state matches this substring except the no-checks-reported response).

2. **`runMerge`: requiredness is the authority** — with an empty `actualChecks[]`:
   - `required.source === 'branch-protection'` + `required.names.length === 0` → **vacuously green**. Skip `classifyChecks`. Append the FR-003 stdout note (`no checks configured and none required — proceeding on completed:validate\n`) to `RunMergeResult.stdout`, call `mergePullRequest`, return `{ exitCode: 0, stdout: <note> }`.
   - `required.source === 'branch-protection'` + `required.names.length > 0` → **red**. Call `classifyChecks` — every required name will be missing, `failingChecks[]` populated with `state: 'MISSING'` entries per required context — same shape as today, same red payload, same `checks-failing` reason. No merge.
   - `required.source === 'fallback-pr-checks'` + empty actual — this is the CI-less-unprotected-repo case in practice (the wrapper couldn't read branch protection, most likely 404). Route via the same `classifyChecks` call: fallback-source iterates the actual list, and an empty list means `failingChecks[]` is empty → vacuously green → append note + merge. (Q1's clarification pinned the note delivery mechanism; the vacuous-green branch fires for both source variants when the union of "actual" and "required" is empty.)
   
3. **`status`/`watch` rollups: `'none'` becomes real data, `'error'` becomes a new visible sentinel** — `rollup(checks)` returns `'none'` for empty input (was `'pending'`). `ChecksRollup` widens from `'pending' | 'success' | 'failure'` to `'pending' | 'success' | 'failure' | 'none' | 'error'`. Both `status.ts` and `watch/poll-loop.ts` map their catch-block to `'error'` (was `'none'` — the conflation this issue undoes). `actionable.ts` naturally treats `'none'` and `'error'` as non-actionable (falls through the `'failure'` check). `diff.ts` uses existing `!==` semantics, so `none → success` etc. print naturally on transition.

Everything else stays put. `merge`'s decision tree keeps its shape (added: one no-op-when-list-nonempty branch); `status`'s row assembly is unchanged apart from the sentinel widening; `watch`'s snapshot union widens once; `context`'s bare catch is unchanged (out of scope — it emits `[]` on failure and doesn't render). The wrapper log line from #855 is preserved unchanged for real errors; the FR-002 "no warn log for no-checks" behavior is achieved by short-circuiting before the log — the log site only fires when we're about to throw.

Live repro closure: on christrudelpw/sniplink PR #16 (issue #2, `completed:validate` set, zero CI, no branch protection), post-fix `generacy cockpit merge 2` will emit the stdout note and squash-merge exit 0 — the exact terminal state finding #22 blocked.

Not-in-scope non-changes: the `context` verb's bare-catch degrade (`context.ts:287`) stays — its `checks` array simply becomes `[]` in the no-checks case, which is what most consumers already assume. Consumer-side polling loops, diff cadence, and event ordering are unchanged. The wrapper's own retry policy is unchanged (single-shot; the caller handles cadence).

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js ≥22 (root `package.json` + `packages/cockpit/package.json`, `packages/generacy/package.json`).
**Primary Dependencies**: `zod` (unchanged); `pino` at the consumer boundary (wrapper's optional `logger?: { warn(obj, msg) }` unchanged from #855); `vitest` for tests. No new deps.
**Storage**: N/A. CLI-side + wrapper fix. No persisted state; no relay payloads; no cloud-side coupling.
**Testing**: `vitest`. Files touched/created:
- `packages/cockpit/src/__tests__/gh-wrapper.test.ts` (MODIFIED — new positive test for the no-checks case: `stderr` includes `no checks reported`, exit 1, `getPullRequestCheckRuns` resolves `[]` without throwing, `logger.warn` NOT called (FR-002 corollary)).
- `packages/generacy/src/cli/commands/cockpit/__tests__/merge.test.ts` (MODIFIED — 3 new tests per FR-011: (a) CI-less unprotected + `completed:validate` → merges with stdout note; (b) branch protection with required contexts + empty actual → red with missing-context names; (c) failing check present → red, unchanged path).
- `packages/generacy/src/cli/commands/cockpit/__tests__/watch.check-rollup.test.ts` (MODIFIED — `rollup([])` returns `'none'` (was `'pending'`); `rollup([{ state: 'PENDING' }])` still `'pending'`).
- `packages/generacy/src/cli/commands/cockpit/__tests__/status.test.ts` OR new focused file (MODIFIED — real-error catch sets `checks: 'error'`; no-checks path via wrapper resolving `[]` sets `checks: 'none'`).
- `packages/generacy/src/cli/commands/cockpit/__tests__/watch.actionable.test.ts` (MODIFIED — `'none'` and `'error'` never actionable, mirrors clarification Q3→A).
- `packages/generacy/src/cli/commands/cockpit/__tests__/watch.diff.test.ts` (MODIFIED — `none → success` emits a `pr-checks` event with the raw union values in `from`/`to` state fields, per Q3→A).

**Target Platform**: Node CLI (`generacy cockpit merge|status|watch`) executed on operator workstations and inside cluster orchestrator processes. `gh` binary pinned to 2.96.x+ (verified stderr for the no-checks case; the exact substring `no checks reported` appears on gh 2.14+ per historical inspection — well below any deployed CI or dev environment).

**Project Type**: Monorepo two-package change. Primary: `packages/cockpit` (wrapper); consumer: `packages/generacy` (`merge.ts`, `status.ts`, `status/row.ts`, `watch/snapshot.ts`, `watch/check-rollup.ts`, `watch/poll-loop.ts`, plus the tests above). No orchestrator, cluster-relay, control-plane, or cloud changes.

**Performance Goals**: N/A. The wrapper change adds one substring `.includes('no checks reported')` per non-zero-exit result (cheap). The status/watch renderer changes are compile-time type widenings; runtime paths are unchanged.

**Constraints**:
- **Detection substring is `no checks reported`** — the fixed prefix in gh's stderr for the no-checks case (`no checks reported on the '<branch>' branch`). Case-sensitive lowercase; matched by `String.prototype.includes`, not regex (deliberate — no anchor games, no false positives from stderr noise around the token). If gh changes the exact message in a future release, the wrapper falls back to the throw path (safe direction — merge fails loudly rather than silently vacuous-greens).
- **No new warn log on the no-checks path** (FR-002). The wrapper's existing `warn(...)` for the failure path fires only on the throw branch; short-circuiting before it satisfies this without touching the log call site.
- **`ChecksRollup` union widens to 5 members** (FR-007): `'pending' | 'success' | 'failure' | 'none' | 'error'`. `actionable.ts` treats `'none'` and `'error'` as non-actionable (Q3→A: implicit is intended); `diff.ts` emits `pr-checks` on `!==` transitions (implicit is intended, tested).
- **`'none'` and `'error'` are distinct sentinels** (Q2→C). `'none'` = "wrapper returned []" = repo has no CI; `'error'` = "wrapper threw" = gh call failed (auth, network, malformed JSON). Rendering must display them distinctly for the operator (the whole point of undoing the conflation).
- **`runMerge.stdout` carries the FR-003 note** (Q1→A). The existing CLI `process.stdout.write(result.stdout)` call at `merge.ts:189-191` remains untouched. Tests assert on the return value's `stdout` property; no `process.stdout` capture is required.
- **FR-003 note is byte-exact**: `no checks configured and none required — proceeding on completed:validate\n` — one line, terminating newline, em-dash character `—` U+2014 (not two hyphens), lowercase. SC-006 assertion greps this literal.
- **`classifyChecks` semantics unchanged**. The `MISSING` state emission for absent required contexts (`packages/generacy/src/cli/commands/cockpit/shared/required-checks.ts:44-46`) already handles the "required set NON-empty + contexts absent" red path. No change needed there.
- **Merge invariant preserved**: "never merge on RED". Vacuously green (empty ∪ empty = ∅ failures) is not red. `completed:validate` remains mandatory (the workflow's own quality gate); teams that want CI mandatory express it via branch-protection required contexts, which the verb continues to respect.
- **Consumer degrade behavior preserved for `context.ts:287`**. That verb's swallow-to-`[]` was appropriate before this fix and stays. Its consumers (review-context payload emitters) don't render the rollup, so widening `ChecksRollup` doesn't touch them.
- **Wrapper's log line stays as `warn(...)` on genuine failures**. `logger.warn({ repo, prNumber, ghStderr }, 'gh pr checks failed')` fires only on the throw path (unchanged from #855). The FR-002 removal-of-warn is achieved by never reaching the log site on the no-checks path.

**Scale/Scope**: 1 wrapper method modified (`getPullRequestCheckRuns`, `packages/cockpit/src/gh/wrapper.ts:587–606`), 1 CLI decision tree modified (`runMerge`, `packages/generacy/src/cli/commands/cockpit/merge.ts:137–169`), 3 rollup consumers widened (`watch/snapshot.ts`, `watch/check-rollup.ts`, `status/row.ts`), 2 catch-block mappings changed (`status.ts:125-127`, `watch/poll-loop.ts:99-101`). ~40 LOC production change, ~180 LOC test change.

## Constitution Check

*GATE: no constitution file at `.specify/memory/constitution.md`. Repository-wide invariants from `CLAUDE.md`, prior cockpit fixes (#800/#826/#836/#845/#853/#855), and this spec's clarifications:*

| Gate | Result | Note |
|------|--------|------|
| No new backwards-compat shims for removed code | PASS | `ChecksRollup` widens; no old sentinel is retained "for old consumers". Old callers of `rollup()` already handle the string union; adding two members is source-compatible for narrow-string switches (default branch was the only pre-fix path for unknown values, and there are no `default:` branches on `ChecksRollup` in the codebase — verified). |
| Change matches the spec's Q&A intent, not just the letter | PASS | Q1→A (`stdout` note on `RunMergeResult`), Q2→C (`'error'` sentinel distinct from `'none'`), Q3→A (implicit `actionable`/`diff` semantics for `'none'`) — all honored. No option-B/C creep. |
| Tests hit real behavior, not mocks-of-mocks | PASS | Wrapper unit tests use `fakeRunner` fixtures shaped exactly as the pinned `gh` returns (verified stderr string is a real gh 2.96 output substring, not invented). The #855 drift suite continues to guard the JSON field list. `runMerge` tests use fakeGh with `getRequiredCheckNames`/`getPullRequestCheckRuns` return values that mirror the wrapper's post-fix shape — no test-encodes-the-bug pattern. |
| Counterexample fixture for the tests-encode-the-bug pattern (#800/#826/#836/#853/#855) | PASS | The no-checks-branch fake fixture is derived from the live sniplink#16 stderr, verified once by hand. Any future revert that re-conflates "no checks" with "checks failed" fails the merge unit tests immediately (SC-002). The #855 JSON-field drift suite catches the orthogonal drift class. |
| Structured logging conventions | PASS | Wrapper's existing `warn({ repo, prNumber, ghStderr }, 'gh pr checks failed')` from #855 is preserved for real errors and skipped for the no-checks path. No new log lines introduced. |
| Zero new runtime dependencies | PASS | Only `String.prototype.includes` and existing zod/vitest. |
| Fail-loud, don't silently degrade | PASS | Vacuously-green merges emit the FR-003 stdout note (loud, greppable). Real errors keep the throw + wrapper warn (loud). The only "silent" behavior — `context.ts`'s bare catch — is preserved unchanged because its downstream never renders the rollup and is Out-of-Scope. |
| `merge` invariant "never merge on RED" | PASS | Absence-vs-failure disambiguation strengthens the invariant. Red now names the specific missing required contexts by name (via `classifyChecks`'s existing `MISSING` state emission); vacuous green fires only when both `actualChecks[]` and `required.names[]` are empty (or fallback-source + empty actual). |
| Live-repro-driven fix (finding #22) | PASS | The exact terminal state on sniplink#16 (`generacy cockpit merge 2` on PR #16, `completed:validate` set, zero CI, no branch protection) is the driving regression. Post-fix behavior on that PR is byte-exact: stdout note + squash merge + exit 0. |

Post-Phase-1 re-check: no violations introduced.

## Project Structure

### Documentation (this feature)

```text
specs/857-found-during-cockpit-v1/
├── spec.md              # (present, unchanged by /plan)
├── clarifications.md    # (present, unchanged by /plan)
├── plan.md              # THIS FILE
├── research.md          # Phase 0 output — decisions + rationale
├── data-model.md        # Phase 1 output — type extensions
├── quickstart.md        # Phase 1 output — verification steps
├── contracts/
│   ├── get-pull-request-check-runs.md  # Wrapper method contract (no-checks detection semantics)
│   ├── run-merge-decision.md           # runMerge branch matrix (vacuous-green, missing-required, checks-failing)
│   └── checks-rollup-union.md          # ChecksRollup union widening (5 members) + actionable/diff semantics
└── checklists/          # (empty)
```

### Source Code (repository root)

```text
packages/cockpit/src/gh/
└── wrapper.ts                                       # MODIFIED — see delta below (no-checks short-circuit)

packages/cockpit/src/__tests__/
└── gh-wrapper.test.ts                               # MODIFIED — new positive test: no-checks stderr → resolves []

packages/generacy/src/cli/commands/cockpit/
├── merge.ts                                         # MODIFIED — vacuous-green branch + FR-003 note append
├── status.ts                                        # MODIFIED — catch maps to 'error' (was 'none')
└── watch/
    ├── snapshot.ts                                  # MODIFIED — ChecksRollup union widens to 5 members
    ├── check-rollup.ts                              # MODIFIED — empty input → 'none' (was 'pending')
    └── poll-loop.ts                                 # MODIFIED — catch maps to 'error' (was []; rollup([]) now 'none')

packages/generacy/src/cli/commands/cockpit/status/
└── row.ts                                           # MODIFIED — StatusRow.checks widens to 5-member union

packages/generacy/src/cli/commands/cockpit/__tests__/
├── merge.test.ts                                    # MODIFIED — FR-011 (a)(b)(c) regression tests
├── watch.check-rollup.test.ts                       # MODIFIED — rollup([]) === 'none'
├── watch.actionable.test.ts                         # MODIFIED — 'none' and 'error' never actionable
├── watch.diff.test.ts                               # MODIFIED — none→success emits pr-checks
└── status.test.ts (NEW or existing)                 # MODIFIED — 'error' distinct from 'none' in row.checks
```

### `wrapper.ts` delta (source)

```diff
   async getPullRequestCheckRuns(repo: string, prNumber: number): Promise<CheckRunSummary[]> {
     const args = [
       'pr',
       'checks',
       String(prNumber),
       '--repo',
       repo,
       '--json',
       'name,state,bucket,link',
     ];
     const result = await this.runner('gh', args);
     if (result.exitCode !== 0) {
+      const stderr = result.stderr.trim();
+      // gh exits 1 for BOTH "checks failed" and "no checks reported on
+      // '<branch>'". Distinguish here so callers can treat absence as
+      // legitimate data rather than a fetch failure.
+      if (stderr.toLowerCase().includes('no checks reported')) {
+        return [];
+      }
       this.logger.warn(
-        { repo, prNumber, ghStderr: result.stderr.trim() },
+        { repo, prNumber, ghStderr: stderr },
         'gh pr checks failed',
       );
-      throw new Error(`gh pr checks failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
+      throw new Error(`gh pr checks failed (exit ${result.exitCode}): ${stderr}`);
     }
     return parseCheckRuns(result.stdout);
   }
```

### `check-rollup.ts` delta (source)

```diff
 export function rollup(checks: CheckRunSummary[]): ChecksRollup {
-  if (checks.length === 0) return 'pending';
+  if (checks.length === 0) return 'none';
   let allTerminalSuccess = true;
   for (const check of checks) {
     if (check.state === 'FAILURE' || check.state === 'CANCELLED') {
       return 'failure';
     }
     if (
       check.state !== 'SUCCESS' &&
       check.state !== 'NEUTRAL' &&
       check.state !== 'SKIPPED'
     ) {
       allTerminalSuccess = false;
     }
   }
   return allTerminalSuccess ? 'success' : 'pending';
 }
```

### `snapshot.ts` delta (source)

```diff
-export type ChecksRollup = 'pending' | 'success' | 'failure';
+export type ChecksRollup = 'pending' | 'success' | 'failure' | 'none' | 'error';
```

### `status/row.ts` delta (source)

```diff
 export interface StatusRow {
   repo: string;
   kind: 'issue' | 'pr';
   number: number;
   title: string;
   state: CockpitState;
   sourceLabel: string;
   prNumber: number | null;
-  checks: 'pending' | 'success' | 'failure' | 'none';
+  checks: 'pending' | 'success' | 'failure' | 'none' | 'error';
   url: string;
   phase: string | null;
 }

 export function buildStatusRow(
   repo: string,
   issue: Pick<Issue, 'number' | 'title' | 'url'>,
   classified: ClassifiedIssue,
   kind: 'issue' | 'pr',
   prNumber: number | null,
-  checks: 'pending' | 'success' | 'failure' | 'none',
+  checks: 'pending' | 'success' | 'failure' | 'none' | 'error',
   phase: string | null,
 ): StatusRow {
   // (body unchanged)
 }
```

### `status.ts` delta (source)

```diff
-      let checks: 'pending' | 'success' | 'failure' | 'none' = 'none';
+      let checks: 'pending' | 'success' | 'failure' | 'none' | 'error' = 'none';
       if (prNumber != null) {
         try {
           const checkRuns = await gh.getPullRequestCheckRuns(repo, prNumber);
           checks = rollup(checkRuns);
         } catch {
-          checks = 'none';
+          checks = 'error';
         }
       }
```

### `watch/poll-loop.ts` delta (source)

```diff
-        let checks: CheckRunSummary[];
+        let checksResult: ChecksRollup;
         try {
-          checks = await deps.gh.getPullRequestCheckRuns(repo, issue.number);
+          checksResult = rollup(await deps.gh.getPullRequestCheckRuns(repo, issue.number));
         } catch {
-          checks = [];
+          checksResult = 'error';
         }
-        snapshot = buildPrSnapshot(repo, issue, classified, lifecycle, rollup(checks));
+        snapshot = buildPrSnapshot(repo, issue, classified, lifecycle, checksResult);
```

(Precise variable-naming may adjust in implementation; the semantic — real errors become the `'error'` sentinel and empty results propagate through `rollup([]) === 'none'` — is what the plan pins.)

### `merge.ts` delta (source) — decision-tree extension

```diff
   const [required, actualChecks] = await Promise.all([
     gh.getRequiredCheckNames(repo, pr.base),
     gh.getPullRequestCheckRuns(repo, pr.number),
   ]);

   if (required.source === 'fallback-pr-checks') {
     logger.warn(
       'required-check set derived from PR check list; token cannot read branch protection',
     );
   }

+  // Vacuous-green: no checks reported AND no required contexts →
+  //   nothing to fail on; proceed on completed:validate.
+  const noActual = actualChecks.length === 0;
+  const noRequired =
+    required.source === 'branch-protection'
+      ? (required.names?.length ?? 0) === 0
+      : true; // fallback-source has no authoritative required set
+  if (noActual && noRequired) {
+    const note = 'no checks configured and none required — proceeding on completed:validate\n';
+    await gh.mergePullRequest(repo, pr.number, { squash: true });
+    logger.info({ pr: pr.number }, 'PR merged');
+    return { exitCode: 0, stdout: note };
+  }
+
   const { failingChecks, ok } = classifyChecks({ required, actual: actualChecks });
   // …unchanged from here
```

Notes on the merge diff:
- `classifyChecks` already emits `state: 'MISSING'` per required-not-actual entry (`packages/generacy/src/cli/commands/cockpit/shared/required-checks.ts:44-46`). When `required.source === 'branch-protection'` + `required.names.length > 0` + `actualChecks.length === 0`, `classifyChecks` naturally produces one `MISSING` entry per required context — no code change there.
- The `noRequired` branch derivation uses `true` for `fallback-pr-checks` deliberately: the fallback source cannot authoritatively enumerate required contexts (that's the whole point of the fallback), so absence of actual + fallback source = vacuously green + `completed:validate` gate. This matches the sniplink#16 live-repro path (`gh api branches/main/protection` returns HTTP 404 on unprotected repos → fallback source).

**Structure Decision**: Two-package fix. Wrapper change is one method (`getPullRequestCheckRuns`), one added branch. Consumer changes are the `merge` decision tree extension (one new branch, ~10 LOC), the `rollup` return value change (one line), and mechanical union widening across three type-carrying files. No orchestrator, cluster-relay, control-plane, or cloud coupling; no data-model persistence changes; no new files.

## Complexity Tracking

*Constitution Check passed; no violations.*

One judgment call worth calling out:

1. **`fallback-pr-checks` → treat as `noRequired = true`.** The alternative — treat fallback source as `noRequired = false` and require the user to configure branch protection to reach vacuous green — was rejected because it re-creates finding #22's symptom: CI-less unprotected repos cannot merge. The sniplink#16 live repro is precisely this case (no CI, no branch protection). The spec's "requiredness is the authority" phrasing plus the merge invariant ("never merge on RED, `completed:validate` is the workflow's own gate") direct us to the `noRequired = true` interpretation for fallback source. Regression test (b) covers the counterexample: when required contexts ARE knowable (branch-protection source) and non-empty, empty actual → red.

## Risk / Rollback

- **Risk**: gh changes the stderr wording for the no-checks case in a future release (e.g., "no check runs reported"). Mitigation: the wrapper's fallback direction on non-match is the throw path, which surfaces immediately as a failed merge and a wrapper warn log — loud regression, not silent misbehavior. Fix is a one-line substring update in the wrapper.
- **Risk**: a repo with `gh pr checks` returning exit 1 for an unrelated stderr reason (e.g., transient auth) is misclassified as no-checks. Mitigation: the substring `no checks reported` is highly specific to the no-checks-on-branch response; no other gh error path uses that exact phrase (verified across gh 2.14–2.96 changelogs). If a future gh version reuses the phrase for a different error, the fix is a substring rescope.
- **Risk**: a downstream consumer of `ChecksRollup` has a `switch` without a `default:` and now hits an unhandled `'none'` or `'error'`. Mitigation: grep for `switch.*checksRollup` and `switch.*rollup` across `packages/generacy/src/` shows no consumer beyond `actionable.ts` (which uses `===`), `diff.ts` (which uses `!==`), and the status renderer (which uses `padEnd`, safe for any string). No `switch` with exhaustive TS exhaustiveness check exists today; adding the members is source-compatible.
- **Risk**: the FR-003 stdout note em-dash character (`—`, U+2014) trips a byte-count assertion in a scraper that counted the string in ASCII bytes. Mitigation: SC-006 specifies byte-exact — the assertion should match the UTF-8-encoded byte sequence, not char count. Test fixtures encode the literal em-dash directly (verified by hex-dump of the string in the assertion).
- **Risk**: `status`'s new `'error'` sentinel adds visual noise if `gh` has a transient error on a large snapshot. Mitigation: this is the intended surface — one row briefly showing `error` on a transient gh hiccup is exactly the observability signal that finding #20 (last week's blank-column observation) was missing. The visible error is preferable to silent absence.
- **Risk**: `watch`'s `diff.ts` emits a `pr-checks` line on the first-poll `none → success` transition when a real repo's CI arrives mid-watch, adding noise to actionable-only consumers. Mitigation: Q3→A pinned this as intended behavior — a repo gaining CI mid-watch IS a real observable event; `'none'` is inherently non-actionable, so `actionable.ts` filters it out for consumers that want only actionable events. `diff.ts`'s emission is consumed by `emit.ts` which prints all transitions; that's the design.
- **Rollback**: revert `wrapper.ts` (1 hunk), `merge.ts` (1 hunk), `check-rollup.ts` (1 hunk), `snapshot.ts` (1 hunk), `status/row.ts` (1 hunk), `status.ts` (1 hunk), `watch/poll-loop.ts` (1 hunk), plus the seven test files. No data migration, no relay-payload change, no coordinated cross-repo work. Rollback restores the pre-fix behavior (finding #22 recurs on sniplink#16), which is the acceptable pre-#857 baseline.
