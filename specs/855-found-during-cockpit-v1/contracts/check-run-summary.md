# Contract: `CheckRunSummary` (post-#855)

**Module**: `packages/cockpit/src/gh/wrapper.ts`
**Type**: `CheckRunSummary` (interface, exported)
**Delta reason**: `conclusion` was a dead-on-arrival passthrough; gh's client-side `--json` validator has always rejected it, so the field has never carried data. Q1→B drops the passthrough. `url` stays the outward field name (Q5→A); wrapper maps from gh's `raw.link`.

## Shape

```ts
export interface CheckRunSummary {
  name: string;
  state: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NEUTRAL' | 'SKIPPED' | 'CANCELLED';
  url?: string;
}
```

## Field semantics

| Field  | Source                                    | Nullability | Notes |
|--------|-------------------------------------------|-------------|-------|
| `name` | `gh pr checks --json name` — `.name`      | Required    | The check-run name (e.g., `ci/test`, `lint`). |
| `state`| `normalizeCheckState({raw.state, raw.bucket, raw.status})` | Required | Normalized rollup. See vocabulary below. |
| `url`  | `raw.link` (nullable-optional in gh)      | Optional    | gh's `link` field, renamed to `url` at the wrapper boundary. Consumers read `.url`. |

## `state` vocabulary

```
SUCCESS   — the check-run passed. Source: gh state=SUCCESS, bucket=pass.
FAILURE   — the check-run failed hard. Source: gh state=FAILURE, bucket=fail.
PENDING   — the check-run is in progress, queued, or not yet reported. Source: gh state=PENDING/IN_PROGRESS/QUEUED, bucket=pending.
NEUTRAL   — the check-run neither passed nor failed (e.g., "neutral" conclusion on GitHub Actions). Source: gh state=NEUTRAL only; bucket has no `neutral` value.
SKIPPED   — the check-run was skipped (conditional not met, etc.). Source: gh state=SKIPPED, bucket=skipping.
CANCELLED — the check-run was cancelled (workflow cancelled, run superseded). Source: gh state=CANCELLED/CANCELED, bucket=cancel.
```

Precedence in `normalizeCheckState`: `raw.state ?? raw.bucket ?? raw.status`. When both `state` and `bucket` are present (which the fixed `--json` field list guarantees), `state` wins. `bucket` is a defensive fallback for gh versions or code paths where `state` might be absent.

## Consumer read map (verified 2026-07-08)

| Consumer file                                                                                | Reads             |
|----------------------------------------------------------------------------------------------|-------------------|
| `packages/generacy/src/cli/commands/cockpit/shared/required-checks.ts:52,62`                 | `.name`, `.state`, `.url` |
| `packages/generacy/src/cli/commands/cockpit/shared/review-context-json.ts:53–58` (post-fix)  | `.name`, `.state`, `.url` |
| `packages/generacy/src/cli/commands/cockpit/watch/check-rollup.ts:9–24`                      | `.state` only     |

No consumer reads `.conclusion`. No consumer reads `.bucket`. Both are wrapper-internal (or deleted).

## Backwards-compat impact

**Source-compatible with all existing consumers.** No production code reads `.conclusion` today (verified via grep). The only emit site (`review-context-json.ts`) is updated in the same PR.

Test fixtures that populate `conclusion` in a `CheckRunSummary` return shape (e.g., `helpers/fake-gh.ts`, `merge.test.ts` `getPullRequestCheckRuns` arrays) will TypeScript-error post-fix. Cleanup is mechanical: drop the field from the object literals.

Downstream cockpit-plugin consumers (out-of-repo) that parse `review-context.json` and read `.checks[].conclusion` will silently see `undefined` — as they always have, because gh never populated it. Removing the field emission is a no-op for them.

## Non-changes

- **`url` field name preserved** (Q5→A). Not renamed to `link` even though gh's raw field is `link`. Wrapper vocabulary translation.
- **`bucket` not on outward interface** (Q1→B). Wrapper-internal only.
- **State vocabulary** unchanged. Six values, same as before.
