# Contract: speckit-bugfix `implementation-review` gate under `ciMergeGateEnabled` (Corner 3)

**File**: `packages/orchestrator/src/worker/config.ts` (read-only — **no production
change**). The #1133 relocation transform at `:229-247` already produces the
intended behavior; this contract pins it with a test (D3=A / FR-005 / FR-006).

## Expected gate set

Given the default `speckit-bugfix` gates (`config.ts:217-223`), the
`implementation-review` gate resolves as:

| `ciMergeGateEnabled` | speckit-bugfix `implementation-review` gate                                                            |
|----------------------|--------------------------------------------------------------------------------------------------------|
| `false`              | `{ phase: 'implement', gateLabel: 'waiting-for:implementation-review', condition: 'on-request' }`       |
| `true`               | `{ phase: 'validate', gateLabel: 'waiting-for:implementation-review', condition: 'on-ci-green' }`       |

The transform matches on `gateLabel === 'waiting-for:implementation-review'` only
(uniformly label-based), so speckit-bugfix is rewritten by the same rule as
speckit-feature. This is intentional: `ciMergeGateEnabled` is opt-in and its
purpose is a post-validate CI-green merge checkpoint; excluding bugfix would let it
merge with no checkpoint exactly when the operator asked for one.

## Invariants

- **INV-1**: With `ciMergeGateEnabled === true`, speckit-bugfix carries a
  `{ phase: 'validate', condition: 'on-ci-green' }` `implementation-review` gate.
- **INV-2**: With `ciMergeGateEnabled === false`, speckit-bugfix's
  `implementation-review` gate is unchanged (`{ phase: 'implement', condition:
  'on-request' }`) — byte-identical to today (SC-006 / FR-009).
- **INV-3**: Other speckit-bugfix gates (clarification, merge-conflicts,
  remediation-limit) are unaffected by the flag.

## Test assertions (FR-006)

Parse `WorkerConfigSchema` with `ciMergeGateEnabled: false` and again with `true`
(otherwise-default config) and assert the speckit-bugfix `implementation-review`
gate matches the table above under each flag state.
