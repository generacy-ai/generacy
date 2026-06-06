# Implementation Plan: JIT GH-CLI Token Provider

**Feature**: Replace static `wizard-credentials.env` `GH_TOKEN` with a JIT installation-token provider for every `gh`-CLI consumer (worker `ClaudeCliWorker`, orchestrator label monitor / label sync / PR-feedback handler / webhook setup), eliminating the ~1h GitHub API 401 cliff.
**Branch**: `773-severity-high-issue-processing`
**Date**: 2026-06-05
**Spec**: [spec.md](./spec.md) | **Clarifications**: [clarifications.md](./clarifications.md)
**Status**: Complete

## Summary

Issue processing dies after ~1h because every `gh` CLI call rides a static `GH_TOKEN` written once by the wizard to `/var/lib/generacy/wizard-credentials.env`. The JIT migration in #766/#819 fixed *git*, not `gh`. This PR extends the JIT path to `gh`: a `JitGitTokenClient` extracted into `@generacy-ai/control-plane` (the package that already owns the `POST /git-token` route) is consumed by two layers — `git-credential-generacy` (existing, no caching) and a new orchestrator/worker-side `createJitGithubTokenProvider()` (new, with in-process pre-expiry cache). The provider auto-resolves the right Unix socket per container (`GIT_TOKEN_SOCKET_PATH` in workers via the #768 proxy, `CONTROL_PLANE_SOCKET_PATH` in the orchestrator via the direct socket), throws a typed `JitTokenError` on failure, and reports `{ ok: false, statusCode: 503 }` to the existing `AuthHealthSink` so the #762 backstop fires immediately instead of waiting for a `gh` 401. Existing `wizardCredsTokenProvider` wiring at `server.ts:160` / `:207` / `:298` / `:335` / `:363` / `:616` is replaced; `wizard-creds-token-provider.ts` and its tests are deleted; `wizard-env-writer.ts` keeps emitting `GH_TOKEN` (retirement deferred per clarification Q1).

## Technical Context

**Language/Version**: TypeScript / Node.js >=22 (ESM)
**Primary Dependencies**: `node:http` (Unix-socket POST, same pattern as `git-credential-generacy.ts` and `cloud-pull-client.ts`), `zod` (response shape validation), `pino` (logger), existing `@generacy-ai/control-plane` types (`GitHelperError`, `GitHelperErrorCode`, `GitTokenResponse`), existing `AuthHealthSink` from `@generacy-ai/orchestrator/services/github-auth-health`
**Storage**: In-process Map keyed by `credentialId`, holding `{ token, expiresAt, fetchedAt }`. No disk persistence (per clarification Q2 — cache lives only in the orchestrator/worker wrapper, not the shared client, because the bin is short-lived).
**Testing**: `vitest` unit tests for the new client + provider; one cross-package smoke test confirming the bin and the new provider both consume the same `JitGitTokenClient` API surface. Existing `wizard-creds-token-provider.test.ts` deleted.
**Target Platform**: Linux containers — orchestrator + worker (both Node 22). Unix-socket-only; no TCP fallback.
**Project Type**: monorepo packages (`packages/control-plane`, `packages/orchestrator`). No frontend / CLI / SDK changes.
**Performance Goals**: ≤1 socket round-trip per `gh` invocation when cache is warm (cache hit → synchronous return). On miss, ≤1 control-plane round-trip; control-plane already coalesces concurrent refreshes (#766 `GitTokenManager`), so the worker/orchestrator wrapper does **not** need its own concurrency coalescer. Refresh window: refresh when `expiresAt - now ≤ 5 min` (same threshold as `GitTokenManager.REFRESH_WINDOW_MS`).
**Constraints**: Provider MUST NEVER return `undefined` (per clarification Q3 — silent fallback to ambient expired `GH_TOKEN` is the bug we are fixing). Provider MUST resolve both sockets (per clarification Q4 — worker via `GIT_TOKEN_SOCKET_PATH`, orchestrator via `CONTROL_PLANE_SOCKET_PATH`). Provider MUST integrate with `AuthHealthSink` (per Q3) so refresh-failure surfaces on the `cluster.credentials` channel as `auth-failed` / `refresh-requested` without waiting for downstream `gh` 401.
**Scale/Scope**: Single in-process cache, single credential type (`github-app`) in v1. Multi-credential (`Map<credentialId, …>`) shape already supported by the underlying `/git-token` route's `credentialId` param.

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo. Gate skipped. Plan adheres to general project conventions verified from `CLAUDE.md`:

- Native `node:http` over Unix socket (matches `git-credential-generacy.ts`, `cloud-pull-client.ts`, `control-plane` server).
- Module-level state pattern via `setGitTokenManager()` is the existing convention; the new client follows constructor DI (matches `CloudPullClient`, `GitTokenManager`).
- Re-exports the new client from `packages/control-plane/src/index.ts` so the orchestrator imports it from the package root (matches existing `ControlPlaneError`, `CodeServerProcessManager` re-exports).
- No new top-level package — the shared client lives in the package that owns the contract (per CLAUDE.md guidance for `#558` shared backends and the explicit Q2 answer).

## Project Structure

### Documentation (this feature)

```text
specs/773-severity-high-issue-processing/
├── spec.md                # (read-only, exists)
├── clarifications.md      # (read-only, exists)
├── plan.md                # THIS FILE
├── research.md            # Phase 0 — technology decisions, alternatives, refs
├── data-model.md          # Phase 1 — types/contracts: JitGitTokenClient, TokenCacheEntry, JitTokenError
├── quickstart.md          # Phase 1 — how to run the cluster end-to-end after this lands
├── contracts/
│   ├── jit-git-token-client.md   # interface contract for the shared client
│   └── jit-token-provider.md     # interface contract for the orch/worker wrapper
├── checklists/            # (exists, empty)
├── conversation-log.jsonl # (exists)
└── tasks.md               # Phase 2 — produced by /tasks, NOT this command
```

### Source Code (repository root)

```text
packages/control-plane/
├── src/
│   ├── services/
│   │   ├── jit-git-token-client.ts          # NEW: shared HTTP-over-Unix-socket client
│   │   │                                    # — POST /git-token request/response/error contract.
│   │   │                                    # Imported by git-credential-generacy.ts AND
│   │   │                                    # by the new orchestrator-side provider.
│   │   │                                    # NO caching here (per Q2).
│   │   ├── git-token-manager.ts             # (existing — unchanged)
│   │   └── cloud-pull-client.ts             # (existing — unchanged)
│   ├── types/
│   │   └── git-token.ts                     # (existing — reuse GitHelperError, GitHelperErrorCode)
│   ├── routes/git-token.ts                  # (existing — unchanged)
│   └── index.ts                             # MODIFIED: re-export JitGitTokenClient + JitGitTokenClientOptions
└── bin/
    └── git-credential-generacy.ts           # MODIFIED: replace inline http.request with JitGitTokenClient.fetch()
                                             # Behavior unchanged (still short-lived, no cache, single mint).

packages/orchestrator/
├── src/
│   ├── services/
│   │   ├── jit-github-token-provider.ts     # NEW: provider factory consumed by gh-CLI sites.
│   │   │                                    # Wraps JitGitTokenClient with:
│   │   │                                    #   - in-process cache (Map<credentialId, entry>)
│   │   │                                    #   - 5-min pre-expiry refresh window
│   │   │                                    #   - AuthHealthSink integration on failure (Q3)
│   │   │                                    #   - typed JitTokenError throw (NEVER undefined)
│   │   │                                    # Auto-detects socket via env (Q4):
│   │   │                                    #   GIT_TOKEN_SOCKET_PATH (worker)
│   │   │                                    #     ?? CONTROL_PLANE_SOCKET_PATH (orchestrator)
│   │   │                                    #     ?? '/run/generacy-control-plane/control.sock'
│   │   ├── github-auth-health.ts            # (existing — AuthHealthSink already exported)
│   │   └── wizard-creds-token-provider.ts   # DELETED
│   └── server.ts                            # MODIFIED:
│                                            #   - line 30:  drop createWizardCredsTokenProvider import
│                                            #              + add createJitGithubTokenProvider import
│                                            #   - line 160: wizardCredsTokenProvider → githubTokenProvider
│                                            #               (constructed in BOTH modes — drop !isWorkerMode guard)
│                                            #   - line 207: LabelSyncService param swap
│                                            #   - line 298: ClaudeCliWorker tokenProvider swap (worker path)
│                                            #   - line 335: LabelMonitorService param swap
│                                            #   - line 363: PrFeedbackMonitorService param swap
│                                            #   - line 616: WebhookSetupService param swap
└── tests/unit/services/
    ├── jit-github-token-provider.test.ts    # NEW: cache hit, miss, pre-expiry refresh,
    │                                        #   socket env resolution, AuthHealthSink reporting,
    │                                        #   typed-error throw on socket unreachable / 4xx / 5xx /
    │                                        #   malformed JSON, never-returns-undefined invariant.
    └── wizard-creds-token-provider.test.ts  # DELETED
```

**Structure Decision**: Two-package layout, matching the clarification Q2 answer.

- **`packages/control-plane/src/services/jit-git-token-client.ts`** owns the wire contract (request shape, response shape, error code mapping). This is the thing that *drifts* when `/git-token` evolves; co-locating it with the route definition prevents skew.
- **`packages/orchestrator/src/services/jit-github-token-provider.ts`** owns the behavior every `gh`-CLI consumer needs (cache, refresh window, `AuthHealthSink` integration, socket auto-resolution). Caching is consumer-specific and intentionally absent from the shared client — `git-credential-generacy.ts` is a fresh process per `git` op, so a cache there is dead weight.

No changes to `cluster-base`, `generacy-cloud`, the relay, or the CLI scaffolder. The `/git-token` route and proxy already exist (#766, #768, #819).

## Complexity Tracking

No constitution; no violations to justify. One judgement call to record:

| Decision | Why | Alternative rejected |
|---|---|---|
| Cache lives only in `jit-github-token-provider.ts`, not in `JitGitTokenClient` | The CLI bin (`git-credential-generacy`) is a fresh process per `git` op — caching there is impossible to amortize. The control-plane process already has `GitTokenManager` caching upstream of the route, so a second cache in the client would be a fourth tier (cloud → manager → client cache → provider cache). | Putting the cache in `JitGitTokenClient` with an opt-out flag for the bin (Q2 option C) — rejected because adding configurability for a single short-lived consumer adds API surface for no benefit. |
| Provider auto-detects socket via env var precedence rather than explicit per-instance config | Two callsites (`server.ts` constructs the provider for both worker + orchestrator process) — explicit config would duplicate the resolution logic at both sites. The env-var precedence chain (`GIT_TOKEN_SOCKET_PATH` ?? `CONTROL_PLANE_SOCKET_PATH` ?? default) is identical to what `git-credential-generacy` already does. | Constructor arg with the resolved socket path — rejected because it pushes resolution logic to callers and we'd need to add it in two places that should be identical. |
| Provider throws on failure AND reports to `AuthHealthSink` (Q3 option B) | Returning `undefined` falls back to ambient expired `GH_TOKEN` — silently reproduces the bug. Throwing without `AuthHealthSink` integration delays detection until the next `gh` 401, which defeats the #762 backstop. Doing both means the `cluster.credentials` channel emits `auth-failed` / `refresh-requested` *before* `gh` is invoked, on the first refresh failure. | Throw only / return-undefined-and-warn — both rejected by Q3. |
