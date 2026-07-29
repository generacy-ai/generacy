# Feature Specification: Re-justify `cockpit_gate_list`'s `runId` drop after generacy-cloud#894

**Branch**: `1080-problem-cockpit-gate-list` | **Date**: 2026-07-29 | **Status**: Draft
**Issue**: [#1080](https://github.com/generacy-ai/generacy/issues/1080) | **Type**: `type:bug` (documentation-only fix — behavior preserved)

## Summary

`cockpit_gate_list` deliberately drops `runId` before calling the cloud. Three comment/docblock sites in this repo (all landed in commit `82077f1a`, issue #1067) currently justify that drop by naming a cloud-side Zod refine — `.refine((q) => q.runId === undefined || q.generation !== undefined, { message: 'runId requires generation' })` — that generacy-cloud#894 deletes and replaces with a real list-mode `where('runId', '==', X)` filter.

Once generacy-cloud#894 deploys to staging, the three sites will assert a contract that no longer exists. The **drop itself remains correct** — but for a *policy* reason (a run-filtered list forecloses agency#471's startup-sweep gate-adoption primitive), not the vanished-refine reason. Forwarding `runId` post-#894 would no longer 400; it would silently narrow the result set, which is a **worse** failure mode than the 400 for the two consumers that exist (agency#471 startup-sweep, agency#469 pre-flight probe).

Scope of this spec: rewrite the three generacy comment/docblock sites + fix the one test that pins the drop by asserting the 400 rationale (assert the drop itself instead). Zero behavior change. The parallel fix to `agency/packages/claude-plugin-cockpit/commands/auto.md:86` (fourth stale site) is a separate repo and out of scope here.

## User Stories

### US1: Future maintainer reads accurate justification for the `runId` drop

**As a** developer maintaining `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts`,
**I want** the comment that explains why `runId` is dropped before forwarding to the cloud to state the actual current reason (a run-filtered list forecloses agency#471's startup-sweep gate-adoption primitive),
**So that** I do not read a false contract claim (cloud "would 400 on `runId` without `generation`") after generacy-cloud#894 deploys, and so that I understand the drop is a *policy* decision requiring a named consumer to revisit — not a workaround for a cloud validation refine.

**Acceptance Criteria**:
- [ ] Comment at `cockpit_gate_list.ts:50-60` names agency#471's adoption path as the reason for dropping `runId`, not the deleted cloud refine.
- [ ] Comment mentions that the cloud accepts `?runId=` on list mode as of generacy-cloud#894 (so the reader knows this is not a limitation being worked around, but a policy being enforced).
- [ ] Comment states that adding an explicit opt-in for run-scoped list is the correct extension path if a future consumer needs it, not removing the drop.

### US2: Docblock on the input schema reflects policy, not vanished refine

**As a** developer reading the `runId` field's docblock on `CockpitGateListInputSchema` at `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.ts:65-75`,
**I want** the docblock to describe the drop as an intentional handler-side policy and not as protection against a cloud 400,
**So that** the schema documentation stays in sync with the actual justification.

**Acceptance Criteria**:
- [ ] `CockpitGateListInputSchema.runId` docblock no longer references the cloud's `runId requires generation` refine.
- [ ] Docblock briefly names the same agency#471-adoption rationale (or cross-links to the handler-site comment as the source of truth).

### US3: Test pins the *behavior* (drop happens), not the *rationale* (why it would break)

**As a** developer running the test suite after generacy-cloud#894 deploys,
**I want** the test that guards the `runId` drop to assert `client.listGates` is invoked without `runId` in its arguments,
**So that** the test continues to catch regressions of the drop itself and does not go stale (or worse, silently pass by asserting a 400 the cloud no longer returns).

**Acceptance Criteria**:
- [ ] Any test that currently asserts a 400 RFC-7807 response as the mechanism enforcing the drop is rewritten to assert `client.listGates` was called *without* `runId` on its query argument (spy/mock the cloud client at the seam, not the wire).
- [ ] Test description/name references the policy (run-agnostic list is required by agency#471 adoption), not the deleted refine.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Rewrite the comment at `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_gate_list.ts:50-60` to state that the drop is a run-agnostic-by-policy decision, that generacy-cloud#894 accepts `?runId=` as a real filter (so this is not a validation workaround), and that agency#471's startup-sweep adoption path is the named consumer requiring visibility of gates from any run. | P1 | Verbatim replacement text is provided in the issue Ask #1. |
| FR-002 | Shrink the docblock on `CockpitGateListInputSchema.runId` at `packages/generacy/src/cli/commands/cockpit/mcp/gates/query-schemas.ts:65-75` to one line that (a) names the load-bearing *fact* (parity with `cockpit_gate_status`; handler drops before the cloud call) and (b) cross-links to `tools/cockpit_gate_list.ts` as the sole source of truth for the *why*. Do not restate the agency#471 rationale here — the handler comment is the anchor. | P1 | Clarification Q2=B: two independent full-prose sites are the drift surface that caused this issue. The one-liner must state the fact, not merely point elsewhere. |
| FR-003 | Keep the existing wire-level guard at `packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-gate-list.test.ts:234-247` (URL never contains `runId=` or `run_id=`) AND add a **new** client-seam test that mocks `createGateQueryClient` and asserts `client.listGates` is invoked with an argument object that has no `runId` property. Rename the existing wire test's description away from any client-seam framing (e.g. `'outbound list URL never carries runId (wire-level guard)'`). Remove any test wording that references a cloud 400 as the enforcement mechanism. | P1 | Clarification Q1=A: the two guards catch different regressions — the URL check covers both the handler strip and `buildListUrl`, the client check pins the handler-level claim that the URL check cannot see when `buildListUrl` silently ignores an unexpected field. |
| FR-004 | Preserve the `runId` drop behavior in `cockpit_gate_list.ts` byte-for-byte. This spec is documentation-and-test-only; no behavioral change ships in this PR. | P1 | Regression risk: if the drop is accidentally removed, agency#471 loses its adoption primitive silently post-#894 deploy. |
| FR-005 | The `agency/packages/claude-plugin-cockpit/commands/auto.md:86` fix — the fourth stale site named in the issue — is tracked separately (different repo). This spec does not touch agency. | P2 | The issue itself flags this as a sibling / separate-repo change. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | No comment or docblock in `packages/generacy/src/` asserts that the cloud rejects `runId` on list mode. | 0 matches | `grep -rniE "runId requires generation\|would 400\|would produce a 400\|RFC-7807" packages/generacy/src/cli/commands/cockpit/` returns zero after the fix. |
| SC-002 | The rewritten comment at `cockpit_gate_list.ts:50-60` names the load-bearing identifier tokens `agency#471` and `generacy-cloud#894` explicitly. | 1+ occurrence each | grep for the literal tokens `agency#471` and `generacy-cloud#894` in the file returns ≥1 each. **Do not grep for prose shapes** (e.g. sentence fragments, "startup-sweep") — a criterion that greps for a phrase fails the first time someone improves the wording, which trains people to weaken the check. Clarification Q5 discipline: grep for the things that must be true, not the way they are phrased. |
| SC-003 | Two guards exist for the `runId` drop: (a) the existing wire-level test at `parity-gate-list.test.ts:234-247` asserting the outbound URL never carries `runId=` or `run_id=`, and (b) a new client-seam test that mocks `createGateQueryClient` and asserts `client.listGates` is called with an argument object lacking any `runId` property. | 2 tests | Both tests present and green against unchanged handler code. Existing test's description renamed to name the wire-level seam it actually checks (no client-seam claim, no 400 rationale). |
| SC-004 | The `runId` drop in `cockpit_gate_list.ts` still executes on every list-mode call. | 100% | Test suite passes; static inspection confirms the drop is still in the handler. Delta of the handler's ts file is comment-only. |
| SC-005 | The PR is documentation-and-test-only. | 0 behavior changes | `git diff` shows only comment / docblock / test file changes under `packages/generacy/`. No production code path modifications. |

## Assumptions

1. **The three site references are exhaustive for this repo.** The issue lists three sites (`cockpit_gate_list.ts:50-60`, `query-schemas.ts:65-75`, "Any test that pins the drop by asserting the 400 rationale"). No other file in `packages/generacy/src/` documents or tests the drop with the vanished-refine framing. **/plan** should verify with a repo-wide grep for `runId requires generation`, `RFC-7807`, and `would 400`. The scope-update issue comment confirms both prose sites are still present on `develop` (`grep -c "runId requires generation"` → 1 each).
2. **The drop happens at exactly one location.** `cockpit_gate_list.ts:50-60` is the sole handler-side site where `runId` is stripped before forwarding to the cloud. **/plan** should verify with a search for `runId` in `packages/generacy/src/cli/commands/cockpit/mcp/tools/` and adjacent client-wrapper code. Note: `buildListUrl` in `mcp/gates/query-client.ts:112-116` is a **second structural drop site** (it never sets `runId` on the list path in the first place) — no comment change needed there, but it is why the wire-level guard has independent coverage value (see FR-003).
3. **The test seam is `client.listGates`.** The issue names `client.listGates` as the mock/spy point for the client-seam test. **/plan** should confirm the actual interface name and import path (the factory is `createGateQueryClient`).
4. **generacy-cloud#894 is merged and its filter is live.** ~~Blocked on generacy-cloud#894 merging and deploying to staging.~~ Per the scope-update comment on issue #1080: generacy-cloud#894 merged as `39650fba` and its two composite indexes (#896, `06f6a263`) reached `READY` before the merge. The blocker has cleared. The three sites in this repo are stale *now*, not stale *when deployed*.
5. **The agency-side fix (`auto.md:86`) is already done.** ~~It's a separate-repo change tracked independently.~~ Per the scope-update comment: agency#471 merged (`509ce461`) and the `auto.md:86` line already reads the corrected wording; `grep -c "would 400" packages/claude-plugin-cockpit/commands/auto.md` → 0. **Do not open a cross-repo PR** — there is nothing left to change in agency. FR-005 stands as a no-op; the sibling scope collapsed to zero.
6. **agency#471 is the named consumer, not a hypothetical.** Its startup-sweep adoption pass AND the same-generation branch in each of the six Step-0 dispatch blocks both call `cockpit_gate_list` expecting to see gates from **prior** runs. A run-filtered list returns `{gates: []}` at startup by construction, which would make adoption a silent no-op and reopen the duplicate-inbox regression #471 exists to close. This makes the "drop preserves adoption primitive" claim in FR-001's comment load-bearing today, not speculative.
7. **The FR-003 test is the anti-drift mechanism, not comment discipline.** Comments drift; the two guards (wire + client-seam) hold the invariant regardless. Q2's docblock discipline minimises how much prose *can* drift; Q1's tests prevent the behaviour itself from drifting. Both matter, and the tests are the load-bearing half.
8. **No new label vocabulary in `workflow-engine` is added.** Per CLAUDE.md's changeset rules, this makes the changeset a `patch` (documentation and test changes; no public API surface change). If it turns out `FR-003` requires new public test utilities, the bump may need to be `minor` — verified at implement time.

## Out of Scope

- Any behavioral change to `cockpit_gate_list` (the drop is preserved verbatim; only prose and test wording change).
- The agency-side fix to `packages/claude-plugin-cockpit/commands/auto.md:86` — different repo, tracked separately per Ask #2 in the issue.
- Any change to `cockpit_gate_open`, `cockpit_gate_ack`, or other cockpit-gate MCP tools.
- Adding an explicit opt-in path for run-scoped list (Ask #3 in the issue explicitly defers this until a named consumer exists — the spec captures the *design intent* that this is the correct extension path, but ships nothing here).
- Any change to `query-schemas.ts`'s Zod validation logic — only the field's docblock text changes.
- Any change to the cloud client's `listGates` interface signature.
- Any change to `agency#471`'s startup-sweep implementation (it doesn't exist yet in agency — this spec preserves the primitive it will depend on).

---

*Generated by speckit; enhanced from issue #1080*
