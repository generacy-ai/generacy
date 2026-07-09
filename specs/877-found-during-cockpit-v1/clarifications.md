# Clarifications for #877 — `wizard-credentials.env` written without trailing newline

## Batch 1 — 2026-07-09

**No clarifications needed — spec is unambiguous.**

The spec is a scoped bug fix with:

- Root cause identified at `packages/control-plane/src/services/wizard-env-writer.ts:83-86` (formatEnvFile) with concrete example of the corruption pattern (`GH_EMAIL=…CLUSTER_ACTING_LOGIN=generacy-ai`).
- Fix described as a single-line change (append `+ '\n'` to the join in `formatEnvFile`).
- 5 functional requirements covering the invariant (FR-001), empty-entries flexibility (FR-002), file-mode preservation (FR-003), and two required regression tests (FR-004, FR-005).
- Explicit out-of-scope carve-outs, including the `CLUSTER_ACTING_LOGIN` env-var plumbing superseded by #878.
- Test file location specified (`packages/control-plane/__tests__/services/wizard-env-writer.test.ts`) — already exists; the existing `formatEnvFile` assertion at line 372 updates in place.

Proceed to `/plan`.
