# Quickstart: Investigating and verifying #746

**Feature**: 746-summary-cloud-deployed-cluster
**Status**: Complete
**Date**: 2026-06-03

This guide shows how to (1) reproduce the bug on the live Droplet, (2) trace the write path per FR-001, and (3) verify SC-001 once a fix has landed (in this repo or out-of-repo).

---

## Prerequisites

- SSH access to the regressing Droplet (`325cdcb9-…`, project `Xr7fxq61PF57U2lOtoKe`).
- Read access to the Firestore cluster doc in the Generacy cloud project (`organizations/vnVZ…/clusters/325cdcb9-…`).
- Local `generacy` repo (this repo) on branch `746-summary-cloud-deployed-cluster`.
- For SC-001 re-verification: DigitalOcean API token and a Generacy cloud activation code to provision one fresh cluster.

---

## Phase 0 — Confirm the in-repo code is innocent (5 min, sanity)

Skip if already convinced. Verifies that **post-#744** `deriveTunnelName` keys on the UUID.

```bash
sed -n '60,90p' packages/control-plane/src/services/vscode-tunnel-manager.ts
```

Expect: `deriveTunnelName(clusterId)` (UUID) and `loadOptionsFromEnv` reading `GENERACY_CLUSTER_ID`. If you see `projectId` referenced here, the bug *is* in-repo and the diagnosis ends; otherwise proceed.

---

## Phase 1 — On the running Droplet (FR-001, FR-002)

SSH into the Droplet and run, in order:

### 1.1 Confirm the env var (hypothesis #1)

```bash
grep -E '^GENERACY_(CLUSTER_ID|PROJECT_ID)=' /opt/generacy/.env
```

- **Expected (UUID)**: `GENERACY_CLUSTER_ID=325cdcb9-5b8e-45fc-a1bc-1ec8570d561d`
- **Bug if observed (projectId)**: `GENERACY_CLUSTER_ID=Xr7fxq61PF57U2lOtoKe` → root cause is in `generacy-cloud cloud-deploy/compose-template.ts`. **File companion issue, stop.**

### 1.2 Confirm the published tarball contains #744 (hypothesis #2)

```bash
docker compose -f /opt/generacy/docker-compose.yml exec orchestrator \
  node -e "console.log(require('@generacy-ai/control-plane/package.json').version)"
# expect: 0.0.0-preview-20260603190235  (or newer)

docker compose -f /opt/generacy/docker-compose.yml exec orchestrator \
  sh -c "grep -n 'GENERACY_CLUSTER_ID\|deriveTunnelName' \
    node_modules/@generacy-ai/control-plane/dist/services/vscode-tunnel-manager.js"
```

- **Expected**: `deriveTunnelName` present, `GENERACY_CLUSTER_ID` read. UUID-keyed.
- **Bug if observed (projectId-keyed in the published JS)**: root cause is in the `publish-preview` workflow — built from a pre-#744 ref despite the timestamp. **File companion issue against the release workflow, stop.**

### 1.3 What name did the cluster actually request? (cross-check)

```bash
docker compose -f /opt/generacy/docker-compose.yml logs orchestrator control-plane \
  | grep -iE 'tunnel.*name|deriveTunnelName|code tunnel --name'
```

- If logs show the UUID-derived name (`g-325cdcb95b8e45fca1`) but the cloud doc still has `g-xr7fxq61pf57u2loto`, the cluster process is correct and the bug lives in the relay handler / cloud doc write path. **Proceed to Phase 2 (Layer B).**

### 1.4 Force a restart to test self-correction (FR-006)

```bash
docker compose -f /opt/generacy/docker-compose.yml restart orchestrator control-plane
```

Wait 30s, then re-read the Firestore doc. If `vscodeTunnelName` flips to UUID-derived: hypothesis #3 (cache) was active but transient; no migration tooling needed. Document and close.

---

## Phase 2 — generacy-cloud relay handler (FR-001 Layer B)

This is a read-only inspection in the `generacy-cloud` repo.

1. Find the handler for `cluster.vscode-tunnel` events. Likely under `services/api/.../relay-handlers/` or wherever incoming `EventMessage`s are dispatched.
2. Confirm the handler reads `data.tunnelName` from the event payload and writes it to `organizations/{orgId}/clusters/{clusterId}.vscodeTunnelName`.
3. Confirm there is no *seed* write of `vscodeTunnelName` from `preApproveActivationCode` using `projectId`. If there is, that seed is the most likely root cause for clusters that never re-registered.
4. Confirm the write is `merge: true` and not write-once.

If any of (2)/(3)/(4) doesn't match expectations, file a companion issue in `generacy-cloud` with this writeup linked.

---

## Phase 3 — Decide where the fix lands (FR-003)

| Phase 1/2 finding | Action |
|-------------------|--------|
| `.env` has projectId (1.1 fails) | Companion issue → `generacy-cloud` `cloud-deploy/compose-template.ts`. #746 closes on writeup. |
| Tarball is pre-#744 (1.2 fails) | Companion issue → release workflow. #746 closes on writeup. |
| Cluster registers UUID name but cloud doc still has projectId (1.3 succeeds, doc wrong) | Companion issue → `generacy-cloud` relay handler. #746 closes on writeup. |
| Restart self-corrects (1.4) | Document the conditions in this `research.md`; no code change. |
| In-repo code is actually wrong (Phase 0 failed) | Single-file fix in `packages/control-plane/src/services/vscode-tunnel-manager.ts`. Add a regression test next to the existing `deriveTunnelName` tests. |

---

## Phase 4 — Verify SC-001 on a fresh cloud deploy (FR-005)

Static inspection is **explicitly insufficient**. Deploy one fresh cluster end-to-end.

```bash
# From the generacy CLI on a workstation, after the fix is in the
# preview-channel tarball (or in this repo, if in-repo):
npx --package=@generacy-ai/generacy@preview generacy deploy \
  ssh://root@<fresh-droplet>:22/opt/generacy --api-url=https://api.generacy.ai
```

(Or use the cloud-deploy UI / `digitalocean.ts` cloud-deploy path — whichever produced the regressing cluster, to keep the verification on the same path.)

Then:

```bash
# In the cloud console / via the Firestore client of your choice:
# Read: organizations/<orgId>/clusters/<NEW_CLUSTER_UUID>.vscodeTunnelName
```

**SC-001 passes when**: the read value equals `deriveTunnelName(NEW_CLUSTER_UUID)` — i.e. `g-` + first 18 hex chars of the de-hyphenated UUID. For an example UUID `7ab1c23d-…`, expect `g-7ab1c23d…`.

**SC-002** is satisfied by argument: UUIDs are unique, derivation is per-UUID, therefore distinct.

---

## Available commands (for reference)

This feature adds no new commands. The commands referenced above are:

| Command | Purpose |
|---------|---------|
| `cat /opt/generacy/.env` | Inspect the cluster's env on the Droplet (hypothesis #1). |
| `docker compose exec orchestrator …` | Inspect the actually-installed `@generacy-ai/control-plane` (hypothesis #2). |
| `docker compose logs orchestrator control-plane` | Read tunnel-name registration in-flight. |
| `docker compose restart` | Test FR-006 self-correction on restart. |
| `npx @generacy-ai/generacy@preview generacy deploy ssh://…` | Provision a fresh cluster for SC-001 verification. |

---

## Troubleshooting

- **`grep` returns nothing in 1.2**: the dist file may be minified or bundled differently between preview builds; fall back to `cat` and inspect by hand, or run `node -e "console.log(require('@generacy-ai/control-plane/dist/services/vscode-tunnel-manager.js').deriveTunnelName('325cdcb9-5b8e-45fc-a1bc-1ec8570d561d'))"` and compare the output to `g-325cdcb95b8e45fca1`.
- **Restart in 1.4 produces no doc change**: either the cluster did not re-register the tunnel (check the logs for a `code tunnel --name` invocation), or the cloud handler is write-once for that field. The second case is hypothesis #3's strong variant — escalate per FR-007.
- **Fresh deploy in Phase 4 still reproduces the bug**: the fix is not yet in the path you exercised. Confirm the tarball channel (preview vs stable) the deploy template pulled and re-verify Layer C.
- **Don't have SSH on the Droplet**: ask the operator who provisioned it for `cat /opt/generacy/.env` output and orchestrator logs. The investigation is read-only; SSH is convenient, not required.
