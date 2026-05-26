# Quickstart: Fix double-space in `formatTierLimitError`

**Feature**: 728-symptom-cli-s-resolver
**Phase**: 1 (Validation)

## Prerequisites

- Repository checked out on branch `728-symptom-cli-s-resolver`.
- `pnpm install` already run at the repo root.
- Node ≥22.

## What This Fix Does

Changes `formatTierLimitError` in `packages/activation-client` so that when `tier` is the empty string, the output reads

```
Worker count of 5 exceeds your plan limit of 2. Upgrade your plan or retry with --workers=2.
```

instead of the buggy

```
Worker count of 5 exceeds your  plan limit of 2. Upgrade your plan or retry with --workers=2.
                                ^^ two spaces
```

No call-site changes; non-empty tier rendering (e.g. `'basic'` → `'Basic'`) is unchanged.

## Files Changed

| Path | Change |
|------|--------|
| `packages/activation-client/src/format-tier-limit-error.ts` | Wrap tier title-casing in a `tier ? ... : 'plan'` ternary; restructure template literal so the qualifier is a pre-built local. |
| `packages/activation-client/tests/unit/format-tier-limit-error.test.ts` | Update the existing `'handles empty tier (degenerate, degrades acceptably)'` assertion to the new well-formed output. Optionally add a regression test that asserts the output contains no `'  '` substring. |

## How to Validate Locally

### 1. Run the unit tests (fastest signal)

```bash
pnpm --filter @generacy-ai/activation-client test
```

Expected: all tests in `format-tier-limit-error.test.ts` pass — including the updated empty-tier assertion.

### 2. Type-check the workspace

```bash
pnpm -w typecheck
```

Expected: clean. The function signature is unchanged so no callers should break.

### 3. End-to-end (optional, requires Basic-tier org credentials)

```bash
# Against an org with tierCap=2:
npx generacy launch --workers=5
```

Expected stderr contains the message body once — with no `your  plan` (double-space) substring. A quick grep:

```bash
npx generacy launch --workers=5 2>&1 | grep -c 'your  plan'
# Expect: 0
```

## Available Commands (no new commands added)

This feature does not introduce any new CLI commands or APIs. It only changes the message body emitted by existing flows:

| Flow | Trigger | Touched by this fix? |
|------|---------|----------------------|
| `npx generacy launch --workers=N` (resolver-side gate) | `--workers > tierCap` | **Yes** (this is the path that produced the double-space) |
| `npx generacy deploy ...` (poll-time gate) | Cloud returns `tier-limit-exceeded` | No behavioral change (tier name is non-empty in this path) |
| Orchestrator activation (poll-time gate) | Cloud returns `tier-limit-exceeded` | No behavioral change |

## Troubleshooting

**"My empty-tier test still asserts `'your  plan'` (two spaces) and is failing."**
That's expected before you apply the test update. Spec FR-003 calls this out: the existing test currently codifies the buggy output and must be updated to the well-formed output as part of the fix.

**"I changed the formatter but the resolver still shows two spaces."**
Check that you rebuilt / that the dev loop picks up changes in `packages/activation-client`. `pnpm --filter @generacy-ai/activation-client build` (if applicable) and rerun the consumer.

**"Should I also add a `tier` field to `launch-config`?"**
No — that's an explicit out-of-scope item (spec § Out of Scope). It's tracked as a sibling of `generacy-cloud#699`. The resolver continuing to pass `tier: ''` is by design for this fix.

**"What about defending against `null`/`undefined` tier?"**
The TypeScript type is `tier: string` and that doesn't change. The runtime check (`tier ? ... : ...`) naturally handles them as a side benefit, but `TierLimitErrorInput` callers are still expected to pass a string.
