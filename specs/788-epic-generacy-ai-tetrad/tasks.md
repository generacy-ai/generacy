# Tasks: `generacy cockpit` — `state`, `advance`, `clarify-context`

**Input**: Design documents from `/specs/788-epic-generacy-ai-tetrad/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/
**Status**: Complete
**Mode**: Epic (coarse-grained task groups)

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Task group can run in parallel with other `[P]` groups in the same phase
- **[Story]**: Which user story this task group addresses

## Phase 1: Foundation

### TG-001 [P] Task Group: Scaffold `cockpit` command group and wire into CLI
**Scope**: 2–3 hours
**Files**:
- `packages/generacy/src/cli/commands/cockpit/index.ts` (new)
- `packages/generacy/src/cli/index.ts` (modify)
- `packages/generacy/package.json` (modify — confirm/add workspace deps)
**Tests**:
- `packages/generacy/src/cli/commands/cockpit/__tests__/index.test.ts` (new — `cockpit --help` lists three subcommands; each stub prints usage)
- Manual: `pnpm --filter @generacy-ai/generacy build && node packages/generacy/bin/generacy.js cockpit --help`

- [ ] Create `cockpit/index.ts` exporting `cockpitCommand()` (Commander `Command` builder) with description "Cockpit — inspect and drive workflow state for one issue."
- [ ] Register three subcommand stubs (`state`, `advance`, `clarify-context`) that print usage and exit 0 — bodies will be replaced in Phase 2.
- [ ] Import `cockpitCommand` in `packages/generacy/src/cli/index.ts` and call `program.addCommand(cockpitCommand())` adjacent to the existing command registrations.
- [ ] Confirm `@generacy-ai/cockpit` and `@generacy-ai/workflow-engine` are listed as workspace deps in `packages/generacy/package.json`; add if missing (use `workspace:*` per repo convention).
- [ ] Add a small smoke test that builds the Commander tree and asserts `cockpit` has exactly three subcommands with the expected names.

---

### TG-002 [P] Task Group: Shared helpers — `issue-ref` and `gate-vocabulary`
**Scope**: 3–4 hours
**Files**:
- `packages/generacy/src/cli/commands/cockpit/issue-ref.ts` (new)
- `packages/generacy/src/cli/commands/cockpit/gate-vocabulary.ts` (new)
**Tests**:
- `packages/generacy/src/cli/commands/cockpit/__tests__/issue-ref.test.ts` (new)
- `packages/generacy/src/cli/commands/cockpit/__tests__/gate-vocabulary.test.ts` (new)

- [ ] Implement `parseIssueRef(input, config): IssueRef` accepting `<n>`, `<owner>/<repo>#<n>`, `https://github.com/owner/repo/issues/<n>`, and `https://github.com/owner/repo/pull/<n>`. Enforce AD-5: bare-number form requires `config.repos.length === 1`; otherwise throw a typed error whose message matches the contract in plan §AD-5.
- [ ] Apply data-model validation rules to `IssueRef`: non-empty `owner`/`repo`, no `/` or whitespace, positive integer `number`, derived `nwo`.
- [ ] Implement `gate-vocabulary.ts` that walks `WORKFLOW_LABELS` from `@generacy-ai/workflow-engine` once at module load, pairs each `waiting-for:<x>` with the matching `completed:<x>` (skipping unpaired ones), and exports a readonly `GATES: Map<string, GateDefinition>` plus `listGates(): string[]` for `--help-gates`.
- [ ] Verify pair derivation matches data-model §GateDefinition expected pairs (clarification, plan-review, tasks-review, etc.).
- [ ] Unit-test both helpers exhaustively — every parser branch, every refusal path, every paired/unpaired label combination.

---

## Phase 2: Verb Implementations
<!-- Phase boundary: Complete Phase 1 before starting Phase 2 (helpers must exist and pass tests) -->

### TG-003 [P] [US1] Task Group: `state` verb
**Scope**: 3–4 hours
**Files**:
- `packages/generacy/src/cli/commands/cockpit/state.ts` (new)
- `packages/generacy/src/cli/commands/cockpit/index.ts` (modify — replace stub)
- `specs/788-epic-generacy-ai-tetrad/contracts/state-output.schema.json` (consume — runtime conformance test)
**Tests**:
- `packages/generacy/src/cli/commands/cockpit/__tests__/state.test.ts` (new — uses injectable `CommandRunner` on `GhCliWrapper`)

- [ ] Implement `stateCommand()` registering arg `<issue>` and `--json` flag; default mode prints `<nwo>#<n>  <state>  <sourceLabel>` (two-space separated).
- [ ] Resolve flow: `loadCockpitConfig()` → `parseIssueRef()` → `gh.fetchIssueLabels()` via `GhCliWrapper` → `classify(labels)` from `@generacy-ai/cockpit` → format.
- [ ] `--json` emits a `ClassifyStateOutput` object matching `contracts/state-output.schema.json`; route stdout exclusively to the payload, stderr to `pino` logs.
- [ ] Cover all six curated tiers (`pending`/`active`/`waiting`/`error`/`terminal`/`unknown`) in integration tests using stub label sets (satisfies SC-003).
- [ ] Error path tests: 404 issue → exit 1 with named-step message; ambiguous bare ref → exit 2 with AD-5 message; gh auth failure → exit 1 referencing `gh issue view`.

---

### TG-004 [P] [US2] Task Group: `advance` verb and manual-advance marker
**Scope**: 4–5 hours
**Files**:
- `packages/generacy/src/cli/commands/cockpit/advance.ts` (new)
- `packages/generacy/src/cli/commands/cockpit/manual-advance-marker.ts` (new)
- `packages/generacy/src/cli/commands/cockpit/index.ts` (modify — replace stub)
**Tests**:
- `packages/generacy/src/cli/commands/cockpit/__tests__/advance.test.ts` (new)
- `packages/generacy/src/cli/commands/cockpit/__tests__/advance-marker.test.ts` (new)

- [ ] Implement `formatManualAdvanceComment({ gate, actor, ts })` per AD-1 / D-R5; enforce data-model validation regexes on `gate`, `actor`, `ts` before string interpolation so the marker cannot inject HTML/markdown.
- [ ] Implement `advanceCommand()` accepting `<issue>` arg, required `--gate <name>`, and `--help-gates`.
- [ ] Validate gate name against `GATES` (TG-002); unknown gate → exit 2 with the valid-gate list per contracts/cli-surface.md.
- [ ] Idempotency (AD-6): if `completed:<gate>` already present, print `already advanced …` to stdout and exit 0 without posting a comment or modifying labels.
- [ ] Refusal (AD-4): if active `waiting-for:*` ≠ requested gate, print refusal line and exit 3; do not post a comment or modify labels. No `--force` flag.
- [ ] Happy-path side-effect order: `gh issue comment` → `gh issue edit --add-label completed:<g>` → `gh issue edit --remove-label waiting-for:<g>`. Resolve `actor` via `gh api user`.
- [ ] Tests: happy path, already-advanced no-op, wrong-gate refusal (exit 3), unknown-gate (exit 2), `--help-gates` lists derived gates, marker regex validation (gate/actor/ts).
- [ ] Verify SC-005 with a `grep` assertion in tests: no hard-coded `completed:` string list in the source file (must come through `GATES`).

---

### TG-005 [P] [US3] Task Group: `clarify-context` verb + supporting helpers
**Scope**: 6–8 hours
**Files**:
- `packages/generacy/src/cli/commands/cockpit/clarify-context.ts` (new)
- `packages/generacy/src/cli/commands/cockpit/clarification-comment-finder.ts` (new)
- `packages/generacy/src/cli/commands/cockpit/code-references.ts` (new)
- `packages/generacy/src/cli/commands/cockpit/index.ts` (modify — replace stub)
- `specs/788-epic-generacy-ai-tetrad/contracts/clarify-context-output.schema.json` (consume — runtime conformance test)
**Tests**:
- `packages/generacy/src/cli/commands/cockpit/__tests__/clarify-context.test.ts` (new)
- `packages/generacy/src/cli/commands/cockpit/__tests__/clarification-comment-finder.test.ts` (new)
- `packages/generacy/src/cli/commands/cockpit/__tests__/code-references.test.ts` (new)

- [ ] Implement `findClarificationComment(gh, ref)` per AD-3 / D-R1: call `gh api repos/{o}/{r}/issues/{n}/timeline` to find the most-recent `labeled` event for `waiting-for:clarification`; then `gh issue view --json comments` and return the first comment with `created_at >= labelEventTs`; return `null` if no qualifying comment.
- [ ] Implement `gatherCodeReferences(branch, ref)` returning `{ touchedFiles, prUrl, prDiffSummary } | null`. Sources per data-model: `gh pr list --search head:<branch>` for `prUrl`; `gh pr diff --name-only` (or `git diff --name-only <base>...<head>` fallback) for `touchedFiles`; `gh pr diff --patch` truncated to 4 KiB (append `…[truncated]`) for `prDiffSummary`. Return `null` when not on a feature branch.
- [ ] Implement spec/plan reading per D-R4: derive branch via `git branch --show-current`; read `specs/<branch>/spec.md` and `specs/<branch>/plan.md`; fall back to scanning `specs/` for a dir starting with `<issueNumber>-`. Missing files → explicit `null` fields (stable schema, FR-009).
- [ ] Implement `clarifyContextCommand()`: refuse (exit 3) if issue is not in `waiting-for:clarification`; otherwise assemble `ClarifyContextOutput` and emit exactly one JSON document to stdout matching `clarify-context-output.schema.json`. Read-only (AD-7) — no comments posted, no labels modified.
- [ ] Output discipline: route all logs/errors to stderr via `pino`; assert in tests by piping captured stdout into `JSON.parse()` (satisfies SC-002).
- [ ] Tests: happy path (all four fields populated), waiting-for refusal (exit 3), missing spec → `spec: null`, missing PR → `codeReferences.prUrl: null`/`prDiffSummary: null` but `touchedFiles` from `git diff`, branch not in `specs/` layout → `spec` and `plan` both `null`, 4 KiB truncation, AD-3 timeline-event selection.

---

## Phase 3: Polish
<!-- Phase boundary: Complete Phase 2 before starting Phase 3 (live smoke test requires all three verbs wired) -->

### TG-006 Task Group: Error messages, help text, and live smoke test
**Scope**: 2–3 hours
**Files**:
- `packages/generacy/src/cli/commands/cockpit/state.ts` (touch — error-message polish)
- `packages/generacy/src/cli/commands/cockpit/advance.ts` (touch — error-message polish)
- `packages/generacy/src/cli/commands/cockpit/clarify-context.ts` (touch — error-message polish)
- `packages/generacy/src/cli/commands/cockpit/index.ts` (touch — `--help` text review)
- `specs/788-epic-generacy-ai-tetrad/quickstart.md` (update with executed smoke steps)
**Tests**:
- Existing `__tests__/` suites (no new files)
- Manual smoke test against a real `waiting-for:clarification` issue

- [ ] Audit every non-zero exit path across the three verbs against contracts/cli-surface.md §"Error Message Conventions": `Error: <verb-name>: <step that failed>: <reason>`. Adjust messages where they don't conform.
- [ ] Confirm `setupErrorHandlers()` from `cli/utils/error-handler.ts` is invoked for the cockpit command tree so unhandled exceptions get the `Error: ` prefix and `DEBUG=1` stack traces. Patch if missing.
- [ ] Polish `--help` and `--help-gates` outputs; verify each subcommand's `Usage` line matches the cli-surface contract.
- [ ] Execute the live smoke test from `quickstart.md` against a real test issue (state classification, manual advance, clarification context). Capture timing for SC-004 (`advance` < 3s).
- [ ] Update `quickstart.md` with the actual commands run, any discrepancies found, and pointers for re-running.
- [ ] Confirm SC-005 via repository grep: no `completed:` string literal exists in `packages/generacy/src/cli/commands/cockpit/` outside `gate-vocabulary.ts`.

---

## Dependencies & Execution Order

**Phase boundaries** (sequential):
- Phase 1 → Phase 2 → Phase 3 (must complete in order)

**Parallel opportunities within phases**:
- Phase 1: TG-001 and TG-002 can run in parallel — TG-001 touches the CLI entry point; TG-002 builds standalone pure-function helpers. They share no files.
- Phase 2: TG-003, TG-004, and TG-005 can all run in parallel. Each verb owns a distinct `*.ts` file. They all touch `cockpit/index.ts` only to swap a single stub registration line for the real `Command` — a small mechanical conflict that's trivial to merge.
- Phase 3: TG-006 is a single sequential polish pass that requires all three verbs already wired.

**Why the phase boundaries**:
- Phase 2 verbs depend on TG-002's `parseIssueRef` and `GATES`, and on TG-001's command registration scaffold.
- Phase 3's live smoke test exercises all three verbs end-to-end and so requires Phase 2 complete.
