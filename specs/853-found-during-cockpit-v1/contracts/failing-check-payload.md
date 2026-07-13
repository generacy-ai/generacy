# Contract: `FailingCheckPayload` schema delta (updated for #853)

**Schema file**: `specs/789-epic-generacy-ai-tetrad/contracts/failing-check.schema.json`
**Type file**: `packages/generacy/src/cli/commands/cockpit/shared/failing-check-json.ts`
**Delta reason**: `runMerge` now includes the linked issue's ref (and, on the CLOSED-issue branch, `state` / `stateReason`) in every red payload. Existing `pr` / `reason` / `failingChecks` shapes are byte-stable.

## Payload shape (post-#853)

```jsonc
{
  "status": "red",
  "reason": "unresolved" | "missing-label" | "checks-failing",
  "pr":     { "number": 42, "url": "https://github.com/o/r/pull/42" } | null,
  "failingChecks": [ { "name": "ci/test", "state": "FAILURE", "url": "https://..." } ],
  "issue": {                            // ← NEW; present on every red payload after this PR
    "owner":  "o",
    "repo":   "r",
    "number": 7,
    "state":       "CLOSED",             // ← present ONLY on the CLOSED-issue red branch
    "stateReason": "completed" | null    // ← present ONLY on the CLOSED-issue red branch; null when gh doesn't surface a reason
  }
}
```

Green path: exit 0, empty stdout — no payload emitted.

## Schema-file diff (`failing-check.schema.json`)

Two changes, both additive:

### 1. `additionalProperties: false` → allow the new `issue` property

**Before**:
```json
"required": ["status", "reason", "pr", "failingChecks"],
"additionalProperties": false,
"properties": { "status": {...}, "reason": {...}, "pr": {...}, "failingChecks": {...} }
```

**After**:
```json
"required": ["status", "reason", "pr", "failingChecks"],
"additionalProperties": false,
"properties": {
  "status": {...},
  "reason": {...},
  "pr": {...},
  "failingChecks": {...},
  "issue": { "$ref": "#/$defs/IssueRefWithState" }   // ← NEW property; still under additionalProperties:false
}
```

- `issue` is NOT added to `required` — it's optional at the schema level. `runMerge` always populates it after #853, but a schema-compliant payload without `issue` remains valid (preserves compatibility for any consumer that hand-crafts payloads today, e.g. mocks in downstream test suites).

### 2. New `$defs.IssueRefWithState` block

```json
"$defs": {
  "IssueRefWithState": {
    "type": "object",
    "required": ["owner", "repo", "number"],
    "additionalProperties": false,
    "properties": {
      "owner":  { "type": "string", "minLength": 1 },
      "repo":   { "type": "string", "minLength": 1 },
      "number": { "type": "integer", "minimum": 1 },
      "state":       { "type": "string", "enum": ["OPEN", "CLOSED"] },
      "stateReason": { "type": ["string", "null"] }
    }
  }
}
```

- `state` and `stateReason` are optional at the schema level (only `owner`/`repo`/`number` are `required`). The CLI populates them only on the CLOSED-issue red branch (see contract I-3 in `merge-command.md`).
- `stateReason` accepts either `string` or `null` — matches the wrapper's `null` default when gh returns no `state_reason` field.

### 3. `allOf` conditional block — unchanged

The existing `allOf` block (which enforces `pr` non-null on `missing-label`/`checks-failing` and `failingChecks` cardinality per reason) is UNTOUCHED. No new conditional for the `issue` field — its presence is caller-driven, not reason-derived.

## Non-changes (deliberate)

- **`reason` enum** — stays `["checks-failing", "missing-label", "unresolved"]`. Q2→B (issue-fetch failure) and Q3→A (CLOSED-issue) both fold into the existing `unresolved` reason.
- **`pr` field** — non-null on `missing-label` / `checks-failing`, nullable on `unresolved`. This invariant is what Q1→B was designed to preserve.
- **`failingChecks` field** — non-empty ONLY on `checks-failing`; empty on `missing-label` / `unresolved`. Unchanged.
- **`status` field** — always the literal `"red"`. Green path emits no stdout.

## Consumer contract

Existing consumers of the payload (cockpit plugin `merge.md` decision table, ajv-compiled validators in test suites) parse only the required fields. The `additionalProperties: false` relaxation is scoped to admit `issue` — no other unknown properties are permitted. Consumers that want to render the new `issue` field opt in by reading it; consumers that don't need it continue to ignore it.

## Test rig

`packages/generacy/src/cli/commands/cockpit/__tests__/merge.test.ts` compiles the schema via ajv 2020 with `strict: false, allErrors: true` and asserts `validate(payload)` returns `true` for every emitted payload. Post-#853 tests assert both schema validity AND presence of the `issue` field on each red branch (see `merge-command.md` Test Signals for the specific SC-001..SC-005 rows).

## Rollback

Reverting this PR:
1. Delete the `issue` property from `properties` in the schema.
2. Delete the `$defs.IssueRefWithState` block.
3. Revert `FailingCheckPayload` / `BuildFailingCheckInput` to their pre-#853 shape in `failing-check-json.ts`.
4. Revert `merge.ts` label source, CLOSED-issue guard, and issue-fetch try/catch.
5. Revert `wrapper.ts` `IssueStateResult` / `IssueStateRawSchema` / `fetchIssueState` gh args.

No data migration; no relay-payload change. Downstream cockpit-plugin consumers that read `issue` after adopting the field must ignore it (they should already, per additive convention).
