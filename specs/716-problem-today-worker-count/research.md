# Research: workers is per-host; CLI launch picks the count

**Issue**: [#716](https://github.com/generacy-ai/generacy/issues/716)
**Branch**: `716-problem-today-worker-count`

Each decision below cross-references a clarification (Q1–Q5) or a structural constraint that fell out of the codebase audit.

## Decision 1 — Activation-complete payload carries `workers` (resolves Q1)

**Decision**: Extend `pollDeviceCode(cloudUrl, deviceCode, httpClient, workers?)` in `@generacy-ai/activation-client` to accept an optional `workers` integer and include it in the request body as `{ device_code, workers? }`. Orchestrator's `activate()` reads `GENERACY_INITIAL_WORKERS` from env and threads it through `pollForApproval` → `pollDeviceCode`.

**Rationale**:
- Q1 resolved B (activation-complete payload, not metadata push). The poll endpoint is the natural place to declare the launch-time intent.
- `metadata.workers` (#714) reports observed running count — that's a *state* push pipeline, not a declarative one. Conflating intent and state in one channel is the failure mode we explicitly rejected.
- Cloud sets `targetWorkers` once at activation. Subsequent scale operations mutate it via `PATCH /clusters/:clusterId/workers` (existing path). No drift to reconcile after activation, so no need to keep pushing on every metadata heartbeat.
- The poll body is the right protocol surface because (a) it already runs once per activation, (b) it already terminates with `cluster_api_key` issuance which logically defines "activation moment", (c) it's already JSON-encoded by `NativeHttpClient.post`, so adding an optional field is a one-line schema bump.

**Alternatives considered**:
- A (metadata push): rejected per Q1 — conflates declared intent with observed state, requires cloud-side reconcile logic for a value that doesn't actually drift.
- C (both): rejected — solves a non-problem (drift). Adds protocol surface area for no operational gain.

**Sources**:
- `packages/activation-client/src/client.ts:125-140` — current `pollDeviceCode` shape (body is `{ device_code }` only).
- `packages/orchestrator/src/activation/index.ts:78-86` — current `pollForApproval` call site.
- `specs/716-problem-today-worker-count/clarifications.md` Q1.

## Decision 2 — CLI is the single point of decision; launch-config carries only the cap (resolves Q2)

**Decision**: `LaunchConfig` adds an optional `tierCap: number` field (set by the companion cloud PR). The CLI prompts for `workers` always (host-side), using `tierCap` only as the upper bound on input validation. The cloud's "Run on my computer" page does not prompt.

**Rationale**:
- Q2 resolved A (CLI-side only). The host owns the decision because the host knows its own RAM/CPU/disk.
- Options B and C invert that and create an undefined-behavior case: user picks 8 in the cloud UI on a 4 GB Chromebook. Either silently downgrade (hostile, hidden) or hard-reject (forces a round-trip through the cloud UI). Neither is good UX.
- A single source of truth for the value also keeps the data flow linear: cloud → tierCap → CLI prompt → user-chosen N → `.env` + `cluster.local.yaml` (via entrypoint) + activation poll body → cloud `targetWorkers`. No fanout, no merge.

**Alternatives considered**:
- B (cloud-side hint, CLI override): two prompts for the same value; users hit the second one after already answering the first; awkward defaults to keep in sync.
- C (cloud-side authoritative): silently-downgrade or hard-reject (see above).

**Sources**:
- `packages/generacy/src/cli/commands/launch/types.ts:47-64` — `LaunchConfigSchema` (where `tierCap?: number` is added).
- `specs/716-problem-today-worker-count/clarifications.md` Q2.

## Decision 3 — Tier-cap fallback to baked-in constant `8` (resolves Q3)

**Decision**: `tierCap = launchConfig.tierCap ?? CLI_FALLBACK_TIER_CAP` where `CLI_FALLBACK_TIER_CAP = 8`. When the fallback is used, emit a one-line warning via Clack (`p.log.warn`) at INFO level once per launch. Track removal of the fallback in a follow-up issue (filed once the cloud companion ships).

**Rationale**:
- Q3 resolved C (conservative baked-in cap).
- Decouples this CLI feature's release schedule from the companion cloud field's release schedule. The two issues can land in either order without breaking the user-facing flow.
- `8` is the right conservative value because (a) `1` would be hostile to plus-tier users who got past the launch-config-missing window, (b) `100` would let CI scripts melt unsuspecting hosts, (c) `8` covers Pro / Team tiers' historical caps without exceeding what a typical 32 GB dev box can sustain.
- The warning text makes the limitation visible so users on higher-tier orgs know to either wait for cloud companion or contact support.

**Alternatives considered**:
- A (hard prereq): unnecessarily couples release schedules; this issue's value is independent of the companion's existence.
- B (no-cap fallback): explicitly dangerous — `--workers=100` would attempt to schedule 100 worker containers; Docker would OOM the host before failing.

**Sources**:
- `packages/generacy/src/cli/commands/launch/types.ts:47-64` — schema location.
- `specs/716-problem-today-worker-count/clarifications.md` Q3.

## Decision 4 — Constant `2` as v1 `suggestedFromHost` (resolves Q4)

**Decision**: Default at the prompt = `min(tierCap, 2)`. Implemented as a single `Math.min(tierCap, SUGGESTED_FROM_HOST)` call with `SUGGESTED_FROM_HOST = 2` declared next to `CLI_FALLBACK_TIER_CAP`.

**Rationale**:
- Q4 resolved B (constant 2).
- A (1) preserves today's behavior, but today's behavior is exactly the bug — 1 is the legacy hardcoded default in `scaffolder.ts:75`, not a deliberate floor.
- C (`min(os.cpus().length, 4)`) is reasonable but introduces a runtime dependency on host inspection; that path belongs in the follow-up resource-aware-defaults issue (cf. spec "Out of scope").
- Final default: `1` on Free (tierCap=1 hypothetical), `2` everywhere the cap is ≥ 2. Single source line: `const defaultWorkers = Math.min(tierCap, 2)`.

**Alternatives considered**:
- See clarifications.md Q4 options A and C.

**Sources**:
- `packages/generacy/src/cli/commands/launch/scaffolder.ts:75,88,102` — current hardcoded `workers: 1` sites.
- `specs/716-problem-today-worker-count/clarifications.md` Q4.

## Decision 5 — No-TTY default with prominent warning (resolves Q5)

**Decision**: When `process.stdout.isTTY` is falsy AND `opts.workers` is undefined, skip the prompt entirely, use `defaultWorkers = min(tierCap, 2)`, and emit a stderr warning before scaffolding begins:

```text
No TTY detected and --workers not provided. Defaulting to <N> workers.
For reproducible scripted launches, pass --workers=<N> explicitly.
```

**Rationale**:
- Q5 resolved C (default with warning).
- A (hard error) breaks scripted launches (`docker compose run -i …`, CI provisioners), which is a known supported path.
- B (silent default) hides important info from CI logs; the user only finds out by noticing their cluster booted with fewer workers than expected.
- C lets the script succeed while leaving a clear breadcrumb. The warning text explicitly recommends the flag for reproducibility, addressing the "why didn't I get N workers?" support case.

**Alternatives considered**:
- See clarifications.md Q5 options A and B.

**Sources**:
- `packages/generacy/src/cli/commands/launch/prompts.ts:36-48` — `promptClaimCode` shows the existing Clack pattern; the new `promptWorkerCount` follows the same shape and gates on `isTTY`.
- `specs/716-problem-today-worker-count/clarifications.md` Q5.

## Decision 6 — `GENERACY_INITIAL_WORKERS` lives in the orchestrator service's compose `environment:` block (not `.env`)

**Decision**: Add a literal `GENERACY_INITIAL_WORKERS=${WORKER_COUNT}` line to the orchestrator service's `environment:` array in `scaffoldDockerCompose`. The value source-of-truths to the `WORKER_COUNT` from `.env` via compose's `${VAR}` interpolation, so there's one canonical write-site (`.env`) but two consumers (compose `replicas` and the orchestrator entrypoint).

**Rationale**:
- The spec explicitly says "An env var passed into the orchestrator container … in the same compose `environment:` block." Putting it as a literal `WORKER_COUNT=N` in `.env` and *also* exposing it as `GENERACY_INITIAL_WORKERS` inside the container keeps the two names distinct: `WORKER_COUNT` is a compose-level concern (replica count), `GENERACY_INITIAL_WORKERS` is an in-container signal (seed `cluster.local.yaml` on first boot only).
- Using compose interpolation (`${WORKER_COUNT}`) means the user's manual edit to `.env` propagates to both consumers on the next `docker compose up`, without the scaffolder having to write the value twice (which would risk drift).
- Naming distinction is intentional: future tooling can mutate `WORKER_COUNT` (scale ops, the existing worker-scaler) without confusing it with a "did the entrypoint already seed `cluster.local.yaml`?" signal.

**Alternatives considered**:
- Single env var `WORKER_COUNT` used for both purposes: rejected because the entrypoint needs an *idempotency* signal ("only seed `cluster.local.yaml` if absent"), and conflating that with the compose-level replica count means subsequent boots (with scale changes) would re-trigger seed logic. Distinct names make the entrypoint's idempotency rule trivially correct: "if `$GENERACY_INITIAL_WORKERS` is set AND `cluster.local.yaml` doesn't exist, write the file."
- Pass via `--env GENERACY_INITIAL_WORKERS=N` at `docker compose up`: rejected because lifecycle commands (`generacy up`) re-run compose without the override flag.

**Sources**:
- `packages/generacy/src/cli/commands/cluster/scaffolder.ts:184-189` — orchestrator service's `environment:` array.
- `packages/generacy/src/cli/commands/cluster/scaffolder.ts:209-211` — worker service's `deploy.replicas: ${WORKER_COUNT:-1}`.
- Spec section "1. CLI launch picks the worker count" (paragraph following the `--workers=4` example).

## Decision 7 — No changes to `worker-count-deriver` or `@generacy-ai/config` schemas

**Decision**: `ClusterLocalYamlSchema.workers` already exists (`z.number().int().min(1).optional()`); `readMergedClusterConfig` already implements local-wins; `reconcileWorkerCount` (post-#712) already reads the merged view. No edits in this issue.

**Rationale**:
- All three were landed by #708/#709/#712. They're already in the shape this issue requires.
- Acceptance criterion #6 ("metadata payload reports the right worker count regardless of whether the value lives in `cluster.yaml` (legacy), `cluster.local.yaml` (new), or both (transition)") is satisfied by the existing local-wins semantics. No code change makes this true that isn't already true.
- The "legacy tolerance" path (un-migrated projects with `workers:` still in `cluster.yaml`) is handled for free: the entrypoint's idempotency check (`only write cluster.local.yaml if absent`) means existing projects keep using `cluster.yaml.workers` until the cloud scaler's first scale op writes the overlay, at which point local-wins takes over. Clean transition with no migration step.

**Sources**:
- `packages/config/src/cluster-config-schema.ts:14-20` — `ClusterLocalYamlSchema`.
- `packages/config/src/cluster-config.ts:59-76` — `readMergedClusterConfig`.
- `packages/generacy/src/cli/commands/cluster/worker-count-deriver.ts:133-185` — async merged-read path (post-#712).

## Decision 8 — Companion repo work is out of scope but tracked in the plan

**Decision**: The entrypoint changes in `cluster-base` (`entrypoint-orchestrator.sh` first-boot seed) and `cluster-microservices` (sync from cluster-base) are companion PRs filed against those repos, not edits in this PR. Their behavior is described in the spec and quickstart so reviewers/testers can verify the end-to-end loop, but this issue ships green even before they land — the env var is just unused until the entrypoint reads it.

**Rationale**:
- Spec section "5. Cloud relays the chosen value at activation time" and "Companion" both make landing-order independence an explicit goal.
- Keeps PR review scope tight; cluster-base PRs have a different reviewer rotation.
- The orchestrator container's `environment:` declaration of `GENERACY_INITIAL_WORKERS` is harmless when the entrypoint doesn't yet read it; the var sits in the environment, no consumer, no effect.

**Sources**:
- Spec section "Companion".
- Recent precedent: PRs #582, #584, #586 all referenced companion `cluster-base` changes without including them in the generacy-side diff.

## Decision 9 — Tests use Vitest with mocked HTTP client; no live cloud calls

**Decision**: All new tests inject the existing `HttpClient` interface (already used in `activation-client/tests/`). No integration tests against a real cloud; no Docker-in-Docker in CI. Manual quickstart covers the end-to-end loop.

**Rationale**:
- Matches existing test architecture in `packages/activation-client/tests/` and `packages/orchestrator/tests/unit/activation/`.
- The interesting failures are at the protocol boundary (does the body contain `workers`?) and the resolver boundary (does Q3 fallback engage when expected?), both unit-testable.
- End-to-end coverage already exists via the orchestrator's `tests/integration/activation*.test.ts` (no change required) and the quickstart steps.

**Sources**:
- `packages/activation-client/src/types.ts:57-59` — `HttpClient` interface used by existing tests.
