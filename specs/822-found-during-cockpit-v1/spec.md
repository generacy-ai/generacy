# Feature Specification: Cockpit CLI status/watch argument-contract drift (positional refs + bare-number inference)

**Branch**: `822-found-during-cockpit-v1` | **Date**: 2026-07-07 | **Status**: Draft
**Issue**: [#822](https://github.com/generacy-ai/generacy/issues/822) | **Type**: Bug

## Summary

Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), on a fresh preview-channel cluster after the PATH fix (cluster-base#73): `/cockpit:status 1` reaches the CLI and dies with `error: required option '--epic <ownerRepoIssue>' not specified`.

Three-part argument-contract drift, all CLI-side:

1. **Inconsistent verb surfaces**: `queue` takes positional `<epic-ref> <phase>` (`packages/cockpit/src/cli/queue.ts:387`), but `status` (`status.ts:140`) and `watch` (`watch.ts:173`) require an `--epic <ownerRepoIssue>` flag. The rev-3 catalog (`docs/epic-cockpit-plan.md` in tetrad-development) and the shipped plugin (`claude-plugin-cockpit` `status.md`/`watch.md`, which pass `$ARGUMENTS` positionally) both specify positional `<epic-ref>`.
2. **Plugin/CLI mismatch**: every `/cockpit:status <ref>` and `/cockpit:watch <ref>` invocation fails at usage parsing. (Root cause of the drift: #806's issue text said "scope by `--epic` only", meaning *epic-scoping only, drop `--repos`* — implemented as keeping the flag.)
3. **No bare-number refs**: `parseEpicRef` (`packages/cockpit/src/resolver/resolve.ts:10-20`) accepts only `owner/repo#N`, so `--epic 1` fails too. Per the unified ref grammar decided on #807 (Q5), a bare number should resolve its repo from the cwd's git origin — in the primary use case the session cwd IS the project repo, and `/cockpit:status 1` is the natural invocation.

**Fix**: convert `status` and `watch` to positional `<epic-ref>` matching `queue` (delete the `--epic` flag — pre-1.0, no compat shim, one mechanism); extend the epic-ref grammar to accept a bare issue number by inferring `owner/repo` from the cwd origin (same inference `context` uses), keeping `owner/repo#N` and full-URL forms; loud `INVALID_EPIC_REF` error naming all accepted forms otherwise. No plugin change needed — it already passes positional refs.

**Repro**: `generacy cockpit status 1` → exit 1, usage error. **Expected**: renders the epic snapshot for issue 1 of the cwd repo.

## Clarifications

See `clarifications.md` for Q&A. Answers settled on 2026-07-07:

- **Q1 → A** (parser architecture): Lift resolution *up*. Each verb calls `resolveIssueContext(...)` FIRST (the same helper `cockpit context` already uses, in `packages/generacy/src/cli/commands/cockpit/resolver.ts`), which handles bare-number/owner-repo/URL parsing and cwd-origin inference; it then passes the expanded `owner/repo#N` to the existing sync `resolveEpic()` in `@generacy-ai/cockpit`. `@generacy-ai/cockpit` stays pure — no filesystem/git subprocess dependency added to the shared library.
- **Q2 → A** (file paths): The spec's `packages/cockpit/src/cli/*` paths are wrong. The real CLI verbs live at `packages/generacy/src/cli/commands/cockpit/{status,watch,queue}.ts`. Retarget all FR notes. `packages/cockpit/src/resolver/resolve.ts` is untouched (Q1=A).
- **Q3 → B** (error shape): Reuse the existing `parse issue: <detailed reason>` message from `resolveIssueContext`, wrapped as `Error: cockpit <verb>: parse issue: …`, exit 2. FR-007's "INVALID_EPIC_REF" named the *requirement* (loud + enumerate accepted forms), not a mandatory error-code string. Ensure the listed forms in the message now include the bare number.
- **Q4 → A** (`queue` migration): `queue` also routes through `resolveIssueContext` so `queue 1 <phase>` works. FR-009's "unchanged" refers to the *argument surface* (positional `<epic-ref> <phase>` stays byte-identical), not the internal parser call.
- **Q5 → A** (`--repo` flag): No `--repo` flag on `status`/`watch`. Session cwd is the single source of truth for bare-number inference (matches #807 Q5 precedent on `context`); a repo override is spelled `owner/repo#N` in the ref itself. `queue`'s existing `--repo` flag (which means *enqueue target*, not ref-resolution override) is unaffected.

## User Stories

### US1: Plugin-driven cockpit invocation (primary)

**As a** developer running `/cockpit:status <ref>` or `/cockpit:watch <ref>` inside a Claude session,
**I want** the CLI to accept the positional ref that the plugin passes through `$ARGUMENTS`,
**So that** the shipped `claude-plugin-cockpit` commands actually work without every invocation failing at Commander usage parsing.

**Acceptance Criteria**:
- [ ] `generacy cockpit status owner/repo#123` renders the epic snapshot.
- [ ] `generacy cockpit watch owner/repo#123` starts the watch stream.
- [ ] `--epic` flag is removed from both commands (no compat shim).
- [ ] Plugin markdown files (`status.md`, `watch.md`) require no change to work.

### US2: Bare-number ref in the primary cwd

**As a** developer whose session cwd IS the project repo,
**I want** `/cockpit:status 1` (or `generacy cockpit status 1`) to resolve issue 1 against the cwd's git origin,
**So that** the natural invocation just works without me typing the full `owner/repo#N`.

**Acceptance Criteria**:
- [ ] `generacy cockpit status 1` in a repo with origin `owner/repo` resolves to `owner/repo#1`.
- [ ] Same inference works for `queue`, `status`, and `watch` (single grammar).
- [ ] `owner/repo#N` and full GitHub URL forms continue to work unchanged.
- [ ] Bare number in a directory with no git origin fails with `INVALID_EPIC_REF` naming all accepted forms.

### US3: Consistent verb surfaces across cockpit

**As a** developer building on or extending the cockpit CLI,
**I want** every verb (`queue`, `status`, `watch`) to take the same positional `<epic-ref>` shape,
**So that** there is exactly one epic-ref mechanism to learn, document, and maintain — matching the rev-3 catalog and the "one mechanism" pre-1.0 principle.

**Acceptance Criteria**:
- [ ] `queue`, `status`, `watch` all use positional `<epic-ref>`.
- [ ] No verb accepts `--epic` as an alternative.
- [ ] Error output on missing ref is identical shape across verbs.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `cockpit status` accepts positional `<epic-ref>` (required, single argument) | P1 | `packages/generacy/src/cli/commands/cockpit/status.ts` (Q2→A retarget from `packages/cockpit/src/cli/status.ts`) |
| FR-002 | `cockpit watch` accepts positional `<epic-ref>` (required, single argument) | P1 | `packages/generacy/src/cli/commands/cockpit/watch.ts` (Q2→A retarget from `packages/cockpit/src/cli/watch.ts`) |
| FR-003 | `--epic <ownerRepoIssue>` flag is removed from `status` and `watch` (no deprecation path — pre-1.0) | P1 | One mechanism per rev-3 catalog. Also removes `--repo` from `status`/`watch` per Q5→A (never existed on those verbs today; regression-guard only). `queue`'s existing `--repo` (enqueue target) is unaffected |
| FR-004 | `status`, `watch`, `queue` each call `resolveIssueContext(epicRef, { gh })` FIRST to expand bare-integer / `owner/repo#N` / URL forms into `owner/repo#N`, then pass the expanded string to the existing sync `resolveEpic()` in `@generacy-ai/cockpit` | P1 | Q1→A: lift resolution up into the verb layer. Reuses `resolveIssueContext` in `packages/generacy/src/cli/commands/cockpit/resolver.ts` (the same helper `cockpit context` uses). `@generacy-ai/cockpit` stays pure — no git subprocess added. `packages/cockpit/src/resolver/resolve.ts` untouched |
| FR-005 | `owner/repo#N` form continues to work across all three verbs | P1 | No regression. Handled by the same `resolveIssueContext` → `resolveEpic` chain |
| FR-006 | Full GitHub issue URL form (`https://github.com/owner/repo/issues/N`) continues to work across all three verbs | P1 | No regression. Handled by the same chain |
| FR-007 | Invalid ref emits `Error: cockpit <verb>: parse issue: <reason>` (exit code 2) where `<reason>` enumerates all three accepted forms: bare number (`<n>`), `<owner>/<repo>#<n>`, and `https://github.com/<owner>/<repo>/issues/<n>` | P2 | Q3→B: reuse `parseIssueRef`/`resolveIssueContext`'s existing message shape, wrapped with verb name. Update its listed forms to include the bare number now that it's legal. Applies to all three verbs uniformly |
| FR-008 | Bare-number ref in a directory without a resolvable git origin emits the same `parse issue: …` error as FR-007 (single error mechanism) | P2 | Same error for all "can't resolve" paths — no distinct code for the origin-missing case |
| FR-009 | `queue` verb's argument surface is unchanged: still `<epic-ref> <phase>`, byte-identical | P1 | Q4→A: "unchanged" applies to the CLI surface. Internally `queue` also routes through `resolveIssueContext` (per FR-004) so `queue 1 <phase>` works. Regression-guard: existing `queue owner/repo#N <phase>` invocations continue to succeed |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `/cockpit:status <ref>` invocations that fail at Commander usage parsing | 0 (from every invocation today) | Manual repro on fresh preview-channel cluster: `generacy cockpit status 1`, `generacy cockpit status owner/repo#1` both succeed |
| SC-002 | `/cockpit:watch <ref>` invocations that fail at Commander usage parsing | 0 | Same as SC-001 for `watch` |
| SC-003 | Number of epic-ref parsing entrypoints in the CLI | 1 (`resolveIssueContext` in `packages/generacy/src/cli/commands/cockpit/resolver.ts`, called by all four verbs — `status`, `watch`, `queue`, `context` — before `resolveEpic`) | Grep for `--epic` flag references in `packages/generacy/src/cli/commands/cockpit/**` returns 0; grep for direct `parseIssueRef(` or `resolveEpic({ epicRef` calls that bypass `resolveIssueContext` in `status.ts`/`watch.ts`/`queue.ts` returns 0 |
| SC-004 | Bare-number invocation in cwd-is-repo scenario | Succeeds | `generacy cockpit status 1` in cwd whose origin is `owner/repo` renders the snapshot for `owner/repo#1` |
| SC-005 | Plugin markdown files touched | 0 | `claude-plugin-cockpit` (`status.md`, `watch.md`) unchanged; they already pass `$ARGUMENTS` positionally |

## Assumptions

- `resolveIssueContext` (in `packages/generacy/src/cli/commands/cockpit/resolver.ts`) is the shared ref-resolution helper; each cockpit verb calls it directly (Q1→A). `@generacy-ai/cockpit`'s `parseEpicRef`/`resolveEpic` stay sync and do not gain a git-subprocess dependency.
- No downstream tool, CI script, or docs (outside plugin markdown and cockpit CLI itself) invokes `cockpit status --epic ...` or `cockpit watch --epic ...`. Pre-1.0 = free to break the flag surface.
- Rev-3 catalog (`docs/epic-cockpit-plan.md` in tetrad-development) and #807 Q5 (unified ref grammar) are the authoritative contract — this bug fix aligns the CLI to them, not the other way around.
- The `#806` implementation misread ("scope by `--epic` only" as "keep `--epic` flag") is settled — no ambiguity to relitigate.
- `queue`'s existing `--repo` flag (enqueue target) is unrelated to ref resolution and is untouched by this fix; potential naming-overload cleanup is a separate follow-up (Q5→A).

## Out of Scope

- Any plugin-side change to `claude-plugin-cockpit` (`status.md`, `watch.md`). They already pass `$ARGUMENTS` positionally — that's why the fix is CLI-only.
- Deprecation shim / compat alias for `--epic`. Pre-1.0, one mechanism only.
- Multi-repo / `--repos` flag reintroduction — that was intentionally dropped in #806 and stays dropped.
- Cross-repo bare-number disambiguation (e.g. bare `1` when cwd has multiple potential owners). Session cwd is the single source of truth; ambiguity → `INVALID_EPIC_REF`.
- Changes to `cockpit queue`'s CLI argument surface — stays byte-identical (positional `<epic-ref> <phase>`). Internal wiring to `resolveIssueContext` is in scope per FR-004/FR-009 and Q4→A.
- `--repo` (singular) override flag on `status` or `watch`. Session cwd is the single source of truth for bare-number inference (Q5→A). `owner/repo#N` in the ref itself is the explicit-repo mechanism.
- Renaming or repurposing `queue`'s existing `--repo` flag (enqueue target). Naming-overload cleanup is a separate later issue.
- Broader CLI-argument-contract audit across other `generacy` verbs — scoped to cockpit.

---

*Generated by speckit*
