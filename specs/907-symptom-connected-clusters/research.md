# Research: Orchestrator `/health` version field

**Feature**: #907 — surface real orchestrator version on `/health`
**Branch**: `907-symptom-connected-clusters`
**Date**: 2026-07-10
**Phase**: 0 — technology & pattern decisions

---

## Decision 1: Env var NAME — `ORCHESTRATOR_VERSION` vs. alternatives

**Options considered**:
- **A**: `ORCHESTRATOR_VERSION` — orchestrator-scoped, name stable, VALUE chosen by build (Q3 → A answer).
- **B**: `GENERACY_VERSION` — shared across all in-cluster components (control-plane, credhelper-daemon, etc.).
- **C**: `ORCHESTRATOR_BUILD_SHA` — git-SHA-specific, name matches the `sha-<short>` image tag scheme.
- **D**: Two env vars (`ORCHESTRATOR_VERSION` + `ORCHESTRATOR_BUILD_SHA`), reported together as `"1.2.3+sha.01a2545"`.

**Chosen**: **A** — `ORCHESTRATOR_VERSION`. Locked in clarifications Q3.

**Rationale**:
- Orchestrator is the only component `GET /health` covers today. A shared name (B) would imply shared plumbing across control-plane / credhelper-daemon that isn't in scope (spec §Out of Scope).
- Decoupling NAME (`ORCHESTRATOR_VERSION`) from VALUE (`sha-<short>` today, semver tomorrow, etc.) means the publish workflow can migrate the identifier scheme without renaming the env var or breaking the `/health` contract.
- The publish workflow (`.github/workflows/publish-cluster-base-image.yml:34`) already computes `sha=sha-$(git rev-parse --short=7 HEAD)`. Wiring that value into `ENV ORCHESTRATOR_VERSION=$sha` at Docker build time is a mechanical follow-up.

**Alternatives rejected**:
- **B**: shared name implies shared plumbing (control-plane `/state`, credhelper `/health`, etc.). Adds cross-component contract surface for no immediate win.
- **C**: bakes the identifier scheme into the NAME. If we later ship semver-tagged images, renaming from `ORCHESTRATOR_BUILD_SHA` to `ORCHESTRATOR_VERSION` breaks every deployed cluster's health endpoint simultaneously.
- **D**: `channel`/`uptime` already carry cross-cutting build metadata via other paths. Composite strings (`+sha.` suffix) are harder for the dashboard to parse and don't add signal the operator can't get from correlating with the image tag.

---

## Decision 2: Source precedence — env var first, then package.json

**Options considered**:
- **A**: `ORCHESTRATOR_VERSION` (env) → `packages/orchestrator/package.json` → sentinel.
- **B**: `packages/orchestrator/package.json` → `ORCHESTRATOR_VERSION` (env) → sentinel.
- **C**: env-var only; no package.json fallback; sentinel if unset.
- **D**: Composite: prefer env, but if env is set to a semver-shaped value AND package.json also has one, warn on divergence.

**Chosen**: **A** — env var first, then package.json, then `"unknown"`.

**Rationale**:
- FR-004 explicitly names the env var as the canonical build-time identifier and package.json as an "acceptable fallback". The precedence direction is implied by "canonical" and "fallback".
- In production images, the env var will always be set by the Dockerfile (per the cross-repo follow-up). Package.json in a Docker image is often `0.1.0` (workspace default), so putting it first would defeat the point of the fix in production.
- In local development (`pnpm dev`), the env var is normally unset. Package.json fallback gives operators something informative (`0.1.0`) instead of the sentinel while iterating.
- The Q1 → A guard against literal `"0.0.0"` from *any* source means neither ordering can silently reproduce the pre-fix bug: even if a stray `ORCHESTRATOR_VERSION=0.0.0` shipped, the resolver would fall through to package.json.

**Alternatives rejected**:
- **B**: reverses which source dominates in production. Fights against FR-004's "canonical env var" language and forces the build to explicitly clear package.json to make the env var visible.
- **C**: leaves local `pnpm dev` operators with no signal but the sentinel. Trivially strict; costs local-DX for no correctness win.
- **D**: divergence-warning is overkill for a cosmetic dashboard field. Adds a decision surface (which one wins when they diverge?) with no downstream consumer that would notice.

---

## Decision 3: `"0.0.0"` guard — literal string equality vs. semver-parse

**Options considered**:
- **A**: Literal string equality against `"0.0.0"`. No trimming, no lowercasing, no parsing.
- **B**: Semver-parse (`0.0.0`, `0.0.0-anything`, `0.0.0+build.1` all treated as unresolved).
- **C**: Whitespace-trim, then string equality. `"  0.0.0  "` also unresolved.

**Chosen**: **A** — bare literal equality.

**Rationale**:
- The symptom (spec §Root Cause) is that cluster-relay's fallback path emits *exactly* the string `"0.0.0"` — no whitespace, no suffix. Matching that exact string is the strongest possible guarantee that the fix eliminates the observed dashboard value.
- Semver-parsing `0.0.0-something` as "unresolved" would surprise operators who deliberately tag a pre-release build (`0.0.0-preview`, `0.0.0-rc.1`). Those are legitimate identifiers, and Q4 → C explicitly says the handler policies no format.
- Whitespace tolerance is defensive coding for a scenario that doesn't happen: Docker `ENV` values are trimmed by convention, and package.json JSON values can't hold leading whitespace inside quotes. Adding it invites the question "what other normalization should we do?" — better to keep the rule sharp.
- The literal-string rule is also easier to grep for post-hoc when debugging a cluster that's reporting `"unknown"`.

**Alternatives rejected**:
- **B**: rejects legitimate pre-release identifiers (Q4 rationale).
- **C**: extra rule for no observed failure mode; blurs the invariant.

---

## Decision 4: ESM package.json read — `readFileSync + import.meta.url` vs. JSON import assertion

**Options considered**:
- **A**: `readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')` and `JSON.parse` inside the resolver.
- **B**: `import pkg from '../../package.json' with { type: 'json' };` at the top of the resolver module.
- **C**: Bundle the version at build time via a `tsc`-invoked codegen step.

**Chosen**: **A** — `readFileSync` at call time.

**Rationale**:
- **A** works uniformly across Node ≥20 without depending on the "JSON import attributes" stage-3 proposal status (Node accepts them but tsc handling varies with `moduleResolution` and target — a per-`tsconfig` config surface we don't want to touch for this).
- The read is inside a try/catch and only happens if the env var didn't resolve. Startup cost is bounded to one small file read on the fallback path.
- Precedent: `packages/orchestrator/src/config/loader.ts` and several other orchestrator modules use `readFileSync` for boot-time file I/O.
- Compared with **C**, avoids a codegen dependency. Compared with **B**, avoids interacting with the JSON import attributes surface at all.

**Alternatives rejected**:
- **B**: introduces a moving target — TypeScript's handling of import attributes has changed between 5.x minors, and the orchestrator's `tsconfig.json` `module` / `moduleResolution` combo may or may not accept it without changes. This is a one-line resolver; not worth the config surface.
- **C**: overkill. `readFileSync` is fine at startup.

---

## Decision 5: Where to call `resolveOrchestratorVersion()` — module load vs. handler registration vs. per-request

**Options considered**:
- **A**: Registration-time — call inside `setupHealthRoutes` once, close over the value.
- **B**: Module load — call at the top of `orchestrator-version.ts` and export the string constant.
- **C**: Per-request — call inside the `/health` handler on every request.

**Chosen**: **A** — registration-time, closure-captured.

**Rationale**:
- The identifier is process-lifetime constant. `/health` is on the polling hot path (Fastify probes, cluster-relay's periodic metadata collection, kubelet liveness probes), so per-request I/O (option C) would be a small but avoidable regression.
- Registration-time keeps the resolver's side effects (a `readFileSync` on the fallback path) scoped to `setupHealthRoutes` — the same place other startup I/O happens. Easier to trace than a module-load side effect.
- Option **B** works but has two subtle costs: (a) makes it harder to reset the value in tests (module cache would need clearing), (b) fires the `readFileSync` even if the health routes aren't registered (e.g. worker mode where health is still registered — but the general principle stands for other consumers).
- Registration-time also mirrors the pattern already used for `githubAuthGetter` at `~58` of the same file (bind at registration, close over in handler).

**Alternatives rejected**:
- **B**: harder to test-reset, fires unconditionally.
- **C**: unnecessary per-request I/O on a hot path.

---

## Decision 6: Test shape — mock the resolver vs. manipulate the environment

**Options considered**:
- **A**: `vi.mock('../services/orchestrator-version.js', ...)` — swap the resolver's return value per test case.
- **B**: Manipulate `process.env.ORCHESTRATOR_VERSION` in `beforeEach` and let the real resolver run.
- **C**: Split — env-var cases use B (real resolver, mocked env), package.json/sentinel cases use A (mocked resolver).

**Chosen**: **C** — split.

**Rationale**:
- The env var case (case a: `sha-abc1234`) can safely manipulate `process.env` because the resolver reads directly from it. This is the highest-fidelity test — it exercises the actual resolver logic against the actual env var.
- The `"0.0.0"` guard case on the env var (case b) is also cleanly covered by option **B**: set `ORCHESTRATOR_VERSION=0.0.0`, watch the resolver fall through to package.json's `"0.1.0"`. Highest fidelity, covers Q1 → A directly.
- The sentinel case (case c) needs both env var *unset* AND package.json to resolve to `"0.0.0"` (or be unreadable). Manipulating the real package.json on disk during a test is fragile and could cross-contaminate other tests running in parallel. Mocking the resolver's return value (or, more surgically, mocking the file read) is cleaner and doesn't couple the test to workspace state.
- The split keeps ~90% of the test running against real code (highest signal for the load-bearing paths) while punting the awkward corner to a targeted mock.

**Alternatives rejected**:
- **A** everywhere: turns the test into a check of "does the handler read the resolver and set the field" — misses the actual precedence logic.
- **B** everywhere: forces on-disk mutation of `package.json` during the sentinel test. Cross-contamination hazard in parallel test runs.

---

## Decision 7: Do we add a `version` constant, or duplicate the sentinel string?

**Options considered**:
- **A**: Export `export const UNRESOLVED_VERSION_SENTINEL = 'unknown'` from the resolver module; both handler and test import it.
- **B**: Duplicate the literal `"unknown"` in the resolver and the test — no shared symbol.

**Chosen**: **B** — duplicate.

**Rationale**:
- Q2 → A explicitly locks the string `"unknown"` "in both the handler and the FR-007 test to prevent drift". A shared constant would let the sentinel string drift silently — if someone renamed the constant to `SENTINEL = 'unknown-version'`, both the handler and the test would agree but the dashboard-facing string would silently change.
- Independent duplicate assertions are the standard pattern for locked-string contracts. Tests should re-state the exact literal so a wire-format regression is caught by the test.
- The resolver module is small; the duplication is 2 characters (`'unknown'`) in each of two files. No maintenance burden.

**Alternatives rejected**:
- **A**: makes the test complicit in silent changes to the wire format.

---

## Sources

- Clarifications answers Q1–Q5 (`specs/907-symptom-connected-clusters/clarifications.md`).
- Spec §Root Cause and FR-001..FR-007 (`specs/907-symptom-connected-clusters/spec.md`).
- `packages/orchestrator/src/routes/health.ts` — current handler + schema.
- `packages/orchestrator/src/types/api.ts:210-219` — current `HealthResponseSchema`.
- `packages/cluster-relay/src/metadata.ts:49-75` — current `?? '0.0.0'` fallback (unchanged).
- `packages/orchestrator/src/__tests__/health-code-server.test.ts` — the test-shape template mirrored for FR-007.
- `.github/workflows/publish-cluster-base-image.yml:34` — the `sha=sha-$(git rev-parse --short=7 HEAD)` line that will feed `ORCHESTRATOR_VERSION` at Docker build time (cross-repo follow-up).
