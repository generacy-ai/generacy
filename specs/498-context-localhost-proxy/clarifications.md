# Clarifications: Localhost-Proxy Exposure Listener

## Batch 1 — 2026-04-29

### Q1: Proxy block requirement for localhost-proxy exposure
**Context**: The role schema defines `proxy:` as optional (`z.record(ProxyConfigSchema).optional()`), but the spec states the proxy listener config is "built from the role's `proxy:` block" — implying it's required for localhost-proxy exposures. If an operator defines a credential with `as: localhost-proxy` but omits the corresponding `proxy:` entry, the listener would have no allowlist rules and no upstream URL (from the role level). This affects validation behavior and fail-closed guarantees.
**Question**: When a credential uses `as: localhost-proxy` exposure but the role has no matching `proxy:` entry, should session creation fail with a validation error? Or should it fall back to a permissive mode using only the plugin's upstream/headers?
**Options**:
- A: Fail closed — require a `proxy:` entry for any localhost-proxy exposure; reject at session start if missing
- B: Fall back — use plugin-provided upstream with no allowlist (allow-all)

**Answer**: A — Fail closed. Session creation must fail with a clear validation error when a credential exposes `as: localhost-proxy` but the role has no matching `proxy:` entry. Error message names the missing key (e.g., "role 'devops' has credential 'sendgrid' exposed as localhost-proxy but no `proxy.sendgrid` entry to define upstream and allowlist"). Consistent with credentials architecture decision #12 (role validation fails closed when exposure isn't fully specified). Permissive fallback (B) is exactly the kind of "default allow" misconfiguration the credentials system is designed to prevent.

### Q2: Agent proxy URL discovery mechanism
**Context**: After the proxy starts on `127.0.0.1:<port>`, the agent process needs to know this URL to direct its API requests through the proxy. Current exposure patterns communicate with the agent via session env vars (e.g., `env` exposure writes `KEY=value` to the session env file) or session directory files (e.g., `gcloud-external-account` writes a JSON config). The existing `renderLocalhostProxy` stub writes `proxy/config.json` to the session dir, but agents typically consume env vars rather than parsing config files.
**Question**: How should the proxy endpoint be communicated to the agent? Should a session env var be written (e.g., `SENDGRID_URL=http://127.0.0.1:7823`), and if so, how is the env var name determined — from the credential ref, the expose rule, or a new field?
**Options**:
- A: Session env var with name derived from credential ref (e.g., `SENDGRID_PROXY_URL`)
- B: Session env var with explicit name from a new `envName` field on the expose rule
- C: Agent reads `proxy/config.json` from session directory (no env var)

**Answer**: B — Explicit `envName` field on the expose rule. Add `envName?: string` to the `localhost-proxy` exposure schema in `packages/credhelper/src/schemas/exposure.ts`. Role declares which env var the agent should consume. Falls back to a derived name `<CREDENTIAL_REF_UPPER>_PROXY_URL` if `envName` is omitted. The session env file gets `<envName>=http://127.0.0.1:<port>` written.

### Q3: Path matching edge cases
**Context**: The spec defines `{param}` as matching "a single non-empty path segment" with literal path support. However, real HTTP requests may include trailing slashes, query strings, or different casing. If these edge cases aren't handled consistently, agents may receive unexpected 403 errors on valid requests (e.g., `POST /v3/mail/send?timeout=30` failing because the query string is included in path matching).
**Question**: For allowlist path matching: (a) Should query strings be stripped before matching? (b) Are trailing slashes significant (i.e., does `/v3/mail/send` match `/v3/mail/send/`)? (c) Is path matching case-sensitive?
**Options**:
- A: Strip query strings, normalize trailing slashes (lenient), case-sensitive paths
- B: Strip query strings, trailing slashes are significant (strict), case-sensitive paths
- C: Strip query strings, normalize trailing slashes (lenient), case-insensitive paths

**Answer**: B — Strip query strings, trailing slashes are significant (strict), case-sensitive paths. Most correct from an HTTP semantics perspective (RFC 7230). Allowlist matching should err on strictness — a false-deny is recoverable (role author adds the alternate path), but a false-allow is a security hole. Query strings always stripped before matching.
