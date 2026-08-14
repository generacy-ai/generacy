# Tasks: Remove the hardcoded `develop` workspace branch — no-preference branch resolution

**Input**: Design documents from `/specs/1088-converttemplateconfig/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/branch-resolution.md, quickstart.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Phase 1: `packages/config` — branch becomes a genuine no-opinion field

- [X] T001 [P] [US1] Drop the Zod default on `WorkspaceConfigSchema.branch` in `packages/config/src/workspace-schema.ts:12`: `z.string().min(1).default('develop')` → `z.string().min(1).optional()` (FR-001a). Inferred type becomes `branch?: string | undefined`; empty string must still be rejected via `.min(1)`.
- [X] T002 [P] [US2] Add optional top-level `branch: z.string().min(1).optional()` to `TemplateConfigSchema` in `packages/config/src/template-schema.ts` (FR-002, Q3=A — mirrors the workspace-format top-level key).
- [X] T003 [US1] Rewrite `convertTemplateConfig` in `packages/config/src/convert-template.ts:26` to pass through `template.branch` (may be `undefined`): `return { org: primary.owner, branch: template.branch, repos }`. Zero `'develop'` literals remain in this file (FR-001, SC-004). Depends on T001+T002 (type + source field).
- [X] T004 [US1] Update `packages/config/src/__tests__/workspace-schema.test.ts:49-54`: replace "defaults to develop" assertion with "undefined when omitted"; keep empty-string rejection test green.
- [X] T005 [P] [US2] Extend `packages/config/src/__tests__/template-schema.test.ts` with branch-field cases: valid non-empty string accepted, empty string rejected, absent → `undefined`.
- [X] T006 [P] [US1] Rewrite `packages/config/src/__tests__/convert-template.test.ts:150` ("always sets branch to develop"): assert branch is unset when the template declares none, and passed through verbatim when declared (SC-002 config half).
- [X] T007 [P] [US1] Audit `packages/config/src/__tests__/loader.test.ts`: fixtures use explicit `branch: develop` YAML and are expected to pass unchanged — verify, fix only if broken.

## Phase 2: `workspace.ts` — resolution chain + no-preference update/clone

- [X] T008 [US3] In `packages/generacy/src/cli/commands/setup/workspace.ts`: widen the local `WorkspaceConfig` interface (`branch: string | undefined`), add `branchSource: 'CLI flag' | 'REPO_BRANCH env' | 'DEFAULT_BRANCH env' | 'config file' | 'none'`, and replace the resolution at `:107-112` with the no-terminal-literal chain `cliArgs.branch ?? REPO_BRANCH ?? DEFAULT_BRANCH ?? configBranch` plus `branchSource` derivation (FR-005, FR-007). The final `?? 'develop'` at `:111` is deleted.
- [X] T009 [US1] Implement Mode B (no preference) in `cloneOrUpdateRepo` per `contracts/branch-resolution.md` §2 (FR-003, FR-004, Q5=A):
  - Existing checkout on branch `<b>` with `refs/remotes/origin/<b>` present after `git fetch origin` → `git pull origin <b>`; never `git checkout`.
  - Detached HEAD (`git branch --show-current` empty) → fetch only, one `logger.warn`, return success.
  - Branch with no `refs/remotes/origin/<b>` (probe `git rev-parse --verify --quiet refs/remotes/origin/<b>` — local refs only, no network/API per Q2=A) → fetch only, one `logger.warn`, return success.
  - New repo → plain `git clone` directly, no `--branch` attempt.
  - Mode A (explicit branch) stays byte-identical (US3); `--clean` semantics unchanged; pull remains best-effort.
- [X] T010 [US1] FR-006 logging in `workspace.ts`: "Configuration" line (`:297`) gains `branchSource` and renders `branch: '(repo default / current branch)'` in the no-preference case; "Cloning repository" line (`:221`) renders `branch: '(repo default)'` when unset; "Switching branch" line is never emitted in Mode B. Depends on T008.

## Phase 3: `packages/generacy` tests

- [X] T011 [US1] Extend `packages/generacy/src/cli/commands/setup/__tests__/workspace.test.ts` (execSafe-mock suite) with Mode B cases: config without `branch` → zero `git checkout` invocations, pull targets the current branch, clone commands contain no `--branch` (SC-001 unit-level, SC-004); detached HEAD and missing `origin/<b>` → no pull, one `warn`, repo counted successful (Q5=A); FR-006 log line carries `branchSource` + placeholder value.
- [X] T012 [US3] Add explicit precedence coverage in the same suite: `--branch` flag > `REPO_BRANCH` > `DEFAULT_BRANCH` > config, including the currently-untested `DEFAULT_BRANCH` tier (SC-003). Explicit-source clone/switch behavior asserted unchanged.
- [X] T013 [P] [US1] NEW `packages/generacy/src/cli/commands/setup/__tests__/workspace.integration.test.ts` — real-git finetooth regression (SC-001): bare fixture repo with default branch `main` containing a template-format `.generacy/config.yaml` with no branch key; clone into `<tmp>/workspaces/<repo>`; run `setup workspace --workdir <tmp>/workspaces --config <checkout>/.generacy/config.yaml` **twice**. Assert: repo still on `main`, no "Switching branch" log, `.generacy/config.yaml` present, second run exits 0. Isolate git globals by pointing `HOME`/`GIT_CONFIG_GLOBAL` at the temp dir. Only the update path is integration-tested (clone URLs are hardcoded to github.com).
- [X] T014 [P] [US1] Audit the second execSync-mock suite `packages/generacy/src/__tests__/setup/workspace.test.ts` for `'develop'` assertions and update to the new contract.
- [X] T015 [P] [US1] Update `packages/generacy/src/config/__tests__/schema.test.ts:630,:665`: assertions of `workspace?.branch === 'develop'` on fixtures that omit `branch` become `toBeUndefined()`.

## Phase 4: Verification & release

- [X] T016 [US1] SC-004 grep gate: `grep -rn "'develop'"` over `packages/config/src/convert-template.ts` and `packages/config/src/workspace-schema.ts` → 0 occurrences; no `?? 'develop'` in the `workspace.ts` branch resolution chain.
- [X] T017 Write NEW changeset `.changeset/1088-branch-no-preference.md`: `@generacy-ai/config` **minor** (new public template `branch:` key + `WorkspaceConfig.branch` widened to optional) + `@generacy-ai/generacy` **patch** (defect fix, no new exports). Single file, both bumps — required by the CI changeset gate (must be a newly added file in the PR diff).
- [X] T018 Full verification: `pnpm build` + run the touched test suites in `packages/config` and `packages/generacy`; confirm consumer-audit non-changes (`packages/config/src/repos.ts`, orchestrator, cockpit loader untouched).

## Dependencies & Execution Order

**Phase boundaries** (sequential): Phase 1 → Phase 2 → Phase 3 → Phase 4. Phase 2's type change (`branch: string | undefined`) depends on Phase 1's schema widening; Phase 3 tests assert against Phase 2 behavior; Phase 4 verifies the whole.

**Within Phase 1**: T001 ∥ T002 (different files); T003 after both. T004–T007 can run in parallel after T003.

**Within Phase 2**: T008 → T009 → T010 (same file, sequential).

**Within Phase 3**: T011 → T012 (same file); T013, T14, T015 parallel with each other and with T011/T012 (different files).

**Playbook coupling check**: no `packages/claude-plugin-cockpit/commands/*.md` files are named in spec.md, plan.md, or the issue — no playbook re-pin task required.

---

*Generated by speckit*
