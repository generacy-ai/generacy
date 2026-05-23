# Quickstart: Verify worker-scale no longer dirties git

## Prerequisites

- A running Generacy cluster from a `cluster-base` or `cluster-microservices` image that includes the companion `.gitignore` PR. (Pre-companion-PR clusters work but `cluster.local.yaml` will not yet be `.gitignore`d.)
- Cloud UI access or direct control-plane Unix-socket access to issue `worker-scale` lifecycle actions.

## Verifying the fix

### 1. Clean tree before scaling

```bash
cd ~/Generacy/<your-project>
git status
# Expected: nothing to commit, working tree clean
cat .generacy/cluster.yaml
# Expected: workers: 1   (or whatever the template default is)
ls .generacy/cluster.local.yaml 2>/dev/null || echo "(local file not present yet — correct)"
```

### 2. Trigger a scale

From the Generacy cloud UI: scale the worker count to 3 (or any value != current).

Equivalent direct call (inside the orchestrator container):
```bash
curl -X POST --unix-socket /run/generacy-control-plane/control.sock \
  http://localhost/lifecycle/worker-scale \
  -H 'content-type: application/json' \
  -d '{"count": 3}'
```

### 3. Verify acceptance criteria

```bash
git status
# Expected: nothing to commit, working tree clean
#           (was previously dirty on .generacy/cluster.yaml)

cat .generacy/cluster.yaml
# Expected: workers: 1   (UNCHANGED — still the template default)

cat .generacy/cluster.local.yaml
# Expected: workers: 3
```

The git-tracked `cluster.yaml` is untouched. The new `cluster.local.yaml` carries the runtime value.

### 4. Verify merged-read semantics

The cloud UI's cluster-config view should show `workers: 3` (the runtime value), not `1`. This proves the read-side merge is wired correctly through `relay-bridge.readClusterYaml()`.

### 5. Verify upstream merge does not conflict

```bash
git pull origin main
# Expected: no conflict on .generacy/cluster.yaml even though cluster.local.yaml differs from template default
```

## Running the test suite

### Helper unit tests

```bash
pnpm --filter @generacy-ai/config test
```

Expected: tests covering empty-both, canonical-only, local-only, both-disjoint, both-overlapping-with-local-winning, and malformed-YAML-throws all pass.

### Worker-scaler tests

```bash
pnpm --filter @generacy-ai/control-plane test -- worker-scaler
```

Expected: existing assertions on post-scale state now read from `cluster.local.yaml`. New negative assertion: `cluster.yaml` content is byte-identical pre- and post-scale.

### Relay-bridge tests

```bash
pnpm --filter @generacy-ai/orchestrator test -- relay-bridge
```

Expected: metadata-collection tests covering fixture with `cluster.local.yaml` override pass.

### App-config tests

```bash
pnpm --filter @generacy-ai/control-plane test -- app-config
```

Expected: existing tests pass unchanged; new regression confirms `cluster.local.yaml` without `appConfig` doesn't hide `cluster.yaml`'s `appConfig`.

## Migrating an existing project

**No migration action is required.** Per Q3=A, an existing project with a pre-fix mutated `cluster.yaml workers:` value continues to behave correctly under local-wins semantics: the first post-fix scale writes the new count to `cluster.local.yaml`, and that value wins. The stale `cluster.yaml workers:` value is documentation noise only.

If you want a clean documentation state, you may manually reset `cluster.yaml workers:` to the template default (typically `1`) and commit. This is optional and does not affect runtime behavior.

## Troubleshooting

### `cluster.local.yaml` shows up in `git status`

The companion `.gitignore` PR has not yet landed in your cluster image. Either:
- Update to a cluster-base/microservices image that includes the `.gitignore` change.
- Manually add `cluster.local.yaml` to your project's `.gitignore` until the upstream change reaches your channel.

### Cloud UI shows old worker count after scale

Two failure modes:
1. **Metadata refresh did not fire**: confirm orchestrator log emitted "metadata refresh triggered" after the scale.
2. **Helper read the wrong file**: confirm `.generacy/cluster.local.yaml` exists and contains the new count. Confirm `.generacy/cluster.yaml` is parseable YAML (helper throws on malformed YAML — won't silently fall back).

### Scale succeeds but `cluster.local.yaml` is empty / not created

Check the orchestrator log for an atomic-write failure on `.generacy/`. The temp+rename pattern requires the directory to be writable by the orchestrator UID — same precondition that worker-scaler's previous `cluster.yaml` write needed. No new failure modes here.

### App-config endpoint stops returning the manifest

Confirm `cluster.yaml` is parseable. The helper throws on malformed YAML rather than silently returning `null` (intentional — see plan.md "Risks & Mitigations"). Previous behavior on a malformed file was an opaque crash; new behavior is an explicit error message naming the file.
