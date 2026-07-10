# Tasks: Deterministic issue→PR resolver with loud ambiguity + draft rejection

**Input**: Design documents from `/specs/904-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/resolver.md, contracts/failing-check-payload.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (all tasks here → US1)

## Phase 1: Types & interface (foundation)

- [ ] T001 [US1] Add `LinkMethod`, `PrCandidate`, and `PullRequestRefResolution` types to `packages/cockpit/src/gh/wrapper.ts` (co-located with existing `PullRequestRef`). Export from the package barrel if one exists; otherwise expose via the same import path callers already use. Invariants I-1..I-5 documented as JSDoc on the union.
- [ ] T002 [US1] Change `GhWrapper.resolveIssueToPRRef` signature in `packages/cockpit/src/gh/wrapper.ts:128` from `Promise<PullRequestRef | null>` to `Promise<PullRequestRefResolution>`. This is the load-bearing interface change; all consumer edits (T007–T010) depend on it. Do NOT touch the implementation body yet — it will fail typecheck until T003 lands, but keeps commits reviewable.

## Phase 2: Resolver implementation

- [ ] T003 [US1] Replace `GhCliWrapper.resolveIssueToPRRef` body in `packages/cockpit/src/gh/wrapper.ts:674-770` with the three-tier deterministic resolver per `contracts/resolver.md`. Introduce a private `evaluateTier(candidates, linkMethod)` helper (per `data-model.md` pseudocode). Tier 1: `gh issue view <n> --repo <r> --json closingIssuesReferences`. Tier 2: `gh pr list --repo <r> --state open --search "head:<issue>-" --json number,url,state,isDraft,headRefName --limit 100`. Tier 3: `gh pr list --repo <r> --state open --search "<issue> in:body" --json ... --limit 100`. Fall-through only on zero-PRs-at-tier; a `gh` error at any tier throws (does NOT fall through — see contracts/resolver.md §Error propagation). Filter each tier's candidates to `state === 'OPEN'` before `evaluateTier`. Delete the current `--search "linked:<n>" --limit 1` primary path AND the `closedByPullRequestsReferences` fallback path (both subsumed by the tiered approach).

## Phase 3: FailingCheckPayload extension (shared type + builder)

- [ ] T004 [US1] In `packages/generacy/src/cli/commands/cockpit/shared/failing-check-json.ts`: extend `RedReason` with `'pr-is-draft' | 'ambiguous-resolution'`. Add exported `LinkMethod` and `PrCandidate` types (import `LinkMethod` from `@generacy-ai/cockpit` if the barrel exports it — see T001; otherwise re-declare locally and unify in T014 polish). Extend the `pr` field's shape to `{ number: number; url: string; linkMethod?: LinkMethod } | null`. Add optional top-level `linkMethod?: LinkMethod` and `candidates?: PrCandidate[]`. Extend `BuildFailingCheckInput` correspondingly.
- [ ] T005 [US1] In the same file, extend `buildFailingCheckPayload` with invariants I-7..I-11 per `data-model.md` §"buildFailingCheckPayload — new invariants": `pr-is-draft` requires `pr === null`, `candidates.length >= 1`, all `candidates[i].isDraft === true`, `linkMethod` set, `failingChecks.length === 0`. `ambiguous-resolution` requires `pr === null`, `candidates.length >= 2`, all `candidates[i].isDraft === false`, `linkMethod` set, `failingChecks.length === 0`. For `missing-label` and `checks-failing`, upgrade the existing `pr` non-null check to also require `pr.linkMethod` be set (I-9). Add I-10/I-11: `candidates`/top-level `linkMethod` MUST NOT be set for `unresolved | missing-label | checks-failing`. Throw `Error("FailingCheckPayload invariant I-<n>: <detail>")` on violation.
- [ ] T006 [P] [US1] Add unit tests for invariants I-7..I-11 to `packages/generacy/src/cli/commands/cockpit/__tests__/failing-check-json.test.ts` (create the file if it doesn't exist): one throw-case per invariant + one happy-path per new reason. This is the local safety net that pins the invariants before consumer wiring lands.

## Phase 4: Consumer wiring

- [ ] T007 [US1] Rewrite the resolver branch in `packages/generacy/src/cli/commands/cockpit/merge.ts:85-114` around the discriminated union. Replace the `if (prRef == null)` + `if (prRef.state !== 'OPEN')` pair with a `switch (resolution.kind)`. Cases:
  - `resolved`: emit `logger.info({ pr: resolution.ref.number, linkMethod: resolution.linkMethod }, `resolved PR #${resolution.ref.number} via ${resolution.linkMethod}` )` **before** any subsequent gh call (FR-004). Continue existing gate/state/label/checks flow with `resolution.ref` in scope. Thread `resolution.linkMethod` into every `pr: { ... }` payload construction in the file (`missing-label`, `checks-failing`, and the state≠OPEN `unresolved` path).
  - `pr-is-draft`: build payload with `reason: 'pr-is-draft'`, `pr: null`, `candidates: resolution.candidates.map(c => ({ number: c.number, url: c.url, isDraft: c.draft, headRefName: c.headRefName }))`, `linkMethod: resolution.linkMethod`. Return `{ exitCode: 1, stdout: serialize... }`. DO NOT call `gh.mergePullRequest`.
  - `ambiguous`: same shape as `pr-is-draft` but with `reason: 'ambiguous-resolution'`.
  - `unresolved`: preserve existing `reason: 'unresolved'` payload with `pr: null`.
- [ ] T008 [US1] Update `packages/generacy/src/cli/commands/cockpit/context.ts:266` (`buildImplementationReviewBundle`) to switch on the new union. Replace `if (prRef == null)` with `switch (resolution.kind)`:
  - `resolved` → extract `.ref` and continue as today.
  - `pr-is-draft` → `throw new CockpitExit(3, 'cockpit context: gate refusal: issue <N> at waiting-for:implementation-review but linked PR(s) are drafts (via <linkMethod>): #A, #B')`.
  - `ambiguous` → `throw new CockpitExit(3, 'cockpit context: gate refusal: issue <N> matches multiple PRs via <linkMethod>: #A, #B')`.
  - `unresolved` → preserve existing `'no linked PR resolved'` message + `CockpitExit(3, …)`.
- [ ] T009 [P] [US1] Update `packages/generacy/src/cli/commands/cockpit/__tests__/helpers/fake-gh.ts` — change the `resolveIssueToPRRef` fake stub to return the new discriminated union. Default stub returns `{ kind: 'unresolved' }`. Add helper factories: `fakeResolvedRef(ref, linkMethod = 'closing-refs')`, `fakePrIsDraft(candidates, linkMethod)`, `fakeAmbiguous(candidates, linkMethod)` for reuse across test files.
- [ ] T010 [P] [US1] Update `packages/cockpit/src/resolver/__tests__/resolve.test.ts:39-41` (`MockGhWrapper.resolveIssueToPRRef`) to return `{ kind: 'unresolved' }` (matches existing behavior — the epic-body parser doesn't exercise this path).

## Phase 5: JSON schema

- [ ] T011 [US1] Extend `specs/789-epic-generacy-ai-tetrad/contracts/failing-check.schema.json` per `contracts/failing-check-payload.md` §"JSON Schema — additive edits": add `'pr-is-draft'` + `'ambiguous-resolution'` to `reason` enum; add third `oneOf` variant to `pr` for `{number, url, linkMethod}`; add top-level optional `linkMethod` string and `candidates` array; add two new `allOf` if/then clauses (one per new reason) with the `candidates.minItems`, `isDraft`-const, `pr: null`, and `failingChecks.maxItems: 0` constraints. Verify against the ajv validator in `merge.test.ts:26-27` by running the merge test suite locally.

## Phase 6: Test coverage

- [ ] T012 [US1] Rewrite the four existing `resolveIssueToPRRef` cases in `packages/cockpit/src/__tests__/gh-wrapper.test.ts:481-573` around the discriminated union. Then add per-tier decision-matrix coverage (per `data-model.md` §"Per-tier decision matrix"): for each of the three tiers, four cases — exactly-one non-draft → `resolved`; ≥2 non-drafts → `ambiguous`; zero non-drafts + ≥1 draft → `pr-is-draft`; zero PRs → fall through. Include one **fall-through spy assertion** per pair of adjacent tiers (Tier 1 falls through → Tier 2 runner call observed; Tier 2 falls through → Tier 3 runner call observed). Include the SC-001 **sniplink fixture** (Tier 1 returns `[#23]`, Tier 3 would return `[#23, #22-draft, #24-draft, #25-draft]`) and assert Tier 2/Tier 3 runners are **never** called.
- [ ] T013 [US1] Extend `packages/generacy/src/cli/commands/cockpit/__tests__/merge.test.ts`:
  - Update the `resolveIssueToPRRef` fake shape at lines 29 + 64-68 to the new union (uses the T009 helpers).
  - Add SC-002 fixture: single-candidate draft → `reason: 'pr-is-draft'`, `runMerge` never invokes `gh.mergePullRequest` (spy assertion). Multi-candidate draft variant.
  - Add SC-003 fixtures: three cases (one per tier) with ≥2 open non-draft candidates → `reason: 'ambiguous-resolution'`, correct `linkMethod`, `gh.mergePullRequest` never invoked.
  - Add SC-004 snapshot: on the green (`resolved`) path, `logger.info` was called with `resolved PR #N via <linkMethod>` **before** any `gh.mergePullRequest` call (assert call order via spy or logger mock).
  - Add snapshot per failing-check payload (`pr-is-draft` single, `pr-is-draft` multi, `ambiguous-resolution` per tier, updated `missing-label` with `linkMethod`, updated `checks-failing` with `linkMethod`) — snapshots round-trip through the ajv validator.
- [ ] T014 [P] [US1] Update `packages/generacy/src/cli/commands/cockpit/__tests__/queue.dependency-warnings.test.ts` — swap any `resolveIssueToPRRef` returning `null`/`PullRequestRef` to the T009 helpers (`{ kind: 'unresolved' }` or `fakeResolvedRef(...)`). No new coverage; just keep the file compiling.
- [ ] T015 [P] [US1] Extend `packages/generacy/src/cli/commands/cockpit/__tests__/context.implementation-review.test.ts` with three cases per `contracts/resolver.md` §Consumer contracts: `pr-is-draft` → `CockpitExit(3, …)` with tier + candidates in the message; `ambiguous` → same shape with tier + candidate #s; `unresolved` → preserved existing message. Update any existing `resolveIssueToPRRef` fakes to the T009 helpers.

## Phase 7: Cross-cutting polish

- [ ] T016 [P] [US1] SC-005 code-search assertion: add a test (or extend an existing meta-test) that greps the repo for `resolveIssueToPRRef` implementations — asserts exactly one lives in `packages/cockpit/src/gh/wrapper.ts` (interface method + one `GhCliWrapper` impl). Documents that `pr-linker.ts` is intentionally excluded (PR→issue direction; per plan.md §"Not touched"). Location suggestion: `packages/cockpit/src/__tests__/single-resolver.test.ts` (new file, ~20 LOC).
- [ ] T017 [US1] Verify `quickstart.md` steps still reproduce: from a fresh checkout, run `pnpm --filter @generacy-ai/cockpit test` and `pnpm --filter @generacy-ai/generacy test -- merge.test.ts` and confirm all green. Fix any remaining stale test fakes surfaced by typecheck (grep for `resolveIssueToPRRef` in test files package-wide as a safety net).

## Dependencies & Execution Order

**Strict sequencing** (interface change is load-bearing):

1. **T001 → T002 → T003** — the resolver types must exist before the interface change lands; the interface change must land before consumers can be updated; the implementation must land before the interface change stops failing typecheck. Commit these together (or in a single PR increment) to keep the tree green.

2. **T004 → T005 → T006** — payload type extension → builder invariants → invariant unit tests. Tests in T006 pin T005 before consumers depend on them.

3. **T003 + T005 → T007 + T008** — both `runMerge` and `context.ts` need the new resolver union (T003) AND the new payload builder shape (T005). T007 and T008 are on different files but T007 is bigger; do T007 first, T008 can be parallel or immediately after.

4. **T009 + T010** — [P] test-fake updates. Independent of each other; both must land before/with T012/T013/T014/T015 or those files won't compile.

5. **T011** — JSON schema update. Independent of TS work but T013's snapshot round-trip depends on it.

6. **T012, T013, T014, T015** — [P] test coverage. All can run in parallel once T003, T005, T007, T008, T009, T010, T011 are in.

7. **T016, T017** — polish. T016 [P] can run any time after T003. T017 is the final green-tree check.

**Parallel opportunities**:
- T009 and T010 (different test files, both trivial fake-shape updates).
- T011 (JSON schema, separate file from all TS work) can land in parallel with the T004/T005 payload work.
- T012, T013, T014, T015 all in parallel once the type/impl foundation is stable.
- T016 in parallel with T012-T015.

**Suggested next step**: `/speckit:implement` to begin execution.
