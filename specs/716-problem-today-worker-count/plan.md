# Implementation Plan: workers is per-host; CLI launch picks the count

**Feature**: Move worker count from project-level `cluster.yaml` to a per-host decision made at `generacy launch`, seeded into `cluster.local.yaml` on first orchestrator boot, and relayed to the cloud as `targetWorkers` via the device-flow activation payload.
**Branch**: `716-problem-today-worker-count`
**Date**: 2026-05-25
**Status**: Complete
**Spec**: [spec.md](./spec.md)
**Issue**: [#716](https://github.com/generacy-ai/generacy/issues/716)
**Companion**: [generacy-cloud#696](https://github.com/generacy-ai/generacy-cloud/issues/696) (stops the cloud from rendering `workers:` into `cluster.yaml`, adds `targetWorkers` cluster-doc field, exposes `tierCap` in launch-config, accepts `workers` on activation poll)

## Summary

Today `WORKER_COUNT` enters the cluster via two paths that both assume project-level provenance: the cloud worker renders `workers: N` into the committed `cluster.yaml`, and the CLI's `scaffolder.ts:75/88/102` hardcodes `1` for every fresh launch. Neither captures host capacity — a 16 GB laptop and a 64 GB workstation in the same project can't agree on one number. #709/#712 already established `cluster.local.yaml` as the runtime source of truth on the orchestrator side; this issue moves the *creation* of that overlay (and its first-boot env var) into the CLI launch flow and informs the cloud once at activation.

The change touches four code surfaces in this repo:
1. **Launch CLI prompt + flag**: `--workers=N`, interactive `p.select`-style prompt when TTY, no-TTY default-with-warning. Tier-cap from `LaunchConfig.tierCap` (cloud-supplied) with a baked-in fallback of `8` until the companion cloud field ships.
2. **Scaffolder env + compose**: write `WORKER_COUNT=N` (already in shape) plus add `GENERACY_INITIAL_WORKERS=N` to the orchestrator compose `environment:` block so the first-boot entrypoint can seed `cluster.local.yaml`.
3. **Activation poll body**: extend the device-flow `POST /api/clusters/device-code/poll` to include `workers` so the cloud sets `targetWorkers` once at activation. Orchestrator reads `GENERACY_INITIAL_WORKERS` from env, passes it through `activate()` into the poll body.
4. **(Documented, no code change in this repo)** entrypoint-orchestrator.sh seeds `.generacy/cluster.local.yaml` from `GENERACY_INITIAL_WORKERS` on first boot. That edit lives in the `cluster-base` repo and is a companion PR.

The CLI's `reconcileWorkerCount` (deriver from #708/#712) already reads `cluster.local.yaml` via `readMergedClusterConfig`. No deriver changes needed.

## Technical Context

**Language/Version**: TypeScript (Node >=22, ESM)
**Primary Dependencies**:
- `@clack/prompts` (CLI prompts — already used by `prompts.ts`)
- `zod` (schema validation for `LaunchConfigSchema` and the new `PollRequestSchema`/`tierCap` field)
- `commander` (CLI flag registration)
- `@generacy-ai/activation-client` (extend `pollDeviceCode` body signature)
- `@generacy-ai/config` (already used downstream — no surface change here)
**Storage**: Filesystem only — `.generacy/.env` (`WORKER_COUNT=N`), `.generacy/docker-compose.yml` (`GENERACY_INITIAL_WORKERS=N` env entry). `cluster.local.yaml` is written by the cluster-base entrypoint (companion repo, not modified here).
**Testing**: Vitest. New tests:
- `packages/generacy/src/cli/commands/launch/__tests__/worker-prompt.test.ts` (matrix from clarifications Q3/Q4/Q5)
- `packages/generacy/src/cli/commands/cluster/__tests__/scaffolder.test.ts` (add: `GENERACY_INITIAL_WORKERS` in compose env block; `WORKER_COUNT` reflects chosen value)
- `packages/activation-client/tests/client.test.ts` (extend: `pollDeviceCode` body carries `workers` when provided)
- `packages/orchestrator/tests/unit/activation/index.test.ts` (extend: `activate()` threads `initialWorkers` through to poller)
**Target Platform**: User developer machines running `npx generacy launch …`; orchestrator container running on first boot inside Docker.
**Project Type**: Single monorepo, four packages touched (`generacy`, `activation-client`, `orchestrator`, plus indirect read-only on `config`).
**Performance Goals**: N/A — interactive CLI command, one-shot per cluster.
**Constraints**:
- TTY detection via `process.stdout.isTTY` (Clack's `p.select` already handles it; we wrap with explicit check for the no-flag/no-TTY warning path).
- Tier-cap fallback to `8` must be **conservative**: reject `--workers=N` where `N > 8` when `launchConfig.tierCap` is absent. Warning logged on fallback use.
- Activation poll body change must be backward-compatible with cloud: `workers` is an optional integer field on the poll request body. Pre-companion cloud ignores it; post-companion cloud reads it. No protocol-version bump.
- No change to the deriver, the `@generacy-ai/config` schema, or `cluster.yaml`/`cluster.local.yaml` formats. (The local YAML schema already accepts `workers: z.number().int().min(1).optional()`.)
**Scale/Scope**: Per acceptance criteria, ~6 files edited, ~3 new test files. Net diff ~250 LOC including tests. No new packages, no dependency additions.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

No `.specify/memory/constitution.md` exists. CLAUDE.md governs:

- ✅ **Edits existing files**: Scaffolder, launch index, prompts file, activation-client client/types, orchestrator activation index. One new launch-side test file; one new prompts helper file (`worker-count-resolver.ts`) extracted to keep the launch action thin. No new packages.
- ✅ **No speculative abstractions**: The tier-cap fallback is a single constant + branch; the no-TTY warning is a single `process.stdout.isTTY` check + `console.warn` line. No "policy object" / strategy pattern.
- ✅ **No error handling for impossible states**: The `--workers=N` rejection above tier cap is a real boundary (user-supplied input). The TTY-absent path is a real boundary (CI). No defensive null-checks beyond Zod validation of `LaunchConfig.tierCap`.
- ✅ **No backwards-compat shims**: The poll body's `workers` field is purely additive on the wire; nothing in this repo special-cases its absence. The fallback `tierCap = 8` is a *forward*-compat shim (until the companion cloud field ships) — required per Q3 resolution, removed once the cloud exposes the real cap (tracked separately).
- ✅ **No documentation files unless needed**: This plan + research + data-model + quickstart are produced by the speckit workflow itself, not ad-hoc docs.
- ✅ **Single bundled change**: One PR covers CLI prompt, scaffolder, activation poll body, and orchestrator threading. Matches user preference for bundled feature PRs.

## Project Structure

### Documentation (this feature)

```text
specs/716-problem-today-worker-count/
├── spec.md              # Feature spec (read-only)
├── clarifications.md    # Q1–Q5 resolutions
├── plan.md              # This file
├── research.md          # Phase 0 decisions (Q1–Q5 → implementation choices)
├── data-model.md        # Entities: LaunchConfig.tierCap, PollRequestBody.workers, WorkerCountResolution
├── quickstart.md        # End-to-end verification: launch → scaffold → boot → activation
├── contracts/
│   ├── worker-count-resolver.md       # CLI prompt/flag/TTY resolution contract
│   ├── activation-poll-body.md        # Extended PollRequestSchema with workers field
│   └── scaffolder-env-compose.md      # GENERACY_INITIAL_WORKERS in compose; WORKER_COUNT in .env
├── checklists/          # (reserved; not populated by /plan)
└── tasks.md             # Generated by /speckit:tasks
```

### Source Code (repository root)

```text
packages/
├── generacy/                                                   # CLI package (@generacy-ai/generacy)
│   └── src/cli/commands/
│       ├── launch/
│       │   ├── index.ts                                       # MODIFIED — register --workers, call resolver, thread to scaffolder
│       │   ├── prompts.ts                                     # MODIFIED — add promptWorkerCount(tierCap, suggested)
│       │   ├── worker-count-resolver.ts                       # NEW — resolveWorkerCount(opts, launchConfig, isTTY) helper
│       │   ├── types.ts                                       # MODIFIED — LaunchOptions.workers?: number; LaunchConfigSchema.tierCap?: number
│       │   ├── scaffolder.ts                                  # MODIFIED — propagate chosen workers (already accepts the param; drop hardcoded 1)
│       │   └── __tests__/
│       │       └── worker-count-resolver.test.ts              # NEW — Q3/Q4/Q5 matrix
│       └── cluster/
│           ├── scaffolder.ts                                  # MODIFIED — scaffoldDockerCompose adds GENERACY_INITIAL_WORKERS to orchestrator env
│           └── __tests__/
│               └── scaffolder.test.ts                         # MODIFIED — assert GENERACY_INITIAL_WORKERS line; WORKER_COUNT propagation
├── activation-client/                                          # @generacy-ai/activation-client
│   └── src/
│       ├── client.ts                                          # MODIFIED — pollDeviceCode accepts optional workers, threads into request body
│       ├── types.ts                                           # MODIFIED — PollRequestSchema (new) with optional workers field
│       └── tests/
│           └── client.test.ts                                 # MODIFIED — assert request body carries workers when provided
└── orchestrator/                                              # @generacy-ai/orchestrator
    └── src/
        ├── activation/
        │   ├── index.ts                                       # MODIFIED — activate() accepts initialWorkers, threads into pollForApproval
        │   ├── poller.ts                                      # MODIFIED — PollOptions.workers optional, forwarded into pollDeviceCode
        │   ├── client.ts                                      # (re-export, unchanged)
        │   └── types.ts                                       # MODIFIED — ActivationOptions.initialWorkers?: number
        └── server.ts                                          # MODIFIED — read GENERACY_INITIAL_WORKERS from env, pass to activate()
```

**Structure Decision**: Multi-package edit within existing monorepo. The CLI surface gets one new helper module (`worker-count-resolver.ts`) to keep `launchAction()` from growing past its current ~150-line size; everything else is in-place edits. The activation-client is the protocol boundary — adding `workers` to the poll body there means both the orchestrator (this repo) and any future direct caller benefit without code duplication.

### Out-of-repo companion (documented only)

```text
cluster-base/                                                  # GitHub: generacy-ai/cluster-base
└── .devcontainer/generacy/scripts/
    └── entrypoint-orchestrator.sh                             # COMPANION — seed cluster.local.yaml from $GENERACY_INITIAL_WORKERS on first boot
```

```text
generacy-cloud/                                                # GitHub: generacy-ai/generacy-cloud
├── (companion #696) buildLaunchConfig                         # add tierCap field
├── (companion #696) device-code poll handler                  # read workers, set targetWorkers on cluster doc
└── (companion #696) cluster.yaml renderer                     # stop writing workers: line
```

## Complexity Tracking

No constitution violations to justify. The change adds one helper file and two protocol-additive Zod fields. The riskiest decision (Q3 fallback to `8`) is explicitly time-bounded and tracked for removal in a follow-up issue once the companion cloud field ships.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| (none) | — | — |
