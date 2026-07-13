# Contract: PR-body evidence blocks

**Purpose**: pin the exact shape reviewers will look for in the PR body so the "captured evidence" side of FR-011 has a single unambiguous target.

Evidence lives inline in the PR body as fenced code blocks (clarification Q1 → A). Spillover to `gh pr comment --body-file` is a formatting fallback for oversized blocks, not a different mechanism.

## Section layout in the PR body

```
## Verification — configured run

### Phase 1: specify
<fenced block A1>
Assertion: <one line>

### Phase 2: clarify
<fenced block A2>
Assertion: <one line>

### Phase 3: plan
<fenced block A3>
Assertion: <one line>

### Phase 4: tasks
<fenced block A4>
Assertion: <one line>

### Phase 5: implement
<fenced block A5>
Assertion: <one line>

### Cross-phase sessionId carryover
<fenced block B>
Assertion: <one line>

### Terminal state
<fenced block D-configured>

## Verification — parity run

### Zero --model drift
<fenced block C>
Assertion: <one line>

### Terminal state
<fenced block D-parity>

## Follow-ups

- Sibling issue for cross-repo docs (FR-009, FR-010): <link to generacy-ai/tetrad-development#N>
```

## Block A (per phase) — required grep and expected content

**Grep command (as run by the operator; embed in PR body above the block)**:
```bash
docker logs <orchestrator-container> 2>&1 \
  | grep -E 'Spawning new Claude CLI|agent.model.transition|"--model"' \
  | grep '"phase":"<phase>"'
```

**Expected content**:
- One JSON Pino line with `"msg":"Spawning new Claude CLI session for phase (via AgentLauncher)"` tagged with the phase.
- The corresponding argv line (from the launcher's spawn) showing `"--model"` followed by the resolved model.
- For `implement` only: an `agent.model.transition` line preceding the spawn, with `prevModel: Y, nextModel: Z`.

**Required assertion under the block** (one line):
> Resolved `<phase>` to `<model>` via `<tier>` — matches fixture `<X|Y|Z>`.

## Block B (cross-phase sessionId carryover) — required grep and expected content

**Grep command**:
```bash
docker logs <orchestrator-container> 2>&1 \
  | grep -E '"sessionId":|"--resume"|"phase":"(clarify|plan|tasks)"' \
  | head -20
```

**Expected content**:
- A `sessionId=<S>` produced by one of `specify` / `clarify` / `plan` / `tasks` (all resolve to Y).
- The subsequent phase's spawn argv containing `--resume <S>`.
- No `agent.model.transition` line between them.

**Required assertion**:
> Phase `<N+1>` reused session `<S>` produced by phase `<N>` (both resolved to `{claude-code, Y}`).

## Block C (parity zero-drift) — required grep and expected content

**Grep command**:
```bash
docker logs <parity-orchestrator-container> 2>&1 | grep -c -- '--model'
```

**Expected output**:
```
0
```

**Required assertion**:
> Zero `--model` flags across the entire parity run.

## Block D (terminal-state parity)

For each of the two runs, show the `gh issue view <issue> --json labels` output (or an equivalent transcript). Both must display the same terminal-state signal per SC-001:
- Both green (`epic-complete` or equivalent), OR
- Both stopped at the same `waiting-for:<gate>`.

If they diverge, the parity claim fails and SC-001 is not satisfied.

## What "zero code content" means

- No `.snap`, `.log`, or `.json` fixtures checked into `specs/815-.../verification/`. If any evidence artifact needs long-term storage, the operator opens a follow-up issue rather than adding it here (Out of Scope §9).
- Grep commands MAY be tweaked by the operator (e.g., a different container name, adding `--since`), but the *set* of grep patterns above is the reviewer's cheat-sheet: substituting different keywords requires a note in the PR body.

## Non-goals for the evidence contract

- No timestamps required — reviewers do not verify wall-clock ordering, only Pino line ordering within blocks.
- No PII scrub — the test repo is a scratch repo, and Pino JSON contains no user data by construction.
- No log integrity signature — the trust model is "reviewer trusts the operator's paste", same as every other cluster verification in this codebase.
