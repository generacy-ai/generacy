# Research: #935 engine changes

## Grammar vs. spec-phrasing reconciliation

The spec uses `## Phase N:` in a few places (Q2, Q3 answer, Change 4 body). The actual grammar the parser recognises is **L3** (`### Phase N:`), per `packages/cockpit/src/resolver/parse-epic-body.ts:5`:

```typescript
const HEADING_L3_RE = /^###\s+(.+?)\s*$/;  // opens a phase
const HEADING_L2_RE = /^##\s+/;             // ignored today
```

**Decision**: treat the spec's `## Phase N:` as spec shorthand for "the phase heading" and pin implementation to the actual grammar (`###`). This is explicitly called out here so the tasker/implementer doesn't try to change the phase heading level.

The `## Ad-hoc` heading in Q2's answer is a *distinct* choice — one level *above* phases — precisely so the parser treats it as scope-level, not phase-scoped. That interpretation stands.

## Live-membership: why the current gap is silent

`computeTransitions` (`packages/generacy/src/cli/commands/cockpit/watch/diff.ts:159-177`) has explicit two-mode logic:

```typescript
if (prev.size === 0) return computeInitialSweep(curr, ts);  // first poll — emit initial:true for all
const out: CockpitEvent[] = [];
for (const [key, currSnap] of curr) {
  const prevSnap = prev.get(key);
  if (prevSnap == null) continue;  // ← THE GAP: mid-stream new key is silent
  // diff issue/pr...
}
```

The comment at line 156-157 confirms the current design intent: *"If a specific key is absent from prev on polls 2..N, that key is treated as baseline and emits nothing."*

This is what needs to change for FR-002. Concretely: replace the `if (prevSnap == null) continue;` branch with a first-sight emission that matches `computeInitialSweep`'s shape per-key (actionable check, `initial: true`, `from: null`, `to: <current-state>`). Non-actionable snapshots stay silent (same policy as the connect-time sweep).

## Registry re-resolution timing

`event-bus-registry.ts:361-415` runs one poll cycle:
- Line 370: `resolveEpic(expandedRef)` at cycle start if `currentResolved == null` (first cycle only).
- Line 382-387: `runOnePoll` fetches snapshots for `resolved.parsed.allRefs`.
- Line 409: `resolveEpic(expandedRef)` refresh at cycle end for the *next* cycle.

So a mid-cycle body edit (e.g., `cockpit scope add`) surfaces on the **next** poll: cycle N ends → line 409 refresh picks up the new ref → cycle N+1 line 382 fetches its snapshot → line 388 emits the transition. With the D-1 fix, that transition carries `initial: true`.

This satisfies FR-002's "within one poll cycle" contract with no registry surgery — just the diff-side change.

## GhWrapper body-edit primitive

`GhCliWrapper.addLabels` / `removeLabels` already invoke `gh issue edit --add-label / --remove-label` (lines 841-859). No existing method sets `--body`. We add:

```typescript
updateIssueBody(repo: string, issue: number, body: string): Promise<void>
```

Implementation invokes `gh issue edit <n> --repo <r> --body-file -` with body piped via stdin (safer than `--body` for large or shell-metachar bodies). `CommandRunner` supports stdin input via a rarely-used option — verified in `packages/cockpit/src/gh/command-runner.ts`.

**Alternative considered**: `gh api /repos/{owner}/{repo}/issues/{n} -X PATCH -f body=@- < body.txt`. Slightly lower-level but no gain over `gh issue edit --body-file -`, so we go with the higher-level primitive that matches existing wrapper style.

## Retry backoff constants — house pattern check

The spec cross-references #913 (resolver retry-once-then-hard-fail) and #924 ("bounds everything"). Both use short bounded retries with explicit ceilings, not indefinite loops. The chosen schedule (100/250/500/1000/2000 ms, 5 attempts) totals ~3.85 s worst-case — matches what an operator can tolerate blocking on a mutation verb and empirically comfortably absorbs 10-way contention against a single scope issue's `PATCH` endpoint (GitHub's own request-serialization is on the order of ~100-300ms per body PATCH; 10 racers with jittered backoff converge well inside the budget).

Deliberately *not* introducing a shared `retryWithBackoff` helper — no existing house helper exists, and the retry semantics here are scope-specific (idempotent verify, typed terminal error). Sibling futures (`cockpit_advance`'s post-mutation verify, PR-body edits) can factor out later; premature abstraction is the anti-pattern (per project CLAUDE.md).

## Parser change: what breaks, what doesn't

Existing epic bodies (verified against `parseEpicBody` fixture tests and #826 warning taxonomy):
- `### Phase 1: …` — unchanged.
- `## Success criteria` (as prose section header, no task-list refs inside) — unchanged. Case-insensitive match `## ad-hoc` is narrow enough not to conflict.
- Refs under `#### ` — unchanged (already terminates phase).
- Refs before any `### ` heading — **new behavior**: previously dropped (`current == null` branch), now collected into `adhocRefs` and `allRefs`. This changes behaviour for one edge case: an epic body that includes task-list refs in a preamble before the first phase heading. Grep against `specs/*/spec.md` and known template files shows this pattern is not used in practice.

**Concrete parser diff**:

```typescript
// parse-epic-body.ts additions
const AD_HOC_HEADING_RE = /^##\s+ad-hoc\s*$/i;  // case-insensitive first-token match

// inside for-loop, before HEADING_L2_RE check:
if (AD_HOC_HEADING_RE.test(line)) {
  current = null;
  currentSeen = new Set();
  continue;
}

// task-list handling — new branch:
if (current == null) {
  // adhoc collection: collect ref into globalRefs and adhocRefs
  if (!globalRefsHas(key)) {
    globalRefs.set(key, ref);
    adhocRefs.push(ref);
  }
  continue;
}
// existing phase-attribution path unchanged
```

## Resolver change: fail-loud relaxation

`resolveEpic` at line 57-59 throws `NO_PHASE_HEADINGS` when `phases.length === 0`. Change:

```typescript
if (parsed.phases.length === 0 && parsed.adhocRefs.length === 0) {
  throw new LoudResolverError('NO_PHASE_HEADINGS');  // preserved for degenerate empty case
}
// otherwise fall through to NO_REFS check on allRefs
```

Actually simpler: `NO_REFS` on `allRefs.length === 0` is sufficient. Drop the `NO_PHASE_HEADINGS` throw entirely; a body with no phases *and* no adhoc refs will just hit `NO_REFS`. Test cases update accordingly.

## MCP schema shape for `cockpit_queue` dual form

Discriminated union at the Zod level:

```typescript
export const CockpitQueueInputSchema = z.union([
  z.object({ epic: EpicRefInputSchema, phase: z.string().min(1) }).strict(),
  z.object({ issue: IssueRefInputSchema }).strict(),
]);
```

Handler dispatches on which branch parsed. Backward-compatible: existing `{ epic, phase }` calls parse into the first branch unchanged.

**Alternative considered**: single-object schema with optional `epic`, `phase`, `issue` fields and runtime XOR. Rejected — the discriminated union carries the invariant into the type system for TypeScript consumers of the tool (per `.strict()` and Zod inference).

## Non-code contracts

- `type:cockpit-tracking` label: applied by playbook when it *creates* new tracking issues. Engine never reads or filters on this label. Documented for dashboard/cleanup consumers.
- `## Ad-hoc` section: convention for scope-level ad-hoc refs in phased bodies. Written by `cockpit scope add`. Read by parser as adhoc, not phase.

## Sources / references

- Spec: `specs/935-operator-requested-capability/spec.md`
- Clarifications: `specs/935-operator-requested-capability/clarifications.md`
- Parser today: `packages/cockpit/src/resolver/parse-epic-body.ts`
- Registry today: `packages/generacy/src/cli/commands/cockpit/mcp/event-bus-registry.ts` (line 370, 409)
- Diff today: `packages/generacy/src/cli/commands/cockpit/watch/diff.ts` (line 156-177)
- `initial: true` precedent: `packages/generacy/src/cli/commands/cockpit/watch/diff.ts:129-148` (`computeInitialSweep`)
- Event schema: `packages/generacy/src/cli/commands/cockpit/watch/emit.ts:5-18`
- Public API: `packages/cockpit/src/index.ts`
- Existing MCP tool patterns: `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_advance.ts`, `.../cockpit_queue.ts`
- Sibling `resolveIssueContext` pattern: `packages/generacy/src/cli/commands/cockpit/resolver.ts`
