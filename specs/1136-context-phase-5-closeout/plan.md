# Implementation Plan: Phase-5 closeout — migration notes, per-repo config examples, rollout checklist + dogfood

**Feature**: Ship the operator-facing documentation, rollout runbook, and dogfood checklist that make the Phase 1–4 engine-native review/remediate flow reachable and provably exercised.
**Branch**: `1136-context-phase-5-closeout`
**Issue**: [generacy-ai/generacy#1136](https://github.com/generacy-ai/generacy/issues/1136) | **Epic**: [#1120](https://github.com/generacy-ai/generacy/issues/1120)
**Status**: Complete

## Summary

Phases 1–4 shipped the engine machinery for `implement → review ⇄ remediate → validate → [final human gate] → merge`: the `review`/`remediate` phases, the findings-artifact sidecar, the draft/ready PR lifecycle, the CI-aware merge gate, and per-workflow config. None of it is reachable by an operator until (a) operators can read how to migrate a repo onto it, (b) the packages are actually rolled out to running clusters, and (c) the loop is proven end-to-end. This issue delivers exactly those three things — as **documentation and an operational runbook**, not runtime code.

This is a **docs + operational** issue. It ships Markdown pages in the existing Docusaurus site, wires them into `docs/sidebars.ts`, ships an in-repo dogfood runbook, and corrects any prose that disagrees with shipped code. It adds **no** code under `packages/*/src/`. Where prose and code disagree, the shipped code is authoritative (FR-008).

All five clarifications are load-bearing:
- **Q1→C** — ship P1 docs + rollout checklist now AND an unchecked in-repo dogfood runbook the operator ticks off and links to #1120 later. The PR does **not** block on the live run (an automated worker cannot restart clusters or drive live stories).
- **Q2→A** — one migration guide page under `docs/docs/guides/generacy/` (migration + gate semantics + flags), a separate contracts reference page under `docs/docs/reference/`, and the rollout checklist as its own docs page. Extend `bugfix-profile-config.md` by link, not duplication.
- **Q3→A** — the rollout/dogfood checklist is repo-agnostic with a clearly-marked canary placeholder; no canary repo is hard-coded.
- **Q4→C** — contracts documented hybrid: inline summary of the sidecar/marker shapes PLUS a link to the canonical shipped files as source of truth. Contract-name key = marker strings `generacy-engine-review` (body) / `generacy-finding:` (inline).
- **Q5→A** — wire all new pages (and the orphaned `bugfix-profile-config.md`) into `docs/sidebars.ts`; a clean Docusaurus build (`onBrokenLinks:'throw'`) is the acceptance gate.

## Technical Context

- **Stack**: Docusaurus site under `docs/` (not in `pnpm-workspace.yaml`; not part of the package build). Content is Markdown/MDX; navigation is the manually-curated `docs/sidebars.ts`. Config `docusaurus.config.ts` sets `onBrokenLinks: 'throw'`, so a dangling internal link fails the build.
- **No new runtime behavior.** Every fact the docs state is grounded in shipped Phase 1–4 code on this branch (verified: `packages/orchestrator/src/worker/review-artifact.ts`, `review-poster.ts`, `review-executor.ts`, `review-charter.ts`, `remediate-*`, the CI merge gate, and `docs/docs/reference/bugfix-profile-config.md`).
- **Grounding sources**: `docs/engine-review-remediate-plan.md` (generacy-ai/tetrad-development), the shipped code named above, and the Phase 1–4 specs under `specs/112x`/`specs/1133`.
- **No `.specify/memory/constitution.md`** in the repo → constitution check skipped.
- **Changeset**: none required. The diff touches only `docs/` and `specs/` — no non-test file under `packages/*/src/` — so the changeset gate does not apply.

## Constitution Check

No constitution file present (`.specify/memory/constitution.md` absent). Skipped per plan convention.

## Project Structure

### New files (documentation)

```
docs/docs/guides/generacy/review-remediate-migration.md
    FR-001 + FR-002 + FR-005. Per-repo migration guide (one page):
      - Adding `ready_for_review` to ci.yml pull_request types; the skipped-CI-reads-as-SUCCESS footgun.
      - Slimming validateCommand to fast checks (single-package + root-config-diff guardrails).
      - Copy-pasteable per-workflow config for speckit-feature AND speckit-bugfix under orchestrator.workflows.*.
      - Feature flags WORKER_REVIEW_PHASE_ENABLED / WORKER_CI_MERGE_GATE_ENABLED and their default-OFF posture.
      - Gate semantics: remediation-limit (+ completed:remediation-limit resume, counter reset; contrasted with
        the retired blocked:stuck-feedback-loop dead-end), relocated post-validate implementation-review, waiting-for:ci.
      - Links to bugfix-profile-config.md rather than duplicating it.

docs/docs/reference/review-artifacts.md
    FR-003. Contracts reference (hybrid). Inline summary of:
      - Findings-artifact sidecar (ReviewArtifactSchema): path .generacy/review-findings-<sanitized-workflowId>.json,
        severity critical|major|minor, status open|resolved, verdict clean|changes-required, round, remediationCount.
        Marked engine-internal — GitHub review state is never source of truth.
      - Engine-authored review marker: body <!-- generacy-engine-review round=<N> -->, inline <!-- generacy-finding:<marker> -->.
        Contract-name key for the generacy-cloud mirror = generacy-engine-review / generacy-finding:.
    Plus links to the canonical shipped files (review-artifact.ts #1124, review-poster.ts #1125) as source of truth.

docs/docs/guides/generacy/review-remediate-rollout.md
    FR-004 + FR-005. Rollout checklist (its own page, repo-agnostic):
      - Ordering: publish @channel packages → restart cluster → restart workers → fresh Claude session.
      - Explicit "generacy update is NOT sufficient".
      - Canary story on a <CANARY-REPO placeholder>.
      - Rollback via the two feature flags to the pre-epic flow.

docs/docs/guides/generacy/review-remediate-dogfood.md
    FR-006 + FR-007. Unchecked in-repo dogfood runbook (checkbox list):
      - Drive one feature story through implement → review ⇄ remediate → validate → final gate → merge.
      - Drive one bugfix through the same loop under the bugfix profile.
      - Record findings and link results back to epic #1120.
      - Repo-agnostic <CANARY-REPO placeholder>; live run is an operator step performed after this PR merges.
```

### Modified files

```
docs/sidebars.ts
    FR-009 + Q5→A. Wire the four new pages into docsSidebar AND retroactively wire the orphaned
    reference/bugfix-profile-config.md.
      - Guides > Generacy: add review-remediate-migration, review-remediate-rollout, review-remediate-dogfood.
      - Reference: add a top-level 'reference/bugfix-profile-config' entry and 'reference/review-artifacts'.

(FR-008) Any existing docs page whose prose contradicts shipped Phase 1–4 behavior — corrected in place.
    Expected scope: none-to-minimal; audited during implement. bugfix-profile-config.md already matches code.
```

### Planning artifacts (this command)

```
specs/1136-context-phase-5-closeout/plan.md          — this file
specs/1136-context-phase-5-closeout/research.md      — doc-layout + rollout-mechanics decisions
specs/1136-context-phase-5-closeout/data-model.md    — doc-page inventory + FR/US coverage map
specs/1136-context-phase-5-closeout/contracts/       — the doc-contracts being published
specs/1136-context-phase-5-closeout/quickstart.md    — how to build/preview docs + verify the gate
```

### Contracts

```
specs/1136-context-phase-5-closeout/contracts/doc-pages.md         — page inventory, paths, sidebar wiring contract, FR mapping
specs/1136-context-phase-5-closeout/contracts/findings-artifact.md — sidecar shape mirrored from ReviewArtifactSchema (#1124)
specs/1136-context-phase-5-closeout/contracts/review-marker.md     — engine review marker strings (#1125) + generacy-cloud key
```

## Key Technical Decisions

1. **Docs-only, code-authoritative (FR-008).** No `packages/*/src/` change → no changeset. Every documented shape/flag/label is copied from shipped code, and the implement phase re-reads the canonical files before writing prose. Inline-only would drift (rejected A); link-only fails US3 readability (rejected B) → hybrid (Q4→C).

2. **Page layout (Q2→A).** One consolidated migration+gates+flags guide (US1 + US2 are coupled operator concerns → one narrative), a separate integrator contracts reference page (US3), and a standalone rollout checklist page. `bugfix-profile-config.md` is referenced by link, never duplicated.

3. **The Docusaurus build is the acceptance gate (Q5→A).** There is no per-PR docs CI job and `docs/` is outside the pnpm workspace, but `onBrokenLinks:'throw'` means a clean `npm run build` in `docs/` proves every internal link resolves and every new page is reachable. Wiring the orphaned `bugfix-profile-config.md` into the sidebar closes the exact defect (orphaned page) the epic's docs premise exists to prevent.

4. **Repo-agnostic checklist (Q3→A).** Canary identity is a runtime operator decision; the checklist ships a clearly-marked `<CANARY-REPO>` placeholder. Hard-coding a repo the spec never names has no grounded basis.

5. **Dogfood runbook shipped, live run deferred (Q1→C).** An automated speckit worker structurally cannot restart clusters or drive live stories, so the live dogfood is a post-merge operator step. The mergeable deliverable is the unchecked runbook artifact + the P1 docs; FR-006/FR-007 are satisfied by the committed runbook, with the live evidence recorded against #1120 by the operator.

## Testing Strategy

No automated tests (Out of Scope — no code under `packages/*/src/`). Acceptance is verified by:
- **Docusaurus build** — `cd docs && npm ci && npm run build` completes clean with `onBrokenLinks:'throw'` (SC-007).
- **Sidebar review** — all four new pages plus `bugfix-profile-config.md` reachable from the rendered sidebar (SC-007).
- **Content review against acceptance criteria** — migration topics (SC-001), gates + contracts (SC-002), rollout + dogfood runbook completeness (SC-003/SC-004/SC-005).
- **Grounding audit** — every documented flag/label/shape re-checked against the shipped file it cites (FR-008).

## Next Step

`/speckit:tasks` to generate the task list.
