# Research: Remove hardcoded 999 cap in createFeature()

## `String.padStart()` Behavior

`String(1004).padStart(3, '0')` returns `'1004'` — padStart only adds characters when the string is shorter than the target length. For numbers >= 1000 (4+ digits), it returns the number as-is. This confirms the cap is unnecessary for branch-name correctness.

## Failure Return Paths Audit

Three failure paths in `createFeature()` currently lack `error` fields:

| Line | Condition | Current | Fix |
|------|-----------|---------|-----|
| 279-287 | `repoRoot` not found | No `error` | Add `error: 'Could not find repository root'` |
| 300-309 | `featureNumInt > 999` | No `error` | Remove entire block |
| 317-326 | Branch name fails regex | No `error` | Add `error: \`Invalid branch name: ${branchName}\`` |

Two failure paths already have `error` fields:
- Line 373-381 (resume path branch mismatch): Has `error: 'Branch checkout failed: ...'`
- Line 474-483 (new path branch mismatch): Has `error: 'Branch checkout failed: ...'`

## Downstream Impact

The orchestrator at `claude-cli-worker.ts:296` uses `featureResult.error ?? 'unknown error'`. Once all failure paths populate `error`, the fallback to `'unknown error'` will never trigger — but no orchestrator changes are needed.

## No Downstream 3-Digit Assumption

Searched for consumers of `feature_num` — it's used only in the return value and for directory naming. No code assumes exactly 3 digits or <= 999.
