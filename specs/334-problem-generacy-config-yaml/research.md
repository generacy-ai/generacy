# Research: Template Config Format Support

## Technology Decisions

### 1. Lightweight schema vs reusing `GeneracyConfigSchema`

**Decision**: Create a new lightweight `TemplateConfigSchema` in `@generacy-ai/config`.

**Rationale**: The `GeneracyConfigSchema` lives in `@generacy-ai/generacy` and includes strict validation (e.g., `proj_` prefix on IDs, `github.com/` prefix on URLs). Using it would:
- Create a circular dependency (`config` → `generacy` → `config`)
- Over-validate fields not needed for workspace conversion (e.g., `project.id` format)
- Couple the low-level config package to the full application schema

The template schema only needs to validate enough to safely convert to `WorkspaceConfig`.

### 2. Detection strategy: key-based vs schema-based

**Decision**: Key-based detection (`repos` key with `primary` sub-key).

**Alternatives considered**:
- **`schemaVersion` key**: Not present in cluster-template output, unreliable
- **`project` key**: Too generic, could match unrelated configs
- **Full schema parse attempt**: Expensive for detection, harder to report errors

The `repos.primary` key is unique to the template format and doesn't appear in the workspace format (which uses `workspace.repos[]`).

### 3. Repo format parsing

**Decision**: Reuse existing `parseRepoInput()` from the same package.

**Rationale**: `parseRepoInput()` already handles all formats:
- `"owner/repo"` → `{ owner, repo }`
- `"github.com/owner/repo"` → `{ owner, repo }`
- `"https://github.com/owner/repo.git"` → `{ owner, repo }`
- `"bare-name"` → `{ owner: defaultOrg, repo: "bare-name" }`

This avoids duplicating regex logic and handles edge cases consistently.

### 4. `org` derivation from `repos.primary`

**Decision**: Extract `owner` from the parsed primary repo URL.

**Alternatives considered**:
- Use `project.org_name`: Not always present, may differ from repo owner
- Require explicit `org` field: Would change the template format

The primary repo's owner is the most reliable org indicator and matches how the workspace format uses `org`.

## Implementation Patterns

### Fallback chain pattern

The loader already uses a null-return pattern for "not my format". The template fallback follows the same pattern:

```
1. File exists? → no → return null
2. Valid YAML object? → no → return null
3. Has `workspace` key? → yes → parse as workspace format (existing)
4. Has `repos.primary`? → yes → parse as template format (NEW)
5. Neither? → return null
```

This preserves the existing contract and is transparent to callers.

### Zod `.passthrough()` for forward compatibility

Using `.passthrough()` on the project schema allows the template format to evolve (e.g., adding new fields) without breaking the converter. We only validate what we need.

## Key Sources

- Existing `GeneracyConfigSchema`: `packages/generacy/src/config/schema.ts`
- Existing workspace loader: `packages/config/src/loader.ts`
- Config examples: `packages/generacy/examples/config-*.yaml`
- Cluster template output format: spec.md template config example
- `parseRepoInput()`: `packages/config/src/parse-repo-input.ts`
