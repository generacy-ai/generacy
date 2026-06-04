# Clarifications: Release pending changesets to `@generacy-ai/*@stable`

**Issue**: [#748](https://github.com/generacy-ai/generacy/issues/748) | **Branch**: `748-summary-generacy-ai-stable`

## Batch 1 — 2026-06-04

### Q1: Changeset scope (15 vs. 16)
**Context**: The spec lists 15 pending changesets, but `.changeset/` currently contains 16 `.md` files. The extra one is `feat-750-identity-split-detector.md` (presumably landed after the spec was authored). Releasing it now bundles it into the same `stable` cut; deferring keeps the release surface aligned with the spec.
**Question**: Include `feat-750-identity-split-detector.md` in this `stable` release, or hold it for a follow-up?
**Options**:
- A: Include — drain all 16 changesets in one cut (spec gets updated to "16").
- B: Defer — release only the 15 listed; leave `feat-750-…` in `.changeset/` for a later release.
- C: Move `feat-750-…` out of `.changeset/` temporarily, run the release for the 15, then restore it.

**Answer**: A — Include all 16, drain in one cut. `feat-750-identity-split-detector` is tested (staging verified end-to-end) and the Release workflow's `changeset version` drains all pending changesets anyway; pulling one out (B/C) is needless friction. One clean `stable` cut.

### Q2: Execution path (workflow vs. manual)
**Context**: FR-002 says "Publish all bumped packages with `pnpm -r publish --tag stable` (or the existing release workflow)." These have different ownership and audit-trail characteristics: a GH Actions release workflow runs under repo automation tokens with a recorded log; a manual local publish runs under the operator's npm token. The notes say "likely best handled manually."
**Question**: Which path does this release use?
**Options**:
- A: Existing GH Actions release workflow (changesets/action or similar) — list the workflow file by name.
- B: Manual local: `pnpm changeset version` → PR for committed bumps → merge → `pnpm -r publish --tag stable` from a clean checkout.
- C: Hybrid: `pnpm changeset version` + commit via PR; publish step via the workflow.

**Answer**: A — The existing `.github/workflows/release.yml`. It's purpose-built and already safe: on `push: main` it runs `changeset version` → opens a Version PR while changesets are pending, and runs `pnpm -r publish` (NOT `pnpm changeset publish`, which doesn't rewrite `workspace:` deps — see #669) once they're drained, gated by a packed-tarball check (`scripts/verify-pack-no-workspace-deps.js`). Do NOT hand-run `changeset publish`. Concrete sequence: (1) Merge `develop → main`. (2) Workflow runs in version mode → opens Version PR (bumps versions, consumes the 16 changesets); no publish yet. (3) Review + merge the Version PR. (4) Workflow runs in publish mode → `pnpm -r publish --tag stable` (skips already-published, publishes the rest, with the tarball guard).

### Q3: Source ref to cut from
**Context**: The release needs a definite commit to publish from. `develop` HEAD may receive new merges during the release window; pinning to a SHA freezes scope. Also matters for verifying tarball contents in SC-002.
**Question**: What ref does the release publish?
**Options**:
- A: `develop` HEAD at start of the release procedure (no freeze).
- B: A specific SHA pinned in advance (please specify or capture before `changeset version`).
- C: A short-lived release branch cut from `develop`, with a code freeze until publish.

**Answer**: B — Pin the `develop` SHA you merge to `main`; that commit *is* the release scope. The "freeze" is operational: merge `develop → main` once, then hold further merges to `develop`/`main` until the Version PR lands. SC-002 verifies the packed tarballs against that known SHA. A dedicated release branch (C) is unnecessary overhead given the main-triggered workflow + single merge.

### Q4: Post-release verification cluster (FR-005 / SC-003)
**Context**: SC-003 measures the fix on a "stable-channel cloud cluster." A real prod cluster validates the actual deployment surface but carries production risk; a throwaway test cluster pinned to `stable` is lower-risk but doesn't prove prod readiness.
**Question**: How is SC-003 verified?
**Options**:
- A: Spin up a throwaway test cluster from `stable` (deploy via `generacy launch`/`deploy`) and inspect `vscodeTunnelName` in its relay metadata. Tear it down after.
- B: Re-deploy or recreate an existing real prod cluster and inspect it.
- C: Temporarily flip staging from `preview` to `stable` for one boot, verify, flip back.
- D: Tarball inspection (SC-002) is sufficient; skip live verification.

**Answer**: A — Throwaway `stable` cluster. After publish, `generacy launch`/`deploy` a disposable cluster on the `stable` channel, confirm it connects and its `vscodeTunnelName` is UUID-derived (`g-<uuid18>`), then tear it down. Real end-to-end, no prod risk. Explicitly NOT D: this entire effort began because static/tarball inspection (#746) missed a real deploy-behavior mismatch — SC-002's tarball checks are necessary but not sufficient.

### Q5: Rollback / abort plan
**Context**: Once a version is published under the `stable` tag, downgrading is not free. `npm unpublish` is only available within 72h and disallowed on packages with downstream installs; `npm deprecate` warns but doesn't pull. Spec has no rollback section.
**Question**: What's the abort/recovery path if the release exposes a regression post-publish?
**Options**:
- A: Roll forward only — author a hotfix changeset, cut a new `stable` patch. (No unpublish.)
- B: `npm dist-tag` re-point `stable` to the previous version (0.3.0) while a hotfix is prepared.
- C: `npm unpublish` within 72h if no consumers; else roll forward.
- D: Block release until a documented rollback runbook is added to the spec.

**Answer**: B — `npm dist-tag` re-point. If a regression surfaces post-publish, immediately `npm dist-tag add @generacy-ai/<pkg>@<previous-good> stable` per package to point `stable` back to the last-good version (instant, non-destructive), then roll forward with a hotfix changeset. Don't rely on `npm unpublish` (C — restricted to 72h, disallowed with downstream installs, breaks consumers); roll-forward-only (A) leaves the bad version live as `stable` until the hotfix ships.
