# Implementation Plan: Operator-requested capability (cockpit auto-mode workstream — #935)

**Feature**: Live-membership event contract + `cockpit scope add`/`scope remove` + single-issue `cockpit queue` + non-epic (flat-list / adhoc) scope refs
**Branch**: `935-operator-requested-capability`
**Status**: Complete

## Summary

Engine-side changes that make cockpit's poll loop and MCP surface support two operator scenarios that today can't be modelled cleanly:
1. **Ad-hoc issues mid-epic** — refs appended to a live epic's task list must join the monitored set within one poll cycle **and** emit a dispatchable "first-sight" event (not a silent snapshot join).
2. **Epic-less auto (stabilization runs)** — cockpit can drive a plain task-list-bearing tracking issue (no `### Phase N` headings), where the monitored set is exactly the refs listed in the body and multiple concurrent tabs on different scope refs never observe each other's events.

Both fall out of a single design reframe: **the scope of an auto session is a task-list-bearing issue**, not necessarily an epic. Existing per-poll `resolveEpic` re-invocation (`event-bus-registry.ts:370, :409`) already picks up mid-cycle body edits — this plan makes the mid-cycle new-member event observable, adds the typed writer verbs for adding/removing refs, adds the single-issue queue form, and teaches the parser + resolver to accept flat-list scope bodies.

## Technical Context

**Languages / packages touched**
- `@generacy-ai/cockpit` (`packages/cockpit/`) — parser (`resolver/parse-epic-body.ts`), resolver (`resolver/resolve.ts`), gh wrapper (`gh/wrapper.ts`), public types
- `generacy` CLI (`packages/generacy/`) — cockpit command tree, watch/diff module, MCP handlers/schemas, MCP server registrations
- TypeScript, ESM, Node ≥22, Vitest for tests. `@clack/prompts` for CLI confirm (already in-tree). `commander` for verb registration. `zod` for MCP schemas.

**Zero new runtime deps.**

**Backward compatibility**
- Parser change is additive: existing epic bodies (with `###` phase headings) parse identically. New `parsed.adhocRefs` field defaults to `[]` when there are no non-phase task-list refs.
- Resolver change is a fail-loud relaxation: `NO_PHASE_HEADINGS` no longer throws when the body has task-list refs but no phase headings (flat-list mode). `NO_REFS` still fires when the body has no refs at all.
- `computeTransitions` change: previously silent case (mid-stream new key) now emits `initial: true`. Consumers already handle `initial: true` (the S8 connect-time snapshot event).
- `cockpit_queue` MCP schema is additive: `{ epic, phase }` still accepted; `{ issue }` variant added via discriminated union. CLI is additive: `--issue <ref>` mutually exclusive with `<epic-ref> <phase>`.

## Design decisions

### D-1: `initial: true` on mid-stream first-sight (Q1 → B)
In `computeTransitions` (`packages/generacy/src/cli/commands/cockpit/watch/diff.ts:167-176`), when a snapshot key appears in `curr` but is absent from `prev` **and** `prev.size > 0` (i.e. not the initial sweep), emit one `label-change` event with `initial: true` if the snapshot is actionable — matching `computeInitialSweep` shape per-key. Wire schema unchanged; consumers see the existing `initial: true` flag they already dispatch on.

### D-2: Shape-aware body writer (Q2 → Hybrid A+C)
`cockpit scope add` / `cockpit scope remove` route through a pure writer that inspects the body once:
- **Phased body** (any `### ` heading present): insertion under an L2 `## Ad-hoc` section, created if missing. Removal deletes the specific task-list line matching the ref (leaves an empty section heading intact — one-shot verb symmetry).
- **Flat body** (no `### ` headings): insertion at body tail; removal deletes the matching line.

Detection uses the same `HEADING_L3_RE` regex as `parseEpicBody` for exact parity with the parser's semantics.

### D-3: Parser + resolver accept flat-list bodies (Q3 → C, engine half)
`parseEpicBody` gains an `adhocRefs: IssueRef[]` field: task-list refs collected when `current == null` — i.e. before any phase heading, under `## Ad-hoc`, and after `####+` terminators. `resolveEpic` no longer throws `NO_PHASE_HEADINGS` when `phases.length === 0 && allRefs.length > 0`. `NO_REFS` still fires when `allRefs.length === 0`.

**`## Ad-hoc` handling**: To make L2 `## Ad-hoc` a phase-terminator for the phased case, the parser recognises the specific case-insensitive first-token match `## ad-hoc` and closes the current phase. Other L2 headings continue to be ignored (backward compat with existing epic bodies that intermix `## Success criteria` etc.).

The `type:cockpit-tracking` label from spec Change 4 is a *playbook* concern (applied by ad-hoc mode to issues *it creates*, for dashboard/cleanup queries) — **no engine code depends on it**. Documented in `research.md` §Non-code contracts.

### D-4: `cockpit scope` CLI namespace = add + remove (Q4 → A+B answer)
Two mutation verbs, no `list` (served by `cockpit_status`). Both use the same read-modify-write-verify retry loop; `remove` is the inverse mutation over the same primitive.

### D-5: Bounded retry with typed contended error (Q5 → A)
Writer loop: **5 attempts, exponential backoff 100 ms / 250 ms / 500 ms / 1 s / 2 s**. On terminal verify-mismatch throw `ScopeContendedError` with code `SCOPE_ADD_CONTENDED` (name kept even for the `remove` case per SC-005 wording; a distinct `SCOPE_REMOVE_CONTENDED` is not warranted). MCP tools surface the code as `class: 'contended'` with the same string. CLI verb exits with code 1 and prints the code + a suggested manual remedy.

**Verify semantics**: read body → compute new body → write → read body back → assert readback === written value. Mismatch → retry from the fresh readback (idempotent by construction: add short-circuits if ref already present; remove short-circuits if ref already absent).

### D-6: Single-issue `cockpit queue`
Add `--issue <ref>` to the CLI verb; runQueue routes to a new `runQueueSingleIssue()` that reuses the eligibility classifier (`classifyRow`) and mutation loop (assign + label) from `runQueue`, minus phase/epic resolution. `--issue` is mutually exclusive with positional `<epic-ref> <phase>` — validated at command-boundary parse.

MCP: extend `CockpitQueueInputSchema` to a discriminated union — `{ epic, phase }` (existing) OR `{ issue }` (new). `cockpit_queue.ts` handler dispatches on shape.

### D-7: Isolation assertion is a test, not code
Registry keyed by expanded `expandedRef` string (owner/repo#N) already gives distinct-scope isolation by construction. The assertion is a load-bearing test that pins this: two concurrent `acquireEpicBus` calls with different refs, publish on one, verify the other doesn't see it.

## Project Structure

### Files added

```
packages/cockpit/src/resolver/parse-epic-body.ts    (MODIFIED — adhocRefs collection)
packages/cockpit/src/resolver/resolve.ts             (MODIFIED — flat-list allowed)
packages/cockpit/src/resolver/types.ts               (MODIFIED — ParsedEpicBody.adhocRefs)
packages/cockpit/src/gh/wrapper.ts                   (MODIFIED — updateIssueBody)
packages/cockpit/src/index.ts                        (MODIFIED — no new exports, unchanged)

packages/generacy/src/cli/commands/cockpit/watch/diff.ts
                                                     (MODIFIED — mid-stream new-key emits initial:true)

packages/generacy/src/cli/commands/cockpit/scope/writer.ts        (NEW — pure writer)
packages/generacy/src/cli/commands/cockpit/scope/retry.ts         (NEW — bounded retry loop)
packages/generacy/src/cli/commands/cockpit/scope/errors.ts        (NEW — ScopeContendedError)
packages/generacy/src/cli/commands/cockpit/scope.ts               (NEW — CLI verb: scope add|remove)

packages/generacy/src/cli/commands/cockpit/queue.ts               (MODIFIED — --issue form)
packages/generacy/src/cli/commands/cockpit/status.ts              (MODIFIED — flat-mode render)
packages/generacy/src/cli/commands/cockpit/status/group.ts        (MODIFIED — adhoc group)

packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_scope_add.ts     (NEW)
packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_scope_remove.ts  (NEW)
packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_queue.ts         (MODIFIED — dispatch on shape)
packages/generacy/src/cli/commands/cockpit/mcp/schemas.ts                     (MODIFIED — new schemas)
packages/generacy/src/cli/commands/cockpit/mcp/server.ts                      (MODIFIED — register scope tools)
packages/generacy/src/cli/commands/cockpit/mcp/errors.ts                      (MODIFIED — contended class)
packages/generacy/src/cli/commands/cockpit/index.ts                           (MODIFIED — add scopeCommand())
```

### Tests added

```
packages/cockpit/src/resolver/__tests__/parse-epic-body.test.ts   (EXTENDED — adhoc + flat)
packages/cockpit/src/resolver/__tests__/resolve.test.ts           (EXTENDED — flat body OK)

packages/generacy/src/cli/commands/cockpit/watch/__tests__/diff.test.ts       (EXTENDED — mid-stream initial)

packages/generacy/src/cli/commands/cockpit/scope/__tests__/writer.test.ts     (NEW — shape-aware writer)
packages/generacy/src/cli/commands/cockpit/scope/__tests__/retry.test.ts      (NEW — retry + backoff + contended)
packages/generacy/src/cli/commands/cockpit/__tests__/scope.test.ts            (NEW — CLI verb)

packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-scope-add.test.ts    (NEW)
packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-scope-remove.test.ts (NEW)
packages/generacy/src/cli/commands/cockpit/mcp/__tests__/parity-queue.test.ts        (EXTENDED — issue form)
packages/generacy/src/cli/commands/cockpit/mcp/__tests__/registry-isolation.test.ts  (NEW — SC-004)
packages/generacy/src/cli/commands/cockpit/mcp/__tests__/registry-liveness.test.ts   (NEW — SC-001)

packages/generacy/src/cli/commands/cockpit/__tests__/queue.test.ts            (EXTENDED — --issue form)
packages/generacy/src/cli/commands/cockpit/__tests__/status.test.ts           (EXTENDED — flat body)
```

### Files not touched (documented for reviewers)
- `packages/generacy/src/cli/commands/cockpit/resolver.ts` (`resolveIssueContext`) — no signature change; every new verb routes through it exactly as `advance`, `queue`, `merge` do today (#822, #850).
- Playbook (`docs/skills/cockpit/*`, agency-side) — companion issue.

## Constitution Check

No `.specify/memory/constitution.md` present in the repository (`ls /workspaces/generacy/.specify/memory/` = not found). Constitution check trivially passes.

Cross-check against project conventions from CLAUDE.md:
- **No new backwards-compat shims**: parser change is additive (new field), not a versioned shim.
- **No comments explaining WHAT**: internal comments limited to WHY (non-obvious contracts — e.g., idempotency, retry budget).
- **Trust boundaries**: MCP handlers validate at the boundary (Zod), internal code trusts inputs.
- **No premature abstraction**: writer + retry are two functions, not a class hierarchy. Retry helper is scope-specific (bounded 5); no generic backoff helper (spec's cross-references to #913 / #924 confirm house pattern is per-caller, not framework).
- **Sibling epic pattern (D-2)**: mirrors existing epic-shape awareness in `parseEpicBody` — no new mode enum surfaced in the public type.

## Success Criteria mapping

| SC | Requirement | Verified by |
|----|-------------|-------------|
| SC-001 | Mid-cycle `add` → `initial: true` event within one poll cycle | `registry-liveness.test.ts` + `diff.test.ts` |
| SC-002 | `cockpit_queue --issue` behaves identically to phase-queued | `parity-queue.test.ts` issue-form fixture |
| SC-003 | Flat-list scope resolves and drives the same loop | `resolve.test.ts` + `parity-status.test.ts` |
| SC-004 | Two-tab isolation, no cross-delivery | `registry-isolation.test.ts` |
| SC-005 | 10-concurrent `scope add` produces 10 entries under bounded budget | `retry.test.ts` (property-style loop with 10 fake in-flight bodies) |
| SC-006 | `scope remove` inverts `scope add` content-equivalently | `writer.test.ts` (round-trip property test) |

## Rollout / risk

- **Parser change risk**: existing bodies without `## Ad-hoc` are unaffected (case-insensitive first-token match is narrow). If a real-world body already uses `## Ad-hoc` as prose header, this becomes a phase-terminator — surveyed against known epic templates in `research.md`.
- **Resolver relaxation risk**: any caller that assumed `resolveEpic` throws on non-phased bodies now sees a valid `ResolvedEpic` with `phases: []`. Grep-verified callers: `status.ts`, `queue.ts`, `watch.ts`, `context.ts`, `event-bus-registry.ts` — each is updated in this plan (`status.ts` flat-mode render; `queue.ts` errors clearly on phase form for flat bodies; others transit `parsed.allRefs` and are unaffected).
- **Writer race risk**: bounded retry + verify readback protects against lost writes; the only failure surface is legitimate high contention (>5 concurrent writers) → typed `SCOPE_ADD_CONTENDED` code. No silent-drop pathway.

## Next step

Run `/speckit:tasks` to generate the task list.
