# Tasks: Cockpit `resolveEpicIssues` honors cross-repo epic children

**Input**: Design documents from `/specs/801-found-dogfooding-cockpit-its/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 status, US2 watch, US3 fallback; FR-### for cross-cutting requirements)

## Phase 1: Setup

- [ ] T001 Verify branch and clean tree: `git status` on `801-found-dogfooding-cockpit-its`; ensure `pnpm install` has been run from the repo root so cockpit + generacy workspaces resolve each other.
- [ ] T002 [P] Snapshot current public types from `packages/cockpit/src/manifest/scoping.ts` and `packages/generacy/src/cli/commands/cockpit/shared/scoping.ts` — quick read to confirm the actual present-day signatures match the contracts in `specs/801-found-dogfooding-cockpit-its/contracts/`. No code changes; this catches drift before the breaking edit.

## Phase 2: Library — `@generacy-ai/cockpit` Type + Signature Change (blocking for consumers)

- [ ] T010 [FR-001] In `packages/cockpit/src/manifest/scoping.ts`, add and export `IssueRef` type matching `contracts/resolveEpicIssues.ts` (`{ repo: string; number: number }`).
- [ ] T011 [FR-001] In the same file, extend `ResolveEpicIssuesOptions` with the new optional `repos?: string[]` field (see `data-model.md` "Updated Type"). Keep `manifestRoot`, `gh`, `cwd`, `logger` unchanged.
- [ ] T012 [FR-007] In `packages/cockpit/src/index.ts`, re-export `IssueRef` (and confirm `ResolveEpicIssuesOptions` is already exported).
- [ ] T013 [FR-001][FR-002] Change `resolveEpicIssues` return type from `Promise<number[]>` to `Promise<IssueRef[]>`. Manifest path: replace the `parseIssueRefNumber(ref, ownerRepo)` filter with a parser that accepts every `owner/repo#n` entry in `phases[].issues` and emits `IssueRef`. Cross-repo entries must be retained.
- [ ] T014 [FR-002] Sort and dedup the manifest-path result: dedup by `${repo}#${number}`, sort ascending by `(repo, number)` — matches the determinism convention in research.md D1/D4.

## Phase 3: Library — Fallback Path Rewrite

- [ ] T020 [FR-004] In `resolveEpicIssues` fallback branch (no matching manifest), build `repoSet = unique([...(options.repos ?? []), \`${owner}/${repo}\`])`. Helper inlined in `packages/cockpit/src/manifest/scoping.ts`.
- [ ] T021 [FR-004] For each `R in repoSet`, run **both** `gh search` queries: `repo:R is:issue label:epic-child <owner>/<repo>#<epicN>` and `repo:R is:issue <owner>/<repo>#<epicN> in:body`. Embed the full `owner/repo#N` form to avoid cross-repo `#N` collisions (research.md D4).
- [ ] T022 [FR-004] Merge results and dedup by `(R, issue.number)`. Apply the same `(repo, number)` sort as the manifest path.
- [ ] T023 [FR-005] When `options.repos` is omitted (or empty after dedup leaves only the epic's own repo by default), emit a single structured `logger.warn` line naming the limitation. Wording: `cockpit: resolveEpicIssues called without configured repos; searching epic repo only (<owner>/<repo>). Cross-repo children will not be discovered.` (matches quickstart.md "Negative case" expectation).
- [ ] T024 [FR-006] Surface malformed-manifest warnings: confirm the existing `logger.warn` path still fires when a `.generacy/epics/*.yaml` fails Zod validation, and that it names the file path and reason. If the wording today is sparse, extend it — but do not change the call shape.

## Phase 4: Consumer Updates — `packages/generacy` CLI (blocked by Phase 2)

- [ ] T030 [FR-003] In `packages/generacy/src/cli/commands/cockpit/shared/scoping.ts`, change `Scope.issues` from `number[]` to `IssueRef[]` (import the type from `@generacy-ai/cockpit`). Update `resolveScope` so `kind: 'epic'` branches construct the new shape directly from `resolveEpicIssues(...)` output. Thread `loaded.config.repos` through as `options.repos` per research.md "Pattern: CLI threads cockpit.repos into resolveScope".
- [ ] T031 [US1][FR-003] In `packages/generacy/src/cli/commands/cockpit/status.ts`, iterate `scope.issues` as `IssueRef[]`. Group by `repo` to preserve the per-repo `gh search` batching; per group, embed only the numbers belonging to that repo (see contracts/scope.ts "Consumer expectations"). Each rendered row's `repo` column must come from the `IssueRef`, not from `scope.ownerRepo`.
- [ ] T032 [US2][FR-003] In `packages/generacy/src/cli/commands/cockpit/watch/poll-loop.ts`, update `reposForScope(scope)` for epic scope to return `unique(scope.issues.map(r => r.repo))`. Update `queryFor(scope, repo)` to embed only the issue numbers whose `IssueRef.repo === repo`. Confirm NDJSON events carry the child's full `owner/repo#n` identity.
- [ ] T033 [US2] In `packages/generacy/src/cli/commands/cockpit/watch.ts`, confirm the JSON envelope (`renderJsonEnvelope`) continues to carry the epic's own `owner/repo/issue` unchanged, and that the new `scope.issues` shape flows through without per-call adaptation. Touch only if a compile error reveals an assumption (most wiring is shape-transparent).
- [ ] T034 [FR-006] Where `resolveScope` catches a malformed-manifest warning from the library, also surface it on the CLI's stderr (FR-006 explicitly asks for one human-readable warning in CLI stderr in addition to the structured log).

## Phase 5: Tests — Library (FR-008, parallel within phase)

- [ ] T040 [P][FR-008][US1] In `packages/cockpit/src/__tests__/manifest-scoping.test.ts`, migrate every existing assertion from `number[]` to `IssueRef[]`. Existing single-repo cases stay green after the shape change.
- [ ] T041 [P][FR-008][US1] Add a new test: manifest with `phases[].issues` containing cross-repo refs (`epicRepo = owner-A/repo-A`, children in `owner-B/repo-B`). Assert every child is present with its own `repo`, none filtered.
- [ ] T042 [P][FR-008][US3] Add a new test: no matching manifest, `options.repos = ['owner-A/repo-A', 'owner-B/repo-B']`, epic in `owner-C/repo-C`. Mock `gh.search` to return distinct results per repo. Assert the function ran both queries per repo (label + body), unioned `repoSet` with `owner-C/repo-C`, and deduped on `(repo, number)`.
- [ ] T043 [P][FR-008][FR-005] Add a new test: no matching manifest, `options.repos` omitted. Assert `logger.warn` was called with the FR-005 warning text and the fallback searched only the epic's own repo.
- [ ] T044 [P][FR-008][FR-006] Add a new test: malformed `.generacy/epics/<x>.yaml` (Zod parse failure). Assert `logger.warn` names the file path and reason, and resolution falls through to the fallback path.

## Phase 6: Tests — CLI Consumers (FR-008, parallel within phase, blocked by Phase 4)

- [ ] T050 [P][FR-008] In `packages/generacy/src/cli/commands/cockpit/__tests__/shared.scoping.test.ts`, migrate existing assertions from `number[]` to `IssueRef[]`. Single-repo epic cases stay green.
- [ ] T051 [P][FR-008][US2] In `packages/generacy/src/cli/commands/cockpit/__tests__/watch.epic-walk.test.ts`, add a cross-repo case: scope with `issues: [{ repo: 'a/b', number: 1 }, { repo: 'c/d', number: 2 }]`. Assert `reposForScope` returns `['a/b', 'c/d']` (unique), `queryFor(..., 'a/b')` embeds only number `1`, and NDJSON events carry the per-child `owner/repo`.

## Phase 7: Version Bump & Polish

- [ ] T060 [FR-007] Bump `packages/cockpit/package.json` from `0.1.0` to `0.2.0` (pre-1.0 minor for breaking API change; research.md D5).
- [ ] T061 Run `pnpm --filter @generacy-ai/cockpit build && pnpm --filter @generacy-ai/generacy build`. Fix any TypeScript errors surfaced by remaining consumers (none expected outside the four files listed in plan.md, but the type checker is authoritative).
- [ ] T062 Run `pnpm --filter @generacy-ai/cockpit test` and `pnpm --filter @generacy-ai/generacy test -- shared.scoping watch.epic-walk` — both green.

## Phase 8: Manual Verification (Success Criteria, sequential — uses live data)

- [ ] T070 [US1][SC-001][SC-002] Execute the quickstart US1 command: `generacy cockpit status --epic generacy-ai/tetrad-development#85`. Confirm rows for `generacy-ai/generacy#786–793` and `generacy-ai/agency#350–360`, per-row `repo` column shows the child's repo, no unrelated `tetrad-development` issues appear.
- [ ] T071 [US2] Execute `generacy cockpit watch --epic generacy-ai/tetrad-development#85` for one full poll cycle. Confirm per-repo polls and NDJSON events carry full `owner/repo#n` identity. Stop with `Ctrl+C`.
- [ ] T072 [US3][SC-003] Execute the quickstart US3 fallback recipe (scratch dir with `cockpit.yaml` listing `generacy` + `agency`, no manifest). Confirm results union across `cockpit.repos ∪ epic's own repo`, both queries fire per repo, results are repo-qualified.
- [ ] T073 [SC-004] Execute `generacy cockpit status --epic <single-repo-epic>` against a known single-repo epic. Confirm no regression — every child resolves to one repo, identical rendering to pre-fix behavior.

## Dependencies & Execution Order

**Sequential chain (must respect order)**:
- Phase 1 (Setup) → Phase 2 (Library types/signature) → Phase 3 (Library fallback) → Phase 4 (CLI consumers) → Phase 7 (build + tests pass) → Phase 8 (manual verification)
- Phase 2 blocks Phase 4: consumer files import `IssueRef` from `@generacy-ai/cockpit`, so the type must exist first.
- Phase 3 blocks T070/T072 (manual verification of fallback) but not the CLI-shape changes (Phase 4 only needs the return type, not the fallback behavior).
- Phase 7 blocks Phase 8: don't manually verify with a stale build.

**Parallel opportunities**:
- T010 + T011 + T012 can run together (same file, but small additions — or split: T012 is a separate file).
- All of Phase 5 (T040–T044) is parallel within itself — same test file, but independent test cases. In practice, batch them in one edit; the `[P]` marker reflects logical independence.
- All of Phase 6 (T050, T051) is parallel — two different test files.
- Phase 5 and Phase 6 can run in parallel with each other once Phase 2 + Phase 4 finish.
- T002 can run in parallel with T001.

**Critical path**: T001 → T010 → T013 → T030 → T031 → T032 → T060 → T062 → T070. Everything else hangs off this spine.

---

*Generated by speckit*
