# Research: Implement-phase product-diff guard (#1107)

## Decision 1 — Diff-window mechanism: `git log --first-parent --no-merges`

**Chosen**: measure the phase's own files with
`git log --first-parent --no-merges --name-only --pretty=format: <startRef>..HEAD`,
deduplicated, then apply the exclusion sets.

**Why not `git diff <startRef>...HEAD` (three-dot)**: three-dot diffs against the
merge-base, which drifts as base merges land, so it does not isolate the phase's work.

**Why not `git diff <startRef> HEAD` (two-dot)**: a base merge on a resumed increment
brings develop's product files into the two-dot range, re-admitting exactly the
fail-open case Q4 forbids.

**Why first-parent + no-merges works** (traced against a persisted first-entry ref):

| Scenario | Commits in `startRef..HEAD` (first-parent, no-merges) | Result |
|---|---|---|
| Increment writes real code | phase commit `P1` | files present ⇒ **pass** (SC-003) |
| Increment writes nothing, only base merge | (merge commit dropped) | empty ⇒ **fail** (bug caught) |
| Resume completes, increment-1 wrote code | `P1` (via first-parent) | pass ⇒ no false-fail (Q5/SC-004 inverse) |
| Base merge brings develop product files | develop commits are 2nd-parent ⇒ excluded | not counted (Q4/SC-004) |
| Whole phase wrote only `specs/`+`CLAUDE.md` | conversation-log/CLAUDE.md commits | all excluded ⇒ **fail** (SC-001/SC-002) |

`--first-parent` never descends into merged-in develop commits; `--no-merges` drops the
merge commits themselves. What remains is the branch's own regular commits since
`startRef`. Earlier-phase commits (specify/plan/tasks) are before `startRef` and excluded
by range.

## Decision 2 — Start-ref capture point & persistence

- **Capture**: right after the pre-implement base-merge hook (`phase-loop.ts:301-317`)
  and before the CLI spawn, via `github.getCurrentCommitSha()` (new; local `git rev-parse HEAD`).
  Capturing *after* the merge means merged-in files are never in `startRef..HEAD` on the
  first increment.
- **Persist-once semantics**: key `phase-start-ref:<owner>:<repo>:<issue>:<phase>`.
  On entry, read the key; if present ⇒ reuse (resume, do NOT overwrite); if absent ⇒
  capture, persist, use. This makes the window span all increments (Q5 → B).
- **Store**: reuse `PhaseTrackerService` (already holds the worker Redis client and is
  already injected into the worker). Add `getValueRaw(key)`/`setValueRaw(key, value, ttl)`
  next to the existing `#892` raw-key methods.
- **TTL**: 7 days for the ref (vs. 24h dedup default) to survive long pauses; expiry
  degrades to re-capture (post-resume window), never to a silent pass.
- **Clear**: delete the key when the implement phase passes the guard (its natural
  completion, just before advancing). On failure, leave it (TTL backstop) so a retry
  still spans the phase.

**Alternatives considered**: a PR/issue HTML-comment marker (spec-suggested) — rejected
as heavier (GitHub round-trips, parse/format, race handling) when Redis is already
mandatory for workers and already wired.

## Decision 3 — Exact-filename exclusion (FR-001, Q3 → A)

- New constant `EXCLUDED_EXACT_PATHS = ['CLAUDE.md','AGENTS.md','GEMINI.md','.github/copilot-instructions.md']`.
- `isProductFile(path, prefixes = EXCLUDED_PATH_PREFIXES, exactPaths = EXCLUDED_EXACT_PATHS)`:
  returns `false` when `path` starts with any prefix **or** exactly equals any exact path.
- **Exact, root-relative match** — not `startsWith('CLAUDE.md')` (would swallow
  `CLAUDE.md.bak`) and not basename-at-any-depth (would exclude genuine
  `packages/*/CLAUDE.md` documentation work). Matches precisely what `update_agent`
  writes at repo root.

## Decision 4 — New GitHubClient methods vs. inline execFile

Add two methods to `GitHubClient` (interface + `gh-cli.ts`), mirroring the existing
local-git `getFilesChangedBetween` (`gh-cli.ts:1382`, runs `git diff` via
`executeCommand('git', …, { cwd: this.workdir })`):

- `getCurrentCommitSha(): Promise<string>` → `git rev-parse HEAD`, trimmed.
- `getFilesChangedByOwnCommits(startRef: string): Promise<string[]>` →
  `git log --first-parent --no-merges --name-only --pretty=format: <startRef>..HEAD`,
  split/trim/dedupe/drop-empty.

**Why on the client, not inline in `product-diff.ts`**: keeps the phase-loop and
product-diff unit tests mocking a single `github` object (matching the existing
`getFilesChangedBetween` test style), and colocates the local-git primitive with its peer.

## Decision 5 — `resolveBaseRef` retained for diagnostics only

The pass/fail decision now keys off the phase-scoped diff, not `baseRef`. `resolveBaseRef`
stays: (a) it is shared with `base-merge.ts` (FR-005 — untouched), and (b) FR-004 wants
"the base/start ref used" in failure diagnostics, so the guard logs both the resolved
`baseRef` and the phase `startRef`.

## Decision 6 — FR-006 deferred (Q2 → A)

The zero-tasks-checked net interacts with FR-002's resume semantics (a resumed increment
can legitimately check off zero *new* tasks) and needs its own design pass. Filed as a
follow-up. FR-001 + FR-002 each independently catch the reported failure.

## References

- `packages/orchestrator/src/worker/product-diff.ts` — current guard helpers.
- `packages/orchestrator/src/worker/phase-loop.ts:301-317` (base merge), `:686` (commit), `:709-784` (guard).
- `packages/workflow-engine/src/actions/github/client/gh-cli.ts:1382` — `getFilesChangedBetween` (local-git precedent).
- `packages/orchestrator/src/services/phase-tracker-service.ts` — raw-key methods (#892 precedent).
- `packages/orchestrator/src/server.ts:271-293` (Redis for workers), `:352,:380` (PhaseTracker wiring).
- Spec #820 (original guard), spec #892 (raw-key phase-tracker), #864/#914 (base-merge subsystem).
