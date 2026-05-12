# Implementation Plan: Wizard Credentials Env Bridge

**Feature**: After bootstrap wizard completes, unseal stored credentials and write a transient env file so post-activation bash scripts can access `GH_TOKEN`, `ANTHROPIC_API_KEY`, etc.
**Branch**: `589-symptoms-after-bootstrap`
**Status**: Complete

## Summary

The bootstrap wizard stores credentials in the AES-256-GCM encrypted credstore (`/var/lib/generacy/credentials.dat`) via `ClusterLocalBackend`, but the post-activation bash scripts (`setup-credentials.sh`, `entrypoint-post-activation.sh`) have no way to access them — they check `$GH_TOKEN` which is never set.

This implements **Option A** from the spec: the `bootstrap-complete` lifecycle handler unseals all stored credentials, maps them to well-known env var names, and writes a transient env file at `/var/lib/generacy/wizard-credentials.env` (mode 0600) **before** writing the sentinel file that triggers post-activation.

## Technical Context

- **Language**: TypeScript (ESM, Node >= 22)
- **Package**: `packages/control-plane`
- **Dependencies**: `@generacy-ai/credhelper` (ClusterLocalBackend, crypto), `yaml` (credentials.yaml parsing), `node:fs/promises`, `node:path`
- **Test Framework**: Vitest
- **Pattern**: Module-level singleton DI (same as `credential-writer.ts`)

## Design Decisions

### D1: Credential Enumeration — Read from `credentials.yaml`
Read credential IDs and types from `.agency/credentials.yaml` (written by `writeCredential()` during wizard flow). No API changes to `ClusterLocalBackend` needed. The metadata file is already the source of truth for "which credentials were stored by the wizard."

### D2: Credential-to-Env-Var Mapping — ID-based with type fallback
The wizard uses well-known credential IDs. The mapping is:

| Credential ID pattern | Env var | Fallback rule |
|---|---|---|
| `github-*` (type `github-app` or `github-pat`) | `GH_TOKEN` | Type-based |
| ID containing `anthropic` (type `api-key`) | `ANTHROPIC_API_KEY` | ID-based |
| Other `api-key` types | `<ID_UPPER_SNAKE>` | e.g., `stripe-key` → `STRIPE_KEY` |
| Any other type | `<ID_UPPER_SNAKE>` | Generic fallback |

This is a static mapping in the new service, easily extended. The mapping does NOT reuse credhelper-daemon plugins (those are session-scoped, overkill for a one-shot env file).

### D3: github-app Value is a Raw Token
During wizard flow, cloud sends the raw installation access token (e.g., `ghs_...`) via `PUT /credentials/:id { type: "github-app", value: "<token>" }`. The stored value is directly usable as `GH_TOKEN` — no JWT minting or parsing required.

### D4: Best-Effort with Relay Warning on Failure
If any credential fails to unseal, the handler writes a partial env file with successfully unsealed credentials, logs a warning, emits a `cluster.bootstrap` relay event with `{ warning: 'credential-unseal-partial', failed: [...] }`, and continues writing the sentinel. Bootstrap is not blocked.

### D5: Env File Lifecycle
- Written by control-plane `bootstrap-complete` handler (this PR)
- Sourced by `entrypoint-post-activation.sh` (cluster-base companion PR)
- Deleted by `entrypoint-post-activation.sh` after sourcing (cleanup in cluster-base)
- On second container start, `credentials.yaml` may exist but sentinel already triggered — no re-write needed (idempotent: overwrite is safe)

### D6: File Permissions
`/var/lib/generacy/wizard-credentials.env` written with mode `0o600`, owned by the Node process user (uid 1002 / `node`). Same directory as `credentials.dat` and `master.key` — already has appropriate ownership.

## Project Structure

```
packages/control-plane/
  src/
    routes/
      lifecycle.ts                    # MODIFIED — call writeWizardEnvFile() before sentinel
    services/
      wizard-env-writer.ts            # NEW — unseal creds, map to env vars, write env file
      credential-writer.ts            # READ-ONLY — reuse getCredentialBackend()
    relay-events.ts                   # READ-ONLY — reuse getRelayPushEvent()
  __tests__/
    services/
      wizard-env-writer.test.ts       # NEW — unit tests for env file generation
    routes/
      lifecycle.test.ts               # MODIFIED — add tests for credential env bridge
```

## Implementation Steps

### Step 1: Create `wizard-env-writer.ts` service

New service at `packages/control-plane/src/services/wizard-env-writer.ts`:

1. **`writeWizardEnvFile(options)`** — main orchestrator function:
   - Reads `.agency/credentials.yaml` to enumerate credential IDs and types
   - For each credential, calls `ClusterLocalBackend.fetchSecret(id)` to unseal
   - Maps each `(id, type, value)` → env var entries via `mapCredentialToEnvEntries()`
   - Writes all entries to env file (mode 0600), one `KEY=value` per line
   - Returns `{ written: string[], failed: string[] }`

2. **`mapCredentialToEnvEntries(id, type, value)`** — pure function mapping:
   - `type: 'github-app' | 'github-pat'` → `[{ key: 'GH_TOKEN', value }]`
   - `id` matching `anthropic` + `type: 'api-key'` → `[{ key: 'ANTHROPIC_API_KEY', value }]`
   - Everything else → `[{ key: idToEnvName(id), value }]`

3. **`idToEnvName(id)`** — converts kebab-case ID to UPPER_SNAKE: `my-api-key` → `MY_API_KEY`

4. **`formatEnvFile(entries)`** — serializes entries as `KEY=value\n` lines (values are not shell-quoted since they don't contain whitespace/special chars — tokens are alphanumeric)

### Step 2: Modify `bootstrap-complete` handler in `lifecycle.ts`

Before writing the sentinel file:
```typescript
// Unseal wizard credentials and write transient env file
try {
  const result = await writeWizardEnvFile({ agencyDir, envFilePath });
  if (result.failed.length > 0) {
    // Emit relay warning
    pushEvent?.('cluster.bootstrap', {
      warning: 'credential-unseal-partial',
      failed: result.failed,
    });
  }
} catch {
  // Non-fatal: log and continue — post-activation will see missing env vars
}
```

The env file is written before the sentinel so `entrypoint-post-activation.sh` can source it.

### Step 3: Write tests

- **`wizard-env-writer.test.ts`**: Unit tests for the service
  - Happy path: two credentials → env file with `GH_TOKEN` and `ANTHROPIC_API_KEY`
  - Empty credentials.yaml → empty env file (no error)
  - One credential fails to unseal → partial file + failed list
  - Mapping correctness for each credential type
  - File permissions check (mode 0600)
  - idToEnvName conversion edge cases

- **`lifecycle.test.ts`**: Integration additions
  - bootstrap-complete writes env file before sentinel
  - bootstrap-complete with no credentials.yaml still succeeds
  - bootstrap-complete with unseal failure still writes sentinel

## Scope Boundaries

### In scope (this PR, generacy repo)
- `wizard-env-writer.ts` service
- `lifecycle.ts` handler modification
- Tests for both

### Out of scope (companion PRs)
- `entrypoint-post-activation.sh` modification to source env file (cluster-base repo)
- `setup-credentials.sh` fallback logic (cluster-base repo)
- Cloud-side `envName` hint in credential payload (future enhancement, Option C from clarifications)
- CLI `generacy credentials get` subcommand (future Option B)
- Post-bootstrap credential edit cache reload
