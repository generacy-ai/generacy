# Clarifications

**Issue**: [generacy-ai/generacy#773](https://github.com/generacy-ai/generacy/issues/773)
**Branch**: `773-severity-high-issue-processing`

## Batch 1 — 2026-06-05

### Q1: Scope of wizard-creds retirement
**Context**: The spec marks "Retiring the static `GH_TOKEN` from `wizard-credentials.env` for non-gh consumers" as out-of-scope follow-up, and FR-011 says `createWizardCredsTokenProvider` "MAY remain". An [NEEDS CLARIFICATION 1] marker on FR-011 asks whether deletion belongs to this PR. The answer determines whether the file (and its tests) get deleted now, whether `wizard-env-writer.ts` keeps emitting `GH_TOKEN`, and how aggressive the diff is.
**Question**: What should this PR do with `wizard-creds-token-provider.ts`, the four gh-CLI wiring lines that reference it today, and the `GH_TOKEN` line that `wizard-env-writer.ts` writes into `wizard-credentials.env`?
**Options**:
- A: Unwire only — leave `wizard-creds-token-provider.ts` and the `GH_TOKEN` env line in place; just stop passing the wizard provider at the four wiring sites.
- B: Unwire + delete the provider file + its tests (no remaining gh consumer); leave `wizard-env-writer.ts` emitting `GH_TOKEN` (other tooling may read it) — defer that to a follow-up.
- C: Unwire + delete the provider file + stop emitting `GH_TOKEN` in `wizard-env-writer.ts` — full retirement in this PR.
- D: Other / propose during planning.

**Answer**: *Pending*

### Q2: Location of the JIT token provider
**Context**: `bin/git-credential-generacy.ts` already inlines socket-talking logic (`POST /git-token` over the control socket) with no caching. The new orchestrator-side JIT provider needs the same upstream call plus an in-process cache. Whether the helper is duplicated, lifted into the orchestrator, or shared affects future drift between the two callers when `/git-token` evolves. [NEEDS CLARIFICATION 2] asks this directly.
**Question**: Where should the JIT token-fetching logic (HTTP-over-Unix-socket call to `POST /git-token` + the in-process token cache) live?
**Options**:
- A: Orchestrator-only — new module at `packages/orchestrator/src/services/jit-github-token-provider.ts`; `git-credential-generacy` keeps its inlined logic (no caching needed there — it's a short-lived CLI).
- B: Shared client — extract a `JitGitTokenClient` into `packages/control-plane` (the package that owns `/git-token`); both the bin and the orchestrator import it, and the orchestrator wraps it with the caching layer.
- C: Shared client AND shared caching — single `JitTokenProvider` class in `packages/control-plane` used by both consumers; the bin opts out of the cache via a flag (or instantiates with cache disabled).
- D: Other / propose during planning.

**Answer**: *Pending*

### Q3: Failure-mode semantics when /git-token is unreachable
**Context**: [NEEDS CLARIFICATION 3] asks how the provider should behave when `/git-token` returns 4xx/5xx, the socket is missing, or the cloud upstream fails. `GhCliGitHubClient.executeGh` calls `tokenProvider()` then passes the resolved value as `GH_TOKEN` to the `gh` subprocess; returning `undefined` reverts to ambient gh auth, throwing surfaces an error before the gh call. The #762 backstop watches `gh` 401s via `GhAuthError` and `AuthHealthSink.recordResult`. The chosen semantics determine whether refresh failures are visible to the existing observability stack or open a new code path.
**Question**: When the JIT provider cannot resolve a fresh token (socket unreachable, `/git-token` 4xx/5xx, malformed response), what should it do?
**Options**:
- A: Throw a typed `JitTokenError`; let the `gh` invocation surface as a failed call with non-401 stderr; do nothing to `AuthHealthSink` (the next successful poll resolves state naturally).
- B: Throw, AND call `AuthHealthSink.recordResult({ ok: false, statusCode: 503 })` from the provider so #762's `auth-failed`/`refresh-requested` flow fires without waiting for a `gh` invocation to fail.
- C: Return `undefined` (gh falls back to whatever env is present, e.g. ambient `GH_TOKEN`); log a warning, do not throw.
- D: Other / propose during planning.

**Answer**: *Pending*

### Q4: Provider scope vs FR-002 worker-socket clause
**Context**: FR-002 says the provider must resolve the orchestrator socket OR the worker proxy socket (`/run/generacy-git-token/control.sock`) based on container context. But "Out of Scope" excludes worker-process gh paths (they pass `undefined` per #620 and use credhelper session env). All four FR-005..FR-008 wiring sites (`server.ts:298`, `LabelMonitorService`, `LabelSyncService`, `PrFeedbackMonitorService`) live in the orchestrator process. So either FR-002's worker-socket branch is dead code in v1, or there is an intended worker consumer not listed in FR-005..FR-008.
**Question**: Should the v1 provider implement worker-socket detection (`/run/generacy-git-token/control.sock`) as FR-002 specifies, or simplify to orchestrator-only since no in-scope wiring site runs in a worker process?
**Options**:
- A: Orchestrator-only — provider hardcodes `/run/generacy-control-plane/control.sock` (or `CONTROL_PLANE_SOCKET_PATH` env); drop FR-002's worker branch.
- B: Dual-mode as written in FR-002 — detect context via env or socket-existence probe so the provider works unchanged if a future worker path adopts it.
- C: Orchestrator-only in this PR; track a follow-up issue for worker-mode if/when a worker gh path needs it.
- D: Other — name the worker consumer that justifies FR-002's worker branch.

**Answer**: *Pending*
