# Clarifications: plan phase writes per-feature managed files (stop appending to shared CLAUDE.md)

**Feature Branch**: `899-found-during-cockpit-v1`
**Issue**: [generacy-ai/generacy#899](https://github.com/generacy-ai/generacy/issues/899)

## Batch 1 — 2026-07-10

### Q1: Managed file path
**Context**: FR-002 explicitly asks which of two paths the per-feature managed file should live at. This determines discoverability, the pointer wording in FR-003, the regression test in FR-007, and whether the file is grouped with spec artifacts or with speckit-managed state.
**Question**: Which path should the per-feature managed file use?
**Options**:
- A: `specs/<feature>/stack.md` — co-located with `spec.md`, `plan.md`, and other feature artifacts under `specs/<feature>/`
- B: `.specify/managed/<feature>.md` — grouped with other speckit-managed state under `.specify/`
- C: A different path (please specify)

**Answer**: *Pending*

---

### Q2: Migration policy for legacy `<!-- speckit:managed -->` sections
**Context**: FR-006 explicitly asks how in-flight branches with pre-existing legacy managed sections in `CLAUDE.md` are handled when they reach `/plan` after the change lands. This governs SC-005 (in-flight branches merge without new content conflicts) and whether the migration is one-shot or opportunistic.
**Question**: What is the migration policy for the legacy managed section in `CLAUDE.md` on in-flight branches?
**Options**:
- A: Leave-alone — `/plan` does not touch the legacy section; it will be cleaned up ambiently when branches merge, and no new managed content is appended
- B: Strip-on-next-plan — `/plan` deletes the legacy section as part of the phase (writes go only to the per-feature file, but the legacy CLAUDE.md region is removed)
- C: One-time migration commit — a separate migration commit on `develop`/base strips the legacy section repo-wide; `/plan` never adds or removes it after that

**Answer**: *Pending*

---

### Q3: Scope of the fix in this repo vs upstream speckit
**Context**: Assumption 2 states that `/plan` is implemented by an upstream speckit skill, not by code in this repo. But the issue and this feature branch live in `generacy-ai/generacy`, and FR-001/FR-002/FR-004 describe behavior changes to `/plan` itself. This determines what artifacts the implementation PR actually ships (and what's blocked on upstream).
**Question**: What does the implementation PR in *this* repo ship, and what (if anything) is deferred to an upstream speckit change?
**Options**:
- A: This repo ships only the CLAUDE.md pointer + doc updates + regression test; the `/plan` skill change lands upstream in speckit and is picked up here via the scaffolder/setup (this PR is unblocked only after upstream ships)
- B: This repo ships a local override of the `/plan` skill (e.g., under `.claude/skills/` or `.specify/`) alongside the pointer + docs + regression test, so the fix works here immediately regardless of upstream
- C: Both — ship the pointer, docs, and regression test here, AND land a local override of the `/plan` skill in this repo to unblock immediately, then remove the local override once upstream ships

**Answer**: *Pending*

---

### Q4: Idempotency mechanism in the per-feature managed file
**Context**: FR-004 requires that re-invoking `/plan` regenerates the per-feature file "in place, not duplicated or appended." Implementations differ: some use HTML-comment markers around a managed region (like today's `<!-- speckit:managed -->`), others overwrite the whole file each run. This affects whether humans can safely edit the file, and what the regeneration algorithm looks like.
**Question**: How should `/plan` achieve idempotent regeneration of the per-feature managed file?
**Options**:
- A: Whole-file overwrite — `/plan` owns the file exclusively; each run rewrites it from scratch. Humans should not hand-edit it.
- B: Marker-delimited managed region — the file is largely human-writable but contains a `<!-- speckit:managed -->` ... `<!-- /speckit:managed -->` block that `/plan` regenerates in place; content outside the markers is preserved.
- C: Structured sections by heading — `/plan` regenerates specific top-level sections (e.g., `## Technologies added by /plan`, `## Active work`) in place, leaves other headings untouched.

**Answer**: *Pending*

---

### Q5: Regression test locale and form
**Context**: FR-007 requires a regression test constructing two sibling branches from the same base, running each through `/plan`, and asserting `git merge-tree` reports zero `CLAUDE.md` conflicts. Where this test lives and how it runs affects who owns it, when it fires, and whether it can run in this repo's CI at all (given that Assumption 2 places `/plan` upstream).
**Question**: Where and how should the FR-007 regression test live?
**Options**:
- A: In this repo as a shell/node script under `specs/899-found-during-cockpit-v1/contracts/` (or `tests/`), executed by CI on this feature's PR and thereafter as part of the standard test suite
- B: In upstream speckit alongside the skill change (this repo trusts upstream to keep it green; no local test artifact)
- C: In this repo as a manual runbook / documented procedure only (no automated CI job), because sibling-branch construction is expensive in CI
- D: Both A and B — mirrored automated test in both places (redundant but catches regressions on either side)

**Answer**: *Pending*

---
