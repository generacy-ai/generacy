# Contract: test-repo `.generacy/config.yaml` fixture

**Purpose**: pin the exact shape the configured verification run consumes so evidence in the PR body is unambiguously traceable to a single fixture.

**Location**: `.generacy/config.yaml` in the *test repo* (not this repo). Nothing about this fixture is checked into `generacy-ai/generacy`.

## Required shape (per FR-001, clarification Q3 → B)

```yaml
schemaVersion: "1"

project:
  id: "<test-repo-project-id>"
  name: "<test-repo-name>"

repos:
  primary: "github.com/<org>/<test-repo>"

defaults:
  agent: claude-code
  baseBranch: main

orchestrator:
  agents:
    default:
      model: <X>            # e.g., sonnet-4-6
    workflows:
      speckit-feature:
        default:
          model: <Y>        # e.g., sonnet-4-5
        phases:
          implement:
            model: <Z>      # e.g., opus-4-7
```

## Field constraints

| Field | Value | Why |
|-------|-------|-----|
| `orchestrator.agents.default.model` (X) | A Claude model ID distinct from Y and Z | Documents tier-3 shadowing for the PR-body honesty note |
| `orchestrator.agents.workflows.speckit-feature.default.model` (Y) | A Claude model ID distinct from X and Z | Resolves for `specify`, `clarify`, `plan`, `tasks`; supplies SC-004 adjacencies |
| `orchestrator.agents.workflows.speckit-feature.phases.implement.model` (Z) | A Claude model ID distinct from X and Y | The phase-override tier; SC-002's primary demonstration |
| `orchestrator.agents.default.provider` | omitted OR `claude-code` | Cross-provider work is Phase 3, out of scope here |
| `orchestrator.agents.workflows.speckit-feature.phases.<other-phase>` | absent | Every non-implement phase must resolve to Y for SC-004 |
| `orchestrator.agents.workflows.speckit-feature.phases.pr-feedback` | absent | Q6 territory — pr-feedback binds to `implement`'s entry, not a dedicated slot (spec Out of Scope §4) |
| `orchestrator.agents.prFeedback` | absent | Out of Scope §4 |

## Resolution table (must hold at run time)

| Phase | Expected `--model` | Expected `--provider` | Same-model-as-previous? |
|-------|--------------------|-----------------------|-------------------------|
| `specify` | Y | (implicit) claude-code | n/a (first phase) |
| `clarify` | Y | (implicit) claude-code | **yes** — SC-004 boundary candidate |
| `plan` | Y | (implicit) claude-code | **yes** — SC-004 boundary candidate |
| `tasks` | Y | (implicit) claude-code | **yes** — SC-004 boundary candidate |
| `implement` | Z | (implicit) claude-code | no (transition; emits `agent.model.transition`) |
| `validate` | no spawn — shell phase | n/a | n/a |

## Change budget

The test repo fixture is a one-shot artifact for the verification session. It is not reused, versioned, or reviewed as part of this PR. If a regression forces a re-run with different values, X/Y/Z may change; the *shape* (three-layer, three distinct Claude models, no `phases.<x>` overrides outside `implement`) must not.

## Non-fixture requirements on the test repo

| Requirement | Reason |
|-------------|--------|
| Repo has an open issue labeled `process:speckit-feature` | Trigger for the workflow |
| Repo has the four `waiting-for:*-review` gate labels configured | Required for operator gate advancement (Assumptions §5) |
| Orchestrator container name is discoverable (`docker ps` reveals it) | Grep target for evidence capture (research.md Decision 1) |
| Orchestrator log level allows `info` (default) | Both grep targets (`Spawning …`, `agent.model.transition`) are logged at `info` |

## Non-fixture requirements on the parity repo

Same repo template but *no* `orchestrator.agents` block at all. Every other field may match the configured repo or diverge — the parity run does not depend on any specific shape beyond "no `orchestrator.agents`".
