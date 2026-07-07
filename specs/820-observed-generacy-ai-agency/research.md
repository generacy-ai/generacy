# Research: #820 — Fail loud when implement phase produces no product changes

## R1: How does the current check misfire?

**Question**: Why did agency PR #376 merge with a spec-only implement phase when `PHASES_REQUIRING_CHANGES` explicitly names `implement`?

**Investigation**: Read `packages/orchestrator/src/worker/phase-loop.ts:344–396` and `packages/orchestrator/src/worker/pr-manager.ts:57–121` (`commitAndPush`).

**Finding**: `hasChanges` is derived from `git status --porcelain` inside `PrManager.commitAndPush` (via `github.getStatus()` at `pr-manager.ts:62`). That's an *unfiltered* count — any file counts, including `specs/**`. The `PHASES_REQUIRING_CHANGES.has(phase) && !hasChanges` guard at line 351 asks the wrong question: it's checking whether the phase produced *any* diff, not whether it produced *product* diff.

Even worse, the `hasPriorImplementation` fallback at lines 355–374 masks the failure once the branch acquires any commit whose message contains `complete implement phase`, `feat: complete T`, or `partial implement progress` — three substrings the implement CLI wrote by default. On agency#376 the branch already had spec commits with those substrings, so even if `hasChanges` had somehow been false, the fallback would have blessed the run anyway.

**Implication**: The fix has two parts:
1. Filter `hasChanges` by path (or replace it with a cumulative branch-diff computation, per Q2).
2. Delete the commit-message heuristic — it is a positive-detection shortcut for the wrong signal.

## R2: What git operation gives us "cumulative branch diff minus excluded paths"?

**Question**: Which git command answers "what files changed on this branch vs. the base ref, with merge-base semantics?"

**Investigation**: The repo already invokes `git diff --name-only` in two places (`gh-cli.ts:790` for HEAD-only, `gh-cli.ts:918` for unmerged files). Neither takes a base ref.

**Finding**: `git diff --name-only <base>...<head>` (triple-dot) does exactly what we need:
- Names files, one per line, on stdout.
- Triple-dot resolves to `git diff $(git merge-base base head) head`, so rebased branches or long-lived branches don't overcount base-branch commits (Clarification Q3 rationale).

**Decision**: Add one `GitHubClient` method: `getFilesChangedBetween(base: string, head: string): Promise<string[]>`. Implement via `executeCommand('git', ['diff', '--name-only', `${base}...${head}`], { cwd: this.workdir })`. Return `stdout.split('\n').filter(Boolean)`.

**Alternatives considered**:
- `git rev-list <base>..HEAD --format="%H"` then per-commit `git diff-tree` — walks commits, matches option B in Q2. Rejected: two round-trips per commit, and less truthful than the cumulative net diff.
- GitHub API's `compareCommits` (`GET /repos/{owner}/{repo}/compare/{base}...{head}`) — network round-trip vs. local git, and less reliable pre-push. Rejected.
- `git status --porcelain` filtered by prefix — only sees uncommitted files. Rejected: cumulative branch diff is the target, not the working tree.

## R3: Where does the PR's base ref come from?

**Question**: How does the phase loop discover the PR's *actual* base (vs. the default branch)?

**Investigation**: `PrManager.ensureDraftPr` at `pr-manager.ts:131–178` calls `github.createPullRequest(...)` with `base: defaultBranch` today, and caches `this.prNumber`. `github.getPullRequest(owner, repo, number)` at `gh-cli.ts:363` returns a `PullRequest` whose `base.ref` is the actual base.

**Finding**: The path is `PrManager.getPrNumber()` (small addition) → `github.getPullRequest(...)` → `.base.ref`. When no PR exists yet, `getDefaultBranch()` is the correct fallback (matches the `commitAndPush` fallback logic at `pr-manager.ts:86–89`).

**Decision**: Add `PrManager.getPrNumber(): number | undefined` and implement `resolveBaseRef(github, prManager, owner, repo)` in the new `product-diff.ts` helper.

**Alternatives considered**:
- Extend the `PrManager` interface to expose base ref directly, cached. Rejected: `PrManager` should not double as a metadata cache; the number is enough.
- Compute base from `context` metadata written at worker init. Rejected: mutation-in-flight case (Failure Modes table in plan.md) means the freshest source is authoritative.

## R4: Which matcher for the exclusion prefix?

**Question**: Prefix, glob, or gitignore semantics?

**Investigation**: The clarification session (Q4) evaluated three options. The repo has no shared glob helper in the orchestrator package; `micromatch`/`minimatch` are not deps of `packages/orchestrator/*`. The exclusion list has exactly one entry (`specs/`) and is not user-configurable (Q1).

**Decision**: Literal prefix, `String.prototype.startsWith`. Store as `['specs/']` (with trailing slash) so `specs` as a file name would not accidentally match — although in practice `git diff --name-only` never emits directory entries, only files.

**Alternatives considered**:
- Minimatch — introduces a dep for one pattern. Rejected.
- `ignore` npm package (gitignore semantics) — over-featured; wrong signal (negation, hierarchy) for a fixed prefix list. Rejected.

## R5: Increment boundary vs. phase completion

**Question**: If `implement` is invoked N times (partial-implement + resume), when does the check fire?

**Investigation**: `phase-loop.ts:248–296` handles the increment path. When `result.implementResult?.partial` is true, the loop:
1. Commits a WIP message via `prManager.commitPushAndEnsurePr(phase, { message: 'wip(speckit): implement increment ...' })`.
2. Clears `currentSessionId`.
3. `i--` and `continue` — restarting the implement phase iteration.

The `continue` at line 295 short-circuits the rest of the loop body, including the `hasChanges` check (lines 351–396) that we're modifying.

**Finding**: The new check will naturally only fire once — when the implement phase reports `partial: false` and control falls through to the `commitPushAndEnsurePr(phase)` block on line 344. That matches Q5's "fire when the implement phase is about to complete" answer.

**Decision**: Do not add explicit "final iteration" gating; the existing structure already achieves it.

## R6: What sources feed the excluded prefix set?

**Question**: Should more than `specs/` be excluded now?

**Investigation**: Skimmed the workflows in `packages/orchestrator/src/worker/workflows/` and the speckit templates. Both `speckit-feature` and `speckit-bugfix` write only to `specs/**` and product code. Docs live at `docs/` — but those *are* product artifacts that a docs-only PR would legitimately update, and the current spec says nothing about docs-only workflows.

**Finding**: `specs/` is the correct single entry for the current speckit workflows. If a future workflow's `implement` legitimately produces only, say, `docs/**` diffs, the exclusion list can grow (with configuration promotion at that time — Q1 rationale).

**Decision**: Ship `['specs/']` only. No `docs/`, `.claude/`, `.github/`, or `README.md` variant.

## R7: Behavior when `git diff` throws

**Question**: What if `origin/<base>` is missing (rare — no remote, unfetched ref)?

**Investigation**: The existing `hasPriorImplementation` fallback catches errors and falls through to the error path (`try { ... } catch {}` at `phase-loop.ts:355–368`). But the *catch* branch there is empty, and control falls into the error label path only *if* `hasPriorImplementation` is false — meaning a git failure would be treated the same as "no prior implementation," which routes to error.

**Finding**: The new implementation should propagate the throw. Silently converting "diff computation failed" into "no product diff" is fine — both should route to `onError`. But we do want the error message to distinguish the two so operators can act correctly.

**Decision**: On `git diff` throw, log the error at `error` level with `{ base, head, stderr }`, and route to `onError` with a message that says "could not compute product diff against `<base>`". Operators seeing this message will know to check remote fetch / ref availability, not to hunt for missing product code.

## Key Sources

- `packages/orchestrator/src/worker/phase-loop.ts` — the current guard and the increment-boundary structure.
- `packages/orchestrator/src/worker/pr-manager.ts` — `hasChanges` derivation, PR/base caching.
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts:363–396` — `getPullRequest` returns `.base.ref`.
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts:660–724` — `getStatus` uses `git status --porcelain`.
- Clarifications document (`clarifications.md` in this feature dir) — Q1–Q5 record the decisions this research builds on.
- Issue body — `generacy-ai/generacy#820` and referenced agency PR #376.
