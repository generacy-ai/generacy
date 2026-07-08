# Tasks: `gh pr checks` field-list fix + `--json` drift guard (#855)

**Input**: Design documents from `/specs/855-found-during-cockpit-v1/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, contracts/
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)

## Phase 1: Wrapper source fix (US1, US2, US3)

- [ ] T001 [US1] Rewrite `getPullRequestCheckRuns`'s `--json` arg to `'name,state,bucket,link'` at `packages/cockpit/src/gh/wrapper.ts:597–610` (FR-001). Drop `conclusion` from the `CheckRunSummary` interface; drop `conclusion`/`detailsUrl` from `CheckRunRawSchema`; simplify `parseCheckRuns` to map `raw.link → url` and remove `raw.conclusion` propagation (FR-002, FR-003, FR-004). Add `'CANCEL'` case to the `normalizeCheckState` switch to cover gh's `bucket` vocabulary.

- [ ] T002 [US3] In the same file `packages/cockpit/src/gh/wrapper.ts`, introduce `GhWrapperLogger` interface + `defaultGhWrapperLogger` (`console.warn` shim) and thread an optional `logger` constructor arg through `GhCliWrapper`. Replace `failIfNonZero(result, 'pr checks')` inside `getPullRequestCheckRuns` with a `logger.warn({ repo, prNumber, ghStderr }, 'gh pr checks failed')` + explicit `throw new Error(...)` (FR-005). Export `GhWrapperLogger` for callers that want to inject pino.

## Phase 2: Downstream type + payload cleanup (US2)

- [ ] T003 [US2] In `packages/generacy/src/cli/commands/cockpit/shared/review-context-json.ts`, delete the `conclusion?: string` field from `ReviewContextPayload.checks[]` and remove the conditional `...(c.conclusion != null ? { conclusion: c.conclusion } : {})` spread in `buildReviewContextPayload`. No other change to the emitted shape.

## Phase 3: Wrapper unit tests (US1, US2, US3)

- [ ] T004 [US1] In `packages/cockpit/src/__tests__/gh-wrapper.test.ts`, update the existing `getPullRequestCheckRuns` positive-path test fixture (`~lines 196–210`) from `{ name, state, conclusion, detailsUrl }` to `{ name, state: 'pass', bucket: 'pass', link: 'https://x' }`. Drop the `conclusion` assertion; assert `url === 'https://x'` (mapped from `link`). Add a fixture case with `bucket: 'cancel'` → asserts `state === 'CANCELLED'` to cover the `normalizeCheckState` switch addition from T001.

- [ ] T005 [US3] In the same file `packages/cockpit/src/__tests__/gh-wrapper.test.ts`, add a new `it('emits warn log and rethrows on non-zero exit', …)` case: inject a `vi.fn()`-backed `{ warn }` logger + a `CommandRunner` that returns `{ stdout: '', stderr: 'Unknown JSON field: "foo"', exitCode: 1 }`, expect `getPullRequestCheckRuns` to reject with `/gh pr checks failed/`, and assert exactly one `logger.warn` call with `({ repo: 'o/r', prNumber: 99, ghStderr: 'Unknown JSON field: "foo"' }, 'gh pr checks failed')`.

## Phase 4: Drift suite (US4)

- [ ] T006 [US4] Create `packages/cockpit/src/gh/__tests__/json-field-drift.test.ts`. Module-scope `hasGhBinary = spawnSync('gh', ['--version']).status === 0`. Load `wrapper.ts` source via `fs.readFileSync`. Statically extract every `'--json',\s*\n\s*'([^']+)'` follow-up (FR-007); build `JsonFieldListSite[]` with `{ fieldList, line, ghSubcommand }`. Assert hard (synthetic failing test) that every `'--json',` follow-up in `wrapper.ts` matched — if any didn't, name the offending line (SC-005).

- [ ] T007 [US4] In the same file `packages/cockpit/src/gh/__tests__/json-field-drift.test.ts`, wrap the extracted-site iteration in `describe.runIf(hasGhBinary)('gh --json field drift', …)`. Emit one `it(...)` per site named like `'--json' at wrapper.ts:<line> — "<fieldList>"`; each `it` runs `spawnSync('gh', ['pr', 'checks', '999999999', '--repo', 'octocat/hello-world', '--json', fieldList], { encoding: 'utf-8', timeout: 5000 })` and asserts `/unknown json field/i.test(result.stderr) === false` (FR-006, FR-008). Ignore exit code, other stderr, stdout — only the client-side `--json` validator matters.

## Phase 5: Downstream fixture cleanup (US2)

- [ ] T008 [P] [US2] Audit and clean `conclusion` from `CheckRunSummary` shapes in `packages/generacy/src/cli/commands/cockpit/__tests__/helpers/fake-gh.ts`. Remove `conclusion` field emissions from any `getPullRequestCheckRuns` fake return values. No assertion changes; grep-verify no `.conclusion` reads remain in fixtures.

- [ ] T009 [P] [US2] Same audit in `packages/generacy/src/cli/commands/cockpit/__tests__/merge.test.ts` — remove any `conclusion` field literals from `CheckRunSummary` fixtures. Verify tests still assert against `state` only.

- [ ] T010 [P] [US2] Same audit in `packages/generacy/src/cli/commands/cockpit/__tests__/context.implementation-review.test.ts`, `context.clarification.test.ts`, `context.artifact-paths.test.ts`, `context.exit-codes.test.ts`. Most likely already omit `conclusion`; remove any occurrences found.

- [ ] T011 [P] [US2] Verify `packages/generacy/src/cli/commands/cockpit/__tests__/watch.check-rollup.test.ts` uses only `state` (per plan.md non-changes list). If any `conclusion` reference has snuck in, remove it; otherwise no-op-verify.

## Phase 6: Verification (all stories)

- [ ] T012 Run `pnpm --filter @generacy-ai/cockpit test` and `pnpm --filter @generacy-ai/generacy test` — all wrapper unit tests + drift suite green, downstream fixture tests still pass. Confirm the drift suite emits `hasGhBinary === true` in CI logs (SC-004) and skips gracefully with `runIf` locally where `gh` is absent.

- [ ] T013 Manual repro of SC-001 per `quickstart.md`: run `generacy cockpit merge <ref>` against a PR with green checks; confirm no `Unknown JSON field` error and the checks branch of the merge decision tree completes. Then run `generacy cockpit status` / `watch` / `context` against the same project; confirm checks column renders real state (not `- / none`) (SC-002).

## Dependencies & Execution Order

**Sequential chain**:

1. T001 → T002 must land before Phase 3 tests can even import the new interface. Do them in that order in the same file.
2. T003 (downstream type cleanup) blocks T008–T011 fixture cleanup (fixture shapes must match the trimmed payload type).
3. T004, T005 (wrapper tests) blocked by T001+T002 (they exercise the new logger + field mapping).
4. T006 → T007 sequential (same file; extractor must exist before the runIf block iterates it).
5. T008–T011 are `[P]` — different fixture files, no cross-dependencies.
6. T012 (test suite) blocked by T001–T011.
7. T013 (manual verification) blocked by T012 (need a green build first).

**Parallel opportunities**:

- **T004 ∥ T005**: both in `gh-wrapper.test.ts` — DIFFERENT test cases, so parallel is fine at the review-effort level but sequential for the same-file edit. Not marked `[P]` for that reason.
- **T006 ∥ T007**: sequential (same file, same suite).
- **T008 ∥ T009 ∥ T010 ∥ T011**: fully parallel — four disjoint fixture files, no shared imports beyond the trimmed type from T003.
- **T003 ∥ T001/T002**: NOT parallel — while the files are disjoint, the fixture updates (T008–T011) semantically depend on T003 first, and T003's payload shape must match T001's `CheckRunSummary` shape. Land T001+T002 first, then T003, then the fixture wave.

**Critical path**: T001 → T002 → T004 → T005 → T003 → (T008 ∥ T009 ∥ T010 ∥ T011) → T006 → T007 → T012 → T013.

---

*Generated by speckit*
