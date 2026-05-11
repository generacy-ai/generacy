# Research: control-plane GET /roles endpoint

## Existing Patterns

### credentials.ts as reference implementation

The `handleGetCredential` handler in `packages/control-plane/src/routes/credentials.ts` is the authoritative pattern for disk-backed control-plane routes:

1. **Agency dir resolution** (line 24): `process.env['CREDHELPER_AGENCY_DIR'] ?? '.agency'`
2. **YAML reading**: Uses `yaml` package (`YAML.parse()`) for parsing
3. **ENOENT handling**: Catches file-not-found separately from other errors
4. **Error responses**: Returns `{ error, code }` objects with appropriate HTTP status codes
5. **No actor requirement for GET**: Only PUT handlers call `requireActor(actor)`

### Router pattern

`packages/control-plane/src/router.ts` uses a declarative route table with regex patterns and named parameter extraction. Routes are matched in array order. The dispatch function distinguishes 404 (no URL match) from 405 (URL match but wrong method).

Key: list routes (`/roles`) must come before detail routes (`/roles/:id`) in the array since regex `^\/roles\/([^/]+)$` does not match `/roles`, but ordering prevents confusion.

### Role YAML file format

Based on `.agency/roles/<id>.yaml` convention (referenced in `default-role-writer.ts` and `credential-writer.ts`), role files are expected to contain:

```yaml
description: "Human-readable role description"
credentials:
  - ref: github-pat
    type: github-pat
  - ref: aws-sts
    type: aws-sts
```

The `id` is derived from the filename (e.g., `reviewer.yaml` → `id: 'reviewer'`).

## Implementation Approach

### handleListRoles

```typescript
// 1. Resolve roles directory
// 2. readdir() with ENOENT catch → empty array
// 3. Filter to .yaml files
// 4. For each: try parse YAML, extract description
// 5. Return { roles: [{ id, description? }] }
```

**Why not return full credentials array in list?** The list endpoint is for the wizard dropdown — only `id` and `description` are needed. Full details available via `GET /roles/:id`.

### handleGetRole rewrite

```typescript
// 1. Resolve role file path
// 2. readFile() with ENOENT → 404
// 3. YAML.parse() with catch → 500
// 4. Return { id, description?, credentials? }
```

## Alternatives Considered

### Shared role-reader service

Could extract a `RoleReader` service class used by both handlers and `default-role-writer.ts`. **Rejected**: premature abstraction for two simple handlers. The credential routes don't have a shared reader either.

### Zod validation of YAML content

Could validate parsed YAML against a schema. **Rejected**: the spec explicitly calls for graceful degradation (malformed YAML → return `id` only). Strict validation would break this requirement.

### fs.watch for role directory changes

Could watch for file changes and cache. **Rejected**: roles are read infrequently (wizard load), and the directory may not exist at startup. Direct reads are simpler and sufficient.

## Key Sources

- `packages/control-plane/src/routes/credentials.ts` — reference pattern
- `packages/control-plane/src/router.ts` — route registration
- `packages/control-plane/src/errors.ts` — error types and `sendError` helper
- `packages/control-plane/src/services/default-role-writer.ts` — validates role file existence
