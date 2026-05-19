# Data Model: #614 Stale Credential Surface After Cluster Re-Add

## Core Entities

### Credential Value (existing, unchanged)

The cloud sends credential values via `PUT /credentials/:id`:

```typescript
// PutCredentialBodySchema (existing in credentials.ts)
{
  type: string;   // "github-app" | "github-pat" | "api-key" | ...
  value: string;  // Raw or JSON-encoded secret
}
```

### GitHub App Credential Value (existing wire format)

When `type === "github-app"`, the `value` field is a JSON string:

```typescript
interface GitHubAppCredentialValue {
  installationId: number;
  token: string;       // Installation access token — this is the GH_TOKEN
  expiresAt?: string;  // ISO 8601
}
```

### GitHub PAT Credential Value (existing wire format)

When `type === "github-pat"`, the `value` field is the raw PAT string.

### Wizard Credentials Env File (existing, line format)

`/var/lib/generacy/wizard-credentials.env` — sourced by `entrypoint-post-activation.sh`:

```
GH_TOKEN=ghs_xxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx
```

Written by `writeWizardEnvFile()`. Atomic write (temp + fsync + rename), mode 0600.

### gh hosts.yml (existing, managed by `gh` CLI)

`~/.config/gh/hosts.yml` — read by `gh` on every invocation:

```yaml
github.com:
  oauth_token: ghs_xxxxxxxxxxxx
  user: ""
  git_protocol: https
```

Written by `gh auth login --with-token`. Lives in ephemeral container filesystem (not volume-mounted), recreated from env file on every container restart.

## New Types

### RefreshGhAuthResult

```typescript
interface RefreshGhAuthResult {
  ok: boolean;
  error?: string;
}
```

Returned by `refreshGhAuth()`. Caller treats `ok: false` as non-fatal.

## Data Flow

### Credential Lifecycle (after fix)

```
Cloud PUT /credentials/github-main-org
  └─ { type: "github-app", value: '{"installationId":123,"token":"ghs_xxx"}' }

Control-Plane handlePutCredential
  ├─ writeCredential()
  │   ├─ ClusterLocalBackend.setSecret("github-main-org", value)  → credentials.dat (encrypted)
  │   ├─ writeCredentialMetadata("github-main-org", "github-app") → credentials.yaml
  │   └─ relay event: cluster.credentials { status: "written" }
  │
  ├─ [NEW] writeWizardEnvFile({ agencyDir, envFilePath })
  │   ├─ reads credentials.yaml → enumerates all credential IDs
  │   ├─ fetches each secret from ClusterLocalBackend
  │   ├─ maps github-app → GH_TOKEN=<token>, anthropic → ANTHROPIC_API_KEY=<key>
  │   └─ atomic write → /var/lib/generacy/wizard-credentials.env
  │
  └─ [NEW] refreshGhAuth(extractedToken)
      └─ echo <token> | gh auth login --with-token → ~/.config/gh/hosts.yml
```

### Volume Cleanup (Fix B)

```
CLI: npx generacy launch --claim=<code>
  ├─ fetchLaunchConfig(cloudUrl, claimCode)
  ├─ scaffoldProject(projectDir, config)
  ├─ [NEW] clearStaleActivation(composeName)
  │   └─ docker run --rm -v <name>_generacy-data:/v alpine rm -f
  │       /v/cluster-api-key
  │       /v/cluster.json
  │       /v/wizard-credentials.env
  ├─ pullImage(projectDir)
  └─ startCluster(projectDir)
```

## Validation Rules

- `refreshGhAuth` must receive a non-empty string token. Empty/null tokens are skipped.
- Token is passed via stdin to `gh auth login --with-token` (never via argv).
- `writeWizardEnvFile` re-enumerates all credentials from `credentials.yaml` — not just the one being PUT. This ensures the env file is always a complete snapshot.
- Volume cleanup only runs when `--claim` is explicitly provided. Normal `generacy launch` without `--claim` (if it were to exist) would NOT clear the volume.
