# Clarifications: activation test reads ambient `GENERACY_PROJECT_ID`

Issue: [generacy-ai/generacy#1190](https://github.com/generacy-ai/generacy/issues/1190)

## Batch 1 — 2026-08-24

### Q1: Fix approach
**Context**: FR-001 permits either isolating the variable in the test (`vi.stubEnv` / `delete`) OR removing the production dependency on ambient env (FR-003). FR-003 is marked "(preferred)"/"SHOULD" — it threads `projectId` through `runActivation`'s options and resolves `process.env['GENERACY_PROJECT_ID']` once at the CLI entry point (`deploy/index.ts`). The choice determines whether any `packages/generacy/src/` code changes, which in turn determines whether a `.changeset/1190-*.md` is required (NFR-002).
**Question**: Which fix approach should this PR ship?
**Options**:
- A: FR-003 production refactor (preferred) — thread `projectId` through `ActivateOptions`, read env at `index.ts`, make `runActivation` pure; add `.changeset/1190-*.md` (`@generacy-ai/generacy` patch); tests pass projectId explicitly.
- B: Test-only isolation — leave `activation.ts` reading ambient env, fix determinism with `vi.stubEnv`/`delete` + `afterEach` cleanup only; no changeset (test-only exempt).

**Answer**: *Pending*

### Q2: `exports.test.ts:17` disposition
**Context**: FR-005 requires the truncated second failure (`__tests__/exports.test.ts:17`) to be investigated and either fixed (if env-leak class) or documented as out-of-scope (if a separate build/import concern). Line 17 is `await import('@generacy-ai/generacy')` — a package-main entry import, i.e. a build/dist-availability concern in the worker, not an env-leak.
**Question**: How should this PR treat `exports.test.ts:17`?
**Options**:
- A: Document it out-of-scope with the build/import rationale (recommended) — it is not env-leak class; file a separate follow-up if it recurs.
- B: Bring it into scope and fix the build/import failure in this PR as well.

**Answer**: *Pending*
