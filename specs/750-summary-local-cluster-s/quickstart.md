# Quickstart: Identity-Split Detection

## What this delivers

After this change, an orchestrator that boots with a mismatched `GENERACY_CLUSTER_ID` (env) vs persisted `cluster.json.cluster_id` will:
1. Emit one `cluster.identity-split` relay event on startup.
2. Continue running normally.
3. NOT mutate any local state.

The cloud UI (delivered in the parallel cloud companion) will consume the event and prompt the user to destroy + re-launch the cluster.

## Files changed

| File | Change |
|------|--------|
| `packages/orchestrator/src/services/identity-split-detector.ts` | NEW: `detectIdentitySplit()` + once-per-process guard + `resetIdentitySplitDetectionState()` test helper |
| `packages/orchestrator/src/server.ts` | MODIFIED: invoke detector after relay bridge starts (both startup paths) |
| `packages/orchestrator/src/routes/internal-relay-events.ts` | MODIFIED: add `'cluster.identity-split'` to `ALLOWED_CHANNELS` |
| `packages/orchestrator/src/__tests__/identity-split-detector.test.ts` | NEW: unit tests covering all `DetectionOutcome` branches + once-only emission |
| `packages/generacy/src/cli/commands/launch/__tests__/scaffolder.test.ts` | MODIFIED (verification gate for FR-001): assert `scaffoldEnvFile` writes `config.clusterId` to `GENERACY_CLUSTER_ID` verbatim |

## Local manual verification

### Setup (simulate a split)

1. Launch a local cluster with the existing flow (`generacy launch --claim=...`).
2. Wait for activation to complete.
3. Tear down: `generacy stop`.
4. Manually edit `~/Generacy/<project>/.generacy/.env` and set `GENERACY_CLUSTER_ID` to a different UUID than the value in `~/Generacy/<project>/.generacy/cluster.json` (or — simpler — leave them out of sync from an earlier mismatched session).
5. Note: `cluster.json` in `.generacy/` is host-side; the orchestrator reads from `/var/lib/generacy/cluster.json` inside the container. Use whichever flow you have for surfacing a mismatch in the container's persisted file.
6. Bring the cluster back up: `generacy up`.
7. Tail the relay client side for the event.

### Expected behavior

- On orchestrator boot, the logs include a single `info` line documenting the detection (e.g. `Identity-split detected: env=<id1> cluster.json=<id2>`).
- A single `cluster.identity-split` event traverses the relay.
- Orchestrator stays up. `/health` returns 200.
- `~/Generacy/<project>/.generacy/.env`, `~/Generacy/<project>/.generacy/cluster.json`, and the in-container `/var/lib/generacy/cluster.json` are byte-equal to their pre-boot state.

### Tests

Run the orchestrator unit tests:
```bash
pnpm --filter @generacy-ai/orchestrator test identity-split-detector
```

Run the launch verification gate:
```bash
pnpm --filter @generacy-ai/generacy test scaffolder
```

## Quick reference: when is detection skipped?

| Condition | Behavior |
|-----------|----------|
| `process.env.GENERACY_CLUSTER_ID` is unset | Skip. Return `{ kind: 'no-env' }`. No event. |
| `cluster.json` is missing or schema-invalid | Skip. Return `{ kind: 'no-cluster-json' }`. No event. |
| Both present, ids equal | Skip. Return `{ kind: 'match' }`. No event. |
| Both present, ids differ, first call | Emit event. Return `{ kind: 'mismatch', emitted: true }`. |
| Both present, ids differ, subsequent calls | Skip emission (once-flag). Return `{ kind: 'mismatch', emitted: false }`. |
| `sendRelayEvent` callback throws | Log error, swallow. Once-flag still flipped (single attempt counts). |

## Cloud companion issue (must be filed)

Per FR-006, before this lands, file a `generacy-ai/generacy-cloud` companion issue:
- **Title**: "Device-code activation must reuse claim's clusterId instead of minting a fresh UUID"
- **Body**: cross-reference this issue (#750), spec section "Root cause (clarified)", cite `services/api/src/services/cluster-activation.ts:385-386` as the mint site to fix.
- **Linked**: this issue (#750), #744, generacy-cloud#792 / #796 / #801.

## Troubleshooting

### "I expect to see the event but the relay is silent"
Check:
1. The orchestrator's relay bridge has actually connected (look for `[relay] connected` log).
2. `cluster.json` exists at `/var/lib/generacy/cluster.json` inside the container.
3. `GENERACY_CLUSTER_ID` is actually set in the container's process env (not just on the host).
4. The two ids genuinely differ (compare via `docker compose exec orchestrator env | grep GENERACY_CLUSTER_ID` and `docker compose exec orchestrator cat /var/lib/generacy/cluster.json`).

### "Event fires every time the relay reconnects"
Bug — file a regression issue. The module-level `hasEmitted` flag should prevent this. Check the call site in `server.ts` is not constructing a fresh module load per reconnect (it shouldn't, but if a future refactor moves detection into a reconnect callback, the once-guard would need to move with it or be persisted).

### "Event fires every container restart"
Expected. Container restart = fresh process = fresh module = flag reset. This is by design: one event per container boot is the right signal for the cloud UI.

### "My fresh cluster shows identity-split immediately"
The cloud companion has not yet landed. Verify your cloud is running a version that includes the device-code → claim-id reuse fix. Until then, every fresh local launch will trip the detector. (This is exactly why we ship detection in this issue — to surface the bug to users while the cloud companion lands.)
