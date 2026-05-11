# Data Model: control-plane GET /roles endpoint

## Source Data

### Role YAML file (`.agency/roles/<id>.yaml`)

```yaml
description: "Role description"
credentials:
  - ref: github-pat
    type: github-pat
  - ref: aws-sts
    type: aws-sts
```

- **Location**: `<agencyDir>/roles/<id>.yaml`
- **Agency dir**: `process.env['CREDHELPER_AGENCY_DIR'] ?? '.agency'`
- **ID derivation**: filename without `.yaml` extension (e.g., `reviewer.yaml` → `reviewer`)

## Response Types

### GET /roles — List response

```typescript
interface ListRolesResponse {
  roles: RoleSummary[];
}

interface RoleSummary {
  id: string;
  description?: string;
}
```

**HTTP 200** — Always, even when directory is empty or missing.

Example responses:
```json
// Empty (no roles directory or no .yaml files)
{ "roles": [] }

// With roles
{ "roles": [
  { "id": "reviewer", "description": "Code review role" },
  { "id": "deployer" }
] }
```

### GET /roles/:id — Detail response

```typescript
interface RoleDetailResponse {
  id: string;
  description?: string;
  credentials?: RoleCredentialRef[];
}

interface RoleCredentialRef {
  ref: string;
  type: string;
  [key: string]: unknown;  // additional YAML fields passed through
}
```

**HTTP 200** — When role file exists.
**HTTP 404** — When role file does not exist.
**HTTP 500** — When YAML parsing fails.

Example success:
```json
{
  "id": "reviewer",
  "description": "Code review role",
  "credentials": [
    { "ref": "github-pat", "type": "github-pat" }
  ]
}
```

Example 404:
```json
{
  "error": "Role 'nonexistent' not found",
  "code": "NOT_FOUND"
}
```

Example 500:
```json
{
  "error": "Failed to parse role file",
  "code": "INTERNAL_ERROR"
}
```

## Validation Rules

| Field | Rule | On Failure |
|-------|------|------------|
| Role ID (from URL param) | Non-empty string | Router rejects (no match) |
| Agency dir | Env var or `.agency` default | N/A (always resolves) |
| Roles directory | May not exist | Return `{ roles: [] }` |
| Individual YAML file (list) | May fail to parse | Include role with `id` only |
| Individual YAML file (detail) | Must parse | Return 500 |
| `description` field | Optional string | Omitted from response |
| `credentials` field | Optional array | Omitted from response |

## Relationships

```
.agency/
├── roles/
│   ├── reviewer.yaml      ──→ GET /roles → { id: 'reviewer', description: '...' }
│   │                       ──→ GET /roles/reviewer → { id, description, credentials }
│   └── deployer.yaml       ──→ GET /roles → { id: 'deployer', description: '...' }
├── credentials.yaml        ──→ (existing credential routes, not modified)
└── config.yaml             ──→ (default-role-writer, not modified)
```
