# Data Model

This feature does not introduce database entities. The "data model" here is
the shape of the version string and the metadata fields written into each
published `package.json`, plus the workflow input shape.

## Entities

### PreviewVersion (version string)

The string emitted into `package.json#version` by `changeset version
--snapshot preview`, then extended by `scripts/stamp-source-sha.mjs`.

**Format**: `0.0.0-preview-<timestamp>-<sha7>`

| Field | Type | Source | Example |
|-------|------|--------|---------|
| `0.0.0` | base version | `package.json` pre-snapshot | `0.0.0` |
| `preview` | dist-tag-aligned tag | `changeset version --snapshot preview` argument | `preview` |
| `<timestamp>` | 14-digit `YYYYMMDDHHMMSS` UTC | changesets snapshot timestamp | `20260604120000` |
| `<sha7>` | first 7 hex chars of source SHA | `git rev-parse HEAD` post-`origin/develop` checkout | `abc1234` |

**Validation**:
- `<sha7>` MUST match `/^[0-9a-f]{7}$/`.
- The full string MUST match `/^0\.0\.0-preview-\d{14}-[0-9a-f]{7}$/`.
- The stamper is idempotent: if `version` already ends with `-<sha7>`, the
  stamper does not append a second suffix.

### PackageMetadata (`package.json` fields)

Fields written into every non-private, non-ignored package's `package.json`
during publish.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | `string` | Yes | The `PreviewVersion` above. |
| `gitHead` | `string` | Yes | Full 40-char hex SHA of the source commit (`/^[0-9a-f]{40}$/`). Conventional npm field; read by the staleness check. |
| `generacy.sourceSha` | `string` | Yes | Duplicate of `gitHead` under a tooling-friendly namespace. Read by Generacy tooling that doesn't want to depend on npm's conventional field. |

**Idempotency rule**: The stamper overwrites `gitHead` and
`generacy.sourceSha` every run (they reflect the current build, not history).
`version`'s `-<sha7>` suffix is appended only if not already present.

**Visibility rules**:
- `version` and `gitHead` are visible via `npm view <pkg>@preview <field>` —
  this is the verification path for SC-002.
- `generacy.sourceSha` is visible via `npm view <pkg>@preview generacy.sourceSha`.

### WorkflowDispatchInputs

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `force_rollback` | `boolean` | `false` | When `true`, skip the staleness check and log a warning identifying the rollback as deliberate. Only honored on the `workflow_dispatch` trigger — the `push: develop` trigger ignores this input entirely (GitHub Actions provides no inputs to push events). |

**Validation**:
- `force_rollback` is a GitHub Actions `boolean` input. At evaluation time
  it appears in `github.event.inputs.force_rollback` as the **string**
  `"true"` or `"false"` (this is a GitHub quirk — the `type: boolean`
  declaration only constrains the UI dropdown). The workflow expression
  MUST compare to `'true'` (string), not `true` (literal).

### StalenessCheckState

Logical state inspected by `scripts/check-preview-staleness.mjs`.

| Field | Type | Source |
|-------|------|--------|
| `candidateSha` | `string` (40-hex) | `git rev-parse HEAD` after `origin/develop` checkout |
| `currentPreviewSha` | `string` (40-hex) \| `null` | `npm view @generacy-ai/generacy@preview gitHead` |
| `isAncestor` | `boolean` | `git merge-base --is-ancestor <candidate> <current>` exit code 0 |
| `forceRollback` | `boolean` | workflow input |

**State transitions / decision table**:

| `currentPreviewSha` | `candidateSha === currentPreviewSha` | `isAncestor` | `forceRollback` | Result |
|---------------------|------|-------|-------|--------|
| `null` | n/a | n/a | n/a | **PUBLISH** (D3, baseline fail-open) |
| not null | true | n/a | n/a | **PUBLISH** (republish of same SHA is allowed) |
| not null | false | false | n/a | **PUBLISH** (candidate is fresh) |
| not null | false | true | `false` | **REFUSE** (FR-006: exit 1 with descriptive message) |
| not null | false | true | `true` | **PUBLISH** (FR-007: log warning, skip check) |

## Relationships

```text
WorkflowRun
  ├── (input)  WorkflowDispatchInputs.force_rollback ─┐
  │                                                    │
  ├── (state)  StalenessCheckState                    ─┤
  │              ├── candidateSha   ◄── git rev-parse HEAD (origin/develop)
  │              └── currentPreviewSha ◄── npm view <anchor>@preview gitHead
  │                                                    │
  └── (output) PackageMetadata (per package)           │
                 ├── version          ── PreviewVersion (incl. <sha7>)
                 ├── gitHead          ── candidateSha (40-hex)
                 └── generacy.sourceSha ── candidateSha (40-hex)
```

## Out-of-Scope Data

- **npm provenance / attestation fields**: Q1=C (not D) — the workflow's
  existing `--provenance` flag stays, but we do not rely on provenance for
  the staleness check or for SC-002. Provenance is a complementary signal,
  not a primary one.
- **Other dist-tags** (`latest`, `alpha`): not in scope.
- **Backfill of `gitHead` into previously-published tarballs**: not in scope.
