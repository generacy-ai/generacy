# Contract: `FailingCheckPayload` extension

**Feature**: #904
**Files**:
- `packages/generacy/src/cli/commands/cockpit/shared/failing-check-json.ts` (TypeScript source)
- `specs/789-epic-generacy-ai-tetrad/contracts/failing-check.schema.json` (JSON Schema — additive edit)

---

## What changes

Two new `reason` enum values, one new optional field on `pr`, two new optional top-level fields (`linkMethod`, `candidates`).

### `RedReason` enum

**Before**: `'checks-failing' | 'missing-label' | 'unresolved'`

**After**: `'checks-failing' | 'missing-label' | 'unresolved' | 'pr-is-draft' | 'ambiguous-resolution'`

- `'pr-is-draft'` — the resolver only found draft PR(s) at whatever tier stopped fall-through. Single-candidate and multi-candidate cases fold into this one variant (clarification Q3-C).
- `'ambiguous-resolution'` — the resolver found ≥2 open non-draft candidates at whatever tier stopped fall-through. The tier is named in `linkMethod`.

### `pr` field

**Before**: `pr: { number: number; url: string } | null`

**After**: `pr: { number: number; url: string; linkMethod?: LinkMethod } | null`

- On the resolved-single-PR reasons (`missing-label`, `checks-failing`), `linkMethod` is required-at-runtime (see I-9 in `data-model.md`).
- On `unresolved` — permissive: `pr` may still be `{ number, url }` without `linkMethod` for the pre-existing "PR found but state != 'OPEN'" path in `merge.ts:99-113`.
- On the multi-candidate reasons (`pr-is-draft`, `ambiguous-resolution`), `pr` is always `null`; the PR set lives on top-level `candidates` instead.

### New top-level `linkMethod`

**New** — optional field on `FailingCheckPayload`:

```ts
linkMethod?: LinkMethod;  // 'closing-refs' | 'branch-name' | 'pr-body'
```

Present ONLY when `reason ∈ { 'pr-is-draft', 'ambiguous-resolution' }`. Absent for the other three reasons.

### New top-level `candidates`

**New** — optional array on `FailingCheckPayload`:

```ts
candidates?: Array<{ number: number; url: string; isDraft: boolean; headRefName: string }>;
```

Present ONLY when `reason ∈ { 'pr-is-draft', 'ambiguous-resolution' }`. Absent for the other three reasons.

Fields carry:
- `number` — PR number.
- `url` — PR URL.
- `isDraft` — the resolver's `draft` field verbatim. Redundant given the reason, but explicit is easier to read in `jq` and grep.
- `headRefName` — the head branch. Load-bearing when the ambiguity is at Tier 2 (branch-name); still nice-to-have at other tiers.

---

## Full post-change type

```ts
export type LinkMethod = 'closing-refs' | 'branch-name' | 'pr-body';

export type RedReason =
  | 'checks-failing'
  | 'missing-label'
  | 'unresolved'
  | 'pr-is-draft'
  | 'ambiguous-resolution';

export interface PrCandidate {
  number: number;
  url: string;
  isDraft: boolean;
  headRefName: string;
}

export interface FailingCheckPayload {
  status: 'red';
  reason: RedReason;
  pr: { number: number; url: string; linkMethod?: LinkMethod } | null;
  candidates?: PrCandidate[];
  linkMethod?: LinkMethod;
  failingChecks: FailingCheck[];
  issue?: IssueRefWithState;
}
```

---

## Per-reason invariants (runtime, in `buildFailingCheckPayload`)

Copied from `data-model.md` §"Payload invariants (per reason)" for local reference:

| reason                | `pr`                                            | top `linkMethod` | `candidates`         | `failingChecks` |
|-----------------------|-------------------------------------------------|-------------------|----------------------|-----------------|
| `unresolved`          | `null` OR `{ number, url }` (no `linkMethod`)   | absent            | absent               | `[]`            |
| `missing-label`       | `{ number, url, linkMethod }` — non-null        | absent            | absent               | `[]`            |
| `checks-failing`      | `{ number, url, linkMethod }` — non-null        | absent            | absent               | `≥1`            |
| `pr-is-draft`         | `null`                                          | required          | `≥1` (all draft)     | `[]`            |
| `ambiguous-resolution`| `null`                                          | required          | `≥2` (all non-draft) | `[]`            |

Enforcement: `buildFailingCheckPayload` throws `Error("FailingCheckPayload invariant I-<n>: <detail>")` on any violation. Test coverage: one per invariant in `packages/generacy/src/cli/commands/cockpit/__tests__/failing-check-json.test.ts`.

---

## JSON Schema — additive edits

Reference file: `specs/789-epic-generacy-ai-tetrad/contracts/failing-check.schema.json`.

### 1. `reason` enum

```diff
- "enum": ["checks-failing", "missing-label", "unresolved"]
+ "enum": ["checks-failing", "missing-label", "unresolved", "pr-is-draft", "ambiguous-resolution"]
```

### 2. `pr` `oneOf` — third variant with `linkMethod`

```json
{
  "pr": {
    "oneOf": [
      { "type": "null" },
      {
        "type": "object",
        "required": ["number", "url"],
        "additionalProperties": false,
        "properties": {
          "number": { "type": "integer", "minimum": 1 },
          "url":    { "type": "string", "format": "uri" }
        }
      },
      {
        "type": "object",
        "required": ["number", "url", "linkMethod"],
        "additionalProperties": false,
        "properties": {
          "number":     { "type": "integer", "minimum": 1 },
          "url":        { "type": "string", "format": "uri" },
          "linkMethod": { "enum": ["closing-refs", "branch-name", "pr-body"] }
        }
      }
    ]
  }
}
```

### 3. New top-level `linkMethod` + `candidates`

```json
{
  "properties": {
    "linkMethod": {
      "type": "string",
      "enum": ["closing-refs", "branch-name", "pr-body"],
      "description": "Present only when reason ∈ { pr-is-draft, ambiguous-resolution }."
    },
    "candidates": {
      "type": "array",
      "description": "Present only when reason ∈ { pr-is-draft, ambiguous-resolution }.",
      "items": {
        "type": "object",
        "required": ["number", "url", "isDraft", "headRefName"],
        "additionalProperties": false,
        "properties": {
          "number":      { "type": "integer", "minimum": 1 },
          "url":         { "type": "string", "format": "uri" },
          "isDraft":     { "type": "boolean" },
          "headRefName": { "type": "string", "minLength": 1 }
        }
      }
    }
  }
}
```

### 4. Two new `allOf` if/then clauses

```json
[
  {
    "if": { "properties": { "reason": { "const": "pr-is-draft" } } },
    "then": {
      "required": ["candidates", "linkMethod"],
      "properties": {
        "pr":         { "type": "null" },
        "candidates": { "minItems": 1, "items": { "properties": { "isDraft": { "const": true } } } },
        "failingChecks": { "maxItems": 0 }
      }
    }
  },
  {
    "if": { "properties": { "reason": { "const": "ambiguous-resolution" } } },
    "then": {
      "required": ["candidates", "linkMethod"],
      "properties": {
        "pr":         { "type": "null" },
        "candidates": { "minItems": 2, "items": { "properties": { "isDraft": { "const": false } } } },
        "failingChecks": { "maxItems": 0 }
      }
    }
  }
]
```

Existing `checks-failing`, `missing-label`, `unresolved` clauses unchanged. `additionalProperties: false` on the root object drops to `true` (or omitted) to permit the two new top-level fields — verify by rerunning the ajv validator in `merge.test.ts:26-27` against a green-path fixture and any existing red-path fixtures.

---

## Sample payloads (jq-friendly)

### `resolved` (green — no payload emitted)

The green merge path does NOT emit a JSON payload — it prints human copy (`'merged and branch deleted\n'`, etc.). The `resolved PR #N via <linkMethod>` log line is a `logger.info` structured log, not stdout JSON. Consumers reading merge outcomes still discover the resolution via the log.

### `pr-is-draft` (single candidate — the sniplink single-PR case)

```json
{
  "status": "red",
  "reason": "pr-is-draft",
  "pr": null,
  "linkMethod": "pr-body",
  "candidates": [
    { "number": 22, "url": "https://github.com/owner/sniplink/pull/22", "isDraft": true, "headRefName": "011-p3-phase" }
  ],
  "failingChecks": [],
  "issue": { "owner": "owner", "repo": "sniplink", "number": 9 }
}
```

### `pr-is-draft` (multi-candidate — the sniplink multi-PR case)

```json
{
  "status": "red",
  "reason": "pr-is-draft",
  "pr": null,
  "linkMethod": "pr-body",
  "candidates": [
    { "number": 22, "url": "https://github.com/owner/sniplink/pull/22", "isDraft": true, "headRefName": "011-…" },
    { "number": 24, "url": "https://github.com/owner/sniplink/pull/24", "isDraft": true, "headRefName": "013-…" },
    { "number": 25, "url": "https://github.com/owner/sniplink/pull/25", "isDraft": true, "headRefName": "012-…" }
  ],
  "failingChecks": [],
  "issue": { "owner": "owner", "repo": "sniplink", "number": 9 }
}
```

### `ambiguous-resolution` (branch-name tier)

```json
{
  "status": "red",
  "reason": "ambiguous-resolution",
  "pr": null,
  "linkMethod": "branch-name",
  "candidates": [
    { "number": 42, "url": "…", "isDraft": false, "headRefName": "9-first-try" },
    { "number": 47, "url": "…", "isDraft": false, "headRefName": "9-do-it-properly" }
  ],
  "failingChecks": [],
  "issue": { "owner": "owner", "repo": "repo", "number": 9 }
}
```

### `missing-label` (post-change — now carries `linkMethod`)

```json
{
  "status": "red",
  "reason": "missing-label",
  "pr": { "number": 23, "url": "…", "linkMethod": "closing-refs" },
  "failingChecks": [],
  "issue": { "owner": "owner", "repo": "sniplink", "number": 9 }
}
```

### `checks-failing` (post-change — now carries `linkMethod`)

```json
{
  "status": "red",
  "reason": "checks-failing",
  "pr": { "number": 23, "url": "…", "linkMethod": "closing-refs" },
  "failingChecks": [
    { "name": "vitest", "state": "FAILURE" }
  ],
  "issue": { "owner": "owner", "repo": "sniplink", "number": 9 }
}
```

### `unresolved` (no change from today)

```json
{
  "status": "red",
  "reason": "unresolved",
  "pr": null,
  "failingChecks": [],
  "issue": { "owner": "owner", "repo": "repo", "number": 9 }
}
```

---

## Consumer contracts

- **`tetrad-development` auto-mode finding recorder** (external consumer): reads `reason` and `linkMethod` off the payload directly (spec §Assumptions #5). The two new enum values are additive; existing consumers of `'unresolved' | 'missing-label' | 'checks-failing'` don't break. If the recorder sees an unfamiliar `reason`, existing "unknown reason" handling paths run.
- **`merge.test.ts` ajv validator**: recompiled against the extended schema. New tests round-trip each of the five reasons.
- **Snapshot tests in `merge.test.ts`** (per SC-004): snapshot the stdout JSON per red-reason path; snapshot the `logger.info` argument on the green path.
