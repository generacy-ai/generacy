# Quickstart: Generacy Extension Integration Verification

## Prerequisites

- Node.js 18+
- pnpm (`npm install -g pnpm`)
- Docker Desktop (for Firestore emulator)
- VS Code 1.80+

## Installation

### 1. Install Dependencies

```bash
# From repo root
pnpm install
```

### 2. Start Orchestrator Locally

```bash
# Start the orchestrator service
cd packages/orchestrator
pnpm dev
```

The orchestrator runs on `http://localhost:3001` by default.

### 3. Configure Extension

Create or update `.vscode/settings.json`:

```json
{
  "generacy.cloudEndpoint": "http://localhost:3001",
  "generacy.cloud.autoConnect": false
}
```

### 4. Set Up API Key (for testing)

The orchestrator uses an in-memory API key store in development. Add a test key:

```bash
# Set environment variable before starting orchestrator
export API_KEY_STORE=in-memory
export TEST_API_KEY=test-key-for-local-dev
```

Or add to `.env` in orchestrator directory.

## Usage

### Verify Health Endpoint

```bash
curl http://localhost:3001/health
# Expected: {"status":"ok"}
```

### Test Authenticated Request

```bash
curl -H "X-API-Key: test-key-for-local-dev" \
  http://localhost:3001/workflows
# Expected: {"workflows":[],...}
```

### Run Extension in Development

```bash
# From repo root
pnpm --filter generacy-extension dev

# Or press F5 in VS Code with extension project open
```

### Run Integration Tests

```bash
# Run all integration tests
pnpm --filter orchestrator test:integration

# Run extension API tests
pnpm --filter generacy-extension test
```

## Available Commands

### Orchestrator

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start in development mode |
| `pnpm build` | Build for production |
| `pnpm test` | Run unit tests |
| `pnpm test:integration` | Run integration tests |
| `pnpm lint` | Check code style |

### Extension

| Command | Description |
|---------|-------------|
| `pnpm dev` | Build and watch |
| `pnpm build` | Production build |
| `pnpm test` | Run tests |
| `pnpm package` | Create VSIX package |

## Troubleshooting

### Connection Refused

**Problem**: Extension shows "Connection refused" or "ECONNREFUSED"

**Solutions**:
1. Verify orchestrator is running: `curl http://localhost:3001/health`
2. Check correct port in extension settings
3. Ensure no firewall blocking localhost

### Authentication Failed

**Problem**: 401 Unauthorized responses

**Solutions**:
1. Verify API key is set correctly in orchestrator
2. Check `X-API-Key` header format
3. Try with `AUTH_ENABLED=false` for debugging

### Extension Not Loading Cloud Views

**Problem**: Dashboard/Queue views are empty or not visible

**Solutions**:
1. Open VS Code Developer Tools (Help > Toggle Developer Tools)
2. Check console for errors
3. Verify `generacy.cloudEndpoint` setting is correct
4. Reload window (Cmd/Ctrl+Shift+P > Reload Window)

### Firestore Connection Issues

**Problem**: Orchestrator fails to connect to Firestore

**Solutions**:
1. Ensure Docker is running
2. Start Firestore emulator: `gcloud emulators firestore start`
3. Set `FIRESTORE_EMULATOR_HOST=localhost:8080`

### Schema Validation Errors

**Problem**: "Invalid response" or Zod validation errors

**Solutions**:
1. Check orchestrator logs for response shape
2. Verify API version compatibility
3. Update extension or orchestrator to match schemas

## Example Verification Flow

```bash
# 1. Start orchestrator
cd packages/orchestrator
pnpm dev

# 2. In another terminal, verify health
curl http://localhost:3001/health

# 3. Create a test workflow
curl -X POST http://localhost:3001/workflows \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-key" \
  -d '{"context": {"test": true}}'

# 4. List workflows
curl -H "X-API-Key: test-key" http://localhost:3001/workflows

# 5. Open VS Code with extension and verify dashboard shows data
```

## Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3001 | Orchestrator port |
| `JWT_SECRET` | (required) | Secret for signing JWTs |
| `API_KEY_STORE` | in-memory | Where to store API keys |
| `AUTH_ENABLED` | true | Enable/disable auth |
| `LOG_LEVEL` | info | Logging verbosity |
| `FIRESTORE_EMULATOR_HOST` | - | Firestore emulator address |
