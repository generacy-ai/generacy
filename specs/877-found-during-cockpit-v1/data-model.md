# Data Model: `wizard-credentials.env` trailing newline fix

## Overview

This is a bug fix affecting the wire format of a single file (`/var/lib/generacy/wizard-credentials.env`). No new entities, schemas, or persisted data structures are introduced.

## Existing Entities (Unchanged)

### `EnvEntry` (internal)

Defined at `packages/control-plane/src/services/wizard-env-writer.ts:28-31`.

```typescript
interface EnvEntry {
  key: string;   // env var name (e.g. GH_TOKEN, GH_USERNAME)
  value: string; // env var value (opaque; not re-encoded)
}
```

**Validation**: none — inputs come from `mapCredentialToEnvEntries()` which is authoritative for shape.
**Relationships**: produced by `mapCredentialToEnvEntries()`, consumed by `formatEnvFile()`.
**Change**: none.

### `WriteWizardEnvFileOptions`, `WriteWizardEnvFileResult`

Public interfaces of `writeWizardEnvFile()`. Unchanged — this fix does not alter the exported API surface.

## File Format Contract

### `/var/lib/generacy/wizard-credentials.env`

**Producer**: `writeWizardEnvFile()` in `packages/control-plane/src/services/wizard-env-writer.ts`.
**Consumer**: `entrypoint-post-activation.sh` (cluster-base) via `set -a; source $WIZARD_CREDS; set +a`.

**Format** (post-fix):

```
<KEY>=<VALUE>\n
<KEY>=<VALUE>\n
...
<KEY>=<VALUE>\n
```

**Invariants** (post-fix):

| Invariant | Before | After | Enforced by |
|-----------|--------|-------|-------------|
| Mode is `0o600` | ✓ | ✓ (unchanged) | `fs.writeFile(..., { mode: 0o600 })` |
| Non-empty file ends with `\n` | ✗ (bug) | ✓ | `formatEnvFile()` appends `+ '\n'` |
| Empty credential set produces `''` or `'\n'` | `''` | `''` (unchanged, permitted by FR-002) | Empty-branch early return |
| One entry per line, `KEY=VALUE` format | ✓ | ✓ (unchanged) | `.map(e => \`${e.key}=${e.value}\`)` |
| Naive `>> append` of `NEW=v\n` yields a superset of parseable keys | ✗ (bug — corrupts last key) | ✓ | Trailing-`\n` invariant makes `>>` land on a new line |

## Persisted State

No changes to:

- `credentials.yaml` (`.agency/credentials.yaml`) — parsed only, unchanged.
- `credentials.dat` (`ClusterLocalBackend`) — read only, unchanged.
- `master.key` (`/var/lib/generacy/master.key`) — not touched.

## API Surface

No changes:

- No new exports from `wizard-env-writer.ts`.
- No changes to Zod schemas.
- No route additions to control-plane or credhelper-daemon.
- No changes to relay message shapes.
