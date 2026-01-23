# Research: Generacy Extension Integration Verification

## Technology Decisions

### Primary Authentication: API Key
**Decision**: Use API key authentication for local development verification
**Rationale**:
- OAuth flow requires GitHub app registration and callback handling
- API keys are simpler to configure for local testing
- Extension supports both methods via `X-API-Key` header
- Production will use OAuth, but API key is sufficient for verification

### Test Framework: Vitest + Playwright
**Decision**: Use vitest for unit/integration tests, Playwright for E2E
**Rationale**:
- Vitest already in use across the monorepo
- Playwright provides reliable VS Code extension testing
- Both support TypeScript natively

### API Validation: Zod
**Decision**: Continue using Zod schemas for all API responses
**Rationale**:
- Already implemented in extension (`src/api/types.ts`)
- Catches schema mismatches at runtime
- Provides TypeScript inference

## Alternatives Considered

### Authentication Methods
| Method | Pros | Cons | Chosen |
|--------|------|------|--------|
| API Key | Simple, stateless | No user identity | Yes (local dev) |
| JWT | User context, expirable | Requires OAuth flow | No |
| Mock Auth | No setup needed | Doesn't verify real flow | No |

### Testing Approaches
| Approach | Pros | Cons | Chosen |
|----------|------|------|--------|
| Manual Only | Quick, flexible | Not repeatable | No |
| Automated Only | Repeatable | Can't test visual | No |
| Hybrid | Best of both | More effort | Yes |

## Implementation Patterns

### API Client Pattern (Extension)
The extension uses a singleton API client with:
```typescript
// Fetch-based with retry logic
class ApiClient {
  private baseUrl: string;
  private tokens: AuthTokens | null;

  async request<T>(endpoint: string, options: RequestOptions): Promise<T> {
    // 1. Add auth header (API key or Bearer token)
    // 2. Execute fetch with timeout
    // 3. Retry on transient failures (3 attempts, exponential backoff)
    // 4. Validate response with Zod
    // 5. Return typed result
  }
}
```

### Auth Middleware Pattern (Orchestrator)
```typescript
// Fastify preHandler hook
async function authMiddleware(request, reply) {
  // 1. Check X-API-Key header
  // 2. If not present, check Authorization: Bearer
  // 3. Validate credentials
  // 4. Attach user/scopes to request
  // 5. Continue or return 401
}
```

### Error Handling Pattern
```typescript
// Extension error display
try {
  const data = await client.get('/endpoint');
} catch (error) {
  if (error instanceof AuthError) {
    // Prompt for re-authentication
  } else if (error instanceof NetworkError) {
    // Show connection troubleshooting
  } else {
    // Generic error with details
  }
}
```

## Key Sources/References

### Codebase References
- Extension API client: `packages/generacy-extension/src/api/client.ts`
- Auth service: `packages/generacy-extension/src/api/auth.ts`
- Orchestrator routes: `packages/orchestrator/src/routes/`
- Auth middleware: `packages/orchestrator/src/auth/middleware.ts`

### Documentation
- VS Code Extension API: https://code.visualstudio.com/api
- Fastify JWT: https://github.com/fastify/fastify-jwt
- Zod: https://zod.dev/

## Configuration Discovery

### Extension Settings Schema
Found in `package.json` contributes.configuration:
```json
{
  "generacy.cloudEndpoint": {
    "type": "string",
    "default": "https://api.generacy.ai",
    "description": "Generacy Cloud API endpoint"
  },
  "generacy.cloud.autoConnect": {
    "type": "boolean",
    "default": false,
    "description": "Automatically connect to cloud on startup"
  }
}
```

### Orchestrator Environment Variables
```
PORT=3001
JWT_SECRET=<secret>
API_KEY_STORE=in-memory|firestore
AUTH_ENABLED=true|false
FIRESTORE_EMULATOR_HOST=localhost:8080
```

## API Response Shapes

### Workflow Response
```typescript
{
  id: "uuid",
  status: "created" | "running" | "paused" | "completed" | "cancelled" | "failed",
  currentStep?: "step-id",
  context: { /* workflow variables */ },
  metadata: { name?: string, tags?: string[] },
  createdAt: "ISO8601",
  updatedAt: "ISO8601",
  completedAt?: "ISO8601"
}
```

### Queue Item Response
```typescript
{
  id: "uuid",
  workflowId: "uuid",
  stepId: "step-id",
  type: "approval" | "choice" | "input" | "review",
  prompt: "What would you like to do?",
  options?: [{ id, label, description? }],
  context: { /* decision context */ },
  priority: "blocking_now" | "blocking_soon" | "when_available",
  createdAt: "ISO8601",
  dueAt?: "ISO8601"
}
```

## Discovered Issues/Gaps

1. **Endpoint Mismatch**: Extension calls `/orgs/*` but orchestrator has `/workflows/*`
   - Need to verify if there's an org-specific API layer or if extension needs update

2. **Missing Org Endpoints**: Orchestrator routes don't include organization management
   - `/orgs` endpoints may be in a separate service (generacy-cloud)
   - Verification should focus on what orchestrator provides

3. **OAuth Callback**: Extension expects `vscode://` callback URI
   - Local dev may need localhost callback configuration

## Recommendations

1. **Start with health check**: Verify basic connectivity before complex flows
2. **Use API key auth**: Skip OAuth complexity for initial verification
3. **Test happy paths first**: Confirm basic operations work before edge cases
4. **Document gaps**: Create issues for any missing functionality discovered
