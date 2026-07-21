# Data Model

Additive-only type changes. No shape change to `ParsedEpicBody`, `ParsedPhase`, or `IssueRef`. One new interface exported.

## New: `ParseEpicBodyOptions`

Location: `packages/cockpit/src/resolver/types.ts` (new export).
Re-exported from: `packages/cockpit/src/index.ts` (new export line).

```typescript
/**
 * Options for `parseEpicBody`. All fields are optional; passing no options
 * (or an empty object) is equivalent to calling `parseEpicBody(body)`.
 */
export interface ParseEpicBodyOptions {
  /**
   * Canonical `"owner/repo"` string. When set, a bare `#N` ref inside a
   * task-list checkbox item (`- [ ] #N` / `- [x] #N`) is accepted and
   * resolved to `<defaultRepo>#N`. Bare refs outside checkbox items
   * remain unaffected. When absent (or undefined), the parser rejects
   * bare refs with the existing #826 warning.
   *
   * Validation: MUST match `/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/`.
   * Malformed input is treated as if the option were absent, and a
   * warning is emitted (marker substring: `invalid defaultRepo`).
   */
  defaultRepo?: string;
}
```

### Validation rules

| Field | Rule | Failure behavior |
|-------|------|------------------|
| `defaultRepo` | Type: `string`. Pattern: `/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/`. | On mismatch: push warning `cockpit: parseEpicBody: invalid defaultRepo '<raw>' (invalid defaultRepo)`; treat as if unset. Never throw. |
| `defaultRepo` | Presence: optional. | Absence → identical behavior to today (FR-005). |
| `options` bag itself | Optional. | `parseEpicBody(body)` and `parseEpicBody(body, undefined)` behave identically. |

## Modified: `parseEpicBody` signature

```typescript
// Before (packages/cockpit/src/resolver/parse-epic-body.ts:64)
export function parseEpicBody(body: string): ParsedEpicBody

// After
export function parseEpicBody(
  body: string,
  options?: ParseEpicBodyOptions,
): ParsedEpicBody
```

Backwards-compatible: existing callers compile without change; TypeScript narrows to today's signature when `options` is omitted.

## Unchanged interfaces

- `IssueRef` (`resolver/types.ts:6-9`) — no fields added, no fields renamed.
- `ParsedPhase` (`resolver/types.ts:11-18`) — no fields added.
- `ParsedEpicBody` (`resolver/types.ts:20-34`) — `warnings[]` is the sole degradation channel (per spec §Out of Scope: no richer `defaultedRefs[]` / `degradation.kind` fields).
- `ResolvedEpic` (`resolver/types.ts:36-44`) — no changes.
- `ResolveEpicOptions` (`resolver/types.ts:46-51`) — no changes (`resolveEpic` derives `defaultRepo` from `epicRef` internally, does not accept it from caller).

## Warning taxonomy additions

`warnings[]` continues to carry human-readable strings, each containing exactly one stable marker substring (per #826 convention). Two new markers introduced by this PR:

| Marker substring | When emitted | FR |
|------------------|--------------|-----|
| `invalid defaultRepo` | `parseEpicBody` called with a malformed `defaultRepo` option value. Exactly one warning per call. | FR-003 |
| `mixed phase heading levels` | Body contains BOTH `###`-shaped phase headings AND phase-shaped `####` headings. Exactly one warning per call regardless of count. | FR-012 |

Existing markers preserved unchanged: `bare '#N'`, `titled but not ref-shaped`, `URL path not /(issues|pull)/N`, `phase headers must be '###'`.

## Relationships

```
ResolveEpicOptions
    │  (options.epicRef → parseEpicRef → epic: IssueRef)
    ▼
resolveEpic
    │  (calls parseEpicBody with { defaultRepo: epic.repo })
    ▼
ParseEpicBodyOptions ─────► parseEpicBody ─────► ParsedEpicBody
                                │                    │
                                │                    ├── phases: ParsedPhase[]
                                │                    ├── adhocRefs: IssueRef[]
                                │                    ├── allRefs: IssueRef[]
                                │                    └── warnings: string[]
                                │
                                └── (bare #N in TASK_LIST_RE line
                                     AND defaultRepo set
                                     AND parseRef(refToken) === null
                                     AND BARE_HASH_N_RE.test(refToken))
                                        → synthesize { repo: defaultRepo, number: N }
```

## Notes for direct callers

- Any consumer of `@generacy-ai/cockpit`'s `parseEpicBody` that passes a body without options continues to receive identical output (FR-005, SC-005).
- Consumers who *want* the bare-`#N` fallback but do not use `resolveEpic` must pass `{ defaultRepo: '<owner>/<repo>' }` explicitly. `defaultRepo` cannot be inferred by the parser.
