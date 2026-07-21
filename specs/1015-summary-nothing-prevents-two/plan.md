# Implementation Plan: Active-driver claim per cockpit scope

**Feature**: Add a GitHub-backed active-driver claim to `/cockpit:auto` so two conversations cannot silently double-drive the same scope.
**Branch**: `1015-summary-nothing-prevents-two`
**Status**: Complete
**Spec**: [`spec.md`](./spec.md)

## Summary

Nothing currently prevents two `/cockpit:auto` conversations from driving the same scope (epic or tracking issue) concurrently. Both sessions dispatch `cockpit_advance` / `cockpit_queue` / `cockpit_merge` against the same issues, both fire human gates, and both mutate the scope body — pure GitHub-level races with no coordination.

This feature adds an **active-driver claim** per scope ref, stored on the scope issue itself as a **structured HTML-comment marker + a `cockpit:claimed` enumeration label** (Q1 → C). The claim is manipulated via two new MCP tools — `cockpit_claim` (idempotent acquire-or-refresh-or-takeover) and `cockpit_release` (Q2 → C) — and consulted by the `/cockpit:auto` skill at arm time and on every wake-tick heartbeat (Q3 → D, Q5 → C).

**Design invariants**:
1. The comment is the source of truth; the label is a discovery/enumeration index. Orphaned labels are tolerated (removed and arm proceeds) — see FR-003.
2. Heartbeat is opportunistic — auto's per-wake `cockpit_claim` call *is* the heartbeat. No dedicated timer. Staleness threshold **10 minutes** absolute.
3. Refusal payload lists the incumbent's session id, ledger path, and all three takeover surfaces (Q4 → D: `--takeover` CLI flag, gate-style operator confirmation, `takeover: true` MCP arg).
4. Observer surfaces (`cockpit_status`, `/cockpit:watch`, standalone `cockpit_await_events` subscribers) are structurally unable to touch claims (Q5 → C, FR-011).

## Technical Context

**Language/Version**: TypeScript, Node.js ≥22 (matches `packages/generacy/package.json`).
**Primary Dependencies**: `@modelcontextprotocol/sdk`, `zod`, `@generacy-ai/cockpit` (`GhCliWrapper`, `resolveIssueContext`).
**Storage**: GitHub Issues API — a dedicated comment (source of truth) + a `cockpit:claimed` label (enumeration index). No local filesystem state beyond the existing per-session ledger.
**Testing**: `vitest` (matches sibling MCP-tool suites — `parity-advance.test.ts`, `parity-scope-add.test.ts`, etc.).
**Target Platform**: In-cluster orchestrator (Linux, Node ≥22).
**Project Type**: Single-package library (`packages/generacy`, with a small extension to `packages/cockpit` for the comment edit/delete gh wrappers). Skill-side prose lives in the separate `agency` repo under `packages/claude-plugin-cockpit/commands/auto.md` — this repo owns only the MCP-tool primitives and their tests.
**Performance Goals**: **≤ 1 GitHub write per auto-loop wake** (SC-006). Acquire = 2 writes (comment create + label apply); heartbeat/refresh = 1 write (comment edit); release = 2 writes (comment delete + label remove).
**Constraints**: Must not add per-dispatch GitHub reads (Q5 → C — opportunistic re-check only). Observer tools MUST NOT be gated by claims. Concurrent sessions on different scopes MUST behave exactly as today (SC-002).
**Scale/Scope**: Two new MCP tools (`cockpit_claim`, `cockpit_release`); one new label (`cockpit:claimed`); two new `GhWrapper` methods (`editIssueComment`, `deleteIssueComment`); one new module (`packages/generacy/src/cli/commands/cockpit/mcp/claim/`) with the marker parser, formatter, and business-logic services. Skill-side auto.md changes in the `agency` repo are a **separate PR** (out of scope for this branch).

## Constitution Check

*No `.specify/memory/constitution.md` exists in this repo (verified). Standard project conventions apply:*

- ✅ **Changesets** (CLAUDE.md gate): the implementation PR will add `.changeset/1015-active-driver-claim.md` bumping `@generacy-ai/generacy` and `@generacy-ai/cockpit` at least `minor` (new MCP tools + new user-visible CLI flag on `/cockpit:auto` + new `GhWrapper` methods).
- ✅ **`cockpit:` label namespace**: new — no collision with `agent:*` / `waiting-for:*` (verified in spec Q1 answer).
- ✅ **Comment marker shape**: `<!-- cockpit:claim v1 ... -->` — no existing skill parses this fence (verified in spec Assumptions).
- ✅ **Never-merge-on-red** (auto.md invariant): unaffected — the claim gates the *arm* step, not merge dispatch. `cockpit_merge` itself doesn't touch claim state.
- ✅ **Observer independence**: enforced by construction — neither `cockpit_status`, `cockpit_await_events`, nor `cockpit_context` call the claim tools. Verified by tests (SC-005).

## Deferred Clarifications — Plan-Phase Decisions

Two clarifications were deferred from the spec's clarification phase as implementer-selectable:

### D-1: Session id derivation

**Choice**: Use `INSTANCE_NONCE` (the existing per-process nonce at `packages/generacy/src/cli/commands/cockpit/mcp/event-bus.ts:72`, already 16 hex chars from `crypto.randomBytes(8)`).

**Rationale**:
- Already unique per MCP server process (probabilistic collision ~2⁻⁶⁴), already generated on module load, already used to disambiguate cursors across process restarts.
- Every `/cockpit:auto` invocation spawns its own MCP server process (per spec: "if each conversation spawns its own MCP server process, the sessions don't even share the registry"), so `INSTANCE_NONCE` is the correct scope: one session ↔ one MCP process ↔ one `INSTANCE_NONCE`.
- Alternative (fresh UUID per `cockpit_claim` call) rejected because a caller that restarts its wake loop within the same MCP process should keep the same claim identity — otherwise the "verify I still hold" path (FR-006) would false-positive as a takeover.
- Alternative (ledger slug hash) rejected: the ledger path is a caller-supplied field; sourcing session id from it opens spoofing (any caller with two ledgers of the same slug takes over silently).

**Public surface**: `cockpit_claim` accepts `sessionId` as a required argument (opaque string, `min(1).max(64)`, `/^[a-f0-9]{16,64}$/` shape). The skill supplies `INSTANCE_NONCE` as its session id. Tests supply arbitrary strings.

### D-2: Changeset bump levels

**Choice**: `minor` for **both** `@generacy-ai/generacy` and `@generacy-ai/cockpit`. Single changeset file `.changeset/1015-active-driver-claim.md`.

**Rationale**:
- `@generacy-ai/generacy`: `minor` per CLAUDE.md rule "new capability → minor" — two new MCP tools + one new user-visible CLI flag (`--takeover` on `/cockpit:auto`, though the CLI-flag wiring happens in the sibling agency-repo PR; the MCP surface here already qualifies as new capability).
- `@generacy-ai/cockpit`: `minor` per CLAUDE.md rule "new capability → minor" — two new public `GhWrapper` methods (`editIssueComment`, `deleteIssueComment`). These are public exports on the `GhWrapper` interface, so any consumer of the interface sees the additions.
- The CLAUDE.md single-file-only rule ("It must be a **newly added** file") is satisfied.

## Project Structure

### Documentation (this feature)

```text
specs/1015-summary-nothing-prevents-two/
├── plan.md                     # This file
├── spec.md                     # Feature specification (read-only)
├── clarifications.md           # Batch 1 clarifications (read-only)
├── research.md                 # Phase 0 output (new)
├── data-model.md               # Phase 1 output (new)
├── contracts/
│   ├── cockpit_claim.md        # MCP tool contract (new)
│   ├── cockpit_release.md      # MCP tool contract (new)
│   ├── claim-marker.md         # HTML-comment marker grammar (new)
│   └── refusal-payload.md      # Structured refusal shape (new)
├── quickstart.md               # Operator + implementer usage (new)
└── checklists/                 # Empty (no checklist requested)
```

### Source Code (repository root)

New files (all under `packages/generacy/src/cli/commands/cockpit/mcp/`):

```text
packages/generacy/src/cli/commands/cockpit/mcp/
├── claim/
│   ├── marker.ts               # NEW — parse/format `<!-- cockpit:claim v1 -->` fenced JSON
│   ├── payload.ts              # NEW — ClaimPayload / RefusalPayload types + Zod schemas
│   ├── acquire.ts              # NEW — acquire-or-refresh-or-takeover business logic
│   ├── release.ts              # NEW — comment delete + label removal
│   ├── discover.ts             # NEW — enumerate current claim on a scope (list comments, match marker)
│   └── __tests__/
│       ├── marker.test.ts      # NEW — round-trip parse/format
│       ├── acquire.test.ts     # NEW — acquire / refresh / takeover / stale / orphaned-label branches
│       ├── release.test.ts     # NEW — release semantics
│       └── discover.test.ts    # NEW — comment/label consistency, orphan tolerance
├── tools/
│   ├── cockpit_claim.ts        # NEW — MCP tool handler (thin wrapper around claim/acquire.ts)
│   └── cockpit_release.ts      # NEW — MCP tool handler (thin wrapper around claim/release.ts)
├── schemas.ts                  # MODIFIED — add CockpitClaimInputSchema, CockpitReleaseInputSchema
├── server.ts                   # MODIFIED — register cockpit_claim + cockpit_release tools
├── errors.ts                   # MODIFIED — add ErrorClass 'claim-conflict' (refusal payload)
└── __tests__/
    ├── parity-claim.test.ts    # NEW — MCP-boundary tests for cockpit_claim (all 5 branches)
    ├── parity-release.test.ts  # NEW — MCP-boundary tests for cockpit_release
    └── observer-independence.test.ts # NEW — SC-005 regression guard
```

Modified files under `packages/cockpit/src/gh/`:

```text
packages/cockpit/src/gh/wrapper.ts
  # ADD: editIssueComment(repo, commentId, body): Promise<void>
  # ADD: deleteIssueComment(repo, commentId): Promise<void>
  # ADD: IssueComment.id field (int, sourced from GraphQL databaseId)
  # ADD to GhWrapper interface + GhCliWrapper impl
```

Changeset (project root):

```text
.changeset/
└── 1015-active-driver-claim.md    # NEW — minor bump for generacy + cockpit
```

**Skill-side prose (out of scope for this branch, tracked separately)**: `agency` repo — `packages/claude-plugin-cockpit/commands/auto.md` needs:
1. Add `--takeover` to the frontmatter arguments and step-1 parse.
2. Add step 1.5 "Claim the scope" (call `cockpit_claim` with `sessionId = INSTANCE_NONCE`; on `class: 'claim-conflict'`, present a gate).
3. Modify step 4's per-wake tick to include `cockpit_claim` refresh (piggyback per FR-007).
4. Add step 6 "Release the claim" branch (`cockpit_release`) to the exit path.
5. On refresh returning a different `sessionId` as the holder, log takeover to ledger and exit cleanly (FR-010).

**Structure Decision**: Sit alongside existing MCP tools. The `claim/` sub-folder groups the ~4 small modules (marker/payload/acquire/release) that would otherwise clutter `mcp/`, matching the sibling `scope/` folder pattern (`packages/generacy/src/cli/commands/cockpit/scope/`). Two thin `tools/cockpit_claim.ts` + `tools/cockpit_release.ts` handlers keep the MCP-server registration list uniform.

## Constitution Re-Check (Post-Design)

- ✅ Comment shape unique and namespaced (`<!-- cockpit:claim v1 ... -->` vs. existing `<!-- cockpit:answers vN ... -->` from `cockpit_relay_clarify_answers`) — no collision.
- ✅ Label vocabulary: `cockpit:claimed` is a new namespace (existing labels use `agent:*`, `waiting-for:*`, `completed:*`, `failed:*`, `phase:*`, `process:*`).
- ✅ GitHub write budget: acquire=2 writes, heartbeat=1 write per wake, release=2 writes. Well under SC-006's "≤ 1 write per wake" for the hot path (only heartbeat runs per wake; acquire is once-per-session, release is once-per-session).
- ✅ No new dependencies added.
- ✅ Zero orchestrator changes — feature is entirely CLI/MCP surface.

## Complexity Tracking

No constitution violations. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| (none)    | —          | —                                    |

## Next Step

Run `/speckit:tasks` to generate the ordered task list.
