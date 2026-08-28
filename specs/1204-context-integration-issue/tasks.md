# Tasks: P3 Integration — Gateway-Enabled Local & Cloud Clusters Run the Mixed-Route Dogfood

**Input**: Design documents from `/specs/1204-context-integration-issue/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/route-discrimination-criteria.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Scope note

This is a **validation and reconciliation** issue (Clarification Q1). The implement phase
produces **documents**, not services: a `runbook.md` the operator executes, a `results.md`
template the operator fills in, and an optional stanza-diff helper. The in-repo worker
**cannot** perform the cluster runs (published-package scaffold, staging VM, sibling
docker-compose). Every task below authors an artifact or a conditional scaffolder fix —
**no task executes a cluster run**. Authoring is not blocked by the upstream contracts;
only *executing* the runbook is (see Phase 1).

## Phase 1: Setup — prerequisite gate status

- [X] T001 Record the current state of the four upstream contracts (generacy-ai/generacy#1202,
  generacy-ai/cluster-base#90, generacy-ai/generacy-cloud#919, generacy-ai/agency#510) via
  `gh issue view` / `gh pr view`, noting merged-and-published status (npm version, image
  tag, deploy ref). This is the source data for the runbook's step-0 hard gate; per plan.md
  all three run-blocking contracts were OPEN as of 2026-08-28. Authoring proceeds regardless;
  this task only captures the snapshot, it does not wait on the gate.

## Phase 2: Runbook authoring (single file — sequential; US1–US4 + closeout)

`runbook.md` is one ordered file, so these tasks are sequential (no `[P]`). Each step
declares preconditions, commands, expected outcome, evidence to capture, and the
abort/file path on failure (data-model.md § Runbook).

- [X] T002 Create `specs/1204-context-integration-issue/runbook.md` with step 0: the
  prerequisite hard gate (verify #1202 / #90 / #919 merged and published; record versions
  used). No run step may appear before this gate passes.
- [X] T003 [US1] Add runbook step 1 (local leg): scaffold with `generacy launch --llm-gateway`
  using published packages + cluster-base image (not tetrad dev), provider key +
  `GENERACY_LLM_GATEWAY_TOKEN` (`sk-bf-` prefix) into `.env.local`, create a fresh disposable
  speckit-bugfix dogfood issue per the #1203 template, commit + push the mixed-route
  `orchestrator.agents` block on the **target repo's** working branch, drive to terminal
  state. Gateway model must contain `/` and have `context_length` ≥128k (32k models pass
  smoke tests then fail on real files — Q2). (FR-001)
- [X] T004 [US1] Add runbook step 2 (local evidence): collect worker logs + Bifrost access
  log (7-day retention — capture promptly) and evaluate against
  `contracts/route-discrimination-criteria.md` C1–C3; attribute any divergence. (FR-002)
- [X] T005 [US2] Add runbook step 3 (cloud leg): staging deploy with `llmGatewayEnabled=true`,
  `.env.local` provider key on the VM, second fresh disposable issue, same recipe → terminal
  state. (FR-003)
- [X] T006 [US2] Add runbook step 4 (cloud evidence + filing): same C1–C3 criteria; file any
  divergence from local/dev behaviour against generacy-ai/generacy-cloud. (FR-004)
- [X] T007 [US3] Add runbook step 5 (four-way stanza diff): run the diff helper across the
  four sources (scaffolder output, tetrad dev compose = canon, cluster-base compose,
  cloud-deploy template) and classify every hunk `intentional | fixed-here | filed`. Canon:
  `tetrad-development/.devcontainer/generacy/docker-compose.yml:180-218`. (FR-005)
- [X] T008 [US4] Add runbook step 6 (cockpit auto observation — validation-only per Q4):
  configure a mixed `cockpit.auto.agents` block, record observed dispatch behaviour of
  today's `auto.md` playbook (expected: passes configured models straight to Agent spawns,
  no route awareness), and append repro to generacy-ai/agency#510 (or file fresh if the
  failure differs). No cockpit code changes in this branch. (FR-006)
- [X] T009 Add runbook step 7 (closeout): flip
  `tetrad-development/docs/llm-gateway-model-routing-plan.md` status to "P3 complete" with
  findings (cross-repo edit, scripted as an operator step), then finalize `results.md`. (FR-007)

## Phase 3: Results template + diff helper (different files — parallelizable)

- [X] T010 [P] [US3] Create `specs/1204-context-integration-issue/results.md` as a template
  with empty result fields (data-model.md § ResultsReport): `prerequisiteVersions`,
  `runs: ClusterRunResult[2]` (local, cloud), `stanzaDiff: DiffReport`,
  `cockpitAutoObservation`, `filedIssues: IssueRef[]`. Embed the CriteriaResult (C1–C3) and
  DiffReport tables, the `completed:validate` target (SC-001/SC-002), and the #1203
  qualitative reference (10 requests, 5.3–11.5s, 0 errors). Mark incompleteness rules from
  data-model.md § Validation rules.
- [X] T011 [P] [US3] Create `specs/1204-context-integration-issue/scripts/diff-gateway-stanza.sh`:
  a small POSIX-shell helper that extracts the `llm-gateway` compose stanza from the four
  sources and diffs each against the canon (tetrad dev compose). Encode the canonical traits
  from research.md D3 as the reference (Bifrost `v2.0.0` pin, `sk-bf-` token, named
  `llm-gateway-data:/app/data` volume, no `source_of_truth`, `list_models: false`, tracked
  token-free `config.json` mounted `:ro`, optional `.env.local` env_file, wget healthcheck
  `start_period: 45s`, cluster-network-only no host port). Trivial helper only — no throwaway
  orchestration machinery (Q1).

## Phase 4: Conditional scaffolder fix (only if a divergence traces to this repo)

<!-- Phase boundary: only entered if T007's diff finds a scaffolder divergence attributable to this repo -->

- [X] T012 [US3] **Conditional** — if and only if the four-way diff (T007, executed by the
  operator, or a pre-known gap) traces a divergence to this repo's scaffolder, fix
  `packages/generacy/src/cli/commands/cluster/scaffolder.ts` so its emitted `llm-gateway`
  stanza converges to canon, and add `.changeset/<slug>.md` (`patch` — defect fix; the gate
  requires a **newly added** changeset file because this touches `packages/*/src/`). If no
  scaffolder divergence is found, skip this task and record "no in-repo divergence" in
  `results.md`.

## Phase 5: Verification

- [X] T013 Verify the artifact set is internally consistent: `runbook.md` step order matches
  data-model.md § Runbook, every FR (001–007) is covered by a runbook step, `results.md`
  fields match the runbook's "evidence to capture" lines, and the diff helper's canon traits
  match research.md D3. Confirm no `packages/*/src/` file changed (doc-only) → **no changeset
  required**; if T012 fired, confirm the changeset was added. `sh -n` the diff helper for
  syntax.

## Dependencies & Execution Order

**Sequential spine**:
- T001 (gate snapshot) → T002 (runbook step 0) → T003…T009 (runbook steps 1–7, same file,
  in order) → T013 (verification).

**Parallel opportunities**:
- T010 and T011 are independent files (`results.md`, `scripts/diff-gateway-stanza.sh`) and
  can run in parallel with each other and alongside the runbook authoring (T002–T009), since
  they touch neither `runbook.md` nor each other.

**Conditional**:
- T012 (scaffolder fix + changeset) is entered **only** if a divergence traces to this repo;
  otherwise skipped with a recorded note. It is not on the authoring critical path — the
  divergence is discovered during operator execution of T007, not during authoring.

**Not scheduled (by design, Q1)**: no task executes a cluster scaffold, cloud deploy, dogfood
run, or `cockpit auto` invocation — those are operator actions driven by the runbook, gated on
the Phase 1 prerequisites being merged and published.

## Playbook coupling

Not applicable. No `packages/claude-plugin-cockpit/commands/*.md` path is named in spec.md or
plan.md (the `auto.md` reference is validation-only and lives in the **agency** repo per
research.md D4), and the `claude-plugin-cockpit` package — including
`playbook-verification.test.ts` — does not exist in this repo. No re-pin task is emitted.
