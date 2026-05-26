# Feature Specification: Fix double-space in `formatTierLimitError` when tier name is unknown

**Branch**: `728-symptom-cli-s-resolver` | **Date**: 2026-05-26 | **Status**: Draft
**Issue**: [#728](https://github.com/generacy-ai/generacy/issues/728)
**Type**: Bug fix (cosmetic / user-facing message)

## Summary

The CLI's resolver-side tier-limit gate is the most common error path users hit when launching with `--workers=N` exceeding their tier cap. Today that path produces an error message containing two consecutive spaces between "your" and "plan":

```
Worker count of 5 exceeds your  plan limit of 2. Upgrade your plan or retry with --workers=2.
```

The cause is that `worker-count-resolver.ts` doesn't have a tier name available (the `launch-config` API exposes `tierCap` but not `tier`), so it passes `tier: ''` into the shared `formatTierLimitError` formatter. The formatter title-cases the empty string into an empty string, leaving a stray space in the template literal.

This is the path that fires in ~99% of over-cap launches (the resolver-side gate runs before any cloud poll). The poll-time path used by the orchestrator and `deploy` command receives a real tier name from the cloud and renders correctly.

The fix updates the formatter to gracefully omit the tier-name segment when `tier` is empty, producing a clean message from both call sites without requiring a cloud-side change.

## User Stories

### US1: CLI user sees a well-formed over-cap error message

**As a** developer running `npx generacy launch --workers=N` against an org whose tier cap is below `N`,
**I want** the resolver-side error message to be free of formatting glitches (no double spaces),
**So that** the message reads professionally and the upgrade/retry call-to-action is clear.

**Acceptance Criteria**:
- [ ] Running `npx generacy launch --workers=5` against an org with `tierCap=2` prints an error message containing no double spaces.
- [ ] The message still conveys the requested worker count, the cap, and the `--workers=<cap>` retry instruction.

### US2: Poll-time tier-limit path retains tier name when available

**As a** developer hitting the cloud-side `tier-limit-exceeded` response (via the orchestrator or `deploy` command),
**I want** the error message to continue naming my plan tier (e.g. "Basic", "Pro"),
**So that** I know which tier limit I exceeded and which upgrade path applies.

**Acceptance Criteria**:
- [ ] When `tier` is non-empty (e.g. `'basic'`), the message reads `Worker count of N exceeds your Basic plan limit of C. Upgrade your plan or retry with --workers=C.`
- [ ] When `tier` is empty, the message reads `Worker count of N exceeds your plan limit of C. Upgrade your plan or retry with --workers=C.` (no double space, tier name omitted).

## Functional Requirements

| ID    | Requirement | Priority | Notes |
|-------|-------------|----------|-------|
| FR-001 | `formatTierLimitError` must omit the tier-name segment when `tier` is empty or falsy, producing a message with no double whitespace. | P1 | Pure-function fix in `packages/activation-client/src/format-tier-limit-error.ts`. |
| FR-002 | `formatTierLimitError` must preserve current rendering when `tier` is a non-empty string (title-cased first letter, rest unchanged). | P1 | Existing non-empty-tier tests must continue to pass without modification. |
| FR-003 | The existing test case `'handles empty tier (degenerate, degrades acceptably)'` in `packages/activation-client/tests/unit/format-tier-limit-error.test.ts` must be updated to assert the new, well-formed output (no double space). | P1 | Test currently codifies the buggy behavior; updating it is part of the fix. |
| FR-004 | No call-site changes required in `worker-count-resolver.ts`, orchestrator, or `deploy` command. | P1 | Resolver continues passing `tier: ''`; fix is entirely inside the formatter. |

## Success Criteria

| ID     | Metric | Target | Measurement |
|--------|--------|--------|-------------|
| SC-001 | Resolver-side message double-space count | 0 | Grep output of `npx generacy launch --workers=5` (against Basic-tier org) contains no `your  plan` substring. |
| SC-002 | Poll-time message tier-name rendering | Unchanged | Existing non-empty-tier unit tests in `format-tier-limit-error.test.ts` pass without assertion changes. |
| SC-003 | Regression test coverage | 1 passing test for empty-tier case | `format-tier-limit-error.test.ts` includes a test asserting the empty-tier output has no double space. |

## Assumptions

- The shape of `TierLimitErrorInput` (`requested: number; cap: number; tier: string`) is stable; `tier` remains a `string` (not changed to `string | undefined`) to avoid call-site updates.
- "Falsy" tier means empty string; the formatter is not expected to defend against `null`/`undefined` at the type level (TypeScript enforces `string`), but a `tier ? ... : ...` check naturally handles both.
- Existing `format-tier-limit-error.test.ts` is the canonical test file; no new test file is needed.
- The richer fix (`launch-config` exposing `tier` alongside `tierCap` so the resolver passes a real tier name) is explicitly out of scope and tracked separately.

## Out of Scope

- Adding a `tier` field to the cloud's `launch-config` response (`services/api/src/services/launch-config.ts` in `generacy-cloud`).
- Threading a real tier name through `worker-count-resolver.ts` to the formatter.
- Changing the signature of `TierLimitErrorInput` (e.g., making `tier` optional).
- Internationalization or copy-rewriting of the tier-limit message body.
- Any change to the poll-time call path's error handling in orchestrator or `deploy`.

## Related

- [#727](https://github.com/generacy-ai/generacy/pull/727) — introduced the shared `formatTierLimitError` formatter via Q4=C consolidation. The empty-tier call from the resolver wasn't surfaced during clarification because `launch-config`'s missing `tier` field wasn't on the radar.
- [generacy-cloud#699](https://github.com/generacy-ai/generacy-cloud/issues/699) — exposed `tierCap` in launch-config; adding `tier` is the natural sibling for the future "richer fix" enhancement.

---

*Generated by speckit*
