# Feature Specification: Found during the cockpit v1

**Branch**: `928-found-during-cockpit-v1` | **Date**: 2026-07-12 | **Status**: Draft

## Summary

Found during the cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92), finding #61 — snappoll-1 run 10, the first-ever live invocation of the `cockpit_merge` MCP tool.

## Observed

`cockpit_merge` is unusable for **every** input — a catch-22 the auto session proved exhaustively on snappoll-1 (#2 / PR #15, green and approved):

- Pass **issue #2** → rejected at the schema: `wrong-kind` ("cockpit_merge requires a PR number").
- Pass **PR #15** → passes the `expects: 'pr'` normalization, but the handler then calls `runMerge({ issue: 15 })` — feeding the PR number into the CLI's *issue* parameter. `resolveIssueToPRRef` treats 15 as an issue number, finds no such issue with closing PRs, and returns `unresolved`.

No input succeeds; D.5 merge dispatch is dead on the MCP path (runs 8–9 never reached a merge, so this shipped untouched by live traffic until now).

## Root cause (verified in source)

`packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_merge.ts`:
- Lines 4–6, the docstring: *"Unlike other tools, this one accepts a **PR ref** — an issue number passed here is a `wrong-kind` schema-level rejection. (The CLI's `runMerge` today takes an issue number and resolves it to a PR…)"* — the contract inversion is documented in the code, i.e. implemented knowingly against #917's spec, which pinned typed **issue** refs with PR-numbers-as-typed-errors (the #906 guard direction), and against the #398 finding that corrected exactly this `<pr-ref>` vs `<issue>` drift in the playbook layer.
- Line 49: `expects: 'pr'`.
- Lines 56–58: `runMerge({ …, issue: normalized.value.ref.number })` — the accepted PR number passed as the issue argument.

**Latent wrong-merge hazard** (worse than the dead-end): GitHub issues and PRs share one number space. In a repo where an issue exists with the passed PR's number, the pass-through resolves *that issue's* linked PR and merges it — an authorized-looking merge of the wrong PR. Only snappoll-1's issue numbering (no issue #15 yet) made this fail loud instead of merge wrong.

**Why tests passed**: the parity/schema fixtures encode the inverted contract and/or use coincident issue/PR numbers where the two readings are indistinguishable — the tests-encode-the-code's-assumptions pattern. A fixture with distinct numbers (issue #2 ↔ PR #15) fails on the very first call.

## Fix

1. `cockpit_merge` accepts an **issue ref** — full parity with the CLI verb (`cockpit merge <issue>`), one contract across both transports. `expects: 'issue'`; the ref passes through to `runMerge` unchanged.
2. A number that resolves to a PR → **typed error with guidance** ("#15 is a pull request; pass the issue number, e.g. #2") — #906's behavior at the tool layer, exactly as #917 specified.
3. Expose the #913 escape hatch as an optional `pr` parameter mirroring `--pr <number>`, with the same linkage verification and preconditions (never a resolution bypass of safety).
4. Correct the docstring; audit the other mcp/tools/* docstrings + schemas for ref-kind agreement with their wrapped CLI verbs (the S6 drift-audit pattern, now at the schema layer).

## Regression tests

- Fixture with **distinct** issue/PR numbers (issue #2 ↔ PR #15): `cockpit_merge(issue ref)` merges PR #15; `cockpit_merge(15)` → typed error naming the issue-ref requirement; never resolves through issue #15.
- Parity: `cockpit_merge` result deep-equals `cockpit merge <issue> --json` for the same fixture.
- Optional `pr` param honors #913's linkage verification (mismatch → refusal).
- Schema audit test: every mcp tool's declared ref kind matches its wrapped CLI verb's usage string.

## Clarifications

Batch 1 — 2026-07-12 (see `clarifications.md` for full context and rationales).

- **Q1 — Bare-string `IssueRefInput` on MCP transport → A (schema-level rejection).** MCP requires qualified refs (`<owner>/<repo>#<n>`, URL, or structured `{ owner, repo, number }`). Bare strings are refused at the MCP boundary with a typed error naming the accepted forms. Rationale: cwd-based inference at the MCP layer would depend on the accident of the entrypoint's spawn cwd (non-deterministic contract, per #850); the calling agent always knows the epic's owner/repo, so explicit qualification costs nothing.
- **Q2 — Wrong-kind detection locus for FR-004 → B (bubbled from `resolveIssueToPRRef`).** The resolver returns a discriminated variant (`'pr-number'` added alongside `resolved|ambiguous|only-drafts|unresolved`) and the MCP handler maps it to the typed `wrong-kind` error. **This amends the Assumption that `runMerge` / `resolveIssueToPRRef` needs no behavioral changes**: the resolver gains one new discriminated arm (a shape change, not a behavior change to existing paths). Post-#913 the tier-1 GraphQL query already distinguishes `Issue` from `PullRequest` natively, so this is free. This also fixes `cockpit merge 15` on the CLI with the same "#15 is a pull request; pass the issue number" guidance — the fix should close #906 in the process.
- **Q3 — Schema audit source-of-truth for FR-007 → B (hardcoded per-verb table in the test).** The audit test carries its own independent table (`{ advance: 'issue', merge: 'issue', queue: 'epic', ... }`) as a third opinion — catches MCP-vs-table drift, CLI-vs-table drift, and the both-sides-drift-together case (which is exactly this finding's history). Maintaining the table when adding a verb is the forcing function.
- **Q4 — FR-009 / SC-004 parity assertion → B (all branches, with envelope-mapping helper).** A canonical `toMcpResult(cliJsonOutput, exitCode)` helper maps CLI stderr JSON + exit code to the MCP `ToolResult` envelope. The helper's mapping table (`exit=2 → class:'invalid-args'`, `exit=3 → class:'gate-refusal'`, …) *is* the transport contract, tested by parity assertions across both success and error branches. Success-only parity (A) would have missed the very divergence this finding is about.
- **Q5 — Backward-compat for `pr` → `issue` rename → B (hard break with targeted redirection error).** Schema rejects `pr` with a typed error whose copy says `"the 'pr' field was renamed to 'issue'; pass the issue ref, not the PR number"`. Optimized for the actual callers (LLM agents): one-shot self-healing rather than a Zod unknown-key diagnosis round. Aliasing `pr` (C) is disqualified — it would re-encode the very inversion this spec exists to end. **Companion cleanup**: grep migrated playbooks (agency, post-#406) for `pr`-field references to `cockpit_merge` and correct them at the same time.

## User Stories

### US1: [Primary User Story]

**As a** [user type],
**I want** [capability],
**So that** [benefit].

**Acceptance Criteria**:
- [ ] [Criterion 1]
- [ ] [Criterion 2]

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | [Description] | P1 | |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | [Metric] | [Target] | [How to measure] |

## Assumptions

- [Assumption 1]

## Out of Scope

- [Exclusion 1]

---

*Generated by speckit*
