# Implementation Plan: Verify Generacy Extension Integration

**Feature**: Verify VS Code extension cloud features against local generacy-cloud API
**Branch**: `144-verify-generacy-extension-integration`
**Status**: Complete

## Summary

This plan covers verification of the Generacy VS Code extension's cloud features (organization dashboard, workflow queue, publishing, integrations) against the locally-running orchestrator API. The goal is to confirm that all integration points work correctly in local development mode.

## Technical Context

**Language**: TypeScript
**Framework**: VS Code Extension API + Fastify (orchestrator)
**Dependencies**:
- Extension: `vscode`, `zod`, native fetch
- Orchestrator: `fastify`, `@fastify/jwt`, `zod`
- Testing: `vitest`, `playwright` (for E2E)

**Key Technologies**:
- VS Code Extension API for UI components
- Fastify for API server
- JWT + API Key authentication
- Zod schema validation
- SecretStorage for token persistence

## Architecture Overview

```
┌─────────────────────────────────────────┐
│     VS Code Extension                   │
│  ┌────────────┐  ┌──────────────────┐   │
│  │ Auth       │  │ Cloud Views      │   │
│  │ Service    │  │ - Dashboard      │   │
│  │            │  │ - Queue          │   │
│  └─────┬──────┘  │ - Publish        │   │
│        │         │ - Integrations   │   │
│        │         └────────┬─────────┘   │
│        │                  │             │
│  ┌─────┴──────────────────┴─────┐       │
│  │ API Client (client.ts)       │       │
│  │ - JWT Bearer auth            │       │
│  │ - Retry logic                │       │
│  │ - Zod validation             │       │
│  └─────────────┬────────────────┘       │
└────────────────┼────────────────────────┘
                 │ HTTP
┌────────────────┼────────────────────────┐
│  Orchestrator  │ (localhost:3001)       │
│  ┌─────────────┴────────────────┐       │
│  │ Auth Middleware              │       │
│  │ - JWT verification           │       │
│  │ - API Key validation         │       │
│  └─────────────┬────────────────┘       │
│  ┌─────────────┴────────────────┐       │
│  │ Routes                       │       │
│  │ /workflows, /queue, /health  │       │
│  └──────────────────────────────┘       │
└─────────────────────────────────────────┘
```

## Project Structure

```
packages/
├── generacy-extension/
│   └── src/
│       ├── api/
│       │   ├── client.ts           # HTTP client with auth
│       │   ├── auth.ts             # OAuth/token management
│       │   ├── types.ts            # Zod schemas
│       │   └── endpoints/          # Typed API methods
│       │       ├── orgs.ts
│       │       ├── queue.ts
│       │       ├── workflows.ts
│       │       └── integrations.ts
│       ├── views/cloud/
│       │   ├── dashboard/          # Org dashboard webview
│       │   ├── queue/              # Queue tree view
│       │   ├── publish/            # Publishing UI
│       │   └── integrations/       # Integration management
│       └── utils/
│           └── config.ts           # Settings management
├── orchestrator/
│   └── src/
│       ├── auth/
│       │   ├── jwt.ts              # JWT verification
│       │   ├── api-key.ts          # API key validation
│       │   └── middleware.ts       # Auth enforcement
│       └── routes/
│           ├── workflows.ts        # Workflow CRUD
│           ├── queue.ts            # Decision queue
│           └── integrations.ts     # Integration info
└── tests/
    └── integration/                # Integration test suites
```

## Verification Strategy

### Phase 1: Environment Setup Verification
1. Confirm orchestrator starts on localhost:3001
2. Verify health endpoints respond
3. Confirm extension can reach the API

### Phase 2: Authentication Verification
1. Test API key authentication (primary for local dev)
2. Verify JWT token handling
3. Test token refresh flow

### Phase 3: Core API Verification
1. **Workflows**: Create, list, get, pause, resume
2. **Queue**: List items, get details, respond to decisions
3. **Organizations**: Get org details, members, usage

### Phase 4: Extension UI Verification
1. Dashboard loads org data correctly
2. Queue view displays items
3. Publishing flow works end-to-end

## API Endpoint Mapping

| Extension Endpoint | Orchestrator Route | Auth Required |
|--------------------|-------------------|---------------|
| `GET /orgs` | `GET /workflows` | `workflows:read` |
| `GET /orgs/:id` | `GET /workflows/:id` | `workflows:read` |
| `GET /queue` | `GET /queue` | `queue:read` |
| `GET /queue/:id` | `GET /queue/:id` | `queue:read` |
| `POST /queue/:id/respond` | `POST /queue/:id/respond` | `queue:write` |
| `POST /workflows` | `POST /workflows` | `workflows:write` |
| `GET /health` | `GET /health` | None |

## Configuration Requirements

### Extension Settings (settings.json)
```json
{
  "generacy.cloudEndpoint": "http://localhost:3001",
  "generacy.cloud.autoConnect": false
}
```

### Orchestrator Environment (.env)
```bash
PORT=3001
JWT_SECRET=dev-secret-for-testing
API_KEY_STORE=in-memory
AUTH_ENABLED=true
LOG_LEVEL=debug
```

## Test Approach

### Automated Tests (vitest)
- API client unit tests with mocked responses
- Auth flow unit tests
- Schema validation tests

### Integration Tests
- Extension → Orchestrator connectivity
- Full request/response cycle validation
- Error handling scenarios

### Manual Verification Checklist
- Visual inspection of dashboard data
- Queue interaction responsiveness
- Error message clarity

## Success Criteria

| Criterion | Verification Method |
|-----------|---------------------|
| Extension connects to local API | Health check passes |
| API key auth works | Authenticated request succeeds |
| Dashboard shows org data | Visual + API response match |
| Queue displays items | Item count matches API |
| Workflow operations work | Create/list/get succeed |
| Error messages are clear | Connection failure shows helpful message |

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| OAuth requires GitHub | High | Use API key auth for local dev |
| Missing API endpoints | Medium | Document gaps, create issues |
| Schema mismatches | Medium | Zod validation catches early |
| Docker/Firestore issues | Low | Document prerequisites clearly |

## Dependencies

- Docker Desktop (for Firestore emulator)
- Node.js 18+
- VS Code 1.80+
- pnpm for package management

## Constitution Check

N/A - No constitution.md found in `.specify/memory/`

## Next Steps

1. Run `/speckit:tasks` to generate the detailed task list
2. Set up local development environment
3. Execute verification tests
4. Document any issues found
