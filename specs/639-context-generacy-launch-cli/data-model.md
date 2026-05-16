# Data Model: Scoped Private-Registry Credentials

## Schema Changes

### `RegistryCredentials` (new type)

```typescript
export const RegistryCredentialsSchema = z.object({
  url: z.string().min(1),       // Registry hostname, e.g. "ghcr.io"
  username: z.string().min(1),  // Registry username
  password: z.string().min(1),  // Registry password or token
});

export type RegistryCredentials = z.infer<typeof RegistryCredentialsSchema>;
```

### `LaunchConfigSchema` (extended)

```typescript
export const LaunchConfigSchema = z.object({
  // ... existing fields unchanged ...
  projectId: z.string().min(1),
  projectName: z.string().min(1),
  variant: z.string().min(1),
  channel: z.enum(['stable', 'preview']).optional(),
  cloudUrl: z.string().url(),
  clusterId: z.string().min(1),
  imageTag: z.string().min(1),
  orgId: z.string().min(1),
  repos: z.object({
    primary: z.string().min(1),
    dev: z.array(z.string()).optional(),
    clone: z.array(z.string()).optional(),
  }),
  cloud: CloudUrlsSchema.optional(),
  // NEW
  registryCredentials: RegistryCredentialsSchema.optional(),
});
```

## Function Signatures

### `pullImage` (modified)

```typescript
export function pullImage(
  projectDir: string,
  registryCredentials?: RegistryCredentials,
): void;
```

## Docker Config File Format

Written to `<projectDir>/.docker/config.json`:

```json
{
  "auths": {
    "<registryCredentials.url>": {
      "auth": "<base64(username:password)>"
    }
  }
}
```

## Validation Rules

| Field | Rule | Error |
|-------|------|-------|
| `url` | Non-empty string | Zod `.min(1)` |
| `username` | Non-empty string | Zod `.min(1)` |
| `password` | Non-empty string | Zod `.min(1)` |
| Entire object | Optional on LaunchConfig | Absent = no-creds path |

## Relationships

```
LaunchConfig
  └── registryCredentials? : RegistryCredentials
        ├── url      → Docker config "auths" key
        ├── username → base64 auth (left of colon)
        └── password → base64 auth (right of colon)
```
