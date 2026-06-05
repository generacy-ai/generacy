# Data Model: Drive cluster GitHub identity from acting account

**Feature**: 760 — `gitIdentityLogin` consumer half
**Date**: 2026-06-05

## Entities

### `GitHubAppCredentialValue` (parsed from `value: string`)

The JSON shape the producer (generacy-cloud#812) seals into the credential value, and the consumer (`wizard-env-writer.ts`) parses. Stored encrypted by `ClusterLocalBackend`.

| Field | Type | Required | Source | Used by consumer? |
|-------|------|----------|--------|--------------------|
| `installationId` | `number` | yes | Producer (GitHub App installation) | No |
| `token` | `string` | yes | Producer (refreshed GitHub App installation token) | Yes → `GH_TOKEN` |
| `expiresAt` | `string` (ISO 8601) | yes | Producer (token expiry) | No (cloud handles refresh) |
| `accountLogin` | `string` | yes | Producer (`installation.account.login` from GitHub API — org name for org installs, user login for user installs) | Yes → fallback for `GH_USERNAME` / `GH_EMAIL` |
| `gitIdentityLogin` | `string \| undefined` | **NEW, optional** | Producer "Act as" picker (#812). Absent on pre-#812 credentials. | **Yes → preferred source for `GH_USERNAME` / `GH_EMAIL` (this PR)** |

**Validation rules (consumer-side)**:
- `value` MUST be a parseable JSON string. Unparseable → skip entire github-app entry (existing behavior, unchanged).
- `parsed.token` MUST be a non-empty string. Otherwise → skip entire github-app entry (existing behavior, unchanged).
- `parsed.gitIdentityLogin`: if a `string`, trim and use if the trimmed value is non-empty. Otherwise → fall through to `accountLogin`.
- `parsed.accountLogin`: if a `string`, trim and use if the trimmed value is non-empty. Otherwise → emit no identity-derived entries (`GH_TOKEN` still emitted alone — existing behavior, unchanged).

**Source-of-truth note**: `gitIdentityLogin` is the operator-selected acting account from the cloud activation wizard's "Act as" picker. `accountLogin` continues to be needed by the producer (for non-identity uses) and is emitted by every credential-refresh cycle. So the fallback branch stays live indefinitely; it is not a legacy-only path.

### `EnvEntry` (consumer-side, internal)

The tuple `mapCredentialToEnvEntries` produces and `writeWizardEnvFile` flushes to `/var/lib/generacy/wizard-credentials.env`. Unchanged by this PR.

```ts
interface EnvEntry {
  key: string;
  value: string;
}
```

Emitted entries for `github-app` type (post-PR):

| Condition | Entries emitted |
|-----------|-----------------|
| `token` present, `gitIdentityLogin` resolves (trimmed non-empty string) | `GH_TOKEN`, `GH_USERNAME=<gitIdentityLogin>`, `GH_EMAIL=<gitIdentityLogin>@users.noreply.github.com` |
| `token` present, `gitIdentityLogin` missing/empty/whitespace/non-string, `accountLogin` resolves | `GH_TOKEN`, `GH_USERNAME=<accountLogin>`, `GH_EMAIL=<accountLogin>@users.noreply.github.com` |
| `token` present, neither identity field resolves | `GH_TOKEN` only |
| `token` missing or value unparseable | `[]` (nothing emitted) |

### `ClusterIdentity` (consumer-side, `identity.ts`)

Resolution order — **unchanged by this PR**:

1. `configUsername` (from `CLUSTER_GITHUB_USERNAME` env var) — top-priority escape hatch.
2. `process.env.GH_USERNAME` — wizard-delivered identity (now sourced from `gitIdentityLogin` or `accountLogin` depending on credential vintage).
3. `gh api /user` fallback — auto-detection from ambient `gh auth` state. Returns `undefined` on auth failure (`(bot)` tokens can't call `/user`).
4. `undefined` → assignee filtering disabled, all issues processed.

The PR updates only the doc-comment for step 2 (calling out that `GH_USERNAME` is the operator-selected acting account, not "the human account the installation belongs to"). No code path changes.

## Relationships

```
generacy-cloud (#812 producer)
    └── seals github-app credential JSON
            ├── token, accountLogin, expiresAt, installationId  (existing)
            └── gitIdentityLogin                                  (NEW)
                    │
                    │ PUT /credentials/:id (control-plane)
                    ▼
            ClusterLocalBackend (encrypted at rest)
                    │
                    │ fetchSecret(id) (on bootstrap-complete)
                    ▼
            wizard-env-writer.ts: mapCredentialToEnvEntries
                    │
                    │ writes /var/lib/generacy/wizard-credentials.env
                    ▼
            entrypoint-post-activation.sh
                    │
                    │ set -a; source wizard-credentials.env; set +a
                    ▼
            ┌────────────────────────────────┬──────────────────────────────────┐
            │ setup-credentials.sh           │ orchestrator (Node process env)  │
            │   git config user.name = $GH_USERNAME
            │   git config user.email = $GH_EMAIL
            └────────────────────────────────┴──────────────────────────────────┘
                                                       │
                                                       ▼
                                       identity.ts: resolveClusterIdentity
                                       (reads process.env.GH_USERNAME)
                                                       │
                                                       ▼
                                       label-monitor assignee filter
                                       (filterByAssignee — exact-string match)
```

## Edge Cases / Invariants

- **Pre-#812 credentials**: `gitIdentityLogin` absent → identical behavior to today. SC-002.
- **Whitespace-only `gitIdentityLogin`**: Treated as missing. Falls back to `accountLogin`. Mirrors existing `accountLogin` trim-length handling. (Q3/A.)
- **Empty-string `gitIdentityLogin`**: Same as whitespace-only — fall back. (Q3/A.)
- **Non-string `gitIdentityLogin`** (e.g. cloud bug seals `null` or `number`): `typeof === 'string'` guard → fall back. Defensive.
- **`accountLogin` also missing/empty**: `GH_TOKEN` emitted alone (no identity vars). Consumer downstream (`identity.ts`) falls through to `gh api /user` → likely fails on bot tokens → assignee filtering disabled. Unchanged behavior.
- **Operator has set `CLUSTER_GITHUB_USERNAME`**: Wins regardless of credential contents. SC-003. (Q4/A.)
- **Producer-side `gitIdentityLogin` matches an org login (operator misconfigured the picker)**: Out of scope — Q1/A defers the warning. The cluster-side backstop in #762 will surface this.
