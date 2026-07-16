# Quickstart: #958

After this PR ships, the day-to-day surfaces change as follows.

## For humans answering clarifications on GitHub

Reply with any of these — all now integrate:

- `Q1: A` / `Q2: B` — the primary flow.
- `**Q1**: A` — bold form, unchanged.
- GitHub "Quote reply" on any question — previously worked only on the last question, now works on all.
- Inline restatement: quote the question above your answer — previously silently discarded, now the leading answer is preserved and the quoted tail dropped.

**Not required** — you don't need any marker, HTML comment, or engine-format. If you're a human, you write like a human, and it works.

**Reply-only resume:** you no longer need to know about the `completed:clarification` label. Post a comment that answers any question; a monitor detects it within one poll interval and requeues the issue. If everything is answered, the phase advances; if not, the gate re-arms and pauses again with a re-post of any remaining questions.

Manual force-advance is still available: apply `completed:clarification` by hand (or via `generacy cockpit advance <issue> --gate clarification`) to bypass the gate whether or not answers parsed. Use this deliberately when you know parsing has failed and you want to proceed anyway.

## For cockpit users invoking the clarify skill

The skill now uses a new MCP tool for relaying answers to the issue:

```
cockpit_relay_clarify_answers({
  issue: "owner/repo#123",
  batch: 1,
  answers: { 1: "B", 2: "prose here", 3: "..." },
})
```

Returns:

```json
{
  "status": "ok",
  "data": {
    "ref": { "owner": "...", "repo": "...", "number": 123, "nwo": "..." },
    "batch": 1,
    "action": "relayed",
    "commentUrl": "https://github.com/.../comments/...",
    "completedLabel": "completed:clarification"
  }
}
```

The tool stamps `<!-- generacy-clarification-answers:<batch> ... -->` deterministically. Idempotent: re-invoking with the same `(issue, batch)` returns `action: "already-relayed", noop: true`.

Do NOT construct the answer comment freehand via `gh issue comment` — that path is deprecated. The orchestrator's authorship gate requires the marker to be stamped by this tool.

## For orchestrator operators

New monitor service starts alongside `MergeConflictMonitorService`:

```
[info] Starting clarification-answer monitor polling { intervalMs: 30000, repos: 3 }
```

Poll cadence is shared with `PrMonitorConfig` (same `pollIntervalMs`, `adaptivePolling`, `maxConcurrentPolls`). No new configuration required.

Structured log lines to watch:

- `event: 'clarification-answer-resume-enqueued'` — monitor detected a new human comment on a paused issue and enqueued a `continue` queue item.
- `code: 'TRANSITION_WITH_QUESTION_HEADINGS'` with `viewerDidAuthor: true` — cluster-self-authored comment tripped the FR-004 detector; the entire poll's integration was aborted, gate stays armed. Investigate.
- `code: 'TRANSITION_WITH_QUESTION_HEADINGS'` with `viewerDidAuthor: false` — a human comment tripped the detector; only that comment was skipped, other humans in the poll integrated normally.
- `event: 'clarification-answer-scanner-marker-excluded'` — cluster-self-authored answer without the deterministic marker was excluded. If seen post-deploy, cockpit's skill hasn't been updated to use the new tool.

## For fix authors touching this area

- **Never introduce a content-sniff as an authorship signal.** Use `viewerDidAuthor`. The FR-002 pre-filter for engine question markers is a defense-in-depth layer, not an authorship gate.
- **Never spell the `*Pending*` literal in a new file.** Import `PENDING_ANSWER_LITERAL` from `@generacy-ai/workflow-engine`. `.changeset/*.md` for a related change should reference the constant, not the literal.
- **Never spell the answer marker in a prompt or skill file.** The marker is stamped by `formatClarificationAnswerComment`. Adding a new answer-marker dialect: append to `CLARIFICATION_ANSWER_MARKERS` and update `formatClarificationAnswerComment` to emit it; nothing else changes.
- **Never remove `waiting-for:*` from a monitor.** The worker owns clearing gate labels on the resume path. `MergeConflictMonitorService` is the reference.

## Local repro / testing

### Replay snappoll#7 (bot self-answer):

```bash
cd packages/orchestrator
pnpm test -- clarification-poster.test.ts
# Look for the describe block: "FR-001 authorship-gate — bot self-answer rejected"
```

Expected: `waiting-for:clarification` retained, `phase:plan` never applied, no `**Answer**:` fields populated with question restatement.

### Table-driven quote-reply integration (Observed B):

```bash
cd packages/orchestrator
pnpm test -- clarification-poster.test.ts
# Look for: "FR-005 quote-stripping — Observed B table"
```

Six rows, four required-pass (per SC-002): plain `Q1:`, GitHub Quote reply, inline restatement, `**Q1**:`. Prose and numbered-list are best-effort.

### Cockpit answer relay tool:

```bash
cd packages/generacy
pnpm test -- cockpit_relay_clarify_answers.test.ts
```

## Troubleshooting

**"My reply was ignored."** Check `waiting-for:clarification` + `agent:paused` are both present on the issue. The monitor only polls when both are set. If they are, watch for `clarification-answer-resume-enqueued` in orchestrator logs within one poll interval (default 30s).

**"Cockpit says `already-relayed` but no answers integrated."** The `<!-- generacy-clarification-answers:<batch> -->` marker for that batch is already on the issue. Bump the batch number to relay a new set, or apply `completed:clarification` manually to force-advance if you know the previous answers were correct.

**"Grep test failed: found `*Pending*` outside `pending-literal.ts`."** Import `PENDING_ANSWER_LITERAL` from `@generacy-ai/workflow-engine` and use it. The literal must exist in exactly one file.

**"FR-004 blew up in a test."** Check the fixture's `viewerDidAuthor` value:
- `false` → per-comment skip; other comments in the fixture should integrate.
- `true` → per-poll abort; no comments in the fixture should integrate; `IntegrationResult.reason === 'aborted-cluster-self-detector'`.
