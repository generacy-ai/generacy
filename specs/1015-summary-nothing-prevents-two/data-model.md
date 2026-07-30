# Data Model: Active-driver claim per cockpit scope

**Feature**: #1015 | **Branch**: `1015-summary-nothing-prevents-two`

Types are declared in TypeScript with Zod schemas as the runtime source of truth. Wire boundaries (MCP tool inputs, GitHub comment JSON body) always parse through the Zod schema before use.

## Entities

### `ClaimPayload` (source of truth — stored inside the GitHub comment marker)

```ts
export interface ClaimPayload {
  /** Marker format version; currently 1. */
  version: 1;
  /** Opaque per-MCP-server-process identifier. Skill supplies INSTANCE_NONCE. */
  sessionId: string;
  /** ISO-8601 UTC. Original acquire time; unchanged by heartbeat refresh. */
  heldSince: string;
  /** ISO-8601 UTC. Updated on every heartbeat/refresh. */
  heartbeatAt: string;
  /** Relative path to the session's ledger, e.g. `.generacy/cockpit/auto-runs/<slug>-<ts>.ledger`. */
  ledger: string;
  /** Scope ref as `<owner>/<repo>#<n>`. Redundant with issue URL but aids operator debugging. */
  scope: string;
}
```

**Validation** (`packages/generacy/src/cli/commands/cockpit/mcp/claim/payload.ts`):

```ts
export const ClaimPayloadSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().regex(/^[a-f0-9]{16,64}$/, {
      message: 'sessionId must be 16-64 hex chars',
    }),
    heldSince: z.string().datetime({ offset: true }),
    heartbeatAt: z.string().datetime({ offset: true }),
    ledger: z.string().min(1).max(512),
    scope: z.string().regex(/^[^/\s]+\/[^/\s#]+#\d+$/, {
      message: 'scope must be "<owner>/<repo>#<n>"',
    }),
  })
  .strict();
```

**Rules**:
- `sessionId` is opaque to the claim mechanism (no interpretation). Uniqueness across sessions is a caller responsibility.
- `heartbeatAt` is compared against server-local clock; skew tolerance is baked into the 10-minute threshold.
- `ledger` is stored as-is; the claim mechanism never opens or validates the path.
- `scope` is written on acquire, never mutated.

---

### `ClaimMarker` (wire form — stored as a comment body)

The full comment body has fixed leading fence + fenced JSON block:

```
<!-- cockpit:claim v1 -->
```json
{ ...ClaimPayload... }
```
```

**Format contract** (`packages/generacy/src/cli/commands/cockpit/mcp/claim/marker.ts`):

- **Detection**: comment body starts with the literal string `<!-- cockpit:claim v1 -->` (case-sensitive). Any comment not matching this prefix is not a claim marker; skip.
- **Parse**: extract the ```` ```json ```` fenced block; `JSON.parse`; validate against `ClaimPayloadSchema`. On parse or validate failure, treat as a stale/corrupt marker and delete during discovery (best-effort).
- **Format**: build a `ClaimPayload`, `JSON.stringify(payload, null, 2)`, wrap in the fixed fence.

**Rules**:
- A comment body may contain **only** the marker — no other content. This makes edit-in-place safe (`editIssueComment` overwrites the whole body).
- Version bumps (v2+) would require a distinct marker fence (`<!-- cockpit:claim v2 -->`) and a discovery-side compatibility branch. Out of scope here.

---

### `LiveClaim` (in-memory, from discovery)

```ts
export interface LiveClaim {
  /** Parsed marker payload from the winning comment. */
  payload: ClaimPayload;
  /** REST API numeric id of the comment holding the marker. Needed for edit/delete. */
  commentId: number;
  /** URL of the comment. Included in refusal payloads for operator convenience. */
  commentUrl: string;
}

export type DiscoverResult =
  | { kind: 'no-claim' }
  | { kind: 'held'; live: LiveClaim; orphanedLabelPresent: boolean }
  | { kind: 'held'; live: LiveClaim; orphanedLabelPresent: false };
```

**Rules** (see `research.md` R-9):
- `no-claim` when zero live payloads are found — the caller MUST NOT be blocked by a `cockpit:claimed` label with no live comment (FR-003).
- On multiple live payloads, oldest `heldSince` wins; younger duplicates are deleted during discovery (best-effort).

---

### `RefusalPayload` (returned inside `class: 'claim-conflict'` errors)

```ts
export interface RefusalPayload {
  status: 'error';
  class: 'claim-conflict';
  detail: string;                    // human-readable summary
  hint: string;                      // takeover instructions
  holder: ClaimPayload;              // full incumbent payload
  commentUrl: string;                // link to the marker comment for direct inspection
}
```

**Contract**:
- `detail` template: `` `scope <scope> is already claimed by session <sessionId> (heartbeat <heartbeatAt>, ledger <ledger>)` ``.
- `hint` template: `` `retry with takeover: true, run /cockpit:auto ... --takeover, or accept the operator gate in the auto skill` ``.
- Extends `ToolErrorResult` — adds `holder` and `commentUrl` fields; `class` narrowed to `'claim-conflict'`.

**New `ErrorClass` value**: `'claim-conflict'` added to `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts`. Distinct from `'contended'` (scope-writer retry exhaustion), `'gate-refusal'` (label-state refusals), and `'internal'`.

---

### `AcquireResult` (returned by `cockpit_claim` on success)

```ts
export type AcquireResult =
  | { status: 'ok'; action: 'acquired'; claim: ClaimPayload; commentUrl: string }
  | { status: 'ok'; action: 'refreshed'; claim: ClaimPayload; commentUrl: string }
  | { status: 'ok'; action: 'taken-over'; claim: ClaimPayload; commentUrl: string;
      displaced: ClaimPayload };
```

**Actions**:
- `acquired`: previous state was no-claim. Two writes (comment create + label apply).
- `refreshed`: caller's `sessionId` already held. One write (comment edit).
- `taken-over`: caller passed `takeover: true` and displaced a different session. Two writes (comment delete + comment create; label already present, no-op).

---

### `ReleaseResult` (returned by `cockpit_release`)

```ts
export type ReleaseResult =
  | { status: 'ok'; action: 'released'; releasedClaim: ClaimPayload }
  | { status: 'ok'; action: 'not-holder'; currentHolder?: ClaimPayload }
  | { status: 'ok'; action: 'no-claim' };
```

**Semantics**:
- `released`: caller held the claim; comment deleted, label removed.
- `not-holder`: a claim exists but for a different `sessionId`. No-op; do not error. Included so callers know the reason for no-op.
- `no-claim`: no live claim on the scope. No-op. Includes label-cleanup as a best-effort side effect.

---

## Tool Input Schemas

### `cockpit_claim` input

```ts
export const CockpitClaimInputSchema = z
  .object({
    scope: IssueRefInputSchema,        // reused from schemas.ts
    sessionId: z.string().regex(/^[a-f0-9]{16,64}$/),
    ledger: z.string().min(1).max(512),
    takeover: z.boolean().default(false),
  })
  .strict();
```

**Wire-shape rules**:
- `scope`: qualified only at MCP boundary (per existing MCP convention — see `ref-input.ts` `assertQualifiedString`), object or `owner/repo#N` string or `github.com/.../issues/N` URL.
- `sessionId`: opaque; caller-supplied. See `research.md` R-6.
- `ledger`: caller-supplied path. Not opened or validated by the tool.
- `takeover`: explicit boolean; default `false` (never implicit).

### `cockpit_release` input

```ts
export const CockpitReleaseInputSchema = z
  .object({
    scope: IssueRefInputSchema,
    sessionId: z.string().regex(/^[a-f0-9]{16,64}$/),
  })
  .strict();
```

**Wire-shape rules**:
- No `takeover` — release is by-session-id only. To forcibly clear a non-owned claim, use `cockpit_claim` with `takeover: true` first, then `cockpit_release`.

---

## GitHub API Contract Extensions

Two new methods added to `GhWrapper` in `packages/cockpit/src/gh/wrapper.ts`:

```ts
export interface GhWrapper {
  // ... existing methods ...
  /**
   * Edit an issue comment by id (REST: PATCH /repos/{repo}/issues/comments/{id}).
   * Overwrites the entire body. Not conditional — callers verify via re-discover.
   */
  editIssueComment(repo: string, commentId: number, body: string): Promise<void>;

  /**
   * Delete an issue comment by id (REST: DELETE /repos/{repo}/issues/comments/{id}).
   * Best-effort; missing comment is treated as success (idempotent).
   */
  deleteIssueComment(repo: string, commentId: number): Promise<void>;
}
```

`IssueComment` extended:

```ts
export interface IssueComment {
  id: number;          // NEW — REST-numeric comment id (databaseId in GraphQL)
  body: string;
  author: string;
  createdAt: string;
  url: string;
}
```

`fetchIssueComments` and `IssueCommentsRawSchema` updated to include `databaseId` in the `gh issue view --json` fielding, mapped to `IssueComment.id`.

---

## State Machine

```
                    +----------------+
                    |   no-claim     |
                    +--------+-------+
                             |
      cockpit_claim(sessionId=S)   [no existing claim]
                             |
                             v
                    +--------+-------+
                    |  held-by-S     |
                    +-+---+---+-+----+
                      |   |   | |
        cockpit_claim(S)  |   | |  10 min elapsed with no heartbeat
        [same session,    |   | |
         refresh only]    |   | +---> stale (visible-as no-claim to next acquirer)
                          |   |
       cockpit_release(S) |   |  cockpit_claim(T, takeover=true)  [T != S]
                          |   |
                          v   v
                    +--------+-------+
                    |   no-claim     |----> cockpit_claim(T) => held-by-T
                    +----------------+
```

- No mutex, no CAS. Race guard = re-discover after write.
- Stale transition is passive — no write occurs at the 10-minute boundary; the marker only vanishes when the next acquirer deletes it during their acquire flow.

---

## Validation & Invariants

| Invariant | Enforced by |
|---|---|
| A scope has ≤1 live claim marker at any moment | Discovery's oldest-wins + delete-younger step (R-9) |
| The comment marker is source of truth over the label | Discovery ignores a lone label; treats it as orphaned (FR-003) |
| Heartbeat refresh does not touch the label | `refresh` branch calls only `editIssueComment` |
| Release is idempotent regardless of holder identity | `release` branch treats non-holder / no-claim as no-op success |
| Observer tools cannot touch claim state | Static-import guard test (`observer-independence.test.ts`) |
| Session id is opaque and never validated for meaning | `sessionId` typed as `z.string().regex(/^[a-f0-9]{16,64}$/)`, no other check |
| `scope` in the claim payload matches the issue it's posted on | Not enforced structurally; caller error if mismatched — audit-only field |

---

## Relationships

- `ClaimPayload` is embedded inside `ClaimMarker` (fenced-JSON body of the marker comment).
- `LiveClaim` wraps `ClaimPayload` + GitHub comment id for update/delete operations.
- `RefusalPayload` embeds `ClaimPayload` (as `holder`) for actionable refusals.
- `AcquireResult.taken-over` embeds two payloads: `claim` (new holder = caller) and `displaced` (previous holder).
