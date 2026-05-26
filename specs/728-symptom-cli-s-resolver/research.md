# Research: Fix double-space in `formatTierLimitError`

**Feature**: 728-symptom-cli-s-resolver
**Phase**: 0 (Research)

## Context

`formatTierLimitError` was extracted into `packages/activation-client` during PR #727 as part of the Q4=C consolidation. Three call sites exist:

1. `packages/generacy/src/cli/commands/launch/worker-count-resolver.ts` — resolver-side gate. Has access to `tierCap` from `launch-config` but **not** to a tier name (the cloud's `launch-config` response does not include `tier`). Passes `tier: ''`.
2. `packages/orchestrator/src/activation/**` — poll-time path. Receives a real tier name from the cloud's `tier-limit-exceeded` response. Passes e.g. `tier: 'basic'`.
3. `packages/generacy/src/cli/commands/deploy/**` — same poll-time semantics as the orchestrator.

The resolver-side path is by far the most common (it fires before any cloud poll); the orchestrator/deploy paths only trigger when the resolver-side gate is bypassed (e.g. unknown cap, race) and a server-side rejection happens.

## Decision

**Make the formatter emit `your plan limit of ${cap}` (no tier-name segment) when `tier` is falsy, and `your ${Title} plan limit of ${cap}` otherwise.**

Implementation sketch:

```ts
export function formatTierLimitError(input: TierLimitErrorInput): string {
  const { requested, cap, tier } = input;
  const planQualifier = tier
    ? `${tier.charAt(0).toUpperCase() + tier.slice(1)} plan`
    : 'plan';
  return `Worker count of ${requested} exceeds your ${planQualifier} limit of ${cap}. Upgrade your plan or retry with --workers=${cap}.`;
}
```

## Rationale

- **Locality**: The bug lives in the formatter; the fix lives in the formatter. No other module needs to know about empty tiers.
- **No call-site churn**: Spec FR-004 explicitly forbids touching `worker-count-resolver.ts`, the orchestrator, or `deploy`. Keeping `tier: string` (not `string | undefined`) and handling the falsy case internally avoids a ripple.
- **No protocol change**: A "richer" fix (adding `tier` to `launch-config`) requires a `generacy-cloud` change and is tracked separately (see `generacy-cloud#699`). Scope-creeping into it here couples this PR to a cross-repo coordination.
- **Backward-compatible**: All existing non-empty-tier tests pass unchanged. Only the test that codifies the buggy empty-tier output needs updating.

## Alternatives Considered

### Alt A: Add `tier` to `launch-config` response and pass it through

- **Pro**: Solves the underlying information gap; resolver-side messages name the tier.
- **Con**: Cross-repo change (`generacy-cloud` + `generacy`); requires API versioning consideration; out of scope per spec. The cosmetic bug would persist until both PRs landed.
- **Verdict**: Rejected for this feature. Tracked as a follow-up (`generacy-cloud#699` sibling).

### Alt B: Change `TierLimitErrorInput.tier` to `string | undefined`

- **Pro**: Type system makes "no tier known" explicit.
- **Con**: Spec FR-004 forbids call-site changes; making the field optional forces resolver and other callers to update their construction sites. Also moves the burden of "what does absence mean" into the type instead of solving it once in the formatter.
- **Verdict**: Rejected. The runtime `tier ? ... : ...` check handles both `''` and (defensively) `null`/`undefined` without type churn.

### Alt C: Defensive double-space replacement (`.replace(/\s+/g, ' ')`)

- **Pro**: Catches any future formatting glitch generically.
- **Con**: Masks the structural cause; encourages "post-process the string" patterns that are hard to reason about. Title-casing and template-literal composition are the right place to fix this.
- **Verdict**: Rejected. Symptom-treating, not cause-treating.

### Alt D: Conditional template literals (two return paths)

- **Pro**: Slightly more explicit than building `planQualifier` first.
- **Con**: Duplicates ~80% of the template, raising the risk of the two branches drifting (e.g. one PR updates the upgrade hint in only one branch).
- **Verdict**: Rejected. The single-return form with a pre-built qualifier is shorter and DRY-er.

## Implementation Patterns

- **Pure function, in-line conditional qualifier** — a single ternary on the qualifier, single return statement. Matches the existing function shape and the test suite's "is pure (identical input yields strict-equal output)" assertion.
- **Test-update-then-implement** — the empty-tier test currently asserts the buggy output (`'your  plan limit'`). It must flip to assert the new output. A second regression test (`tier=''` produces no double space) can be added explicitly, though the updated existing test is functionally equivalent — adding it makes intent legible.

## Sources / References

- [#727](https://github.com/generacy-ai/generacy/pull/727) — Introduced shared `formatTierLimitError`. Q4=C consolidation.
- [generacy-cloud#699](https://github.com/generacy-ai/generacy-cloud/issues/699) — Exposed `tierCap` (not `tier`) in launch-config.
- `packages/activation-client/src/format-tier-limit-error.ts` — current source.
- `packages/activation-client/tests/unit/format-tier-limit-error.test.ts` — current test.
- Spec at [`spec.md`](./spec.md) — clarification-phase decisions are codified here; this research expands on the "why" behind the chosen approach.
