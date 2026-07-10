# Implementation Plan: Orchestrator surfaces a real version on `/health`

**Feature**: Populate a real `version` field on `GET /health` — declared in the Fastify response schema (both 200 and 503 branches) and resolved at handler startup from `ORCHESTRATOR_VERSION` env var first, then `packages/orchestrator/package.json`, with the literal `"0.0.0"` treated as unresolved from any source and the exact sentinel `"unknown"` emitted when nothing resolves.
**Branch**: `907-symptom-connected-clusters`
**Issue**: [generacy-ai/generacy#907](https://github.com/generacy-ai/generacy/issues/907)
**Date**: 2026-07-10
**Status**: Complete

## Summary

Every connected cluster in the cloud dashboard reports `Orchestrator: v0.0.0` because `/health` never emits a `version` field. Two independent bugs conspire:

1. **Handler omission** — `packages/orchestrator/src/routes/health.ts` (`~131-137`) builds the response without `version`.
2. **Schema strip** — the Fastify response schema (`~68-99`) does not declare `version`, so even if the handler set it Fastify would strip it before serialization. Both the 200 and 503 branches must be updated.

Downstream, `packages/cluster-relay/src/metadata.ts:57` reads `String(data['version'] ?? '0.0.0')` — a defensive fallback that keeps firing on every cluster today.

**Fix (per clarifications Q1..Q5)**:

1. **Type surface**: Add `version: string` (non-optional) to `HealthResponseSchema` in `packages/orchestrator/src/types/api.ts:210-219`. This propagates automatically to the exported `HealthResponse` type via `z.infer<...>`.
2. **Schema declaration**: Add `version: { type: 'string' }` to both the 200 and 503 `response` properties inside `setupHealthRoutes` (`packages/orchestrator/src/routes/health.ts:70-82` and `84-98`). Non-declaration causes Fastify's `fast-json-stringify` to strip the field — this is the load-bearing half of the fix.
3. **Resolver module**: New `packages/orchestrator/src/services/orchestrator-version.ts` exports `resolveOrchestratorVersion(): string`. Precedence: (a) `process.env.ORCHESTRATOR_VERSION` (Q3 → A — canonical env var, name stable, VALUE wired to `sha-<short>` at image build time by the publish workflows), (b) `packages/orchestrator/package.json` `version` read once at startup via `readFileSync(new URL('../../package.json', import.meta.url))`. Both sources are subjected to the same guard: any non-empty string other than the literal `"0.0.0"` wins; anything else (missing, empty, whitespace, `"0.0.0"`) falls through. If both fall through, return exactly `"unknown"` (Q2 → A — locked string). Q1 → A: the `"0.0.0"` guard applies to all sources; neither the env var nor the package.json read is trusted to bypass it.
4. **Handler wiring**: Call `resolveOrchestratorVersion()` once at `setupHealthRoutes` registration time (not per-request — the identifier is process-lifetime constant) and capture into a closure. Assign `response.version = resolvedVersion` unconditionally in the handler (`~131-137`).
5. **Test**: New `packages/orchestrator/src/__tests__/health-version.test.ts` — mirrors the `health-code-server.test.ts` pattern (mocked probes, `server.inject()` against `createServer()`). Three cases covering FR-007: (a) env var set to `sha-abc1234` → response `version === 'sha-abc1234'`; (b) env var set to `"0.0.0"` and `package.json` version is `"0.1.0"` → response `version === '0.1.0'` (Q1 guard on env var); (c) env var unset and `package.json` mocked to `"0.0.0"` → response `version === 'unknown'` (Q2 sentinel).

**Non-goals** (spec §Out of Scope): no changes to `packages/cluster-relay/src/metadata.ts` (FR-006 — the `?? '0.0.0'` fallback stays as-is; the fix is orchestrator-side). No changes to `channel` or `uptime` on `/health` (Q5 → A — those already flow through the orchestrator's own `collectMetadata` from cluster YAML and `process.uptime()`, so there is no user-visible bug there). No cloud dashboard changes (Firestore string field already accepts any value). No image publish workflow changes in this PR — the value wiring for `ORCHESTRATOR_VERSION` at Docker build time is a cross-repo follow-up in `cluster-base` / `cluster-microservices`.

## Technical Context

**Language / Runtime**: TypeScript 5.x, ESM, Node ≥20 (package.json engines).
**Test framework**: Vitest.
**Framework**: Fastify 5 with `fast-json-stringify` response serialization (the field-strip behavior is a documented Fastify feature — undeclared fields are removed from JSON output before send).
**Validation**: Zod 3 for `HealthResponseSchema`; the Fastify per-route response schema is hand-written JSON Schema, NOT derived from Zod. Both must be updated in lockstep (Zod type feeds the compile-time handler body; Fastify JSON Schema feeds runtime serialization).

**Key files touched**:
- `packages/orchestrator/src/routes/health.ts` — handler + Fastify response schema (both 200 and 503).
- `packages/orchestrator/src/types/api.ts` — `HealthResponseSchema` (line 210-219).
- `packages/orchestrator/src/services/orchestrator-version.ts` — NEW — resolver module.
- `packages/orchestrator/src/__tests__/health-version.test.ts` — NEW — FR-007 test.

**External dependencies**: none. `readFileSync` + `URL` are `node:fs` / `node:url` (already used elsewhere in orchestrator).

**Assumptions carried from spec + clarifications**:
- `ORCHESTRATOR_VERSION` is the canonical env var NAME (Q3 → A). Its VALUE is set at Docker image build time by the publish workflows (`.github/workflows/publish-cluster-base-image.yml:34` already computes `sha=sha-$(git rev-parse --short=7 HEAD)`); wiring that value into an image `ENV ORCHESTRATOR_VERSION=...` is a follow-up PR against the cluster-base / cluster-microservices Dockerfiles. **Not in this PR's blast radius.**
- The identifier is process-lifetime constant — resolve once at `setupHealthRoutes` and close over the value (avoids re-reading `package.json` from disk on every `/health` request).
- The `"0.0.0"` sentinel guard applies verbatim — literal-string comparison against `"0.0.0"`. No trimming, no lowercasing, no semver-parsing. This mirrors what cluster-relay's fallback string equals.
- No format contract is enforced on the returned string (Q4 → C). Any non-empty, non-`"0.0.0"` string is accepted verbatim. The recommended VALUE convention (non-binding) is the `sha-<short>` scheme the image is already tagged with.
- `HealthResponse['version']` is non-optional in the Zod schema. `HealthResponseSchema.parse(...)` on a response missing `version` would be a bug — the handler is required to populate it, and the resolver's fallback tier (`"unknown"`) guarantees it always can.

## Project Structure

**Modified — Zod type surface**:
- `packages/orchestrator/src/types/api.ts` (line 210-219) — add `version: z.string()` (non-optional) to `HealthResponseSchema`. Position between `services` and `codeServerReady` to match the field order the Fastify JSON schema will use.

**Modified — Fastify handler + response schema**:
- `packages/orchestrator/src/routes/health.ts`:
  - Import: add `import { resolveOrchestratorVersion } from '../services/orchestrator-version.js';` at the top.
  - Registration-time resolution: inside `setupHealthRoutes`, after the `githubAuthGetter` binding (`~58`), capture `const resolvedVersion = resolveOrchestratorVersion();`. One call per process, closure-captured.
  - Schema — 200 branch (`~68-82`): add `version: { type: 'string' }` alongside the existing `status`, `timestamp`, etc.
  - Schema — 503 branch (`~84-98`): identical addition. **Both are required** — omission of either regresses on the reconnect path (FR-002 note in spec).
  - Handler (`~131-137`): construct the `HealthResponse` with `version: resolvedVersion` alongside the existing fields. Position matches the schema ordering.
  - `/health/live` and `/health/ready` responses (lines 158-225) are NOT touched — spec §Impact and cluster-relay metadata both only read from `/health`.

**New — resolver module**:
- `packages/orchestrator/src/services/orchestrator-version.ts` — exports `resolveOrchestratorVersion(): string`. Internal helper `isRealVersion(candidate: string | undefined): candidate is string` implements the shared guard (non-empty AND `!== '0.0.0'`, no trimming). Precedence: env var → package.json → `"unknown"`. Package.json read is wrapped in a try/catch; any error (missing file, malformed JSON, missing `version` field) falls through to the sentinel. Read is synchronous at module-load time is acceptable — orchestrator startup already does `readFileSync` in several places (`config/loader.ts`), and the resolver is only invoked once per process. See `research.md` §"Decision 4" for the ESM `readFileSync + import.meta.url` vs. `import ... assert { type: 'json' }` trade-off.

**New — regression test**:
- `packages/orchestrator/src/__tests__/health-version.test.ts` — mirrors the shape of `health-code-server.test.ts:1-62`. Mocks `probeCodeServerSocket` + `probeControlPlaneSocket` + `@generacy-ai/control-plane` + `@generacy-ai/workflow-engine` identically. Manipulates `process.env.ORCHESTRATOR_VERSION` between cases via `beforeEach`/`afterEach`. For the package.json fallback and sentinel cases, mocks the resolver module directly (vi.mock) rather than trying to swap package.json on disk. Assertions target `body.version` on the JSON response.

**Not touched (intentional)**:
- `packages/cluster-relay/src/metadata.ts` — FR-006. Its `?? '0.0.0'` fallback stays as-is; the fix is orchestrator-side only, and the fallback is still correct behavior when the orchestrator is genuinely unreachable.
- `packages/orchestrator/src/routes/health.ts` `/health/live` and `/health/ready` handlers — spec scope is `/health` only.
- `packages/orchestrator/src/services/relay-bridge.ts` `collectMetadata` — Q5 → A. The `channel` and `uptime` fields it sources (from cluster YAML at `:727-728` and `process.uptime()` at `:688`) are unchanged. `orchestratorVersion` will now be sourced downstream by cluster-relay's `metadata.ts` from the newly-populated `/health` field, which is the whole point.
- Publish workflows (`.github/workflows/publish-cluster-*.yml`) and cluster-base / cluster-microservices Dockerfiles — value-wiring for `ORCHESTRATOR_VERSION` at image build time is a cross-repo follow-up (see spec §Assumptions).

## Constitution Check

No `.specify/memory/constitution.md` exists in this repo. Constitution check is trivially satisfied.

**Cross-cutting invariants observed anyway**:
- **Fail-visible, not fail-silent** — the sentinel `"unknown"` is emitted explicitly rather than falling back to `"0.0.0"`, so a misconfigured cluster is distinguishable in the dashboard from the pre-fix bug (Q1 → A rationale).
- **Locked-string sentinel** — `"unknown"` is compared in both the resolver and the test to guarantee no drift (Q2 → A rationale). No exported constant across boundaries; the string is duplicated deliberately in the test as an independent assertion.
- **No format policing in the handler** — the handler accepts any non-empty non-`"0.0.0"` string verbatim (Q4 → C). The recommended `sha-<short>` scheme is a build-side convention, not a runtime contract.
- **Resolve once, not per-request** — `resolveOrchestratorVersion()` is invoked at `setupHealthRoutes` registration time and closed over. `/health` is on the request-liveness hot path; per-request `readFileSync` would be a small but avoidable regression.
- **Schema + type parity** — the Zod schema (`HealthResponseSchema`) and the Fastify JSON response schema are updated in the same PR. Diverging them regresses (Zod compile-time says `version: string`, Fastify runtime strips it → 500 or silently-empty).

## Data & Contract Artifacts

- `research.md` — technology decisions (why `ORCHESTRATOR_VERSION` over `GENERACY_VERSION`, why env-var precedence over package.json, why `readFileSync + import.meta.url` for ESM package.json read, why resolve at registration-time not per-request, why keep the guard as literal-string equality vs. semver-parse).
- `data-model.md` — full type definitions for `resolveOrchestratorVersion()` return contract, the resolver's decision matrix (env var × package.json × `"0.0.0"` guard, 6 rows), and the extended `HealthResponse` type (Zod + Fastify schema shape side-by-side).
- `contracts/health-response.md` — the extended `/health` response shape. Covers the 200 branch, the 503 branch, and the schema-strip regression the JSON schema declaration prevents.
- `contracts/orchestrator-version.md` — pre/post conditions on `resolveOrchestratorVersion()`. Input matrix (env var absent/empty/`"0.0.0"`/real × package.json unreadable/`"0.0.0"`/real) → output table. Determinism guarantees (pure function of `process.env` + one file read at call time).
- `quickstart.md` — repro the current bug (curl `/health` on the running orchestrator, observe missing `version`), verify the fix (curl after the change, observe non-`"0.0.0"` value), and the FR-007 test invocation (`pnpm --filter @generacy-ai/orchestrator test health-version`).

## Next Step

Run `/speckit:tasks` to generate the dependency-ordered task list.
