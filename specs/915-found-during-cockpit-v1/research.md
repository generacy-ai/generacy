# Research: Surfacing classifier reason in failure evidence (#915)

Phase 0 output. Documents the technical decisions behind the plan, alternatives considered, and links to the concrete evidence in code.

## Decision 1: Explicit `classifier?: string` parameter as the synthetic-vs-process discriminator

**Chosen**: Add an optional `classifier?: string` parameter to `buildErrorEvidence`. Presence is the sole discriminator. Populates `reason` and rewords `exitDescriptor`.

**Rejected — output-emptiness discriminator**: A prior draft (FR-002 in the initial spec) proposed `result.error.output.length === 0` as the discriminator. This breaks on the no-progress guard at `phase-loop.ts:426`, which legitimately populates `error.output` with the counter text (`no progress: tasks_remaining stayed at ${tasksRemaining} across two increments`). Adopting this discriminator would require the no-progress site to stop putting content in `output` just to satisfy an inference rule — the exact derived-signal fragility this arc has rejected repeatedly (#889 Q2, #902 Q4, #904 Q5: outcomes as explicit discriminated values, never inferred).

**Rejected — dual-signal invariant check**: A composite discriminator that treats `classifier` as primary and adds a dev-mode assertion that `classifier + non-empty output` fails would enforce a false invariant. "Classifier present ⇒ output empty" is not a law: a future classifier can legitimately carry both a reason and an output tail (a validation classifier that both explains the failure and shows the failing test excerpt). An assertion on a non-invariant is a time bomb.

**Rationale**: An explicit parameter puts the path decision at the callsite, where a reader can grep for it. It composes with Q5→B (all six callsites pass explicitly, `undefined` on process paths) to make every callsite's classification a visible statement.

**Reference**: `packages/orchestrator/src/worker/phase-loop.ts:989–1011` (current `buildErrorEvidence`); this spec's clarifications Q1→B.

## Decision 2: Reason rendering — single-line inline, multi-line fenced (1 KiB cap)

**Chosen**: Single-line reasons render inline as `**Reason**: <reason>`. Multi-line reasons render with `**Reason**:` on its own line followed by a fenced ```text``` block containing the verbatim message, capped at 1 KiB with trailing `…` on truncate.

**Rejected — inline-only with newline substitution**: Replacing `\n` with `; ` inside a single inline line degrades stack-trace readability. Catch-block reasons are `String(error)` — stacks with newlines are the expected case, and `;`-joining makes them unreadable.

**Rejected — verbatim inline (no cap, no substitution)**: Preserves fidelity but invites 50 KB comments if a catch site throws with an embedded huge string. The 1 KiB cap is a defensive bound.

**Rejected — inline pass-through with cap only**: Newlines in inline markdown render as spaces, so a stack-trace excerpt becomes an unreadable run-on line. Poor UX for the catch-block sites.

**Rationale**: Matches the exact rendering idiom `outputTail` already established in `stage-comment-manager.ts:appendEvidenceBlock` (fence + cap). The fence neutralizes markdown-hostile content (embedded backticks, `#` chars mistaken for headings) for free. Multi-line detection is a simple `reason.includes('\n')` check.

**Reference**: This spec's clarifications Q2→B. Existing outputTail fence idiom: `packages/orchestrator/src/worker/stage-comment-manager.ts:200–213, 331–351`.

## Decision 3: Site-specific classifier names (`spawn-error`, `product-diff-error`)

**Chosen**: Each catch-block synthetic-result site passes a site-specific name:
- `'no-product-code-changes'` — product-diff guard (~:630) — from specs/820.
- `'no-progress'` — no-progress guard (~:429).
- `'spawn-error'` — unexpected-spawn catch (~:373).
- `'product-diff-error'` — product-diff-detection catch (~:600).

**Rejected — shared `'catch-block'` literal**: A classifier name should say what failed, not which control-flow construct caught it. `'catch-block'` tells the operator nothing at the summary-line level. Two distinct sites would be indistinguishable in the alert until the operator reads the reason text.

**Rejected — family-prefixed names (`catch-block:spawn`, `catch-block:product-diff`)**: Organizes by implementation detail no consumer filters on. The prefix's only value would be alert-log grouping, which no downstream consumer does today. Adds a hierarchy for the future's sake.

**Rationale**: The alert summary line (`❌ implement failed — implement failed post-exit: no-product-code-changes (process exit 0).`) needs to be actionable at a glance. A named classifier signals both which check failed and that the exit code is a post-exit artifact rather than the true failure descriptor.

**Reference**: This spec's clarifications Q3→B.

## Decision 4: ZWSP-escape backticks in `reason`, matching `outputTail`

**Chosen**: `reason.replace(/`/g, '` `)` (ZWSP inserted after every single backtick) before rendering. The rendered value is inline in the single-line case and inside a fence in the multi-line case; both cases benefit from the same defense against markdown-hostile content.

**Rejected — no sanitization**: `String(error)` output is arbitrary caller-thrown text; trusting it means one thrown error containing `` ` `` breaks the surrounding bold-label markdown.

**Rejected — inline-code wrapping (`` **Reason**: `<reason>` ``)**: Restyles every reason as inline code, a visual change with no safety increment beyond the ZWSP escape (once Q2-B puts multi-line content in fences).

**Rationale**: One sanitization idiom across both fields (`reason` + `outputTail`), already proven in `stage-comment-manager.ts:200,334`. The escape is O(reason length) and typically noise-free (few reasons contain backticks).

**Reference**: This spec's clarifications Q4→B. Existing ZWSP idiom: `packages/orchestrator/src/worker/stage-comment-manager.ts:200`.

## Decision 5: All six FR-006 callsites pass the argument explicitly

**Chosen**: Every `buildErrorEvidence` callsite passes the `classifier` argument explicitly. The three synthetic sites pass named classifiers; the two shell/CLI process-failure sites (`:294`, `:548`) pass `classifier: undefined`.

**Rejected — omit the argument at process-path sites**: With an optional parameter, "didn't pass it" and "decided it's a process path" are indistinguishable at the callsite. A reader would have to know the API to interpret omission.

**Rejected — render `reason` on process paths too (widen scope)**: Would inject redundant "command failed with exit 1" reasons over the outputTail that already IS the evidence on those paths. US2 explicitly requires unchanged shape on process paths.

**Rationale**: Explicit `undefined` states the decision. Every callsite's path classification becomes a grep-auditable statement (`grep -n 'buildErrorEvidence' phase-loop.ts` shows classifier args in a one-liner per site).

**Reference**: This spec's clarifications Q5→B.

## Decision 6: Additive optional field — no breaking changes

**Chosen**: `reason?: string` as an optional field on the command-exit variant of `errorEvidence`. Pre-fix serialized blobs (persisted in historical stage comments read by cockpit) still parse.

**Rejected — required field with default**: Would force a data migration on any consumer reading historical stage-comment JSON. The stage-comment marker format was chosen for markdown-first persistence; introducing a required schema break for a defensively-additive UX fix is disproportionate.

**Rationale**: The change composes naturally with the #890 shape. Consumers that don't yet read `reason` see byte-identical output on process paths; consumers that do read `reason` get the classifier message where present.

## Implementation Patterns Referenced

1. **Fence + cap idiom** (`stage-comment-manager.ts:207–213`): use ` ```text` fence with a bounded byte tail, trailing `\`\`\`` on its own line. Multi-line reason rendering reuses this.
2. **ZWSP substitution idiom** (`stage-comment-manager.ts:200,229,334`): defend against markdown-hostile content by inserting `​` inside dangerous character runs. Extended to `reason`.
3. **buildErrorEvidence six-site pattern** (`phase-loop.ts:294,373,429,548,600,630`): every synthetic PhaseResult path already constructs `result.error = {...}` in-place before calling `buildErrorEvidence`. The classifier parameter adds one more argument to those calls without changing the surrounding shape.
4. **CommandExitEvidence Extract type** (`types.ts:302–305`): the type is derived from the discriminated union rather than declared standalone, so extending the variant with `reason?` automatically threads it through consumers.

## Key Sources / References

- `packages/orchestrator/src/worker/phase-loop.ts` — target file, six callsites and the helper.
- `packages/orchestrator/src/worker/stage-comment-manager.ts` — both renderers (`appendEvidenceBlock`, `renderFailureAlert`).
- `packages/orchestrator/src/worker/types.ts:250–294` — `errorEvidence` union declaration.
- `specs/847-found-during-cockpit-v1/` — original evidence-block contract; #915 extends it.
- `specs/865-found-during-cockpit-v1/` — failure-alert composer; #915 threads the `reason` through here too.
- `specs/890-found-during-cockpit-v1/` — recent `stderr → output` rename; establishes the "renderers update in lockstep" invariant.
- `specs/820-*` — the `PHASES_REQUIRING_CHANGES` guard whose `error.message` this fix surfaces.
- Live incident: tetrad-development#92, finding #55 (snappoll#3 double-requeue).
