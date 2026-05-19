# Research: Wizard Credentials Env Bridge

## Technology Decisions

### Decision 1: Transient Env File (Option A) over CLI Subcommand (Option B)

**Chosen**: Write `/var/lib/generacy/wizard-credentials.env` from the `bootstrap-complete` handler.

**Rationale**:
- Fastest path to unblock post-activation flow — no new packages or CLI commands
- The env file is consumed once by `entrypoint-post-activation.sh` and deleted
- The existing `ClusterLocalBackend` already provides `fetchSecret()` for unsealing
- Secrets on disk briefly in plaintext is mitigated by: mode 0600, same directory as `master.key`, deleted after first read, `tmpfs` mount option available
- Option B (`generacy credentials get`) is the right long-term answer but requires new CLI infrastructure — filed as follow-up

**Alternatives Rejected**:
- **Option B (CLI subcommand)**: Better security (no plaintext on disk) but requires `generacy credentials get` subcommand, daemon socket access from bash, more moving parts. Follow-up issue.
- **Option C (credhelper socket from bash)**: Awkward — credhelper API is session-based, not designed for one-shot reads. `curl --unix-socket` works but needs session lifecycle management from bash.

### Decision 2: Enumerate from credentials.yaml, Not Backend

**Chosen**: Read credential IDs from `.agency/credentials.yaml` metadata file.

**Rationale**:
- `ClusterLocalBackend` has no `listKeys()` method — adding one is an API change across the shared `@generacy-ai/credhelper` package
- `credentials.yaml` is already written by `writeCredential()` for every wizard credential
- Contains both the ID and the type, which are needed for env var mapping
- Zero dependency changes — just read a YAML file that's already there

### Decision 3: Static ID-to-Env Mapping, Not Plugin Reuse

**Chosen**: Hardcoded mapping in `wizard-env-writer.ts`.

**Rationale**:
- Credhelper plugins (`renderExposure`) are session-scoped and require a full `MintContext` with role, scope, and TTL — massive overkill
- The wizard only creates 2-3 well-known credentials (`github-main-org`, `anthropic-api-key`)
- A static mapping of `type → env var name` is 10 lines vs importing the entire plugin system
- If more credential types are added to the wizard, extending the mapping is trivial

### Decision 4: Best-Effort Semantics

**Chosen**: Write partial env file on unseal failure, emit relay warning, continue with sentinel.

**Rationale**:
- Matches existing control-plane pattern: `writeCredential` uses `failedAt` field for partial failures (AD-3: fail forward)
- Blocking `bootstrap-complete` on a single credential failure would prevent the cluster from progressing entirely
- Cloud UI can display the warning via the relay event
- Post-activation script already handles missing env vars gracefully (warns but continues)

## Implementation Patterns

### Pattern: Module-Level Singleton DI
Used throughout control-plane (e.g., `setCredentialBackend()`, `setRelayPushEvent()`, `getCodeServerManager()`). The new `wizard-env-writer.ts` reuses `getCredentialBackend()` from `credential-writer.ts` — no new singleton needed.

### Pattern: Atomic File Write
`credential-writer.ts` uses temp + rename for `credentials.yaml`. The env file write doesn't need atomicity (consumed once, overwrite-safe), but uses `writeFile` with `{ mode: 0o600 }` for permission safety.

### Pattern: Fire-and-Forget with Warning
`bootstrap-complete` already uses fire-and-forget for code-server start. The env file write is not fire-and-forget (it must complete before the sentinel), but unseal failures within it are non-fatal.

## Key References

| Component | File | Purpose |
|---|---|---|
| bootstrap-complete handler | `packages/control-plane/src/routes/lifecycle.ts:97-118` | Where env file write is inserted |
| credential writer | `packages/control-plane/src/services/credential-writer.ts` | Source of `getCredentialBackend()` singleton |
| ClusterLocalBackend | `packages/credhelper/src/backends/cluster-local-backend.ts` | `fetchSecret(key)` for unsealing |
| credentials.yaml writer | `packages/control-plane/src/services/credential-writer.ts:64-105` | YAML format reference |
| relay events | `packages/control-plane/src/relay-events.ts` | `getRelayPushEvent()` for warning emission |
| lifecycle tests | `packages/control-plane/__tests__/routes/lifecycle.test.ts` | Existing test patterns |
| credential writer tests | `packages/control-plane/__tests__/services/credential-writer.test.ts` | DI mock patterns |

## Env Var Mapping Reference

Based on credhelper-daemon plugin analysis:

| Wizard Credential ID | Type | Env Var | Source |
|---|---|---|---|
| `github-main-org` | `github-app` | `GH_TOKEN` | Well-known wizard ID |
| `anthropic-api-key` | `api-key` | `ANTHROPIC_API_KEY` | Well-known wizard ID |
| (future) any github-* | `github-pat` | `GH_TOKEN` | Type-based fallback |
| (future) any other | `api-key` | `<ID_UPPER_SNAKE>` | Generic fallback |

Note: `GH_TOKEN` (not `GITHUB_TOKEN`) is used because `setup-credentials.sh` in cluster-base checks `${GH_TOKEN:-}`. The credhelper plugin default is `GITHUB_TOKEN` but the bash scripts use `GH_TOKEN`.
