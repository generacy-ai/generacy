# Feature Specification: `cockpit_merge` MCP tool ref-contract fix

**Branch**: `928-found-during-cockpit-v1` | **Date**: 2026-07-12 | **Status**: Draft
**Issue**: [#928](https://github.com/generacy-ai/generacy/issues/928)

## Summary

The `cockpit_merge` MCP tool ships with an inverted ref contract: it declares `expects: 'pr'` and rejects issue numbers as `wrong-kind`, but then forwards the accepted PR number into `runMerge`'s `issue` parameter — which routes it through `resolveIssueToPRRef` as if it were an issue number. Result: **no input succeeds**. Passing an issue is a schema-level rejection; passing a PR is silently mis-typed and resolves against the wrong side of the number space. On repos where an issue with that number exists, this becomes an authorized-looking **wrong-PR merge** hazard, not just a dead-end.

Found during the cockpit v1.5 auto-mode integration smoke test (generacy-ai/tetrad-development#92), finding #61 — snappoll-1 run 10, the first-ever live invocation of `cockpit_merge`. Distinct issue/PR numbering (issue #2 ↔ PR #15) exposed the bug that the existing parity/schema fixtures had masked.

## Observed behavior

Verified in `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_merge.ts`:

- Docstring (lines 3–7) documents the inversion knowingly — a PR-in/PR-out contract, framed as diverging from the CLI's issue-in shape.
- Line 49: `expects: 'pr'` in the `normalizeIssueRef` call — issue numbers are rejected at the boundary with `wrong-kind`.
- Lines 56–58: `runMerge({ …, issue: normalized.value.ref.number })` — the PR number is passed as the CLI's *issue* argument. `runMerge` calls `resolveIssueToPRRef`, which reads the number as an issue and looks for closing PRs. In snappoll-1 no issue #15 exists, so the call returns `unresolved` (dead end). In a repo where issue #15 does exist, the call resolves to *that issue's* linked PR and merges it — the wrong-merge hazard.

Divergences from prior specs:
- **#917** pinned typed issue refs across cockpit MCP tools, with PR-numbers as typed-error responses.
- **#906** established the "PR passed where issue expected → typed error, not silent resolution" pattern at the CLI guard layer.
- **#398** corrected the same `<pr-ref>` vs `<issue>` drift in the playbook layer.

`cockpit_merge` diverges from all three.

## User Stories

### US1: Auto-mode agent merges an approved PR through the MCP tool

**As** an auto-mode cockpit agent driving an epic through D.5 (merge dispatch),
**I want** `cockpit_merge` to accept the epic's issue reference and merge its linked PR,
**So that** the merge dispatch step succeeds under the same one-contract-per-verb model as `cockpit_status`, `cockpit_watch`, `cockpit_queue`, and the CLI verb `cockpit merge <issue>`.

**Acceptance Criteria**:
- [ ] `cockpit_merge({ issue: <owner>/<repo>#<n> })` accepts an issue ref and, on approval + green checks, merges the issue's linked PR.
- [ ] The tool's result deep-equals the JSON output of `cockpit merge <ref> --json` for the same input (transport parity).
- [ ] Passing a bare number that resolves to a PR (not an issue) returns a **typed error** (`wrong-kind` or equivalent) naming the required kind and giving the corrective form, e.g. `"#15 is a pull request; pass the issue number, e.g. #2, or use the --pr escape hatch."`
- [ ] Passing an issue number that has no linked PR returns the same `unresolved` typed error as the CLI verb.

### US2: Human operator uses the #913 `--pr` escape hatch through MCP

**As** a human operator invoking cockpit through an MCP client,
**I want** an optional `pr` parameter on `cockpit_merge` mirroring the CLI's `--pr <number>` flag,
**So that** I can bypass issue→PR resolution when the linkage is broken, without losing the linkage-verification safety check.

**Acceptance Criteria**:
- [ ] `cockpit_merge({ issue: …, pr: <n> })` performs the same linkage verification `--pr` performs at the CLI (mismatch → typed refusal).
- [ ] Passing `pr` never bypasses gate refusals, approval checks, or checks-state guards — it only overrides the resolution step.

### US3: Schema audit prevents future ref-kind drift

**As** a cockpit MCP maintainer,
**I want** an automated schema audit test that fails when any MCP tool's declared ref kind disagrees with its wrapped CLI verb's usage,
**So that** the `cockpit_merge`-style drift cannot be reintroduced (or silently added to a new tool) without a red test.

**Acceptance Criteria**:
- [ ] Test enumerates every `mcp/tools/*` handler, cross-references its `normalizeIssueRef({ expects })` value against the wrapped CLI verb's ref kind from its Commander usage string, and asserts equality.
- [ ] Test fails loudly (with a per-tool table row) when any pair disagrees.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | `cockpit_merge` input schema renames `pr` → `issue`, typed as `IssueRefInput`. | P1 | Matches sibling tools (`cockpit_status`, `cockpit_watch`, `cockpit_queue`, `cockpit_advance`). |
| FR-002 | `normalizeIssueRef` call site uses `expects: 'issue'`. | P1 | Removes the schema-level rejection of issue refs. |
| FR-003 | The normalized issue ref is passed to `runMerge` unchanged as `issue: normalized.value.ref.number`. | P1 | Restores parity with the CLI verb's argument shape. |
| FR-004 | Numbers that resolve to a pull request (not an issue) produce a typed `wrong-kind` error naming the required kind and offering a corrective form. | P1 | Matches #906 / #917 behavior at the tool layer. |
| FR-005 | Optional `pr?: number` parameter added, mirroring the CLI's `--pr <number>` escape hatch and preserving its linkage verification. | P2 | #913 parity. Never a resolution bypass of gate/approval/checks safety. |
| FR-006 | Docstring at the top of `cockpit_merge.ts` corrected to reflect issue-in/PR-out. | P1 | Blocks re-drift by removing the "documented intent" alibi. |
| FR-007 | Schema audit test asserts every `mcp/tools/*` handler's `expects:` value matches its wrapped CLI verb's ref kind. | P1 | S6 drift-audit pattern, at the schema layer. |
| FR-008 | Regression fixture uses **distinct** issue/PR numbers (issue #2 ↔ PR #15) so that a resurgence of the pass-through would fail loudly rather than resolve through a coincident number. | P1 | Directly closes the test-fixture blind spot that let this ship. |
| FR-009 | Parity test asserts `cockpit_merge` result deep-equals `cockpit merge <issue> --json` for the same input. | P1 | One contract across both transports. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `cockpit_merge` succeeds for a valid issue-ref input on a repo with distinct issue/PR numbering. | 100% (fixture-driven) | Regression test with fixture (issue #2 ↔ PR #15) is green. |
| SC-002 | `cockpit_merge` invocations that would previously have been silent wrong-merges (passing a PR number that coincides with an existing issue number) now return a typed error and perform no merge. | 100% | Regression test asserts no `gh pr merge` call is dispatched and a `wrong-kind` error is returned. |
| SC-003 | Every `mcp/tools/*` handler's `expects:` value matches its wrapped CLI verb's ref kind. | 0 mismatches | Schema audit test iterates the tool registry. |
| SC-004 | `cockpit_merge` result JSON matches `cockpit merge <issue> --json` output for the same input. | Deep-equal | Parity test in the MCP suite. |

## Assumptions

- The CLI verb `cockpit merge <issue>` remains the canonical contract; the MCP tool is a wrapper, not a divergent surface. (Aligned with #917.)
- `runMerge` and its `resolveIssueToPRRef` codepath do not need behavioral changes — the bug is entirely at the MCP handler's contract boundary.
- Existing tests that pass under the inverted contract encode the code's assumptions rather than the intended contract; those fixtures will be rewritten alongside the fix (see FR-008).
- The `--pr` escape hatch (#913) already carries its own linkage verification at the CLI layer, so exposing it through the MCP tool is a plumbing change, not new safety design.

## Out of Scope

- Behavioral changes to `runMerge`, `resolveIssueToPRRef`, or any CLI-layer merge logic.
- Broader MCP tool contract redesign beyond ref-kind alignment.
- New gate refusal categories or check-state semantics — the fix is contractual, not policy.
- Cloud-side changes; this is a `packages/generacy` fix only.

## References

- Prior specs the current implementation diverges from: #917 (typed refs across cockpit MCP tools), #906 (PR-passed-where-issue-expected → typed error at CLI guard), #913 (`--pr` escape hatch), #398 (`<pr-ref>` vs `<issue>` drift correction in the playbook layer).
- Discovery context: generacy-ai/tetrad-development#92 finding #61 (snappoll-1 run 10, PR #15 / issue #2).

---

*Generated by speckit*
