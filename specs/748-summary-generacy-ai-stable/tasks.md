# Tasks: Release pending changesets to `@generacy-ai/*@stable`

**Input**: Design documents from `/specs/748-summary-generacy-ai-stable/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/release-workflow.md, quickstart.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files / independent ops, no dependencies)
- **[Story]**: Which user story this task belongs to (US1 = "Prod cluster operator gets the cloud-cluster fixes")

> NOTE: This feature ships **no source modifications**. It is a release-engineering
> execution against the existing `.github/workflows/release.yml`. Every task is
> an operator step or a verification gate; there are no code edits to make.

---

## Phase 1: Pre-flight Checks

- [X] T001 [US1] Confirm there are exactly 16 `.md` files in `.changeset/` (excluding `README.md` and `config.json`). Command: `ls .changeset/*.md | grep -v README.md | wc -l` → must equal `16`. If not 16, STOP and re-clarify scope (Q1 may need re-answering). (FR-001, SC-001 baseline)
- [X] T002 [P] [US1] Confirm `@stable` is currently stuck at `0.3.0`. Command: `npm view @generacy-ai/control-plane@stable version` → must equal `0.3.0`. (data-model.md §RegistryState "Before")
- [X] T003 [P] [US1] Confirm `@preview` is current (sanity baseline — preview is unaffected by this cut). Command: `npm view @generacy-ai/control-plane@preview version` → recent timestamped preview version.
- [X] T004 [P] [US1] Confirm repo `NPM_TOKEN` is valid by inspecting the most recent successful `release.yml` run. If the last `Publish to npm` step succeeded, the token is good. Otherwise rotate the secret in repo settings before proceeding. (contracts/release-workflow.md §Required secrets)
- [X] T005 [P] [US1] Confirm local tooling is installed: `pnpm`, `gh`, `git`, `node` (≥22), and the `generacy` CLI (needed for T020/T021 throwaway cluster verification). (quickstart.md §Prerequisites)

---

## Phase 2: Pin and Merge `develop → main`

- [ ] T010 [US1] Capture the pinned `develop` SHA that defines release scope. Command: `git fetch origin && PINNED=$(git rev-parse origin/develop); echo "$PINNED"`. Record this SHA in the incident channel / release notes (it is referenced by SC-002 verification later). (FR-001, Q3=B)
- [ ] T011 [US1] Announce operational freeze in the team channel: "Release in progress on `generacy-ai/generacy`. Hold further merges to `develop` and `main` until the Version PR lands." Freeze stays in effect through T015. (FR-001, plan.md Constraints, Q3=B)
- [ ] T012 [US1] Open a `develop → main` PR pinned to the captured SHA. Command: `gh pr create --base main --head develop --title "chore: cut release at <SHA>" --body "Drains 16 pending changesets to @generacy-ai/*@stable. Pinned: <SHA>."` (FR-001)
- [ ] T013 [US1] Merge the `develop → main` PR (squash OR merge commit — workflow triggers on `push: main` regardless). The merge is the trigger for `release.yml` version mode. (FR-001)

---

## Phase 3: Version PR — Workflow Run 1 (Version Mode)

- [ ] T014 [US1] Watch `release.yml` version-mode run. Command: `gh run watch -e push --workflow release.yml`. Expected duration ~5–10 min. Expected outcome: workflow detects 16 pending changesets, runs `pnpm changeset version` via `changesets/action@v1`, opens a "chore: version packages" Version PR against `main`. (FR-002, contracts/release-workflow.md §Version mode)
- [ ] T015 [US1] Locate the auto-opened Version PR. Command: `gh pr list --search "chore: version packages" --base main`. Capture the PR number (`$VPR`). (FR-003)
- [ ] T016 [US1] Review the Version PR diff. Verify:
  - All 16 `.changeset/*.md` files are deleted (excluding `README.md` / `config.json`).
  - `packages/*/package.json` `version` fields are bumped past `0.3.0` (bump types match the changeset annotations).
  - `packages/*/CHANGELOG.md` entries are appended for each package touched by a changeset.
  - No unexpected `package.json` mutations (e.g., dependency rewrites unrelated to the bumps).
  If the diff includes unrelated changes, the freeze was broken — close this PR, re-pin a fresh `develop` SHA, restart from T010. (FR-003, quickstart.md §Troubleshooting)
- [ ] T017 [US1] Merge the Version PR. Command: `gh pr merge $VPR --squash --delete-branch`. After this merge, **operational freeze can be lifted** — release scope is committed. (FR-003)

---

## Phase 4: Publish — Workflow Run 2 (Publish Mode)

- [ ] T018 [US1] Watch `release.yml` publish-mode run (triggered by T017's merge to `main`). Command: `gh run watch -e push --workflow release.yml`. Expected duration ~10–15 min. Verify each gate passes in order: (FR-004, contracts/release-workflow.md §Publish mode)
  - `Verify no workspace protocol leaks in packed tarballs` (runs `scripts/verify-pack-no-workspace-deps.js`) — MUST pass. If this fails, DO NOT merge a workaround; the gate exists because of #669. Investigate the offending package's `dependencies` block on the pinned SHA, fix forward on `develop`, re-cut.
  - `Publish to npm` (`pnpm -r --filter '!generacy-extension' publish --tag stable --no-git-checks --provenance`) — should succeed across all non-private packages. If partial failure (network blip), re-run the failed job from the GH Actions UI; `pnpm publish` skips already-at-version packages.
  - `Advance @latest dist-tag for all published packages` — idempotent per-package dist-tag moves.
  - Downstream `publish-devcontainer-feature.yml` is triggered (workflow chain).

---

## Phase 5: Verification

- [ ] T019 [US1] **SC-001 + SC-002 (tarball)**: Confirm `@stable` is no longer `0.3.0` and the tarball contains UUID-keyed `deriveTunnelName`. Commands: (FR-005, SC-001, SC-002, research.md §"Tarball-content verification")
  ```bash
  NEW=$(npm view @generacy-ai/control-plane@stable version)
  echo "New @stable: $NEW"
  [ "$NEW" != "0.3.0" ] && echo "OK: SC-001 bumped past 0.3.0" \
    || { echo "FAIL: still at 0.3.0"; exit 1; }

  TARBALL=$(npm view @generacy-ai/control-plane@stable dist.tarball)
  curl -sL "$TARBALL" | tar -xzO --wildcards 'package/dist/**/*.js' 2>/dev/null \
    | grep -q 'deriveTunnelName' \
    && echo "OK: SC-002 deriveTunnelName present" \
    || { echo "FAIL: SC-002 deriveTunnelName missing"; exit 1; }
  ```
  If SC-002 fails, publish skipped or fragmented — re-check workflow log, identify affected package, re-run workflow OR follow rollback (Phase 6).

- [ ] T020 [US1] **SC-003 (live cluster) — Launch**: Spin up a throwaway `stable`-channel cluster. Commands: (FR-006, SC-003, quickstart.md §Step 7)
  ```bash
  TS=$(date +%s)
  NAME="release-verify-$TS"
  generacy launch --channel stable --name "$NAME"
  ```
  Complete device-code activation in the browser when the `Go to:` URL is streamed by the workflow. Wait for cluster to reach `connected` status.

- [ ] T021 [US1] **SC-003 (live cluster) — Verify + Tear down**: Confirm `vscodeTunnelName` matches `^g-[0-9a-f]{18}$` in relay metadata, then destroy the throwaway cluster. Commands: (FR-006, SC-003, data-model.md §LiveClusterState)
  ```bash
  TUNNEL=$(generacy status --json 2>/dev/null | jq -r '.vscodeTunnelName // empty')
  echo "vscodeTunnelName: $TUNNEL"
  echo "$TUNNEL" | grep -E '^g-[0-9a-f]{18}$' \
    && echo "OK: SC-003 UUID-derived tunnel name" \
    || { echo "FAIL: SC-003 tunnel name not UUID-derived"; exit 1; }

  generacy destroy --yes
  ```
  Triage failure modes per quickstart.md §Step 7:
  - **`vscodeTunnelName` missing entirely**: cluster image wasn't rebuilt against new `@stable`. File a follow-up on the `cluster-base` repo; the npm publish itself is still good — do NOT block this release.
  - **`vscodeTunnelName` is projectId-derived** (UUID with hyphens or project-name slug): image rebuilt but resolved an old `@generacy-ai/control-plane`. This is the #746 failure mode — investigate image pull + the `package.json` version in the running container before declaring victory.

- [ ] T022 [US1] Post a release-complete note to the team channel with: pinned SHA (T010), new `@stable` version (T019), Version PR number (T015), and SC-003 result (T021). Update spec acceptance checkboxes in `spec.md`. (Operator hygiene — closes the loop on the issue.)

---

## Phase 6: Rollback Runbook (contingency, executed only on regression)

> Only execute this phase if a post-publish regression surfaces and rollback is required.
> Acknowledge as out-of-band steps; do not run on the happy path.

- [ ] T030 [US1] Identify affected packages from incident reports. The bulk-release changesets keep version bumps in lock-step, so a regression typically hits 1–2 packages but rollback is per-package. (FR-007, Q5=B)
- [ ] T031 [US1] For each affected package, re-point `@stable` to the previous good version. Command: `npm dist-tag add @generacy-ai/<pkg>@<previous-good> stable`. For the cloud-cluster line, `<previous-good>` is typically `0.3.0`. Instant and non-destructive. (FR-007, research.md §Rollback)
- [ ] T032 [US1] **DO NOT** run `npm unpublish` (72h window, disallowed with downstream installs, breaks consumers). **DO NOT** hand-run `pnpm changeset publish` (#669: leaks `workspace:` deps). These are documented as prohibited per Q5=B / Q2=A. (FR-007, plan.md Constraints)
- [ ] T033 [US1] Author a hotfix changeset on `develop` addressing the regression. Re-run the entire release procedure (Phase 1 → Phase 5) for the next `develop → main` cut. The next publish will move `@stable` forward past the bad version.

---

## Dependencies & Execution Order

**Strictly sequential (happy path)**:

```
Phase 1 (Pre-flight) → Phase 2 (Pin + Merge) → Phase 3 (Version PR) → Phase 4 (Publish) → Phase 5 (Verification)
                                                                                                    │
                                                                                                    ▼
                                                                                          Phase 6 (Rollback, only on regression)
```

The two `release.yml` runs (T014 version mode, T018 publish mode) are serialized by the workflow's `concurrency` group (`group: ${{ github.workflow }}`, `cancel-in-progress: false`). The Version PR merge (T017) is the trigger that hands off from version mode to publish mode.

**Parallel opportunities within Phase 1**:

- T002, T003, T004, T005 can all run in parallel (independent read-only checks). T001 must precede the others only by convention (it gates the entire release).

**Phase boundaries** (sequential — cannot overlap):

- Phase 2 cannot start until Phase 1 confirms 16 changesets and current `@stable=0.3.0`.
- Phase 3 cannot start until the `develop → main` merge has fired `release.yml`.
- Phase 4 cannot start until the Version PR is merged (T017).
- Phase 5 cannot start until publish-mode run completes successfully (T018).
- Phase 6 is contingency only.

**Operational freeze window** (T011 → T017): no merges to `develop` or `main` for any reason during this window. This is the longest blocking constraint (~15–25 min wall time across T011–T017).

---

## Notes for the Implementer

- **No source code changes**: every task is operator-driven against the existing release workflow and npm registry. There are no files to edit in `packages/*`, `scripts/`, or `.github/workflows/`.
- **The Version PR (T015) is the one repo-mutating artifact**, and it's generated by `changesets/action@v1` — not hand-authored.
- **Single user story (US1)**: every task is in service of "Prod cluster operator gets the cloud-cluster fixes" — there is no second story to parallelize across.
- **Workflow is idempotent**: re-running a failed publish job is safe (`pnpm publish` skips already-published versions). Re-running version mode just refreshes the Version PR.
- For rollback (Phase 6), only re-point `@stable`; do NOT re-point `@latest` (per data-model.md §RegistryState).

---

*Generated by speckit /tasks*
