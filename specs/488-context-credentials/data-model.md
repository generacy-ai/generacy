# Data Model: Remove cloud-side credential storage and OIDC code

**Feature**: #488 | **Date**: 2026-04-28

This is a pure deletion feature. The data model documents what is being removed and what modifications are needed to existing types.

## Types Being Deleted

### `SessionTokenClaims` (from `jwt-parser.ts`)

```typescript
interface SessionTokenClaims {
  sub: string;       // User ID
  org_id: string;    // Organization ID
  scope: string;     // Must be "credhelper"
  iat: number;       // Issued at
  exp: number;       // Expires at
}
```

### `SessionTokenProvider` (from `session-token-store.ts`)

```typescript
interface SessionTokenProvider {
  getToken(): { value: string; claims: SessionTokenClaims } | null;
}
```

### `SessionTokenStatus` (from `session-token-store.ts`)

```typescript
interface SessionTokenStatus {
  authenticated: boolean;
  user?: string;
  org?: string;
  expiresAt?: number;
}
```

## Types Being Modified

### `DaemonConfig` (in `src/types.ts`)

**Remove these fields:**
```typescript
// DELETE these from DaemonConfig:
sessionTokenStore: SessionTokenStore;
generacyCloudApiUrl?: string;
```

### `DefaultBackendClientFactory` constructor (in `src/backends/factory.ts`)

**Remove `sessionTokenStore` parameter:**
```typescript
// BEFORE:
constructor(sessionTokenStore?: SessionTokenStore)

// AFTER:
constructor()  // or remove constructor entirely if no other params
```

### `ControlServer` constructor (in `src/control-server.ts`)

**Remove `sessionTokenStore` parameter:**
```typescript
// BEFORE:
constructor(sessionManager: SessionManager, sessionTokenStore?: SessionTokenStore)

// AFTER:
constructor(sessionManager: SessionManager)
```

## Backend Factory Error Message

**Before:**
```
Unknown backend type "${type}". Supported types: env, generacy-cloud
```

**After:**
```
Unknown backend type "${type}". Supported types: env, cluster-local
```

Note: `cluster-local` is not yet implemented (phase 2) but is listed in the error to guide configuration toward the forthcoming backend.
