# Clarifications — #481 BackendClient Factory (Phase 7a)

## Batch 1 — 2026-04-15

### Q1: Unknown backend type — validate at config load or factory dispatch?
**Context**: Acceptance criterion 4 says "Unknown backend type in `backends.yaml` fails at config load with a clear error." However, `BackendEntrySchema.type` is currently `z.string()` (accepts any string), and the Out of Scope section explicitly excludes "Changes to the credhelper shared types package." Tightening the Zod schema to `z.enum(['env', 'generacy-cloud'])` would require a shared package change.
**Question**: Where should unknown backend type validation happen?
**Options**:
- A: At Zod schema level in `credhelper` shared package (tighten `type` to enum — contradicts Out of Scope)
- B: At factory dispatch time in `credhelper-daemon` only (keeps shared package unchanged, but validation happens at runtime not parse time)
- C: Both — add enum validation to schema AND factory dispatch (belt-and-suspenders, but requires shared package change)

**Answer**: B — factory dispatch time in credhelper-daemon only.**

Keep the shared `@generacy-ai/credhelper` types package unchanged in this issue (matches the Out of Scope note). Validation happens at runtime when the `BackendClientFactory.create()` dispatches on the `type` field:

```typescript
// packages/credhelper-daemon/src/backends/factory.ts
export class BackendClientFactory {
  create(backend: BackendConfig): BackendClient {
    switch (backend.type) {
      case 'env':
        return new EnvBackend();
      case 'generacy-cloud':
        return new GeneracyCloudBackend();
      default:
        throw new UnknownBackendTypeError(
          `Unknown backend type '${backend.type}' in backends.yaml (backend id: '${backend.id}'). ` +
          `Supported types: env, generacy-cloud.`,
        );
    }
  }
}
```

Factory dispatch runtime validation:
- Gives the same fail-closed behavior the acceptance criterion asks for (daemon startup fails if any `backends.yaml` entry has an unknown type)
- Error is clear and names both the invalid value and the list of supported types
- Doesn't require a shared-package schema change or a cross-package coordination PR

Acceptance criterion 4 should be read as "Unknown backend type fails at daemon startup (during factory initialization over the loaded config) with a clear error" — the factory iterates declared backends at startup to produce a `Map<backend_id, BackendClient>`, which is when the validation fires. Config load (Zod parsing) still succeeds because `type: z.string()` accepts anything; the daemon-side factory is the enforcement point.

If later we want earlier validation (catching typos before the daemon even starts), that's a clean follow-up — tighten the Zod enum in the shared package and retire the runtime check. Not worth scope-creeping this issue.

---

### Q2: Per-plugin integration tests — Phase 7a scope or follow-up?
**Context**: FR-009 (P2) requires "at least one integration test per core plugin exercising real EnvBackend" — that's 7 plugins × 1 test = 7 new integration tests. However, the acceptance criteria only specify "New integration test exercises a full session with env-backed credentials and a mock plugin" (a single integration test). These are different scopes of work.
**Question**: Should per-plugin integration tests (FR-009) be included in Phase 7a, or deferred to a follow-up?
**Options**:
- A: Include in Phase 7a (adds ~7 integration tests alongside the core work)
- B: Defer to follow-up issue (Phase 7a delivers only the single integration test from acceptance criteria)

**Answer**: B — defer per-plugin integration tests to a follow-up.**

FR-009's "at least one integration test per core plugin" (7 tests) was overspecified in my original issue body relative to the core deliverable. The acceptance criterion as written — a single end-to-end integration test covering the full session with env-backed credentials — is the right scope for Phase 7a.

Rationale:
- The core value of Phase 7a is replacing the four empty-string stubs. One end-to-end test proves the factory + env backend + session rendering chain works.
- Per-plugin integration tests are valuable for regression coverage but orthogonal to the structural fix. They can be added opportunistically as plugins change or new plugins are added, without blocking this unblocker.
- Scope creep here delays the broader unblocking effect. Phase 7a is in the critical path for any end-to-end testing; every extra test shape that has to land first is a slowdown.

**Action**: drop FR-009's "per-plugin" language from the Phase 7a acceptance criteria. File a separate follow-up issue titled something like "Add per-plugin integration tests with real EnvBackend" and tag it with a lower priority. The existing plugin unit tests (with inline `vi.fn().mockResolvedValue(...)` mocks) continue to catch plugin-internal regressions in the meantime.

If the implementer finds that adding a per-plugin integration test is trivial as part of Phase 7a work (e.g., the scaffolding is already there), they can include one or two opportunistically — but it's not a gate.
