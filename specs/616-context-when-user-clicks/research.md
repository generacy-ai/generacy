# Research: Thread projectId into activation URL

**Feature**: #616 | **Date**: 2026-05-14

## Current Data Flow

```
Cloud API                    CLI (launch)              Container (.env)         Orchestrator
─────────                    ──────────                ────────────────         ────────────
POST /launch-config    →     fetchLaunchConfig()
  { projectId }              scaffoldEnvFile()    →    GENERACY_PROJECT_ID=X
                                                       (docker-compose env_file)  →  process.env['GENERACY_PROJECT_ID']

POST /device-code      ←─────────────────────────────────────────────────────────   activate()
  { verification_uri,                                                                prints "Go to: <verification_uri>"
    user_code }
                             compose.ts log scraper ←── docker logs
                             extracts URL + code
                             openBrowser(url)
```

**Gap**: `GENERACY_PROJECT_ID` is available in the orchestrator's environment but never read during activation. The `verification_uri` is printed verbatim.

## Technology Decision: URL Construction

**Decision**: Use the built-in `URL` API (global, no import needed in Node 22).

**Rationale**:
- Handles edge cases (trailing slashes, existing params, encoding) automatically
- `searchParams.set()` is idempotent and handles URL encoding
- Already used in the codebase (`scaffolder.ts:deriveRelayUrl` at line 78-85)

**Alternative rejected**: String concatenation (`url + '?projectId=' + id`) — brittle, doesn't handle existing query params or special characters.

## Key Finding: CLI Regex Already Handles Query Params

The CLI's log scraper regex at `compose.ts:64`:
```
/Go to:\s+(https?:\/\/[^\s\\"']+)/
```

This character class `[^\s\\"']` captures everything that's not whitespace, backslash, or quotes — which includes `?`, `=`, `&`, and all query param characters. No regex change needed.

## Key Finding: Deploy Command Also Needs Update

`deploy/activation.ts:42-47` prints the raw `verification_uri` and opens it. Same fix applies. The projectId is available from the activation context (fetched via `fetchLaunchConfig`).

## Scope Boundary

The cloud's `POST /api/clusters/device-code` response includes `verification_uri` as a bare URL (e.g., `https://app.generacy.ai/cluster-activate`). We append params client-side rather than asking the cloud to include them because:
1. The cloud doesn't know `projectId` at device-code issuance time (it's a generic endpoint)
2. Changing the cloud response would be a breaking API change
3. The orchestrator already has `GENERACY_PROJECT_ID` in its environment

## Pattern Precedent

`scaffolder.ts:deriveRelayUrl()` already uses the `URL` API to append `projectId` to the relay WebSocket URL:
```typescript
export function deriveRelayUrl(cloudUrl: string, projectId: string): string {
  const url = new URL(cloudUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = '/relay';
  url.searchParams.set('projectId', projectId);
  return url.toString();
}
```

The activation URL construction follows the same pattern.
