# Feature Specification: Epic: generacy-ai/tetrad-development#85 | Phase: S3 | Tier: v1-simplification | Issue: G-S3

Collapse the CLI surface to the rev 3 catalog: one `context <issue>` verb, one gh wrapper, one resolver module.

**Branch**: `807-epic-generacy-ai-tetrad` | **Date**: 2026-07-06 | **Status**: Draft

## Summary

Epic: generacy-ai/tetrad-development#85 | Phase: S3 | Tier: v1-simplification | Issue: G-S3

Collapse the CLI surface to the rev 3 catalog. Merge `state` + `clarify-context` + `review-context` into one `context <issue>` verb: classify the issue's current gate, emit the bundle that gate needs (clarification comment + spec/plan + code refs for clarification; PR metadata + diff + checks for implementation-review / merge preflight; artifact paths for spec/plan/tasks review). Fold the CLI-local `gh-ext.ts` (`CockpitGh`, 306 LOC) into the engine's single `gh` wrapper (`packages/cockpit/src/gh/wrapper.ts`); collapse the three ref/scope resolvers (`shared/scoping.ts`, `shared/resolve-context.ts`, `issue-ref.ts`) into one module. `advance` and `merge` behavior unchanged; exit-code convention kept (0 success / 1 gh-IO / 2 usage / 3 gate refusal).

Owns (isolation): `packages/generacy/src/cli/commands/cockpit/{state.ts,clarify-context.ts,review-context.ts,gh-ext.ts,issue-ref.ts,shared/**,index.ts}` ; `packages/cockpit/src/gh/**`.

Acceptance: `generacy cockpit context` returns the correct bundle for each gate (unit-tested per gate); exactly one gh wrapper and one resolver module remain; advance/merge tests pass unchanged.

Depends on: G-S2 (resolver + registration files) (see the epic checklist for issue numbers).

---
Part of the Epic Cockpit. Plan: `docs/epic-cockpit-plan.md` in tetrad-development (S3 / G-S3).

## User Stories

### US1: One verb to fetch whatever the current gate needs

**As an** operator (human or agent) running the cockpit on an in-flight issue,
**I want** a single `generacy cockpit context <issue>` verb that classifies the issue's current gate and emits the bundle that gate needs,
**So that** I do not have to know which sub-verb (`state` / `clarify-context` / `review-context`) matches which gate, and I never receive the wrong bundle for the state I'm in.

**Acceptance Criteria**:
- [ ] Given an issue labelled `waiting-for:clarification`, `context <issue>` emits the clarification bundle (clarification comment + `spec.md` + `plan.md` + code references) — same shape as the current `clarify-context` output.
- [ ] Given an issue whose linked PR is at `waiting-for:implementation-review` (or the merge-preflight equivalent), `context <issue>` emits the PR bundle (PR metadata + unified diff + check results) — same shape as the current `review-context` output.
- [ ] Given an issue at a spec/plan/tasks review gate (e.g. `waiting-for:spec-review`, `waiting-for:plan-review`, `waiting-for:tasks-review`), `context <issue>` emits the artifact-paths bundle (paths to `specs/<dir>/spec.md`, `plan.md`, `tasks.md` as they exist).
- [ ] Given an issue at a gate `context` does not know how to bundle (or `state = unknown`), the verb exits `3` with a message naming the current label — a gate refusal, not a silent success.
- [ ] Output is stable JSON on stdout; diagnostics go to stderr; exit code is `0` on success, `1` on gh-IO failure, `2` on usage error, `3` on gate refusal.

### US2: One `gh` wrapper across cockpit and CLI

**As a** contributor adding or debugging a cockpit CLI command,
**I want** exactly one `gh` wrapper (`packages/cockpit/src/gh/`) that both the engine and the CLI verbs use,
**So that** I do not have to discover, extend, or keep in sync the CLI-local `gh-ext.ts` (`CockpitGh`, 306 LOC) alongside the engine wrapper.

**Acceptance Criteria**:
- [ ] Every method previously exported from `packages/generacy/src/cli/commands/cockpit/gh-ext.ts` (`fetchIssueLabels`, `fetchIssueState`, `postIssueComment`, `addLabel`, `removeLabel`, `addAssignees`, `fetchIssueTimeline`, `fetchIssueComments`, `getCurrentUser`, plus any helpers used by `state`/`advance`/`clarify-context`) is available on the engine `GhWrapper` in `packages/cockpit/src/gh/wrapper.ts`.
- [ ] `packages/generacy/src/cli/commands/cockpit/gh-ext.ts` is deleted.
- [ ] No file under `packages/generacy/src/cli/commands/cockpit/**` imports from a CLI-local gh wrapper; all `gh` calls route through `@generacy-ai/cockpit`'s exported wrapper.
- [ ] Existing method signatures on the engine `GhWrapper` remain source-compatible for engine call sites (watch/status/merge); additions are additive.

### US3: One resolver module for issue refs and repo scoping

**As a** contributor touching how the cockpit parses `<issue>` arguments or resolves a repo from cwd,
**I want** exactly one resolver module,
**So that** ref-shape rules, repo inference, and the returned `gh` instance live in one place rather than being spread across `shared/scoping.ts` (if still present), `shared/resolve-context.ts`, and `issue-ref.ts`.

**Acceptance Criteria**:
- [ ] The three files `shared/scoping.ts`, `shared/resolve-context.ts`, and `issue-ref.ts` collapse into one module (name TBD in plan; e.g. `shared/resolve.ts`) exporting the parser (previously `parseIssueRef` → `IssueRef`) and the context resolver (previously `resolveContext` → `ResolvedContext { repo, issue, gh }`).
- [ ] Every remaining call site in `packages/generacy/src/cli/commands/cockpit/**` imports from the single module.
- [ ] Ref-shape acceptance rules are preserved: `owner/repo#N` and full GitHub issue/PR URLs accepted; bare `#N` still rejected with the same error message shape.
- [ ] `advance` and `merge` continue to compile and pass their existing tests against the new module.

### US4: `advance` and `merge` behavior unchanged

**As an** operator who already relies on `generacy cockpit advance` and `generacy cockpit merge`,
**I want** their observable behavior — command surface, output, exit codes, gate transitions — to be unchanged after the collapse,
**So that** in-flight automations, docs, and muscle memory keep working while the read-side surface is being simplified.

**Acceptance Criteria**:
- [ ] `advance`'s existing unit tests pass unchanged (no test edits beyond import-path updates required by the resolver/gh consolidation).
- [ ] `merge`'s existing unit tests pass unchanged (same constraint).
- [ ] `--help` output for `advance` and `merge` is byte-identical, save for any implicit changes forced by removing `state`/`clarify-context`/`review-context` from the parent group listing.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | New verb `generacy cockpit context <issue>`: parses `<issue>` via the collapsed resolver, classifies the issue's current gate (reusing the `GATES` map derived from `WORKFLOW_LABELS`), and dispatches to the bundle producer for that gate. | P1 | Single entry point replacing `state` + `clarify-context` + `review-context`. |
| FR-002 | Gate → bundle mapping: (a) `waiting-for:clarification` → clarification bundle (clarification comment + `spec.md` + `plan.md` + code references); (b) `waiting-for:implementation-review` and merge-preflight equivalent → PR bundle (PR metadata + unified diff + check results); (c) `waiting-for:spec-review` / `waiting-for:plan-review` / `waiting-for:tasks-review` → artifact-paths bundle listing the relevant paths under `specs/<dir>/`. | P1 | Bundle payload shapes match today's `clarify-context` and `review-context` JSON so downstream skills/consumers keep working. |
| FR-003 | Unknown or unhandled gate (including `state = unknown`): the verb exits `3` with a message naming the issue's current label(s). No silent success and no partial bundle. | P1 | Preserves the gate-refusal exit-code convention (3) that `clarify-context` uses today. |
| FR-004 | Exit codes: `0` = success, `1` = gh-IO failure, `2` = usage/ref-parse error, `3` = gate refusal. Identical across `context`, `advance`, `merge`, `watch`, `status`, `queue`. | P1 | Explicitly called out in the epic body. |
| FR-005 | Output: bundle payload is a single JSON object on stdout, terminated by a newline; diagnostics and warnings go to stderr. `--json` flag is not required (JSON is the only shape). | P1 | Matches the existing convention in `clarify-context`/`review-context`. |
| FR-006 | Delete `state`, `clarify-context`, and `review-context` from the command group in `packages/generacy/src/cli/commands/cockpit/index.ts`. The verbs are removed, not aliased. | P1 | Rev-3 principle: shrink the surface — do not preserve every old verb. |
| FR-007 | `packages/generacy/src/cli/commands/cockpit/gh-ext.ts` is deleted. Every method it exported is added to the engine `GhWrapper` (`packages/cockpit/src/gh/wrapper.ts`) and re-exported from `@generacy-ai/cockpit`. | P1 | "Exactly one gh wrapper" acceptance criterion. |
| FR-008 | The three resolver files (`shared/scoping.ts` if present after S2, `shared/resolve-context.ts`, `issue-ref.ts`) are collapsed into one module. All call sites in `packages/generacy/src/cli/commands/cockpit/**` are updated. | P1 | "Exactly one resolver module" acceptance criterion. |
| FR-009 | Ref-shape parsing rules preserved verbatim: accept `owner/repo#N` and full GitHub issue/PR URLs; reject bare `#N` with the existing error message shape. | P1 | Same behavior as today's `parseIssueRef`. |
| FR-010 | `advance` and `merge` command surfaces, flags, output, and exit codes are unchanged from the caller's perspective. Their unit tests pass unchanged apart from import-path adjustments forced by FR-007/FR-008. | P1 | Explicit epic acceptance constraint. |
| FR-011 | Unit tests exist for `context` per gate: one test per branch of FR-002 (clarification, implementation-review, spec-review, plan-review, tasks-review) plus the gate-refusal branch of FR-003. Assertions cover both the exit code and the shape of the emitted JSON. | P1 | Epic acceptance: "unit-tested per gate". |
| FR-012 | Isolation: no file outside the owned paths (`packages/generacy/src/cli/commands/cockpit/{state.ts,clarify-context.ts,review-context.ts,gh-ext.ts,issue-ref.ts,shared/**,index.ts}` and `packages/cockpit/src/gh/**`) is modified, except for consumer import-path updates in files that today import the removed exports. | P1 | Keeps blast radius bounded to what the epic reserves for S3. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Correct bundle per gate | For each gate in FR-002, `generacy cockpit context <issue>` emits the documented bundle shape and exits `0` | Vitest suite: one test per gate exercising the whole verb through a stubbed `CommandRunner`. |
| SC-002 | Loud gate refusal | Given an unhandled gate or `state = unknown`, `context` exits `3` with a message naming the current label(s) | Vitest test asserting exit code and stderr contents. |
| SC-003 | One gh wrapper | Zero files under `packages/generacy/src/cli/commands/cockpit/**` export or import a CLI-local gh wrapper; `gh-ext.ts` deleted | Static check via `grep` for `CockpitGh` and `gh-ext` — expected zero hits outside test fixtures. |
| SC-004 | One resolver module | Zero remaining imports of `shared/scoping`, `shared/resolve-context`, or `issue-ref` under the cockpit paths | Static check via `grep` for those specifiers — expected zero hits. |
| SC-005 | Exit-code convention preserved | `context`, `advance`, `merge` all use `{0,1,2,3}` per FR-004 | Vitest coverage on each verb's error paths. |
| SC-006 | advance/merge regression-free | Existing `advance` and `merge` unit tests pass with no assertion changes | Green CI on `packages/generacy` typecheck + test steps. |
| SC-007 | Removed verbs unregistered | `generacy cockpit --help` no longer lists `state`, `clarify-context`, or `review-context` | Snapshot test on the parent command's `--help` output. |

## Assumptions

- G-S2 (single-source discovery / resolver + registration files) has landed. This spec builds on the post-S2 file layout.
- The current gate vocabulary in `WORKFLOW_LABELS` (`packages/workflow-engine`) already covers every gate `context` needs to classify (clarification, implementation-review, spec-review, plan-review, tasks-review, plus the merge-preflight label used by `merge`). Adding new gates is out of scope for S3.
- The bundle payload shapes emitted today by `clarify-context` (`ClarifyContextOutput`) and `review-context` (`ReviewContextPayload`) are the contract downstream skills consume; `context` reproduces them verbatim for the corresponding gates.
- Bundle producers can share the collapsed `gh` wrapper — no additional GitHub REST surface is required beyond what `CockpitGh` + the engine `GhWrapper` already cover.
- The artifact-paths bundle format for spec/plan/tasks-review gates is a small, new shape defined in this spec (previously implicit in the CLI's file-scanning code in `clarify-context.ts`).

## Out of Scope

- Changing the behavior, flags, output, or exit codes of `advance`, `merge`, `watch`, `status`, or `queue`.
- Adding new gates to the workflow-label vocabulary.
- Changing the JSON payload shapes of the clarification bundle or the PR bundle — the shapes are preserved so downstream skill consumers keep working.
- Any changes outside `packages/generacy/src/cli/commands/cockpit/**` and `packages/cockpit/src/gh/**`, except mechanical import-path updates in files that today reference the removed exports.
- Reintroducing `state`, `clarify-context`, or `review-context` as aliases for `context`. They are deleted (see FR-006).
- Same-repo `#N` shorthand support in the collapsed resolver — the current rejection stays (see FR-009).

---

*Generated by speckit*
