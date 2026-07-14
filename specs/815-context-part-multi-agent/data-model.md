# Data Model: config fixture + evidence artifacts

No new production entities. Two kinds of data participate: (1) the `orchestrator.agents` config surface already shipped by #813/#814 and copied into the test repo, and (2) the evidence artifacts produced during verification.

## Entity 1: `orchestrator.agents` (existing, from #814)

Defined by `WorkerConfigSchema` in `packages/orchestrator/src/worker/config.ts`. Reference shape for the test-repo fixture:

```yaml
orchestrator:
  agents:
    default:                              # tier 3 (repo-wide)
      model: <model-X>
      provider: claude-code               # optional; omit → inherit
    workflows:
      speckit-feature:
        default:                          # tier 2 (per-workflow)
          model: <model-Y>
        phases:
          implement:                      # tier 1 (per-phase override)
            model: <model-Z>
```

### Fields consumed by this verification

| Path | Type | Required in fixture | Purpose |
|------|------|---------------------|---------|
| `orchestrator.agents.default.model` | Claude model ID | yes (SC-004 needs X to exist) | Establishes X for the honesty note in the PR body; shadowed by Y in a `speckit-feature` run |
| `orchestrator.agents.default.provider` | `claude-code` \| omitted | omitted → inherit | Kept `claude-code` at every layer per Out of Scope §1 |
| `orchestrator.agents.workflows.speckit-feature.default.model` | Claude model ID | yes | Y — resolved model for every non-implement phase; supplies SC-004's same-model adjacencies |
| `orchestrator.agents.workflows.speckit-feature.phases.implement.model` | Claude model ID | yes | Z — the phase override; the resolution SC-002 primarily proves |

### Validation

- Fixture is validated at cluster boot by the orchestrator's Zod schema. Missing/invalid → orchestrator refuses to run. No new validation.
- X, Y, Z SHOULD be three distinct Claude model IDs so the evidence unambiguously demonstrates each tier. Any three from the `sonnet-*` / `opus-*` families work.

### Resolution map (guarantees for the run)

Given the fixture above, `resolveAgentForPhase(config, 'speckit-feature', phase)` returns:

| Phase | Provider | Model | Layer that won |
|-------|----------|-------|----------------|
| `specify` | `claude-code` | Y | `workflows.speckit-feature.default` |
| `clarify` | `claude-code` | Y | `workflows.speckit-feature.default` |
| `plan` | `claude-code` | Y | `workflows.speckit-feature.default` |
| `tasks` | `claude-code` | Y | `workflows.speckit-feature.default` |
| `implement` | `claude-code` | Z | `workflows.speckit-feature.phases.implement` |
| `validate` | n/a — shell phase, no agent spawn | n/a | n/a |

Four adjacent same-model pairs (`specify→clarify`, `clarify→plan`, `plan→tasks`) satisfy SC-004; only one is required.

## Entity 2: Evidence blocks (produced during verification)

The PR body carries evidence as fenced code blocks. Two categories:

### Category A: Per-phase spawn evidence (configured run)

One block per agent-spawning phase (`specify`, `clarify`, `plan`, `tasks`, `implement`) — five blocks total.

**Grep**:
```
docker logs <orchestrator-container> 2>&1 | grep -E 'Spawning Claude CLI|Spawning new Claude CLI|agent.model.transition|--model' | grep '"phase":"<phase>"'
```

**Expected content per block**:
- One `"msg":"Spawning new Claude CLI session for phase (via AgentLauncher)"` line (or its resumed-session counterpart) tagged with the phase name.
- The corresponding argv line containing `--model <resolved-model-for-that-phase>`.
- Optionally, an `agent.model.transition` line when adjacent phases differ (`plan→implement` is the guaranteed transition in the Decision 3 fixture).

**Required assertion in PR-body text below each block**:
> Phase `<phase>` resolved to `<model>` via `<tier-that-won>`; matches fixture (research.md Decision 3).

### Category B: Session-carryover evidence (configured run)

One block covering at least one boundary where phase N and phase N+1 both resolved to the same `{claude-code, Y}`.

**Grep**:
```
docker logs <orchestrator-container> 2>&1 | grep -E '"sessionId"|--resume|"phase":"'
```

**Expected content**:
- Phase N's `currentSessionId = result.sessionId` producer log (from `phase-loop.ts:466`).
- Phase N+1's spawn argv containing `--resume <same-sessionId>`.
- No `agent.model.transition` line between them (same provider + same model).

### Category C: Parity-run evidence (unconfigured sibling repo)

Single block covering the whole parity run.

**Grep**:
```
docker logs <orchestrator-container> 2>&1 | grep -c -- '--model'
```

**Expected output**: `0`.

**Required assertion in PR-body text below the block**:
> Zero `--model` flags across all phase spawns in the parity run. Denominator = every phase spawn observed.

### Category D: Terminal-state parity (both runs)

Not a fenced code block — a `gh issue view <issue-number> --json labels` transcript (or manual label list) for both the configured issue and the parity issue, showing both reached the same terminal state (both green, or both stopped at the same gate) per SC-001.

## Validation rules for evidence

| Rule | Where enforced | Failure mode |
|------|----------------|--------------|
| Every one of the five agent-spawning phases has a Category A block | Human review | Reviewer requests missing blocks; PR does not merge |
| Each Category A block's `--model` matches the resolution map above | Human review + `.generacy/config.yaml` cross-check | If drift, either the fixture is wrong or #813/#814 regressed |
| Category B block shows `--resume <sessionId>` on a same-`{provider, model}` boundary | Human review | If absent, SC-004 unsatisfied; re-run or investigate #814 regression |
| Category C `grep -c -- '--model'` output is `0` | Human review | Any nonzero → SC-003 unsatisfied; a code path outside `orchestrator.agents` is emitting `--model` |
| Category D shows same terminal state for both issues | Human review | Behavioral divergence indicates a regression in the parity path |

## Non-goals

- No JSON schema, OpenAPI, or programmatic assertion of evidence — reviewer eyes are the only checker (Q1 → A).
- No persisted log corpus checked into `specs/815-.../verification/` (Out of Scope §9).
- No cross-run diff artifact — reviewer compares Category A resolutions to the fixture manually.
