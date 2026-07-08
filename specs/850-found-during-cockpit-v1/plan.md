# Implementation Plan: `cockpit advance` accepts bare issue numbers and no longer references removed `cockpit.repos` config

**Feature**: Route `cockpit advance` (and any remaining sibling) through `resolveIssueContext`; narrow `parseIssueRef` to a strict qualified-forms-only parser; refresh the bare-number rejection copy; lock the invariant with an ESLint rule.
**Branch**: `850-found-during-cockpit-v1`
**Date**: 2026-07-08
**Spec**: [spec.md](./spec.md)
**Clarifications**: [clarifications.md](./clarifications.md)
**Status**: Complete

## Summary

Three sibling defects, one root cause. `cockpit advance` (`packages/generacy/src/cli/commands/cockpit/advance.ts:108`) calls `parseIssueRef` directly instead of the `resolveIssueContext` wrapper that `status` / `watch` / `queue` / `merge` adopted in #822. That skew produces three user-visible failures on a bare-number invocation like `generacy cockpit advance 2 --gate implementation-review`:

1. **Grammar skew.** Sibling verbs accept `2`; `advance` rejects it. Refs copied out of `cockpit status` output cannot be pasted into `cockpit advance`.
2. **Removed-config reference in the error copy.** The rejection message ("bare issue number `2` is not accepted — repos are not configured") points users at the `cockpit.repos` knob deleted in #806.
3. **`context` sits on the same broken parser.** `context.ts:156` was migrated to the shared `parseIssueRef` in isolation and never routed through `resolveIssueContext`. Same class of regression, one directory over.

**Fix triangle (per Q1–Q4 in [clarifications.md](./clarifications.md)):**

- **Q2→C — Narrow `parseIssueRef`.** Move the `BARE_NUMBER` gate *out* of `parseIssueRef` and *into* `resolveIssueContext`. `parseIssueRef` becomes a strict qualified-forms parser (owner/repo#N and URL only) — bare numbers never enter it. This deletes the `/bare issue number/.test(message)` control-flow-by-exception-message pattern at `resolver.ts:153` (spec assumption line 76). The re-parse `<inferred>#<n>` step is replaced with a direct `makeRef(owner, repo, number)` call, since we already hold the parsed number.
- **Q4→A — Refresh the copy.** The bare-number failure throw moves from `parseIssueRef` to `resolveIssueContext`'s origin-inference failure path. Message becomes a single inline sentence (matches existing cockpit error style, one greppable unit in CI logs): `bare issue number "N" is not accepted here. Accepted: <owner>/<repo>#N, a full issue URL, or a bare number inside a checkout with a resolvable GitHub origin.` No mention of `cockpit.repos` or "repos are not configured".
- **FR-005 — Migrate remaining callers.** `advance.ts:108` and `context.ts:156` both switch to `resolveIssueContext`. The `IssueRef` shape they consume is unchanged (`{ owner, repo, number, nwo }`) — this is a call-site swap, not a signature change.
- **Q1→C + FR-006 — Lock the invariant.** Add an ESLint `no-restricted-imports` override for `packages/generacy/src/cli/commands/cockpit/**` disallowing named import of `parseIssueRef` from `./resolver.js`, allowed only in `resolver.ts` and `__tests__/`. Rule message names `resolveIssueContext` as the correct import. Marks `parseIssueRef` `@internal` in its JSDoc.
- **FR-007 — Test rewrite.** `__tests__/resolver.test.ts` line 6 currently asserts `parseIssueRef('123')` throws `bare issue number "123" is not accepted`. Post-Q2→C, `parseIssueRef('123')` throws with the *garbage-fallback* message (`unrecognized issue ref`). The test moves to `resolveIssueContext`: with no runner, it fails at git-origin lookup; the new bare-number error copy is asserted there. No test may still assert the stale "repos are not configured" string (SC-002).
- **Q3→A / SC-002 / SC-003 — Grep audit.** After the copy rewrite, the two SC-002/SC-003 greps under `packages/generacy/src/` MUST return zero. Current state (verified at plan time): `resolver.ts:101` is the only production hit; `__tests__/resolver.test.ts:6` is the only test hit. Both fall in this change.

**Scope guard.** Zero changes to `resolveIssueContext`'s cwd-origin inference algorithm (spec Out of Scope line 82). Zero changes to `IssueRef` or the ref grammar itself. Zero cockpit-config re-introduction. Zero relay-payload or GitHub-comment surface changes.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js ≥22 (per `packages/generacy` package).
**Primary Dependencies**: `@generacy-ai/cockpit` (`GhCliWrapper`, `CommandRunner`, `GhWrapper`), `commander`, `vitest` for tests, `eslint` + `@typescript-eslint` for the new rule enforcement. Zero new runtime dependencies.
**Storage**: N/A. This is a pure call-site refactor + error-copy rewrite. No config, no schema, no state.
**Testing**: `vitest`. Affected suites:
- `packages/generacy/src/cli/commands/cockpit/__tests__/resolver.test.ts` — rewrite the bare-number path (line 6) to assert the FR-002 copy on `resolveIssueContext`, not `parseIssueRef`. Keep the qualified-forms tests unchanged (lines 12–60).
- `packages/generacy/src/cli/commands/cockpit/__tests__/advance.test.ts` (if present; otherwise extend `advance.test.ts` or the closest existing suite) — add three cases: bare-number happy path (stubbed runner returns `https://github.com/owner/repo.git`), bare-number failure with unresolvable origin (asserts FR-002 copy), and regression that `owner/repo#N` still routes.
- `packages/generacy/src/cli/commands/cockpit/__tests__/context.test.ts` — parallel additions for `context` (bare-number happy path, unresolvable-origin failure with FR-002 copy). Not a new file if one already exists — extend it.
- `.eslintrc.json` — the added override is validated by CI's existing lint step.
**Target Platform**: CLI runtime; ships as part of `@generacy-ai/generacy` (`bin/generacy.js`). Runs on Node ≥22 across macOS / Linux / Windows.
**Project Type**: Single-package modification inside `packages/generacy/src/cli/commands/cockpit/` + one root `.eslintrc.json` edit.
**Performance Goals**: N/A. Ref parsing is O(1) regex; adding a `/^\d+$/` gate in `resolveIssueContext` before delegating to `parseIssueRef` is a single regex test — negligible.
**Constraints**:
- `IssueRef` shape unchanged (`{ owner, repo, number, nwo }`) — spec assumption line 73.
- `resolveIssueContext`'s public signature unchanged (`ResolveIssueContextInput` → `ResolvedIssueContext`).
- `parseIssueRef` remains **exported** (its unit tests import it, and tests are allowed by the ESLint override for `**/__tests__/**` — line 63 in `.eslintrc.json`). Marking `@internal` is a JSDoc annotation, not a symbol change.
- Zero net change to error taxonomy for the qualified-forms paths (owner/repo#N and URL) — they continue to throw with the same `parse issue: <reason>` prefix, and callers continue to wrap with `Error: cockpit <verb>: `.
- No new `--repo` flag on `advance` or `context`. Cwd-origin inference is the sole bare-number remedy (matches sibling verbs and spec Out of Scope).
**Scale/Scope**: 3 source files modified (`resolver.ts`, `advance.ts`, `context.ts`), 1 root config file modified (`.eslintrc.json`), 1 test file rewritten (`resolver.test.ts`), 2 test files extended (`advance.test.ts`, `context.test.ts`) — created if absent for `advance`. ~40 LOC production, ~120 LOC tests. No new files.

## Constitution Check

*GATE: no constitution file at `.specify/memory/constitution.md`. Repository-wide invariants derived from `CLAUDE.md`, clarifications, and adjacent completed cockpit-v1 epics (#822, #841, #845, #847):*

| Gate | Result | Note |
|------|--------|------|
| No premature abstractions / no half-finished implementations | PASS | No new module. The bare-number gate moves ~6 lines from one function to another in the same file. The ESLint rule reuses an existing top-level `no-restricted-imports` block — one added `overrides` entry, no plugin. |
| Match spec Q&A intent, not just the letter | PASS | Q1→C (ESLint rule, not vitest scanner), Q2→C (move gate to `resolveIssueContext`, delete regex signaling), Q3→A (grep whole of `packages/generacy/src/`), Q4→A (single inline sentence, three forms enumerated). All four honored end-to-end. |
| No backwards-compat shims for removed code | PASS | The stale "repos are not configured" copy is *deleted*, not rewritten to preserve a substring. The `/bare issue number/.test(message)` sentinel is *deleted*, not retyped as a class. Test line 6 is *rewritten* to the new location, not kept as a legacy assertion. |
| Tests hit real behavior, not mocks-of-mocks | PASS | `resolver.test.ts` continues to stub only the `CommandRunner` (git-origin lookup) — the same seam it uses today (line 78–86). The new copy is asserted as a substring in the thrown Error, not via mock recording. |
| Structured logging conventions | PASS | No log lines added or changed. Error surface is the CLI stderr `Error: cockpit <verb>: parse issue: …` line already established at `advance.ts:110`, `context.ts:158`, `status.ts:58`, `watch.ts:103`, `queue.ts:236`. |
| Don't add features beyond what the task requires | PASS | No new `--repo` flag on `advance`/`context`. No new gates parsed. No new cockpit verbs. No new config knob to replace `cockpit.repos`. FR-006 is scoped to `packages/generacy/src/cli/commands/cockpit/**` — not the whole repo. |
| Loud failures, no silent guesses | PASS | Unresolvable git origin remains an exit 2 with the enumerated-forms message (FR-004 fail-closed). No fallback to `origin/HEAD` or environment variables. |

Post-Phase-1 re-check: no new violations introduced by the ESLint rule or the test rewrite.

## Project Structure

### Documentation (this feature)

```text
specs/850-found-during-cockpit-v1/
├── spec.md              # (present, unchanged by /plan)
├── clarifications.md    # (present, unchanged by /plan)
├── plan.md              # THIS FILE
├── research.md          # Phase 0 output — Q1/Q2/Q3/Q4 decisions + rejected alternatives
├── data-model.md        # Phase 1 output — narrowed parseIssueRef contract + IssueRef stability
├── quickstart.md        # Phase 1 output — repro (SC-001) + grep verification (SC-002, SC-003)
├── contracts/
│   ├── parse-issue-ref.md      # Strict qualified-forms parser contract (post Q2→C)
│   ├── resolve-issue-context.md # Bare-number gate + FR-002 copy + FR-003/FR-004 semantics
│   └── eslint-rule.md          # FR-006 no-restricted-imports rule shape + scope
└── checklists/          # (present, empty)
```

### Source Code (repository root)

```text
packages/generacy/src/cli/commands/cockpit/
├── resolver.ts                       # MODIFIED — narrow parseIssueRef to qualified forms only (Q2→C);
│                                      #            move BARE_NUMBER gate + FR-002 copy into resolveIssueContext;
│                                      #            delete /bare issue number/.test(message) sentinel;
│                                      #            mark parseIssueRef @internal in JSDoc (FR-006)
├── advance.ts                        # MODIFIED — swap parseIssueRef(issue) → resolveIssueContext({ issue }) (FR-001);
│                                      #            drop the `import { parseIssueRef, ... }` line
├── context.ts                        # MODIFIED — same swap (FR-005 audit resolution — this is the second offender)
└── __tests__/
    ├── resolver.test.ts              # MODIFIED — rewrite bare-number test to assert new copy on resolveIssueContext (FR-007);
    │                                  #            remove any assertion of "repos are not configured" (SC-002)
    ├── advance.test.ts               # MODIFIED (create if absent) — bare-number happy path + FR-004 failure copy
    └── context.test.ts               # MODIFIED (create if absent) — bare-number happy path + FR-004 failure copy

.eslintrc.json                        # MODIFIED — add overrides entry for cockpit/** disallowing parseIssueRef import (FR-006)
```

Out of repo (referenced only, not modified by this PR): none.

**Structure Decision**: Everything sits in one leaf directory (`packages/generacy/src/cli/commands/cockpit/`) plus one root config file. No new module boundary, no shared helper, no cross-package thread. The ESLint rule extends the existing `no-restricted-imports` block at `.eslintrc.json:20-32`, using the same `overrides`-per-file pattern already established at lines 33-72 — it is not a new plugin or a new lint config file. The Q2→C narrowing collapses `resolveIssueContext`'s bare-number path from "try parse → catch bare-number sentinel → fall through" to "regex-gate first → parse only qualified forms → makeRef directly on inference success" — one control flow, no exception-driven branch.

## Design Overview

### Q2→C — Narrow `parseIssueRef`, gate bare numbers in `resolveIssueContext`

**Before** (`resolver.ts:81-110`):
```ts
export function parseIssueRef(input: string): IssueRef {
  const trimmed = input.trim();
  if (trimmed === '') fail('issue argument is required');
  // owner/repo#N branch (unchanged)
  // URL branch (unchanged)
  if (BARE_NUMBER.test(trimmed)) {
    fail(`bare issue number "${trimmed}" is not accepted — repos are not configured, …`);
  }
  fail(`unrecognized issue ref "${input}". Use <n>, <owner>/<repo>#<n>, …`);
}
```

**After** (`resolver.ts`):
```ts
/**
 * @internal — cockpit callers MUST use `resolveIssueContext` instead. This
 * function is exported only for its unit tests. Enforced by ESLint
 * `no-restricted-imports` (see .eslintrc.json).
 *
 * Strict qualified-forms parser. Accepts:
 *   - `owner/repo#123`
 *   - `https://github.com/owner/repo/issues/123`
 *   - `https://github.com/owner/repo/pull/123`
 *
 * Bare numbers ("123") fall through to the `unrecognized issue ref` throw —
 * they are NOT a special case here. The bare-number remedy (cwd-origin
 * inference) lives in `resolveIssueContext`.
 */
export function parseIssueRef(input: string): IssueRef {
  const trimmed = input.trim();
  if (trimmed === '') fail('issue argument is required');
  // owner/repo#N branch (unchanged)
  // URL branch (unchanged)
  // BARE_NUMBER branch DELETED.
  fail(`unrecognized issue ref "${input}". Use <n>, <owner>/<repo>#<n>, or https://github.com/<owner>/<repo>/issues/<n>.`);
}
```

**Before** (`resolver.ts:142-169`):
```ts
export async function resolveIssueContext(input): Promise<ResolvedIssueContext> {
  const runner = input.runner ?? nodeChildProcessRunner;
  try {
    const ref = parseIssueRef(input.issue);
    return { ref, repo: ref.nwo, gh: new GhCliWrapper(runner) };
  } catch (err) {
    if (!/bare issue number/.test((err as Error).message)) throw err;
  }
  // fall-through: bare number → infer repo → re-parse "<repo>#<n>"
  const trimmed = input.issue.trim();
  const number = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(number) || number <= 0) {
    fail(`bare issue number "${trimmed}" is not a positive integer`);
  }
  const repoNwo = input.repo ?? (await inferRepoFromGitOrigin(runner, input.cwd));
  const parts = repoNwo.split('/');
  const ref = makeRef(parts[0]!, parts[1]!, number);
  return { ref, repo: ref.nwo, gh: new GhCliWrapper(runner) };
}
```

**After**:
```ts
export async function resolveIssueContext(input): Promise<ResolvedIssueContext> {
  const runner = input.runner ?? nodeChildProcessRunner;
  const trimmed = input.issue.trim();

  // Bare-number gate: run cwd-origin inference (or use input.repo override).
  if (BARE_NUMBER.test(trimmed)) {
    const number = Number.parseInt(trimmed, 10);
    // number > 0 is guaranteed by /^\d+$/ + makeRef's assertion; no double-check.
    let repoNwo: string;
    try {
      repoNwo = input.repo ?? (await inferRepoFromGitOrigin(runner, input.cwd));
    } catch (err) {
      // Rewrap: FR-002 copy names the accepted forms, not the git-command failure.
      throw new Error(
        `parse issue: bare issue number "${trimmed}" is not accepted here. ` +
        `Accepted: <owner>/<repo>#${trimmed}, a full issue URL, or a bare number inside a ` +
        `checkout with a resolvable GitHub origin. ` +
        `(cwd-origin inference failed: ${(err as Error).message.replace(/^parse issue: /, '')})`
      );
    }
    const parts = repoNwo.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      fail(`inferred repo "${repoNwo}" is not in <owner>/<repo> form`);
    }
    const ref = makeRef(parts[0]!, parts[1]!, number);
    return { ref, repo: ref.nwo, gh: new GhCliWrapper(runner) };
  }

  // Qualified forms only. Any failure here is fatal — no fall-through.
  const ref = parseIssueRef(input.issue);
  return { ref, repo: ref.nwo, gh: new GhCliWrapper(runner) };
}
```

**What's deleted**:
- `parseIssueRef`'s `BARE_NUMBER` branch and its "repos are not configured" throw (6 lines at `resolver.ts:99-104`).
- `resolveIssueContext`'s `try { parseIssueRef } catch { if (!/bare issue number/.test(message)) throw }` sentinel pattern (5 lines at `resolver.ts:147-154`).
- The `Number.parseInt` + `Number.isInteger` re-check inside `resolveIssueContext` (3 lines at `resolver.ts:157-160`) — after Q2→C's regex-first gate the number is guaranteed by `/^\d+$/`, and `makeRef` re-asserts `> 0`. Two-layer defense would be over-designed.

**What stays the same**:
- Ref grammar (`OWNER_REPO_HASH`, `ISSUE_URL`, `BARE_NUMBER` regexes at lines 50-52).
- `IssueRef` shape (`{ owner, repo, number, nwo }`).
- `inferRepoFromGitOrigin` — untouched. Its `parse issue: could not infer owner/repo…` throw is now caught by `resolveIssueContext` and rewrapped into the FR-002 copy.
- `makeRef`'s validation of owner / repo / positive integer.
- The `input.repo` programmatic override — bare-number-only, no CLI flag (spec Q5 → A of #822, honored here).

### FR-002 — Refreshed error copy

The bare-number rejection message (both when origin inference fails and, transitively, when neither `input.repo` nor a resolvable cwd origin is available) is:

```
parse issue: bare issue number "N" is not accepted here. Accepted: <owner>/<repo>#N, a full issue URL, or a bare number inside a checkout with a resolvable GitHub origin. (cwd-origin inference failed: <inner reason>)
```

Notes:
- Single inline sentence (Q4→A). `parse issue: ` prefix preserved (loud-errors convention). CLI callers add `Error: cockpit <verb>: ` on top → users see `Error: cockpit advance: parse issue: bare issue number "2" is not accepted here…`.
- `N` is the actual number typed. `<owner>/<repo>#N` in the message text is a *literal template*, not a substitution — same style as the existing `Use <n>, <owner>/<repo>#<n>, …` throw at the end of `parseIssueRef`.
- The trailing `(cwd-origin inference failed: …)` clause preserves the debugging information from `inferRepoFromGitOrigin`'s throw (git remote missing vs. URL not GitHub vs. exit != 0) — dropping it would make the "why did this fail on my box" case invisible. The clause is inside a single sentence, still one greppable line, so Q4→A is satisfied.
- Zero occurrences of `cockpit.repos` (SC-003) or `repos are not configured` (SC-002) after this change.

### FR-001 / FR-005 — Migrate `advance` and `context`

**`advance.ts:32,106-111`** before:
```ts
import { parseIssueRef, type IssueRef } from './resolver.js';
// ...
let ref: IssueRef;
try {
  ref = parseIssueRef(issue);
} catch (err) {
  throw new CockpitExit(2, `Error: cockpit advance: ${(err as Error).message}`);
}
const gh = deps.gh ?? new GhCliWrapper(deps.runner ?? nodeChildProcessRunner);
```

After:
```ts
import { resolveIssueContext, type IssueRef } from './resolver.js';
// ...
let ref: IssueRef;
let gh: GhWrapper;
try {
  const resolvedCtx = await resolveIssueContext({ issue, runner: deps.runner });
  ref = resolvedCtx.ref;
  gh = deps.gh ?? resolvedCtx.gh;
} catch (err) {
  throw new CockpitExit(2, `Error: cockpit advance: ${(err as Error).message}`);
}
```

**`context.ts:27,154-159`** — identical shape. `IssueRef` continues to be imported as a type-only name; the runtime `parseIssueRef` import is dropped. Downstream code (`gh.fetchIssueLabels(ref.nwo, ref.number)`, etc.) is unchanged — `ref` has the same shape.

Two subtle points:

1. `advance` previously built its own `gh` wrapper on line 113 with `deps.runner ?? nodeChildProcessRunner`. The migrated form gets `resolvedCtx.gh` (also built with `deps.runner ?? nodeChildProcessRunner` inside `resolveIssueContext`). `deps.gh` still wins. Behavior identical.
2. `context` builds `gh` on line 161 the same way. Same swap, same result.

The changes to these two files are a *net line reduction* (drop the local `gh` construction, source it from the ctx bundle), matching how `status`, `watch`, `merge`, and `queue` already read.

### FR-006 — ESLint `no-restricted-imports` rule

**Added `.eslintrc.json` `overrides` entry** (after the existing per-file allow-list at lines 33-61):

```json
{
  "files": ["packages/generacy/src/cli/commands/cockpit/**/*.ts"],
  "excludedFiles": [
    "packages/generacy/src/cli/commands/cockpit/resolver.ts",
    "packages/generacy/src/cli/commands/cockpit/__tests__/**"
  ],
  "rules": {
    "no-restricted-imports": ["error", {
      "paths": [
        { "name": "child_process", "message": "Direct child_process usage is forbidden. Use ProcessFactory or AgentLauncher instead. See #437." },
        { "name": "node:child_process", "message": "Direct child_process usage is forbidden. Use ProcessFactory or AgentLauncher instead. See #437." },
        {
          "name": "./resolver.js",
          "importNames": ["parseIssueRef"],
          "message": "Import `resolveIssueContext` from './resolver.js' instead. `parseIssueRef` is a strict qualified-forms parser — cockpit verbs must go through `resolveIssueContext` so bare-number cwd-origin inference works uniformly. See #850."
        }
      ]
    }]
  }
}
```

Notes on the rule shape:
- `paths[].name === './resolver.js'` targets the exact relative import spec used inside the cockpit directory (`import { … } from './resolver.js';`). All current call-sites use this exact form; no `../resolver.js` or `../../…/resolver.js` occurrences under the target glob (verified at plan time via the Grep in the Summary section).
- `importNames: ["parseIssueRef"]` restricts *only* that named export; `IssueRef`, `resolveIssueContext`, `ResolvedIssueContext`, `ResolveIssueContextInput` remain freely importable.
- The `paths` array re-includes the existing `child_process` / `node:child_process` entries — `no-restricted-imports` overrides *replace* the parent config, not merge, so we must carry those forward for the cockpit dir.
- `excludedFiles` allows `resolver.ts` itself (where `parseIssueRef` is defined) and the `__tests__/` subdirectory (where the unit tests import both). The root `.eslintrc.json` line 68 already turns `no-restricted-imports` off for `**/__tests__/**`, but keeping the explicit `excludedFiles` here documents intent and survives future test-glob changes.
- Rule message names `resolveIssueContext` as the correct import (Q1→C explicit ask).

**JSDoc `@internal` annotation** — added to `parseIssueRef`'s doc comment in `resolver.ts` (Q1→C says "should also be marked `@internal`"). It's documentation, not a type-system change; TypeScript's `--stripInternal` flag is not part of the build so `parseIssueRef` remains callable, but IDEs surfacing `@internal` hints double-reinforce the ESLint error.

### FR-007 — Test rewrite

**Deleted / rewritten** in `__tests__/resolver.test.ts`:

- Line 6 test (`refuses a bare number (repos are not configured)`) is *deleted*. `parseIssueRef('123')` no longer has a bare-number branch — it falls through to the `unrecognized issue ref` throw, which is already covered by the `rejects garbage` case at line 48.
- New test in the `resolveIssueContext` block: `bare number with unresolvable origin fails with the FR-002 copy`. Runner stub returns exit 128. Assert the thrown message matches `/parse issue: bare issue number "123" is not accepted here\./` AND does NOT contain `/repos are not configured/`.
- New test: `bare number succeeds when input.repo is set (FR-003 programmatic override path)`. Already partially covered by lines 94-108 — extend to assert the runner is never called for git-origin lookup on this path.
- Existing test at line 110-119 (`fails loudly when bare number is passed and git origin lookup fails`) is *retained* but its regex assertion tightens from `/could not infer owner\/repo/` to also assert the FR-002 wrapping (`bare issue number "123" is not accepted here`). The inner `could not infer` clause is now the nested reason inside parentheses.

**Added** in `__tests__/advance.test.ts` (create if the file doesn't exist):
- Bare-number happy path: runner stub returns `https://github.com/owner/repo.git`; assert the code path calls `gh.fetchIssueLabels('owner/repo', 2)`.
- Bare-number failure: runner stub exits non-zero; assert `CockpitExit(2, …)` with a message matching the FR-002 copy.
- Regression: `owner/repo#2` still routes with no runner call.

**Added** in `__tests__/context.test.ts` (create if absent): the identical three-case matrix for `context`. Same stub shape, same assertions.

**SC-002 net** — after these edits, `grep -r "repos are not configured" packages/generacy/src/` returns nothing (spec-level acceptance).

### Grep audit (SC-003)

Current state under `packages/generacy/src/` (verified at plan time):
- `cockpit.repos`: zero hits — the config knob was already fully removed in #806.
- `repos are not configured`: two hits — `resolver.ts:101` (deleted by Q2→C) and `resolver.test.ts:6` (rewritten by FR-007).

After this PR: both greps return zero, satisfying SC-002 and SC-003 without a separate cleanup pass.

## Complexity Tracking

*Constitution Check passed; no violations.*

- Zero new files. Zero new modules. Zero new dependencies.
- One new ESLint `overrides` entry (~15 lines JSON).
- One JSDoc annotation (`@internal`).
- Net line change: **negative** in production (deleting the exception-signaling pattern outweighs the added FR-002 wrap), roughly **+80 lines** in tests.

## Risk / Rollback

- **Risk 1 (spec assumption line 76).** `resolveIssueContext`'s bare-number gate now sits *before* `parseIssueRef` runs. Any caller that today constructs a `ResolveIssueContextInput` with `input.issue = "0"` or `input.issue = "01"` hits the new gate. `0` is caught by `makeRef`'s `> 0` check; `01` is `Number.parseInt("01", 10) === 1` and passes. Both cases match today's behavior, verified against `resolver.test.ts:58-60`. Explicit test added for the leading-zero case to lock the equivalence.
- **Risk 2.** The FR-002 copy trails the git-origin inference reason inside parentheses. If the reason contains "repos are not configured" (it does not today — the string only lived in the deleted `parseIssueRef` branch), SC-002 would silently regress. Mitigation: an SC-002 grep is part of the tasks phase acceptance, not just the runtime error text.
- **Risk 3.** ESLint rule syntax variance across `@typescript-eslint` versions could reject `importNames` on `no-restricted-imports.paths`. Mitigation: `importNames` has been supported in core ESLint 7.6+ and the project uses `eslint:recommended` with `@typescript-eslint/parser` — no plugin override needed. If the rule fails to parse in CI, fallback is `patterns` with a `group` glob (documented in `contracts/eslint-rule.md`).
- **Risk 4.** A future cockpit verb author copy-pastes the `advance` migration but drops the `resolveIssueContext` call because their verb reads a `<ref>` from somewhere other than argv (e.g., a config file, a stdin line). The ESLint rule fires on the *import*, not the call site, so it still catches this by refusing the `parseIssueRef` import — the author is forced to think about which resolver they want.
- **Rollback**: revert `resolver.ts`, `advance.ts`, `context.ts`, `.eslintrc.json`, and the three test files. Zero data migration, zero config change, zero relay impact. Existing `owner/repo#N` and URL call flows are byte-identical pre-and-post; only the bare-number path and the ESLint rule are net-new behavior.
