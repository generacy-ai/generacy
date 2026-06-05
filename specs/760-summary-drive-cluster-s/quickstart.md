# Quickstart: Verify cluster GitHub identity from acting account

**Feature**: 760 — `gitIdentityLogin` consumer half

This document covers (a) running the unit suite locally and (b) end-to-end verification on a real cluster.

## Prerequisites

- Node >=22, pnpm installed.
- `packages/control-plane` and `packages/orchestrator` dependencies installed (`pnpm install` from repo root).
- For end-to-end verification: an org-owned GitHub repo, an org-level GitHub App installation, and the generacy-cloud producer (#812) deployed.

## Unit-test verification (local)

The bulk of the change is provable by the existing test suite at `packages/control-plane/__tests__/services/wizard-env-writer.test.ts`, extended to cover the new field.

```bash
# From repo root
pnpm --filter @generacy-ai/control-plane test wizard-env-writer
```

Expected coverage (added or extended by this PR):

| Case | Credential JSON (excerpt) | Expected `GH_USERNAME` | Expected `GH_EMAIL` |
|------|---------------------------|------------------------|---------------------|
| `gitIdentityLogin` present, non-empty | `{"token":"...","accountLogin":"Painworth","gitIdentityLogin":"pw-dev-bot"}` | `pw-dev-bot` | `pw-dev-bot@users.noreply.github.com` |
| `gitIdentityLogin` whitespace-only | `{"token":"...","accountLogin":"Painworth","gitIdentityLogin":"   "}` | `Painworth` | `Painworth@users.noreply.github.com` |
| `gitIdentityLogin` empty string | `{"token":"...","accountLogin":"Painworth","gitIdentityLogin":""}` | `Painworth` | `Painworth@users.noreply.github.com` |
| `gitIdentityLogin` not a string | `{"token":"...","accountLogin":"Painworth","gitIdentityLogin":null}` | `Painworth` | `Painworth@users.noreply.github.com` |
| `gitIdentityLogin` absent (legacy) | `{"token":"...","accountLogin":"alice"}` | `alice` | `alice@users.noreply.github.com` |
| `gitIdentityLogin` with leading/trailing whitespace | `{"token":"...","accountLogin":"Painworth","gitIdentityLogin":"  pw-dev-bot  "}` | `pw-dev-bot` | `pw-dev-bot@users.noreply.github.com` |
| Both identity fields missing | `{"token":"..."}` | (not emitted) | (not emitted) — `GH_TOKEN` only |

Additionally, spot-check `packages/orchestrator/src/services/__tests__/identity.test.ts` still passes — no behavior change is asserted here, but the comment-only change must not regress the existing precedence test (SC-003).

```bash
pnpm --filter @generacy-ai/orchestrator test identity
```

## End-to-end verification (org cluster)

Run on a freshly-activated org cluster after both this PR and generacy-cloud#812 have shipped.

1. **Pre-activation**: In the cloud wizard, complete the "Act as" picker step with a user-account login (e.g. `pw-dev-bot`). Complete activation.
2. **Verify env file**:
   ```bash
   docker compose exec orchestrator cat /var/lib/generacy/wizard-credentials.env 2>/dev/null || \
     docker compose exec control-plane cat /var/lib/generacy/wizard-credentials.env
   ```
   Expected lines:
   ```
   GH_TOKEN=<token>
   GH_USERNAME=pw-dev-bot
   GH_EMAIL=pw-dev-bot@users.noreply.github.com
   ```
   **NOT** `GH_USERNAME=<your-org-name>`. (SC-001)
3. **Verify orchestrator process env**:
   ```bash
   docker compose exec orchestrator env | grep -E '^(GH_USERNAME|GH_EMAIL|CLUSTER_GITHUB_USERNAME)='
   ```
   Expected: `GH_USERNAME=pw-dev-bot`, `GH_EMAIL=pw-dev-bot@users.noreply.github.com`, `CLUSTER_GITHUB_USERNAME` **not set**.
4. **Verify label-monitor identity** (orchestrator logs at startup):
   ```
   Cluster identity resolved: pw-dev-bot (from GH_USERNAME)
   ```
   **NOT** `Cluster identity resolved: <org-name> (from GH_USERNAME)`.
5. **Verify assignee matching**: Assign an open issue in the org repo to `pw-dev-bot` and apply a workflow label. The orchestrator should pick it up; previously (org-as-identity), the issue would be silently dropped at debug level.
6. **Verify commit attribution**: After the orchestrator commits to a PR, the GitHub commit page shows author `pw-dev-bot`, not the org.

## Legacy-cluster verification

Run on a cluster activated **before** generacy-cloud#812 (credential lacks `gitIdentityLogin`). The behavior must be identical to today.

1. Trigger a credential refresh (or wait for the next refresh cycle).
2. Inspect `wizard-credentials.env`:
   ```
   GH_TOKEN=<token>
   GH_USERNAME=<accountLogin>
   GH_EMAIL=<accountLogin>@users.noreply.github.com
   ```
3. Confirm no startup warnings about missing `gitIdentityLogin`. (None should appear — fallback is silent by design, per Q1/A.)

## Manual escape-hatch verification (SC-003)

Confirm that setting `CLUSTER_GITHUB_USERNAME` still wins.

```bash
# In .generacy/.env or docker-compose env
CLUSTER_GITHUB_USERNAME=override-user
```

Restart the orchestrator. Expected log line:

```
Cluster identity resolved: override-user (from CLUSTER_GITHUB_USERNAME)
```

This must hold even when `GH_USERNAME` came from `gitIdentityLogin`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Org cluster still shows `GH_USERNAME=<org-name>` after this PR | Producer hasn't shipped — credential lacks `gitIdentityLogin`. | Re-seal the credential after generacy-cloud#812 deploys; or, until #812 ships, set `CLUSTER_GITHUB_USERNAME` as a manual workaround. |
| `GH_USERNAME` is the org name even though the producer is deployed | The credential was sealed before #812 and hasn't refreshed yet, OR the operator selected the org in the picker. | Trigger a credential refresh; check `gitIdentityLogin` raw value via `PUT /credentials/:id` echo or relay event. |
| `GH_USERNAME=<whitespace>` ever appears | Bug — the trim guard isn't working. | Re-read `mapCredentialToEnvEntries`; the value must be `.trim()`-ed before the length check. |
| Label monitor still drops all issues silently | Either `CLUSTER_GITHUB_USERNAME` is set to the wrong value (escape hatch beats `GH_USERNAME`), or the assignees on the issues genuinely don't match the resolved identity. | Check `docker compose exec orchestrator env`; check issue assignees on GitHub. |
| Tests pass locally but the deployed cluster shows wrong behavior | Container image is from a build before this PR merged. | Force-pull cluster image: `pnpm exec generacy update` in the cluster directory. |
