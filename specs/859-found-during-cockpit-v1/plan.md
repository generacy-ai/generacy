# Implementation Plan: `cockpit merge` deletes the head branch after successful squash

**Feature**: After a successful squash-merge, `cockpit merge` deletes the PR's head branch via explicit ref DELETE; classifies the outcome as `deleted` / `already-gone` / `skipped-cross-fork` / `delete-failed` and appends a canonical line to stdout so the deletion outcome is visible.
**Branch**: `859-found-during-cockpit-v1`
**Date**: 2026-07-08
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md)
**Status**: Complete

## Summary

Root cause: `mergePullRequest` (`packages/cockpit/src/gh/wrapper.ts:799-812`) passes `--delete-branch=false` unconditionally. On the first successful cockpit squash-merge (christrudelpw/sniplink PR #16, finding #24 of the cockpit v1 smoke test tracked as generacy-ai/tetrad-development#88), GitHub therefore left the head branch (`002-phase-1-foundation-part`) behind — the "branch can be safely deleted" prompt reappears and the manual-playbook hygiene step comes back into scope. On an epic with many child issues, one stale speckit branch per child accumulates fast and confuses both later branch listings and the workers' checkout logic.

Fix (three coordinated changes across two packages, honoring the five clarifications):

1. **Wrapper: two new primitives** (Q3→C slimmed) — `packages/cockpit/src/gh/wrapper.ts`:
   - `PullRequestDetail` gains `headRepositoryOwner: string | null` (Q2→A: authoritative cross-fork signal sourced from `headRepositoryOwner.login`, `null` when the head repo has been deleted). `getPullRequestDetail`'s `--json` field list expands from ten fields to eleven; the raw schema gains a nullable `headRepositoryOwner: { login }` object.
   - New `deleteHeadRef(repo: string, headRef: string): Promise<DeleteHeadRefResult>` method (Q1→B: explicit ref delete). Runs `gh api -X DELETE repos/{owner}/{name}/git/refs/heads/{headRef}` via the shared `runner`. Return shape `{ outcome: 'deleted' | 'already-gone' | 'delete-failed', stderr?: string }`:
     - Exit 0 → `{ outcome: 'deleted' }`.
     - Exit non-zero with stderr matching `HTTP 404|HTTP 422` → `{ outcome: 'already-gone' }` (GitHub returns 422 when the ref no longer exists; 404 when the repo lookup itself misses — both semantically "not there").
     - Any other non-zero exit → `{ outcome: 'delete-failed', stderr: trimmed stderr }` — the runMerge classifier decides how to render.
   - No `isCrossForkPr` helper (Q3→C-slimmed rationale: one-line field comparison at the caller, not a plumbing helper).

2. **`runMerge`: orchestrate delete + classify + compose stdout** — `packages/generacy/src/cli/commands/cockpit/merge.ts`:
   - After a successful `gh.mergePullRequest(...)` on **either** the vacuous-green branch (finding #22, the #857 change) OR the classify-passing branch, resolve the deletion outcome:
     1. **Cross-fork pre-check (Q2→A, deterministic)**: `pr.headRepositoryOwner != null && pr.headRepositoryOwner !== issueRef.owner`. If true → outcome is `skipped-cross-fork`, do NOT call `deleteHeadRef`.
     2. Otherwise call `gh.deleteHeadRef(repo, pr.head)`. Its `outcome` field is the classification directly — no additional stderr pattern-matching in the caller (Q2→A explicit no-safety-net rationale).
   - Compose the canonical suffix (Q4→C, byte-exact for the four deterministic variants):

     | Outcome                | Canonical suffix                                                                 |
     |------------------------|----------------------------------------------------------------------------------|
     | `deleted`              | `merged and branch deleted\n`                                                    |
     | `already-gone`         | `merged (branch was already deleted)\n`                                          |
     | `skipped-cross-fork`   | `merged (branch delete skipped: cross-fork PR)\n`                                |
     | `delete-failed`        | `merged (branch delete failed: <trimmed gh stderr>)\n`                            |

     - On the **vacuous-green** path, the suffix REPLACES the trailing `\n` of `no checks configured and none required — proceeding on completed:validate\n` (i.e. the previous line stays with its `\n`, then the deletion line is appended in full). Net stdout: two lines terminated by a single `\n` each.
     - On the **classify-passing** path (previous stdout `''`), the suffix is the sole stdout line.
   - Exit code stays **0** for all four deletion outcomes. `delete-failed` is a warn-log + visible stdout suffix, NOT an exit-1 (the merge itself succeeded; branch hygiene is best-effort per the spec's "Handle gracefully" clause).
   - `delete-failed` also emits `logger.warn({ pr: pr.number, repo, headRef: pr.head, stderr }, 'branch deletion failed')` for observability. `already-gone` and `skipped-cross-fork` emit `logger.info(...)` at debug-friendly `info` level (`{ outcome, headRef }`).

3. **Tests** — regression fixtures covering the four outcomes plus the header-schema drift class the #855 lesson requires.

Everything else stays put. The `runMerge` decision tree keeps its shape (vacuous-green branch, classify-passing branch — both extended identically for the deletion suffix). No orchestrator, cluster-relay, control-plane, or cloud coupling. The wrapper's `mergePullRequest` continues to pass `--delete-branch=false` unchanged — the two-step design (Q1→B) requires that flag stay so the delete is caller-controlled.

Live-repro closure: on christrudelpw/sniplink post-fix, the next successful squash-merge deletes the head branch and stdout ends with `merged and branch deleted\n`. On a hypothetical repo where GitHub's own auto-delete-head-branches setting is enabled, `deleteHeadRef` will receive a 422 (ref already gone by the time the DELETE lands) and stdout ends with `merged (branch was already deleted)\n` — distinguishable from cross-fork skip and from real failures, which is the point of Q1→B over Q1→A.

Not-in-scope non-changes: retroactive cleanup of already-stale branches on existing epics (out-of-scope per spec); repo-level `delete_branch_on_merge` flip at scaffold time (out-of-scope per spec — separate consideration for the project-creation flow); operator opt-out flag (Q5→C — defer until real workflow surfaces demand).

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js ≥22 (root `package.json`, `packages/cockpit/package.json`, `packages/generacy/package.json`).
**Primary Dependencies**: `zod` (unchanged); `pino` at consumer boundary (unchanged); `vitest` for tests. No new deps.
**Storage**: N/A. Wrapper primitive + CLI orchestration fix. No persisted state; no relay payloads; no cloud coupling.
**Testing**: `vitest`. Files touched:
- `packages/cockpit/src/__tests__/gh-wrapper.test.ts` (MODIFIED — three new tests for `deleteHeadRef`: exit 0 → `deleted`; exit 1 + `HTTP 422` stderr → `already-gone`; exit 1 + `HTTP 404` stderr → `already-gone`; exit 1 + arbitrary stderr → `delete-failed` with stderr. Plus one test asserting `getPullRequestDetail` surfaces `headRepositoryOwner` for a same-owner PR and a fork PR, and `null` for a deleted head repo).
- `packages/generacy/src/cli/commands/cockpit/__tests__/merge.test.ts` (MODIFIED — new tests exercising each of the four deletion outcomes composed on top of both the vacuous-green path (line-2 append) and the classify-passing path (sole line): SC-101 same-owner + success → `deleted`; SC-102 same-owner + wrapper returns `already-gone` → `already deleted`; SC-103 cross-fork PR → `skipped: cross-fork PR` without calling `deleteHeadRef`; SC-104 same-owner + wrapper returns `delete-failed` → `delete failed: <stderr>` + `logger.warn` fired + exitCode still 0).

**Target Platform**: Node CLI (`generacy cockpit merge`) executed on operator workstations and inside cluster orchestrator processes. `gh` binary pinned to 2.96.x+ (verified `gh api -X DELETE repos/…/git/refs/heads/…` returns 422 for a missing ref on gh 2.96 — well below any deployed CI or dev environment).

**Project Type**: Monorepo two-package change. Primary: `packages/cockpit` (`gh/wrapper.ts`); consumer: `packages/generacy` (`cli/commands/cockpit/merge.ts`). No orchestrator, cluster-relay, control-plane, or cloud changes.

**Performance Goals**: N/A. The wrapper change adds exactly one additional `gh api` call per successful merge on non-cross-fork PRs (~200 ms round-trip; the merge itself takes multi-second). Cross-fork PRs add zero additional gh calls (skipped via field comparison).

**Constraints**:

- **Delete mechanism is explicit ref DELETE** (Q1→B). `mergePullRequest` continues to pass `--delete-branch=false`; `deleteHeadRef` fires as a second step. This is the mechanism that surfaces 422 vs. 404 vs. other stderr distinctly — the whole point of the classifier-per-outcome design.
- **Cross-fork detection is a deterministic field comparison** (Q2→A). Wrapper surfaces `headRepositoryOwner` on `PullRequestDetail`; caller compares against `issueRef.owner`. No stderr pattern-matching for permission strings — that's the fragility class this epic keeps deleting (#855 lesson).
- **`headRepositoryOwner` may be `null`** — GitHub returns `headRepositoryOwner: null` when the head fork has been deleted after the PR was opened. In that case the caller treats it as same-owner (attempt the delete; a residual permission error surfaces as `delete-failed` — the correct classification because we genuinely could not decide).
- **`gh api -X DELETE`'s "already gone" surface**: GitHub responds 422 `{ "message": "Reference does not exist" }` when the ref is absent (repo has `delete_branch_on_merge` on and beat us to it), and 404 when the repo lookup misses (unlikely but possible in edge cases). Detection: `stderr` includes `HTTP 422` OR `HTTP 404`. Case-sensitive uppercase per `gh api` stderr format (matches the `getRequiredCheckNames` pattern at `wrapper.ts:857`).
- **Wrapper never throws on non-zero delete exit** — every non-zero exit maps to `{ outcome: 'delete-failed' | 'already-gone', stderr? }`. The caller classifies. This mirrors `getRequiredCheckNames`'s fallback pattern (also non-throwing on the 403/404 case) rather than the `failIfNonZero(...)` throw pattern.
- **Stdout suffixes are canonical for the four deterministic variants** (Q4→C, byte-exact). `merged and branch deleted\n`, `merged (branch was already deleted)\n`, `merged (branch delete skipped: cross-fork PR)\n`, and prefix `merged (branch delete failed: ` with wrapped stderr free-form followed by `)\n`. Tests assert byte-exact for the four canonical strings (SC-101/SC-102/SC-103) and prefix-plus-substring for the wrapped-stderr line (SC-104).
- **Exit code unchanged by deletion outcome** — all four outcomes exit 0 when the merge itself succeeded. `delete-failed` is loud on stdout (visible outcome line) and via `logger.warn`, but does not fail the verb. Spec's "Handle gracefully" clause explicitly permits this.
- **`logger.warn` fires only for `delete-failed`** — `already-gone` and `skipped-cross-fork` are expected steady-state outcomes on repos with auto-delete enabled and on cross-fork PRs respectively; they emit `logger.info` at most. Only `delete-failed` warrants operator attention.
- **`mergePullRequest`'s `--delete-branch=false` flag stays** — flipping to `--delete-branch` would fold outcomes back into gh's opaque success (Q1→A rejected rationale). Any refactor that "cleans up" the flag re-introduces the visibility loss this fix exists to prevent.
- **No `--keep-branch` flag** (Q5→C). GitHub's UI "Restore branch" button is the one-click recovery path; adding an option with no requesting consumer is the dead-surface class the epic keeps deleting.
- **Merge invariant preserved**: "never merge on RED". Nothing about the delete-branch fix touches the pre-merge check-classification decision tree. Deletion runs strictly on the post-merge-success path.

**Scale/Scope**: 1 wrapper interface extension (`PullRequestDetail.headRepositoryOwner`), 1 wrapper method added (`deleteHeadRef` on both interface and impl), 1 raw schema updated (`PullRequestDetailRawSchema` gains one field), 1 CLI decision-tree extension (`runMerge` post-merge deletion classifier — one function per two success branches, ~40 LOC). ~60 LOC production change, ~140 LOC test change.

## Constitution Check

*GATE: no constitution file at `.specify/memory/constitution.md`. Repository-wide invariants from `CLAUDE.md`, prior cockpit fixes (#800/#826/#836/#845/#853/#855/#857), and this spec's clarifications:*

| Gate | Result | Note |
|------|--------|------|
| No new backwards-compat shims for removed code | PASS | No shims added. `PullRequestDetail.headRepositoryOwner` is a new nullable field, source-additive (existing consumers ignore it). No sentinel is retained. |
| Change matches the spec's Q&A intent, not just the letter | PASS | Q1→B (explicit ref DELETE), Q2→A (wrapper field, no safety-net stderr matching), Q3→C-slimmed (two wrapper primitives, caller orchestrates), Q4→C (canonical for the four deterministic variants, prefix + free stderr for delete-failed), Q5→C (no flag) — all honored. No option drift. |
| Tests hit real behavior, not mocks-of-mocks | PASS | Wrapper unit tests use `fakeRunner` fixtures with stderr strings taken from real `gh api -X DELETE` responses (verified 422 message on a repo with no ref, 404 message on a repo missing the repo lookup — pinned in fixtures, not invented). `runMerge` tests use fakeGh with `getPullRequestDetail` + `deleteHeadRef` return values that mirror the wrapper's post-fix shape. No test-encodes-the-bug pattern. |
| Counterexample fixture for the tests-encode-the-bug pattern (#800/#826/#836/#853/#855/#857) | PASS | The wrapper fixtures pin the exact `HTTP 422` and `HTTP 404` stderr substrings from real `gh api` output; a future revert that flips detection to a wrong substring (`404 Not Found`, `422 Unprocessable`) fails immediately. The runMerge SC-101→SC-104 suite pins the four canonical stdout lines byte-exact; a rewording revert fails immediately. |
| Structured logging conventions | PASS | `logger.warn({ pr, repo, headRef, stderr }, 'branch deletion failed')` follows the existing `warn({ repo, prNumber, ghStderr }, 'gh pr checks failed')` shape from #855. `logger.info({ outcome, headRef }, 'branch deletion outcome')` for the info paths. No unstructured messages. |
| Zero new runtime dependencies | PASS | Only existing zod/vitest and `String.prototype.includes` on the `HTTP 422|HTTP 404` disjunction. |
| Fail-loud, don't silently degrade | PASS | `delete-failed` emits both `logger.warn` and a visible stdout suffix. `already-gone` and `skipped-cross-fork` are steady-state outcomes and emit stdout-visible suffixes. There is no silent path. |
| `merge` invariant "never merge on RED" | PASS | Deletion runs strictly on the post-merge-success path. The pre-merge classify-checks decision tree is untouched. |
| Wrapper stays "thin" (Q3→C-slimmed rationale) | PASS | Wrapper gains exactly two primitives — one field on an existing interface, one new method — and does no classification. Outcome classification lives in `runMerge` where the rest of the decision tree already lives. No `isCrossForkPr` helper. |
| No stderr pattern-matching for permission strings (Q2→A rejection of B/C safety net) | PASS | Cross-fork detection is a deterministic field comparison. `deleteHeadRef`'s stderr detection covers only the deterministic `HTTP 422|HTTP 404` substrings — a residual permission error after the pre-check passes falls through to `delete-failed`'s free-form-stderr suffix, which is the correct classification. |
| Live-repro-driven fix (finding #24) | PASS | The exact terminal state on christrudelpw/sniplink PR #16 (successful squash + head branch left behind + "safe to delete" prompt visible) is the driving regression. Post-fix behavior on the next such merge: head branch deleted, stdout ends with `merged and branch deleted\n`, no manual hygiene step. |

Post-Phase-1 re-check: no violations introduced.

## Project Structure

### Documentation (this feature)

```text
specs/859-found-during-cockpit-v1/
├── spec.md              # (present, unchanged by /plan)
├── clarifications.md    # (present, unchanged by /plan)
├── plan.md              # THIS FILE
├── research.md          # Phase 0 output — decisions + rationale
├── data-model.md        # Phase 1 output — type extensions
├── quickstart.md        # Phase 1 output — verification steps
├── contracts/
│   ├── delete-head-ref.md            # Wrapper method contract (delete-outcome semantics)
│   ├── pull-request-detail-owner.md  # PullRequestDetail.headRepositoryOwner field contract
│   └── run-merge-deletion.md         # runMerge deletion classifier + stdout suffix matrix
└── checklists/          # (empty)
```

### Source Code (repository root)

```text
packages/cockpit/src/gh/
└── wrapper.ts                                       # MODIFIED — PullRequestDetail gains headRepositoryOwner;
                                                    #            PullRequestDetailRawSchema gains nullable owner;
                                                    #            getPullRequestDetail JSON list expands;
                                                    #            GhWrapper interface gains deleteHeadRef;
                                                    #            impl adds deleteHeadRef method

packages/cockpit/src/__tests__/
└── gh-wrapper.test.ts                               # MODIFIED — 4 new tests: deleteHeadRef {0 → deleted,
                                                    #            1 + HTTP 422 → already-gone,
                                                    #            1 + HTTP 404 → already-gone,
                                                    #            1 + other stderr → delete-failed};
                                                    #            1 test: headRepositoryOwner surfacing (same-owner / fork / null)

packages/generacy/src/cli/commands/cockpit/
└── merge.ts                                         # MODIFIED — post-merge deletion classifier;
                                                    #            stdout suffix composition for both success branches;
                                                    #            logger.warn on delete-failed; logger.info on info paths

packages/generacy/src/cli/commands/cockpit/__tests__/
└── merge.test.ts                                    # MODIFIED — SC-101/102/103/104 (deletion-outcome regression suite)
```

### `wrapper.ts` delta — `PullRequestDetail` + raw schema (source)

```diff
 export interface PullRequestDetail {
   number: number;
   title: string;
   url: string;
   base: string;
   head: string;
+  headRepositoryOwner: string | null;
   body: string;
   author: { login: string } | null;
   state: 'OPEN' | 'CLOSED' | 'MERGED';
   draft: boolean;
   labels: string[];
   diff: string;
   diffTruncated: boolean;
 }
```

```diff
 const PullRequestDetailRawSchema = z
   .object({
     number: z.number().int(),
     title: z.string(),
     url: z.string(),
     baseRefName: z.string(),
     headRefName: z.string(),
+    headRepositoryOwner: z
+      .object({ login: z.string() })
+      .passthrough()
+      .nullable()
+      .optional(),
     body: z.string().nullable().optional(),
     …
   })
   .passthrough();
```

### `wrapper.ts` delta — `getPullRequestDetail` JSON field list (source)

```diff
     const viewResult = await this.runner('gh', [
       'pr',
       'view',
       String(prNumber),
       '--repo',
       repo,
       '--json',
-      'number,title,url,baseRefName,headRefName,body,author,state,isDraft,labels',
+      'number,title,url,baseRefName,headRefName,headRepositoryOwner,body,author,state,isDraft,labels',
     ]);
```

```diff
     return {
       number: detail.data.number,
       title: detail.data.title,
       url: detail.data.url,
       base: detail.data.baseRefName,
       head: detail.data.headRefName,
+      headRepositoryOwner: detail.data.headRepositoryOwner?.login ?? null,
       body: detail.data.body ?? '',
       …
     };
```

### `wrapper.ts` delta — new `deleteHeadRef` primitive (source)

```diff
+export interface DeleteHeadRefResult {
+  outcome: 'deleted' | 'already-gone' | 'delete-failed';
+  stderr?: string;
+}
```

```diff
 export interface GhWrapper {
   …
   mergePullRequest(
     repo: string,
     prNumber: number,
     opts: { squash: true },
   ): Promise<MergeResult>;
+  deleteHeadRef(repo: string, headRef: string): Promise<DeleteHeadRefResult>;
   …
 }
```

```diff
+  async deleteHeadRef(
+    repo: string,
+    headRef: string,
+  ): Promise<DeleteHeadRefResult> {
+    const [owner, name] = repo.split('/');
+    if (!owner || !name) {
+      throw new Error(
+        `deleteHeadRef: repo must be "owner/name", got: ${repo}`,
+      );
+    }
+    const result = await this.runner('gh', [
+      'api',
+      '-X',
+      'DELETE',
+      `repos/${owner}/${name}/git/refs/heads/${headRef}`,
+    ]);
+    if (result.exitCode === 0) {
+      return { outcome: 'deleted' };
+    }
+    const stderr = result.stderr.trim();
+    if (/HTTP\s+422|HTTP\s+404/.test(stderr)) {
+      return { outcome: 'already-gone' };
+    }
+    return { outcome: 'delete-failed', stderr };
+  }
```

### `merge.ts` delta — post-merge deletion classifier (source)

```diff
   if (noActual && noRequired) {
     await gh.mergePullRequest(repo, pr.number, { squash: true });
     logger.info({ pr: pr.number }, 'PR merged');
+    const deletionSuffix = await classifyAndDeleteBranch({
+      gh,
+      pr,
+      issueRef,
+      logger,
+    });
     return {
       exitCode: 0,
-      stdout: 'no checks configured and none required — proceeding on completed:validate\n',
+      stdout:
+        'no checks configured and none required — proceeding on completed:validate\n' +
+        deletionSuffix,
     };
   }

   const { failingChecks, ok } = classifyChecks({ required, actual: actualChecks });
   if (!ok) { … /* unchanged */ }

   await gh.mergePullRequest(repo, pr.number, { squash: true });
   logger.info({ pr: pr.number }, 'PR merged');
-  return { exitCode: 0, stdout: '' };
+  const deletionSuffix = await classifyAndDeleteBranch({
+    gh,
+    pr,
+    issueRef,
+    logger,
+  });
+  return { exitCode: 0, stdout: deletionSuffix };
 }
```

New helper (same file, or `merge/delete-head-branch.ts` if it grows — keep in-file at first, split only if a second consumer appears):

```typescript
interface DeletionCtx {
  gh: GhWrapper;
  pr: PullRequestDetail;
  issueRef: IssueRefWithState;
  logger: Logger;
}

async function classifyAndDeleteBranch(ctx: DeletionCtx): Promise<string> {
  const { gh, pr, issueRef, logger } = ctx;

  // Cross-fork pre-check (Q2→A, deterministic field comparison).
  if (
    pr.headRepositoryOwner != null &&
    pr.headRepositoryOwner !== issueRef.owner
  ) {
    logger.info(
      { pr: pr.number, headRef: pr.head, headOwner: pr.headRepositoryOwner },
      'branch deletion skipped: cross-fork PR',
    );
    return 'merged (branch delete skipped: cross-fork PR)\n';
  }

  const result = await gh.deleteHeadRef(
    `${issueRef.owner}/${issueRef.repo}`,
    pr.head,
  );
  switch (result.outcome) {
    case 'deleted':
      return 'merged and branch deleted\n';
    case 'already-gone':
      logger.info(
        { pr: pr.number, headRef: pr.head },
        'branch was already deleted',
      );
      return 'merged (branch was already deleted)\n';
    case 'delete-failed':
      logger.warn(
        { pr: pr.number, repo: `${issueRef.owner}/${issueRef.repo}`, headRef: pr.head, stderr: result.stderr },
        'branch deletion failed',
      );
      return `merged (branch delete failed: ${result.stderr ?? ''})\n`;
  }
}
```

Notes on the merge diff:
- The helper is invoked identically from both the vacuous-green branch (line-2 append) and the classify-passing branch (sole line). Two call sites — same helper — matches the "two success paths, one deletion policy" structure.
- `pr.headRepositoryOwner === null` (deleted head fork) falls through to the `deleteHeadRef` call, because we cannot deterministically decide it's cross-fork. A residual 403/permission-shape error there correctly surfaces as `delete-failed` with a free-form stderr — the user sees the reason, exit code stays 0.
- `pr.head` is the raw head ref (e.g. `feature/x`); URL-encoding of `/` is not required by `gh api` (verified with `gh api repos/…/git/refs/heads/feature%2Fx` and `.../heads/feature/x` — both work; the unencoded form matches the format used in scaffolded workflows).

**Structure Decision**: Two-package fix. Wrapper change is one new interface field plus one new method (~30 LOC combined). Consumer change is the post-merge deletion classifier — one helper (~35 LOC) invoked identically from two success sites (~4 LOC each). No orchestrator, cluster-relay, control-plane, or cloud coupling; no data-model persistence changes; no new files (the classifier helper stays in `merge.ts` per the "no premature abstraction" rule).

## Complexity Tracking

*Constitution Check passed; no violations.*

One judgment call worth calling out:

1. **Wrapper's `deleteHeadRef` does NOT throw on non-zero exit; it returns `{ outcome: 'delete-failed', stderr }` instead.** The alternative — `failIfNonZero(...)` + caller catches — was rejected because the caller wants outcome semantics (which is what the `outcome` union expresses), not exception-flow semantics. `getRequiredCheckNames` at `wrapper.ts:855-858` sets the precedent (403/404 → `source: 'fallback-pr-checks'`, not throw). Adopting the same shape keeps the wrapper's contract predictable across primitives — every method returns a discriminated-union result for expected non-happy paths, and throws only for unrecoverable protocol errors (malformed JSON, unrecognized shape). Regression test SC-104 pins that a wrapper `{ outcome: 'delete-failed' }` return value produces the correct `delete failed:` suffix without any try/catch on the caller side.

## Risk / Rollback

- **Risk**: `gh api` changes stderr wording for the 422/404 case in a future release (e.g. drops the `HTTP 422` prefix). Mitigation: the wrapper's fallback direction on non-match is the `delete-failed` outcome, which surfaces immediately as a visible stdout suffix and a wrapper warn log — loud regression, not silent misbehavior. Fix is a one-line regex update in `deleteHeadRef`.
- **Risk**: a PR is opened from a fork where the fork has since been transferred to the base owner's org (rare — head repo owner now equals base owner, but the token still lacks push perms). Mitigation: the deterministic pre-check permits the delete attempt; a residual 403 surfaces as `delete-failed` with the raw gh stderr on stdout — visible and correctly classified. No misclassification, no silent skip.
- **Risk**: `gh api -X DELETE` requires `repo` scope which some tokens lack (rare for cockpit-issued tokens, which have `repo` scope by default per `#620`'s wizard-creds env bridge). Mitigation: same as above — `delete-failed` with the auth-error stderr, exit 0, merge succeeded. The operator sees the reason and can act (or ignore — the merge is already done).
- **Risk**: adding `headRepositoryOwner` to the `--json` field list causes `gh pr view` to fail on very old gh versions that don't recognize the field. Mitigation: `gh pr view --json headRepositoryOwner` has been supported since gh 2.14 (verified in changelog); the pinned floor is 2.96.x, well above. If a future revert accidentally strips the field, `PullRequestDetailRawSchema.safeParse` fails with a shape-mismatch throw — loud.
- **Risk**: consumers of `PullRequestDetail` OTHER than `runMerge` see the new `headRepositoryOwner` field and misinterpret `null` as "no head repo" when it actually means "head fork was deleted". Mitigation: grep for `PullRequestDetail` in `packages/` — the type is consumed only by `runMerge`, `review-context` payloads (which don't render the field), and cockpit's `context` verb (which passes through). No downstream ambiguity.
- **Risk**: the classify-passing branch's stdout was previously `''`; consumers piping `runMerge`'s stdout may see a new non-empty line and treat it as an error signal. Mitigation: cockpit's own consumers already handle non-empty success-path stdout (per the #857 vacuous-green precedent, which added a note to the same field). Any external scraper that assumed empty-stdout-means-success on cockpit merge success needs updating — the deletion outcome is meaningful signal, not noise.
- **Risk**: the FR-002 wording `merged and branch deleted` collides with a substring assertion in some downstream harness. Mitigation: SC-101→SC-103 specify byte-exact strings; the exact strings are unique and short enough that no reasonable harness has been asserting on partial matches. If a collision surfaces, prefix the stdout with `cockpit merge: ` — separate follow-up, not this issue.
- **Rollback**: revert `wrapper.ts` (three hunks: `PullRequestDetail` field, raw schema field, JSON list expansion, method addition), `merge.ts` (helper + two call-site hunks), plus the two test files. No data migration, no relay-payload change, no coordinated cross-repo work. Rollback restores the pre-fix behavior (finding #24 recurs on the next successful cockpit squash-merge), which is the acceptable pre-#859 baseline.
