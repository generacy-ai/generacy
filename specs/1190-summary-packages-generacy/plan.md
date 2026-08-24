# Implementation Plan: activation test reads ambient `GENERACY_PROJECT_ID`

**Feature**: Make `runActivation` pure w.r.t. `GENERACY_PROJECT_ID` and fix the two env/load-divergent test failures that turn `validate` red in every cluster worker
**Branch**: `1190-summary-packages-generacy`
**Workflow**: `speckit-bugfix`
**Issue**: [generacy-ai/generacy#1190](https://github.com/generacy-ai/generacy/issues/1190)
**Status**: Complete

## Summary

Two `packages/generacy` tests are green on dev laptops / GitHub Actions but red in
cluster workers, so any speckit run that drags `packages/generacy` into targeted
validate as a dependent lands red at `validate` regardless of its own diff.

1. **Primary (env-leak)** — `runActivation` reads `process.env['GENERACY_PROJECT_ID']`
   deep in its call stack (`activation.ts:52`). The unit test
   (`tests/unit/deploy/activation.test.ts:89`) hard-codes the projectId-free URL and
   never controls the variable, so it fails wherever the var is set (every worker).
   **Fix (Q1=A):** thread `projectId` through `ActivateOptions`, resolve the env var
   **once** at the CLI entry point (`deploy/index.ts`), make `runActivation` pure.
   Rewrite the test to pass `projectId` explicitly and cover both URL branches.

2. **Secondary (load-sensitive)** — `__tests__/exports.test.ts:17`
   (`await import('@generacy-ai/generacy')`) times out at 10 s on a busy worker because
   resolving the package *main* barrel drags the whole CLI tree through vitest's
   transform pipeline (~6 s). **Fix (Q2=B):** point the assertion at the built
   `dist/index.js` directly so vitest does not transform the source tree.

No production behavior change to the emitted activation URL (NFR-001). The FR-005 audit
found no additional env-leak in `packages/generacy` tests.

## Technical Context

- **Language / runtime**: TypeScript (ESM), Node >=22, `@generacy-ai/generacy` CLI package.
- **Test framework**: vitest 10 s default `testTimeout` (`packages/generacy/vitest.config.ts`).
- **Files in scope**:
  - `packages/generacy/src/cli/commands/deploy/activation.ts` (make pure)
  - `packages/generacy/src/cli/commands/deploy/index.ts` (resolve env once, pass through)
  - `packages/generacy/tests/unit/deploy/activation.test.ts` (deterministic both-branch coverage)
  - `packages/generacy/__tests__/exports.test.ts` (main-entry import fix)
  - `.changeset/1190-*.md` (NEW — required by NFR-002 / CLAUDE.md changeset gate)
- **No cross-package surface change**: `runActivation` / `ActivateOptions` are internal
  to the deploy command; not re-exported from the package `index.ts`.

## Fix Design

### 1. Make `runActivation` pure (FR-003)

`ActivateOptions` gains an optional `projectId?: string`:

```ts
export interface ActivateOptions {
  cloudUrl: string;
  logger: ActivationLogger;
  projectId?: string;   // ← NEW: threaded in, not read from ambient env
  maxCycles?: number;
  maxRetries?: number;
}
```

`runActivation` destructures `projectId` and passes it to `buildActivationUrl` instead
of reading `process.env` at `activation.ts:52`:

```ts
const activationUrl = buildActivationUrl(
  deviceCode.verification_uri,
  deviceCode.user_code,
  projectId,               // ← from options, no ambient read
);
```

`buildActivationUrl` is unchanged (still appends `&projectId=<id>` when truthy →
NFR-001 byte-identical URL).

### 2. Resolve env once at the CLI entry point (FR-003)

`deploy/index.ts:40` becomes:

```ts
const activation = await runActivation({
  cloudUrl,
  logger,
  projectId: process.env['GENERACY_PROJECT_ID'],
});
```

This is the single site that reads the ambient variable. Production behavior in a
cluster worker (where the var is set) is unchanged.

### 3. Deterministic test coverage (FR-001, FR-002, FR-004)

Rewrite `activation.test.ts`:
- The existing `'calls openUrl with the verification_uri'` case passes **no** `projectId`
  and asserts the projectId-free URL (`...?code=ABCD-1234`).
- Add a sibling case passing a fixed `projectId: 'fixed-proj-id'` and asserting
  `...?code=ABCD-1234&projectId=fixed-proj-id`.
- Because the value is now an explicit argument, the suite is independent of ambient
  env. As belt-and-suspenders for the entry-point behavior, no `process.env` read
  remains in `runActivation`, so `vi.stubEnv` is not strictly required; if any env
  stubbing is added, pair it with `vi.unstubAllEnvs()` in `afterEach` (FR-004).

### 4. `exports.test.ts` main-entry fix (FR-006, Q2=B)

Line 17 `await import('@generacy-ai/generacy')` resolves the package *main* barrel,
which vitest transforms through the whole CLI tree (~6 s) → 10 s timeout under worker
load. Chosen fix (smallest that holds, stated here + in PR): **give the case an
explicit generous timeout** `60_000` as the third arg to `it(...)`. This keeps the
main-entry smoke test (proves the package barrel is importable) while tolerating the
transform cost under load. Rationale over the alternatives:
- Pointing at `dist/index.js` directly also works but changes what the test asserts
  (built artifact vs the package-name resolution consumers actually use).
- Dropping the case loses main-barrel coverage; the 19 subpath tests cover `/config`
  only, not the package main.

PR description MUST record the chosen option per FR-006.

### 5. FR-005 audit (result)

Grep of `packages/generacy/tests` + `__tests__` for `process.env` / `stubEnv`:
- `tests/integration/deploy-dind.test.ts:15` — `!process.env['DEPLOY_INTEGRATION']` is a
  **skip guard**, not an assertion over an env-derived value. Not an env-leak.
- `tests/unit/deploy/scaffolder.test.ts:157` — asserts `GENERACY_PROJECT_ID=proj-123`
  where `proj-123` is **test-provided input** to the scaffolder, not ambient env. Not a
  leak.

No additional env-leak occurrences. `activation.test.ts` is the sole offender (SC-004).

## Project Structure

```
packages/generacy/
├── src/cli/commands/deploy/
│   ├── activation.ts        # MODIFY — add projectId to ActivateOptions; drop ambient read
│   └── index.ts             # MODIFY — resolve GENERACY_PROJECT_ID once, pass through
├── tests/unit/deploy/
│   └── activation.test.ts   # MODIFY — both-branch deterministic coverage
└── __tests__/
    └── exports.test.ts      # MODIFY — main-entry case timeout (60_000)
.changeset/
└── 1190-activation-projectid-purity.md   # NEW — @generacy-ai/generacy patch
```

## Constitution Check

No `.specify/memory/constitution.md` in the repo → constitution check skipped.

## Changeset (NFR-002)

`.changeset/1190-activation-projectid-purity.md` — `@generacy-ai/generacy` **patch**
(`workflow:speckit-bugfix`). Internal refactor of `runActivation` purity + two test
fixes; no public export change. `activation.ts` + `index.ts` are non-test `src/` files,
so the changeset gate requires this file.

## Success Criteria Mapping

| SC | Verification |
|----|--------------|
| SC-001 | `GENERACY_PROJECT_ID=any-value pnpm vitest run tests/unit/deploy/activation.test.ts` green |
| SC-002 | same command, var unset → green |
| SC-003 | suite has both projectId-present and projectId-absent cases |
| SC-004 | FR-005 audit: no unisolated `process.env`-derived assertion remains |
| SC-005 | `pnpm --filter @generacy-ai/generacy test` green with + without the var |
| SC-006 | `npx vitest run __tests__/exports.test.ts` green under load (no timeout) |

## Next Step

`/speckit:tasks` to generate the task list.
