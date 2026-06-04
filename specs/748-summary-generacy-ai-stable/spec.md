# Feature Specification: Release pending changesets to `@generacy-ai/*@stable`

**Branch**: `748-summary-generacy-ai-stable` | **Date**: 2026-06-04 | **Status**: Clarified

## Summary

`@generacy-ai/*@stable` is at **0.3.0** and is missing the **entire recent cloud-cluster line**. There are **16 pending changesets** in `.changeset/` that have never been released to the `stable` npm tag — so any **prod / `stable`-channel** cloud cluster pulls packages without these fixes. (Staging is unaffected: it uses the `preview` tag, which is current.)

This was surfaced by #746: `stable` `@generacy-ai/control-plane` lacks #744's per-cluster `deriveTunnelName`, so a `stable`-channel cloud cluster would regress to **projectId-derived tunnel names** (collisions across sibling clusters), plus miss the rest of the cloud-cluster fixes below.

## Pending changesets (16)

Cloud-cluster line:
- `feat-744-multi-cluster-cli` — per-cluster tunnel name + identity, `launch --name`
- `fix-vscode-tunnel-actual-name` (#743)
- `fix-cluster-identity-gh-username` (#742)
- `prepare-workspace-lifecycle` / `fix-739-post-activation-clone-race` (#739/#741)
- `739-pre-approved-device-code`
- `fix-737-claude-json-volume-bind` (#737)
- `feat-750-identity-split-detector` (post-spec addition; staging-verified, drained in this cut per Q1)
- `propagate-primary-branch`, `fix-workspace-deps-leak`, `fix-orchestrator-republish-clean-deps`, `bulk-worker-scale-release`, `bulk-stable-release`, `initial-stable-release`, `release-followup-727-730`, `release-followup-workflow-engine`

## Deliverable

Cut a `stable` release via the existing `.github/workflows/release.yml` workflow: merge a pinned `develop` SHA to `main`, review and merge the auto-opened Version PR (which runs `changeset version` and consumes all 16 changesets), and let the workflow run `pnpm -r publish --tag stable` (gated by `scripts/verify-pack-no-workspace-deps.js`). Confirm `@generacy-ai/control-plane@stable` now contains UUID-keyed `deriveTunnelName` in the packed tarball, and verify on a throwaway `stable` cluster.

## Acceptance criteria

- [ ] All 16 changesets consumed; `@generacy-ai/control-plane@stable` and siblings version-bumped past 0.3.0.
- [ ] `npm view @generacy-ai/control-plane@stable` tarball contains UUID-keyed `deriveTunnelName` (SC-002).
- [ ] A throwaway `stable`-channel cloud deploy reports a UUID-derived `vscodeTunnelName` (`g-<uuid18>`), not projectId-derived (SC-003).

## Notes

- Release-engineering follow-up flagged in #746 (Q3=B): #746 verified the fix on `preview`; this issue ships it to `stable` for prod readiness.
- Executed via the existing release workflow (NOT a hand-run of `pnpm changeset publish`, which fails to rewrite `workspace:` deps — see #669).

Relates: #744, #746, generacy-ai/generacy-cloud#792, generacy-ai/generacy-cloud#795, generacy-ai/generacy-cloud#796.

## User Stories

### US1: Prod cluster operator gets the cloud-cluster fixes

**As a** Generacy operator deploying clusters on the `stable` channel,
**I want** `@generacy-ai/*@stable` to include the 16 pending changesets (notably #737–#746 + `feat-750`),
**So that** new `stable`-channel deploys get UUID-derived VS Code tunnel names, the workspace clone race fix, claude.json volume bind, GH username identity, and the rest of the cloud-cluster line — without me having to flip to `preview`.

**Acceptance Criteria**:
- [ ] A fresh `generacy launch`/`deploy` against the `stable` channel boots cleanly and reports `vscodeTunnelName` matching `g-<uuid18>` (not projectId-derived) in its relay metadata.
- [ ] No regression in the existing `stable` deployment surface relative to `preview`.

## Functional Requirements

| ID | Requirement | Priority | Notes |
|----|-------------|----------|-------|
| FR-001 | Merge a pinned `develop` SHA into `main` to define release scope. | P1 | Q3=B: that commit *is* the release scope; operational freeze on further `develop`/`main` merges until the Version PR lands. |
| FR-002 | Trigger `.github/workflows/release.yml` to run `changeset version` and auto-open the Version PR (bumps versions, consumes all 16 changesets). | P1 | Q2=A. Do NOT hand-run `pnpm changeset publish` (breaks `workspace:` deps per #669). |
| FR-003 | Review and merge the Version PR. | P1 | Manual review gate; confirms version bumps before publish. |
| FR-004 | Workflow runs `pnpm -r publish --tag stable` in publish mode, gated by `scripts/verify-pack-no-workspace-deps.js` packed-tarball check. | P1 | Skips already-published packages, publishes the rest. |
| FR-005 | Verify `@generacy-ai/control-plane@stable` tarball contains UUID-keyed `deriveTunnelName` via `npm view` / `npm pack` inspection. | P1 | SC-002. Static check, necessary but not sufficient. |
| FR-006 | Deploy a throwaway `stable` cluster via `generacy launch`/`deploy`, confirm `vscodeTunnelName` is UUID-derived, then tear it down. | P1 | SC-003. Q4=A — explicitly NOT relying on tarball inspection alone (this whole issue exists because #746's static check missed the real deploy mismatch). |
| FR-007 | If a post-publish regression surfaces, use `npm dist-tag add @generacy-ai/<pkg>@<previous-good> stable` per affected package to instantly re-point `stable` back to the last-good version, then roll forward with a hotfix changeset. | P1 | Q5=B. Do NOT rely on `npm unpublish` (72h limit, breaks consumers); roll-forward-only leaves the bad version live as `stable`. |

## Success Criteria

| ID | Metric | Target | Measurement |
|----|--------|--------|-------------|
| SC-001 | All 16 pending changesets consumed; package versions bumped past 0.3.0. | 16/16 drained, 0 remaining `.md` files in `.changeset/` (excluding `README.md` / `config.json`). | `ls .changeset/*.md` on `main` post Version PR merge; `npm view @generacy-ai/control-plane versions --json` shows new version. |
| SC-002 | `@generacy-ai/control-plane@stable` packed tarball contains UUID-keyed `deriveTunnelName`. | `deriveTunnelName` function present and behaves per #744 (`g-` prefix + 18 hex chars from UUID). | `npm view @generacy-ai/control-plane@stable dist.tarball` → download/extract → grep `deriveTunnelName`. |
| SC-003 | A throwaway `stable`-channel cloud cluster reports a UUID-derived `vscodeTunnelName`. | `vscodeTunnelName` matches `^g-[0-9a-f]{18}$` (not projectId-derived). | `generacy launch`/`deploy` against `stable`, inspect relay metadata via `generacy status` or `/health`, then `generacy destroy`. |

## Assumptions

- The release workflow `.github/workflows/release.yml` is in working order (no recent breakage); credentials/secrets for npm publish are valid.
- The 16 pending changesets in `.changeset/` are all intended for `stable` and have no inter-dependencies that would require a different release ordering.
- `feat-750-identity-split-detector` has been staging-verified end-to-end (per Q1 answer).
- A clean rollback path via `npm dist-tag` is acceptable for any post-publish regression (no `npm unpublish` needed).

## Out of Scope

- Refactoring or modifying the release workflow itself.
- Bumping the `preview` tag (already current).
- Publishing under any tag other than `stable`.
- Cluster-image rebuilds (handled by separate workflows in `.github/workflows/publish-cluster-*-image.yml`).
- Authoring or merging new changesets unrelated to this release.

---

*Generated by speckit*
