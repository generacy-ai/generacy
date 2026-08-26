---
sidebar_position: 4
---

# Review / Remediate Rollout Checklist

A repo-agnostic checklist for rolling the review ⇄ remediate flow out to a
cluster. Replace `<CANARY-REPO>` with the repository you canary on — do not
hard-code a specific repo into your process.

## Why the order matters

Clusters pick up new `@channel` packages **on boot** — the entrypoint re-pulls
them when the container starts. They do **not** pick up new packages via
`generacy update`, and a newly rolled-out package does **not** affect a Claude
session that is already in flight. So the rollout has to publish first, then
restart from the bottom up, then start a genuinely fresh session.

:::warning `generacy update` is NOT sufficient
`generacy update` does not deliver a new `@channel` package to a running cluster.
You must restart the cluster (and its workers) so the entrypoint re-pulls, then
begin a fresh Claude session. Skipping the restart leaves the old code running.
:::

## Checklist

1. **Publish the `@channel` packages.** Cut and publish the release for the
   channel your cluster tracks (e.g. `@preview` / `@stable`).
2. **Restart the cluster.** This forces the entrypoint to re-pull the just-published
   packages.
3. **Restart the workers.** Workers must restart to load the new package too — a
   cluster restart alone does not re-pull inside long-lived worker processes.
4. **Start a fresh Claude session.** An in-flight session keeps running the code it
   started with; only a new session picks up the rolled-out behavior.

## Canary

Before enabling the flags fleet-wide:

- Turn on `WORKER_REVIEW_PHASE_ENABLED` (and, if adopting the CI gate,
  `WORKER_CI_MERGE_GATE_ENABLED`) on a cluster scoped to `<CANARY-REPO>` only.
- Drive one real story through `implement → review ⇄ remediate → validate → final
  gate → merge` and confirm the gate labels appear and clear as expected.
- Watch for the `waiting-for:remediation-limit`, `waiting-for:ci`, and relocated
  `implementation-review` gates behaving as documented in the
  [migration guide](./review-remediate-migration.md#5-gate-semantics).

## Rollback

The flow is gated entirely behind the two feature flags. To revert to the
pre-epic behavior, flip both **off** and restart:

- `WORKER_REVIEW_PHASE_ENABLED=false`
- `WORKER_CI_MERGE_GATE_ENABLED=false`

With both off, the run sequence and observable behavior are byte-identical to the
pre-epic flow — no config or label cleanup is required. Restart the cluster and
workers so the change takes effect, then start a fresh session.
