# Feature Specification: Release pending changesets to `@generacy-ai/*@stable`

**Branch**: `748-summary-generacy-ai-stable` | **Date**: 2026-06-04 | **Status**: Draft | **Issue**: [#748](https://github.com/generacy-ai/generacy/issues/748)

## Summary

`@generacy-ai/*@stable` is pinned at **0.3.0** and is missing the entire recent **cloud-cluster line** of fixes. There are **15 pending changesets** in `.changeset/` that have never been consumed for a `stable` release — so any prod / `stable`-channel cloud cluster boots with packages predating the cloud-cluster work. Staging is unaffected (it uses the `preview` tag, which is current).

This was surfaced by #746: `stable` `@generacy-ai/control-plane` lacks #744's per-cluster `deriveTunnelName`, so a `stable`-channel cloud cluster regresses to projectId-derived tunnel names (collisions across sibling clusters) plus misses the rest of the cloud-cluster fixes (claude.json bind, post-activation clone race, identity split, vscode tunnel name, etc.).

**Nature of work**: Pure release operation. No application source changes — only consuming changesets, bumping versions, and publishing to npm under the `stable` dist-tag.

## Pending changesets (15)

Cloud-cluster line (primary motivation):
- `feat-744-multi-cluster-cli` — per-cluster tunnel name + identity, `launch --name`
- `fix-vscode-tunnel-actual-name` (#743)
- `fix-cluster-identity-gh-username` (#742)
- `prepare-workspace-lifecycle` / `fix-739-post-activation-clone-race` (#739/#741)
- `739-pre-approved-device-code`
- `fix-737-claude-json-volume-bind` (#737)

Release/infra changesets folded in:
- `propagate-primary-branch`, `fix-workspace-deps-leak`, `fix-orchestrator-republish-clean-deps`, `bulk-worker-scale-release`, `bulk-stable-release`, `initial-stable-release`, `release-followup-727-730`, `release-followup-workflow-engine`

## User Stories

### US1: Prod cloud cluster gets cloud-cluster fixes

**As a** Generacy prod / `stable`-channel cluster operator,
**I want** `@generacy-ai/*@stable` to include the cloud-cluster line (#737–#746),
**So that** clusters deployed on the stable channel don't regress to broken tunnel naming, missing claude.json binds, or post-activation clone races that staging already has fixed.

**Acceptance criteria**:
- [ ] A fresh prod cloud cluster boots with `@generacy-ai/control-plane@stable` that contains UUID-keyed `deriveTunnelName`.
- [ ] Cloud-cluster fixes listed above are present in the `stable` tarballs.

### US2: Release engineer can re-run the workflow cleanly

**As a** Generacy release engineer,
**I want** a documented, reproducible procedure that drains the 15 pending changesets to the `stable` dist-tag,
**So that** the next prod release isn't another months-of-drift incident and the changeset pipeline is left empty.

**Acceptance criteria**:
- [ ] `.changeset/` is empty (or contains only changesets unrelated to this batch) after the release.
- [ ] Each affected package's version is bumped past 0.3.0 per its consumed changesets.
- [ ] `CHANGELOG.md` entries are generated for each affected package.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Run `pnpm changeset version` to consume the 15 pending changesets and bump package versions. | P1 | Driven by changeset metadata — no manual version bumps. |
| FR-002 | Publish all bumped packages with `pnpm -r publish --tag stable` (or the existing release workflow). | P1 | Per memory: stable publish goes through the changeset / `pnpm -r publish` path. |
| FR-003 | Verify by inspecting the published tarball contents, not source `package.json`. | P1 | Memory note: source vs. published can diverge; tarball is authoritative. |
| FR-004 | Confirm `@generacy-ai/control-plane@stable` tarball contains UUID-keyed `deriveTunnelName` (the #746 regression marker). | P1 | Use `npm view` + `npm pack` or `npm view ... dist.tarball`. |
| FR-005 | Deploy a `stable`-channel cloud cluster post-release and confirm `vscodeTunnelName` is UUID-derived. | P1 | Closes the loop with the #746 acceptance criterion. |
| FR-006 | Do not introduce application source changes in this release. | P1 | This is a release-engineering operation only. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | `@generacy-ai/control-plane@stable` version | Bumped past 0.3.0 with the 15 changesets reflected | `npm view @generacy-ai/control-plane@stable version` |
| SC-002 | `deriveTunnelName` present in published tarball | UUID-keyed implementation matches `develop` source | `npm view @generacy-ai/control-plane@stable dist.tarball` → unpack → grep `deriveTunnelName` |
| SC-003 | Prod cloud cluster tunnel name | UUID-derived, not projectId-derived | Deploy `stable`-channel cluster, inspect `vscodeTunnelName` in relay metadata |
| SC-004 | Pending changesets drained | Pre-existing 15 changesets removed from `.changeset/` after `changeset version` | `ls .changeset/*.md` shows only `README.md` and anything added since |

## Assumptions

- The 15 pending changesets are correctly authored and don't need rewriting before consumption.
- The `pnpm -r publish` pipeline (or the existing release workflow) is the canonical path to the `stable` dist-tag.
- Cloud staging (preview) is already validated; this is purely a "promote to stable" operation.
- No coordinating cloud-side release (generacy-cloud) is gated on this — staging-tested fixes are deployed independently to cloud.

## Out of Scope

- Application source code changes (bug fixes, features).
- Authoring new changesets — only consuming the existing 15.
- Releasing `@generacy-ai/generacy-extension` (excluded in `.changeset/config.json` `ignore` list).
- Cloud-side (generacy-cloud) releases or deploys — those are tracked separately in #792/#795/#796.
- Backporting fixes to any pre-0.3.0 line; only the forward `stable` line is in scope.

## Notes

- Per the issue: "Pure release operation — likely best handled manually / via the existing release workflow rather than the speckit pipeline." Implementation may be a runbook + workflow invocation rather than code changes.
- Related: #744, #746, generacy-ai/generacy-cloud#792, #795, #796.

---

*Generated by speckit*
