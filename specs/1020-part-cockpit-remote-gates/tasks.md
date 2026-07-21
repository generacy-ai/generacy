# Tasks: Cockpit Remote Gates — Shared Wire Contracts

**Input**: Design documents from `/specs/1020-part-cockpit-remote-gates/`
**Prerequisites**: plan.md (required), spec.md (required), clarifications.md, research.md, data-model.md, quickstart.md, contracts/ (three JSON Schema files)
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: All tasks target US1 (schema-only issue — one user story implicit in acceptance criteria)

## Phase 1: Setup

- [X] T001 [US1] Create module directory `packages/cockpit/src/gates/` (empty scaffolding step — subsequent tasks write the files listed in `plan.md` §Project Structure). No `package.json` edit; no new dependency; root export only (Q2=A).

## Phase 2: Type surface (foundational — must land before schemas import from it)

- [X] T002 [P] [US1] Author `packages/cockpit/src/gates/types.ts` with the `GATE_TYPES` const tuple + `GateTypeSchema` (`z.enum(GATE_TYPES)`), `ARTIFACT_REVIEW_KINDS` + `ArtifactReviewKindSchema`, and `GATE_OUTCOMES` + `GateOutcomeSchema`. Exact string members and shapes per `data-model.md` §1–2. Import `z` from `zod`. Export both the const arrays (for iteration in tests + fixtures) and the schemas (for parsing). Types via `z.infer<>`.

## Phase 3: Core schemas (depends on Phase 2)

- [X] T003 [US1] Author `packages/cockpit/src/gates/schemas.ts` with `IssueRefSchema`, `ActorSchema`, `GateOptionSchema`, `GateRecordSchema`, `GateAnswerSchema`, `GateOutcomeAckSchema`. Field shapes, `.regex()` / `.datetime({ offset: true })` / `.min(0)` / `z.literal(true)` invariants exactly per `data-model.md` §2–3. `GateAnswerSchema` MUST include the `.refine(v => v.optionId !== null || (v.freeText !== undefined && v.freeText.length > 0), { message: 'optionId=null requires a non-empty freeText' })` rule from §3. Schemas use plain `z.object()` (NOT `.strict()`) per §5 forward-compat rule. Re-export the ArtifactReviewKind/GateType/GateOutcome symbols authored in T002 by importing from `./types.js`.

## Phase 4: Derivation helpers (depend on Phase 2 for `GateType` / `ArtifactReviewKind`)

- [X] T004 [P] [US1] Author `packages/cockpit/src/gates/gate-id.ts` with `deriveGateKey(input: { issueRef, gateType, generation }): string` producing exactly `${owner}/${repo}#${number}:${gateType}:${generation}` and `deriveGateId(gateKey: string): string` producing `createHash('sha256').update(gateKey, 'utf8').digest('hex').slice(0, 24)`. Import `createHash` from `node:crypto`. Both functions pure; no I/O; no zod parse inside (data-model §4 — helpers are pure formatters, callers own boundary validation).

- [X] T005 [P] [US1] Author `packages/cockpit/src/gates/generation.ts` with all eight per-gate-type helpers: `deriveClarificationGeneration`, `deriveArtifactReviewGeneration`, `deriveImplementationReviewGeneration`, `deriveManualValidationGeneration`, `deriveEscalationGeneration`, `derivePhaseQueueGeneration`, `deriveFilingGeneration`, `deriveScopeDrainedGeneration`. Return-string formats exactly per `data-model.md` §4 (colon-joined lowercase, Q1=A). `ArtifactReviewGenerationInput.kind` typed as `ArtifactReviewKind` from `./types.js` for compile-time typo safety (Q5=A). No runtime Zod parse — TypeScript structural typing handles the boundary; document in a one-line JSDoc comment that untrusted callers should `ArtifactReviewKindSchema.parse(kind)` before the call.

## Phase 5: Fixtures (depend on Phase 3 schemas + Phase 4 helpers)

- [X] T006 [US1] Author `packages/cockpit/src/gates/fixtures.ts` exporting: `VALID_FIXTURES: Record<GateType, GateRecord>` (8 entries, one per gate type — construct each via the matching generation helper + `deriveGateKey` + `deriveGateId` so the fixture round-trips deterministically); `MALFORMED_FIXTURES: Record<string, unknown>` with named entries covering at minimum `'missing-description'`, `'allow-free-text-false'`, `'empty-gate-id'`, `'unknown-gate-type'`, `'non-hex-gate-id-prefix'`, `'answer-null-option-empty-free-text'`, `'invalid-issue-url'`, `'naive-timestamp'`; `VALID_ANSWER_FIXTURES: Record<GateType, GateAnswer>` (one per gate type, alternating between `optionId`-set and `optionId: null` + `freeText` paths so both branches of the refine rule get fixture coverage); `VALID_ACK_FIXTURES: Record<'applied' | 'superseded' | 'failed', GateOutcomeAck>` (3 entries). Every valid fixture MUST pass its matching `Schema.parse(...)` at module load (assert inline so a fixture drift breaks the build immediately, not the test run).

## Phase 6: Module aggregate export

- [X] T007 [US1] Author `packages/cockpit/src/gates/index.ts` re-exporting the full public surface exactly as listed in `data-model.md` §7 (schemas, enums + const tuples, types via `z.infer`, derivation helpers, all eight generation helpers, all four fixture maps). This is the single import surface the package root pulls from.

## Phase 7: Package root re-export (depends on Phase 6)

- [X] T008 [US1] Edit `packages/cockpit/src/index.ts` to add the "Wire contracts" re-export block from `data-model.md` §7 at the bottom of the file (after the existing `gh wrapper` block). Naming collision resolution: the existing `IssueRef` type exported from `./resolver/types.js` (see current `src/index.ts:39`) collides with the new `IssueRef` from `./gates/index.js`. The two shapes are DIFFERENT (`resolver/types` `IssueRef` is `{ owner, repo, issueNumber }`; gates `IssueRef` is `{ owner, repo, number }`). Resolve by re-exporting the gates version under an alias `type GateIssueRef` alongside `IssueRefSchema` (kept unaliased — no schema collision). Do NOT rename either underlying type; alias only at the root export boundary. Update `data-model.md` §7 surface list in a companion doc-fix commit if the alias name differs from what §7 shows.

## Phase 8: Tests (parallel — each test file is independent)

- [X] T009 [P] [US1] Author `packages/cockpit/src/__tests__/gates-schemas.test.ts`. Coverage: (a) each of the 8 `VALID_FIXTURES[gateType]` round-trips through `GateRecordSchema.parse(JSON.parse(JSON.stringify(fixture)))` and deep-equals the input (data-model §5); (b) every named entry in `MALFORMED_FIXTURES` throws when parsed against its matching schema, and the thrown message names the offending field (spot-check 2–3 cases with `.toThrow(/allowFreeText/)` style matchers rather than asserting the full message); (c) `allowFreeText: false` is rejected specifically (Q4=A invariant); (d) `optionId: null` + missing/empty `freeText` on a `GateAnswer` is rejected with the exact refine message `optionId=null requires a non-empty freeText`; (e) `askedAt` / `answeredAt` / `at` reject a naive `new Date().toString()` and accept `new Date().toISOString()`.

- [X] T010 [P] [US1] Author `packages/cockpit/src/__tests__/gates-id.test.ts`. Coverage: (a) `deriveGateId(deriveGateKey({...}))` is byte-identical across two invocations with the same inputs (determinism — load-bearing per research §3); (b) result matches `/^[0-9a-f]{24}$/`; (c) hand-computed sha256 of a fixed pre-image (e.g. `generacy-ai/generacy#1020:artifact-review:spec-review:abc1234`) matches the helper output for the first 24 hex chars — locks the algorithm, not just the shape; (d) different `gateType` OR different `generation` with the same `issueRef` produces a different `gateId`; (e) `deriveGateKey` output shape is exactly `${owner}/${repo}#${number}:${gateType}:${generation}` (regex assert).

- [X] T011 [P] [US1] Author `packages/cockpit/src/__tests__/gates-generation.test.ts`. Coverage: (a) `deriveArtifactReviewGeneration({ kind: 'spec-review', headSha: 'abc1234' })` returns `'spec-review:abc1234'` (and same for all four `ArtifactReviewKind`s); (b) `deriveEscalationGeneration({ subtype: 'stalled', labelOrState: 'agent:error', counter: 3 })` returns `'stalled:agent:error:3'` — asserts that colons inside `labelOrState` are preserved (research §5 escalation note); (c) `deriveScopeDrainedGeneration({ trackingIssueRef: {owner:'generacy-ai',repo:'generacy',number:900}, counter: 2 })` returns `'generacy-ai/generacy#900:2'`; (d) simple-number helpers (`deriveManualValidationGeneration`, `derivePhaseQueueGeneration`) return `String(phaseNumber)`; (e) `deriveClarificationGeneration` and `deriveFilingGeneration` return the sole input field verbatim.

## Phase 9: JSON Schema mirror (parallel with Phase 8 — no code dep)

- [X] T012 [P] [US1] Regenerate the three JSON Schema files under `specs/1020-part-cockpit-remote-gates/contracts/` (`gate-record.schema.json`, `gate-answer.schema.json`, `gate-outcome-ack.schema.json`) from the authored Zod schemas via a one-shot `zod-to-json-schema` invocation (research §10 — manual regenerate step, NOT wired into `pnpm build`). Verify the three files already checked in match the newly-generated output; if drift, update the checked-in files. Do not add `zod-to-json-schema` as a package dep — invoke via `pnpm dlx` or a scratch script. Cross-repo mirror consumers (generacy-cloud) read these files as source of truth.

## Phase 10: Changeset (CI gate — MUST land in the PR)

- [X] T013 [US1] Add `.changeset/1020-cockpit-gates.md` with front-matter `"@generacy-ai/cockpit": minor` and a one-line summary (per CLAUDE.md §Changesets — this is a new public API surface, minor bump). MUST be a **newly added** file in the PR diff — the CI gate greps `--diff-filter=A` against base. Copy the shape of a recent comparable changeset in `.changeset/` if unsure.

## Phase 11: Verification

- [X] T014 [US1] Run `pnpm --filter @generacy-ai/cockpit typecheck` and `pnpm --filter @generacy-ai/cockpit test` locally. Confirm: (a) all three new test files pass; (b) no other tests in `@generacy-ai/cockpit` regressed (the `IssueRef` alias in T008 is the most likely regression surface — the existing `resolver/types.js` `IssueRef` is used by classifier/resolver tests); (c) `tsc` reports zero errors across the package; (d) `MALFORMED_FIXTURES` inline `Schema.parse` in T006 does NOT throw at module load (fixtures must be well-formed *as `unknown`* — the schemas reject them, not the type system).

## Dependencies & Execution Order

**Sequential dependencies**:
- T001 (dir) → T002 (types)
- T002 (types) → T003 (schemas) — schemas import `GateTypeSchema` etc. from `./types.js`
- T002 (types) → T004 + T005 (helpers) — `ArtifactReviewKind` type
- T003 + T004 + T005 → T006 (fixtures) — fixtures use every schema + every generation helper
- T006 → T007 (module index) — re-exports fixtures
- T007 → T008 (root index) — root re-exports from `./gates/index.js`
- T003 + T005 + T006 → T009 (schema tests)
- T004 → T010 (id tests)
- T005 → T011 (generation tests)
- T003 → T012 (JSON schema regen)
- All implementation tasks (T001–T012) → T014 (verification)

**Parallel opportunities**:
- T004 and T005 (different files, both depend only on T002) can run in parallel.
- T009, T010, T011, T012 (Phase 8 + Phase 9) can all run in parallel once their code deps land.
- T013 (changeset) has no code dep — can be added at any time before PR opens.

**Critical path**: T001 → T002 → T003 → T006 → T007 → T008 → T014. Everything else fans off this spine.

## Notes for the implementer

- **Root export only** (Q2=A): do NOT edit `packages/cockpit/package.json` `exports`. Downstream imports must read `import { GateRecordSchema } from '@generacy-ai/cockpit'`.
- **Zero I/O in the module** (plan §Technical Context): no `fs`, no `net`, no `child_process` anywhere under `src/gates/`. Only `node:crypto` for sha256 (T004).
- **Fixture determinism**: because `deriveGateId` is a pure hash of a deterministic pre-image, every `VALID_FIXTURES[type].gateId` is a specific 24-hex-char string. Do NOT hand-type these — compute them via the helpers so the fixture stays in sync when a generation helper's shape ever changes (which requires an epic-level coordinated change anyway).
- **`allowFreeText: z.literal(true)`** (Q4=A): schema-enforced invariant. There is no `allowFreeText: false` fixture. If a downstream implementer needs one, they need a new gateType, not a schema loosening.
- **No `.strict()` on `z.object`** (data-model §5): forward-compat additive fields are a feature, not a bug. Wire-contract changes stay a coordinated epic-level decision, but unknown fields passthrough silently.
- **Playbook coupling check**: `spec.md` / `plan.md` / issue body do NOT name any `packages/claude-plugin-cockpit/commands/*.md` file. No `playbook-verification.test.ts` re-pin task required.
