# Quickstart: Verify the #841 classifier fix

**Feature**: #841 | **Branch**: `841-found-during-cockpit-v1`

## Prerequisites

- Node ≥ 22, pnpm installed
- Repo checked out at `/workspaces/generacy`
- On branch `841-found-during-cockpit-v1`

## Install / build

```bash
pnpm install
pnpm --filter @generacy-ai/cockpit build
```

## Run the unit tests

```bash
# Full cockpit test suite (SC-005 gate)
pnpm --filter @generacy-ai/cockpit test

# Just the classifier regression tests
pnpm --filter @generacy-ai/cockpit test -- classifier
```

**Expected**: all cases green, including the three FR-007 / FR-008 / FR-009 regression cases.

## Typecheck

```bash
pnpm --filter @generacy-ai/cockpit typecheck
```

**Expected**: no errors. The widened `CockpitState` union propagates through the `Record<CockpitState, number>` on `TIER_RANK` — if a key is missing, the compiler will surface it here.

## Manual verification against a live smoke-test repo (SC-004)

Once merged into the cluster running the smoke test (from `generacy-ai/tetrad-development#88`):

```bash
generacy cockpit status --repo christrudelpw/sniplink --issue 2
generacy cockpit status --repo christrudelpw/sniplink --issue 3
generacy cockpit status --repo christrudelpw/sniplink --issue 4
```

**Expected**: all three issues render under the **waiting** bucket (source label `waiting-for:clarification`), not `terminal`. Live label set on those issues is `{completed:specify, waiting-for:clarification, agent:in-progress, agent:paused}`.

If a broader dashboard command exists:

```bash
generacy cockpit status --repo christrudelpw/sniplink
```

**Expected**: the three issues appear in the actionable / waiting list; no "nothing to do" surprise.

## What "success" looks like

| Signal                                                                                              | Where                                          |
|-----------------------------------------------------------------------------------------------------|------------------------------------------------|
| `packages/cockpit` vitest suite green, including new FR-007/8/9 cases                               | `pnpm --filter @generacy-ai/cockpit test`      |
| Typecheck clean                                                                                     | `pnpm --filter @generacy-ai/cockpit typecheck` |
| `christrudelpw/sniplink#2,3,4` render in the `waiting` bucket of `cockpit status`, not `terminal`   | manual smoke test, per SC-004                  |
| The #839 startup sweep still detects the same "issue waiting on developer" set                      | inspect / rerun orchestrator startup logs      |
| No consumer of `classify()` regresses                                                               | full `packages/cockpit` suite green            |

## Troubleshooting

- **`Property 'stage-complete' is missing in type ...`** on `TIER_RANK` — you added the union member but forgot the map entry. Add `'stage-complete': 5` and shift `unknown` to `6`.
- **`completed:validate` classifies as `stage-complete`** — you edited the pattern but forgot to consult `TERMINAL_COMPLETED_LABELS`. Ensure the `startsWith('completed:')` branch checks membership *first* and only falls through to `'stage-complete'` when the label is not in the terminal set.
- **`{completed:specify, completed:plan}` picks `completed:specify` as `sourceLabel`** — your `STAGE_COMPLETE_PIPELINE_ORDER` is reversed. Latest phase (`completed:plan`) MUST come **earlier** in the array (lower index wins).
- **Exhaustive-switch TS errors elsewhere in the repo** — expected in downstream consumers. Add `case 'stage-complete':` arms as needed. Not blocking for this PR (the change is source-compatible; strict `assertNever` sites need the arm).
- **`cockpit status` renders a bucket with no heading for `stage-complete`** — expected. Bucket rendering is a cosmetic follow-up; not in scope for #841.

## Rollback

Revert the single commit on `841-found-during-cockpit-v1`. The change is contained in five files (`types.ts`, `state/label-map.ts`, `state/precedence.ts`, `state/classifier.ts`, `__tests__/classifier.test.ts`) with no config or dependency churn — clean rollback.
