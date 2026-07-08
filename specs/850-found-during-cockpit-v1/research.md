# Research: `cockpit advance` bare-number acceptance & error copy refresh

**Issue**: [generacy-ai/generacy#850](https://github.com/generacy-ai/generacy/issues/850)
**Branch**: `850-found-during-cockpit-v1`
**Date**: 2026-07-08
**Phase**: 0 — decision log & rejected alternatives

---

## D1 — Where does the bare-number gate live?

**Decision**: Move the `BARE_NUMBER` (`/^\d+$/`) gate out of `parseIssueRef` and into `resolveIssueContext` as the *first* branch, before delegating to `parseIssueRef`. `parseIssueRef` becomes a strict qualified-forms-only parser (owner/repo#N and URL).

**Source**: [clarifications.md](./clarifications.md) Q2 → **C**.

**Rationale**:
- Q2 identified the real problem: `resolveIssueContext` currently detects the bare-number case by string-matching the *thrown message* (`/bare issue number/.test(message)` at `resolver.ts:153`). This is control-flow-by-exception-message — an anti-pattern in TypeScript, and doubly bad because FR-002 requires rewriting that exact string.
- Option A (keep the sentinel substring) would ship two coupled strings that must be updated in lock-step forever.
- Option B (typed error class) fixes the coupling but keeps the "parse must throw to signal a case the caller then handles" indirection.
- Option C deletes the pattern outright: `resolveIssueContext` knows what a bare number looks like (`/^\d+$/` — the same regex `parseIssueRef` uses), so it gates *first*, runs cwd-origin inference on match, and only calls `parseIssueRef` for qualified forms.

**Consequences**:
- `parseIssueRef('123')` no longer throws `bare issue number "123" is not accepted`; it throws the qualified-forms `unrecognized issue ref "123". Use <n>, …` message. Test line 6 in `resolver.test.ts` is *deleted* (already covered by the `rejects garbage` case).
- `resolveIssueContext`'s bare-number path no longer needs to re-parse `<repo>#<n>`; it holds the `owner`, `repo`, and `number` values already and calls `makeRef` directly.
- The FR-002 copy is thrown from `resolveIssueContext`'s origin-inference failure branch, wrapping (not replacing) the inner git-command reason inside a trailing parenthesized clause.

**Rejected — Option A (keep sentinel substring)**: Two strings kept in sync forever. Fails Q2's stated intent ("rather than typing it or repinning it").

**Rejected — Option B (typed `BareNumberRefError` class)**: Better than A but still leaves the parse-throws-and-caller-catches indirection. When the parser can gate first, throwing to signal a valid case that *isn't an error* is architecturally wrong. Q2's answer explicitly rules this out.

---

## D2 — How is the FR-006 invariant enforced?

**Decision**: ESLint `no-restricted-imports` rule under `.eslintrc.json` `overrides`, scoped to `packages/generacy/src/cli/commands/cockpit/**` with `resolver.ts` and `__tests__/**` excluded. Rule message names `resolveIssueContext` as the correct import.

**Source**: [clarifications.md](./clarifications.md) Q1 → **C**.

**Rationale**:
- Q1's framing was explicit: "the mechanism purpose-built for 'this import is reserved'". ESLint fires *at the moment of the mistake*, in-editor, before CI. A test-based scanner (Option A) checks the same thing one stage later with hand-rolled file walking. A per-verb runtime matrix (Option B) is the high-maintenance option for a regression class fundamentally about imports, not behavior.
- The repo already uses `no-restricted-imports` at the root level (`.eslintrc.json:20-32`) for the `child_process` ban, with per-file `overrides` for allowed exceptions (lines 33-72). Adding one more `overrides` entry for the cockpit dir extends the existing pattern rather than introducing a new lint mechanism.
- `paths[].importNames` is supported since ESLint 7.6.0 — the project's `eslint:recommended` + `@typescript-eslint/parser` stack supports it. If a version-specific gotcha shows up, the `patterns` form with a `group` glob is a drop-in fallback (documented in `contracts/eslint-rule.md`).

**Rejected — Option A (source-code scanner vitest)**: Roughly equivalent coverage, but the feedback loop is `pnpm test` instead of IDE red-squiggles. And a scanner test is a hand-rolled file walker — brittle to `import type` distinction, quote-style variance, and multi-line imports.

**Rejected — Option B (per-verb runtime test)**: Highest maintenance. Every new verb requires an added test row. The regression class is "wrong import chosen", which is a compile-/lint-time concern, not a runtime one.

---

## D3 — Grep-audit scope for stale `cockpit.repos` references

**Decision**: SC-003's grep is scoped to the whole of `packages/generacy/src/`. Stale references to removed config are defects wherever they sit. If the grep finds actual code reading `cockpit.repos` (it shouldn't, post-#806), remove it here if trivial; otherwise split into a follow-up issue.

**Source**: [clarifications.md](./clarifications.md) Q3 → **A**.

**Rationale**:
- Q3's framing: "shipping a fix for 'stale copy references removed config' while knowingly leaving sibling instances is this bug half-done."
- Verification at plan time:
  - `grep -r "cockpit.repos" packages/generacy/src/` → **0 hits**. Fully removed in #806.
  - `grep -r "repos are not configured" packages/generacy/src/` → **2 hits**: `resolver.ts:101` (deleted by D1 / Q2→C) and `__tests__/resolver.test.ts:6` (rewritten by FR-007).
- After this PR: both greps return zero. SC-002 and SC-003 met with no separate cleanup pass.
- Historical spec documents under `specs/` mentioning `cockpit.repos` are frozen artifacts and NOT in scope for the grep (spec Assumptions line 74).

**Rejected — Option B (only the exact error copy called out in the spec)**: Would leave sibling instances if any turned up. Grep is cheap; not doing it here creates a follow-up-issue liability for a two-second scan.

**Rejected — Option C (limited to migrated verbs)**: Same problem as B, just with a smaller radius. Fails Q3's intent.

---

## D4 — Refreshed error-message shape

**Decision**: Single inline sentence enumerating the three accepted forms, prefixed with the existing `parse issue: ` convention, with the git-command failure reason preserved inside a trailing parenthesized clause.

Full message:
```
parse issue: bare issue number "N" is not accepted here. Accepted: <owner>/<repo>#N, a full issue URL, or a bare number inside a checkout with a resolvable GitHub origin. (cwd-origin inference failed: <inner reason>)
```

**Source**: [clarifications.md](./clarifications.md) Q4 → **A**.

**Rationale**:
- Q4's framing: "one greppable unit in CI logs, matches the existing error style, enumeration is short enough that multi-line formats buy scannability nothing."
- Cockpit errors are consumed by `Error: cockpit <verb>: <message>` CLI wrappers (`advance.ts:110`, `context.ts:158`, `status.ts:58`, `watch.ts:103`, `queue.ts:236`). Preserving `parse issue: ` as the inner prefix maintains that consistency.
- The parenthesized `(cwd-origin inference failed: …)` clause exists because dropping the inner git-command reason (git remote missing vs. URL not GitHub vs. exit 128) blinds users to the *actual* failure. Q4→A's phrasing "a bare number inside a checkout with a resolvable GitHub origin" tells them what the resolver wanted; the parenthesized clause tells them what it got. Both fit on one line.
- The literal template `<owner>/<repo>#N` in the message text (rather than a substitution) matches the existing style at `resolver.ts:107-108` (`Use <n>, <owner>/<repo>#<n>, …`).

**Rejected — Option B (multi-line bulleted list)**: Noisier in `pnpm test` output and CI logs. The three accepted forms fit comfortably on one line.

**Rejected — Option C (two-part `hint:` idiom)**: Would establish a new error convention the cockpit codebase doesn't have. Out of scope for this bug.

---

## D5 — Preserve `input.repo` programmatic override

**Decision**: Retain `ResolveIssueContextInput.repo` as-is. Bare-number-only. No CLI flag on `advance` or `context`.

**Source**: Derivable from spec + prior epic (#822 Q5 → A, referenced at `resolver.ts:140`).

**Rationale**:
- The `input.repo` override exists for programmatic callers (e.g. tests, or a future non-CLI harness). #822 explicitly ruled out surfacing it as a CLI flag on `context`.
- `advance` inherits the same policy. Bare-number failure with no CLI-accepted remedy is the intentional design — the sole remedy is a resolvable cwd origin.
- Preserving `input.repo` keeps `merge.ts:116` (which passes `opts.repo`) working unchanged.

**Consequences**:
- `merge`'s `--repo <owner/repo>` flag is unaffected. It's an existing flag on that verb, plumbed via `ResolveIssueContextInput.repo`.
- `advance` and `context` intentionally do NOT gain a `--repo` flag as part of this fix.

---

## D6 — Number-validity double-check

**Decision**: Trust the `/^\d+$/` regex. Drop the redundant `Number.parseInt` + `Number.isInteger` check inside `resolveIssueContext`'s bare-number path. `makeRef` still asserts `number > 0`, so `"0"` continues to fail loudly.

**Rationale**:
- Post-D1, the bare-number gate is `/^\d+$/`. That regex guarantees the string is one-or-more digits; `Number.parseInt("<one-or-more-digits>", 10)` is guaranteed to return a positive integer OR zero.
- `makeRef` at `resolver.ts:65` asserts `Number.isInteger(number) && number > 0` — the `> 0` guard catches `"0"` and throws `issue number must be a positive integer, got "0"`.
- The existing `if (!Number.isInteger(number) || number <= 0)` check inside `resolveIssueContext` (lines 158-160) is dead code after D1: the regex already ruled out non-digits, and `makeRef` already asserts positivity. Deleting it removes a redundant layer without changing observable behavior.
- Verified against `resolver.test.ts:58-60` which asserts `parseIssueRef('owner/repo#0')` throws with `/positive integer/`. The same assertion holds through `resolveIssueContext('0')` because it reaches `makeRef`.

**Rejected alternative — keep the double-check "for defense"**: Two-layer defense would be over-designed and would require FR-007 tests to keep asserting a message no user ever sees post-D1.

---

## D7 — ESLint rule syntax fallback

**Decision (primary)**: Use `no-restricted-imports.paths` with `{ name: "./resolver.js", importNames: ["parseIssueRef"] }`.

**Decision (fallback, if the primary fails in CI)**: Switch to `no-restricted-imports.patterns` with `{ group: ["**/resolver.js"], importNames: ["parseIssueRef"] }`. Documented in `contracts/eslint-rule.md`.

**Rationale**:
- `paths[].importNames` is available since ESLint 7.6.0. The project's ESLint version isn't pinned in the top-level config, but `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser` in a modern monorepo typically peer-depend on ESLint 8+ which supports both `paths[].importNames` and `patterns[].importNames`.
- If the CI lint step reports "invalid schema" on `importNames` under `paths`, the `patterns` form is a drop-in replacement with a wider match glob (works for any relative or aliased import path). No behavior difference for our two current call sites (`advance.ts:32`, `context.ts:27`, both using `./resolver.js`).
- Not adopting `patterns` by default because it broadens the match to any file path ending in `resolver.js`, which could clash with a hypothetical future `resolver.js` elsewhere in the same override glob (there is none today).

---

## Sources & references

- [Spec — 850-found-during-cockpit-v1](./spec.md)
- [Clarifications — Batch 1 (Q1–Q4)](./clarifications.md)
- Sibling verbs already on `resolveIssueContext`: `status.ts:54`, `watch.ts:99`, `queue.ts:233`, `merge.ts:116`.
- Root ESLint config: `.eslintrc.json` (existing `no-restricted-imports` block at lines 20-32, per-file `overrides` pattern at lines 33-72).
- Prior cockpit-v1 epics referenced: #822 (`resolveIssueContext` introduction), #806 (`cockpit.repos` config removal), #841 (label-pair invariant), #845 (poll-path resume detection), #847 (companion cockpit-v1 defect batch).
