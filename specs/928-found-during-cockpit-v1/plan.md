# Implementation Plan: cockpit_merge issue-ref contract fix

**Feature**: Fix `cockpit_merge` MCP tool contract — invert PR-in-PR-out → issue-in-PR-out, add typed `wrong-kind` guidance when a PR number is passed, expose `--pr` escape hatch, and add a schema-audit test that pins per-verb ref-kind agreement across MCP and CLI transports.
**Branch**: `928-found-during-cockpit-v1`
**Status**: Complete

## Summary

`cockpit_merge` is unusable for every input:

- Passing an **issue** number → rejected at the schema (`expects: 'pr'` mismatch, `wrong-kind`).
- Passing a **PR** number → passes the schema, but the handler feeds the PR number into `runMerge`'s `issue` parameter. `resolveIssueToPRRef(repo, prNumber)` treats it as an issue and returns `unresolved`. In a repo where an issue *does* exist with the passed PR's number, the resolver would find *that issue's* linked PR and merge it — a latent wrong-merge hazard, masked on snappoll-1 only because no issue #15 existed.

The fix inverts the tool contract to match its CLI verb (`cockpit merge <issue>`), promotes the wrong-kind check into the resolver as a discriminated `pr-number` variant (fixing the CLI's `cockpit merge 15` confusion at the same time, closing #906), exposes the `--pr <number>` escape hatch (#913) as an optional MCP parameter, and adds three regression seams: distinct-number fixture, envelope-mapping parity across success + error branches, and a hardcoded per-verb schema-audit table as an independent third opinion.

## Technical Context

**Language / runtime**: TypeScript (ESM), Node ≥22, `@generacy-ai/generacy` and `@generacy-ai/cockpit` packages.
**Framework**: `commander` (CLI), `@modelcontextprotocol/sdk` (MCP server), `zod` (schemas), `vitest` (tests).
**Direct dependencies** (already in the tree; no new deps):

- `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_merge.ts` — MCP handler (rewrite).
- `packages/generacy/src/cli/commands/cockpit/mcp/schemas.ts` — `CockpitMergeInputSchema` (field rename `pr` → `issue`, add optional `pr: z.number().int().positive()`, `.strict()` rejects unknown keys).
- `packages/generacy/src/cli/commands/cockpit/mcp/ref-input.ts` — `normalizeIssueRef` (no signature change; caller-side `expects: 'issue'`).
- `packages/generacy/src/cli/commands/cockpit/merge.ts` — `runMerge` / `runMergeWithExplicitPr` (add branch that surfaces the new `pr-number` resolver variant as CLI exit-2 with the guidance copy).
- `packages/cockpit/src/gh/wrapper.ts` — `resolveIssueToPRRef` (add `'pr-number'` arm to `PullRequestRefResolution`; tier-1 GraphQL already fetches the type, so this is a shape change, no extra RTT).
- `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-merge.test.ts` — expand to all branches with envelope-mapping helper.
- `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/tool-schema-invalid-refs.test.ts` — extended (or new sibling) to encode the audit table.

**Test infra**: `vitest`, stub GhWrapper pattern (see `parity-advance.test.ts:11`), fixture files in `__tests__/fixtures/` when JSON payloads exceed inline readability.

**No new packages, no runtime deps, no dev deps.**

## Constitution Check

No `.specify/memory/constitution.md` file present in the repo. Applied the project's implicit constitution encoded in `CLAUDE.md` and adjacent specs:

- **Single source of truth for resolver kinds** — `PullRequestRefResolution` is the canonical discriminated union (per #904 Q5). Extending it by one arm (`'pr-number'`) preserves that pattern; the alternative (MCP handler pre-flight `gh` call) would create a second locus of truth for the same classification. Answered per clarifications Q2 → B.
- **Explicit refs at transport boundaries** — MCP requires qualified refs (per #850 direction, applied here per clarifications Q1 → A). Bare strings are rejected at the MCP boundary with the typed-error copy naming accepted forms.
- **Contract inversion is a bug, not a feature** — the docstring at `cockpit_merge.ts:4-6` documents the current inversion knowingly; the fix corrects both code and docstring so the tool's advertised contract matches its wrapped CLI verb (#917 spec direction, #398 finding pattern).
- **Independent third opinions for cross-artifact contracts** — the schema-audit test uses a hardcoded per-verb table (Q3 → B) rather than parsing Commander usage strings; this catches both-sides-drift-together (which is *this* finding's history) that an artifact-vs-artifact parser cannot.
- **Never a resolution bypass of safety** — the `pr` optional parameter mirrors `--pr <number>`'s existing guarantees (linkage verification, all preconditions). It skips the resolver, never the safety gates. Per FR-003 and #913.
- **Existing type discipline preserved** — no `as unknown as X` double-casts; new discriminated arm gets tested exhaustive-check coverage in `runMerge`.

Passes.

## Project Structure

```
packages/generacy/src/cli/commands/cockpit/
├── merge.ts                                # runMerge: new `pr-number` branch → exit-2 + guidance stdout.
├── mcp/
│   ├── schemas.ts                          # CockpitMergeInputSchema: `pr` → `issue` rename; add optional `pr: z.number().int().positive()`; .strict() rejects unknown keys.
│   ├── ref-input.ts                        # unchanged; caller-side `expects: 'issue'`.
│   ├── tools/
│   │   └── cockpit_merge.ts                # REWRITE: expects `issue`, forwards optional `pr` to runMergeWithExplicitPr, translates resolver's `pr-number` arm → wrong-kind ToolErrorResult with hint copy.
│   └── __tests__/
│       ├── parity-merge.test.ts            # EXPAND: distinct issue/PR fixture (issue #2 ↔ PR #15) covers happy path, unresolved, ambiguous, only-drafts, pr-number, and pr-flag success/refusal. All branches use `toMcpResult()` envelope mapper.
│       ├── envelope-mapping.test.ts        # NEW: unit tests the mapper (exit=2 → invalid-args, exit=3 → gate-refusal, exit=1 → transport, exit=0 → ok with data).
│       └── tool-schema-audit.test.ts       # NEW (or extend tool-schema-invalid-refs.test.ts): hardcoded per-verb table asserts MCP tool's declared ref kind matches the wrapped CLI verb's usage string kind; new-verb forces table update.
└── mcp/errors.ts                           # ADD: `toMcpResult(cliJsonStdout, exitCode) → ToolResult` envelope-mapping helper. Mapping table lives here as the transport contract.

packages/cockpit/src/gh/
├── wrapper.ts                              # PullRequestRefResolution: extend union with `{ kind: 'pr-number' }` (no extra fields; the number is the caller's input). Tier-1 GraphQL query extended (or its schema loosened) to surface "this number is a PullRequest" natively — zero extra round-trips.
└── __tests__/
    └── wrapper.tier1-shape-drift.test.ts   # Add case: number-is-a-PR → `{ kind: 'pr-number' }`.
```

**No files created outside these locations. No renames beyond the schema field.**

## Implementation Sequence

Ordered by dependency; each step is independently testable.

### Step 1 — Resolver: add `pr-number` arm

`packages/cockpit/src/gh/wrapper.ts`:

- Extend `PullRequestRefResolution` union: `| { kind: 'pr-number' }` (no fields — the caller supplied the number).
- Extend `Tier1InitialResponseSchema` (and the follow-up GraphQL query if needed) so tier-1 can report "the requested number is a `PullRequest`, not an `Issue`." This is free: GraphQL's `node(id: ...)` distinguishes types natively, and `gh api graphql` on the requested `<number>` can either check `Node.__typename` or catch a "not an Issue" error and check the sibling PullRequest.
- If tier-1 detects the input is a PR, return `{ kind: 'pr-number' }` immediately — do not fall through to tier-2/tier-3 (those tiers cannot classify).
- Invariant I-6 (added to the union docstring): `kind === 'pr-number'` ⇒ no other fields; the offending number is the caller's `issue` argument.

Test coverage: `wrapper.tier1-shape-drift.test.ts` gains a case that stubs the tier-1 response for a PR-numbered node and asserts `{ kind: 'pr-number' }` returns.

### Step 2 — CLI: `runMerge` handles `pr-number`

`packages/generacy/src/cli/commands/cockpit/merge.ts`:

- In `runMerge`, after the `resolution.kind === 'unresolved'` branch, add:
  ```
  if (resolution.kind === 'pr-number') {
    return {
      exitCode: 2, // invalid-args per Q4's envelope table
      stdout: serializeFailingCheckJson(buildFailingCheckPayload({
        reason: 'pr-number',
        pr: null,
        issue: issueRef,
        hint: `#${issue} is a pull request; pass the issue number (e.g. the issue whose closing PR is #${issue}).`,
      })),
    };
  }
  ```
- Exhaustive-check the resolver kinds (TypeScript `never` at the end) so the new arm is caught by the type-checker at every callsite.
- Fixes `cockpit merge 15` on the CLI in the same commit → closes #906.

Test coverage: `merge.test.ts` gains a case that stubs `resolveIssueToPRRef` returning `{ kind: 'pr-number' }` and asserts `exitCode === 2` with the guidance copy in stdout.

### Step 3 — MCP schema: field rename + optional `pr`

`packages/generacy/src/cli/commands/cockpit/mcp/schemas.ts`:

- Rename `CockpitMergeInputSchema`'s field `pr` → `issue` (typed as `IssueRefInputSchema`).
- Add optional `pr: z.number().int().positive()` (mirrors CLI `--pr <number>`).
- Keep `.strict()` — unknown keys rejected.
- Add a `.refine()` or superRefine that translates the old-field-name `pr` shape (a `pr` key whose type is *not* `number`, i.e. an IssueRefInput) into the typed redirection error message: `"the 'pr' field was renamed to 'issue'; pass the issue ref, not the PR number"`. Per Q5 → B.

Note: because `pr: number` is now valid (as the escape hatch), the redirection error must trigger only when the caller sends `pr: <IssueRefInput>` (string or object). Zod's `.strict()` alone would reject *both* uses; the refinement runs before strict and picks the redirection message when `pr` is a non-number.

Alternative if the `.refine`-before-`.strict` layering is awkward: keep `.strict()` and intercept the rejection in `cockpit_merge.ts` — if the parse fails and `input.pr` exists with a non-numeric type, override the detail with the redirection message. Both compile to identical caller-visible behavior; pick whichever reads clearer in review.

### Step 4 — MCP handler: rewrite

`packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_merge.ts`:

- `CockpitMergeInput` shape: `{ issue: IssueRefInput; pr?: number }`.
- Docstring: rewrite to match the corrected contract (issue-in-PR-out; optional `pr` mirrors `--pr <number>`).
- `normalizeIssueRef(parsed.data.issue, { expects: 'issue', ... })`.
- If `parsed.data.pr` present → call `runMergeWithExplicitPr` with `{ issue: normalized.value.ref.number, prNumber: parsed.data.pr }`.
- Else → call `runMerge` with `{ issue: normalized.value.ref.number }` (unchanged from today except for which number goes where).
- **Result envelope**: use the new `toMcpResult(result.stdout, result.exitCode)` helper (Step 5) — do not open-code the `status`/`class` mapping in this handler anymore.
- Wrong-kind handling: the `expects: 'issue'` gate in `normalizeIssueRef` already rejects PR-URL / structured `{ owner, repo, number }` refs whose live classification is a PR — that path already returns `class: 'wrong-kind'`. What is *new* is the **resolver-bubbled** case: caller passes a plain number ref, `normalizeIssueRef` accepts it as issue-shaped (no classification RTT for object form), `runMerge` runs, resolver reports `pr-number` → `toMcpResult` maps exit-2 with `reason: 'pr-number'` → tool-side branch overrides class to `'wrong-kind'` (not `'invalid-args'`) because the offense is a kind mismatch, not an arg-shape error.

### Step 5 — Envelope-mapping helper

`packages/generacy/src/cli/commands/cockpit/mcp/errors.ts`:

- Add `toMcpResult<T>(cliJsonStdout: string, exitCode: number): ToolResult<T>`:
  - Parses `cliJsonStdout` as JSON. Non-JSON → `class: 'internal'`.
  - `exitCode === 0` → `{ status: 'ok', data: parsed }`.
  - `exitCode === 2` → look at `parsed.reason`:
    - `'pr-number'` → `class: 'wrong-kind'` with `parsed.hint` as `hint`.
    - `'unresolved' | 'ambiguous-resolution' | 'pr-is-draft' | 'checks-failing'` → `class: 'gate-refusal'`.
    - Anything else → `class: 'invalid-args'`.
  - `exitCode === 3` → `class: 'gate-refusal'`.
  - `exitCode === 1` → `class: 'transport'`.
  - Other → `class: 'internal'`.
- This mapping table **is the transport contract** (Q4 → B). It is the single artifact tested by parity.

### Step 6 — Parity test (all branches)

`packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-merge.test.ts`:

- Fixture: distinct numbers — issue #2 ↔ PR #15.
- Cases (each asserts `toMcpResult(cliOutput, exitCode)` deep-equals `mcpResult`):
  1. Happy path: `cockpit_merge({ issue: { … #2 } })` → merges PR #15 → `status: 'ok'`, `data.pr.number === 15`.
  2. `pr-number`: `cockpit_merge({ issue: { … #15 } })` → `status: 'error'`, `class: 'wrong-kind'`, hint copy matches.
  3. Unresolved: PR #15 with no linked issue → `class: 'gate-refusal'`, `reason` mentions unresolved.
  4. Ambiguous: two linked open PRs → `class: 'gate-refusal'`.
  5. `pr-is-draft`: only-drafts → `class: 'gate-refusal'`.
  6. `checks-failing`: PR checks red → `class: 'gate-refusal'`, `reason: 'checks-failing'`.
  7. `pr` escape hatch success: `cockpit_merge({ issue: … #2, pr: 15 })` when linkage OK → `status: 'ok'`.
  8. `pr` escape hatch linkage refusal: `pr: 15` when PR #15 does not declare #2 → `class: 'gate-refusal'`, refusal message matches CLI stderr copy.
  9. Old-field-name redirection: `cockpit_merge({ pr: { owner, repo, number: 2 } })` → `class: 'invalid-args'`, detail contains the redirection copy from Q5.
  10. Bare-string on MCP: `cockpit_merge({ issue: '928' })` → `class: 'invalid-args'`, detail names the required qualified forms (Q1).

### Step 7 — Envelope-mapping unit test

`packages/generacy/src/cli/commands/cockpit/mcp/__tests__/envelope-mapping.test.ts`:

- Direct unit tests over `toMcpResult()` — one per exit-code / reason combination. Fast; no gh stub needed.
- Guarantees the mapping table doesn't drift silently when a new `reason` string is introduced in `runMerge`.

### Step 8 — Schema-audit test (per-verb table)

`packages/generacy/src/cli/commands/cockpit/mcp/__tests__/tool-schema-audit.test.ts`:

- Hardcoded per-verb table (Q3 → B):
  ```ts
  const EXPECTED_KIND: Record<string, 'issue' | 'epic'> = {
    cockpit_status: 'epic',
    cockpit_context: 'issue',
    cockpit_advance: 'issue',
    cockpit_resume: 'issue',
    cockpit_queue: 'epic',
    cockpit_merge: 'issue',
    cockpit_await_events: 'epic',
  };
  ```
- For each MCP tool, assert the `normalizeIssueRef({ expects })` value in the handler source matches the table's declared kind (grep the source; hardcoded regex is fine — the value is a string literal on a single line).
- For each CLI verb, assert the usage string in the Commander file matches the table's declared kind (`<issue>` → `issue`, `<epic>` → `epic`, `<issue-ref>` → `issue`, etc.).
- Adding a new verb requires updating the table (forcing function). Deleting the table entry mid-refactor fails loudly.

### Step 9 — Docstring audit sweep

Per FR-004 (audit-the-other-tool docstrings for ref-kind agreement with their wrapped CLI verbs — the S6 drift-audit pattern at the schema layer):

- Skim each `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_*.ts` docstring; correct any that misdescribe the wrapped verb's ref kind. The audit-table test (Step 8) catches the schema/source drift; the docstring sweep catches the human-readable drift.

### Step 10 — Playbook sweep for `pr`-field references

Per Q5 companion note:

- `git grep -n "cockpit_merge" agency/ specs/` (or wherever migrated playbooks live) — find and correct any callers still passing `{ pr: … }` to `cockpit_merge`. The schema self-describes on error, but a playbook example carrying the old field would keep steering agents into the redirection error round.

## Risks and Trade-offs

- **Resolver shape change**: extending `PullRequestRefResolution` by one arm is a non-behavioral change to existing paths but does touch every exhaustive-check callsite. TypeScript's `never` catches misses. The change is small enough (one arm, zero-field variant) to review in one pass.
- **Schema `.strict()` interaction with the redirection message (Step 3)**: two implementations are equivalent; pick the one that reads better in review. Both are testable via the parity fixture.
- **Distinct-number fixture drift**: hardcoding issue #2 / PR #15 in the parity test means renaming the fixture numbers requires an audit. Documented at the top of `parity-merge.test.ts`.
- **Old-field-name redirection is a hard break**: no existing MCP caller succeeds today (the tool is dead), so backward-compat is vacuously safe. But playbooks and docs may reference `pr` — Step 10 mitigates.
- **Latent wrong-merge hazard**: closed with high confidence. `cockpit_merge({ issue: … #15 })` when #15 is a PR → `resolveIssueToPRRef` returns `pr-number` → tool errors before any merge call. `cockpit_merge({ issue: … #15, pr: 15 })` still requires PR #15 to *declare* issue #15 as a closing issue (which it can't for its own number in the current PR-closes-issue direction) — the `--pr` linkage gate catches this.

## Success Criteria (from spec)

- **SC-001**: `cockpit_merge` succeeds on a valid issue ref with a mergeable linked PR.
- **SC-002**: `cockpit_merge` returns `wrong-kind` with actionable hint when the input resolves to a PR.
- **SC-003**: Distinct-number fixture (issue #2 ↔ PR #15) passes end-to-end.
- **SC-004**: All-branch parity between MCP `ToolResult` and CLI stderr JSON via `toMcpResult()`.
- **SC-005**: Schema-audit test fails when *any* MCP tool declares a ref kind that disagrees with its wrapped CLI verb.

## Suggested Next Step

Run `/speckit:tasks` to generate a task list from this plan.

---

*Generated by speckit for #928*
