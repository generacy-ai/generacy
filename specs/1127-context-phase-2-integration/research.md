# Research: implement→review→ready flow end-to-end (Phase-2 integration)

Issue: generacy-ai/generacy#1127 · Part of epic generacy-ai/generacy#1120

## Decision 1 — Rebase-on-develop; consume the real executors, don't re-implement (Q1=A)

**Decision**: #1124/#1125/#1126 merge to `develop` first; this branch rebases on them and ships only integration tests + the two contract artifacts. The implement phase dependency-blocks (skip→requeue-after-deps) until all three merge.

**Rationale**: Mirrors #1123 Q1=B. Co-landing unmerged executor work (option B) would put real review/posting/convergence logic in this integration diff, defeating the "prove they're wired, don't re-plumb" purpose and creating a merge-order hazard. Rebasing keeps the diff a pure acceptance gate.

**Consequence**: The exact production API each test binds to (review executor entrypoint, findings-sidecar shape, posting method name, draft-conversion method name) is **not knowable pre-rebase**. The plan pins the *behavior* and the *seams*; signatures are resolved at implement time against the merged code.

**Alternatives considered**: B (co-land) — rejected as it splits ownership and re-implements. Test-only doubles standing in for the real executors — rejected by Q1=A except the P3 `remediate` stub.

## Decision 2 — Verdict steering shim (clean vs blocking) without forking the executor

**Decision**: Drive the clean-vs-blocking review outcome by controlling the review executor's **input**, not by re-implementing verdict logic. The review phase is an agent phase over the PR diff whose structured output is a findings-artifact sidecar (pause-context pattern). The harness seeds/controls that sidecar (or the executor's CLI output via the `cliSpawner` mock) so the executor emits a clean verdict in US1 and a blocking verdict on the first pass of US2.

**Rationale**: FR-008 forbids introducing real review/remediation behavior. Steering input keeps the *real* executor in the loop (Q1=A) while making the verdict deterministic. The findings sidecar is the same artifact P3 remediate consumes, so steering through it exercises the real contract surface.

**Open at implement time**: whether #1124 exposes the verdict lever as (a) a seedable sidecar file the executor reads, or (b) CLI output the executor parses. Both are mockable through the existing `PhaseLoopDeps`/`GitHubClient`/`cliSpawner` seams; pick the one #1124 actually ships. No new production seam is added by #1127.

## Decision 3 — `remediate` stays a test-only stub via the existing seam (Q3=A)

**Decision**: The changes-required branch injects a test-only `remediate` stub through `PhaseLoopDeps.remediateTrigger` + the `i--; continue;` backtrack (the #1123 seam, pinned in `specs/1123-context-phase-1-integration/contracts/remediate-review-seam.md`). No shipped placeholder executor.

**Rationale**: The real remediate executor is P3/#1128; a shipped placeholder would leak dead production code the epic bans (FR-008). The seam already exists and is contract-pinned, so #1127 reuses it verbatim.

**Interaction with #1126**: In P2 the blocking verdict is expected to drive the off-sequence entry via #1126's convergence wiring. The test binds `remediateTrigger` to that verdict where #1126 exposes it, or uses a fire-once shim standing in for the real trigger if #1126 delivers convergence through a different internal path. Either way the *stub executor* is test-only and the *backtrack invariant* is what's asserted.

## Decision 4 — Marker-match helper: assert #1125's, ship minimal only as fallback (Q4=B, D-3)

**Decision**: FR-005 asserts a standalone deterministic marker-match helper. Preferred source is the helper co-located with #1125's engine-authored marker (marker-family precedent: `clarification-markers.ts` exports both the marker constant and a `match…Marker(body)` helper). If #1125 ships only the constant, #1127 adds a minimal `matchEngineAuthoredReviewMarker(body)` in the marker module — **never** in `PrFeedbackMonitorService`.

**Rationale**: Q4=B assigns the exclusion *predicate wired into routing* to #1130. #1127 must not touch `PrFeedbackMonitorService` (which today has only a `isTrustedCommentAuthor` trust filter — `pr-feedback-monitor-service.ts:267-286`, no engine-authored predicate). A standalone marker-match helper is the seam #1130 consumes; asserting it proves the marker contract without pre-empting #1130's routing change.

**Alternative considered**: Q4 option A — add a predicate *exposed for `PrFeedbackMonitorService`* now. Rejected: touches #1130's production monitor code and splits ownership. Developer flagged A as a reasonable alternative; B chosen.

## Decision 5 — Contract artifact is a pin/cross-reference note (Q2=B)

**Decision**: Ship `contracts/engine-review-integration.md` that **pins/cross-references** the engine-authored marker contract and the findings-artifact shape, naming #1124 (findings artifact) and #1125 (marker + posting) as the authorship home. Author no new contract.

**Rationale**: Q2=B — the executors are the authorship home for their own co-located contracts (mirrors #1123, which shipped only tests + a note against #1121's real types). #1127's durable acceptance artifact is the pin note + the tests, not a competing contract doc.

## Test-convention notes (grounding)

- Integration tests use the `*.integration.test.ts` suffix and live in `packages/orchestrator/src/worker/__tests__/` (precedent: `phase-loop.review-remediate.integration.test.ts`).
- Harness builders `createMockDeps()` / `createMockContext()` / `createConfig()` + `fireOnceTrigger()` + `phaseStartOrder()` are lifted directly from the #1123 integration test.
- `GitHubClient` is mocked as a capturing spy (`vi.fn()` per method, cast `as unknown as GitHubClient`); assertions read `.mock.calls`.
- Marker matching follows `clarification-markers.ts`: line-anchored at column 0, case-sensitive ASCII, `> `-quoted markers do not match.

## Sources

- `docs/engine-review-remediate-plan.md` (generacy-ai/tetrad-development) — full epic design.
- Epic body: generacy-ai/generacy#1120.
- P1 seam contract: `specs/1123-context-phase-1-integration/contracts/remediate-review-seam.md`.
- Dependencies: #1124 (review executor + findings artifact), #1125 (PR posting + draft/ready lifecycle), #1126 (re-review convergence). Downstream consumer: #1130 (engine-thread exclusion + external-feedback routing).
