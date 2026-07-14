# Quickstart: run the verification and file the PR

This is the operator's runbook. It captures the two verification tracks, the single file edit, and the PR body layout that satisfies FR-011 for reviewers.

## Prerequisites

- A cluster running an orchestrator build that contains #813 and #814 merged to `develop` (confirmed by `git log --oneline develop | grep -E '#813|#814'`).
- Access to `docker logs <orchestrator-container>` on that cluster.
- Two scratch repos under the org's test scope:
  - **Configured repo**: carries the three-layer fixture from `contracts/config-fixture.md`.
  - **Parity repo**: no `orchestrator.agents` block at all.
- Cockpit label-manipulation access (`gh issue edit --add-label`, `--remove-label`).

## Track 1: configured run

### Step 1 — set up the test repo

Write `.generacy/config.yaml` per `contracts/config-fixture.md`. Pick three Claude model IDs — e.g., `sonnet-4-6` (X), `sonnet-4-5` (Y), `opus-4-7` (Z). Commit and push.

### Step 2 — trigger the workflow

Open an issue in the configured repo and add the `process:speckit-feature` label. The orchestrator's label monitor picks it up on its next poll.

### Step 3 — drive the run through every phase

Watch the issue's label state. At each `waiting-for:*-review` pause, add the matching `completed:<gate>` label:

| Pause | Advance with |
|-------|--------------|
| `waiting-for:spec-review` | `completed:spec-review` |
| `waiting-for:clarification-review` | `completed:clarification-review` |
| `waiting-for:plan-review` | `completed:plan-review` |
| `waiting-for:tasks-review` | `completed:tasks-review` |
| `waiting-for:implementation-review` | **stop here** — this is the natural implementation-review terminal per Q2 → A |

The run should touch, in order: `specify` → `clarify` → `plan` → `tasks` → `implement` → (halts at implementation review). `validate` is a shell phase with no agent spawn.

### Step 4 — capture per-phase evidence

For each of the five agent-spawning phases, run:

```bash
docker logs <orchestrator-container> 2>&1 \
  | grep -E 'Spawning new Claude CLI|agent.model.transition|"--model"' \
  | grep '"phase":"<phase>"'
```

Each grep should return the spawn line + argv line + (for `implement`) a preceding `agent.model.transition`. Paste each output into the PR body under the `### Phase N: <phase>` heading in the layout defined by `contracts/evidence.md`.

### Step 5 — capture cross-phase session carryover

Pick any adjacent pair among `specify` → `clarify` → `plan` → `tasks` (all resolve to Y — same `{claude-code, Y}`). Run:

```bash
docker logs <orchestrator-container> 2>&1 \
  | grep -E '"sessionId":|"--resume"|"phase":"(clarify|plan|tasks)"' \
  | head -20
```

Confirm the second phase's spawn argv contains `--resume <sessionId>` matching the `sessionId` the first phase produced. Paste under `### Cross-phase sessionId carryover`.

### Step 6 — record terminal state

```bash
gh issue view <configured-issue-number> --json labels
```

Paste output under `### Terminal state` (configured section).

## Track 2: parity run

### Step 1 — set up the parity repo

Write a `.generacy/config.yaml` with no `orchestrator.agents` block. Any other schema-valid fields are fine. Commit and push.

### Step 2 — trigger and drive the workflow

Open a `process:speckit-feature` issue, advance the same four gates, stop at the natural implementation-review terminal.

### Step 3 — capture zero-drift evidence

```bash
docker logs <parity-orchestrator-container> 2>&1 | grep -c -- '--model'
```

Expected output: `0`. Paste under `### Zero --model drift`.

### Step 4 — record terminal state

```bash
gh issue view <parity-issue-number> --json labels
```

Confirm same terminal-state signal as Track 1 (both green, or both stopped at the same gate). Paste under `### Terminal state` (parity section).

## The single file edit landed by this PR

Open `packages/generacy/examples/config-full.yaml`. Replace the commented-out `# agents:` block (currently lines ~57–82) with a live, uncommented, three-layer example. Keep the existing precedence-chain header comment (lines ~48–56) as-is.

Suggested content:

```yaml
  agents:
    # Repo-wide default. Applies to any workflow/phase that doesn't override.
    default:
      provider: claude-code
      model: sonnet-4-6

    workflows:
      speckit-feature:
        # Applies to every phase of this workflow unless a phases.<phase>
        # override is set below.
        default:
          model: sonnet-4-5

        phases:
          # Full override for the implement phase. pr-feedback binds to this
          # same entry (pr-feedback resolves against the `implement` phase).
          implement:
            provider: claude-code
            model: opus-4-7
```

Reviewers will verify SC-005 — that an operator reading this alone can construct a valid `orchestrator.agents` block.

## PR body

Follow the section layout in `contracts/evidence.md`. Include:

1. All five per-phase Block A sections.
2. One Block B (cross-phase carryover).
3. One Block C (parity zero-drift).
4. Two Block D terminal-state entries.
5. A **Follow-ups** section linking the sibling `tetrad-development` issue for FR-009 + FR-010 (per Q5 → A).
6. A one-line honesty note about `agents.default` (X) being shadowed by Y in this run (Decision 3 honesty note).

## Open the sibling `tetrad-development` issue

Before or during PR review, file an issue on `generacy-ai/tetrad-development` covering:
- `docs/dev-cluster-architecture.md` orchestrator-block section update (FR-009).
- `docs/multi-agent-provider-plan.md` Phase 1 status flip + PR-link updates (FR-010).

Embed the URL in this PR body's **Follow-ups** section.

## Troubleshooting

| Symptom | Diagnosis | Action |
|---------|-----------|--------|
| No `Spawning new Claude CLI …` lines for some phases | Workflow stopped before reaching them; missed a `completed:<gate>` advance | Add the missing label; wait for label monitor poll |
| `--model` value in a Block A doesn't match the fixture | Fixture drift OR resolver regression | Cross-check `.generacy/config.yaml`; if fixture is correct, this is a #814 regression → escalate per FR-012, do not fix in this PR |
| Parity run shows `--model` matches (Block C returns non-zero) | Something outside `orchestrator.agents` is emitting `--model` | Investigate; likely a cluster-level env var — check `WORKER_AGENT_MODEL` on the cluster |
| Cross-phase `--resume` missing | Adjacent phases resolved to different `{provider, model}` OR a #814 regression | Confirm fixture puts both in the same tier; if yes, escalate per FR-012 |
| Configured and parity terminal states diverge | Behavioral parity broken | Escalate per FR-012; do not paper over |
| `docker logs` output truncated (log rotation) | Cluster log retention too short | Re-run with `docker logs -f` piped to `tee` from the start of the run; retain the file locally for grep |

## What NOT to do

- Do not add a shell script or fixture files under `specs/815-.../verification/` (Out of Scope §9).
- Do not touch `packages/orchestrator/**` in this PR (Out of Scope §3).
- Do not attempt to update `docs/dev-cluster-architecture.md` or `docs/multi-agent-provider-plan.md` (both live in `tetrad-development`, re-scoped per Q5).
- Do not force through a green PR if either grep target returns unexpected content — escalate per FR-012 instead.
