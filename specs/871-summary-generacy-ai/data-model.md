# Data Model: Close the orchestrator + generacy CI test-coverage blind spot

**Feature**: 871 | **Date**: 2026-07-09

## N/A — This feature has no runtime data model

This issue is a **CI-wiring + test-remediation** change. It introduces:

- No new runtime entities.
- No new persistence.
- No new API request/response payloads.
- No schema changes to existing entities.

The only "types" this feature interacts with are pre-existing schemas whose test fixtures are stale:

| Pre-existing schema | Where defined | This feature's touch |
|--------------------|---------------|----------------------|
| `PollResponse` (approved variant) | `@generacy-ai/activation-client/src/types.ts` — requires `cloud_url` (#517) | Group C tests update their fixture to include `cloud_url`. No schema change. |
| Orchestrator config `auth` block | `packages/orchestrator/src/config/loader.ts` (Zod) | Group B tests add a valid `auth` block to their config fixture. No schema change. |
| GitHub webhook API responses (`GET/PATCH /repos/{owner}/{repo}/hooks/*`) | External (GitHub REST) | Group D tests refresh their `nock` / HTTP mock to match the current call shape used by `webhook-setup-service.ts`. No schema change on our side. |

## Test-fixture shape references

For traceability only — implementers refer to the source-of-truth locations, not to this doc.

- `PollResponse` approved variant — see `packages/activation-client/src/types.ts` (`PollResponseSchema`).
- Orchestrator config auth block — see `packages/orchestrator/src/config/loader.ts` schema.
- Webhook service call shapes — see `packages/orchestrator/src/services/webhook-setup-service.ts`.
