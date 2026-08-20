# Feature Specification: Phase-5 closeout — migration notes, per-repo config examples, rollout checklist + dogfood

**Branch**: `1136-context-phase-5-closeout` | **Date**: 2026-08-20 | **Status**: Draft

## Summary

Final phase of the engine-native review & remediate epic (generacy-ai/generacy#1120). The
engine-side machinery shipped across Phases 1–4 (`review`/`remediate` phases, findings artifact,
draft/ready lifecycle, CI-aware merge gate, bugfix profiles, per-workflow config). Nothing in
that machinery is *reachable by an operator* until: (a) operators understand how to migrate their
repos to it, (b) the new packages are actually rolled out to running clusters, and (c) the flow
has been proven end-to-end on real work. This issue delivers the documentation, the rollout
runbook, and a dogfood pass that validates the whole loop.

This is a **documentation + operational** issue, not a code feature. It ships Markdown docs, a
rollout checklist, and a recorded dogfood result linked back to the epic. No new runtime behavior
is introduced; where prose and code disagree, the shipped code is authoritative and the docs are
corrected to match.

## Context

Phase-5 closeout: documentation, migration, and a real dogfood pass. Rollout mechanics matter:
clusters pick up new npm packages via **restart** (the entrypoint re-pulls `@channel` packages on
boot) — `generacy update` alone is NOT sufficient. Workers must restart too, and newly rolled-out
packages require a **fresh Claude session** to take effect.

Grounding facts the docs must reflect (from `docs/engine-review-remediate-plan.md` in
generacy-ai/tetrad-development and the shipped Phase 1–4 code):

- New flow: `… implement → review ⇄ remediate → validate → [final human gate] → merge`.
- `review`/`remediate` gated behind `reviewPhaseEnabled` (env `WORKER_REVIEW_PHASE_ENABLED`,
  default OFF) and CI merge gate behind `ciMergeGateEnabled` (env `WORKER_CI_MERGE_GATE_ENABLED`,
  default OFF).
- Per-workflow overrides live under `orchestrator.workflows.<name>` in `.generacy/config.yaml`
  (`maxRemediations`, `review.profile`, `review.blockingSeverity`, `validateCommand`,
  `ciWaitTimeoutMs`, opt-in `failThenPass`).
- Gates: `waiting-for:remediation-limit` (+ `completed:remediation-limit` to resume, resets the
  counter), `waiting-for:ci`, and the relocated post-validate `implementation-review` final
  approval gate.
- CI: target repos need `ready_for_review` in their `ci.yml` `pull_request` types; the merge gate
  treats `skipped` ≠ `passed`; repos whose CI owns the full suite should slim `validateCommand` to
  fast checks (lint/format/typecheck/build).
- Contracts to document: the findings-artifact sidecar shape and the engine-authored review marker
  (so operators and downstream tooling recognize engine-posted `COMMENT`-event reviews).

## User Stories

### US1: Repo owner migrates a repo onto the new flow (P1)

**As a** repo owner adopting engine-native review/remediate,
**I want** a per-repo migration guide,
**So that** I can enable the new flow correctly without stranding my workers or silently
merging PRs whose CI never ran.

**Acceptance Criteria**:
- [ ] Guide covers adding `ready_for_review` to `ci.yml` `pull_request` types and explains the
      skipped-CI-reads-as-SUCCESS footgun the merge gate closes.
- [ ] Guide shows how to slim `validateCommand` to fast checks for repos whose CI owns the suite,
      including the single-package and root-config-diff guardrails.
- [ ] Guide gives copy-pasteable per-workflow config examples for both `speckit-feature` and
      `speckit-bugfix` under `orchestrator.workflows.*`.
- [ ] Guide documents the feature flags (`WORKER_REVIEW_PHASE_ENABLED`,
      `WORKER_CI_MERGE_GATE_ENABLED`) and their default-OFF state.

### US2: Operator understands the new gate semantics (P1)

**As a** cockpit/auto operator,
**I want** documented gate semantics for the new and relocated gates,
**So that** I know how to resume a paused run and what each gate means.

**Acceptance Criteria**:
- [ ] `remediation-limit` gate documented: when it fires (counter at cap), what to inspect
      (surfaced remaining findings), how to resume (`completed:remediation-limit`), and that
      resuming resets the counter. Contrasted with the retired `blocked:stuck-feedback-loop`
      dead-end.
- [ ] Relocated post-validate `implementation-review` gate documented as the final human approval
      before merge (moved from post-implement).
- [ ] `waiting-for:ci` pause documented (bounded CI wait → timeout → resumable pause).

### US3: Integrator understands the engine's review artifacts (P2)

**As a** downstream tool author or reviewer,
**I want** the findings-artifact and engine-authored-marker contracts documented,
**So that** I can consume engine review output and not race the engine's own loop.

**Acceptance Criteria**:
- [ ] Findings-artifact sidecar shape documented (severity `critical|major|minor`, file/line,
      round, verdict `clean|changes-required`) and marked engine-internal (GitHub review state is
      never source of truth).
- [ ] Engine-authored review marker documented (the marker string engine reviews carry so the
      PR-feedback monitor excludes them), keyed by contract name for the generacy-cloud mirror.

### US4: Platform operator rolls the new packages out to a cluster (P1)

**As a** platform operator,
**I want** a rollout checklist,
**So that** clusters actually pick up the new packages and I can roll back if the canary fails.

**Acceptance Criteria**:
- [ ] Checklist ordering: publish `@channel` packages → restart cluster → restart workers →
      start a fresh Claude session. Explicitly states `generacy update` is insufficient.
- [ ] Canary story: drive one story through the full loop on a designated test repo before
      general enablement.
- [ ] Rollback note: how to disable via the feature flags and revert to the pre-epic flow.

### US5: Maintainer dogfoods the flow end-to-end (P1)

**As an** epic owner,
**I want** one real feature story and one real bugfix run through the new flow end to end,
**So that** the epic can close with evidence the flow works, not just that it compiles.

**Acceptance Criteria**:
- [ ] One feature story completes `implement → review ⇄ remediate → validate → final gate → merge`.
- [ ] One bugfix completes the same loop under the bugfix profile.
- [ ] Findings recorded and linked back to epic generacy-ai/generacy#1120.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Publish a per-repo migration guide (Markdown, in the docs site) covering `ready_for_review` CI trigger, `validateCommand` slimming, and per-workflow config examples for feature + bugfix. | P1 | Consolidates/links the existing `docs/docs/reference/bugfix-profile-config.md` shipped in Phase 4. |
| FR-002 | Document gate semantics for `remediation-limit`, the relocated post-validate `implementation-review`, and `waiting-for:ci`. | P1 | Include resume labels and counter-reset behavior. |
| FR-003 | Document the findings-artifact sidecar contract and the engine-authored review marker contract. | P2 | Keyed by contract name; note engine-internal verdict authority. |
| FR-004 | Publish a rollout checklist: publish → cluster restart → worker restart → fresh session, plus canary story and rollback note. | P1 | Must state `generacy update` is insufficient. |
| FR-005 | Document the feature flags gating the new flow (`WORKER_REVIEW_PHASE_ENABLED`, `WORKER_CI_MERGE_GATE_ENABLED`) and their default-OFF posture. | P1 | Rollback lever for US4. |
| FR-006 | Execute the rollout checklist on a canary test repo and drive one feature + one bugfix story end to end. | P1 | Dogfood; the acceptance evidence. |
| FR-007 | Record dogfood findings and link results back to epic generacy-ai/generacy#1120. | P1 | Closes the epic. |
| FR-008 | Where documentation and shipped code disagree, correct the docs to match the code. | P2 | Docs describe reality, not the plan sketch. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | Migration guide completeness | All four migration topics present (CI trigger, validateCommand slimming, per-workflow examples, flags) | Guide review against US1 acceptance |
| SC-002 | Gate + contract docs completeness | All three gates and both contracts documented | Doc review against US2/US3 acceptance |
| SC-003 | Rollout checklist executable | Checklist followed on a canary with no undocumented manual step required | Canary run log |
| SC-004 | Dogfood feature story | 1 feature story merges through the full loop | PR link + epic comment |
| SC-005 | Dogfood bugfix story | 1 bugfix merges through the full loop under bugfix profile | PR link + epic comment |
| SC-006 | Epic linkage | Dogfood results and doc PR linked in epic #1120 | Epic comment |

## Assumptions

- Phases 1–4 (issues #1121–#1135) are merged to `develop` and the packages are publishable; this
  issue documents and exercises shipped behavior rather than defining new behavior.
- Docs live in the existing Docusaurus site under `docs/docs/` (e.g. `guides/generacy/` for the
  migration guide, `reference/config/` for config examples), extending the Phase-4
  `bugfix-profile-config.md` reference rather than duplicating it.
- A designated canary/test repo is available for the dogfood run with the operator holding
  `Workflows: write` to add the `ready_for_review` CI trigger.
- The dogfood is performed against a channel that already carries the Phase 1–4 packages.

## Out of Scope

- Any new runtime behavior in `review`/`remediate`/validate/CI machinery (owned by Phases 1–4).
- cockpit:auto slimming in the `agency` repo (sibling Phase-5 work item, separate repo/issue).
- YAML workflow-engine executor feature parity and `speckit-epic` workflow changes (epic-wide out
  of scope).
- Automated tests — this issue ships docs, a checklist, and a recorded manual dogfood; it does not
  add code under `packages/*/src/`.

---

*Generated by speckit*
