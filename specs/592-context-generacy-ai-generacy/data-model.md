# Data Model: wizard-env-writer github-app token extraction

**Feature**: #592 | **Date**: 2026-05-12

## Existing Types (unchanged)

### EnvEntry
```typescript
// packages/control-plane/src/services/wizard-env-writer.ts
interface EnvEntry {
  key: string;   // Environment variable name (e.g., 'GH_TOKEN')
  value: string; // Environment variable value (e.g., 'ghs_abc123')
}
```

### WriteWizardEnvFileOptions
```typescript
export interface WriteWizardEnvFileOptions {
  agencyDir: string;
  envFilePath?: string; // default: /var/lib/generacy/wizard-credentials.env
}
```

### WriteWizardEnvFileResult
```typescript
export interface WriteWizardEnvFileResult {
  written: string[];  // credential IDs successfully written
  failed: string[];   // credential IDs that failed to unseal
}
```

## Implicit Types (cloud payload shapes)

### GitHubAppCredentialValue (new cloud format)
```typescript
// Not formally defined — JSON.parse'd inline with defensive checks
// Payload from generacy-cloud#547 PUT /control-plane/credentials/:id
{
  installationId: number;
  accountLogin: string;
  repositorySelection: string;
  token: string;        // ghs_* installation access token
  expiresAt: string;    // ISO timestamp
}
```

The `token` field is the only field extracted. All other fields are ignored by the env-writer.

### GitHubPatCredentialValue
```typescript
// Raw string — no JSON parsing
// Value is directly a GitHub PAT (ghp_*)
string
```

## Function Signature (unchanged)

```typescript
export function mapCredentialToEnvEntries(
  id: string,
  type: string,
  value: string,
): EnvEntry[]
```

## Behavioral Changes

| Type | Input | Output (before) | Output (after) |
|------|-------|-----------------|----------------|
| `github-app` | `'{"token":"ghs_abc",...}'` | `[{key:'GH_TOKEN', value:'{"token":"ghs_abc",...}'}]` | `[{key:'GH_TOKEN', value:'ghs_abc'}]` |
| `github-app` | `'{"installationId":1}'` (no token) | `[{key:'GH_TOKEN', value:'{"installationId":1}'}]` | `[]` |
| `github-app` | `'not-json'` | `[{key:'GH_TOKEN', value:'not-json'}]` | `[]` |
| `github-pat` | `'ghp_xyz'` | `[{key:'GH_TOKEN', value:'ghp_xyz'}]` | `[{key:'GH_TOKEN', value:'ghp_xyz'}]` (unchanged) |
