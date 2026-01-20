# Quickstart: Orchestrator Service

## Installation

```bash
# From monorepo root
npm install

# Build the orchestrator package
npm run build -w packages/orchestrator
```

## Configuration

Create a `.env` file or set environment variables:

```bash
# Server
PORT=3000
HOST=0.0.0.0

# Redis
REDIS_URL=redis://localhost:6379

# Authentication
AUTH_ENABLED=true
JWT_SECRET=your-secret-key-here

# GitHub OAuth (optional, for Humancy extension)
GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
GITHUB_CALLBACK_URL=http://localhost:3000/auth/github/callback

# Rate Limiting
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW=1 minute

# Logging
LOG_LEVEL=info
LOG_PRETTY=true
```

Or use YAML configuration (`config/orchestrator.yaml`):

```yaml
orchestrator:
  port: 3000
  host: 0.0.0.0

  redis:
    url: redis://localhost:6379

  auth:
    enabled: true
    providers:
      - apiKey
      - github-oauth2
    jwt:
      secret: ${JWT_SECRET}
      expiresIn: '24h'

  rateLimit:
    max: 100
    timeWindow: '1 minute'
```

## Running

### Development

```bash
# Start Redis (if not running)
docker run -d -p 6379:6379 redis:7-alpine

# Start the server in development mode
npm run dev -w packages/orchestrator
```

### Production

```bash
# Build
npm run build -w packages/orchestrator

# Start
npm run start -w packages/orchestrator

# Or with Docker
docker build -t generacy/orchestrator packages/orchestrator
docker run -p 3000:3000 generacy/orchestrator
```

## API Usage

### Authentication

**API Key** (for CLI/CI):
```bash
curl -H "X-API-Key: your-api-key" http://localhost:3000/workflows
```

**JWT Token** (after OAuth):
```bash
curl -H "Authorization: Bearer <jwt-token>" http://localhost:3000/workflows
```

### Workflow Operations

**Create Workflow**:
```bash
curl -X POST http://localhost:3000/workflows \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "definitionId": "standard-development",
    "context": {
      "repository": "owner/repo",
      "issueNumber": 42
    },
    "metadata": {
      "name": "Fix login bug",
      "tags": ["bug", "auth"]
    }
  }'
```

**List Workflows**:
```bash
curl -H "X-API-Key: your-api-key" \
  "http://localhost:3000/workflows?status=running&page=1&pageSize=10"
```

**Get Workflow**:
```bash
curl -H "X-API-Key: your-api-key" \
  http://localhost:3000/workflows/550e8400-e29b-41d4-a716-446655440000
```

**Pause/Resume/Cancel**:
```bash
# Pause
curl -X POST http://localhost:3000/workflows/{id}/pause \
  -H "X-API-Key: your-api-key"

# Resume
curl -X POST http://localhost:3000/workflows/{id}/resume \
  -H "X-API-Key: your-api-key"

# Cancel
curl -X DELETE http://localhost:3000/workflows/{id} \
  -H "X-API-Key: your-api-key"
```

### Decision Queue

**Get Queue**:
```bash
curl -H "X-API-Key: your-api-key" http://localhost:3000/queue
```

**Respond to Decision**:
```bash
curl -X POST http://localhost:3000/queue/{id}/respond \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "response": true,
    "comment": "LGTM!"
  }'
```

### WebSocket Streaming

```javascript
const ws = new WebSocket('ws://localhost:3000/ws', {
  headers: { 'Authorization': 'Bearer <jwt-token>' }
});

ws.onopen = () => {
  // Subscribe to channels
  ws.send(JSON.stringify({
    type: 'subscribe',
    channels: ['workflows', 'queue']
  }));
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log(message.type, message.payload);
};
```

### Health Check

```bash
# Readiness
curl http://localhost:3000/health

# Response
{
  "status": "ok",
  "timestamp": "2026-01-20T12:00:00Z",
  "services": {
    "redis": "ok",
    "workflowEngine": "ok"
  }
}
```

### Metrics

```bash
# Prometheus format
curl http://localhost:3000/metrics

# Output
# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{method="GET",path="/workflows",status="200"} 42
...
```

## Testing

```bash
# Unit tests
npm run test -w packages/orchestrator

# Integration tests (requires Redis)
npm run test:integration -w packages/orchestrator

# Watch mode
npm run test:watch -w packages/orchestrator
```

## Troubleshooting

### Common Issues

**Redis Connection Failed**:
```
Error: connect ECONNREFUSED 127.0.0.1:6379
```
- Ensure Redis is running: `docker run -d -p 6379:6379 redis:7-alpine`

**Rate Limited**:
```json
{
  "type": "urn:generacy:error:rate-limited",
  "title": "Too Many Requests",
  "status": 429,
  "detail": "Rate limit exceeded. Try again in 60 seconds."
}
```
- Wait for rate limit window to reset
- Check your API key's rate limit configuration

**Invalid API Key**:
```json
{
  "type": "urn:generacy:error:unauthorized",
  "title": "Unauthorized",
  "status": 401,
  "detail": "Invalid or missing API key"
}
```
- Verify the `X-API-Key` header is correct
- Check if the API key has expired

**WebSocket Connection Rejected**:
- Ensure auth token is passed in upgrade request
- Check if token has expired
- Verify CORS settings allow WebSocket connections

### Logs

```bash
# View logs (development)
npm run dev -w packages/orchestrator

# View logs (production)
docker logs <container-id>

# Structured JSON logs
{"level":"info","time":1705750800000,"msg":"Server started","port":3000}
```

---

*Generated by speckit*
