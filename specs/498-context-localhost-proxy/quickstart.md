# Quickstart: localhost-proxy Exposure Listener

## Overview

The localhost-proxy exposure allows the credhelper daemon to serve as a secure HTTP proxy for SaaS APIs. The agent connects to `http://127.0.0.1:<port>`, and the proxy injects auth headers and forwards only allowed method+path combinations to the upstream API.

## Role Configuration Example

```yaml
# .agency/roles/sendgrid-sender.yaml
schemaVersion: '1'
id: sendgrid-sender
description: Can send emails via SendGrid

credentials:
  - ref: sendgrid
    expose:
      - as: localhost-proxy
        port: 7823
        envName: SENDGRID_API_URL  # optional, defaults to SENDGRID_PROXY_URL

proxy:
  sendgrid:
    upstream: https://api.sendgrid.com
    default: deny
    allow:
      - method: POST
        path: /v3/mail/send
      - method: GET
        path: /v3/contacts/{id}
```

## How It Works

1. **Session begin**: Credhelper starts an HTTP server on `127.0.0.1:7823`
2. **Agent discovers proxy**: Via env var `SENDGRID_API_URL=http://127.0.0.1:7823`
3. **Agent sends request**: `POST http://127.0.0.1:7823/v3/mail/send`
4. **Proxy checks allowlist**: POST + /v3/mail/send → allowed
5. **Proxy forwards**: Adds `Authorization: Bearer <secret>` header, forwards to `https://api.sendgrid.com/v3/mail/send`
6. **Response returned**: Upstream response piped back to agent as-is
7. **Session end**: Proxy server stopped, port released

## Denied Requests

```
GET /v3/mail/send → 403 (wrong method)
POST /v3/other   → 403 (path not in allowlist)
```

Response body:
```json
{
  "error": "Request denied: GET /v3/mail/send does not match any allowed rule",
  "code": "PROXY_ACCESS_DENIED",
  "details": { "method": "GET", "path": "/v3/mail/send" }
}
```

## Path Matching Rules

- **Literal**: `/v3/mail/send` matches exactly `/v3/mail/send`
- **Param placeholder**: `/v3/contacts/{id}` matches `/v3/contacts/abc123` (any non-empty segment)
- **Query strings**: Stripped before matching (`/v3/mail/send?foo=bar` matches `/v3/mail/send`)
- **Trailing slashes**: Significant (`/v3/mail/send` does NOT match `/v3/mail/send/`)
- **Case**: Sensitive (`/v3/Mail/Send` does NOT match `/v3/mail/send`)

## Testing

```bash
# Run unit tests
cd packages/credhelper-daemon
pnpm test -- --grep "localhost-proxy"

# Run integration tests
pnpm test -- --grep "localhost-proxy integration"
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `PROXY_PORT_COLLISION` error on session start | Port already in use | Choose a different port in role config or end the conflicting session |
| `PROXY_CONFIG_MISSING` error | Role has `as: localhost-proxy` but no `proxy.<ref>` entry | Add `proxy:` block to role config keyed by credential ref |
| 403 on valid request | Method or path doesn't match allowlist | Check method case and exact path (trailing slashes matter) |
| Connection refused | Session not started or already ended | Verify session is active; check env var for correct port |
