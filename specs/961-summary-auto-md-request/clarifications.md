# Clarifications

> **Note (2026-07-16):** Issue #961 was closed by @christrudelpw at 2026-07-16T17:37:31Z as
> **moved** to `generacy-ai/agency#429`. The closing comment also corrects the spec's Leg 2
> diagnosis: as written in the contract, Leg 2 is GraphQL-to-GraphQL (`viewer.login` compared
> against `reviewThreads…author.login`, both `generacy-ai`), so the strict `==` already matches
> and Leg 2 is **not** a real defect. Leg 1 is the sole must-fix. The questions below reflect
> both the routine ambiguities in the spec and the two elephants introduced by the closure: what
> to do with this spec branch, and how much of Leg 2 to keep.

## Batch 1 — 2026-07-16

### Q1: Spec disposition after issue closure
**Context**: Issue #961 is closed as moved to agency#429. This spec branch (`961-summary-auto-md-request`)
is the artifact for a closed issue. Proceeding through plan → tasks → implement will produce a
PR in generacy for work that lives in agency. The orchestrator won't notice the closure on its own.
**Question**: What is the intended disposition of this spec branch?
**Options**:
- A: Abandon — delete the branch and stop the workflow.
- B: Stub-and-stop — keep the spec as a pointer to agency#429, mark all subsequent phases as no-ops,
  and drop a "moved" marker in `spec.md`.
- C: Continue full workflow — treat the spec as valid, produce plan/tasks/implement artifacts,
  even though the implementation code lives in agency (implement phase would be a doc-only PR).

**Answer**: *Pending*

### Q2: Leg 2 provisions given closing-comment correction
**Context**: Your closing comment states Leg 2 as written is GraphQL-to-GraphQL and the strict `==`
already matches — so Leg 2 is not a real defect and Leg 1 is the sole must-fix. The current spec
treats Leg 2 as a first-class bug (FR-002 primary rule change, FR-003 fallback, US2 acceptance
criteria, SC-004 identity-suffix match metric).
**Question**: How should Leg 2 be scoped?
**Options**:
- A: Remove entirely — drop FR-002/FR-003/US2/SC-004 and any Leg 2 prose. Spec becomes Leg-1-only,
  matching agency#429's scope.
- B: Keep as defense-in-depth only — rewrite Leg 2 provisions as "no primary rule change; add
  suffix-insensitive tolerance as a shape-drift guard." Keep the regression test for the
  two-string fixture.
- C: Keep as-is — the spec's Leg 2 diagnosis is correct despite the closing comment; do not
  narrow the scope.

**Answer**: *Pending*

### Q3: Regression test framework and location (FR-007 / SC-004)
**Context**: FR-007 requires "a regression test asserts the postcondition passes for a known-good
POST and fails only when the review genuinely did not land. Test lives in `/workspaces/agency`."
No framework is named. Agency already has vitest fixtures; a fixture-replay bash script would also
be viable and matches the contract's shell-oriented style.
**Question**: What framework and fixture format should the regression test use?
**Options**:
- A: Vitest with JSON fixtures for the POST response, the `pulls/{n}/comments` payload, and the
  GraphQL `reviewThreads` payload. Runs in agency's existing `pnpm test` gate.
- B: Bash-driven fixture replay: canned JSON files fed through the contract's grep/jq pipeline,
  with `set -e` assertions. Aligns with the contract's shell style; runs standalone.
- C: Some other framework already conventional in agency (please name it).

**Answer**: *Pending*

### Q4: SC-005 drift-guard enforcement scope
**Context**: SC-005 says the "D.2 prose in `auto.md` restates no leg-shape detail that could drift
from `contracts/postcondition-check.md`" and adds "enforceable by an `rg` check in future audits."
"Future audits" is not scoped — could mean a landed CI gate, a checked-in script the human runs,
or a comment-only aspiration.
**Question**: What enforcement should land in this PR?
**Options**:
- A: CI gate — a workflow job that runs `rg 'response\.comments|stripBotSuffix|pull_request_review_id'`
  scoped to `auto.md` and fails the PR on any match beyond a reference-by-path.
- B: Checked-in script (e.g., `scripts/check-postcondition-drift.sh`) with docs, not gated in CI.
- C: Aspirational only — no automation in this PR; SC-005 is human-review guidance.

**Answer**: *Pending*

### Q5: Leg 2 fallback trigger granularity (FR-003)
**Context**: FR-003 defines the suffix-insensitive login match as a fallback "when
`pull_request_review_id` is null on the first-comment node." Ambiguous whether the fallback is
per-thread or per-response: does one null-carrying thread flip the whole postcondition to
login-matching, or does each thread pick its own key?
**Question**: When some threads carry `pull_request_review_id` and others do not (defensive case
per Assumption 3), how should the fallback fire?
**Options**:
- A: Per-thread — each review thread is matched by `pull_request_review_id` if present, else by
  `stripBotSuffix(login)`. Mixed responses are matched thread-by-thread.
- B: All-or-nothing — if any thread's first-comment node is missing `pull_request_review_id`, the
  entire postcondition falls back to login matching for every thread in the page.
- C: N/A — the fallback path is defensive-only per FR-003 and Assumption 3; if it ever fires,
  emit a warning and fall back all-or-nothing (option B).

**Answer**: *Pending*
