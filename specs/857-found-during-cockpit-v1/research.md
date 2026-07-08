# Research: #857 — no-checks is not RED

## Decisions

### D1 — Detect "no checks reported" via stderr substring, not exit-code semantics

**Decision**: In `getPullRequestCheckRuns`, when `result.exitCode !== 0`, inspect `result.stderr` (case-insensitive) for the substring `no checks reported`. If present, return `[]`. Otherwise, keep the existing `logger.warn` + `throw` path from #855.

**Rationale**: `gh pr checks` conflates two states in its exit code (both use exit 1): "one or more checks are failing/pending/cancelled" and "there are no checks reported on this branch". The exit code alone cannot distinguish them; the stderr message can. `no checks reported` is a fixed prefix in gh's source for the no-checks state (`no checks reported on the '<branch>' branch`). It has appeared verbatim since gh 2.14 (Nov 2022) and does not overlap any other gh error phrase we could find in the changelog, source, or in captures across gh 2.14–2.96. Using a substring rather than an anchored regex avoids false negatives if gh adds a suffix (e.g., surrounding quotes, ANSI codes).

**Alternatives considered**:
- **A: Parse `gh api /repos/{owner}/{repo}/commits/{ref}/check-runs` directly.** Bypasses the exit-1 conflation entirely. Rejected: adds a second gh call per PR checked, changes the response shape (raw check-runs API returns `check_runs[]` not the same fields), and forces us to re-implement `normalizeCheckState` for the raw API's `conclusion` vocabulary. High blast radius for the same information.
- **B: Add `--exit-status=noexit-if-no-checks` (hypothetical gh flag).** No such flag exists.
- **C: Detect "no checks" as `stdout === '[]'` on exit 1.** Rejected: on the no-checks path, gh returns exit 1 BEFORE any JSON is emitted. `stdout` is empty (not `'[]'`). Verified on gh 2.96 against sniplink#16.
- **D: Regex `^no checks reported`.** Rejected: gh's line may or may not include a leading `!` or a colored prefix depending on TTY detection. Substring is more robust.

**Sources**: 
- gh source at `pkg/cmd/pr/checks/checks.go` (message emitted around the no-runs branch).
- Live capture from `christrudelpw/sniplink#16` on gh 2.96 (finding #22 of the cockpit v1 smoke test).
- gh 2.14 release notes confirming the `pr checks` command's no-checks message.

### D2 — Requiredness is the merge authority; fallback source means noRequired=true

**Decision**: In `runMerge`, define `noRequired` as:
- `required.source === 'branch-protection'` → `(required.names?.length ?? 0) === 0`
- `required.source === 'fallback-pr-checks'` → `true`

Vacuous-green fires when `actualChecks.length === 0 && noRequired`.

**Rationale**: The `fallback-pr-checks` source means "we couldn't read branch protection" — typically HTTP 403 (insufficient token scope) or HTTP 404 (branch is not protected). The 404 case IS the "no CI on unprotected repo" scenario finding #22 hits. In that case there is no authoritative required set, so the merge invariant reduces to the workflow's own gate (`completed:validate`) plus "no actual failing checks reported". Both conditions being true is vacuously green.

The 403 case is an operator misconfiguration (token can't read branch protection), and treating it as noRequired=true would mask a real setup problem. However, the existing `logger.warn('required-check set derived from PR check list; token cannot read branch protection')` already surfaces that. The choice is: silently mask + warn (current post-fix), or refuse to merge and force the operator to fix the token. We choose the former because:
1. The warn log already exists (loud enough for observability).
2. `completed:validate` remains mandatory — the workflow still gates on its own quality signal.
3. Blocking merge on a 403 is disproportionate to the operator's request (they explicitly asked to merge, `completed:validate` is set, no failing checks are reported).

**Alternatives considered**:
- **A: Treat fallback source as noRequired=false; force branch-protection reachability.** Rejected: recreates finding #22 for CI-less unprotected repos, which is the whole point of this fix.
- **B: Distinguish 403 (block merge) from 404 (allow merge) inside `getRequiredCheckNames`.** Rejected: adds a second sentinel to `RequiredChecksResult.source` (e.g., `'fallback-403' | 'fallback-404'`) that's out of proportion to the value. The wrapper today lumps both under `fallback-pr-checks` and that boundary is fine.

**Sources**: 
- Spec's clarifications (Q2 rationale — the `'none'` becomes legitimate data thesis).
- `packages/cockpit/src/gh/wrapper.ts:837-879` — `getRequiredCheckNames` implementation.
- `packages/generacy/src/cli/commands/cockpit/merge.ts:142-146` — the existing fallback warn.

### D3 — Widen `ChecksRollup` to include `'none'` and `'error'`

**Decision**: `ChecksRollup` becomes `'pending' | 'success' | 'failure' | 'none' | 'error'`. `'none'` = wrapper returned `[]` (repo has no CI); `'error'` = wrapper threw (fetch failure). `rollup([])` returns `'none'` (was `'pending'`).

**Rationale**: The pre-fix conflation collapsed three distinct states (has CI + pending, no CI, gh call failed) into `'pending'` or `'none'`. Finding #20 (last week's blank-column observation) was operators unable to distinguish "no CI" from "gh failed" because both rendered `none`. Making them distinct sentinels (Q2→C) restores observability with one string-union widening and one catch-block mapping change per verb.

`rollup([]) === 'none'` (not `'pending'`) because that's the semantic — an empty check-run list means "no checks reported", not "checks are pending". The prior `'pending'` was an unfortunate coincidence: `'pending'` didn't lie about the state on repos where CI was actually pending, but it DID lie on repos with no CI.

**Alternatives considered**:
- **A: Keep `ChecksRollup` at 3 members; surface `'none'`/`'error'` only in `StatusRow.checks`.** Rejected: `watch/snapshot.ts` and `watch/diff.ts` reference the union directly; keeping them narrower forces `poll-loop.ts` to map back to `'pending'` for empty results, re-creating the conflation. Union widening is the natural place.
- **B: Use `null` for both `'none'` and `'error'`.** Rejected: renderer needs a printable string; `null` forces every consumer to `?? '<sentinel>'`. String literals are simpler.
- **C: Distinct 'no-ci' string.** Rejected: `'none'` matches the pre-existing `StatusRow.checks` sentinel — no need to invent a new word.

**Sources**: 
- Clarifications Q2 → C rationale.
- Clarifications Q3 → A rationale (implicit `actionable`/`diff` semantics for `'none'`).

### D4 — Merge decision-tree extension goes BEFORE `classifyChecks`

**Decision**: The vacuous-green branch (empty actual + noRequired → merge with note) fires as an explicit `if (noActual && noRequired)` block BEFORE the `classifyChecks(...)` call. In all other cases, execution falls through to the existing `classifyChecks` + `ok ? merge : return red` flow.

**Rationale**:
1. `classifyChecks` on empty-actual + branch-protection-required-empty already returns `{ failingChecks: [], ok: true }` correctly (empty loop). So the "explicit branch before classify" is not strictly necessary for correctness on THAT sub-case.
2. But the explicit branch is REQUIRED for the FR-003 stdout note emission (Q1→A). The existing green path returns `{ exitCode: 0, stdout: '' }` — there's no seam to inject the note from inside `classifyChecks`.
3. Adding the explicit branch also makes the semantic ("this merge is vacuously green because both sides are empty") legible to a reader and to grep-based tests.
4. On empty-actual + branch-protection-required-non-empty, `classifyChecks` correctly emits one `MISSING` per required context, populates `failingChecks[]`, and the existing `ok === false` red-payload path fires. No new code path needed for regression test (b).

**Alternatives considered**:
- **A: Inject the note inside `mergePullRequest`.** Rejected: `mergePullRequest` is a wrapper method (cross-package boundary), doesn't know about `completed:validate` semantics, and the note is specifically about the merge-decision layer.
- **B: Emit the note via `logger.info`.** Rejected explicitly by Q1 clarification (routes through logger formatting, not part of the stdout contract, and the `'PR merged'` info log would collide).
- **C: Always emit the note, gated on `checksSkipped` boolean.** Rejected: the note is byte-exact only when checks are truly absent + none required. On a normal green merge (checks ran + passed), no note is emitted — that's the existing behavior and preserving it is FR-003's byte-exact requirement.

**Sources**: 
- Clarifications Q1 → A rationale.
- `packages/generacy/src/cli/commands/cockpit/merge.ts:169` — pre-fix green return path.

### D5 — Preserve #855's wrapper warn semantics, don't touch the log site

**Decision**: The `logger.warn({ repo, prNumber, ghStderr }, 'gh pr checks failed')` call from #855 stays exactly where it is. FR-002 (no warn on no-checks path) is satisfied by returning `[]` BEFORE reaching the warn/throw site. On real failures the warn still fires, unchanged.

**Rationale**: The wrapper log is the operator's leading indicator for observability into gh failures (#855 FR-005). Keeping the log call site intact means:
1. Real failures still emit the structured `{ repo, prNumber, ghStderr }` log.
2. The no-checks path is now silent at the wrapper (matches FR-002).
3. `status`/`watch` `catch` blocks fire only for real errors and map to `'error'` sentinel — the observable signal is the sentinel + wrapper warn, not a duplicate log at the CLI.

**Alternatives considered**:
- **A: Log an `info` on the no-checks path.** Rejected: adds noise for a legitimate steady state (repo has no CI).
- **B: Move the log to the CLI layer.** Rejected: cross-cuts #855's design, requires threading loggers through call sites that don't have them.

**Sources**: 
- #855 plan.md — "Wrapper-level warn log on failure" (FR-005).
- Clarifications Q2 → C — no-checks is legitimate data, error is a distinct sentinel.

## Non-decisions (deliberate)

- **`context.ts:287` bare-catch degrade** — unchanged. `context` builds a review payload; its `checks: []` on failure is source-compatible and doesn't render a rollup.
- **`gh pr checks --json bucket,link` field list** — unchanged from #855.
- **`normalizeCheckState`'s `bucket` vocabulary handling** — unchanged from #855.
- **`getRequiredCheckNames` fallback semantics** — unchanged (`source: 'fallback-pr-checks'` on 403/404 is pre-existing).
- **`classifyChecks`'s `MISSING` state emission** — unchanged; it already handles branch-protection-with-required-set + absent-actual correctly.
- **`RequiredChecksResult` shape** — unchanged (`{ source, names }`).
- **Wrapper's optional `logger` DI (from #855)** — unchanged.
- **Consumer catch behavior at `context.ts:287`** — unchanged; out of scope.

## Implementation patterns adopted

- **Substring detection over regex** — for the stderr `no checks reported` match: robust to leading TTY color codes, prefix punctuation, and trailing quotes. `String.prototype.includes` + `toLowerCase()` for case-insensitivity.
- **Explicit early-return branch in `runMerge`** — mirrors the existing `if (prRef == null)`, `if (prRef.state !== 'OPEN')`, `if (issueState.state === 'CLOSED')`, `if (!labels.includes(...))` pattern. Zero new abstraction.
- **Union widening at the type-carrier files (`snapshot.ts`, `row.ts`) then downstream renderers pick up automatically** — mirrors #855's `CheckRunSummary` interface delete.
- **Regression tests derived from live captures** — the `no checks reported` stderr fixture in `gh-wrapper.test.ts` and the sniplink#16 flow in `merge.test.ts` are copied from real gh output on the finding-#22 PR, not invented.

## Sources / references

- **Live repro**: `christrudelpw/sniplink#16` (issue #2) — CI-less, unprotected, `completed:validate` set. Exit 1 with stderr `no checks reported on the '002-phase-1-foundation-part' branch`.
- **Prior art**: 
  - #855 (`packages/cockpit/src/gh/wrapper.ts:587-606` post-fix, wrapper warn semantics, drift suite).
  - #853 (`fetchIssueState` field-list fix — same shape of drift bug at a different call site).
  - #836 (`resolveIssueContext` bare-number acceptance).
  - #826, #800 (earlier `gh` interface-drift bugs; the tests-encode-the-bug pattern).
- **gh source**: `pkg/cmd/pr/checks/checks.go` (message string).
- **Spec docs**: `spec.md` FR-001 through FR-011, `clarifications.md` Q1 → A / Q2 → C / Q3 → A.
