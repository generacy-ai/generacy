# Data Model: Wizard Credentials Env Bridge

## Core Interfaces

### WriteWizardEnvFileOptions

```typescript
interface WriteWizardEnvFileOptions {
  /** Path to .agency directory containing credentials.yaml */
  agencyDir: string;
  /** Output path for the env file (default: /var/lib/generacy/wizard-credentials.env) */
  envFilePath?: string;
}
```

### WriteWizardEnvFileResult

```typescript
interface WriteWizardEnvFileResult {
  /** Credential IDs successfully written to env file */
  written: string[];
  /** Credential IDs that failed to unseal */
  failed: string[];
}
```

### EnvEntry

```typescript
interface EnvEntry {
  /** Environment variable name (e.g., GH_TOKEN) */
  key: string;
  /** Plaintext credential value */
  value: string;
}
```

## Existing Types (Read-Only)

### credentials.yaml Structure

```yaml
# Written by credential-writer.ts during wizard PUT /credentials/:id
credentials:
  github-main-org:
    type: github-app
    backend: cluster-local
    status: active
    updatedAt: "2026-05-12T10:00:00.000Z"
  anthropic-api-key:
    type: api-key
    backend: cluster-local
    status: active
    updatedAt: "2026-05-12T10:01:00.000Z"
```

TypeScript representation (parsed from YAML):

```typescript
interface CredentialsYaml {
  credentials: Record<string, CredentialMetadataEntry>;
}

interface CredentialMetadataEntry {
  type: string;
  backend: string;
  status: 'active' | 'pending' | 'error';
  updatedAt: string;
}
```

### ClusterLocalBackend (from @generacy-ai/credhelper)

```typescript
// Used via getCredentialBackend() singleton
interface WritableBackendClient {
  fetchSecret(key: string): Promise<string>;  // Returns plaintext value
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
}
```

## Output Artifact

### wizard-credentials.env

```bash
# /var/lib/generacy/wizard-credentials.env (mode 0600)
GH_TOKEN=ghs_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Format rules:
- One `KEY=value` per line
- No quoting (token values are alphanumeric + hyphens)
- No comments in output
- No trailing newline after last entry
- Empty file if no credentials found (not an error)

## Env Var Mapping

```typescript
const WELL_KNOWN_MAPPINGS: Record<string, Record<string, string>> = {
  // By type
  'github-app': { envVar: 'GH_TOKEN' },
  'github-pat': { envVar: 'GH_TOKEN' },
};

const ID_PATTERN_MAPPINGS: Array<{ pattern: RegExp; envVar: string }> = [
  { pattern: /anthropic/, envVar: 'ANTHROPIC_API_KEY' },
];

// Fallback: idToEnvName('my-credential') → 'MY_CREDENTIAL'
function idToEnvName(id: string): string {
  return id.toUpperCase().replace(/-/g, '_');
}
```

## Relay Event (Warning)

Emitted on `cluster.bootstrap` channel when one or more credentials fail to unseal:

```typescript
{
  warning: 'credential-unseal-partial',
  failed: ['credential-id-1'],  // IDs that failed
  written: ['github-main-org', 'anthropic-api-key'],  // IDs that succeeded
}
```
