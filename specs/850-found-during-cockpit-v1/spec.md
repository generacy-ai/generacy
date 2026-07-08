# Feature Specification: `cockpit advance` accepts bare issue numbers and no longer references removed `cockpit.repos` config

**Branch**: `850-found-during-cockpit-v1` | **Date**: 2026-07-08 | **Status**: Draft
**Source**: [generacy-ai/generacy#850](https://github.com/generacy-ai/generacy/issues/850) (found via cockpit v1 smoke test, generacy-ai/tetrad-development#88 finding #18)

## Summary

`generacy cockpit advance <ref> --gate <gate>` violates the unified issue-ref grammar established by #807 Q5. It rejects bare issue numbers (e.g. `advance 2 --gate implementation-review`) even though sibling verbs (`context`, `status`, `watch`, `queue`) accept them and infer the repo from the cwd git origin. The rejection message also references the removed `cockpit.repos` configuration ("repos are not configured"), pointing users at a remedy that no longer exists after the rev 2 config deletion.

The root cause is that `advance` calls `parseIssueRef` directly (`packages/generacy/src/cli/commands/cockpit/advance.ts:108`) rather than the shared `resolveIssueContext` (`packages/generacy/src/cli/commands/cockpit/resolver.ts:142`) that other verbs adopted in #822. The error copy lives at `resolver.ts:101-102`.

This spec covers (a) routing `advance` through `resolveIssueContext`, (b) refreshing the bare-number error copy to enumerate only the accepted forms without naming removed config, and (c) auditing every remaining cockpit verb for the same regression so we do not ship the fix and leave another verb wrong.

## User Stories

### US1: Advance a bare-numbered issue from the cwd of its repo

**As a** developer running `generacy cockpit` from inside a repo checkout,
**I want** `cockpit advance <bare-number> --gate <gate>` to work exactly like `cockpit status <bare-number>`,
**So that** I can copy the ref from a suggestion or another verb's output and pass it to `advance` without hand-editing it into `owner/repo#N`.

**Acceptance Criteria**:
- [ ] `generacy cockpit advance 2 --gate implementation-review` run from inside `generacy-ai/generacy` clones resolves to `generacy-ai/generacy#2` and reaches the same code path a full ref would.
- [ ] `generacy cockpit advance generacy-ai/generacy#2 --gate implementation-review` continues to work unchanged.
- [ ] `generacy cockpit advance https://github.com/generacy-ai/generacy/issues/2 --gate implementation-review` continues to work unchanged.
- [ ] Running `cockpit advance 2 …` from a directory whose git origin cannot be resolved to `owner/repo` fails with a message that names only the accepted forms and does not mention `cockpit.repos` or any deleted config.

### US2: The error message points at a real remedy

**As a** developer whose ref fails to parse,
**I want** the error to list the ref forms the CLI actually accepts,
**So that** I can fix my input without chasing a config knob that no longer exists.

**Acceptance Criteria**:
- [ ] The bare-number failure message enumerates the accepted forms (`<owner>/<repo>#N`, full GitHub issue URL, or a bare number when cwd is inside a repo with a resolvable GitHub origin).
- [ ] The message contains no reference to `cockpit.repos`, "repos are not configured", or any other removed configuration.

### US3: No other verb is silently on the old parser

**As a** cockpit user,
**I want** every verb that takes an issue ref to accept the same grammar,
**So that** copy/pasting a ref from one verb to another never fails because of parser skew.

**Acceptance Criteria**:
- [ ] Every cockpit subcommand that takes an issue-ref argument routes through `resolveIssueContext` (or a shared helper with equivalent cwd-origin inference), not through `parseIssueRef` in isolation.
- [ ] A test enforces this invariant so a future new verb cannot regress by wiring `parseIssueRef` directly.

## Functional Requirements

| ID    | Requirement | Priority | Notes |
|-------|-------------|----------|-------|
| FR-001 | `cockpit advance` MUST resolve its issue-ref argument via `resolveIssueContext` (not `parseIssueRef` alone), matching `status`/`watch`/`queue`. | P1 | Callsite: `packages/generacy/src/cli/commands/cockpit/advance.ts:108`. |
| FR-002 | The bare-number rejection message in `resolver.ts` MUST NOT reference `cockpit.repos` or "repos are not configured". It MUST enumerate the accepted forms (`<owner>/<repo>#N`, full URL, bare number when cwd origin resolves) as a single inline sentence. | P1 | Current copy: `packages/generacy/src/cli/commands/cockpit/resolver.ts:101-102`. Per Q2=C: after the refactor the message is thrown by `resolveIssueContext`'s origin-inference failure path, not by `parseIssueRef`. Per Q4=A: single inline sentence, form: `bare issue number "N" is not accepted here. Accepted: <owner>/<repo>#N, a full issue URL, or a bare number inside a checkout with a resolvable GitHub origin.` |
| FR-003 | `cockpit advance <bare-number>` MUST succeed when run from inside a checkout whose git origin resolves to a GitHub `owner/repo`. | P1 | Cwd-origin inference already implemented for other verbs via `resolveIssueContext`. |
| FR-004 | `cockpit advance <bare-number>` MUST fail with the refreshed message (FR-002) when cwd origin cannot be resolved. | P1 | Fail-closed: no silent guess. |
| FR-005 | Every remaining cockpit subcommand that takes an issue-ref argument MUST also route through `resolveIssueContext`. | P1 | Audit `context.ts:156` (currently calls `parseIssueRef` directly) and any other callsite; migrate as needed. |
| FR-006 | The unified-grammar invariant MUST be enforced by an ESLint `no-restricted-imports` rule that disallows importing `parseIssueRef` outside `resolver.ts` (and its own tests). Rule message MUST name `resolveIssueContext` as the correct import. | P2 | Per Q1=C: enforced at lint time (CI already runs lint); fires in-editor at the moment of the mistake. `parseIssueRef` should also be marked `@internal`. Rule scope: `packages/generacy/src/cli/commands/cockpit/**` (allowed only in `resolver.ts` and `__tests__/`). |
| FR-007 | Existing `parseIssueRef` unit tests (`__tests__/resolver.test.ts`) MUST be updated so that the bare-number path reflects the Q2=C refactor: `parseIssueRef` no longer throws on a bare number (it's a strict qualified-forms-only parser), and the "cannot resolve cwd origin" failure — now thrown by `resolveIssueContext` — asserts the new FR-002 copy. No test may still assert the stale "repos are not configured" string. | P1 | Prevents FR-002 regressing under a green test suite. |

## Success Criteria

| ID     | Metric | Target | Measurement |
|--------|--------|--------|-------------|
| SC-001 | `generacy cockpit advance 2 --gate implementation-review`, run from inside a resolvable checkout, succeeds. | Exit 0 (or exits with a downstream gate-related non-zero code — never with a ref-parse error). | Manual + integration test. |
| SC-002 | Substring `repos are not configured` in `packages/generacy/src/`. | 0 occurrences. | `grep -r "repos are not configured" packages/generacy/src/` returns nothing. |
| SC-003 | Substring `cockpit.repos` in `packages/generacy/src/`. | 0 occurrences (excluding historical spec docs under `specs/`). | grep. Per Q3=A: whole of `packages/generacy/src/` is in scope — including `--help` / description text and in-`src/` docs strings, not just the error copy. Any live code reading `cockpit.repos` is dead code (should be zero post-#806); remove if trivial, split off if not. |
| SC-004 | Cockpit verbs calling `parseIssueRef` without a `resolveIssueContext` wrapper. | 0 verbs. | Codebase audit + FR-006 ESLint rule. |
| SC-005 | Every accepted-form assertion in `resolver.test.ts` (bare number, owner/repo#N, full URL) passes after the migration. | All green. | `pnpm test` in the affected package. |

## Assumptions

- `resolveIssueContext` already implements the cwd-origin inference and error taxonomy needed here; no new helper is required (it landed in #822 and is used by `status`/`watch`/`queue`). Per Q2=C, `resolveIssueContext` will grow the `/^\d+$/` bare-number gate that currently lives inside `parseIssueRef`; the plan phase owns the exact split.
- The `advance` command's downstream logic only needs the parsed `IssueRef` and the same wrapper metadata (`repo`, `gh`) that other verbs consume — swapping the resolver is a call-site change, not a signature overhaul.
- Historical spec documents under `specs/` that mention `cockpit.repos` are frozen artifacts and NOT in scope for the SC-003 grep (grep is scoped to `packages/generacy/src/`).
- `context.ts:156` currently calling `parseIssueRef` directly is either a genuine second offender (to be migrated under FR-005) or a case where the calling flow already provides cwd-origin inference upstream — planning phase will confirm which.
- Per Q2=C: `parseIssueRef` will be narrowed to a strict qualified-forms-only parser (owner/repo#N and URL). It no longer throws a "bare issue number" error, and the string-based signaling regex at `resolver.ts:153` (`/bare issue number/.test(message)`) is deleted. This removes the control-flow-by-exception-message pattern rather than repinning or typing it.

## Out of Scope

- Any change to the ref grammar itself (owner/repo#N and URL syntax stay as-is).
- Restoring or replacing the removed `cockpit.repos` configuration.
- Changes to `resolveIssueContext`'s inference algorithm (this feature only migrates callers).
- Cockpit verbs that do not take an issue-ref argument.
- Cross-repo ref resolution beyond what `resolveIssueContext` already supports.

---

*Generated by speckit — reviewed and enhanced 2026-07-08*
