# Research — #558 Credential Persistence in Control-Plane

## Technology Decisions

### TD-1: Storage Module Location

**Decision**: Extract `ClusterLocalBackend`, `CredentialFileStore`, and crypto helpers to `packages/credhelper/src/backends/` (the existing shared `@generacy-ai/credhelper` package).

**Rationale**: The shared credhelper package already contains the `WritableBackendClient` interface that `ClusterLocalBackend` implements. Moving the implementation alongside its interface is the natural home. Both consumers (credhelper-daemon and control-plane) already depend on this package.

| Alternative | Pros | Cons |
|-------------|------|------|
| A: New `@generacy-ai/cluster-secrets` package | Clean separation | New package overhead, new dep for both consumers, more monorepo config |
| B: Import credhelper-daemon directly from control-plane | Zero extraction work | Pulls in full daemon (sessions, plugins, docker proxy) as transitive dep |
| **C: Extract to `@generacy-ai/credhelper`** | **Single source of truth, flat dep graph, no new package** | **Grows a types-only package with runtime code** |
| D: Duplicate crypto in control-plane | No cross-package dep | Divergence risk, double maintenance |

Decision C accepted. The "types-only" label for credhelper is already inaccurate — it includes Zod schemas (runtime code). Adding storage modules is a natural evolution.

### TD-2: Error Handling in Extracted Modules

**Decision**: Replace `CredhelperError` references with a lightweight `StorageError` class in the extracted modules.

**Rationale**: `CredhelperError` is tightly coupled to credhelper-daemon's HTTP error response format (status codes, `toResponse()`). The extracted storage modules don't need HTTP semantics. A simple error class with a `code` string field is sufficient.

| Alternative | Pros | Cons |
|-------------|------|------|
| A: Copy `CredhelperError` to shared package | Familiar API | Drags HTTP status mapping into a storage layer |
| **B: New `StorageError` with code field** | **Clean, minimal, storage-focused** | **Daemon must catch and re-wrap** |
| C: Throw plain `Error` with code property | No new class | Inconsistent error handling pattern |

Daemon already catches backend errors in session manager — wrapping `StorageError` → `CredhelperError` is a one-line change.

### TD-3: Credential Metadata Format

**Decision**: Store metadata in `.agency/credentials.yaml` as a map keyed by credential ID.

**Rationale**: The `.agency/` directory is the established location for cluster configuration (roles, config). Using YAML matches the existing `roles.yaml` pattern. The `yaml` npm package is already a dependency of both credhelper and control-plane.

```yaml
# .agency/credentials.yaml
credentials:
  github-main-org:
    type: github-app
    backend: cluster-local
    status: active
    updatedAt: "2026-05-10T12:00:00Z"
  anthropic/api-key:
    type: api-key
    backend: cluster-local
    status: active
    updatedAt: "2026-05-10T12:00:00Z"
```

### TD-4: Backend Instance Lifecycle

**Decision**: Eagerly initialize `ClusterLocalBackend` at control-plane startup.

**Rationale**: Matches credhelper-daemon's pattern where `init()` is called in `bin/credhelper-daemon.ts` before accepting requests. Fail-fast on missing master key gives a clear error rather than a 500 on first credential write.

| Alternative | Pros | Cons |
|-------------|------|------|
| **A: Eager init at startup** | **Fail-fast, clear errors, matches daemon pattern** | **Blocks startup if key missing** |
| B: Lazy init on first write | Startup never blocked | Silent until first request; harder to debug |
| C: Init per-request | Always fresh state | Wasteful; re-reads key file every time |

### TD-5: Relay Event Channel

**Decision**: Use `cluster.credentials` channel with payload `{ credentialId, type, status: 'written' }`.

**Rationale**: Follows the established pattern from `cluster.audit` (audit route) and `cluster.bootstrap` (peer-repo-cloner). The cloud side can listen on this channel to update wizard UI state.

## Implementation Patterns

### Pattern 1: Atomic YAML Write (from `default-role-writer.ts`)

```typescript
const tmpPath = `${yamlPath}.tmp.${process.pid}`;
await fs.writeFile(tmpPath, yaml.stringify(doc));
await fs.rename(tmpPath, yamlPath);
```

This pattern is used for `.generacy/config.yaml` writes and will be reused for `.agency/credentials.yaml`.

### Pattern 2: Relay Event Emission (from `audit.ts`)

```typescript
const pushEvent = getRelayPushEvent();
if (pushEvent) {
  pushEvent('cluster.credentials', { credentialId, type, status: 'written' });
}
```

Nil-safe — works even if relay is not injected (e.g., during testing).

### Pattern 3: Error Response with `failedAt` (new)

```typescript
res.writeHead(500, { 'Content-Type': 'application/json' });
res.end(JSON.stringify({
  error: 'Credential write failed',
  code: 'CREDENTIAL_WRITE_FAILED',
  failedAt: 'metadata-write',
}));
```

Extends the existing `{ error, code, details? }` error shape with `failedAt` for partial failure diagnosis.

## Key Sources

| Source | Purpose |
|--------|---------|
| `packages/control-plane/src/services/default-role-writer.ts` | Atomic YAML write pattern, `.agency/` file access |
| `packages/control-plane/src/routes/audit.ts` | Relay event emission pattern |
| `packages/control-plane/src/routes/credentials.ts` | Current stub handlers to replace |
| `packages/credhelper-daemon/src/backends/cluster-local-backend.ts` | Primary extraction source |
| `packages/credhelper-daemon/src/backends/crypto.ts` | AES-256-GCM helpers to extract |
| `packages/credhelper-daemon/src/backends/file-store.ts` | File store to extract |
| `packages/credhelper/src/types/context.ts` | `WritableBackendClient` interface |
| `packages/control-plane/src/relay-events.ts` | `getRelayPushEvent()` singleton |

## Security Considerations

1. **Secret values never in metadata** — `.agency/credentials.yaml` contains only type/backend/status. The actual secret is only in the AES-256-GCM encrypted file store.
2. **Actor required** — `requireActor(actor)` enforced on PUT (existing pattern from stub).
3. **Master key permissions** — `/var/lib/generacy/master.key` is mode 0600, uid 1002. Control-plane process must run as the same user or have read access.
4. **No secret in logs** — The `failedAt` error response contains only the step name, never the credential value.
5. **No secret in relay events** — Event payload contains `credentialId` and `type`, never the secret value.

---

*Generated by speckit*
