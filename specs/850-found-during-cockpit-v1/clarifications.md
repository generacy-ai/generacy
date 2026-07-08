# Clarifications: `cockpit advance` bare-number acceptance & error copy refresh

**Issue**: [generacy-ai/generacy#850](https://github.com/generacy-ai/generacy/issues/850)
**Branch**: `850-found-during-cockpit-v1`

---

## Batch 1 — 2026-07-08

### Q1: FR-006 invariant test form

**Context**: FR-006 requires a test that fails if a cockpit verb is wired to `parseIssueRef` without the cwd-origin resolver wrapping it. Three approaches with different maintenance/coverage tradeoffs.

**Question**: How should the FR-006 invariant test be implemented?

**Options**:
- A: **Source-code scanner test** — a vitest that reads every `.ts` under `packages/generacy/src/cli/commands/cockpit/` (excluding `resolver.ts` and `__tests__/`) and asserts none of them import `parseIssueRef`. Fast, no runtime dependencies, catches the exact regression class.
- B: **Per-verb runtime test** — for each cockpit subcommand that takes an issue ref, invoke it with a bare number (with a stubbed git-origin runner) and assert bare-number inference fires. Higher fidelity but higher maintenance (must be updated when new verbs land).
- C: **Type-level / lint guard** — mark `parseIssueRef` as `@internal` and add an ESLint `no-restricted-imports` rule disallowing imports of `parseIssueRef` outside `resolver.ts`. Enforced at lint time, no vitest at all.

**Answer**: *Pending*

---

### Q2: `parseIssueRef` bare-number signaling to `resolveIssueContext`

**Context**: `resolveIssueContext` currently detects the bare-number case by regex-matching the thrown message (`/bare issue number/.test(message)` at `resolver.ts:153`). Updating the error copy per FR-002 while keeping this regex is fragile — the two must be kept in sync forever.

**Question**: How should `parseIssueRef` communicate "bare number, please infer" to `resolveIssueContext`?

**Options**:
- A: **Keep string-based signaling** — update the error copy per FR-002 but preserve the substring `bare issue number` so `resolveIssueContext`'s regex still matches. Minimal diff.
- B: **Typed error class** — introduce `BareNumberRefError extends Error` (or a sentinel field); `resolveIssueContext` uses `instanceof` / property check. Message copy becomes free to change without co-updating a regex.
- C: **Move the bare-number gate out of `parseIssueRef`** — `parseIssueRef` becomes a "known-good forms only" parser. `resolveIssueContext` checks `BARE_NUMBER` itself before calling `parseIssueRef`. Deletes the fall-through-by-catch pattern entirely.

**Answer**: *Pending*

---

### Q3: Help-text / usage-doc audit scope

**Context**: The bug is framed around the runtime error copy, but `cockpit.repos` may also appear in Commander.js `--help` strings, description text, or in-repo README/docs snippets under `packages/generacy/src/`. SC-003 currently just greps for the string.

**Question**: Is auditing `--help`/description text and in-`src/` docs strings for stale `cockpit.repos` references in scope for this fix?

**Options**:
- A: **In scope** — SC-003's grep naturally covers this; treat any `cockpit.repos` mention anywhere under `packages/generacy/src/` as a defect to fix here.
- B: **Out of scope** — only the specific error copy called out in the spec (`resolver.ts:101-102`) is in scope. Any incidental `--help` references get a follow-up issue.
- C: **In scope, but limited to `advance` and the other verbs migrated under FR-005** — i.e. audit help text for verbs we touch, ignore others.

**Answer**: *Pending*

---

### Q4: Refreshed error-message shape

**Context**: FR-002 mandates enumerating the accepted forms but is silent on layout. The current message is a single inline sentence. Multi-line output is more scannable but noisier in CI logs.

**Question**: What shape should the refreshed bare-number rejection message take?

**Options**:
- A: **Single inline sentence** — matches current style. E.g. `bare issue number "2" is not accepted here. Accepted: <owner>/<repo>#N, https://github.com/<owner>/<repo>/issues/N, or a bare number when run inside a checkout with a resolvable GitHub origin.`
- B: **Multi-line bulleted list** — leading sentence + one bullet per form. More readable at a terminal, noisier in log capture.
- C: **Two-part message** — one-line summary line + a `hint:` line that references cwd-origin inference. Matches other cockpit error idioms (verify against existing verbs).

**Answer**: *Pending*
