# Research: Cloud cluster `vscodeTunnelName` projectId regression

**Feature**: 746-summary-cloud-deployed-cluster
**Status**: Complete
**Date**: 2026-06-03

This document captures the technology decisions, alternatives considered, and the FR-001 investigation plan (write-path trace) that gates all subsequent work.

---

## Decision 1 — Diagnosis-first, not code-first

**Decision**: Treat #746 as an investigation, not a code change. FR-001 (trace where `vscodeTunnelName` is written on the cloud cluster doc) is P0 and gates any in-repo edit (Q5=A).

**Rationale**:
- In-repo `deriveTunnelName` / `loadOptionsFromEnv` (`packages/control-plane/src/services/vscode-tunnel-manager.ts:64–88`) already key on `GENERACY_CLUSTER_ID` (UUID). The observed value `g-xr7fxq61pf57u2loto` cannot be produced by that function from the UUID `325cdcb9-…`.
- A patch here would be speculative and could mask the real cause.
- Cost of the investigation step is low (read-only); cost of fixing the wrong layer is high (wasted release, persistent collision risk).

**Alternatives considered**:
- *Patch first, investigate later.* Rejected — the in-repo function is verifiably correct on the UUID path, so any patch would be a workaround, not a fix.
- *Open a generacy-cloud issue immediately without a trace.* Rejected — the spec wants an evidence-backed diagnosis pointing at a specific layer, not a guess.

---

## Decision 2 — Verification by ONE fresh end-to-end deploy (SC-001), reasoning for SC-002

**Decision**: Confirm SC-001 by deploying exactly one fresh DigitalOcean cluster end-to-end and reading `vscodeTunnelName` from its Firestore doc. SC-002 (sibling distinctness) follows by argument from UUID uniqueness + per-UUID derivation.

**Rationale**: Q4=C. The bug is a code-vs-deploy mismatch — code looked correct but deployed behavior was wrong. Static inspection alone is insufficient. A second sibling deploy is unnecessary infrastructure spend; uniqueness is mathematically guaranteed once SC-001 is confirmed.

**Alternatives considered**:
- *Two sibling deploys (Q4=A).* Rejected — duplicate infra cost for no information gain beyond SC-001.
- *Static-only verification (Q4=B).* Rejected — explicitly identified as insufficient for this bug class.

---

## Decision 3 — No migration tooling; rely on restart self-correction

**Decision**: Existing cloud clusters auto-correct on next restart/activation via `loadOptionsFromEnv` re-deriving + #743 cluster-doc persistence writing the corrected name back. No CLI migration command, no operator playbook (Q2=B).

**Rationale**: `loadOptionsFromEnv` runs at boot; #743 persists the *actual* registered tunnel name into the cluster doc; once the upstream source-of-truth is corrected, the doc self-heals on the next restart. FR-007 keeps a conditional carve-out *only* if hypothesis #3 (stale cache surviving restart) turns out to be the root cause.

**Alternatives considered**:
- *No migration, leave existing clusters on projectId names (Q2=A).* Rejected — defeats the per-cluster isolation goal of #744 for any existing cluster.
- *Operator-triggered migration CLI (Q2=C).* Rejected — tooling overhead unjustified when restart suffices.

---

## Decision 4 — Stable-channel publish of #744 is out of scope

**Decision**: #746 closes once SC-001 is verified on the **preview** channel. Consuming `.changeset/feat-744-multi-cluster-cli.md` and publishing `@generacy-ai/control-plane@stable` is a separate release-engineering task (Q3=B). FR-008 flags the dependency on that task; #746 does not own it.

**Rationale**: Release cadence is orthogonal to this bug. Cloud-deploy uses preview tarballs at the moment, which is exactly where the bug surfaced and where the fix is verified.

**Alternatives considered**:
- *Block #746 on stable release (Q3=A).* Rejected — couples a bug fix to release cadence unnecessarily.
- *Conditional ownership (Q3=C).* Rejected — adds branching ownership rules with no benefit.

---

## Decision 5 — In-repo fix only if root cause is in `generacy`

**Decision**: If FR-001 traces the bug to an in-repo file, ship the fix here. If it traces to `generacy-cloud` (cloud-deploy template, relay handler that writes `vscodeTunnelName`) or to the `publish-preview` workflow, file a companion issue in the owning repo and ship only the diagnosis writeup from #746 (Q1=A).

**Rationale**: Automation can't span repos; #746 must close on its own merits. Diagnosis is the gating, valuable deliverable regardless of where the fix lives.

**Alternatives considered**:
- *End-to-end ownership including cross-repo PRs (Q1=B).* Rejected — out of scope for a single repo's issue.
- *Hybrid: leave #746 open until companion PRs land (Q1=C).* Rejected — adds tracking overhead with no benefit over a companion issue.

---

## FR-001 investigation — the write path of `vscodeTunnelName`

This is the gating P0 deliverable. The investigation is read-only and produces a written diagnosis. Three layers to inspect, in order:

### Layer A — Cluster process (in this repo)

- `packages/control-plane/src/services/vscode-tunnel-manager.ts`
  - `deriveTunnelName(clusterId)` strips hyphens, prefixes `g-`, slices first 18 hex chars. Verified UUID-keyed (line 64–71).
  - `loadOptionsFromEnv` reads `GENERACY_CLUSTER_ID` (line 81). Verified UUID-keyed.
  - Tunnel events emitted on `cluster.vscode-tunnel` via `getRelayPushEvent()`. Carries `tunnelName?: string` (actual, post-fallback).
- `packages/orchestrator/src/services/relay-bridge.ts` — `collectMetadata()` is the periodic heartbeat path; check whether it ships any `tunnelName` field today and what source it reads from.
- `packages/cluster-relay/src/messages.ts` — `EventMessage` and metadata payload shape (read-only; identify which channel/field carries the name to cloud).

**Probe inside the running Droplet** (manual, per quickstart.md):
1. `cat /opt/generacy/.env | grep GENERACY_CLUSTER_ID` — confirm the UUID is what the process sees (hypothesis #1).
2. `docker compose logs orchestrator | grep -iE 'tunnel|deriveTunnelName'` — confirm what name the cluster requested.
3. Inspect the preview tarball: `docker compose exec orchestrator node -e "console.log(require('@generacy-ai/control-plane/package.json').version)"` and `grep -n GENERACY_CLUSTER_ID node_modules/@generacy-ai/control-plane/dist/services/vscode-tunnel-manager.js` — confirm the published code actually has #744 (hypothesis #2).

### Layer B — generacy-cloud relay handler

- The relay receives `cluster.vscode-tunnel` events. The handler that persists `vscodeTunnelName` to `organizations/{orgId}/clusters/{clusterId}` is in `generacy-cloud`. Inspect:
  - Does the handler read `tunnelName` from the relay event payload, or does it compute `g-${projectId.slice(...)}` cloud-side?
  - Was the doc last written by a pre-#744 cluster process that registered under projectId, and is the handler write-once / merge-only?
- The cluster doc was also visible at deploy creation time (`preApproveActivationCode`); inspect whether that codepath seeds `vscodeTunnelName` before the cluster has registered.

### Layer C — publish-preview workflow

- `.github/workflows/publish-preview.*` (or equivalent in the `generacy-ai/control-plane` build pipeline) is manual `workflow_dispatch`. Confirm the dispatch ref for the `0.0.0-preview-20260603190235` tarball included #744's merge SHA `6f74140` (or a descendant).
- If the tarball was built from a ref *before* `6f74140`, the cluster has pre-#744 code despite the timestamp suggesting otherwise.

### Three hypotheses (from spec) — mapping to layers

| # | Hypothesis | Inspect | Disposition |
|---|------------|---------|-------------|
| 1 | Droplet env actually has projectId, not UUID | Layer A probe 1 | If true: fix is in `generacy-cloud` compose-template.ts (companion issue). |
| 2 | Preview tarball doesn't actually contain #744 | Layer A probe 3 + Layer C | If true: fix is in the release workflow / changeset (companion issue). |
| 3 | Stale/cached tunnel registration survives | Layer A logs + Layer B handler shape | If true: FR-007 — document the conditions; only build tooling if restart provably insufficient. |

A fourth possibility — cloud-side pre-computation of `vscodeTunnelName` from projectId — is surfaced by Layer B and is the one that, if true, makes the entire in-repo path moot.

---

## Implementation patterns

- **Atomic, reversible diagnosis**: write findings into `specs/746-…/research.md` as Layer A/B/C is investigated. Each layer's conclusion either pins or eliminates a hypothesis.
- **Cite line numbers** in `packages/control-plane/src/services/vscode-tunnel-manager.ts` for any in-repo claim — code may have moved since the spec was written.
- **Companion-issue boilerplate** (if Layer B or C): include observed UUID, observed tunnel name, expected tunnel name from `deriveTunnelName`, the trace step that pinned the layer, and a pointer to this `research.md`.

---

## Key sources / references

- Issue #744 — per-cluster (UUID) tunnel naming. Commit `6f74140` on `develop`.
- Issue #743 — control-plane reports *actual* registered tunnel name back to cloud. Underwrites FR-006's "self-correct on restart" guarantee.
- Issue #608 — `deriveTunnelName` origin (20-char limit for Microsoft tunnel service).
- Issue #618 — the pre-#744 projectId-derived design, intentionally chosen for stability across activations of a single cluster.
- generacy-cloud#792, generacy-cloud#795 — companion cloud-side per-cluster persistence (referenced by spec).
- File: `packages/control-plane/src/services/vscode-tunnel-manager.ts:64–88` (verified UUID-keyed).

---

## Investigation Log — Layer A code (T001)

**Date**: 2026-06-03. **Status**: Confirmed UUID-keyed.

`packages/control-plane/src/services/vscode-tunnel-manager.ts` on branch `746-summary-cloud-deployed-cluster` (post-#744):

- `deriveTunnelName(clusterId)` at lines **64–71**: strips hyphens, prefixes `g-`, slices first 18 chars, validates against `/^[a-z][a-z0-9-]{0,19}$/`. **Does NOT lowercase** its input.
- `loadOptionsFromEnv` at lines **73–89**: reads `env["GENERACY_CLUSTER_ID"]` (line 81), throws if missing, returns `{ binPath, tunnelName: deriveTunnelName(id) }`.

For `GENERACY_CLUSTER_ID = "325cdcb9-5b8e-45fc-a1bc-1ec8570d561d"`:
- `compact = "325cdcb95b8e45fcab1c343e849f0bb90"`
- `out = "g-325cdcb95b8e45fca1"` ← matches expected per spec.

**Implication**: the regressing value `g-xr7fxq61pf57u2loto` **cannot** be produced by this code from the UUID input. Layer A code is innocent on the UUID path. Hypothesis #2 (in-repo code wrong) is **eliminated** unless the running tarball is pre-#744 (separately tested by T003).

---

## Investigation Log — Layer C (T006)

**Date**: 2026-06-03. **Status**: Hypothesis #2 (Layer C — pre-#744 ref) ELIMINATED.

`gh run list --workflow=publish-preview.yml --repo generacy-ai/generacy` confirms the workflow run that produced `0.0.0-preview-20260603190235`:

- Run ID `26906597368`, started `2026-06-03T19:01:40Z`.
- **headSha `6f74140a01d60b291723799f7ae1828b7113e4b4` — exactly #744's merge SHA on `develop`.**
- Conclusion: `success`.
- Build time (workflow start → published `0.0.0-preview-20260603190235` timestamp 19:02:35Z) ≈ 55s, consistent with a normal `pnpm install + build + changeset version --snapshot + publish` cycle.

**Implication**: the published preview tarball at version `0.0.0-preview-20260603190235` provably contains #744's UUID-keyed `deriveTunnelName`. No earlier preview-published tarball can produce the observed lowercase regression value through the published code. **Hypothesis #2 (Layer C) is eliminated.**

(`@generacy-ai/control-plane` is a workspace package in this repo — the publish workflow lives in `.github/workflows/publish-preview.yml`. There is no separate `generacy-ai/control-plane` repo; a 404 confirms this.)

---

## Investigation Log — Layer B cloud handler (T005)

**Date**: 2026-06-03. **Status**: One write path, reads from event payload, NO cloud-side computation. One incidental concern noted (multi-cluster routing).

Inspected `generacy-ai/generacy-cloud` (HEAD `cc1fd7d`, `fix(relay): route control-plane requests by clusterId, not projectId (#795)`).

**Single write path** for `vscodeTunnelName` (`grep` across non-test code):

`services/api/src/services/relay/message-handler.ts:486–512` — the `cluster.vscode-tunnel` EventMessage handler:

```ts
if (message.event === 'cluster.vscode-tunnel' && this.db) {
  const tunnelData = (message.data ?? {}) as Record<string, unknown>;
  const status = tunnelData.status as string | undefined;
  if (status) {
    const update: Record<string, unknown> = { vscodeTunnelStatus: status };
    if (status === 'connected') {                          // ← gate
      update.vscodeTunnelConfigured = true;
      if (typeof tunnelData.tunnelName === 'string') {
        update.vscodeTunnelName = tunnelData.tunnelName;   // ← read from event
      }
      ...
    }
    resolveClusterDocRef(this.db, orgId, projectId)        // ← lookup by projectId
      .then((ref) => { if (ref) ref.update(update); })     // ← merge update
      ...
  }
}
```

Properties:
1. **No cloud-side computation** of `vscodeTunnelName` — the value is whatever the cluster sent in `data.tunnelName`. The pre-existing assumption (spec assumption #3) holds.
2. **`vscodeTunnelName` only updates when `status === 'connected'`** (line 491). Starting/authorization_pending/disconnected/error status payloads do NOT touch this field. Implication: a doc value can persist arbitrarily long if the cluster never re-reaches `connected`.
3. **`ref.update()` is merge-semantics** (Firestore: updates listed fields only, doesn't write-once-and-block). Not write-once.
4. **NO seed of `vscodeTunnelName` from `projectId`** at any other call site — verified by `grep -rn 'vscodeTunnelName\s*[:=]'` across non-test, non-spec code. Only:
   - schema definition (`packages/db/src/collections/clusters.ts:121`)
   - read-back converter (`packages/db/src/collections/clusters.ts:220`)
   - the handler above
   - SSE read endpoint (`services/api/src/routes/events/cluster.ts:112`)
   - web hooks (read-only)

**`resolveClusterDocRef` (separate concern)** at `services/api/src/services/relay/cluster-doc-resolver.ts:21–55`:

```ts
const querySnapshot = await collection
  .where('projectId', '==', projectId)
  .where('status', 'in', ['connecting', 'connected', 'starting'])
  .limit(1)
  .get();
```

Looks up the cluster doc by **`projectId`**, not by `clusterId`. With `limit(1)`. The handler writes to whichever cluster matches the `projectId` filter first — **not necessarily the cluster that emitted the event**. This is a latent multi-cluster routing bug but does **not** explain the observed regression because:

- Per `gh issue #746` evidence, only one cluster (`325cdcb9-...`) is in the project at observation time.
- A `limit(1)` of `where projectId == X` returns the only matching doc, which IS `325cdcb9-...`.

It will become relevant once #791/#792 multi-cluster is exercised — and is a candidate for a separate companion issue regardless of #746's outcome.

**`compose-template.ts` env var rendering** (`services/api/src/services/cloud-deploy/compose-template.ts:206`):

```
GENERACY_CLUSTER_ID=${input.clusterId}
```

`clusterId` flows from `provisionDroplet → preApproveActivationCode → activateCluster`, where post-#792 (`services/api/src/services/cluster-activation.ts:386`) it is `randomUUID()`. So on a post-#792 deploy, `GENERACY_CLUSTER_ID` in `/opt/generacy/.env` is the UUID. **Hypothesis #1's cloud-deploy variant (env template literally embeds projectId) is eliminated** — the code path puts the UUID there.

(Hypothesis #1's operational variant — env var on the running Droplet does not match the rendered template, e.g. manually edited, or set via a different path — remains untested without SSH probe T002.)

---

## Investigation Log — Timeline pins

Confirmed merge / publish timestamps (UTC):

| Time (UTC) | Event |
|------------|-------|
| 2026-06-03 19:01:40 | `publish-preview.yml` run #26906597368 starts on `6f74140` (#744 merge SHA). |
| 2026-06-03 19:02:35 | `@generacy-ai/control-plane@0.0.0-preview-20260603190235` published (post-#744). |
| 2026-06-03 19:19:43 | generacy-cloud#791 merges (`a7c0f90`) — touches `cluster-activation.ts` but does NOT change `clusterId` derivation (still legacy projectId-keyed at this point). |
| 2026-06-03 20:53:32 | generacy-cloud#792 merges (`ea24968`) — flips `clusterId = randomUUID()` (`cluster-activation.ts:386`). |
| 2026-06-03 21:51:34 | generacy-cloud#795 merges (`cc1fd7d`) — relay control-plane request routing fix. |

The regressing cluster's doc key `325cdcb9-5b8e-45fc-a1bc-1ec8570d561d` is UUID-shaped (not projectId-shaped), so **the cluster was provisioned after 20:53:32 UTC** — which is also after the post-#744 preview tarball was already published and post-#744 was the current `preview` dist-tag. Therefore, at first boot the cluster would have installed `0.0.0-preview-20260603190235` (post-#744) and would have had `GENERACY_CLUSTER_ID=<UUID>` in the rendered `.env`.

---

## Investigation Log — Hypothesis #1 (env var)

**Status**: Not yet probed on the live Droplet (T002 requires SSH access — not available from this workspace).

**What's known from code-only inspection**:
- The cloud-deploy template literally writes `GENERACY_CLUSTER_ID=${input.clusterId}` where `input.clusterId` is the UUID (timeline pin above). So the rendered `.env` should contain the UUID.
- However, this only proves what was *written at deploy time*. The live Droplet's running env (env file + env-overrides + manual edits) must still be probed.

**Probe still required** (T002 — operator action):
```bash
ssh <droplet>
grep -E '^GENERACY_(CLUSTER_ID|PROJECT_ID)=' /opt/generacy/.env
docker compose -f /opt/generacy/docker-compose.yml exec orchestrator printenv GENERACY_CLUSTER_ID
```

If both show UUID → hypothesis #1 fully eliminated. If either shows projectId → root cause pinned (and would imply something out of repo since rendered template puts UUID there).

---

## Investigation Log — Hypothesis #2 (tarball provenance)

**Status**: Eliminated *for the published tarball*. Not yet probed *for the actually-installed bytes on the Droplet*.

**What's known from code-only inspection**: see "Layer C (T006)" — the published tarball at version `0.0.0-preview-20260603190235` was built from `6f74140` (#744 merge SHA). The bytes in npm registry for that version are post-#744.

**Probe still required** (T003 — operator action):
```bash
docker compose -f /opt/generacy/docker-compose.yml exec orchestrator \
  node -e "console.log(require('@generacy-ai/control-plane/package.json').version)"
docker compose -f /opt/generacy/docker-compose.yml exec orchestrator \
  sh -c "grep -n 'GENERACY_CLUSTER_ID\|GENERACY_PROJECT_ID\|deriveTunnelName' \
    node_modules/@generacy-ai/control-plane/dist/services/vscode-tunnel-manager.js"
```

If installed version is `0.0.0-preview-20260603190235` AND the dist file reads `GENERACY_CLUSTER_ID` (not `GENERACY_PROJECT_ID`) → hypothesis #2 fully eliminated.

---

## Investigation Log — Cluster request trace (T004 probe)

**Status**: Not yet probed (requires Droplet log access).

**Probe still required** (T004 — operator action):
```bash
docker compose -f /opt/generacy/docker-compose.yml logs orchestrator control-plane \
  | grep -iE 'tunnel.*name|deriveTunnelName|code tunnel --name|vscode-tunnel'
```

What to look for in the log output:
- `code tunnel --name <X>` invocation: that's the **requested** name.
- `cluster.vscode-tunnel` event payload with `status: 'connected'` and `tunnelName: <Y>`: that's the **actual registered** name (per #743 — `actualTunnelName` parsed from the `vscode.dev/tunnel/<...>` URL).

The interesting cases:
- Requested = `g-325cdcb95b8e45fca1` AND actual = `g-325cdcb95b8e45fca1` → cluster process is correct; doc is wrong due to either (a) a `connected` event never landed cloud-side, or (b) the doc was last written by a pre-#744 cluster process and never overwritten. Hypothesis #3 territory.
- Requested = `g-xr7fxq61pf57u2loto` directly → in-process code is using projectId despite installed tarball being post-#744 (running process predates package update). Restart fixes it.
- Requested = `g-325cdcb95b8e45fca1` but actual = `g-xr7fxq61pf57u2loto` → Microsoft tunnel service returned a pre-existing tunnel under the same auth (interesting cache/auth-binding behavior). Document under FR-007.

---

## Diagnosis (T007) — partial

Pinned to the extent possible without live Droplet access:

**Eliminated**:
- ✗ Layer A code is wrong (T001 ✓).
- ✗ Layer C published tarball is pre-#744 (T006 ✓).
- ✗ Cloud-deploy compose-template embeds projectId in `GENERACY_CLUSTER_ID` (T005 partial — code reading ✓).
- ✗ Cloud-side computes `vscodeTunnelName` from `projectId` (T005 ✓ — handler reads from event payload only).
- ✗ Cloud-side seeds `vscodeTunnelName` at activation time (T005 ✓ — no such seed call site exists).

**Still possible (requires live probe to discriminate)**:
1. **Running orchestrator process is pre-#744 even though installed tarball is post-#744** — entrypoint installs `@preview` on every boot, but the running Node process holds whatever code was loaded at *its* boot time. If the cluster booted from a pre-#744 preview tarball at some point and was never restarted (only the on-disk tarball was refreshed), the running code is older than `package.json` suggests. Restart fixes. **T003 + T004 combined would expose this.** (Note: per the timeline pin, this requires the cluster's first boot to predate 19:02:35 UTC — but the UUID-shape doc key requires provisioning after 20:53 UTC, contradicting this. So this hypothesis is *only* viable if the cluster was provisioned post-#792 with a pre-#744 tarball, which the timeline forbids unless a `@preview` dist-tag rollback occurred. **Currently the lowest-probability remaining hypothesis.**)
2. **`GENERACY_CLUSTER_ID` env on the live Droplet is `Xr7fxq61PF57U2lOtoKe` despite the deploy template writing the UUID** — could result from a manual edit, a different override path (e.g. `.env.local`), or a bug in env propagation. **T002 + T003 (`docker compose exec orchestrator printenv GENERACY_CLUSTER_ID`) discriminates directly.** If so: companion issue in `generacy-cloud` is unlikely (the template code is correct); rather, an operational forensic on the specific Droplet.
3. **Microsoft tunnel service returned a pre-existing tunnel registration** under the post-#744 auth, with `actualTunnelName = g-xr7fxq61pf57u2loto`. This is the most surprising hypothesis but consistent with the lowercase-projectId-shape value not being producible by post-#744 code. **T004 (request vs actual name in logs) discriminates.** If so: FR-007 territory — document the condition, and (likely) the cluster needs to `code tunnel unregister --name g-xr7fxq61pf57u2loto` before re-registering. The existing `unregister()` method in `vscode-tunnel-manager.ts:284` covers this, but it's only invoked on `generacy destroy`, not at restart.
4. **The cloud doc value is stale from a pre-#744 era write that the post-#744 cluster has never overwritten** — i.e., no `connected` event has landed cloud-side since the cluster started speaking #744. Per Layer B finding, `vscodeTunnelName` only updates on `status === 'connected'`. If the post-#744 cluster's tunnel keeps failing to reach `connected`, the cloud doc value would persist indefinitely. **T004 (does `cluster.vscode-tunnel: connected` ever fire?) discriminates.** Note this would also require a pre-#744 cluster to have ever existed for this projectId/UUID combo, which the UUID-shape doc-key timeline complicates. **T014 (restart self-correction test) is the natural escalation.**

**Layer pinned by elimination**: not Layer A, not Layer C. Either Layer B (`generacy-cloud` — operational forensics on the specific Droplet) or stale cache on Layer A's runtime (FR-007). **Cannot pin to a single Layer without the three live-Droplet probes (T002/T003/T004).** The decision gate (T008) is therefore **blocked on operator action**.

---

## Companion Issues

(None filed yet — pending T008 decision after T002/T003/T004 complete.)
