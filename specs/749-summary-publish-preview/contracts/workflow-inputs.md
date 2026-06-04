# Contract: publish-preview workflow inputs and outputs

## Triggers

```yaml
on:
  push:
    branches: [develop]
  workflow_dispatch:
    inputs:
      force_rollback:
        description: 'Skip staleness guard for deliberate rollback. Logs a warning. Use only during incident response.'
        type: boolean
        required: false
        default: false
```

### Input semantics

| Trigger | `force_rollback` honored? |
|---------|---------------------------|
| `push: develop` | No (push events have no inputs; field is unreadable) |
| `workflow_dispatch` | Yes |

### Expression-evaluation note

`github.event.inputs.force_rollback` is a **string** (`"true"`/`"false"`)
even though `type: boolean` is declared. The workflow MUST use string
comparison:

```yaml
if: github.event.inputs.force_rollback != 'true'
```

NOT `!= true` (which compares to a literal, never matches).

## Published artifact contract

For every non-private, non-ignored package (`packages/*/package.json`
where `private !== true` and the package name is not in
`.changeset/config.json#ignore`):

```jsonc
{
  "name": "@generacy-ai/<pkg>",
  "version": "0.0.0-preview-<YYYYMMDDHHMMSS>-<sha7>",
  "gitHead": "<full-40-char-sha>",
  "generacy": {
    "sourceSha": "<full-40-char-sha>"
    // ... other generacy fields preserved
  }
  // ... all other fields preserved
}
```

### Verification commands (per SC-002)

```bash
# Short SHA in version string (human-visible)
npm view @generacy-ai/generacy@preview version
# → 0.0.0-preview-20260604120000-abc1234

# Full SHA via npm conventional field
npm view @generacy-ai/generacy@preview gitHead
# → abc1234567890abcdef1234567890abcdef123456

# Full SHA via Generacy tooling namespace
npm view @generacy-ai/generacy@preview generacy.sourceSha
# → abc1234567890abcdef1234567890abcdef123456
```

## Staleness check contract

**Inputs**: `candidateSha` (current `origin/develop` HEAD),
`currentPreviewSha` (from `npm view`), `forceRollback` (workflow input).

**Output**: Process exit code.

| Exit | Meaning |
|------|---------|
| `0` | Safe to publish (baseline missing, equal-SHA republish, candidate is fresh, OR `force_rollback=true`) |
| `1` | Refused — candidate is a strict ancestor of current preview |

**Required log output on refusal**:

```text
STALE: candidate <candidate-sha> is an ancestor of current preview <current-sha>
Refusing to publish. Set force_rollback=true to override (workflow_dispatch only).
```

**Required log output on rollback override**:

```text
WARNING: force_rollback=true — skipping staleness check.
  candidate    = <candidate-sha>
  current      = <current-sha>
  This is an auditable, deliberate backward publish.
```

## Stamping contract

**Inputs**: `git rev-parse HEAD` (full SHA), iteration over
`packages/*/package.json` filtered by `private` and ignore list.

**Side effects**:
- For each eligible `package.json`:
  - If `version` does not already end with `-<sha7>`, append `-<sha7>`.
  - Set `gitHead = <full-sha>`.
  - Set `generacy.sourceSha = <full-sha>` (preserving other `generacy.*` keys).
  - Write file back with `JSON.stringify(pkg, null, 2) + '\n'`.

**Idempotency**: Running the stamper twice in a row at the same SHA
produces no diff after the first run.

**Ordering**: The stamper MUST run AFTER `pnpm changeset version
--snapshot preview` (which rewrites `version`) and BEFORE
`scripts/verify-pack-no-workspace-deps.js` (so the verify step sees the
final manifest) and BEFORE `pnpm publish` (so the registry receives the
stamped manifests).
