# Implementation Plan: JIT gh token provider works without `github-app` descriptor

**Feature**: #773 silent fallback on wizard-bootstrapped clusters — build the JIT gh token provider credential-less when only the cluster API key is available.
**Branch**: `777-severity-high-773-not`
**Status**: Complete
**Date**: 2026-06-06
**Spec**: [spec.md](spec.md) · [clarifications.md](clarifications.md)

## Summary

#773 introduced a just-in-time GitHub token provider that fetches fresh installation tokens via `/git-token` on every `gh` invocation, retiring the static `wizard-credentials.env` `GH_TOKEN`. The provider is gated on the presence of a `github-app` credential descriptor in `.agency/credentials.yaml`. Wizard-bootstrapped clusters (every cluster in production today) never have that descriptor — they store a raw `GH_TOKEN`/`GH_USERNAME`/`GH_EMAIL` triple — so `githubAppCredentialId` is `undefined`, the provider is never constructed, and `GhCliGitHubClient` falls through to the ambient (expired) `GH_TOKEN` inherited from the orchestrator's `process.env`. Symptom: every `gh` call (label sync, label monitor, PR-feedback monitor, workers) 401s about an hour after activation.

The fix removes the descriptor gate. When `/var/lib/generacy/cluster-api-key` exists (the same precondition the working `git-credential-generacy` path relies on), the orchestrator builds a credential-less provider that calls `client.fetch()` with no `credentialId` — the control-plane resolves the GitHub installation server-side from cluster identity. Cache key and `authHealth` keying use the reserved sentinel `'__wizard__'`. Worker mode does the same in its own process. Defense-in-depth: when the provider is present, the `gh` env override always carries `GH_TOKEN` (never `undefined`), so ambient leakage is structurally impossible.

## Technical Context

**Language/Version**: TypeScript 5.x, Node.js >= 22
**Primary Dependencies**: `@generacy-ai/control-plane` (`JitGitTokenClient`, `JitTokenError`), `pino` (logging), `node:fs` (api-key presence probe). No new runtime deps.
**Storage**: file-presence probe of `/var/lib/generacy/cluster-api-key` (existsSync, contents never read in orchestrator); `.agency/credentials.yaml` read unchanged (existing `readCredentialDescriptors`).
**Testing**: `vitest` (existing). Unit coverage in `packages/orchestrator/__tests__/services/` and `packages/workflow-engine/__tests__/actions/github/client/`.
**Target Platform**: Linux orchestrator container; ClaudeCliWorker subprocess in the same container.
**Project Type**: TypeScript monorepo (single tree, multiple workspace packages).
**Performance Goals**: behavior unchanged from #773 — token cached until `expiresAt - now <= 5 min`, single in-flight refresh per cache key, `JitGitTokenClient` already coalesces concurrent fetches.
**Constraints**:
- Backwards-compatible with clusters that *do* have a `github-app` descriptor — behavior unchanged on that branch (`credentialId` still passed; sentinel not used).
- Truly-unconfigured / offline cluster (no api-key file) must keep today's legacy fallback (no JIT provider, ambient `GH_TOKEN`).
- Token-fetch failure must never silently fall through to ambient `GH_TOKEN` — fail-loud per FR-008 / Clarification Q5.
**Scale/Scope**: 3 source files modified (1 in workflow-engine, 2 in orchestrator), 1 new helper, ~150 LOC of test additions.

## Constitution Check

No `.specify/memory/constitution.md` present in the repo — no gates to evaluate. Skipped per template guidance.

## Architecture decisions (cross-reference clarifications)

| Decision | Choice | Source |
|---|---|---|
| Cache key + `authHealth` key when no descriptor exists | Reserved-prefix sentinel `'__wizard__'` (same constant for both) | [Q1](clarifications.md#q1-synthetic-key-value) |
| Provider construction precondition | `existsSync('/var/lib/generacy/cluster-api-key')` — *not* a socket probe, *not* unconditional | [Q2](clarifications.md#q2-provider-construction-precondition) |
| Cloud-side compatibility | None required — relay events fire-and-forget; cloud has no consumer; control-plane resolves installation from cluster identity, not `credentialId` | [Q3](clarifications.md#q3-cloud-side-compatibility-of-synthetic-credential-id-in-relay-events) |
| Worker mode | Worker process builds its own credential-less provider at startup with independent cache | [Q4](clarifications.md#q4-worker-mode-provider-construction) |
| Failure behavior | Callers catch `JitTokenError` at loop boundary, log, skip the `gh` call; provider env override always sets `GH_TOKEN` to defeat ambient leakage | [Q5](clarifications.md#q5-behavior-when-jit-fetch-fails-and-ambient-gh_token-exists) |

## Project Structure

### Documentation (this feature)

```text
specs/777-severity-high-773-not/
├── plan.md                  # This file
├── research.md              # Decision rationale, alternatives
├── data-model.md            # JitGithubTokenProviderOptions shape, sentinel constant
├── quickstart.md            # Verify fix on a wizard-bootstrapped cluster
├── contracts/
│   ├── jit-github-token-provider.ts.md   # New signature for createJitGithubTokenProvider
│   └── gh-cli-env-override.md            # GhCliGitHubClient.resolveTokenEnv contract
├── checklists/              # (empty — populated by /checklist if requested)
├── spec.md                  # (read-only)
├── clarifications.md        # (read-only)
└── tasks.md                 # NOT created by /plan — produced by /tasks
```

### Source Code (repository root)

```text
packages/orchestrator/
├── src/
│   ├── server.ts                                        (MODIFIED)
│   │   # Lines 201–224: replace `githubAppCredentialId ? … : undefined`
│   │   # with api-key-presence gate; pass credentialId only when descriptor exists.
│   ├── services/
│   │   ├── jit-github-token-provider.ts                 (MODIFIED)
│   │   │   # `credentialId` becomes optional. When undefined: cache+authHealth key
│   │   │   # both use the exported `WIZARD_SENTINEL_KEY` constant; client.fetch() is
│   │   │   # called with no arg (already supported — sends `'{}'`).
│   │   └── cluster-api-key-probe.ts                     (NEW, ~15 LOC)
│   │       # Exports `clusterApiKeyExists(path = DEFAULT_KEY_PATH): boolean`.
│   │       # Pure `fs.existsSync` wrapper for testability; respects
│   │       # `CLUSTER_API_KEY_PATH` env var for tests.
│   └── worker/
│       └── claude-cli-worker.ts                         (MODIFIED)
│           # Worker mode currently receives tokenProvider via deps. Confirm that
│           # the worker entry (server.ts isWorkerMode branch) constructs the
│           # credential-less provider when needed. Worker process inherits the
│           # same gating logic — no separate change needed in this file itself
│           # IF server.ts handles both modes (current pattern).
└── __tests__/
    └── services/
        └── jit-github-token-provider.test.ts            (MODIFIED — add)
            # - credential-less path: cache key + authHealth keyed by '__wizard__'
            # - client.fetch() called with no argument
            # - JitTokenError thrown through unchanged
            # - cache hit/miss/expiry semantics identical with sentinel key

packages/workflow-engine/
├── src/actions/github/client/
│   └── gh-cli.ts                                        (MODIFIED)
│       # `resolveTokenEnv`: when `this.tokenProvider` is set, ALWAYS return an
│       # env object containing `GH_TOKEN` (= token, or '' on the throw-and-skip
│       # path if a caller bypasses the throw). Today: returns `undefined` when
│       # token is falsy → ambient leaks. New invariant: provider present ⇒
│       # `GH_TOKEN` key always present in env override.
└── __tests__/actions/github/client/
    └── gh-cli.test.ts                                   (MODIFIED — add)
        # - provider present + token returned → env carries GH_TOKEN=token
        # - provider present + provider throws JitTokenError → propagates;
        #   no executeCommand('gh', …) call observed
        # - provider absent → env undefined (existing behavior; no regression)
```

**Structure Decision**: surgical fix inside the existing monorepo layout. No new packages, no new top-level directories. All changes live next to the files they modify; the api-key probe is a 15-LOC pure helper colocated with `jit-github-token-provider.ts` for direct unit-test access (vs. importing the control-plane's `ClusterApiKeyReader`, which is an async file-reader with caching — overkill here, where we only need existence at startup).

## Implementation phases

### Phase 0 — Research (this command)
- See [research.md](research.md). Confirms the credential-less code path is already structurally complete on the control-plane side (`JitGitTokenClient.fetch(credentialId?)` handles `undefined` → `'{}'` body) and on the cloud side (`POST /git-token` resolves the installation from the cluster-api-key Authorization, not the request body).

### Phase 1 — Design (this command)
- See [data-model.md](data-model.md) for the updated `JitGithubTokenProviderOptions` shape and the `WIZARD_SENTINEL_KEY` constant.
- See [contracts/jit-github-token-provider.ts.md](contracts/jit-github-token-provider.ts.md) for the new function signature.
- See [contracts/gh-cli-env-override.md](contracts/gh-cli-env-override.md) for the env-override invariant.

### Phase 2 — Tasks (next command: `/tasks`)
Outline of expected tasks (not exhaustive — produced authoritatively by `/tasks`):

1. Add `WIZARD_SENTINEL_KEY = '__wizard__'` export to `jit-github-token-provider.ts`.
2. Make `credentialId` optional in `JitGithubTokenProviderOptions`; thread sentinel through cache + authHealth keys.
3. Add `cluster-api-key-probe.ts` helper.
4. Update `server.ts` provider construction: gate on `clusterApiKeyExists()`, pass `credentialId` only when descriptor present.
5. Update `GhCliGitHubClient.resolveTokenEnv` to always include `GH_TOKEN` when provider is set.
6. Unit tests: credential-less provider (orchestrator), env-override invariant (workflow-engine).
7. Smoke test: run a wizard-bootstrapped cluster locally and confirm `gh api repos/<org>/<repo>` succeeds with no `github-app` descriptor.

## Complexity Tracking

No constitution violations; table omitted.

## Out of scope

- Synthesizing a `github-app` descriptor on wizard clusters (#777 explicitly chooses the credential-less path instead — simpler, matches the working git path).
- Cloud-side `refresh-requested` consumer (deferred per [Q3](clarifications.md#q3-cloud-side-compatibility-of-synthetic-credential-id-in-relay-events), already deferred by #762).
- Removing `wizard-credentials.env` `GH_TOKEN` writes from `wizard-env-writer.ts` (a future cleanup once nothing reads `GH_TOKEN` ambiently — separate issue).
- Backporting to clusters that pin to a pre-#773 image (the bug only exists with #773 deployed; older images use the static path).

## Next step

Run `/tasks` to generate the dependency-ordered task list.
