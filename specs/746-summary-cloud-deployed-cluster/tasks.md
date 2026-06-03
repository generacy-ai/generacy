# Tasks: Cloud cluster VS Code tunnel name still derived from projectId

**Input**: Design documents from `/specs/746-summary-cloud-deployed-cluster/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md, clarifications.md
**Status**: Complete

## Format: `[ID] [P?] [Story] Description`
- **[P]**: Can run in parallel (different files / different systems, no shared state)
- **[Story]**: Which user story this task belongs to ([US1] = operator deploying multiple clusters in one project)

This is a **diagnosis-led bugfix** (FR-001 is P0 and gates any in-repo code change per Q5=A). Phase 1 read-only investigation must complete before Phase 3 conditionally branches into either an in-repo fix or a companion-issue handoff (Q1=A). Phase 4 verification requires one fresh end-to-end cloud deploy (Q4=C).

---

## Phase 1: Investigation — FR-001 write-path trace (P0, gates everything)

The output of Phase 1 is an updated `specs/746-…/research.md` with each of the three hypotheses pinned or eliminated, and the responsible Layer (A in-repo, B generacy-cloud, C publish-preview workflow) identified.

- [ ] T001 [P] [US1] Re-verify in-repo `deriveTunnelName` / `loadOptionsFromEnv` are UUID-keyed by inspecting `packages/control-plane/src/services/vscode-tunnel-manager.ts:60-90`. Confirm post-#744 state matches the spec's assumption. Record the exact line numbers (code may have moved since spec was written) in `specs/746-summary-cloud-deployed-cluster/research.md` under a new "Investigation Log — Layer A code" section.

- [ ] T002 [P] [US1] Probe the regressing Droplet's `GENERACY_CLUSTER_ID` env (hypothesis #1) via SSH per quickstart.md §1.1: `grep -E '^GENERACY_(CLUSTER_ID|PROJECT_ID)=' /opt/generacy/.env` on the live Droplet running cluster `325cdcb9-5b8e-45fc-a1bc-1ec8570d561d` (project `Xr7fxq61PF57U2lOtoKe`). Record observed value in research.md under "Investigation Log — Hypothesis #1". If the value is the projectId, mark hypothesis #1 confirmed and root cause = `generacy-cloud cloud-deploy/compose-template.ts`.

- [ ] T003 [P] [US1] Verify the installed `@generacy-ai/control-plane` preview tarball actually contains #744's UUID-keyed `deriveTunnelName` (hypothesis #2) via quickstart.md §1.2: `docker compose exec orchestrator node -e "require('@generacy-ai/control-plane/package.json').version"` and `grep -n 'GENERACY_CLUSTER_ID\|deriveTunnelName' node_modules/@generacy-ai/control-plane/dist/services/vscode-tunnel-manager.js`. Record version + grep output in research.md under "Investigation Log — Hypothesis #2". If the published dist file is pre-#744, mark hypothesis #2 confirmed and root cause = `publish-preview` workflow ref pinning.

- [ ] T004 [P] [US1] Inspect orchestrator + control-plane logs on the Droplet for the actually-requested tunnel name per quickstart.md §1.3: `docker compose logs orchestrator control-plane | grep -iE 'tunnel.*name|deriveTunnelName|code tunnel --name'`. Record observed `code tunnel --name <X>` invocation and any `cluster.vscode-tunnel` payload in research.md under "Investigation Log — Cluster request trace". If the cluster requested `g-325cdcb95b8e45fca1` (UUID-derived) but the Firestore doc still holds `g-xr7fxq61pf57u2loto`, the bug is in the cloud write path (Layer B).

- [ ] T005 [US1] FR-001 Layer B read-only inspection: trace the generacy-cloud relay handler that writes `vscodeTunnelName` to `organizations/{orgId}/clusters/{clusterId}`. Per quickstart.md Phase 2 and research.md "Layer B": locate the `cluster.vscode-tunnel` event handler in generacy-cloud (likely under `services/api/.../relay-handlers/`), confirm it reads `data.tunnelName` from the event payload (not computed cloud-side), confirm `preApproveActivationCode` does not seed `vscodeTunnelName` from `projectId`, and confirm write semantics are `merge: true` (not write-once). Record findings in research.md under "Investigation Log — Layer B". Depends on T001-T004 so the cluster-side facts are pinned first.

- [ ] T006 [P] [US1] FR-001 Layer C: confirm the `0.0.0-preview-20260603190235` `@generacy-ai/control-plane` tarball was built from a ref containing #744's merge SHA `6f74140` (or descendant). Inspect the relevant `publish-preview` workflow run (manual `workflow_dispatch`) in the `generacy-ai/control-plane` build pipeline or `.github/workflows/publish-preview.*`. Record the actual build ref in research.md under "Investigation Log — Layer C". Can run in parallel with T005.

- [ ] T007 [US1] FR-002 root-cause synthesis: from T001-T006 results, write a "Diagnosis" section in `specs/746-summary-cloud-deployed-cluster/research.md` that pins the root cause to exactly one of (hypothesis #1 env, hypothesis #2 tarball, hypothesis #3 cache, hypothesis #4 cloud-side computation/seed) and to exactly one Layer (A in-repo, B generacy-cloud, or C release workflow). Cite the specific probe output that proves it. Depends on T001-T006.

---

## Phase 2: Decide where the fix lands (FR-003) — gate to Phase 3

- [ ] T008 [US1] Decision gate per FR-003 and quickstart.md Phase 3 decision matrix. Based on T007's pinned Layer, choose exactly one of the Phase 3 branches below:
  - **Layer A (in-repo)** → execute T009 + T010. Skip T011, T012.
  - **Layer B (generacy-cloud)** → execute T011 (companion issue). Skip T009, T010, T012.
  - **Layer C (publish-preview workflow)** → execute T012 (companion issue). Skip T009, T010, T011.
  - **Hypothesis #3 confirmed and restart provably insufficient** → also execute T013 (FR-007 conditional documentation), in addition to whichever of T009-T012 the Layer demands.
  Record the chosen branch in research.md under a new "Decision" section. Depends on T007.

---

## Phase 3: Conditional fix or companion-issue handoff

Execute only the subset selected by T008. Do **not** execute all of these.

### Branch A — In-repo fix (low probability per Q1 note)

- [ ] T009 [US1] **Conditional on T008 = Layer A**: ship the targeted in-repo fix in `packages/control-plane/src/services/vscode-tunnel-manager.ts`. Most likely candidates: `deriveTunnelName` (lines ~60-71) or `loadOptionsFromEnv` (lines ~75-90). Single-file change, no new abstractions, no new schemas. Add `.changeset/fix-746-tunnel-name-uuid.md` describing the regression and fix.

- [ ] T010 [US1] **Conditional on T009**: add a regression test next to existing `deriveTunnelName` tests in `packages/control-plane/src/services/vscode-tunnel-manager.test.ts` (or the closest equivalent test file — locate via `find packages/control-plane -name '*vscode-tunnel*test*'`). Test must assert: given `GENERACY_CLUSTER_ID = '325cdcb9-5b8e-45fc-a1bc-1ec8570d561d'`, `loadOptionsFromEnv().tunnelName === 'g-325cdcb95b8e45fca1'`, and the projectId-shaped input observed in the regression (`'Xr7fxq61PF57U2lOtoKe'`) never produces the observed regressing value through this codepath. Run `pnpm --filter @generacy-ai/control-plane test` to confirm green. Depends on T009.

### Branch B — Companion issue in generacy-cloud

- [ ] T011 [US1] **Conditional on T008 = Layer B**: open a companion issue in `generacy-ai/generacy-cloud` titled "Cluster `vscodeTunnelName` write-path uses projectId instead of relay-reported UUID name (companion to generacy#746)". Body must include: observed UUID (`325cdcb9-…`), observed regressing tunnel name (`g-xr7fxq61pf57u2loto`), expected name from `deriveTunnelName` (`g-325cdcb95b8e45fca1`), the specific Layer B trace step from T005 that pinned the bug, link to this issue's `research.md`. Use `gh issue create --repo generacy-ai/generacy-cloud --title '…' --body "$(cat <<'EOF' … EOF)"`. Capture the new issue URL in research.md under "Companion Issues".

### Branch C — Companion issue against publish-preview workflow

- [ ] T012 [US1] **Conditional on T008 = Layer C**: open a companion issue against the owning repo for the `publish-preview` workflow (likely `generacy-ai/control-plane` build repo or wherever `.github/workflows/publish-preview.*` lives — confirmed by T006). Title: "publish-preview workflow built `0.0.0-preview-20260603190235` from pre-#744 ref (companion to generacy#746)". Body must include: published version string, the actual build ref observed in T006, the expected merge SHA `6f74140` or descendant. Capture URL in research.md.

### FR-007 conditional documentation

- [ ] T013 [US1] **Conditional on hypothesis #3 confirmed AND restart provably insufficient (per T015 result, see Phase 4)**: write a new section "FR-007: stale-cache conditions" in `specs/746-summary-cloud-deployed-cluster/research.md` documenting the exact conditions under which a restart fails to re-derive, what cache layer is responsible, and what (if any) operator action is required. Per spec FR-007 default assumption: restart suffices, so this task is typically a no-op. Do **not** build a migration CLI (Q2=B forbids it) — documentation only.

---

## Phase 4: Verification (FR-005, FR-006, SC-001, SC-002)

- [ ] T014 [US1] FR-006 self-correction test on the existing regressing cluster (`325cdcb9-…`) per quickstart.md §1.4. Run `docker compose -f /opt/generacy/docker-compose.yml restart orchestrator control-plane`, wait 30s, then re-read `organizations/<orgId>/clusters/325cdcb9-…/vscodeTunnelName` from Firestore. Record result in research.md under "FR-006 Verification". If it flips to `g-325cdcb95b8e45fca1` (UUID-derived): hypothesis #3 was transient cache, no migration needed. If it does not flip: T013 conditionally applies. Can run in parallel with T015 only if T008 chose Layer A or Layer C (Layer B fix won't be in effect on the live cluster until the companion PR lands).

- [ ] T015 [US1] FR-005 / SC-001 end-to-end verification — required regardless of fix location (Q4=C). Provision exactly one fresh cloud cluster via the same cloud-deploy path that produced the regression (DigitalOcean) per quickstart.md Phase 4. Read its `vscodeTunnelName` from `organizations/<orgId>/clusters/<NEW_UUID>` and confirm it equals `deriveTunnelName(<NEW_UUID>)` (i.e. `g-` + first 18 hex chars of the de-hyphenated UUID, lower-cased). Record the new UUID, the read value, and the computed expected value in research.md under "SC-001 Verification". SC-002 is satisfied by argument from UUID uniqueness once SC-001 passes (per Q4=C, no second deploy required). Depends on the relevant fix (T010 if Layer A, T011's companion PR merged if Layer B, T012's companion PR merged if Layer C) being live in the preview channel the deploy consumed.

---

## Phase 5: Release-task handoff (FR-008)

- [ ] T016 [US1] FR-008 flag on the separate #744 stable-release tracking task: leave a comment (or open one if it doesn't exist) on the release task referencing `.changeset/feat-744-multi-cluster-cli.md`, noting that prod / `stable`-channel cloud clusters will not get per-cluster tunnel naming until that changeset is consumed and `@generacy-ai/control-plane@stable` is republished. SC-003 is explicitly out of scope for #746 closure (Q3=B). This is a notification, not a release action.

---

## Dependencies & Execution Order

```
Phase 1 (T001 ∥ T002 ∥ T003 ∥ T004) → T005 ∥ T006 → T007
                                                       ↓
                                                      T008 (decision gate)
                                                       ↓
                              ┌────────────────────────┼────────────────────────┐
                              ↓ (Layer A)              ↓ (Layer B)              ↓ (Layer C)
                            T009 → T010              T011                     T012
                                                       ↓
                              (any branch) → T014 ∥ T015 → (conditionally) T013 → T016
```

**Phase 1 parallel set**: T001, T002, T003, T004 are all read-only probes and touch different systems (local source, Droplet env, Droplet tarball, Droplet logs). Run concurrently to compress investigation time.

**Phase 1 sequential**: T005 depends on T001-T004 (need the cluster-side facts pinned before judging the cloud handler). T006 is independent of T005 and can parallelize with it.

**Phase 2 gate**: T007 (diagnosis synthesis) and T008 (branch selection) are strictly sequential and gate Phase 3.

**Phase 3 mutually exclusive**: exactly one of {T009+T010, T011, T012} runs per T008's decision. T013 is conditional on a separate signal from T014.

**Phase 4 ordering**: T014 may parallelize with T015 when the fix path doesn't depend on a Layer B handler change (i.e. when T008 chose Layer A or C). When T008 chose Layer B, T014 should wait until the companion PR lands so the live cluster's restart actually exercises the corrected write path.

**Phase 5**: T016 is independent and can run any time after T007 (it only needs the diagnosis to phrase the release-task comment correctly).

---

## Parallel opportunities

- **Investigation (Phase 1)**: 4 concurrent probes T001-T004 + T006 in parallel with T005.
- **Verification (Phase 4)**: T014 ∥ T015 when fix is in-repo or in publish-preview workflow.
- All other phases are sequential due to gating decisions.

---

## Out-of-scope reminders (do not turn into tasks)

- ❌ Consuming `.changeset/feat-744-multi-cluster-cli.md` and publishing stable (Q3=B, separate release task).
- ❌ Cross-repo PRs into `generacy-cloud` or release-workflow repos (Q1=A, companion issues only).
- ❌ Migration CLI / operator-triggered re-registration (Q2=B, restart self-correction suffices).
- ❌ A second sibling cloud deploy for SC-002 (Q4=C, reasoned from UUID uniqueness).
