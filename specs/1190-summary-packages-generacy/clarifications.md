# Clarifications: activation test reads ambient `GENERACY_PROJECT_ID`

Issue: [generacy-ai/generacy#1190](https://github.com/generacy-ai/generacy/issues/1190)

## Batch 1 — 2026-08-24

### Q1: Fix approach
**Context**: FR-001 permits either isolating the variable in the test (`vi.stubEnv` / `delete`) OR removing the production dependency on ambient env (FR-003). FR-003 is marked "(preferred)"/"SHOULD" — it threads `projectId` through `runActivation`'s options and resolves `process.env['GENERACY_PROJECT_ID']` once at the CLI entry point (`deploy/index.ts`). The choice determines whether any `packages/generacy/src/` code changes, which in turn determines whether a `.changeset/1190-*.md` is required (NFR-002).
**Question**: Which fix approach should this PR ship?
**Options**:
- A: FR-003 production refactor (preferred) — thread `projectId` through `ActivateOptions`, read env at `index.ts`, make `runActivation` pure; add `.changeset/1190-*.md` (`@generacy-ai/generacy` patch); tests pass projectId explicitly.
- B: Test-only isolation — leave `activation.ts` reading ambient env, fix determinism with `vi.stubEnv`/`delete` + `afterEach` cleanup only; no changeset (test-only exempt).

**Answer**: A — FR-003 production refactor. Thread `projectId` through `runActivation`'s options (`ActivateOptions`), resolve `process.env['GENERACY_PROJECT_ID']` once at the CLI entry point (`deploy/index.ts`), and add `.changeset/1190-*.md` (`@generacy-ai/generacy` patch). Tests pass `projectId` explicitly and cover both branches of `buildActivationUrl` deterministically. Rationale: B fixes the symptom but leaves `runActivation` environment-dependent (the next test re-acquires the bug), and B's "test-only exempt" assumption is a known way for generacy PRs to land red on the changeset bot.

### Q2: `exports.test.ts:17` disposition
**Context**: FR-005 requires the truncated second failure (`__tests__/exports.test.ts:17`) to be investigated and either fixed (if env-leak class) or documented as out-of-scope (if a separate build/import concern). Line 17 is `await import('@generacy-ai/generacy')` — a package-main entry import, i.e. a build/dist-availability concern in the worker, not an env-leak.
**Question**: How should this PR treat `exports.test.ts:17`?
**Options**:
- A: Document it out-of-scope with the build/import rationale (recommended) — it is not env-leak class; file a separate follow-up if it recurs.
- B: Bring it into scope and fix the build/import failure in this PR as well.

**Answer**: B — bring `__tests__/exports.test.ts:17` into scope and fix it in this PR, AND correct the classification: it is **not** a build/dist-availability concern. Reproduced in a devcontainer with `dist/index.js` present, the case fails with a **10 s vitest timeout** (`Test timed out in 10000ms`), while the 19 sibling subpath-export tests pass — so the package is built and resolvable. A plain-node `import('./dist/index.js')` completes in ~812 ms; the failure is load-sensitive because resolving the package *main* barrel drags the whole CLI tree through vitest's transform pipeline (~6 s transform), so it is green on an idle machine and reliably red on a busy worker — the same divergence class as the primary bug. Deferring it leaves the #1187 validate run red (2 files failed), so Option A would not unblock anything. Suggested fixes (pick smallest that holds; state choice in PR description): give the case an explicit generous timeout (e.g. `60_000`), point the assertion at `dist/index.js` directly, or drop the main-entry smoke test (19 subpath tests already cover the consumer surface).
