# Implementation Plan: Acting-identity resolution for the `cluster-identity` trust rule

**Feature**: Follow-up to #869 — introduce a distinct acting-identity source (`CLUSTER_ACTING_LOGIN`) so the `cluster-identity` trust rule fires on freshly-scaffolded clusters where the operator's App-bot login differs from the assignee login.
**Branch**: `874-found-during-cockpit-v1`
**Status**: Complete

## Summary

The `cluster-identity` trust rule shipped in #869 compares `comment.author` against `ctx.clusterIdentity`, but the value threaded into `ctx.clusterIdentity` today is the **assignee** identity resolved by `resolveClusterIdentity()` in `packages/orchestrator/src/services/identity.ts` — sourced from `CLUSTER_GITHUB_USERNAME` / `GH_USERNAME` / `gh api /user`. On a scaffolded cluster running under a GitHub App installation token:

- `CLUSTER_GITHUB_USERNAME` and `GH_USERNAME` are the operator's login (`christrudelpw`) — not the App bot's login;
- `gh api /user` 403s on installation tokens (the #830 pathology);
- The rule therefore compares an App-bot author (`generacy-ai[bot]` in REST / `generacy-ai` in GraphQL) against the operator's login — always false — and every unresolved thread is skipped with `reason: none-untrusted`.

This PR carves out a **separate** acting-identity path that is distinct from the assignee chain and used only by the trust predicate:

1. New env var `CLUSTER_ACTING_LOGIN`, sole source per Q1=A / Q2=A. Scaffolder writes it (FR-003). Cloud-deploy provisioning tracked in a follow-up generacy-cloud issue (FR-004, Q5=A).
2. New `resolveActingIdentity()` in `packages/orchestrator/src/services/acting-identity.ts` — synchronous env read at boot; emits FR-006 error log naming the tried chain link iff the var is unset (Q4=A). Cached for process lifetime.
3. Threaded into `ctx.clusterIdentity` at both trust callsites (`PrFeedbackMonitorService`, `ClaudeCliWorker → PrFeedbackHandler`) **in place of** `clusterGithubUsername`. The assignee identity keeps flowing through `filterByAssignee()` unchanged; the two chains are now separate.
4. `isTrustedCommentAuthor` normalizes both sides of the `clusterIdentity` comparison via a shared `normalizeLogin()` helper: strip `[bot]` suffix, lowercase, trim (FR-002 / Q3=C). The `botLogin === comment.author` path (line 87) receives the same normalization so bot logins stay comparable across REST/GraphQL surfaces.
5. Skip warns in `PrFeedbackMonitorService.pollRepo()` and `PrFeedbackHandler.handle()` include `clusterIdentity` (raw + normalized) plus the observed author's normalized form (FR-005).

**Non-goals** (kept as-is / explicitly out of scope):
- No derivation from the `github-app` credential JSON (Q1=A) — kept as follow-up.
- No App-JWT credential type (out of scope in spec).
- No cloud-deploy change in this repo — tracked in `generacy-cloud` (FR-004).
- No fallback to the assignee chain for the trust comparison (FR-007) — degraded mode is the correct outcome when `CLUSTER_ACTING_LOGIN` is unset.
- No change to `resolveClusterIdentity()` / `filterByAssignee()` behavior — assignee filtering is a different concern.

## Technical Context

**Language / runtime**: TypeScript, Node >=22. ESM.

**Repos / packages touched**:
- `packages/workflow-engine` — extend `comment-trust.ts` with normalization; contract test additions.
- `packages/orchestrator` — new `services/acting-identity.ts`; wire it into `server.ts` in place of `clusterGithubUsername` at both trust callsites; keep `resolveClusterIdentity()` for assignee filtering; update skip-warn shapes.
- `packages/generacy` — extend `scaffolder.ts` `ScaffoldEnvInput` with `actingLogin?: string`; write `CLUSTER_ACTING_LOGIN=<value>` line into `.env` when present; extend `LaunchConfigSchema` in `commands/launch/types.ts` with optional `actingLogin`; thread through `launch/scaffolder.ts` and `deploy/scaffolder.ts` bundle builders.

**Dependencies**: none new. Uses existing `zod` schemas, existing pino logger, existing env-var pipeline.

**Env-var precedent**:
- `CLUSTER_ACTING_LOGIN` (new) — acting login for trust comparison. Written by scaffolder. Container-side only. Never read by `filterByAssignee`.
- `CLUSTER_GITHUB_USERNAME` (existing) — assignee login for `filterByAssignee`. Unchanged.
- `GH_USERNAME` (existing) — assignee fallback source. Unchanged.

**Normalization contract** (`normalizeLogin`):
```
input.trim().toLowerCase().replace(/\[bot\]$/, '')
```
Both sides of the equality go through this pipeline before comparison. See `contracts/normalize-login.contract.md`.

**Caching**: `resolveActingIdentity()` runs once during `createServer()` in `packages/orchestrator/src/server.ts`, the resolved value (or `null`) is closed over by the two trust callsites, no re-read for the process lifetime. Env vars can't transiently change mid-process, so no retry.

## Project Structure

```
specs/874-found-during-cockpit-v1/
├── spec.md                                    (existing, read-only)
├── clarifications.md                          (existing, read-only)
├── plan.md                                    (THIS FILE)
├── research.md                                (technology decisions)
├── data-model.md                              (entity + type definitions)
├── quickstart.md                              (verify locally)
└── contracts/
    ├── normalize-login.contract.md            (normalization pipeline)
    ├── acting-identity-resolver.contract.md   (resolver semantics + FR-006 log line)
    └── skip-warn-shape.contract.md            (FR-005 warn context extension)

packages/workflow-engine/src/security/
├── comment-trust.ts                           (MODIFIED — add normalizeLogin, thread through decision 1.5 + bot login match)
└── __tests__/comment-trust.test.ts            (MODIFIED — SC-002's 16-fixture table-driven test)

packages/orchestrator/src/
├── services/
│   ├── acting-identity.ts                     (NEW — resolveActingIdentity + FR-006 error log)
│   └── __tests__/acting-identity.test.ts      (NEW — env-present, env-absent, whitespace, case, [bot]-suffix cases)
├── server.ts                                  (MODIFIED — call resolveActingIdentity, thread into PrFeedbackMonitorService + ClaudeCliWorker)
├── services/pr-feedback-monitor-service.ts    (MODIFIED — skip-warn ctx gains normalized-form pair; use actingIdentity instead of clusterGithubUsername for trust)
└── worker/pr-feedback-handler.ts              (MODIFIED — FR-006 error log message updated to name CLUSTER_ACTING_LOGIN; skip-warn ctx extended)

packages/generacy/src/cli/commands/
├── cluster/
│   ├── scaffolder.ts                          (MODIFIED — ScaffoldEnvInput.actingLogin; write CLUSTER_ACTING_LOGIN=... line when set)
│   └── __tests__/scaffolder.test.ts           (MODIFIED — .env parity assertion for the new line)
├── launch/
│   ├── types.ts                               (MODIFIED — LaunchConfigSchema.actingLogin?: string)
│   └── scaffolder.ts                          (MODIFIED — thread config.actingLogin into scaffoldEnvFile)
└── deploy/
    └── scaffolder.ts                          (MODIFIED — thread config.actingLogin into scaffoldEnvFile)
```

## Constitution Check

No `.specify/memory/constitution.md` was found. Applied the project's standing conventions:
- Prefer editing existing files over creating new ones — followed except for the resolver (`services/acting-identity.ts`) and its contract/test files, which are additive because separation from `resolveClusterIdentity()` is the whole point of the change.
- No new dependencies.
- No emojis in code (existing untrusted-notice body already contains one — untouched).
- Single-responsibility per FR: each FR maps to a discrete code location (see mapping in `research.md`).
- Fail-loud where surprising, fail-safe where semantic (FR-007 fail-safe by design: no trust rule fires → tier-based rules still apply, degraded but observable).

## Component Design

### 1. `normalizeLogin(raw: string): string`

New pure helper exported from `packages/workflow-engine/src/security/comment-trust.ts`. Pipeline:
```typescript
export function normalizeLogin(raw: string): string {
  return raw.trim().toLowerCase().replace(/\[bot\]$/, '');
}
```
Applied to both sides of the `botLogin` match (line 87) and the `clusterIdentity` match (line 94). Empty result after normalization is treated as "no login" — neither the bot nor cluster-identity branch fires on an empty string, both fall through to the tier gate.

### 2. `resolveActingIdentity(logger: Logger): string | undefined`

New module `packages/orchestrator/src/services/acting-identity.ts`. Synchronous env read (no async, no `gh` fallback, no config layer). Per Q4=A / Q1=A:

- Read `process.env['CLUSTER_ACTING_LOGIN']`.
- If set & non-empty (post-trim): normalize via `normalizeLogin()`, `logger.info(...)`, return normalized value.
- If unset OR empty: `logger.error({ triedChain: ['CLUSTER_ACTING_LOGIN'], reason: 'unset-or-empty' }, 'Acting identity unresolvable — cluster-identity trust rule will not fire. Set CLUSTER_ACTING_LOGIN to the App bot login (e.g., generacy-ai).')`, return `undefined`.

Called once from `createServer()` in `packages/orchestrator/src/server.ts` (near line 161, alongside the existing `resolveClusterIdentity` call). Result stored as a local `actingIdentity`; assignee-identity resolution kept exactly as-is.

### 3. Trust callsite rewiring

Two locations currently pass `clusterGithubUsername` as `ctx.clusterIdentity`:

- `packages/orchestrator/src/server.ts:337` — `ClaudeCliWorkerDeps.clusterIdentity`.
- `packages/orchestrator/src/services/pr-feedback-monitor-service.ts:209` — `PrFeedbackMonitorService` field passed into `isTrustedCommentAuthor` ctx.

Both change to pass the new `actingIdentity` value. The **assignee** filtering (`filterByAssignee()`) continues to key on `clusterGithubUsername` — untouched, tests unaffected. `ClaudeCliWorker.clusterIdentity` → `PrFeedbackHandler.clusterIdentity` chain also swaps to the acting identity.

### 4. Skip-warn context (FR-005)

Two log lines gain the extended context:

- `pr-feedback-monitor-service.ts:285` — "PR has unresolved threads but every comment author is untrusted" warn. Add `clusterIdentity` (raw or `null`), and for each entry in `untrustedCommentSkips`, add `normalizedAuthor` (result of `normalizeLogin(author)`) and `normalizedClusterIdentity`.
- `pr-feedback-handler.ts:263` — "Zero-trusted unresolved threads — retaining waiting-for:address-pr-feedback label" warn. Same extension.

The per-skip "Skipped PR review comment from untrusted author" info line (`pr-feedback-handler.ts:210`) also gains `normalizedAuthor` + `normalizedClusterIdentity` so operators can pinpoint mismatch cases.

### 5. Scaffolder plumbing (FR-003)

- `ScaffoldEnvInput` gains optional `actingLogin?: string`.
- `scaffoldEnvFile()` emits `CLUSTER_ACTING_LOGIN=${input.actingLogin}` in the "Identity" section directly under `GENERACY_ORG_ID` when set. Not emitted when unset (fail-loud via FR-006 at boot).
- `LaunchConfigSchema` gains optional `actingLogin: z.string().min(1).optional()`.
- `launch/scaffolder.ts` and `deploy/scaffolder.ts` thread `config.actingLogin` into their `scaffoldEnvFile()` calls.

No `environment:` block entry is needed in `docker-compose.yml`. The orchestrator and worker services already load `.env` via `env_file: [{ path: '.env' }, { path: '.env.local', required: false }]` at `scaffolder.ts:198–201`; the new var is automatically available.

### 6. `PrFeedbackHandler` FR-006 log update

`packages/orchestrator/src/worker/pr-feedback-handler.ts:125` currently names the old chain:
```
triedChain: ['config', 'CLUSTER_GITHUB_USERNAME', 'GH_USERNAME', 'gh api user']
```
Update to name the new chain per FR-006:
```
triedChain: ['CLUSTER_ACTING_LOGIN']
```
Message text stays informative: "Acting identity unresolvable at handler runtime — cluster-identity trust rule will not fire; tier-based trust still applies."

## Testing Strategy

### Unit tests

- **`comment-trust.test.ts`** — SC-002's 16-fixture table-driven test for `isTrustedCommentAuthor`:
  4 `[bot]` combinations × 2 case × 2 whitespace = 16 (provisioned, observed) login pairs; every pair must return `{ trusted: true, reason: 'cluster-identity' }`. Same matrix repeated for the `botLogin` path.
- **`acting-identity.test.ts`** — env-present, env-empty, env-whitespace, env-with-`[bot]`-suffix, env-with-uppercase; asserts return value + log shape. FR-006 exact wording assertion.
- **`scaffolder.test.ts`** — three cases: `actingLogin` absent → no `CLUSTER_ACTING_LOGIN=` line; present → single `CLUSTER_ACTING_LOGIN=<value>` line under `GENERACY_ORG_ID`; presence in both launch and deploy scaffolder outputs.
- **`pr-feedback-handler.test.ts`** — update the H7 case (already asserting the old chain) to name `['CLUSTER_ACTING_LOGIN']`; add new case: acting identity `Generacy-AI` provisioned, comment author `generacy-ai[bot]` (GraphQL/REST forms) → `reason: cluster-identity`.
- **`clarification-poster-trust.test.ts`** — assertion still holds; `clarificationPoster` reads `CLUSTER_GITHUB_USERNAME` for the "am I the author" self-check, which is a *different* concept (author-of-clarification), not affected by this change.

### Integration test

- **`pr-feedback-integration.test.ts`** — the existing stub at line 2352 that pattern-matches `ctx.clusterIdentity && comment.author === ctx.clusterIdentity` must gain a normalization branch to match the new predicate; add one new fixture asserting a `[bot]` suffix mismatch normalizes correctly end-to-end.

### Manual verification (see `quickstart.md`)

- Fresh `generacy launch --claim=<...>` with `CLUSTER_ACTING_LOGIN=generacy-ai` provisioned; post a review via cockpit; assert `reason: cluster-identity` in decision log.
- Same, without `CLUSTER_ACTING_LOGIN`; assert exactly one `error`-level log line at boot naming `CLUSTER_ACTING_LOGIN`; assert every skip warn carries `clusterIdentity: null`.

## Migration / Deployment Notes

- **Existing clusters** don't gain `CLUSTER_ACTING_LOGIN` by container restart alone. Operators must regenerate `.env` (re-run `generacy launch` after volume cleanup) or hand-add the var to `.env` and `docker compose up -d`. Until then, FR-006's boot error line names exactly what is missing.
- **Cloud-deploy path** (generacy-cloud repo) does not yet populate `LaunchConfig.actingLogin`. Cloud clusters remain in degraded mode (observable via FR-005 / FR-006) until the follow-up ships. Cross-repo tracking issue is filed against generacy-cloud (per FR-004 / Q5=A).
- **Zero behavior change** for clusters where `CLUSTER_ACTING_LOGIN` is unset AND every comment author is a tier-trusted account (OWNER/MEMBER/COLLABORATOR). The change is invisible to healthy workflows.

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Operators typo the value in `.env` (e.g., `generacy_ai` instead of `generacy-ai`), and the trust rule silently keeps failing. | FR-005 skip-warn already logs `normalizedClusterIdentity` alongside `normalizedAuthor` — the mismatch is visible in a single log line. |
| Cloud-deploy divergence causes cloud clusters to stay degraded after this ships. | Cross-repo tracking issue in `generacy-cloud`. `SC-005` grep-diff parity closes both. |
| Normalization is over-aggressive and accidentally matches an unintended login. | Case/whitespace variants of a login are not distinct GitHub identities. The `[bot]` suffix is a rendering artifact of REST author fields, not a separate account. See `research.md` §2. |
| FR-006 error line fires transiently at boot then never re-fires; operator misses it during a fresh restart. | The per-skip warn (FR-005) carries the same signal (`clusterIdentity: null`) on every poll, so any log window with at least one skip is diagnosable. |

## Next Steps

- Generate tasks: `/speckit:tasks`
