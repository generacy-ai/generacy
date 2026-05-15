# Data Model: Wizard-env-writer GH_USERNAME / GH_EMAIL

## Existing Types (unchanged)

### EnvEntry (wizard-env-writer.ts:21-24)

```typescript
interface EnvEntry {
  key: string;
  value: string;
}
```

### WriteWizardEnvFileOptions (wizard-env-writer.ts:7-12)

```typescript
interface WriteWizardEnvFileOptions {
  agencyDir: string;
  envFilePath?: string;  // default: /var/lib/generacy/wizard-credentials.env
}
```

### WriteWizardEnvFileResult (wizard-env-writer.ts:14-19)

```typescript
interface WriteWizardEnvFileResult {
  written: string[];
  failed: string[];
}
```

## Credential Payload (input)

The `github-app` credential value is a JSON string with this runtime shape:

```typescript
interface GitHubAppCredentialPayload {
  installationId: number;
  token: string;
  accountLogin?: string;   // <-- NEW field consumed by this feature
  expiresAt?: string;
}
```

No Zod schema change needed — the function uses runtime `typeof` guards on the parsed JSON, not schema validation.

## Type Assertion Change

**Before** (line 39):
```typescript
const parsed = JSON.parse(value) as { token?: unknown };
```

**After**:
```typescript
const parsed = JSON.parse(value) as { token?: unknown; accountLogin?: unknown };
```

## Env Var Mapping

| Credential Type | Payload Field | Env Var | Format |
|----------------|---------------|---------|--------|
| `github-app` | `token` | `GH_TOKEN` | Raw token string |
| `github-app` | `accountLogin` | `GH_USERNAME` | Raw login string |
| `github-app` | `accountLogin` | `GH_EMAIL` | `<login>@users.noreply.github.com` |

## Output Examples

### With accountLogin present

Input: `'{"installationId":1,"token":"ghs_abc","accountLogin":"alice"}'`

Output:
```
GH_TOKEN=ghs_abc
GH_USERNAME=alice
GH_EMAIL=alice@users.noreply.github.com
```

### Without accountLogin (backwards-compatible)

Input: `'{"installationId":1,"token":"ghs_abc"}'`

Output:
```
GH_TOKEN=ghs_abc
```

### With empty accountLogin

Input: `'{"installationId":1,"token":"ghs_abc","accountLogin":""}'`

Output:
```
GH_TOKEN=ghs_abc
```
