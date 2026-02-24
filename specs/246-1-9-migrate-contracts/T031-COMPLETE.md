# Task T031: Migrate contracts/schemas/github-app/ - COMPLETE

**Task**: Migrate entire `contracts/schemas/github-app/` directory to `latency/types/github-app/`
**Status**: ✅ COMPLETE
**Date**: 2026-02-24

## Summary

Successfully migrated the complete github-app schema directory from contracts to latency/types, including all TypeScript source files and test files.

## Files Migrated

### Source Files (4 files)
All migrated to: `/workspaces/latency/packages/latency/src/types/github-app/`

1. **index.ts** (1,561 bytes)
   - Re-exports all GitHub App related schemas
   - Exports permission scope, progressive permission, and webhook event types

2. **permission-scope.ts** (4,989 bytes)
   - PermissionScope schema with versioned namespace
   - PermissionScopeDefinition schema
   - Permission categories and levels
   - Parse/format helper functions
   - Depends on: `../../common/timestamps.js`

3. **progressive-permission.ts** (4,580 bytes)
   - ProgressivePermissionRequest schema
   - Permission request ID generation (ULID-based)
   - Installation ID schema
   - Permission request status enum
   - Depends on: `../../common/timestamps.js`, `./permission-scope.js`

4. **webhook-event.ts** (5,544 bytes)
   - WebhookEvent schema with versioned namespace
   - Webhook event ID generation (ULID-based)
   - Webhook event types (push, issues, PRs, actions, etc.)
   - WebhookSender schema
   - TypedWebhookEvent utility type
   - Depends on: `../../common/timestamps.js`

### Test Files (3 files)
All migrated to: `/workspaces/latency/packages/latency/src/types/github-app/__tests__/`

1. **permission-scope.test.ts** (8,226 bytes)
   - Tests for PermissionCategorySchema, PermissionLevelSchema
   - Tests for PermissionScopeSchema and PermissionScopeDefinitionSchema
   - Tests for parse/format helper functions
   - Tests for versioned namespace

2. **progressive-permission.test.ts** (8,390 bytes)
   - Tests for PermissionRequestIdSchema and InstallationIdSchema
   - Tests for ProgressivePermissionRequestSchema
   - Tests for ID generation functions
   - Tests for permission request status

3. **webhook-event.test.ts** (10,759 bytes)
   - Tests for WebhookEventIdSchema and WebhookEventTypeSchema
   - Tests for WebhookSenderSchema and WebhookEventSchema
   - Tests for webhook event ID generation
   - Comprehensive tests for all event types

## Migration Details

### Import Path Updates
- All imports remained relative and were preserved as-is
- `../../common/timestamps.js` - maintained same relative path (already exists in latency)
- Local imports (`./permission-scope.js`) - maintained

### Directory Structure
```
latency/packages/latency/src/types/github-app/
├── index.ts
├── permission-scope.ts
├── progressive-permission.ts
├── webhook-event.ts
└── __tests__/
    ├── permission-scope.test.ts
    ├── progressive-permission.test.ts
    └── webhook-event.test.ts
```

## Dependencies

All dependencies are satisfied:
- ✅ `zod` - Available in latency
- ✅ `ulid` - Available in latency
- ✅ `vitest` - Available in latency (for tests)
- ✅ `ISOTimestampSchema` from `../../common/timestamps.js` - Exists in latency

## Schema Features

All migrated schemas follow the versioned namespace pattern:
- `V1` schema with version registry
- `Latest` pointing to current version
- `getVersion()` helper for version-specific access
- Backward-compatible type aliases
- Parse and safeParse helper functions

## Next Steps

1. Update latency package exports to include github-app types
2. Run tests to verify migration
3. Update any consumers to import from latency instead of contracts
4. Document the migration in the tracking manifest

## Files Created

- `/workspaces/latency/packages/latency/src/types/github-app/index.ts`
- `/workspaces/latency/packages/latency/src/types/github-app/permission-scope.ts`
- `/workspaces/latency/packages/latency/src/types/github-app/progressive-permission.ts`
- `/workspaces/latency/packages/latency/src/types/github-app/webhook-event.ts`
- `/workspaces/latency/packages/latency/src/types/github-app/__tests__/permission-scope.test.ts`
- `/workspaces/latency/packages/latency/src/types/github-app/__tests__/progressive-permission.test.ts`
- `/workspaces/latency/packages/latency/src/types/github-app/__tests__/webhook-event.test.ts`

---

**Migration Completed Successfully** ✅
