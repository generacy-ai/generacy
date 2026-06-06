# Clarifications: JIT gh token provider must work without a `github-app` credential descriptor

**Issue**: [#777](https://github.com/generacy-ai/generacy/issues/777)
**Branch**: `777-severity-high-773-not`

---

## Batch 1 — 2026-06-06

### Q1: Synthetic key value
**Context**: FR-003 says "use a stable synthetic constant (e.g. `'default'`)" for the cache key and `authHealth.recordResult(...)` keying in the credential-less path. The issue body hedges with "`'default'`/the repo owner". The exact string becomes part of the wire contract for `cluster.credentials` relay events (`refresh-requested`/`auth-failed`/`auth-recovered`) when no descriptor exists, so the cloud will see it. Picking the wrong value can leak repo identifiers into telemetry or collide with a real descriptor id.
**Question**: What MUST the synthetic key be when no `github-app` descriptor is present?
**Options**:
- A: Literal string `'default'` (matches the FR-003 example exactly; never collides because real descriptor ids are GitHub installation/credential identifiers, not the word "default")
- B: A reserved-prefix string such as `'__wizard__'` or `'__synthetic__'` (clearly distinguishes the credential-less path from any real descriptor id at a glance in logs/relay payloads)
- C: Repo owner / cluster id derived (e.g. `clusterId` from `cluster.json`) — gives per-cluster cardinality but introduces variability and possible PII in relay events

**Answer**: *Pending*

---

### Q2: Provider construction precondition
**Context**: FR-002 says "build the JIT gh provider whenever `createJitGitTokenClient` can be constructed (the control-plane socket precondition)". `createJitGitTokenClient({ socketPath })` is a constructor that doesn't probe the socket — it just builds an HTTP client wrapper. So the actual gate is ambiguous: do we always construct (and let `fetch()` fail loudly at first call), or do we probe the socket at startup and skip the provider if unreachable (matching today's `undefined` semantics for callers)? This determines whether wizard clusters whose control-plane is briefly slow to bind get a working provider on first attempt or a permanently-`undefined` one.
**Question**: When no `github-app` descriptor exists, what precondition gates provider construction?
**Options**:
- A: Always construct — `createJitGitTokenClient` is unconditional; first `fetch()` call is the failure point (matches "fail at call time" of US3; provider is never `undefined` for callers)
- B: Probe the control-plane socket at startup (`fs.existsSync(socketPath)` or a TCP-style connect) and only construct if reachable; if unreachable, leave provider `undefined` (preserves today's "no provider → ambient fallback" only for the unrechable case, which the assumption section says is rare)
- C: Gate on the presence of `/var/lib/generacy/cluster-api-key` (the precondition `git-credential-generacy` actually relies on), without probing the socket

**Answer**: *Pending*

---

### Q3: Cloud-side compatibility of synthetic credential id in relay events
**Context**: The Assumptions section explicitly flags this: "The `GitHubAuthHealthService` is tolerant of a synthetic credential id (`'default'`) as a key — it does not validate the key against `.agency/credentials.yaml`. (To be re-verified during /clarify or /plan.)" `GitHubAuthHealthService.maybeRequestRefresh` emits `refresh-requested` on `cluster.credentials` keyed by `credentialId`. If we send `{ credentialId: 'default' }` to the cloud, the cloud may have no row to refresh and may either no-op silently, log a warning, or treat it as an error. This affects whether the existing `refresh-requested`/`auth-failed`/`auth-recovered` flow actually does anything useful for wizard clusters or is just noise.
**Question**: What is the expected cloud-side behavior when an `auth-failed` / `refresh-requested` relay event arrives with a synthetic credential id that has no matching descriptor row?
**Options**:
- A: Cloud already silently no-ops unknown credential ids — relay events for the credential-less path are fire-and-forget telemetry only; this fix does NOT need a cloud-side change to be effective
- B: Suppress relay event emission entirely in the credential-less path (don't call `authHealth.recordResult` / `maybeRequestRefresh` at all when there is no descriptor) — accept that wizard clusters get no GitHub-auth health relay signal until a descriptor is synthesized
- C: Emit events but document this as a known cloud-side gap to be addressed by a separate follow-up issue; do not block #777 on the cloud-side change

**Answer**: *Pending*

---

### Q4: Worker-mode provider construction
**Context**: FR-004 says the same provider MUST be threaded to `ClaudeCliWorker` via the existing `tokenProvider` plumbing. But `ClaudeCliWorker` runs in a separate worker process (forked or spawned). In today's code, `githubAppCredentialId` is passed positionally into worker-construction sites (see `server.ts` lines 355–388). The provider itself is a closure over a `JitGitTokenClient` and a cache `Map`, so it can't literally cross a process boundary. Either worker mode constructs its own equivalent provider at worker startup (and its cache is independent of orchestrator's), or there is shared in-process plumbing that the spec is assuming.
**Question**: How does the worker-mode `ClaudeCliWorker` receive the credential-less provider?
**Options**:
- A: Worker process constructs its own `createJitGithubTokenProvider({ client, /* no credentialId */, logger })` at worker startup, with an independent cache; orchestrator and worker have separate caches but identical fetch behavior (matches `ClaudeCliWorker`'s existing pattern of building its own deps)
- B: Worker mode is in-process (same Node process as orchestrator) and literally shares the orchestrator's provider instance — confirm by inspecting `ClaudeCliWorker` lifecycle
- C: Worker mode is out of scope for this fix; only orchestrator-mode `gh` callers are addressed, and a follow-up issue covers worker mode

**Answer**: *Pending*

---

### Q5: Behavior when JIT fetch fails AND ambient `GH_TOKEN` exists
**Context**: US3 wants fail-loud ("clear, observable failures … instead of a silent fallback to a static expired token"). FR-008 says the fix MUST NOT add any read of `GH_TOKEN` from `wizard-credentials.env` *for `gh` purposes*. But today's `gh` callers (`GhCliGitHubClient.getEnv()`) inherit ambient `GH_TOKEN` from `process.env` automatically when `tokenProvider` returns nothing — meaning: even if we make the provider throw, a caller that catches the throw and proceeds will spawn `gh` with the ambient (likely expired) token unless we actively scrub it. So "fail-loud" requires more than just the provider throwing.
**Question**: When the JIT provider throws `JitTokenError`, what MUST happen to the ambient `GH_TOKEN` for `gh` calls?
**Options**:
- A: Callers MUST propagate the throw (not catch) — `gh` is never spawned at all. Ambient `GH_TOKEN` is irrelevant because we never reach an `executeCommand('gh', ...)` call. (Most fail-loud; matches US3.)
- B: Callers catch the throw, log, and skip the `gh` call (do not spawn) — same observable outcome as A but with localized error handling so one credential failure doesn't crash unrelated monitors.
- C: Callers spawn `gh` with `GH_TOKEN` explicitly unset in the env override (e.g. `{ GH_TOKEN: '' }`) so the ambient value can't leak through — `gh` fails loudly with its own "no auth" error rather than a delayed 401.

**Answer**: *Pending*

---
