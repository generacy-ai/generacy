# Research: activation test ambient env + exports load-timeout

Issue: [generacy-ai/generacy#1190](https://github.com/generacy-ai/generacy/issues/1190)

## Decision 1 — Purity refactor over test-only isolation (Clarification Q1=A)

**Decision**: Thread `projectId` through `ActivateOptions`; resolve
`process.env['GENERACY_PROJECT_ID']` exactly once at the CLI entry point
(`deploy/index.ts`). Make `runActivation` pure with respect to its inputs.

**Alternatives considered**:
- **B — test-only isolation** (`vi.stubEnv` / `delete` + `afterEach` cleanup, leave
  `activation.ts` reading ambient env). Rejected: fixes the symptom but leaves
  `runActivation` environment-dependent, so the next test over this function
  re-acquires the bug. It also relies on the "test-only ⇒ changeset-exempt" assumption,
  a known way generacy PRs land red on the changeset bot.

**Rationale**: A pure function is deterministic across environments by construction —
the strongest form of FR-001. The single ambient read moves to the composition root,
which is the only place that legitimately owns process-environment coupling.

## Decision 2 — `exports.test.ts:17` is load-sensitive, not build-availability (Q2=B)

**Finding**: With `dist/index.js` present, `await import('@generacy-ai/generacy')` fails
with a **10 s vitest timeout** while the 19 sibling subpath tests pass, so the package
is built and resolvable. A plain-node `import('./dist/index.js')` completes in ~812 ms.
The failure is load-sensitive: resolving the package *main* barrel drags the whole CLI
tree through vitest's transform pipeline (~6 s transform), green on an idle machine and
reliably red on a busy worker — the same env/load divergence class as the primary bug.

**Decision**: Bring it in scope (not defer). Chosen fix: explicit `60_000` timeout on
the `it(...)` case (smallest change that keeps main-barrel coverage).

**Alternatives considered**:
- **Point the import at `dist/index.js` directly** — avoids the transform cost, but
  changes the assertion from "the published package name resolves" to "the built file
  imports", weakening the consumer-surface intent of the test.
- **Drop the main-entry smoke test** — the 19 subpath tests cover `/config` only, not
  the package main barrel; dropping loses that coverage.

**Rationale**: The generous timeout preserves what the test asserts while tolerating the
worst-case transform cost under worker load. FR-006 requires stating the chosen option
in the PR description.

## Decision 3 — FR-005 sibling audit result

Grepped `packages/generacy/tests` and `packages/generacy/__tests__` for `process.env` /
`stubEnv`:
- `tests/integration/deploy-dind.test.ts:15` — `!process.env['DEPLOY_INTEGRATION']` is a
  test **skip guard** (and an integration test excluded from the default run), not an
  assertion over an env-derived value.
- `tests/unit/deploy/scaffolder.test.ts:157` — `GENERACY_PROJECT_ID=proj-123` is asserted
  over scaffolder **output** where `proj-123` is test-provided input, not ambient env.

No additional env-leak. `activation.test.ts` is the sole offender.

## Implementation patterns referenced

- **Composition-root env read**: matches the codebase pattern where CLI commands resolve
  ambient config once at `index.ts` and pass values down (e.g. `resolveApiUrl(options.cloudUrl)`
  at `deploy/index.ts:38`).
- **Changeset shape**: single `@generacy-ai/generacy` patch entry, mirroring existing
  `.changeset/*.md` files (see `.changeset/1005-adopt-existing-smee-channel.md`).

## Key sources

- `packages/generacy/src/cli/commands/deploy/activation.ts:15-22,35-52`
- `packages/generacy/src/cli/commands/deploy/index.ts:38-40`
- `packages/generacy/tests/unit/deploy/activation.test.ts:82-90`
- `packages/generacy/__tests__/exports.test.ts:13-22`
- `packages/generacy/vitest.config.ts` (`testTimeout: 10000`)
