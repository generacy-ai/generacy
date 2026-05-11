# Quickstart: control-plane GET /roles endpoint

## Prerequisites

```bash
pnpm install
```

## Build

```bash
cd packages/control-plane
pnpm build
```

## Run Tests

```bash
cd packages/control-plane
pnpm test
```

Or with watch mode:
```bash
pnpm test:watch
```

## Manual Testing

### 1. Start the development stack

```bash
/workspaces/tetrad-development/scripts/stack start
source /workspaces/tetrad-development/scripts/stack-env.sh
pnpm dev
```

### 2. Create test role files

```bash
mkdir -p .agency/roles
cat > .agency/roles/reviewer.yaml << 'EOF'
description: "Code review role"
credentials:
  - ref: github-pat
    type: github-pat
EOF
```

### 3. Test endpoints via curl (against Unix socket)

```bash
# List all roles
curl --unix-socket /run/generacy-control-plane/control.sock http://localhost/roles

# Get specific role
curl --unix-socket /run/generacy-control-plane/control.sock http://localhost/roles/reviewer

# Get nonexistent role (should 404)
curl --unix-socket /run/generacy-control-plane/control.sock http://localhost/roles/nonexistent
```

### 4. Test via relay (wizard flow)

Navigate to the bootstrap wizard in the cloud UI. Step 3 (Role Selection) should:
- Load without console errors
- Display available roles from `.agency/roles/`
- Allow selection and proceed to step 4

## Expected Responses

### GET /roles (empty)
```json
{ "roles": [] }
```

### GET /roles (with roles)
```json
{
  "roles": [
    { "id": "reviewer", "description": "Code review role" }
  ]
}
```

### GET /roles/reviewer
```json
{
  "id": "reviewer",
  "description": "Code review role",
  "credentials": [
    { "ref": "github-pat", "type": "github-pat" }
  ]
}
```

### GET /roles/nonexistent
```json
{
  "error": "Role 'nonexistent' not found",
  "code": "NOT_FOUND"
}
```

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| 404 on `GET /roles` | Route not registered | Verify `router.ts` has the list route before the detail route |
| Empty roles list | No `.yaml` files in `.agency/roles/` | Create role files or check `CREDHELPER_AGENCY_DIR` env var |
| "Stub role" in response | Old `handleGetRole` still active | Verify the rewritten handler is compiled (`pnpm build`) |
| Socket connection refused | Control-plane not running | Check `CONTROL_PLANE_SOCKET_PATH` and service status |
