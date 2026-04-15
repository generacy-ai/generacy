# Clarifications — #481 BackendClient Factory (Phase 7a)

## Batch 1 — 2026-04-15

### Q1: Unknown backend type — validate at config load or factory dispatch?
**Context**: Acceptance criterion 4 says "Unknown backend type in `backends.yaml` fails at config load with a clear error." However, `BackendEntrySchema.type` is currently `z.string()` (accepts any string), and the Out of Scope section explicitly excludes "Changes to the credhelper shared types package." Tightening the Zod schema to `z.enum(['env', 'generacy-cloud'])` would require a shared package change.
**Question**: Where should unknown backend type validation happen?
**Options**:
- A: At Zod schema level in `credhelper` shared package (tighten `type` to enum — contradicts Out of Scope)
- B: At factory dispatch time in `credhelper-daemon` only (keeps shared package unchanged, but validation happens at runtime not parse time)
- C: Both — add enum validation to schema AND factory dispatch (belt-and-suspenders, but requires shared package change)

**Answer**: *Pending*

### Q2: Per-plugin integration tests — Phase 7a scope or follow-up?
**Context**: FR-009 (P2) requires "at least one integration test per core plugin exercising real EnvBackend" — that's 7 plugins × 1 test = 7 new integration tests. However, the acceptance criteria only specify "New integration test exercises a full session with env-backed credentials and a mock plugin" (a single integration test). These are different scopes of work.
**Question**: Should per-plugin integration tests (FR-009) be included in Phase 7a, or deferred to a follow-up?
**Options**:
- A: Include in Phase 7a (adds ~7 integration tests alongside the core work)
- B: Defer to follow-up issue (Phase 7a delivers only the single integration test from acceptance criteria)

**Answer**: *Pending*
