# Contract: Cockpit Answer Relay (`cockpit_relay_clarify_answers`)

## Purpose

Give cockpit's clarify skill a deterministic tool for relaying human answers into the paused issue — stamping the `<!-- generacy-clarification-answers:<batch> -->` marker in exactly the shape the orchestrator's answer-scanner requires. Replaces the current freehand `gh issue comment` invocation.

Without this contract, spec FR-003 cannot be enforced: the agent free-writes the answer body, the marker is improvised per run (four different agent-invented markers were observed on #5/#6/#7/#8 in a single run), and `viewerDidAuthor === true` + missing/wrong marker means the orchestrator rejects the cockpit-relayed answer the same way it rejects the bot's self-answer.

## Tool signature

**Name**: `cockpit_relay_clarify_answers`

**Input** (Zod schema):

```ts
{
  issue: IssueRefInput,        // <owner>/<repo>#<n>, full URL, or bare number resolved from cwd
  batch: number,               // non-negative integer
  answers: Record<number, string>,  // { 1: "...", 2: "...", ... }, non-empty
}
```

**Output** (`ToolResult<data>`):

```ts
{
  status: 'ok',
  data: {
    ref: { owner, repo, number, nwo },
    batch: number,
    action: 'relayed' | 'already-relayed',
    commentUrl?: string,
    completedLabel: 'completed:clarification',
    noop?: true,
  }
}
```

## Behavior

1. Resolve `issue` via `resolveIssueContext` (same as `runAdvance`).
2. Resolve actor via `resolveCockpitIdentity({ mode: 'optional' })`.
3. Fetch existing comments; if a prior comment carries the exact `<!-- generacy-clarification-answers:<batch> -->` prefix for this `batch`, return `action: 'already-relayed', noop: true` without re-posting (idempotence).
4. Render body via `formatClarificationAnswerComment({ batch, answers, actor, ts: now.toISOString() })`.
5. `gh.postIssueComment(ref.nwo, ref.number, body)` — capture the URL.
6. `gh.addLabel(ref.nwo, ref.number, 'completed:clarification')` — reuses `runAdvance`'s idempotent label-add.
7. Return `action: 'relayed', commentUrl, completedLabel: 'completed:clarification'`.

## Non-behavior

- MUST NOT rewrite `clarifications.md` locally or push a commit. Body of the comment is the sole state change on the issue; the orchestrator's phase loop persists parsed answers to the file on the next queue-picked cycle.
- MUST NOT remove `waiting-for:clarification`. The worker owns clearing that on the resume path (mirrors `runAdvance`'s AD-1 invariant).
- MUST NOT allow prose-only answer forms. Input is a structured `Record<number, string>`; the tool renders `Q<n>: <value>` lines. Prose answer forms are out of scope for this PR (spec §Out of Scope).

## Refusal / error surface

Reuses `wrapToolBoundary` + `CockpitExit` mapping (see `packages/generacy/src/cli/commands/cockpit/mcp/errors.ts`):

- Zod parse failure → `class: 'invalid-args'`.
- `resolveIssueContext` failure → `class: 'invalid-ref'`.
- `answers` map empty → `class: 'invalid-args'`, detail `at least one answer required`.
- `answers` value empty string → `class: 'invalid-args'`, detail `answer for Q<n> is empty`.
- Transport failure on `gh.postIssueComment` → `class: 'transport'`.
- Transport failure on `gh.addLabel` → `class: 'transport'`. The comment was posted; the label-add failure is surfaced but the comment URL is included in the error detail so the caller can inspect state.

## Idempotence

Two calls with the same `(issue, batch, answers)` produce one comment and one label-add. Second call returns `action: 'already-relayed', noop: true`. Different `answers` values under the same `batch`: the second call still returns `noop: true` — the marker is `batch`-keyed, not answers-content-keyed. Callers must bump the batch number to relay a new set (matches how the questions-side `clarification:batch-N` marker works).

## Skill integration

The `.claude/skills/cockpit-clarify` skill file(s) that currently instruct the agent to post the answer body via `gh issue comment` are refactored to instead:

1. Draft the structured `{ [questionNumber: number]: string }` map.
2. Invoke `cockpit_relay_clarify_answers` with that map.

The tool's structured output (`ToolResult`) gives the skill an unambiguous success / already-relayed / error signal without parsing stdout.

## Wiring

- New file: `packages/generacy/src/cli/commands/cockpit/mcp/tools/cockpit_relay_clarify_answers.ts`.
- New file: `packages/generacy/src/cli/commands/cockpit/clarify-relay.ts` (`runClarifyRelay` + `ClarifyRelayInput`/`Result` types).
- New file: `packages/generacy/src/cli/commands/cockpit/clarification-answer-marker.ts` (`formatClarificationAnswerComment`).
- Registered in `packages/generacy/src/cli/commands/cockpit/mcp/server.ts` with `server.registerTool('cockpit_relay_clarify_answers', ...)`.
- Zod schema in `packages/generacy/src/cli/commands/cockpit/mcp/schemas.ts` (`CockpitRelayClarifyAnswersInputSchema`).

## Test coverage requirements

- `formatClarificationAnswerComment`: valid + all invalid inputs (batch, actor, ts, answers).
- `runClarifyRelay`: happy path, refusal branches, idempotence via existing-marker detection, transport-failure at each `gh` call.
- MCP tool: Zod-schema validation, parity with the CLI form (mirrors `parity-advance.test.ts`), stdout cleanliness (no stray writes when invoked via MCP).
- Round-trip: `commentCarriesAnswerMarker(formatClarificationAnswerComment(marker)) === true` for every fixture in `formatClarificationAnswerComment`'s valid input space.
