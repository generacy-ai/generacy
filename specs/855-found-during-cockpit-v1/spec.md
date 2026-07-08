# Feature Specification: Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #20 — first hard failure of a defect that has silently degraded every checks-dependent surface since rev 2

**Branch**: `855-found-during-cockpit-v1` | **Date**: 2026-07-08 | **Status**: Draft

## Summary

Found during the cockpit v1 integration smoke test (generacy-ai/tetrad-development#88), finding #20 — first hard failure of a defect that has silently degraded every checks-dependent surface since rev 2.

Observed: `generacy cockpit merge 2` (after #853's workaround) exits 1 with `gh pr checks failed (exit 1): Unknown JSON field: "conclusion"`. Root cause: `packages/cockpit/src/gh/wrapper.ts:605` requests `--json name,state,conclusion,detailsUrl` from `gh pr checks` — and TWO of those fields have never existed on that command (`gh pr checks --json` exposes: bucket, completedAt, description, event, link, name, startedAt, state, workflow — verified on gh 2.96.0). `conclusion` is REST/`gh run` vocabulary; the URL field is `link`, not `detailsUrl`. gh validates the field list CLIENT-SIDE before any network call, so this method fails on every gh version, every invocation.

Blast radius: merge's checks branch (hard failure, blocks every merge); `context`'s implementation-review bundle and review-context-json (checks section); and the status/watch checks rollups — which explains a week-old observation: every `cockpit status` render during this smoke test showed blank checks columns (`- / none`) on every PR. That wasn't absent data; the fetch has never succeeded and the consumers degrade silently. (The silent-degradation half deserves a warn log where the wrapper error is swallowed.)

Why tests never caught it: the wrapper is exercised via mocked CommandRunner fixtures that answer with the shape the code EXPECTS — the same tests-encode-the-assumption pattern as #800/#826/#836/#853, but this time the drifted interface is gh's, not ours.

Fix: (1) wrapper field list → `name,state,bucket,link`; update the Zod schema and map the rollup from `bucket` (pass/fail/pending/skipping/cancel — it is purpose-built for exactly this rollup); thread the rename through context.ts/review-context-json consumers. (2) Add a CI-tier test that runs the REAL pinned gh binary with each `--json` field list the codebase uses against a dummy ref and asserts no "Unknown JSON field" error — gh's client-side validation makes this cheap, deterministic, and network/auth-free, and it closes the entire "gh interface drift invisible to mocked tests" class for every wrapper method at once. (3) Grep the wrapper for other --json field lists and validate them in the same pass.

Repro: `gh pr checks 999 --repo <any> --json conclusion` → "Unknown JSON field" instantly, no auth needed.


## User Stories

### US1: Merge command succeeds against a healthy PR

**As a** cockpit operator running `generacy cockpit merge <ref>`,
**I want** the checks-gathering step to complete successfully instead of failing with `Unknown JSON field: "conclusion"`,
**So that** merges of PRs with green checks actually go through and I stop hitting the workaround path introduced in #853.

**Acceptance Criteria**:
- [ ] `generacy cockpit merge <ref>` against a PR with green checks does not error with `Unknown JSON field` on any supported `gh` version.
- [ ] `gh pr checks --json name,state,bucket,link` is the only field list issued for check-run enumeration; no call requests `conclusion` or `detailsUrl`.
- [ ] The check-run rollup (pass / fail / pending / skipping / cancel) is derived from `gh`'s `bucket` field internally, without exposing `bucket` on the outward `CheckRunSummary` interface.

### US2: Checks columns render real data in status/watch/context

**As a** cockpit operator running `generacy cockpit status` (or `watch`, or `context`) on any project,
**I want** the checks column to reflect the PR's actual check state instead of silently rendering `- / none`,
**So that** the surface I rely on for review-readiness stops lying by omission.

**Acceptance Criteria**:
- [ ] For a PR with at least one non-skipped check, `cockpit status` renders a non-empty checks summary (not `- / none`).
- [ ] `cockpit watch` renders the same populated checks summary as `status` for the same PR.
- [ ] `cockpit context` (implementation-review bundle) and `review-context-json` emit the check-run list with `state` populated, sourced from the fixed wrapper.

### US3: Silent wrapper failures become observable

**As a** cockpit operator or on-call engineer,
**I want** a `warn`-level log to fire whenever `getPullRequestCheckRuns` fails,
**So that** the next "checks column mysteriously blank" incident surfaces in seconds instead of a week.

**Acceptance Criteria**:
- [ ] When `gh pr checks` fails, `getPullRequestCheckRuns` emits a `warn` log with structured fields `{ repo, prNumber, ghStderr }` before rethrowing.
- [ ] Consumers (`status`, `watch`, `context`) retain their existing degrade-catches so the visible symptom (blank checks) is unchanged, but the log line is present in every failure.
- [ ] `merge`'s hard-fail behaviour on wrapper error is preserved (rethrow, not swallow).

### US4: gh interface drift can no longer land silently

**As a** contributor modifying any `--json` field list in `packages/cockpit/src/gh/wrapper.ts`,
**I want** CI to fail fast if any requested field name is not accepted by the pinned `gh` binary,
**So that** the "tests mock the shape the code expects" failure mode that hid this bug for weeks cannot repeat for any wrapper method.

**Acceptance Criteria**:
- [ ] A vitest suite at `packages/cockpit/src/gh/__tests__/json-field-drift.test.ts` iterates every `--json` field list statically extracted from `wrapper.ts` and invokes the real pinned `gh` binary against a dummy ref, asserting no `Unknown JSON field` error.
- [ ] The suite uses `describe.runIf(hasGhBinary)` so it skips visibly on developer machines without `gh` and runs in CI where `gh` is present.
- [ ] Field lists are extracted by literal-string grep of `'--json',` followed by a literal string arg; the test fails hard if any `--json` follow-up in `wrapper.ts` is not a string literal.

## Functional Requirements

| ID  | Requirement | Priority | Notes |
|-----|-------------|----------|-------|
| FR-001 | `getPullRequestCheckRuns` in `packages/cockpit/src/gh/wrapper.ts` MUST invoke `gh pr checks` with `--json name,state,bucket,link` (no `conclusion`, no `detailsUrl`). | P1 | Root fix. |
| FR-002 | The Zod schema backing `parseCheckRuns` MUST validate `{ name, state, bucket, link }` and MUST NOT require or emit `conclusion`. | P1 | Cleared by Q1→B: raw passthrough dropped entirely. |
| FR-003 | The check-run rollup consumed by `merge`, `status`, `watch`, and `context` MUST be derived from `bucket` internally within the wrapper; `bucket` MUST NOT appear on the outward `CheckRunSummary` interface. | P1 | Cleared by Q1→B: `state` is the outward semantic; `bucket` is a wrapper-internal implementation detail. |
| FR-004 | Consumers (`context.ts`, `required-checks.ts`, `review-context-json.ts`) MUST source the check-run URL from a wrapper mapping over gh's raw `link` field. `CheckRunSummary`'s outward field name stays `url`. | P1 | Cleared by Q5→A: no consumer rename; wrapper does the `link`→`url` mapping. |
| FR-005 | `getPullRequestCheckRuns` MUST emit a `warn`-level log with structured fields `{ repo, prNumber, ghStderr }` via an injected logger on any failure, then rethrow. Consumer catch-blocks stay untouched. | P1 | Cleared by Q2→A: wrapper-level single site; rethrow preserves `merge`'s hard-fail. |
| FR-006 | A vitest suite at `packages/cockpit/src/gh/__tests__/json-field-drift.test.ts` MUST invoke the real pinned `gh` binary against every extracted `--json` field list and assert no `Unknown JSON field` error. The suite MUST use `describe.runIf(hasGhBinary)` to skip gracefully when `gh` is absent locally, and MUST run in CI where the workflow guarantees `gh` is present. | P1 | Cleared by Q3→A: colocated vitest, `runIf` gate. |
| FR-007 | The drift suite MUST extract `--json` field lists statically from `wrapper.ts` via a literal-string grep of the pattern `'--json',` immediately followed by a string-literal arg. The suite MUST fail hard if any `--json` follow-up in `wrapper.ts` is not a string literal. | P1 | Cleared by Q4→A: grep with enforcement; forbids dynamic field lists. |
| FR-008 | Every existing `--json` field list in `packages/cockpit/src/gh/wrapper.ts` MUST be audited in the same pass and validated by the drift suite; no other method may request a field name the pinned `gh` does not accept. | P1 | The "grep the wrapper and fix any siblings" cleanup listed in the summary. |

## Success Criteria

| ID  | Metric | Target | Measurement |
|-----|--------|--------|-------------|
| SC-001 | `generacy cockpit merge <ref>` against a green PR completes without an `Unknown JSON field` error. | 0 occurrences on `gh` 2.96.x and newer. | Manual repro of the failure path from the summary against a PR with green checks; also covered by an integration path in the CI drift suite. |
| SC-002 | Checks column population in `cockpit status` / `watch` / `context`. | 100% of PRs with ≥1 non-skipped check render a non-empty checks summary (no `- / none`). | Smoke-test rerun of the scenario that originally produced the week-old blank-column observation. |
| SC-003 | Silent-swallow visibility. | Every `getPullRequestCheckRuns` failure emits exactly one `warn` log with `{ repo, prNumber, ghStderr }`. | Grep of orchestrator logs after intentionally breaking a `--json` field list against a scratch branch. |
| SC-004 | gh interface drift coverage. | The drift suite covers 100% of `--json` field lists in `wrapper.ts` and fails within one CI run on any drift-inducing change. | New wrapper method with a bogus `--json` field is added on a scratch branch; CI drift suite fails with a clear `Unknown JSON field` assertion pointing at the exact field list. |
| SC-005 | Field list literalness. | 100% of `'--json',` follow-ups in `wrapper.ts` are string literals. | The drift suite's extractor asserts this; a non-literal insertion fails the suite. |

## Assumptions

- The pinned `gh` version used in CI accepts the field set `{ bucket, completedAt, description, event, link, name, startedAt, state, workflow }` on `gh pr checks --json`, as verified on 2.96.0.
- gh's client-side `--json` validation fires before any network/auth interaction, making the drift suite network-free and cheap to run per CI job.
- No caller currently consumes `CheckRunSummary.conclusion` for anything other than opaque passthrough emission in `review-context-json.ts`, so dropping it is source-compatible for every real consumer.
- `describe.runIf` is available in the vitest version pinned by `packages/cockpit`.

## Out of Scope

- Any change to `gh run` vocabulary or `Checks` REST-API consumers (this bug is scoped to `gh pr checks`).
- Refactoring the consumer-side degrade behaviour beyond adding the wrapper-level log (i.e., `status` / `watch` / `context` continue to render `- / none` on failure).
- Renaming `CheckRunSummary.url` to `link` or otherwise changing the outward vocabulary of the summary interface beyond removing `conclusion`.
- Introducing an AST-based extractor (e.g., `ts-morph`) for `--json` field lists; the grep-plus-literal-enforcement approach is deliberate.
- Structural changes to `parseCheckRuns` beyond the schema-field swap and `bucket`→rollup mapping.

---

*Generated by speckit*
